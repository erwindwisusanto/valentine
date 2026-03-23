// config/domains.js
// Kreatif Bersama — All domains

const DOMAINS = {

    // ═══════════════════════════════════════════════════════════
    // 🏥 VALENTINE — Clinical (REVIV, Infusion Bali, IVDrip)
    // ✅ READY — KB_ROUTER + prompt + 80 KB files shipped
    // ═══════════════════════════════════════════════════════════
    'valentine': {
        displayName: 'Valentine Health Assistant',
        brands: ['REVIV Bali', 'Infusion Bali', 'IVDrip Bali'],
        promptFile: 'valentine_prompt.txt',
        kbFolder: 'valentine',

        depthRules: {
            classifierRole: 'clinical triage nurse',
            depth_0_1: 'Greetings, booking, simple follow-up, acute single-symptom, known protocol',
            depth_2: 'Chronic (>4 weeks), multi-system, labs/imaging, unmonitored meds, phenotype'
        },

        safeMode: {
            technicalMessage: "Sorry — temporary technical issue. We'll continue shortly.",
            clinicalMessage: "Our medical team will review and continue shortly.",
            alertType: 'clinical_escalation'
        },

        requiresCitations: true,
        piiFields: ['dob', 'medical_history', 'lab_results'],
        encryptLogs: true
    },

    // ═══════════════════════════════════════════════════════════
    // 🏠 MAJORDOME — Villa Concierge
    // ⏳ CONFIG ONLY — needs: kb/majordome/00_KB_ROUTER.txt + prompts/majordome_prompt.txt
    // ═══════════════════════════════════════════════════════════
    'majordome': {
        displayName: 'Majordome Concierge',
        brands: ['Majordome Bali'],
        promptFile: 'majordome_prompt.txt',
        kbFolder: 'majordome',

        depthRules: {
            classifierRole: 'luxury concierge assistant',
            depth_0_1: 'Restaurant reco, driver booking, simple activity, house info, check-in/out',
            depth_2: 'Multi-day itinerary, group event, complaint, special requests, emergency'
        },

        safeMode: {
            message: `I'm having trouble with your request. Please:
                        • WhatsApp our team: +62 XXX
                        • Or call the villa manager directly
                        We'll sort this out for you!`,
            alertType: 'concierge_escalation'
        },

        requiresCitations: false,
        piiFields: ['phone', 'villa_code'],
        encryptLogs: false
    },

    // ═══════════════════════════════════════════════════════════
    // 🍷 BALIDRINK — Alcohol Delivery
    // ⏳ CONFIG ONLY — needs: kb/balidrink/00_KB_ROUTER.txt + prompts/balidrink_prompt.txt
    // ═══════════════════════════════════════════════════════════
    'balidrink': {
        displayName: 'BaliDrink Assistant',
        brands: ['BaliDrink'],
        promptFile: 'balidrink_prompt.txt',
        kbFolder: 'balidrink',

        depthRules: {
            classifierRole: 'beverage order assistant',
            depth_0_1: 'Availability, price, simple order (1-5 items), delivery zone, order status',
            depth_2: 'Wine pairing, event supply (>10), rare/special order, complaint, bulk order'
        },

        safeMode: {
            message: `I'm having trouble processing your request. Please:
                        • WhatsApp us: +62 XXX
                        • Or try again in a few minutes
                        Cheers! 🍷`,
            alertType: 'order_escalation'
        },

        requiresCitations: false,
        piiFields: ['phone', 'address'],
        encryptLogs: false,

        // Age verification required
        ageVerification: true,
        minAge: 21
    },

    // ═══════════════════════════════════════════════════════════
    // 🚴 EBIKE — Rental & Purchase
    // ⏳ CONFIG ONLY — needs: kb/ebike/00_KB_ROUTER.txt + prompts/ebike_prompt.txt
    // ═══════════════════════════════════════════════════════════
    'ebike': {
        displayName: 'E-Bike Bali Assistant',
        brands: ['E-Bike Bali'],
        promptFile: 'ebike_prompt.txt',
        kbFolder: 'ebike',

        depthRules: {
            classifierRole: 'e-bike rental specialist',
            depth_0_1: 'Availability, price/model, simple rental (1-2), return location, shop hours',
            depth_2: 'Multi-day rental, group (>3), tour planning, purchase, insurance/damage'
        },

        safeMode: {
            message: `I'm unable to process your request right now. Please:
                        • WhatsApp us: +62 XXX
                        • Or visit our shop in Canggu
                        We'll get you riding! 🚴`,
            alertType: 'booking_escalation'
        },

        requiresCitations: false,
        piiFields: ['phone', 'passport'],
        encryptLogs: false
    }
};

function getDomain(key) {
    const d = DOMAINS[key];
    if (!d) throw new Error(`Unknown domain: ${key}. Valid: ${Object.keys(DOMAINS).join(', ')}. Note: only 'valentine' has KB+prompts shipped.`);
    return d;
}

module.exports = { DOMAINS, getDomain };