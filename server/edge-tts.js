const { EdgeTTS } = require('edge-tts-universal');

/**
 * Generates audio using edge-tts-universal library.
 * Fixed API usage: Constructor takes text/voice, and synthesize() returns a result with audio Blob.
 */
async function getEdgeTTS(text, voice, rate = '+0%', pitch = '+0Hz') {
    try {
        const tts = new EdgeTTS(text, voice, {
            rate: rate,
            pitch: pitch
        });

        const result = await tts.synthesize();

        if (!result || !result.audio) {
            throw new Error('No audio data received from synthesis');
        }

        // Convert Blob to Buffer for Node.js
        const arrayBuffer = await result.audio.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        if (buffer.length < 500) {
            throw new Error('TTS buffer is too small');
        }

        return buffer;
    } catch (error) {
        console.error('EdgeTTS Universal Error:', error.message);
        throw error;
    }
}

module.exports = { getEdgeTTS };
