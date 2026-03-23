const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const { addChatJob } = require('../queues/agentQueue')
const { insertChatLog } = require('../services/patientDb')
const { downloadAndGenerateMediaContent } = require('../controller/message-media')

/**
 * WHA Webhook Handler
 * Receives messages from WHA (WhatsApp HTTP API) and sends directly to chatWorker
 *
 * Expected WHA payload structure:
 * {
 *   "session": "default",
 *   "event": "messages.upsert",
 *   "payload": {
 *     "from": "628123456789@s.whatsapp.net",
 *     "message": { "conversation": "Hello", ... },
 *     "_data": { ... }
 *   }
 * }
 */
router.post('/inbound-message', async (req, res) => {
  try {
    console.log('=== WAHA WEBHOOK RECEIVED ===')
    console.log('Body:', JSON.stringify(req.body, null, 2))

    // Extract data from WHA payload
    const session = req.body.session || 'default'
    const payload = req.body.payload || req.body
    const webhookPayload = req.body

    // Check if this is a bot message (fromMe=true)
    if (webhookPayload.payload.fromMe === true) {
      console.log('[WEBHOOK] Message from bot (fromMe=true) - logging but not responding')

      // Extract message text for logging
      let message = ''
      if (payload.message?.conversation) {
        message = payload.message.conversation
      } else if (payload.message?.extendedTextMessage?.text) {
        message = payload.message.extendedTextMessage.text
      } else if (payload._data?.message?.conversation) {
        message = payload._data.message.conversation
      } else if (payload._data?.message?.extendedTextMessage?.text) {
        message = payload._data.message.extendedTextMessage.text
      }

      // Log bot message to chat_logs for audit trail
      const tenantId = process.env.TENANT_ID
      const fromPhone = webhookPayload.payload._data?.key?.remoteJid?.replace(/@.*$/, '') || 'unknown'
      const msisdnHash = crypto.createHash('sha256').update(fromPhone).digest('hex')

      await insertChatLog({
        tenantId,
        msIsdn_id: fromPhone,
        msisdnHash,
        model: 'bot_message',
        cachedTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        model_latency_ms: 0,
        depthClassification: 'N/A',
        retrievedIds: [],
        citedIds: [],
        citationMatch: false,
        jobId: `bot_${webhookPayload.payload.id || Date.now()}`
      }).catch(err => console.error('[WEBHOOK] Failed to log bot message:', err.message))

      return res.status(200).send('OK')
    }

    // Check for non-message events
    if (webhookPayload.event == 'session.status') {
      console.log(`[WEBHOOK] Ignoring non-message event: ${webhookPayload.event}`)
      return res.status(200).send('OK')
    }

    // Extract phone number (remove @s.whatsapp.net, @lid, etc.)
    const from = payload.from || payload._data?.key?.remoteJid || 'unknown'
    const phone = from.replace(/@.*$/, '') // Clean: remove everything after @
    const fromPhone = webhookPayload.payload._data?.key?.remoteJidAlt.replace(/@.*$/, '')

    // Extract message text from various WHA payload formats
    let message = ''
    if (typeof payload.body === 'string' && payload.body.trim() !== '') {
      message = payload.body
    } else if (payload.message?.conversation) {
      message = payload.message.conversation
    } else if (payload.message?.extendedTextMessage?.text) {
      message = payload.message.extendedTextMessage.text
    } else if (payload._data?.message?.conversation) {
      message = payload._data.message.conversation
    } else if (payload._data?.message?.extendedTextMessage?.text) {
      message = payload._data.message.extendedTextMessage.text
    }

    // Extract media only from payload.media
    let mediaUrl = null
    let mediaBase64 = null
    let mediaMimeType = null
    let mediaGeminiResult = null

    if (payload.media?.url) {
      mediaUrl = payload.media.url
      mediaMimeType = payload.media.mimeType || payload.media.mimetype || null
    }

    if (mediaUrl) {
      try {
        console.info(`[${new Date().toLocaleString()}] HAS MEDIA URL`);
        const downloadedMedia = await downloadAndGenerateMediaContent(mediaUrl, mediaMimeType)
        mediaBase64 = downloadedMedia?.mediaBase64 || null
        mediaMimeType = downloadedMedia?.mimeType || mediaMimeType
        mediaGeminiResult = downloadedMedia?.geminiResult || null
      } catch (err) {
        console.warn('[WEBHOOK] Failed to download media URL:', err.message)
      }
    }

    if (!message && mediaGeminiResult) {
      message = mediaGeminiResult
    }

    // Validate required fields
    if (!message && !mediaUrl) {
      console.log('[WEBHOOK] No text or media found in message, ignoring')
      return res.status(200).send('OK')
    }

    // Get tenant ID from env (or could be derived from session/phone)
    const tenantId = process.env.TENANT_ID
    if (!tenantId) {
      console.error('[WEBHOOK] TENANT_ID not configured')
      return res.status(500).send('Server configuration error')
    }

    // Add job directly to chatWorker queue
    const job = await addChatJob({
      // Tenant & session
      tenantId,
      session: webhookPayload.session,
      // Who we are
      me: webhookPayload.me.id,
      // Message identity
      messageId: webhookPayload.payload.id,
      timestamp: webhookPayload.payload.timestamp,
      // Sender info
      msisdn_id: phone,
      from: fromPhone,
      fromMe: webhookPayload.payload.fromMe,
      pushName: webhookPayload.payload._data.pushName,
      // Message content
      message,
      mediaUrl,
      mediaBase64,
      mediaMimeType,
      mediaGeminiResult,
      hasMedia: webhookPayload.payload.hasMedia,
      // Key (for reply/ack targeting)
      key: webhookPayload.payload._data.key,
      // Source
      source: webhookPayload.payload.source,
    })


    console.log(`[WEBHOOK] Added chat job ${job.id} for ${phone}`)
    console.log('==============================')
    res.status(200).send('OK')

  } catch (error) {
    console.error('[WEBHOOK] Failed to process message:', error)
    res.status(500).json({ error: error.message })
  }
})

module.exports = router
