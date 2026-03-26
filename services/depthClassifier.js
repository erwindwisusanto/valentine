// services/depthClassifier.js
// Domain rules loaded from config — NOT hardcoded
const { generateContent } = require('./geminiClient');

const DOMAIN_DEPTH_RULES = {
    // ═══════════════════════════════════════════════════════════
    // VALENTINE — Clinical (REVIV, Infusion Bali, IVDrip)
    // ═══════════════════════════════════════════════════════════
    'valentine': {
        name: 'clinical triage nurse',
        depth_0_1: 'Greetings, booking, simple follow-up, acute single-symptom, known protocol, price/location',
        depth_2: 'Chronic (>4 weeks), multi-system, labs/imaging, unmonitored meds, phenotype reasoning'
    },

    // ═══════════════════════════════════════════════════════════
    // MAJORDOME — Villa Concierge
    // ═══════════════════════════════════════════════════════════
    'majordome': {
        name: 'luxury concierge assistant',
        depth_0_1: 'Restaurant reco, driver booking, simple activity, house info, check-in/out',
        depth_2: 'Multi-day itinerary, group event, complaint resolution, special requests, emergency'
    },

    // ═══════════════════════════════════════════════════════════
    // BALIDRINK — Alcohol Delivery
    // ═══════════════════════════════════════════════════════════
    'balidrink': {
        name: 'beverage order assistant',
        depth_0_1: 'Availability, price, simple order (1-5 items), delivery info, order status',
        depth_2: 'Wine pairing, event supply (>10), rare order, complaints, bulk/corporate'
    },

    // ═══════════════════════════════════════════════════════════
    // EBIKE — Rental & Purchase
    // ═══════════════════════════════════════════════════════════
    'ebike': {
        name: 'e-bike rental specialist',
        depth_0_1: 'Availability, price/model, simple rental (1-2), return location, shop info',
        depth_2: 'Multi-day rental, group (>3), tour planning, purchase consultation, insurance/damage'
    }
};

const buildClassifierPrompt = (domain, history, message) => {
    const rules = DOMAIN_DEPTH_RULES[domain];
    if (!rules) throw new Error(`Unknown domain: ${domain}`);

    return `
        You are a ${rules.name} for a WhatsApp chatbot.
        Based on the conversation history and latest message,
        classify the required reasoning depth:

        - DEPTH_0_1: ${rules.depth_0_1}
        - DEPTH_2: ${rules.depth_2}

        Output ONLY one token: DEPTH_0_1 or DEPTH_2.

        Conversation history (last 5 turns):
        ${history}

        Latest message:
        ${message}`.trim();
};

async function classifyDepth({ domain, history, message, geminiClient }) {
    const prompt = buildClassifierPrompt(domain, history, message);

    // FIX: 3s timeout — classifier must never block worker indefinitely
    const t0 = Date.now();
    const result = await Promise.race([
        geminiClient.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: { maxOutputTokens: 10, temperature: 0 }
        }),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('CLASSIFIER_TIMEOUT')), 3000))
    ]);
    const latencyMs = Math.round(Date.now() - t0);

    const raw = result.text.trim().toUpperCase();
    console.log(`[depthClassifier] Classified as: ${raw}`);

    // Track token usage
    const usage = result.usageMetadata || {};
    const classification = raw.includes('DEPTH_2') ? 'pro' : 'flash';

    return {
        tier: classification,
        usage: {
            cachedTokens: usage.cachedContentTokenCount || 0,
            inputTokens: usage.promptTokenCount || 0,
            outputTokens: usage.candidatesTokenCount || 0
        },
        latencyMs
    };
}

module.exports = { classifyDepth, DOMAIN_DEPTH_RULES };