// services/kbRouter.js — dual-mode routing entry point
// Called by chatWorker BEFORE any main Gemini inference call.

const { generateContent } = require('./geminiClient');
const { getIndex } = require('./kbRetriever');

// ── Hard-stop trigger map (in-memory, loaded once at boot) ────────────────────
// Keys: lowercase keyword or /regex/. Values: array of KB IDs to force-fetch.
const HARD_STOPS = new Map([
  ['pregnancy', ['00_policy_pregnancy_breastfeeding_v1']],
  ['breastfeeding', ['00_policy_pregnancy_breastfeeding_v1']],
  ['enceinte', ['00_policy_pregnancy_breastfeeding_v1']],
  // IDs must be EXACT — no wildcards, no prefix expansion.
  // Replace these with your actual compiled IDs from kb/json/index.json.
  ['suboxone', ['11_immune_ldn_v2']],
  ['buprenorphine', ['11_immune_ldn_v2']],
  ['opioids', ['11_immune_ldn_v2']],
  ['bleomycin', ['32_iv_hbot_contraindications_v1']],  // exact ID — add other hbot variants as separate entries if needed
  ['g6pd', ['32_iv_ivc_contraindications_v1', '00_policy_pro_oxidant_gate_v1']],
  ['hemolysis', ['32_iv_ivc_contraindications_v1', '00_policy_pro_oxidant_gate_v1']],
  ['favism', ['32_iv_ivc_contraindications_v1', '00_policy_pro_oxidant_gate_v1']],
  ['melena', ['00_triage_bleeding_v1', '00_policy_b17_gate_v1']],
  ['hematemesis', ['00_triage_bleeding_v1', '00_policy_b17_gate_v1']],
  ['blood in stool', ['00_triage_bleeding_v1']],
  ['seizure', ['00_triage_neuro_v1', '00_policy_ivermectin_gate_v1']],
  ['ataxia', ['00_triage_neuro_v1']],
  ['confusion', ['00_triage_neuro_v1']],
  ['neuro red flag', ['00_triage_neuro_v1', '00_policy_dca_gate_v1']],
]);

// Always load on every DEPTH 2 request (global policies).
// Keep this list short — these must be in every clinical response.
const ALWAYS_LOAD = [
  '00_policy_clinical_intent_and_claims_v1',
  '00_policy_teleconsult_er_v1',
];

// ── Stage 1: Node prefilter — O(N) on trigger count, <5ms wall-clock, no disk read ──────
// N = number of hard-stop triggers (20–50 typical). Still <1ms in practice — "O(1)" was imprecise.
function runPrefilter(message) {
  const needle = message.toLowerCase();
  const hits = new Set();
  for (const [trigger, ids] of HARD_STOPS) {
    if (needle.includes(trigger)) ids.forEach(id => hits.add(id));
  }
  return [...hits];
}

// ── Stage 2: LLM router — Gemini reads KB_ROUTER from cache ───────
async function runLLMRouter(message, prefilterHits, tagCandidates, cacheName) {
  // Force flash-lite for routing (fast, cheap, accurate enough for routing decisions)
  const routerModel = 'gemini-2.5-flash-lite';
  // Pass ONLY tag-matched candidates (max 30) — never the full ID list.
  // Injecting 200–500 IDs would blow the router prompt and break the "<2s" target.
  // KB_ROUTER in cache contains routing rules — the LLM needs signals, not a catalogue.
  const prompt = `User message: ${message}
Prefilter already force-fetching: ${prefilterHits.join(', ') || 'none'}
Candidate KB IDs (tag-matched, max 30): ${tagCandidates.slice(0, 30).join(', ') || 'none'}

Apply KB_ROUTER rules. Return ONLY valid JSON: {"always_load":[],"fetch":[],"reasons":[]}`;

  try {
    const t0 = Date.now();
    const result = await generateContent({
      model: routerModel,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        cachedContent: cacheName,
        generationConfig: { maxOutputTokens: 8192, temperature: 0 }
      }
    });
    const latencyMs = Math.round(Date.now() - t0);

    console.log(`[kbRouter] candidates:`, JSON.stringify(result.candidates, null, 2));

    // Extract text from SDK response
    const candidate = result.candidates?.[0];
    if (!candidate?.content?.parts?.[0]?.text) {
      console.error('[kbRouter] Unexpected SDK response structure:', JSON.stringify(result));
      const err = new Error('invalid_response_structure');
      err.fromKbRouter = true;
      throw err;
    }

    // M6 — strip markdown fences: Flash-Lite sometimes wraps output in ```json``` even at temp=0
    const raw = candidate.content.parts[0].text.trim()
      .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

    console.log(`[kbRouter] raw LLM output: ${raw}`);

    const parsed = JSON.parse(raw);
    // Track token usage
    const usage = result.usageMetadata || {};
    parsed.usage = {
      cachedTokens: usage.cachedContentTokenCount || 0,
      inputTokens: usage.promptTokenCount || 0,
      outputTokens: usage.candidatesTokenCount || 0
    };
    parsed.latencyMs = latencyMs;
    return parsed;
  } catch (error) {
    // Distinguish error types
    console.log(`[kbRouter] Error during LLM routing:`, JSON.stringify(error));
    
    const isTimeout = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
    const isParseError = error instanceof SyntaxError;

    // Clinical escalation — KB router failures require human review
    const err = new Error(isTimeout ? 'kb_router_timeout' : isParseError ? 'kb_router_parse_error' : 'kb_router_api_error');
    err.fromKbRouter = true;
    throw err;
  }
}

// ── Entry point: called by chatWorker for every DEPTH 2 request ──────────────
// Returns the deduplicated final set of KB IDs to load via kbRetriever.
async function resolveKBIds(message, cacheName) {
  // Stage 1 — deterministic, <5ms
  const prefilterHits = runPrefilter(message);

  // Stage 1b — tag-match prefilter (sync, no LLM, feeds Stage 2)
  // Scans index in-memory, returns top candidates by tag overlap score. Max 30.
  // F1: hoist toLowerCase() outside the map — 1 call, not N×M calls
  const needle = message.toLowerCase();
  const tagCandidates = [...getIndex().entries()]
    .map(([id, e]) => ({ id, score: e.tags.filter(t => needle.includes(t.toLowerCase())).length }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(c => c.id);  // top candidates — slice(0,30) applied in prompt

  // Stage 2 — LLM finalizes (~200ms)
  const llm = await runLLMRouter(message, prefilterHits, tagCandidates, cacheName);

  // Stage 3 — Merge rule (source of truth)
  // Final = ALWAYS_LOAD ∪ prefilter_hits ∪ llm.always_load ∪ llm.fetch
  const finalSet = new Set([
    ...ALWAYS_LOAD,
    ...prefilterHits,
    ...(llm.always_load || []),
    ...(llm.fetch || []),
  ]);
  console.log(`[kbRouter X] ${JSON.stringify([...finalSet])}`);

  return [...finalSet];  // kbRetriever.loadKBFiles() resolves via index.json
}

// L1 — export runPrefilter so chatWorker can invoke hard-stops independently of DEPTH tier
module.exports = { resolveKBIds, runPrefilter };