// services/patientDb.js
// Database operations for patient profiles and chat logs
const { query } = require('../db');
const { randomUUID } = require('crypto');

/**
 * Get existing patient profile for merging arrays
 * @param {string} tenantId
 * @param {string} msisdnHash
 * @returns {Promise<Object|null>} Patient profile or null if not found
 */
async function getPatientProfile(tenantId, msisdnHash) {
  const result = await query(
    `SELECT
      allergies,
      conditions,
      medications,
      last_labs,
      terrain_flags,
      follow_up_note
    FROM patient_profiles
    WHERE tenant_id = $1
      AND msisdn_hash = $2`,
    [tenantId, msisdnHash]
  );
  return result.rows[0] || null;
}

/**
 * Create a new patient profile
 * @param {string} tenantId
 * @param {string} msisdnHash
 * @param {Object} profileUpdate - Profile data from AI extraction
 * @returns {Promise<Object>}
 */
async function createPatientProfile(tenantId, msisdnHash, profileUpdate) {
  const result = await query(
    `INSERT INTO patient_profiles (
      id,
      tenant_id,
      msisdn_hash,
      first_name,
      age,
      sex,
      location,
      language,
      allergies,
      conditions,
      medications,
      last_labs,
      terrain_flags,
      follow_up_note
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
    )
    RETURNING *`,
    [
      randomUUID(), // Generate UUID for id
      tenantId,
      msisdnHash,
      profileUpdate.first_name || null,
      profileUpdate.age || null,
      profileUpdate.sex || null,
      profileUpdate.location || null,
      profileUpdate.language || 'en',
      profileUpdate.allergies || [], // ARRAY column - pass array directly
      profileUpdate.conditions || [], // ARRAY column - pass array directly
      profileUpdate.medications ? JSON.stringify(profileUpdate.medications) : null, // jsonb
      profileUpdate.last_labs ? JSON.stringify(profileUpdate.last_labs) : null, // jsonb
      profileUpdate.terrain_flags ? JSON.stringify(profileUpdate.terrain_flags) : null, // jsonb
      profileUpdate.follow_up_note || null
    ]
  );
  return result.rows[0];
}

/**
 * Update existing patient profile with new data, merging arrays
 * @param {string} tenantId
 * @param {string} msisdnHash
 * @param {Object} existing - Current profile data
 * @param {Object} profileUpdate - New profile data from AI
 * @returns {Promise<Object>}
 */
async function updatePatientProfile(tenantId, msisdnHash, existing, profileUpdate) {
  // Merge arrays with new values, removing duplicates
  const mergedAllergies = [...new Set([...(existing.allergies || []), ...(profileUpdate.allergies || [])])];
  const mergedConditions = [...new Set([...(existing.conditions || []), ...(profileUpdate.conditions || [])])];

  const result = await query(
    `UPDATE patient_profiles
    SET
      allergies = $1,
      conditions = $2,
      medications = $3,
      last_labs = $4,
      terrain_flags = $5,
      follow_up_note = $6,
      updated_at = NOW()
    WHERE tenant_id = $7
      AND msisdn_hash = $8
    RETURNING *`,
    [
      mergedAllergies, // ARRAY column - pass array directly
      mergedConditions, // ARRAY column - pass array directly
      profileUpdate.medications !== undefined
        ? JSON.stringify(profileUpdate.medications)
        : existing.medications, // jsonb
      profileUpdate.last_labs !== undefined
        ? JSON.stringify(profileUpdate.last_labs)
        : existing.last_labs, // jsonb
      profileUpdate.terrain_flags !== undefined
        ? JSON.stringify(profileUpdate.terrain_flags)
        : existing.terrain_flags, // jsonb
      profileUpdate.follow_up_note ?? existing.follow_up_note,
      tenantId,
      msisdnHash
    ]
  );
  return result.rows[0];
}

/**
 * Upsert patient profile - update if exists, create if not
 * @param {string} tenantId
 * @param {string} msisdnHash
 * @param {Object} profileUpdate - Profile data from AI extraction
 * @returns {Promise<Object>} The created or updated profile
 */
async function upsertPatientProfile(tenantId, msisdnHash, profileUpdate) {
  const existing = await getPatientProfile(tenantId, msisdnHash);

  if (existing) {
    return await updatePatientProfile(tenantId, msisdnHash, existing, profileUpdate);
  } else {
    return await createPatientProfile(tenantId, msisdnHash, profileUpdate);
  }
}

/**
 * Insert a chat log entry
 * @param {Object} logData - Chat log data
 * @returns {Promise<Object>}
 */
async function insertChatLog(logData) {
  const result = await query(
    `INSERT INTO chat_logs (
      tenant_id,
      msisdn_id,
      msisdn_hash,
      model,
      cached_tokens,
      input_tokens,
      output_tokens,
      model_latency_ms,
      depth_classification,
      kb_objects_retrieved,
      kb_objects_cited,
      citation_match,
      job_id,
      created_at,
      wa_message_id,
      token_breakdown
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), $14, $15
    )
    RETURNING *`,
    [
      logData.tenantId,
      logData.msIsdn_id,
      logData.msisdnHash,
      logData.model,
      logData.cachedTokens,
      logData.inputTokens,
      logData.outputTokens,
      logData.model_latency_ms || logData.latencyMs, // Support both keys
      logData.depthClassification,
      logData.retrievedIds || [], // Pass array directly for ARRAY columns
      logData.citedIds || [],     // Pass array directly for ARRAY columns
      logData.citationMatch,
      String(logData.jobId),
      String(logData.waMessageId),
      logData.tokenBreakdown ? JSON.stringify(logData.tokenBreakdown) : null
    ]
  );
  return result.rows[0];
}

/**
 * Insert an escalation record for follow-up
 * @param {string} tenantId
 * @param {string} msisdnHash
 * @param {string} reason - Reason for escalation (e.g., 'llm_unavailable', 'job_failed_definitive')
 * @param {string} jobId - BullMQ job ID
 * @returns {Promise<Object>}
 */
async function insertEscalation(tenantId, msisdnHash, reason, jobId) {
  const result = await query(
    `INSERT INTO escalations (tenant_id, msisdn_hash, reason, job_id, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [tenantId, msisdnHash, reason, String(jobId)]
  );
  return result.rows[0];
}

/**
 * Insert a chat log entry for safe-mode scenarios
 * @param {string} tenantId
 * @param {string} msisdnHash
 * @param {string} model - Model identifier (e.g., 'safe_mode')
 * @param {string} jobId - BullMQ job ID
 * @returns {Promise<Object>}
 */
async function insertSafeModeChatLog(tenantId, msisdnHash, model, jobId) {
  const result = await query(
    `INSERT INTO chat_logs (
      tenant_id,
      msisdn_hash,
      model,
      safe_mode,
      job_id,
      created_at
    ) VALUES ($1, $2, $3, TRUE, $4, NOW())
    ON CONFLICT DO NOTHING
    RETURNING *`,
    [tenantId, msisdnHash, model, String(jobId)]
  );
  return result.rows[0];
}

module.exports = {
  getPatientProfile,
  createPatientProfile,
  updatePatientProfile,
  upsertPatientProfile,
  insertChatLog,
  insertEscalation,
  insertSafeModeChatLog,
};