const express = require('express')
const app = express()
const redis = require('./config/redis2')
const { agentQueue } = require('./queues/agentQueue')
const inboundMessageRoutes = require('./routes/inboundMessage')

// Parse JSON bodies
app.use(express.json())

// Log ALL incoming requests
app.use((req, res, next) => {
  // Format time in WIB (Asia/Jakarta timezone)
  const timeStr = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  console.log(`[${timeStr}] ${req.method} ${req.url}`)
  // console.log('Headers:', JSON.stringify(req.headers, null, 2))
  next()
})

app.get('/', (req, res) => {
  res.send('Hello World!')
})

// Check Redis and Queue status
app.get('/status', async (req, res) => {
  try {
    // Get Redis keys for session data
    const keys = await redis.keys('*:session:*')

    // Get queue stats
    const queueStats = {
      waiting: await agentQueue.getWaitingCount(),
      active: await agentQueue.getActiveCount(),
      completed: await agentQueue.getCompletedCount(),
      failed: await agentQueue.getFailedCount(),
    }

    res.json({
      redis: {
        activeSessions: keys.length,
      },
      queue: queueStats,
    })
  } catch (error) {
    console.error('[ERROR] Status check failed:', error)
    res.status(500).json({ error: error.message })
  }
})

// Status routes
const statusRoutes = require('./routes/status')
app.use('/status', statusRoutes)

// Inbound message routes
app.use('/', inboundMessageRoutes)

// 404 handler
app.use((req, res) => {
  console.log('404 - Route not found:', req.method, req.url)
  res.status(404).send('Not Found')
})

module.exports = app
