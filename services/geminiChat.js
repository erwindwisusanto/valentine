// services/geminiChat.js
const { generateContent } = require('./geminiClient');

const MAX_OUTPUT_TOKENS = 8192;

// services/geminiChat.js — add geminiChatWithTools() for tool-aware calls
// NOTE: tools are in the cache (flash/pro only), NOT in the request
async function geminiChatWithTools({ model, cacheName, userParts }) {
    // DEBUG: Log request details (remove sensitive data in production)
    console.log('[geminiChatWithTools] Request details:');
    console.log('  model:', model);
    console.log('  cacheName:', cacheName);

    let result;
    try {
        result = await generateContent({
            model,
            contents: [{ role: 'user', parts: userParts }],
            config: {
                cachedContent: cacheName,
                generationConfig: { temperature: 0.3, maxOutputTokens: MAX_OUTPUT_TOKENS }
            }
        });
        console.log('[geminiChatWithTools] API response received');
    } catch (e) {
        console.error('[geminiChatWithTools] Gemini API error:');
        console.error('  Error:', JSON.stringify(e, null, 2));
        throw e;
    }

    // Validate response structure
    if (!result || !result.candidates || result.candidates.length === 0) {
        console.error('[geminiChatWithTools] Invalid response structure from Gemini:');
        console.error('  Response:', JSON.stringify(result, null, 2));
        throw new Error('[geminiChatWithTools] Gemini returned invalid response (missing candidates)');
    }

    console.log('[geminiChatWithTools] API response structure:');
    console.log('  result.candidates.length:', result.candidates.length);
    console.log('  candidate:', JSON.stringify(result.candidates[0], null, 2));

    const candidate = result.candidates[0];

    // C5 — safety filter check (finishReason: SAFETY)
    if (candidate.finishReason === 'SAFETY') {
        const err = new Error('[geminiChatWithTools] Response blocked by safety filter');
        err.isSafety = true;
        throw err;
    }

    // Validate candidate.content.parts exists before accessing
    if (!candidate?.content?.parts?.[0]) {
        console.error('[geminiChatWithTools] Invalid candidate structure (missing parts):');
        console.error('  Candidate:', JSON.stringify(candidate, null, 2));
        throw new Error('[geminiChatWithTools] Candidate missing content parts');
    }

    // 1. Check if Gemini is requesting a tool call
    if (candidate.content.parts[0].functionCall) {
        const { name, args } = candidate.content.parts[0].functionCall;

        // Only handle calculate_lab_ratios — reject all other function calls
        if (name === 'calculate_lab_ratios') {
            // 2. Execute locally — deterministic math, no LLM involved
            const { calculateLabRatios } = require('./labCalculator');

            let toolResult;
            toolResult = calculateLabRatios(args.markers, args.patient_context);

            // 3. Return result to Gemini so it can draft the WhatsApp message
            let d2;
            try {
                d2 = await generateContent({
                    model,
                    contents: [
                        { role: 'user', parts: userParts },
                        { role: 'model', parts: [{ functionCall: { name, args: args } }] },
                        { role: 'user', parts: [{ functionResponse: { name, response: { result: toolResult } } }] }
                    ],
                    config: {
                        cachedContent: cacheName,
                        generationConfig: { temperature: 0.1, maxOutputTokens: MAX_OUTPUT_TOKENS }
                    }
                });
            } catch (e) {
                console.error('[geminiChatWithTools] Follow-up API error:');
                console.error('  Error:', JSON.stringify(e, null, 2));
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
        } else {
            // Model hallucinated a function call that doesn't exist
            console.warn(`[geminiChatWithTools] Model called unknown function: ${name}`);
            console.warn(`[geminiChatWithTools] Args:`, JSON.stringify(args));
            console.warn(`[geminiChatWithTools] Retrying with flash-lite cache (no tools)...`);

            // Retry with flash-lite cache (has system instruction + KB context, but NO tools)
            const flashLiteCache = cacheName.replace(/gemini-2\.5-(flash|pro)/, 'gemini-2.5-flash-lite');
            const retryResult = await generateContent({
                model,
                contents: [{ role: 'user', parts: userParts }],
                config: {
                    cachedContent: flashLiteCache,
                    generationConfig: { temperature: 0.3, maxOutputTokens: MAX_OUTPUT_TOKENS }
                }
            });

            if (!retryResult?.candidates?.[0]?.content?.parts?.[0]?.text) {
                throw new Error('[geminiChatWithTools] Retry failed - no text response');
            }

            const usage = retryResult.usageMetadata || {};
            return {
                text: retryResult.candidates[0].content.parts[0].text,
                model: model,
                cachedTokens: usage.cachedContentTokenCount || 0,
                inputTokens: usage.promptTokenCount || 0,
                outputTokens: usage.candidatesTokenCount || 0
            };
        }
    }

    // Validate candidate structure before accessing
    if (!candidate?.content?.parts?.[0]?.text) {
        console.error('[geminiChatWithTools] Invalid candidate structure:');
        console.error('  Candidate:', JSON.stringify(candidate, null, 2));
        throw new Error('[geminiChatWithTools] Candidate missing content text');
    }

    // FIX: Normalize return shape to match chatWorker destructuring
    const usage = result.usageMetadata || {};
    return {
        text: candidate.content.parts[0].text,
        model: model,
        cachedTokens: usage.cachedContentTokenCount || 0,
        inputTokens: usage.promptTokenCount || 0,
        outputTokens: usage.candidatesTokenCount || 0
    };
}

module.exports = { geminiChatWithTools };
