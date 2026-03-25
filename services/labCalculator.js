// services/labCalculator.js
function calculateLabRatios(markers, context = {}) {
  console.log(`[LabCalculator] Calculating ratios for markers:`, markers);

  const results = {};

  // HOMA-IR = (fasting glucose mmol/L × fasting insulin µIU/mL) / 22.5
  if (markers.FBG && markers.fasting_insulin) {
    const fbg_mmol = markers.FBG_unit === 'mg/dL' ? markers.FBG / 18.0 : markers.FBG;
    results.HOMA_IR = round2((fbg_mmol * markers.fasting_insulin) / 22.5);
  }

  // TyG index = ln(TG mg/dL × FBG mg/dL / 2)
  if (markers.TG && markers.FBG) {
    const tg_mgdl  = markers.TG_unit  === 'mmol/L' ? markers.TG  * 88.57 : markers.TG;
    const fbg_mgdl = markers.FBG_unit === 'mmol/L' ? markers.FBG * 18.0  : markers.FBG;
    results.TyG_index = round2(Math.log(tg_mgdl * fbg_mgdl / 2));
  }

  // eGFR — CKD-EPI 2021 race-free (KDIGO 2021) — ckdEpi2021 defined below calculateLabRatios
  if (markers.creatinine && markers.age) {
    results.eGFR = ckdEpi2021(markers.creatinine, markers.age, markers.sex);
  }

  results.computed_at = new Date().toISOString();

  console.log(`[LabCalculator] Computed results:`, results);
  
  return results;
}

function round2(n) { return Math.round(n * 100) / 100; }

// BUG-G6 FIX: CKD-EPI 2021 race-free formula — was called but never defined → ReferenceError on every renal panel
function ckdEpi2021(creatinine_mgdl, age, sex = 'M') {
  const kappa = (sex === 'F' || sex === "female") ? 0.7  : 0.9;
  const alpha = (sex === 'F' || sex === "female") ? -0.241 : -0.302;
  const scr_k = creatinine_mgdl / kappa;
  const base  = (sex === 'F' || sex === "female") ? 1.012 : 1.0;
  return round2(
    142 * Math.pow(Math.min(scr_k, 1), alpha)
        * Math.pow(Math.max(scr_k, 1), -1.200)
        * Math.pow(0.9938, age)
        * base
  );
}

module.exports = { calculateLabRatios };