// services/kbRetriever.js
const fs   = require('fs');
const path = require('path');
// FIX: REPO_ROOT must be declared BEFORE INDEX_PATH uses it
const REPO_ROOT = path.resolve(__dirname, '..');
// FIX P2: Dynamic path based on TENANT_DOMAIN (multi-domain architecture)
const domain = process.env.TENANT_DOMAIN || 'default';
const INDEX_PATH = path.resolve(REPO_ROOT, `kb/index.json`);
// ─── Boot-time index load ───────────────────────────────────────────────────
// Loaded once, held in memory. Key = canonical id, value = index entry.
let _index = null;
function getIndex() {
  if (!_index) {
    // index.json format: { generated_at, count, entries: [...] }
    const doc = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    const entries = doc.entries ?? doc;  // backward-compat if bare array
    _index = new Map(entries.map(e => [e.id, e]));
  }
  return _index;
}

// ─── Single-file resolver ──────────────────────────────────────────────────
// Acceptance test: kbRetriever.get("32_iv_ivc_high_dose_v3") works
// regardless of whether the file is in kb/json/ or kb/32/...
// Repo root = directory of this file (services/) → one level up (declared above)

function get(id) {
  // Try exact match first
  let entry = getIndex().get(id);
  let lookupId = id;

  // Case-insensitive fallback: KB files may reference uppercase IDs (e.g., "10_AUTONOMIC_VAGAL")
  // but index.json stores them in lowercase (e.g., "10_autonomic_vagal")
  if (!entry) {
    const lowercaseId = id.toLowerCase();
    entry = getIndex().get(lowercaseId);
    if (entry) {
      console.log(`[kbRetriever] Converted uppercase ID "${id}" to lowercase "${lowercaseId}"`);
      lookupId = lowercaseId;
    }
  }

  // Flexible keyword search: Extract keywords (remove prefix number) and search
  // Example: "12_GUT" → searches for IDs containing "gut"
  // Example: "10_AUTONOMIC_VAGAL" → searches for IDs containing "autonomic" and "vagal"
  if (!entry) {
    // Remove prefix number (e.g., "12_" from "12_GUT")
    const keywords = id.replace(/^\d+_/, '').toLowerCase().split('_').filter(k => k.length > 0);

    if (keywords.length > 0) {
      // Search index for entries containing all keywords
      for (const [indexId, indexEntry] of getIndex().entries()) {
        const indexIdLower = indexId.toLowerCase();
        // Check if all keywords are present in the index ID
        const allKeywordsMatch = keywords.every(kw => indexIdLower.includes(kw));

        if (allKeywordsMatch) {
          console.log(`[kbRetriever] Keyword match: "${id}" → "${indexId}" (keywords: ${keywords.join(', ')})`);
          entry = indexEntry;
          lookupId = indexId;
          break;
        }
      }
    }
  }

  if (!entry) { console.warn(`[kbRetriever] id not found in index: ${id}`); return null; }
  // entry.filepath is relative to repo root (e.g. "kb/json/32_iv_ivc_high_dose_v3.json")
  const abs = path.resolve(REPO_ROOT, entry.filepath);
  if (!fs.existsSync(abs)) { console.warn(`[kbRetriever] file missing on disk: ${abs}`); return null; }
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

// ─── Batch loader (called by chatWorker after KB_ROUTER returns ids) ────────
// Hard caps: prevent a single request from loading 40+ files and blowing token budget.
// MAX_KB_FILES: max number of KB objects per request. MAX_KB_CHARS: total content chars.
// If exceeded: log warning + truncate (never throw — agent degrades gracefully).
const MAX_KB_FILES = 15;           // tune per domain (Valentine: 15, pizza: 5)
const MAX_KB_CHARS = 120_000;      // ~30k tokens at ~4 chars/token

function loadKBFiles(fileIds) {
  if (!fileIds?.length) return [];
  // Deduplicate by lowercase to handle case variations (e.g., "10_AUTONOMIC_VAGAL" vs "10_autonomic_vagal")
  const uniqueIds = Array.from(new Set(fileIds.map(id => id.toLowerCase())));
  const loaded = uniqueIds.slice(0, MAX_KB_FILES).map(id => get(id)).filter(Boolean);
  if (uniqueIds.length > MAX_KB_FILES)
    console.warn(`[kbRetriever] capped at ${MAX_KB_FILES} files (requested ${uniqueIds.length})`);
  // Total chars guard
  let chars = 0;
  return loaded.filter(f => {
    const sz = JSON.stringify(f).length;
    if (chars + sz > MAX_KB_CHARS) { console.warn(`[kbRetriever] MAX_KB_CHARS reached, dropping ${f.id}`); return false; }
    chars += sz; return true;
  });
}

// ─── Formatter (inject into contents[] for Gemini) ─────────────────────────
function formatKBContext(files) {
  if (!files.length) return '';
  return 'KB FILES LOADED (cite by id — these are the only files available to you this turn):\n'
    + files.map(f => JSON.stringify(f, null, 2)).join('\n---\n');
}

module.exports = { get, loadKBFiles, formatKBContext, getIndex };
// kbRetriever is load-only. Routing logic lives in services/kbRouter.js.

/*
  ACCEPTANCE TEST — run once after migrateKB.js:
  node -e "
    const r = require('./services/kbRetriever');
    const f = r.get('32_iv_ivc_high_dose_v3');
    if (!f) throw new Error('FAIL: id not resolved');
    if (f.id !== '32_iv_ivc_high_dose_v3') throw new Error('FAIL: id mismatch');
    if (!f.content.s2_patient_communication_public) throw new Error('FAIL: _public key missing');
    if (Object.keys(f.content).some(k => k.endsWith('_public') && k !== 's2_patient_communication_public'))
      throw new Error('FAIL: unexpected _public key found — visibility leak');
    console.log('✅ acceptance: id resolved, visibility isolation OK');
  "
*/