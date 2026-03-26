// services/redis2.js
// Redis client — single instance for all operations (sessions, locks, cache)
// Uses ioredis for reliability and Lua scripting support

const Redis = require('ioredis');

// Parse REDIS_URL or use defaults
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const redis = new Redis(redisUrl, {
  // Connection settings
  maxRetriesPerRequest: null,       // Retry failed commands
  retryDelayOnFailover: 100,     // Wait 100ms between retries
  enableReadyCheck: true,        // Verify connection before use
  // enableOfflineQueue: true (default) - Queue commands while connecting, essential for startup

  // Reconnection strategy
  retryStrategy(times) {
    if (times > 10) {
      console.error('[redis] Max reconnection attempts reached');
      return null; // Stop retrying
    }
    return Math.min(times * 100, 3000); // Exponential backoff, max 3s
  },

  // Timeout settings
  connectTimeout: 10000,        // 10s connection timeout
  commandTimeout: 10000,         // 10s per command (prevents worker hang)

  // TCP keepalive - CRITICAL for preventing idle connection timeouts
  // Sends keepalive probes to detect dead connections before using them
  keepAlive: 30000,              // 30s - send keepalive probe every 30s of inactivity

  // Automatic refresh of connection
  autoResubscribe: true,         // Resubscribe to channels after reconnect
  autoResendUnfulfilledCommands: true, // Resend commands that didn't receive reply
});

// Event handlers
redis.on('connect', () => console.log('[redis] Connected'));
redis.on('error', (err) => console.error('[redis] Error:', err.message));
redis.on('close', () => console.warn('[redis] Connection closed'));

// Health check
async function healthCheck() {
  try {
    const pong = await redis.ping();
    console.log('[redis] Health:', pong);
    return pong === 'PONG';
  } catch (err) {
    console.error('[redis] Health check failed:', err.message);
    return false;
  }
}

module.exports = redis;
module.exports.healthCheck = healthCheck;