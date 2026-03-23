// services/geminiChat.js
const axios = require('axios');

const { ai, flash } = require('./geminiClient');
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
const KEY = process.env.GEMINI_API_KEY;

const MAX_OUTPUT_TOKENS = 8192;

// services/geminiChat.js — add tools to payload

async function agentChat({ modelTier, cacheName, kbContext, dossier, history, message, mediaBase64 = null }) {
    const model = modelTier === 'pro' ? 'gemini-2.5-pro' : 'gemini-2.5-flash';

    // Build dynamic parts (NOT in cache)
    const userParts = [];

    // 1. Inject Medical KB if available (Dynamic RAG)
    if (kbContext) {
        userParts.push({ text: `${kbContext}\n\n---\n` });
    }

    // 2. Inject User Context & History
    userParts.push({ text: `USER CONTEXT:\n${dossier}` });
    // C3 — history elements are {role, content} objects — serialize to string for Gemini parts
    userParts.push(...history
        .filter(h => h.role !== 'system')  // dossier already in dossier field — no double injection
        .slice(-10)
        .map((h) => ({ text: `${h.role}: ${h.content}` })));

    // 3. Inject Current Message & Media
    userParts.push({ text: `Patient: ${message}` });
    if (mediaBase64) {
        userParts.push({ inlineData: { mimeType: 'image/jpeg', data: mediaBase64 } });
    }

    const payload = {
        cachedContent: cacheName,
        contents: [{ role: 'user', parts: userParts }],

        // TOOL DECLARATIONS — Node.js executes, Gemini never computes
        tools: [
            {
                functionDeclarations: [
                    {
                        name: "calculate_lab_ratios",
                        description: "Calculates deterministic values from user-provided data. For health: clinical ratios (HOMA-IR, TyG, eGFR). For commerce: prices, availability. MUST be called whenever deterministic computation is required.",
                        parameters: {
                            type: "OBJECT",
                            properties: {
                                markers: {
                                    type: "OBJECT",
                                    description: "Dictionary of extracted markers. Keys must be standardized (e.g., FBG, TG, HDL, creatinine)."
                                },
                                patient_context: {
                                    type: "OBJECT",
                                    properties: {
                                        age: { type: "INTEGER" },
                                        sex: { type: "STRING" }
                                    }
                                }
                            },
                            required: ["markers"]
                        }
                    }
                ]
            }
        ],
        generationConfig: { temperature: 0.3, maxOutputTokens: MAX_OUTPUT_TOKENS }
    };

    // C7 — wrap axios: detect CACHE_EXPIRED (404), rate limit (429), server errors (5xx)
    // Without this, a Gemini cache expiry causes 100% job crashes for ~400s (gap between Gemini TTL and Redis TTL)
    const timeout = model === 'gemini-2.5-pro' ? 60000 : 30000; // 40s for pro, 15s for flash
    let data;
    try {
        ({ data } = await axios.post(
            `${GEMINI_API}/${model}:generateContent?key=${KEY}`,
            payload,
            { timeout }
        ));
    } catch (e) {
        const status = e.response?.status;
        const errMsg = e.response?.data?.error?.message || '';
        if (status === 404 && errMsg.includes('Cached content')) {
            // Gemini expired the cache before Redis TTL lapsed — force rebuild on next request
            throw Object.assign(new Error('[agentChat] Gemini cache expired — Redis invalidation required'), { code: 'CACHE_EXPIRED' });
        }
        if (status === 429 || status >= 500) throw e;  // BullMQ will retry with backoff
        throw new Error(`[agentChat] Fatal Gemini error ${status}: ${JSON.stringify(e.response?.data)}`);
    }

    // C5 — safety filter / empty response guard (finishReason: SAFETY or empty parts)
    const candidate = data.candidates?.[0];
    if (!candidate || candidate.finishReason === 'SAFETY' || !candidate.content?.parts?.[0]?.text) {
        const err = new Error(`[agentChat] Blocked or empty response. Reason: ${candidate?.finishReason}`);
        if (candidate?.finishReason === 'SAFETY') {
            err.isSafety = true;
        }
        throw err;
    }
    return {
        text: candidate.content.parts[0].text,
        model: model,
        cachedTokens: data.usageMetadata?.cachedContentTokenCount || 0,
        inputTokens: data.usageMetadata?.promptTokenCount || 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount || 0
    };
}

// services/geminiChat.js — add geminiChatWithTools() for tool-aware calls
// NOTE: tools are now included in the cache, not in the request
async function geminiChatWithTools({ model, cacheName, userParts }) {
    const payload = {
        cachedContent: cacheName,
        contents: [{ role: 'user', parts: userParts }],
        // tools are now in the cache - do NOT pass them here or Gemini will return 400
        generationConfig: { temperature: 0.3, maxOutputTokens: MAX_OUTPUT_TOKENS }
    };

    // DEBUG: Log request details (remove sensitive data in production)
    console.log('[geminiChatWithTools] Request details:');
    console.log('  model:', model);
    console.log('  cacheName:', cacheName);
    console.log('  userParts length:', userParts.length);

    const timeout = model === 'gemini-2.5-pro' ? 60000 : 30000; // 40s for pro, 15s for flash
    let data;
    try {
        ({ data } = await axios.post(`${GEMINI_API}/${model}:generateContent?key=${KEY}`, payload, { timeout }));
    } catch (e) {
        console.error('[geminiChatWithTools] Gemini API error:');
        console.error('  Status:', e);
        console.error('  Error:', JSON.stringify(e, null, 2));
        throw e;
    }

    // Validate response structure
    if (!data?.candidates || !data.candidates[0]) {
        console.error('[geminiChatWithTools] Invalid response structure from Gemini:');
        console.error('  Response:', JSON.stringify(data, null, 2));
        throw new Error('[geminiChatWithTools] Gemini returned invalid response (missing candidates)');
    }

    const candidate = data.candidates[0];

    // C5 — safety filter check (finishReason: SAFETY)
    if (candidate.finishReason === 'SAFETY') {
        const err = new Error('[geminiChatWithTools] Response blocked by safety filter');
        err.isSafety = true;
        throw err;
    }

    // 1. Check if Gemini is requesting a tool call instead of returning text
    if (candidate.content.parts[0].functionCall) {
        const { name, args } = candidate.content.parts[0].functionCall;

        // 2. Execute locally — deterministic math, no LLM involved
        const { calculateLabRatios } = require('./labCalculator');
        let toolResult;
        if (name === 'calculate_lab_ratios') {
            toolResult = calculateLabRatios(args.markers, args.patient_context);
        }

        // 3. Return result to Gemini so it can draft the WhatsApp message
        const followUp = {
            cachedContent: cacheName,
            contents: [
                { role: 'user', parts: userParts },
                { role: 'model', parts: [{ functionCall: { name, args: args } }] },
                { role: 'user', parts: [{ functionResponse: { name, response: { result: toolResult } } }] }
            ],
            generationConfig: { temperature: 0.1, maxOutputTokens: MAX_OUTPUT_TOKENS }  // M5: deterministic for clinical math follow-up
        };
        // BUG-G8 FIX: timeout added on followUp call (uses same model-based timeout)
        let d2;
        try {
            ({ data: d2 } = await axios.post(`${GEMINI_API}/${model}:generateContent?key=${KEY}`, followUp, { timeout }));
        } catch (e) {
            console.error('[geminiChatWithTools] Follow-up API error:');
            console.error('  Status:', e.response?.status);
            console.error('  Error:', JSON.stringify(e.response?.data, null, 2));
            throw e;
        }

        // Validate follow-up response structure
        if (!d2?.candidates || !d2.candidates[0] || !d2.candidates[0].content?.parts?.[0]?.text) {
            console.error('[geminiChatWithTools] Invalid follow-up response structure from Gemini:');
            console.error('  Response:', JSON.stringify(d2, null, 2));
            throw new Error('[geminiChatWithTools] Gemini returned invalid follow-up response');
        }

        // C5 — safety filter check on follow-up
        if (d2.candidates[0].finishReason === 'SAFETY') {
            const err = new Error('[geminiChatWithTools] Follow-up response blocked by safety filter');
            err.isSafety = true;
            throw err;
        }

        // FIX: Normalize return shape to match chatWorker destructuring
        const usage2 = d2.usageMetadata || {};
        return {
            text: d2.candidates[0].content.parts[0].text,
            model: model,
            cachedTokens: usage2.cachedContentTokenCount || 0,
            inputTokens: usage2.promptTokenCount || 0,
            outputTokens: usage2.candidatesTokenCount || 0
        };
    }

    // Validate candidate structure before accessing
    if (!candidate?.content?.parts?.[0]?.text) {
        console.error('[geminiChatWithTools] Invalid candidate structure:');
        console.error('  Candidate:', JSON.stringify(candidate, null, 2));
        throw new Error('[geminiChatWithTools] Candidate missing content text');
    }

    // FIX: Normalize return shape to match chatWorker destructuring
    const usage = data.usageMetadata || {};
    return {
        text: candidate.content.parts[0].text,
        model: model,
        cachedTokens: usage.cachedContentTokenCount || 0,
        inputTokens: usage.promptTokenCount || 0,
        outputTokens: usage.candidatesTokenCount || 0
    };
}

// BUG-G5 FIX: geminiChatWithTools must be exported here — agentChat-only export makes tools unreachable
module.exports = { agentChat, geminiChatWithTools };