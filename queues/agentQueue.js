// queues/agentQueue.js
// BullMQ queue for async WhatsApp message processing
// Domain-agnostic: same queue handles all tenants (valentine, majordome, etc.)

const { Queue } = require('bullmq');
const redis = require('../config/redis2');

// Single queue for all agent chat jobs — tenant isolation via job.data.tenantId
const agentQueue = new Queue('agent-chat-jobs', {
  connection: redis,
  defaultJobOptions: {
    attempts: 1,  // No retries — fail fast and notify user
    removeOnComplete: 100,  // Keep last 100 completed jobs
    removeOnFail: 50        // Keep last 50 failed jobs
  }
});

/**
 * Add a chat job to the queue
 * @param {Object} data - Job data
 * @param {string} data.tenantId - Tenant ID (from env or job data)
 * @param {string} data.msIsdn_id - MSISDN ID (optional)
 * @param {string} data.from - Sender phone number
 * @param {string} data.message - Message text
 * @param {string} [data.mediaUrl] - Optional media URL
 * @param {Object} [options] - BullMQ job options
 */
async function addChatJob(data, options = {}) {
  return await agentQueue.add('chat-message', data, options);
}

module.exports = { agentQueue, addChatJob };