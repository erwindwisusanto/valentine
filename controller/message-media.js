const axios = require('axios')
const { generateContent } = require('../services/geminiClient')

function buildMediaHeaders() {
    const headers = {}

    if (process.env.WAHA_API_KEY) {
        headers['X-Api-Key'] = process.env.WAHA_API_KEY
    }

    return headers
}

async function downloadMediaFromUrl(url, providedMimeType = null) {
    if (!url || typeof url !== 'string') {
        return null
    }

    const { data, headers } = await axios.get(url, {
        timeout: 15000,
        responseType: 'arraybuffer',
        headers: buildMediaHeaders()
    })

    const mimeType = providedMimeType || headers['content-type'] || 'image/jpeg'
    const mediaBase64 = Buffer.from(data).toString('base64')

    return {
        mimeType,
        mediaBase64
    }
}

function buildMediaPrompt(mimeType) {
    if (!mimeType) {
        return 'Describe this media briefly and extract important details.'
    }

    if (mimeType.startsWith('image/')) {
        return 'Describe this image in detail and extract key medical or contextual details if any.'
    }

    if (mimeType === 'application/pdf') {
        return 'Summarize this document with key points.'
    }

    return 'Summarize this file and extract important details.'
}

async function generateMediaContent({ mediaBase64, mimeType }) {
    if (!mediaBase64) {
        return null
    }

    const model = process.env.GEMINI_MEDIA_MODEL || 'gemini-2.5-flash'
    const prompt = buildMediaPrompt(mimeType)
    const contents = [
        { text: prompt },
        {
            inlineData: {
                mimeType: mimeType || 'application/octet-stream',
                data: mediaBase64
            }
        }
    ]

    const t0 = Date.now()
    const response = await generateContent({
        model,
        contents
    })
    const latencyMs = Math.round(Date.now() - t0)

    const text = response?.text || response?.candidates?.[0]?.content?.parts?.[0]?.text || null
    // Track token usage
    const usage = response?.usageMetadata || {}
    return {
        text,
        usage: {
            cachedTokens: usage.cachedContentTokenCount || 0,
            inputTokens: usage.promptTokenCount || 0,
            outputTokens: usage.candidatesTokenCount || 0,
            latencyMs
        }
    }
}

async function downloadAndGenerateMediaContent(url, providedMimeType = null) {
    const downloaded = await downloadMediaFromUrl(url, providedMimeType)
    if (!downloaded) {
        return null
    }

    const geminiResult = await generateMediaContent({
        mediaBase64: downloaded.mediaBase64,
        mimeType: downloaded.mimeType
    })

    return {
        mimeType: downloaded.mimeType,
        mediaBase64: downloaded.mediaBase64,
        geminiResult: geminiResult.text,
        usage: geminiResult.usage
    }
}

module.exports = {
    downloadMediaFromUrl,
    downloadAndGenerateMediaContent
}
