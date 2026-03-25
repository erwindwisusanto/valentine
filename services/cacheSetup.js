// services/cacheSetup.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDomain } = require('../config/domains');
const { ai } = require('./geminiClient');

// IMPORTANT: all cache keys are tenant-scoped
// Multi-tenant design: each tenant has its own cache/lock/hash Redis keys (namespaced by tenantId).
// Option A — one process per tenant (simple): TENANT_ID from env, call ensurePlatformCache(redis).
// Option B — multiple tenants in one process: refactor as ensurePlatformCache(redis, tenantId)
//   and call for each tenant at startup. Keys are already namespaced — no other changes needed.
// Option A (1 process per tenant): tenantId from env — safe, TENANT_ID is deployment-scoped.
// Option B (multi-tenant 1 process): tenantId must come from job.data.tenantId, NOT env.
// In Option B, this line must move into ensurePlatformCache(redis, tenantId) and into
// every Redis key, DB insert, media fetch, and cacheName call. No global tenantId.
const tenantId = process.env.TENANT_ID;
if (!tenantId) throw new Error('[cacheSetup] TENANT_ID env var missing');

const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'];

const LOCK_KEY = `${tenantId}:agent:cache_lock`;
const CACHE_KEY = `${tenantId}:agent:cache_name`;
const HASH_KEY = `${tenantId}:agent:cache_hash`;

function buildStaticContent() {
  // Cache = agent system prompt + KB_ROUTER. Never individual KB files.
  // KB_ROUTER (~2k tokens) MUST be here — it's what tells Gemini which KB files to load.
  // Without it, the "router-in-cache" model collapses: Gemini has no routing rules.
  // MIN-2: explicit guard — prevents cryptic ENOENT at boot with no indication of which file is missing
  // FIX P0: Dynamic paths based on TENANT_DOMAIN (multi-domain architecture)
  const domainKey = process.env.TENANT_DOMAIN;
  if (!domainKey) throw new Error('[cacheSetup] TENANT_DOMAIN env var missing');

  // Validate domain exists + get config (throws if unknown)
  const domainConfig = getDomain(domainKey);
  console.log(`[cacheSetup] Domain: ${domainKey}, PII fields: ${domainConfig.piiFields.join(', ')}`);

  if (!domainConfig) throw new Error('[cacheSetup] TENANT_DOMAIN env var missing');
  const required = [`./prompts/${domainConfig.kbFolder}_prompt.txt`, `./kb/${domainConfig.kbFolder}/00_KB_ROUTER.txt`];

  for (const f of required)
    if (!fs.existsSync(f)) throw new Error(`[cacheSetup] MISSING required file: ${f}`);
  const agentPrompt = fs.readFileSync(required[0], 'utf8');
  const kbRouter = fs.readFileSync(required[1], 'utf8');
  return 'AGENT SYSTEM POLICY\n' + agentPrompt
    + '\n\n---\nKB ROUTING RULES\n' + kbRouter;
}

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

async function ensurePlatformCache(redis) {
  // 1. Distributed lock — UUID token, single flight across all instances
  const lockToken = crypto.randomUUID();
  // M4 fix: lock TTL 90s must be < wait ceiling (increased for 2 models)
  const acquired = await redis.set(LOCK_KEY, lockToken, 'NX', 'EX', 90);

  if (!acquired) {
    // Another instance is rebuilding — wait 100s (lock TTL 90s)
    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const cached = await redis.get(CACHE_KEY);
      if (cached) return JSON.parse(cached);
    }
    throw new Error('[CACHE] Lock held too long — rebuild did not complete');
  }

  try {
    const staticContent = buildStaticContent();
    const newHash = sha256(staticContent);
    const storedHash = await redis.get(HASH_KEY);
    const existingCached = await redis.get(CACHE_KEY);

    // 2. Hash gate — skip rebuild if content unchanged
    // Also handle migration from old single-cache string format
    if (storedHash === newHash && existingCached) {
      try {
        const parsed = JSON.parse(existingCached);
        // Verify it's the new format (has both model keys)
        if (parsed['gemini-2.5-flash'] && parsed['gemini-2.5-pro']) {
          console.log('[CACHE] Hash unchanged — reusing', parsed);
          return parsed;
        }
      } catch (e) {
        // Old format (plain string) or invalid JSON — needs rebuild
        console.log('[CACHE] Old cache format detected — rebuilding...');
      }
    }

    // 3. Build new caches for both models
    console.log('[CACHE] Hash changed — rebuilding for both models');

    const cacheNames = {};

    // Tool declaration for calculate_lab_ratios
    const calculateLabRatiosTool = {
      name: 'calculate_lab_ratios',
      description: 'Calculates deterministic biomarker ratios and scores from raw lab values. ONLY call this function when you need to calculate eGFR, HOMA-IR, TG/HDL, or other lab ratios.',
      parameters: {
        type: 'OBJECT',
        properties: {
          markers: {
            type: 'OBJECT',
            description: 'Raw lab values keyed by biomarker name',
            properties: {
              FBG: { type: 'INTEGER' },
              TG: { type: 'INTEGER' },
              HDL: { type: 'INTEGER' },
              LDL: { type: 'INTEGER' },
              insulin: { type: 'INTEGER' },
              creatinine: { type: 'INTEGER' },
              age: { type: 'INTEGER' },
              sex: { type: 'STRING', enum: ['male', 'female', 'M', 'F'] }
            }
          },
          patient_context: {
            type: 'OBJECT',
            properties: {
              age: { type: 'INTEGER' },
              sex: { type: 'STRING', enum: ['male', 'female', 'M', 'F'] },
              weight: { type: 'INTEGER' }
            }
          }
        },
        required: ['markers']
      }
    };

    // Build cache for each model in parallel
    await Promise.all(MODELS.map(async (model) => {
      console.log(`[CACHE] Creating cache for ${model}...`);
      const isRouter = model === 'gemini-2.5-flash-lite';
      const cache = await ai.caches.create({
        model,
        config: {
          systemInstruction: staticContent,
          // Only include tools for inference models, NOT router
          ...(!isRouter && { tools: [{ functionDeclarations: [calculateLabRatiosTool] }] }),
          ttl: '86000s'
        },
      });
      cacheNames[model] = cache.name;
      console.log(`[CACHE] Cache created for ${model} (tools: ${!isRouter}):`, cache.name);
    }));

    // 4. Atomic swap — write name + hash in single Redis transaction
    const multi = redis.multi();
    multi.set(CACHE_KEY, JSON.stringify(cacheNames), 'EX', 85000); // TTL slightly less than cache TTL to allow for refresh before expiration
    multi.set(HASH_KEY, newHash, 'EX', 85000); // TTL slightly less than cache TTL to allow for refresh before expiration
    await multi.exec();
    console.log('[CACHE] New caches live:', cacheNames);
    return cacheNames;

  } finally {
    // FIX-4: atomic Lua CAS — GET+DEL was a race: another instance could acquire between the two calls
    const lua = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end`;
    await redis.eval(lua, 1, LOCK_KEY, lockToken);
  }
}

module.exports = { ensurePlatformCache };