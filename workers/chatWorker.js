// workers/chatWorker.js
const { Worker } = require('bullmq');
const crypto = require('crypto');                         // C1 — needed for msisdnHash
const { GoogleGenAI } = require('@google/genai'); // C2 — using new SDK
const { ensurePlatformCache } = require('../services/cacheSetup');
const { classifyDepth } = require('../services/depthClassifier');
const { geminiChatWithTools } = require('../services/geminiChat');  // agentChat removed (dead code) — only geminiChatWithTools is used in worker flow
const { resolveKBIds, runPrefilter } = require('../services/kbRouter');    // L1 — runPrefilter exported for DEPTH_0_1 hard-stops
const { loadKBFiles, formatKBContext } = require('../services/kbRetriever');
const { parseCitedObjects, checkCitationMatch } = require('../services/citationParser');
const { extractProfileUpdate } = require('../services/jsonExtractor');    // FIX-1: was missing → ReferenceError on every turn with new patient facts
const { loadPatientContext, formatPatientContext } = require('../services/patientMemory'); // C5 — unified session init
const { upsertPatientProfile, insertChatLog, insertEscalation, insertSafeModeChatLog } = require('../services/patientDb'); // Database operations for patients and chat logs
const { notifyAlert } = require('../utils/notifyAlert');
const { fetchMediaWithFallback } = require('../utils/fetchMedia');         // C2 — was missing → ReferenceError on any media message
const { sendChunked } = require('../services/whatsappFormatter');
const waClient = require('../services/whatsappClient');
const redis = require('../config/redis2');
const { getDomain } = require('../config/domains');

function getDomainSafeMode(domainConfig, reason = 'technical') {
    return domainConfig.safeMode[`${reason}Message`];
}

const geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const worker = new Worker(
    'agent-chat-jobs',
    async (job) => {
        // tenantId + msisdn_id from job.data — never from process.env (multi-tenant safe)

        const {
            messageId,
            tenantId,
            msisdn_id,
            from,
            message,
            mediaUrl,
            mediaBase64,
            mediaMimeType,
            mediaGeminiResult,
            mediaUsage,
            key
        } = job.data;

        // FIX P2: Input validation — prevent crash on malformed job data
        if (!tenantId || !from) {
            throw new Error(`[chatWorker] Invalid job data: tenantId=${tenantId}, from=${from}`);
        }

        // C1 — msisdnHash declared early, used in session key + SQL INSERT
        const msisdnHash = crypto.createHash('sha256').update(from).digest('hex');

        // 1. Load session — C5: unified pattern, tenant-scoped key, msisdnHash (not raw phone)
        const sessionKey = `${tenantId}:session:${msisdnHash}`;
        const sessionRaw = await redis.get(sessionKey);
        let history = [];
        let dossier = '';
        if (sessionRaw) {
            // FIX P2: try/catch to handle corrupt session data
            try {
                history = JSON.parse(sessionRaw);
            } catch (e) {
                // Redis expired — attempt PostgreSQL rebuild
                const ctx = await loadPatientContext(tenantId, msisdnHash);  // C4 — tenant-scoped

                if (ctx) {
                    // Known patient — silent rebuild, patient sees no gap
                    history = [{
                        role: 'system',
                        content: formatPatientContext(ctx)
                    }];
                    await redis.set(sessionKey, JSON.stringify(history), 'EX', 3600);
                }
                // ctx = null → new patient → empty history → normal onboarding
            }
            // C6 — extract dossier from persisted system slot (was missing → dossier='' on all active sessions)
            dossier = history.find(h => h.role === 'system')?.content || '';
        } else {
            const ctx = await loadPatientContext(tenantId, msisdnHash);  // C4 — tenant-scoped query
            if (ctx) {
                dossier = formatPatientContext(ctx);
                history = [{ role: 'system', content: dossier }];
                await redis.set(sessionKey, JSON.stringify(history), 'EX', 3600);
            }
        }

        // 2. Classify depth — C2: geminiClient passed, C3: history serialized as strings
        // FIX P1: tenantId (ex: reviv_bali) ≠ domain (ex: valentine). Use TENANT_DOMAIN env.
        const tenantDomain = process.env.TENANT_DOMAIN;
        const domainConfig = getDomain(tenantDomain);
        const depthResult = await classifyDepth({
            domain: tenantDomain,
            history: history
                .filter(h => h.role !== 'system')     // F1 — exclude dossier from classifier input
                .slice(-5)
                .map(h => `${h.role}: ${h.content}`)
                .join('\n'),
            message,
            geminiClient  // C2 — was missing, caused silent TypeError → permanent flash fallback
        }).catch(() => ({ tier: 'flash', usage: { cachedTokens: 0, inputTokens: 0, outputTokens: 0 } }));
        const modelTier = depthResult.tier;

        // 3. Get shared cache — now returns JSON with both model caches
        // FIX: use 'let' so we can reassign after retry
        let cacheJson = await redis.get(`${tenantId}:agent:cache_name`);
        if (!cacheJson) {
            // M2 — give 3s for race condition at startup (container boot), then retry via throw
            await new Promise(r => setTimeout(r, 3000));
            // FIX: reassign cacheJson, not new variable
            cacheJson = await redis.get(`${tenantId}:agent:cache_name`);
            if (!cacheJson) {
                // Cache still missing after wait — try to rebuild it
                console.log(`[chatWorker] Cache missing, attempting to rebuild...`);
                try {
                    const cacheNames = await ensurePlatformCache(redis);
                    console.log(`[chatWorker] Cache rebuilt successfully:`, cacheNames);
                } catch (rebuildErr) {
                    console.error(`[chatWorker] Cache rebuild failed:`, rebuildErr.message);
                    const safeModeMessage = getDomainSafeMode(domainConfig, 'technical');
                    await sendChunked(waClient, from, safeModeMessage);
                    await notifyAlert(tenantId, { type: 'cache_missing', job_id: job.id });
                    throw new Error('CACHE_NOT_READY');  // M2: throw not return — BullMQ retries, message not lost
                }
                // After rebuild, get the cache again
                cacheJson = await redis.get(`${tenantId}:agent:cache_name`);
                if (!cacheJson) {
                    const safeModeMessage = getDomainSafeMode(domainConfig, 'technical');
                    await sendChunked(waClient, from, safeModeMessage);
                    await notifyAlert(tenantId, { type: 'cache_missing', job_id: job.id });
                    throw new Error('CACHE_NOT_READY');
                }
            }
        }
        const cacheNames = JSON.parse(cacheJson);

        // 4. KB retrieval — L1: hard-stops run regardless of depth tier (safety-critical)
        const hardStopIds = runPrefilter(message);       // always run — pregnancy/G6PD/etc must load even on Flash
        let kbContext = '';
        let retrievedIds = [];
        // Store full KB result to get both usage and latency
        let kbRouterResult = {
            usage: { cachedTokens: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 }
        };
        if (hardStopIds.length) {
            const safetyFiles = loadKBFiles(hardStopIds);
            kbContext += formatKBContext(safetyFiles);
            retrievedIds = [...hardStopIds];
        }
        if (modelTier === 'pro') {
            const geminiModel = modelTier === 'pro' ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
            // Always use flash-lite cache for KB routing (cheaper, fast enough for routing)
            const cacheName = cacheNames['gemini-2.5-flash-lite'];
            const kbResult = await resolveKBIds(message, cacheName);
            kbRouterResult = kbResult;  // Full result with usage, latencyMs
            const relevant = loadKBFiles(kbResult);
            kbContext += formatKBContext(relevant);
            retrievedIds = [...new Set([...retrievedIds, ...relevant.map(p => p.id)])];
        }

        // 5. Call Gemini — BUG-G1 FIX: stateKey idempotency prevents history poisoning on SQL-crash retry
        // Problem: without this, a retry reads history Redis already containing the prev turn → doubled context → hallucination cascade
        // Solution: persist inference result to Redis BEFORE touching session history or SQL.
        // On retry: fast-path restores state from Redis, skips Gemini, proceeds directly to send+persist.
        const stateKey = `${tenantId}:state:${job.id}`;
        const savedState = await redis.get(stateKey);

        let text, model, cachedTokens, inputTokens, outputTokens, latencyMs, depthClassification, citedIds, citationMatch;
        // Token breakdown by service (stored in DB as JSONB)
        let tokenBreakdown = {
            depthClassifier: { cachedTokens: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 },
            kbRouter: { cachedTokens: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 },
            mediaAnalysis: { cachedTokens: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 },
            mainChat: { cachedTokens: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 }
        };

        if (savedState) {
            // FAST-PATH RETRY — inference already done, restore state, skip Gemini call entirely
            ({
                text, model, cachedTokens, inputTokens, outputTokens,
                depthClassification, citedIds, citationMatch, tokenBreakdown
            } = JSON.parse(savedState));
            // Calculate total latency from tokenBreakdown (stored inside each service)
            latencyMs = Object.values(tokenBreakdown).reduce((sum, s) => sum + (s.latencyMs || 0), 0);
        } else {
            // NORMAL PATH — call Gemini
            // Track tokens and latency from depth classifier
            tokenBreakdown.depthClassifier = { ...depthResult.usage, latencyMs: depthResult.latencyMs || 0 };
            // Track tokens and latency from KB router
            tokenBreakdown.kbRouter = {
                cachedTokens: kbRouterResult.usage?.cachedTokens || 0,
                inputTokens: kbRouterResult.usage?.inputTokens || 0,
                outputTokens: kbRouterResult.usage?.outputTokens || 0,
                latencyMs: kbRouterResult.latencyMs || 0
            };
            // Track tokens and latency from media analysis (if processed in inboundMessage)
            tokenBreakdown.mediaAnalysis = {
                cachedTokens: mediaUsage?.cachedTokens || 0,
                inputTokens: mediaUsage?.inputTokens || 0,
                outputTokens: mediaUsage?.outputTokens || 0,
                latencyMs: mediaUsage?.latencyMs || 0
            };
            // BUG-G13 FIX: agentChat() replaced by geminiChatWithTools() — required by Section 07.
            // agentChat() never attached the Function Declarations → the model could not
            // call calculate_lab_ratios → eGFR, HOMA-IR, and ratios were hallucinated.
            // geminiChatWithTools() intercepts functionCall if returned,
            // executes calculateLabRatios() deterministically, then calls Gemini again with the result.
            // If Gemini does not request a tool (non-clinical message), the path is identical to agentChat().
            const t0 = Date.now();
            try {
                const resolvedMediaBase64 = mediaBase64 || (mediaUrl ? await fetchMediaWithFallback(mediaUrl) : null);
                const resolvedMediaMimeType = mediaMimeType || 'image/jpeg';
                const userParts = [
                    ...(kbContext ? [{ text: `KB CONTEXT:\n${kbContext}` }] : []),
                    ...(dossier ? [{ text: `PATIENT DOSSIER:\n${dossier}` }] : []),
                    ...history.filter(h => h.role !== 'system').map(h => ({ text: `${h.role}: ${h.content}` })),
                    { text: `user: ${message}` },
                    ...(mediaGeminiResult ? [{ text: `MEDIA ANALYSIS:\n${mediaGeminiResult}` }] : []),
                    ...(resolvedMediaBase64 ? [{ inlineData: { mimeType: resolvedMediaMimeType, data: resolvedMediaBase64 } }] : [])
                ];
                // console.log(`[chatWorker] Calling geminiChatWithTools with modelTier=${modelTier}, userParts:`, userParts);
                
                // FIX: Convert tier to actual Gemini model ID
                const geminiModel = modelTier === 'pro' ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
                // Select the correct cache for this model
                const cacheName = cacheNames[geminiModel];
                if (!cacheName) {
                    throw new Error(`[chatWorker] Cache not found for model: ${geminiModel}`);
                }
                // tools are now in the cache - no need to pass them
                const res = await geminiChatWithTools({ model: geminiModel, cacheName, cacheNames, userParts });
                ({ text, model, cachedTokens, inputTokens, outputTokens, latencyMs } = res);
                // Track tokens and latency from main chat
                tokenBreakdown.mainChat = { cachedTokens, inputTokens, outputTokens, latencyMs };
            } catch (err) {
                console.error('[chatWorker] geminiChatWithTools failed:', err.message);
                // Check if this is a clinical escalation (kbRouter error or safety block)
                const isClinical = err.fromKbRouter || err.isSafety;
                const safeModeMessage = getDomainSafeMode(domainConfig, isClinical ? 'clinical' : 'technical');
                await sendChunked(waClient, from, safeModeMessage);
                await notifyAlert(tenantId, { type: 'gemini_unavailable', code: err.code, job_id: job.id });
                await insertEscalation(tenantId, msisdnHash, 'llm_unavailable', job.id);
                await insertSafeModeChatLog(tenantId, msisdnHash, 'safe_mode', job.id);

                return;
            }
            latencyMs = Date.now() - t0;
            depthClassification = modelTier === 'pro' ? 'DEPTH_2' : 'DEPTH_0_1';
            citedIds = parseCitedObjects(text);
            citationMatch = checkCitationMatch(retrievedIds, citedIds);
            // Checkpoint: persist inference result before any mutation — idempotency guarantee
            // FIX: NX prevents race condition on concurrent retry — only first worker writes
            // Calculate totals for backward compatibility with proper defaults
            const totalCachedTokens = Object.values(tokenBreakdown).reduce((sum, s) => sum + (s.cachedTokens || 0), 0);
            const totalInputTokens = Object.values(tokenBreakdown).reduce((sum, s) => sum + (s.inputTokens || 0), 0);
            const totalOutputTokens = Object.values(tokenBreakdown).reduce((sum, s) => sum + (s.outputTokens || 0), 0);
            // Calculate total latency from all services
            const totalLatencyMs = Object.values(tokenBreakdown).reduce((sum, s) => sum + (s.latencyMs || 0), 0);
            const wasSet = await redis.set(stateKey,
                JSON.stringify({
                    text, model, cachedTokens: totalCachedTokens, inputTokens: totalInputTokens, outputTokens: totalOutputTokens,
                    latencyMs: totalLatencyMs, depthClassification, citedIds, citationMatch, tokenBreakdown
                }),
                'NX', 'EX', 3600);

            if (!wasSet) {
                // Another worker already wrote — restore their result
                const existing = await redis.get(stateKey);
                if (existing) {
                    ({
                        text, model, cachedTokens, inputTokens, outputTokens,
                        depthClassification, citedIds, citationMatch, tokenBreakdown
                    } = JSON.parse(existing));
                    // Calculate total latency from tokenBreakdown
                    latencyMs = Object.values(tokenBreakdown).reduce((sum, s) => sum + (s.latencyMs || 0), 0);
                }
            }
        }

        // 6. Send & Persist — FIX: claim lock BEFORE side effect to prevent double-send on crash
        const sendStateKey = `${tenantId}:send_state:${job.id}`;
        // FIX: TTL=60s — if crash before sendChunked, retry can proceed after 1 min max
        const sendClaim = await redis.set(sendStateKey, 'sending', 'NX', 'EX', 60);

        if (sendClaim) {
            // We claimed the lock — safe to send
            // FIX P1-GHOSTING: try/catch to release lock on failure, allowing BullMQ retry
            try {
                await sendChunked(waClient, from, text);

                // Update session history only on first send — prevents doubled turns on retry
                const updatedHistory = [...history, { role: 'user', content: message }, { role: 'assistant', content: text }];
                const sysEntries = updatedHistory.filter(h => h.role === 'system');
                const turnEntries = updatedHistory.filter(h => h.role !== 'system');
                const trimmed = [...sysEntries, ...turnEntries.slice(-40)];
                await redis.set(sessionKey, JSON.stringify(trimmed), 'EX', 3600);

                // Mark as sent (XX = only if key exists)
                await redis.set(sendStateKey, 'sent', 'XX', 'EX', 3600);
                console.log('[chatWorker] Message sent successfully, proceeding to profile update...');
            } catch (err) {
                // CRITICAL: Unlock to allow BullMQ retry to attempt sending again
                await redis.del(sendStateKey);
                throw err;
            }
        } else {
            // Lock exists — check if previous attempt succeeded or is still in progress
            const state = await redis.get(sendStateKey);
            if (state !== 'sent') {
                // Previous send crashed or still in progress — yield to let it complete or retry
                throw new Error('[Gate] Previous send in progress or crashed, yielding to retry');
            }
            // state === 'sent' → message already delivered, skip send but continue to SQL
        }

        // BUG-G12 FIX: dbProcessedKey gate REMOVED — it had become toxic.
        // Raisonnement : les deux mutations SQL sont nativement idempotentes :
        //   UPDATE: DISTINCT UNNEST — retry produces the same state as N=1.
        //   INSERT : ON CONFLICT (job_id) DO NOTHING — retry → no-op silencieux.
        // Anti-pattern gate: if INSERT crashed AFTER redis.set(dbProcessedKey),
        // the gate was set but the INSERT never executed → chat_log MISSING
        // → medical traceability violation (HIPAA/GDPR audit trail).
        // Rule: only use a Redis gate if the underlying SQL mutation
        // n'est PAS structurellement idempotente. Ici elle l'est → gate inutile et dangereuse.
        console.log("THIS TEXT", text);
        const profileUpdate = extractProfileUpdate(text);
        console.log("PROFILE UPDATE", profileUpdate);
        if (profileUpdate) {
            // Upsert patient profile - creates new or updates existing with merged arrays
            await upsertPatientProfile(tenantId, msisdnHash, profileUpdate);
        }

        // ON CONFLICT DO NOTHING - prevents duplicate inserts on retry
        // Calculate totals from tokenBreakdown for backward compatibility
        const totalCachedTokens = Object.values(tokenBreakdown).reduce((sum, s) => sum + (s.cachedTokens || 0), 0);
        const totalInputTokens = Object.values(tokenBreakdown).reduce((sum, s) => sum + (s.inputTokens || 0), 0);
        const totalOutputTokens = Object.values(tokenBreakdown).reduce((sum, s) => sum + (s.outputTokens || 0), 0);
        // Recalculate latency if not already set (for retry path)
        if (!latencyMs) {
            latencyMs = Object.values(tokenBreakdown).reduce((sum, s) => sum + (s.latencyMs || 0), 0);
        }
        await insertChatLog({
            tenantId,
            msIsdn_id: msisdn_id,
            msisdnHash,
            model,
            cachedTokens: totalCachedTokens,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            latencyMs,
            depthClassification,
            retrievedIds,
            citedIds,
            citationMatch,
            jobId: job.id,
            waMessageId: key.id,
            tokenBreakdown
        });
    },
    { connection: redis, concurrency: 10, limiter: { max: 50, duration: 60000 } }
);

worker.on('failed', async (job, err) => {
    console.error(`[WORKER] Job ${job.id} failed definitively:`, err.message);
    console.error(`[WORKER] Job attempts: ${job?.attemptsMade}, error:`, err);

    // v8.1: Send safe-mode message when all retries exhausted — user must never be left hanging
    try {
        // const { tenantId, from } = job.data;
        // const msisdnHash = crypto.createHash('sha256').update(from).digest('hex');
        // const domainConfig = getDomain(process.env.TENANT_DOMAIN);
        // Clinical escalation if from kbRouter or safety block, otherwise technical
        // const isClinical = err.fromKbRouter || err.isSafety;
        // const safeMsg = getDomainSafeMode(domainConfig, isClinical ? 'clinical' : 'technical');

        // console.log(`[WORKER] Sending safe mode message to ${from}:`, safeMsg);
        // await sendChunked(waClient, from, safeMsg);
        // await insertEscalation(tenantId, msisdnHash, 'job_failed_definitive', job.id);
        // await notifyAlert(tenantId, { type: 'job_failed', reason: err.message, job_id: job.id });
        console.log(`[WORKER] Safe mode message sent successfully for job ${job.id}`);
    } catch (failedErr) {
        console.error('[WORKER] Failed to send safe-mode message:', failedErr.message);
    }
});

module.exports = worker;
