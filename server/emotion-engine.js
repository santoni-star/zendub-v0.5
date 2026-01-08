/**
 * Simple Emotion Engine for ZenDub.
 * Maps text features to TTS prosody (pitch, rate).
 */
class EmotionEngine {
    constructor() {
        this.patterns = [
            { regex: /!|\b(wow|oh|amazing|incredible|на неймовірно|вау)\b/i, pitch: '+10Hz', rate: '+35%' }, // Excited
            { regex: /\?/, pitch: '+5Hz', rate: '+20%' }, // Inquisitive
            { regex: /\.\.\.|\b(sigh|sadly|unfortunately|жаль|на жаль)\b/i, pitch: '-10Hz', rate: '+10%' }, // Sad/Slow
            { regex: /\b(angry|mad|furious|зло|гнівно)\b/i, pitch: '-5Hz', rate: '+45%' }, // Angry/Fast
            { regex: /[A-Z]{2,}/, pitch: '+15Hz', rate: '+50%' } // Shouting (Caps)
        ];
    }

    analyze(text) {
        let pitch = '+0Hz';
        let rate = '+0%';

        for (const pattern of this.patterns) {
            if (pattern.regex.test(text)) {
                pitch = pattern.pitch;
                rate = pattern.rate;
                break; // Take the first matching emotion
            }
        }

        // Adjust rate based on text length to avoid overflow
        if (text.length > 200) rate = '+15%';

        return { pitch, rate };
    }
}

module.exports = new EmotionEngine();
