const express = require('express');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');
const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getEdgeTTS } = require('./edge-tts');
const emotionEngine = require('./emotion-engine');

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_DIR = path.join(__dirname, 'cache');

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR);
}

app.use(cors());
app.use(express.json());

// Перелік мов з минулого проекту
const VOICES = {
    'uk': { male: 'uk-UA-OstapNeural', female: 'uk-UA-PolinaNeural' },
    'pl': { male: 'pl-PL-MarekNeural', female: 'pl-PL-ZofiaNeural' },
    'cs': { male: 'cs-CZ-AntoninNeural', female: 'cs-CZ-VlastaNeural' },
    'de': { male: 'de-DE-KillianNeural', female: 'de-DE-KatjaNeural' },
    'en': { male: 'en-US-AndrewNeural', female: 'en-US-AvaNeural' }
};

function getCacheFilename(text, voice, pitch, rate) {
    const hash = crypto.createHash('md5').update(`${text}-${voice}-${pitch}-${rate}`).digest('hex');
    return path.join(CACHE_DIR, `${hash}.mp3`);
}

app.get('/', (req, res) => {
    res.status(200).send('ZenDub Server is Running! 🚀<br>Version: 1.3');
});

app.post('/tts', async (req, res) => {
    const { text, lang, voiceType, useEmotion, targetDuration } = req.body;
    console.log(`[TTS] Request: ${text.substring(0, 30)}... [${lang}]${targetDuration ? ` (target: ${targetDuration.toFixed(1)}s)` : ''}`);
    if (!text || text.trim().length === 0) return res.status(400).json({ error: 'Text required' });

    const targetLang = lang || 'uk';
    const type = voiceType || 'male';
    const voiceConfig = VOICES[targetLang] || VOICES['uk'];
    const voice = voiceConfig[type] || voiceConfig['male'];

    // Емоційний аналіз
    let { pitch, rate } = useEmotion ? emotionEngine.analyze(text) : { pitch: '+0Hz', rate: '+20%' };

    // Include targetDuration in cache key if provided
    const cacheKey = targetDuration ? `${text}-${voice}-${pitch}-${rate}-${targetDuration.toFixed(2)}` : `${text}-${voice}-${pitch}-${rate}`;
    const hash = crypto.createHash('md5').update(cacheKey).digest('hex');
    const cacheFile = path.join(CACHE_DIR, `${hash}.mp3`);

    if (fs.existsSync(cacheFile)) {
        console.log(`[TTS] Cache hit: ${path.basename(cacheFile)}`);
        const buffer = fs.readFileSync(cacheFile);
        return res.json({ audio: `data:audio/mp3;base64,${buffer.toString('base64')}` });
    }

    try {
        // Generate base TTS
        const buffer = await getEdgeTTS(text, voice, rate, pitch);
        if (!buffer || buffer.length < 500) {
            return res.status(500).json({ error: 'TTS failed' });
        }

        // If targetDuration specified, apply time-stretching
        if (targetDuration && targetDuration > 0) {
            const tempInput = path.join(CACHE_DIR, `temp-${hash}-input.mp3`);
            const tempOutput = path.join(CACHE_DIR, `temp-${hash}-output.mp3`);

            try {
                // Write temp input
                fs.writeFileSync(tempInput, buffer);

                // 1. Get duration and stretch with ffmpeg
                const { execSync } = require('child_process');
                const probeCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${tempInput}"`;
                const currentDur = parseFloat(execSync(probeCmd).toString());

                if (currentDur && !isNaN(currentDur)) {
                    let tempo = currentDur / targetDuration;
                    // Clamp to reasonable limits for voice
                    if (tempo < 0.5) tempo = 0.5;
                    if (tempo > 2.0) tempo = 2.0;

                    const ffmpegCmd = `ffmpeg -y -v error -i "${tempInput}" -filter:a "atempo=${tempo}" -vn "${tempOutput}"`;
                    execSync(ffmpegCmd, { timeout: 10000 });
                } else {
                    throw new Error('Could not determine audio duration');
                }

                // Read stretched audio
                if (fs.existsSync(tempOutput)) {
                    const stretchedBuffer = fs.readFileSync(tempOutput);
                    fs.writeFileSync(cacheFile, stretchedBuffer);
                    console.log(`[TTS] Time-stretched: ${buffer.length} -> ${stretchedBuffer.length} bytes`);

                    // Cleanup
                    fs.unlinkSync(tempInput);
                    fs.unlinkSync(tempOutput);

                    return res.json({ audio: `data:audio/mp3;base64,${stretchedBuffer.toString('base64')}` });
                } else {
                    console.warn(`[TTS] Time-stretch failed, using original`);
                    fs.writeFileSync(cacheFile, buffer);
                }
            } catch (stretchError) {
                console.error('[TTS] Time-stretch error:', stretchError.message);
                // Fallback to original
                fs.writeFileSync(cacheFile, buffer);
                // Cleanup temp files
                try { fs.unlinkSync(tempInput); } catch (e) { }
                try { fs.unlinkSync(tempOutput); } catch (e) { }
            }
        } else {
            // No time-stretching, use original
            fs.writeFileSync(cacheFile, buffer);
        }

        console.log(`[TTS] Success: ${buffer.length} bytes`);
        return res.json({ audio: `data:audio/mp3;base64,${buffer.toString('base64')}` });

    } catch (error) {
        console.error('[TTS] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/subtitles', async (req, res) => {
    const videoId = req.query.v;
    console.log(`[SUBS] Fetching for: ${videoId}`);
    if (!videoId) return res.status(400).send('No ID');

    try {
        const output = await youtubedl(`https://www.youtube.com/watch?v=${videoId}`, {
            dumpSingleJson: true, noWarnings: true, skipDownload: true,
            subLang: '.*', writeAutoSub: true, writeSub: true
        });

        const subsMap = output.subtitles || {};
        const autoMap = output.automatic_captions || {};

        let track = subsMap.en || autoMap.en || subsMap.uk || autoMap.uk || Object.values(subsMap)[0] || Object.values(autoMap)[0];
        if (!track) {
            console.log(`[SUBS] No tracks found for ${videoId}`);
            return res.status(404).send('No subtitles');
        }

        const format = track.find(f => f.ext === 'srv1' || (f.url && f.url.includes('fmt=srv1'))) || track[0];
        console.log(`[SUBS] Using format: ${format.ext}`);
        const response = await axios.get(format.url);

        let subtitles = [];
        const result = await new xml2js.Parser().parseStringPromise(response.data);
        if (result.transcript && result.transcript.text) {
            subtitles = result.transcript.text.map(i => ({
                start: parseFloat(i.$.start),
                dur: parseFloat(i.$.dur) || 2.0,
                end: parseFloat(i.$.start) + (parseFloat(i.$.dur) || 2.0),
                text: (i._ || (i.s ? i.s.join(' ') : '')).replace(/\n/g, ' ').trim()
            })).filter(s => s.text && !isNaN(s.start));
        }

        console.log(`[SUBS] Found ${subtitles.length} lines`);
        res.json({ subtitles });
    } catch (e) {
        console.error('[SUBS] Error:', e.message);
        res.status(500).send(e.message);
    }
});

app.listen(PORT, () => {
    console.log(`ZenDub Server v1.3 running on port ${PORT}`);
});
