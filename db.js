// db.js
// PostgreSQL client wrapper — exports pg Pool for all database operations

const { Pool } = require('pg');

// Use DATABASE_URL or fallback to localhost
const connectionString = process.env.DATABASE_URL || 'postgresql://localhost:5432/use_engine';

const pool = new Pool({
  connectionString,
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 2000, // Return error after 2 seconds if connection cannot be established
});

// Health check — call at startup
async function healthCheck() {
  try {
    const res = await pool.query('SELECT 1 as result');
    console.log('[db] PostgreSQL connected ', res.rows[0]);
    return true;
  } catch (err) {
    console.error('[db] Health check failed:', err.message);
    return false;
  }
}

// Query helper for easier SQL execution
async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log('[db] Executed query', { text, duration, rows: res.rowCount });
    return res;
  } catch (error) {
    console.error('[db] Query error', { text, error: error.message });
    throw error;
  }
}

// Handle pool errors
pool.on('error', (err) => {
  console.error('[db] Unexpected error on idle client', err);
  process.exit(-1);
});

// Export pool and query helper
module.exports = { pool, query, healthCheck };
