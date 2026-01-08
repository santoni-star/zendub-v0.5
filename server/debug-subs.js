const youtubedl = require('youtube-dl-exec');
const axios = require('axios');
const xml2js = require('xml2js');

async function test(videoId) {
    try {
        console.log(`Testing video: ${videoId}`);
        const output = await youtubedl(`https://www.youtube.com/watch?v=${videoId}`, {
            dumpSingleJson: true, noWarnings: true, skipDownload: true,
            subLang: '.*', writeAutoSub: true, writeSub: true
        });

        const subsMap = output.subtitles || {};
        const autoMap = output.automatic_captions || {};

        let track = subsMap.en || autoMap.en || subsMap.uk || autoMap.uk || Object.values(subsMap)[0] || Object.values(autoMap)[0];
        if (!track) {
            console.log('No subtitles found in maps');
            return;
        }

        console.log('Track found, searching for format...');
        const format = track.find(f => f.ext === 'srv1' || (f.url && f.url.includes('fmt=srv1'))) || track[0];
        console.log(`Using format ext: ${format.ext}`);

        const response = await axios.get(format.url);
        console.log('Subtitle data received, parsing...');

        const result = await new xml2js.Parser().parseStringPromise(response.data);
        if (result.transcript && result.transcript.text) {
            console.log(`Parsed ${result.transcript.text.length} subtitle items.`);
            console.log('First item:', JSON.stringify(result.transcript.text[0]));
        } else {
            console.log('Parsed XML structure is unusual:', JSON.stringify(result).substring(0, 500));
        }

    } catch (e) {
        console.error('Test failed:', e.message);
        if (e.response) console.error('Response status:', e.response.status);
    }
}

// jNQXAC9IVRw is "Me at the zoo" - should have something
test('jNQXAC9IVRw');
