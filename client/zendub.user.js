// ==UserScript==
// @name         ZenDub v1.3
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  Security & Debug Fix: Resolved Trusted Types (TrustedHTML) blocks and improved scoping for debugging.
// @author       ZenDub Team
// @match        *://*.youtube.com/*
// @match        *://*.vimeo.com/*
// @connect      translate.googleapis.com
// @connect      googlevideo.com
// @connect      localhost
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        serverUrl: 'http://localhost:3000',
        translationChunkSize: 4500,
        ttsBlockChars: 2000,
        maxTimeGap: 5.0,
        priorityLines: 20
    };

    const LANGS = { 'uk': 'UA', 'en': 'EN', 'pl': 'PL', 'cs': 'CZ', 'de': 'DE' };

    const Logger = {
        log: (msg) => console.log(`%c[ZenDub] %c${msg}`, "color: #ff3d00; font-weight: bold;", "color: #fff;"),
        warn: (msg) => console.warn(`[ZenDub] ${msg}`),
        error: (msg, err) => console.error(`[ZenDub] ${msg}`, err || '')
    };

    const decodeHTML = (html) => {
        const entities = {
            'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"', 'apos': "'", 'nbsp': ' ',
            '#39': "'", '#x27': "'", '#x2f': '/', '#32': ' ', '#45': '-', '#58': ':',
            '#160': ' ', '#x10': '\n'
        };
        if (!html) return '';
        return html.replace(/&([^;]+);/g, (match, entity) => {
            if (entities[entity]) return entities[entity];
            if (entity.startsWith('#')) {
                const code = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
                return isNaN(code) ? match : String.fromCharCode(code);
            }
            return match;
        });
    };

    // --- MAIN CONTROLLER ---
    class ZenDubController {
        constructor() {
            this.videoId = null;
            this.subtitles = [];
            this.blocks = [];
            this.currentAudio = null;
            this.isPlaying = false;
            this.isProcessing = false;
            this.videoEl = null;
            this.interceptedData = null;

            this.settings = {
                lang: localStorage.getItem('zendub-lang') || 'uk',
                voice: localStorage.getItem('zendub-voice-type') || 'male',
                useEmotion: localStorage.getItem('zendub-emotion') === 'true',
                isDubbing: localStorage.getItem('zendub-isDubbing') === 'true',
                isSubs: localStorage.getItem('zendub-isSubs') === 'true'
            };
            this.ui = { panel: null, dubBtn: null, subBtn: null, voiceBtn: null, overlay: null };

            // Expose for debugging
            if (typeof unsafeWindow !== 'undefined') unsafeWindow.ZDub = this;
            window.ZDub = this;

            this.init();
        }

        init() {
            Logger.log('Initializing v1.5 (Security & Debug Fixes)');
            this.setupInterceptor();

            if (document.readyState === 'loading') {
                window.addEventListener('DOMContentLoaded', () => this.onReady());
            } else {
                this.onReady();
            }
        }

        onReady() {
            this.setupVideoListeners();
            window.addEventListener('yt-navigate-finish', () => this.handleNavigation());
            window.addEventListener('yt-page-data-updated', () => this.handleNavigation());
            setInterval(() => { this.checkUrl(); this.tryInjectUI(); }, 2000);
            this.loop();
        }

        setupInterceptor() {
            const self = this;
            let _initialPlayerResponse = undefined;

            // Intercept ytInitialPlayerResponse
            Object.defineProperty(unsafeWindow, 'ytInitialPlayerResponse', {
                get() { return _initialPlayerResponse; },
                set(val) {
                    _initialPlayerResponse = val;
                    if (val && val.captions) {
                        Logger.log('Intercepted ytInitialPlayerResponse with captions');
                        self.interceptedData = val;
                        self.checkUrl();
                    }
                },
                configurable: true
            });
        }

        handleNavigation() {
            Logger.log('YouTube Navigation Detected');
            this.checkUrl();
        }

        checkUrl() {
            const vid = new URLSearchParams(window.location.search).get('v');
            if (vid && vid !== this.videoId) {
                Logger.log(`Video ID detected: ${vid}`);
                this.videoId = vid;
                this.resetState();

                // Re-expose because YouTube navigation might clear window properties
                if (typeof unsafeWindow !== 'undefined') unsafeWindow.ZDub = this;
                window.ZDub = this;

                // Only start if settings are active AND not already processing
                setTimeout(() => {
                    if ((this.settings.isDubbing || this.settings.isSubs) && !this.isProcessing && this.subtitles.length === 0) {
                        this.startStrategy();
                    }
                }, 2000);
            }
        }

        resetState() {
            this.subtitles = []; this.blocks = [];
            if (this.currentAudio) {
                this.currentAudio.pause();
                this.currentAudio.src = "";
                this.currentAudio = null;
            }
            this.isPlaying = false;
            if (this.ui.overlay) this.ui.overlay.style.display = 'none';
            if (this.overlayTimer) clearTimeout(this.overlayTimer);
            if (this.debugTimer) clearTimeout(this.debugTimer);
            this.updateBtnState();
            this.updateDebug('Ready');
        }

        setupVideoListeners() {
            if (this.videoCheckInterval) clearInterval(this.videoCheckInterval);
            this.videoCheckInterval = setInterval(() => {
                const v = document.querySelector('video');
                if (v && v !== this.videoEl) {
                    if (this.videoEl && this.seekingHandler) {
                        this.videoEl.removeEventListener('seeking', this.seekingHandler);
                    }
                    if (this.videoEl && this.pauseHandler) {
                        this.videoEl.removeEventListener('pause', this.pauseHandler);
                    }
                    if (this.videoEl && this.playHandler) {
                        this.videoEl.removeEventListener('play', this.playHandler);
                    }

                    this.videoEl = v;

                    this.seekingHandler = () => {
                        if (this.currentAudio) {
                            this.currentAudio.pause();
                            this.currentAudio = null;
                        }
                        this.isPlaying = false;
                        this.subtitles.forEach(s => s.played = false);
                        this.blocks.forEach(b => b.played = false);
                    };

                    this.pauseHandler = () => {
                        if (this.currentAudio) {
                            this.currentAudio.pause();
                            // Do NOT set to null, so we can resume
                        }
                        this.isPlaying = false; // Script logic pauses, but audio object remains
                        Logger.log('Video paused - audio suspended');
                    };

                    this.playHandler = () => {
                        // 1. Try to resume existing audio if valid
                        if (this.currentAudio && !this.currentAudio.ended && this.currentAudio.paused) {
                            this.currentAudio.play().then(() => {
                                this.isPlaying = true;
                                Logger.log('Audio resumed');
                            }).catch(e => {
                                Logger.warn('Resume failed, resetting', e);
                                this.currentAudio = null;
                                this.resetPlaybackPosition(v.currentTime);
                            });
                        } else {
                            // 2. Or reset position based on current time
                            this.resetPlaybackPosition(v.currentTime);
                        }
                    };

                    this.resetPlaybackPosition = (t) => {
                        if (this.blocks.length > 0) {
                            this.blocks.forEach(b => {
                                if (b.start + b.dur < t) b.played = true; // Already passed
                                else b.played = false; // Can play again
                            });
                        }
                        Logger.log('Playback position reset');
                    };

                    v.addEventListener('seeking', this.seekingHandler);
                    v.addEventListener('pause', this.pauseHandler);
                    v.addEventListener('play', this.playHandler);
                }
            }, 1000);
        }

        // --- UI METHODS ---
        tryInjectUI() {
            if (document.getElementById('zendub-panel')) return;
            const c = document.querySelector('.ytp-right-controls') || document.querySelector('.ytp-left-controls');
            if (!c) return;

            const panel = document.createElement('div');
            panel.id = 'zendub-panel';
            panel.style.cssText = 'display: flex; align-items: center; margin-right: 12px; margin-left: 12px; font-family: "YouTube Sans", Roboto, Arial, sans-serif; height: 100%; position: relative;';

            const createToggle = (text, key, color, tooltip) => {
                const btn = document.createElement('button');
                btn.textContent = text; btn.title = tooltip;

                const getIsActive = () => {
                    if (key === 'voice') return this.settings.voice === 'male';
                    return this.settings[key];
                };

                const updateStyle = () => {
                    const active = getIsActive();
                    if (key === 'voice') {
                        btn.textContent = active ? '♂️' : '♀️';
                    }
                    btn.style.cssText = `background: ${active ? color : 'rgba(255,255,255,0.15)'}; border: none; color: white; padding: 4px 10px; cursor: pointer; font-weight: bold; margin-right: 6px; border-radius: 6px; font-size: 14px; transition: all 0.2s; box-shadow: 0 4px 6px rgba(0,0,0,0.3); backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,0.1); display: flex; align-items: center; justify-content: center; min-width: 32px;`;
                };

                updateStyle();

                btn.onclick = (e) => {
                    e.stopPropagation();
                    if (key === 'voice') {
                        this.settings.voice = (this.settings.voice === 'male' || !this.settings.voice) ? 'female' : 'male';
                        localStorage.setItem('zendub-voice-type', this.settings.voice);
                        Logger.log(`Voice switched to: ${this.settings.voice}`);
                        updateStyle();
                        // Clear ALL audio cache and re-fetch with new voice
                        if (this.blocks && this.blocks.length > 0) {
                            this.blocks.forEach(b => {
                                b.audioSrc = null;
                                b.ready = false;
                                b.played = false;
                                b.preparing = false;
                            });
                            // Immediately fetch first few blocks with new voice
                            const currentTime = this.videoEl ? this.videoEl.currentTime : 0;
                            const currentBlockIdx = this.blocks.findIndex(b => b.start >= currentTime);
                            const startIdx = Math.max(0, currentBlockIdx - 1);
                            Logger.log(`Re-fetching TTS with ${this.settings.voice} voice from block ${startIdx}`);
                            this.preloadBlocks(startIdx, 5);
                        }
                    } else {
                        this.settings[key] = !this.settings[key];
                        localStorage.setItem(`zendub-${key}`, this.settings[key]);
                        Logger.log(`${key} set to: ${this.settings[key]}`);
                        updateStyle();
                        this.updateBtnState();
                        // Start strategy ONLY if:
                        // 1. Turning ON (not off)
                        // 2. Not already processing
                        // 3. Don't have subtitles yet
                        if (this.settings[key] && (key === 'isDubbing' || key === 'isSubs') && !this.isProcessing && this.subtitles.length === 0) {
                            this.startStrategy();
                        }
                    }
                };
                return btn;
            };

            this.ui.dubBtn = createToggle('DUB', 'isDubbing', '#ff3d00', 'Start Emotional Dubbing');
            panel.appendChild(this.ui.dubBtn);

            this.ui.subBtn = createToggle('SUB', 'isSubs', '#2979ff', 'Show Subtitles');
            panel.appendChild(this.ui.subBtn);

            this.ui.voiceBtn = createToggle('VOICE', 'voice', '#00e676', 'Toggle Voice Gender (♂/♀)');
            panel.appendChild(this.ui.voiceBtn);

            const select = document.createElement('select');
            select.style.cssText = `background: rgba(20,20,20,0.95); color: #fff; border: 1px solid rgba(255,255,255,0.3); font-size: 10px; cursor: pointer; border-radius: 6px; padding: 4px; font-weight: bold;`;
            for (let code in LANGS) {
                const opt = document.createElement('option'); opt.value = code; opt.textContent = LANGS[code];
                if (code === this.settings.lang) opt.selected = true; select.appendChild(opt);
            }
            select.onchange = (e) => {
                this.settings.lang = e.target.value;
                localStorage.setItem('zendub-lang', this.settings.lang);
                // Only reset and restart if we have subtitles already
                if (this.subtitles.length > 0) {
                    this.resetState();
                    if (this.settings.isDubbing || this.settings.isSubs) {
                        this.startStrategy();
                    }
                }
            };
            panel.appendChild(select);

            c.prepend(panel);
        }

        updateBtnState() {
            // UI styles are handled within createToggle's updateStyle
        }

        updateDebug(msg, persistent = false) {
            const target = (this.settings.isDubbing || !this.settings.isSubs) ? this.ui.dubBtn : this.ui.subBtn;
            if (!target) return;

            const originalTexts = { dubBtn: 'DUB', subBtn: 'SUB' };
            target.textContent = msg.toUpperCase();

            if (!persistent) {
                if (this.debugTimer) clearTimeout(this.debugTimer);
                this.debugTimer = setTimeout(() => {
                    if (this.ui.dubBtn) this.ui.dubBtn.textContent = originalTexts.dubBtn;
                    if (this.ui.subBtn) this.ui.subBtn.textContent = originalTexts.subBtn;
                    // Voice button maintains its icon - never touched
                }, 4000);
            }
        }

        // --- THE "NEVER FAIL" EXTRACTION (V1.4 HYBRID FOCUS) ---
        async startStrategy() {
            if (this.isProcessing) return;
            this.isProcessing = true;
            this.updateDebug('Extracting...', true);

            try {
                let result = await this.extractionChain();
                if (!result || !result.subs || result.subs.length === 0) throw new Error('NO_SUBTITLES');

                this.subtitles = result.subs.map(s => ({ ...s, played: false, translatedText: null, ready: false }));
                this.updateDebug(`${result.type}: ${this.subtitles.length} lines`, true);

                // PROGRESSIVE PLAYBACK: Start priority sync (first ~20 lines)
                await this.prioritySync();

                // Start background translation WITHOUT waiting (parallel)
                this.backgroundFlow(); // No await - runs in background!

                // Mark as ready immediately so audio can start
                this.updateDebug('Playing...', true);

            } catch (err) {
                Logger.error('Execution Failed', err);
                this.updateDebug(`FAIL: ${err.message}`, true);
            } finally {
                this.isProcessing = false;
            }
        }

        async extractionChain() {
            this.updateDebug('Chain: Searching...', true);

            // Method 1: Intercepted Data
            if (this.interceptedData && this.interceptedData.captions) {
                const res = await this.pickBestTrack(this.interceptedData.captions.playerCaptionsTracklistRenderer.captionTracks);
                if (res) return res;
            }

            // Method 2: Player API (movie_player)
            try {
                const player = document.getElementById('movie_player');
                if (player && player.getOptions) {
                    const tracks = player.getOptions('captions', 'tracklist');
                    if (tracks && tracks.length > 0) {
                        const res = await this.pickBestTrack(tracks);
                        if (res) return res;
                    }
                }
            } catch (e) { }

            // Method 3: unsafeWindow Direct
            let res = await this.tryUnsafeWindow();
            if (res) return res;

            // Method 4: HTML Script Scanning
            res = await this.tryHtmlScanning();
            if (res) return res;

            // Method 5: Server Fallback
            res = await this.tryServer();
            if (res) return { subs: res, type: 'SERVER' };

            return null;
        }

        async tryUnsafeWindow() {
            try {
                const w = unsafeWindow || window;
                const resp = w.ytInitialPlayerResponse || (w.ytplayer ? w.ytplayer.config?.args?.raw_player_response : null);
                if (resp && resp.captions) {
                    return await this.pickBestTrack(resp.captions.playerCaptionsTracklistRenderer.captionTracks);
                }
            } catch (e) { } return null;
        }

        async tryHtmlScanning() {
            try {
                const scripts = Array.from(document.scripts);
                for (const script of scripts) {
                    if (script.textContent.includes('ytInitialPlayerResponse')) {
                        const match = script.textContent.match(/var ytInitialPlayerResponse\s*=\s*({.+?});/);
                        if (match) {
                            const data = JSON.parse(match[1]);
                            if (data.captions) return await this.pickBestTrack(data.captions.playerCaptionsTracklistRenderer.captionTracks);
                        }
                    }
                }
            } catch (e) { } return null;
        }

        async pickBestTrack(tracks) {
            if (!tracks) return null;

            // Priorities: Manual English/Original -> ASR English/Original -> Any Manual -> Any ASR -> First available
            const findTrack = (list, lang, manualOnly) => list.find(t =>
                (t.languageCode === lang) &&
                (manualOnly ? (t.kind !== 'asr' && !t.vssId?.includes('.asr')) : true)
            );

            let track = findTrack(tracks, 'en', true) || findTrack(tracks, 'uk', true) ||
                tracks.find(t => t.kind !== 'asr' && !t.vssId?.includes('.asr')) ||
                findTrack(tracks, 'en', false) || findTrack(tracks, 'uk', false) ||
                tracks[0];

            if (track && track.baseUrl) {
                this.updateDebug(`Fetching: ${track.languageCode}`, true);
                const subs = await this.fetchHybrid(track.baseUrl);
                if (subs && subs.length > 0) return { subs, type: track.kind === 'asr' ? 'AUTO' : 'MANUAL' };
            }
            return null;
        }

        async fetchHybrid(baseUrl) {
            // Priority 1: JSON3
            let subs = await this.fetchJSON3(baseUrl + '&fmt=json3');
            if (subs && subs.length > 0) {
                Logger.log('Fetch SUCCESS: JSON3 format');
                return subs;
            }

            // Priority 2: XML (srv1) Fallback
            Logger.warn('JSON3 failed or empty. Falling back to XML...');
            subs = await this.fetchXML(baseUrl + '&fmt=srv1');
            if (subs && subs.length > 0) {
                Logger.log('Fetch SUCCESS: XML (srv1) fallback');
                return subs;
            }
            return null;
        }

        fetchJSON3(url) {
            return new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method: 'GET', url,
                    onload: (res) => {
                        try {
                            if (!res.responseText || res.responseText.length < 10) return resolve(null);
                            const data = JSON.parse(res.responseText);
                            const subs = data.events
                                .filter(ev => ev.segs)
                                .map(ev => ({
                                    start: ev.tStartMs / 1000,
                                    dur: (ev.dDurationMs || 1200) / 1000,
                                    end: (ev.tStartMs + (ev.dDurationMs || 1200)) / 1000,
                                    text: ev.segs.map(s => s.utf8).join('').replace(/\n/g, ' ').trim()
                                }))
                                .filter(s => s.text.length > 0);
                            resolve(subs);
                        } catch (e) { resolve(null); }
                    },
                    onerror: () => resolve(null)
                });
            });
        }

        fetchXML(url) {
            return new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method: 'GET', url,
                    onload: (res) => {
                        try {
                            const parser = new DOMParser();
                            const xml = parser.parseFromString(res.responseText, "text/xml");
                            const nodes = xml.querySelectorAll('text');
                            const subs = Array.from(nodes).map(node => ({
                                start: parseFloat(node.getAttribute('start')),
                                dur: parseFloat(node.getAttribute('dur')) || 1.2,
                                end: parseFloat(node.getAttribute('start')) + (parseFloat(node.getAttribute('dur')) || 1.2),
                                text: decodeHTML(node.textContent).replace(/\n/g, ' ').trim()
                            })).filter(s => s.text.length > 0);
                            resolve(subs);
                        } catch (e) { resolve(null); }
                    },
                    onerror: () => resolve(null)
                });
            });
        }

        tryServer() {
            return new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method: 'GET', url: `${CONFIG.serverUrl}/subtitles?v=${this.videoId}`,
                    onload: (res) => {
                        if (res.status === 200) resolve(JSON.parse(res.responseText).subtitles);
                        else resolve(null);
                    },
                    onerror: () => resolve(null)
                });
            });
        }

        async prioritySync() {
            const time = this.videoEl ? this.videoEl.currentTime : 0;
            const idx = Math.max(0, this.subtitles.findIndex(s => s.start >= time));
            const end = Math.min(idx + CONFIG.priorityLines, this.subtitles.length);

            if (idx < this.subtitles.length) {
                this.updateDebug('Translating...', true);
                await this.translateRange(idx, end);
                this.updateDebug('Building blocks...', true);
                this.rebuildBlocks();
                // Immediately fetch audio for first blocks
                this.updateDebug('Fetching audio...', true);
                this.preloadBlocks(0, 5);
                Logger.log(`Priority sync complete: ${end - idx} lines ready, audio loading...`);
            }
        }

        async backgroundFlow() {
            const BATCH = 40;
            Logger.log('Background translation started - audio can play while this continues');

            for (let i = 0; i < this.subtitles.length; i += BATCH) {
                // Check if user navigated away
                if (this.videoId !== new URLSearchParams(window.location.search).get('v')) {
                    Logger.log('Video changed, stopping background flow');
                    return;
                }

                const s = i; const e = Math.min(i + BATCH, this.subtitles.length);

                // Skip already translated batches (from prioritySync)
                if (this.subtitles.slice(s, e).some(sub => !sub.ready)) {
                    await this.translateRange(s, e);
                    const progress = Math.round((e / this.subtitles.length) * 100);
                    this.updateDebug(`${progress}%`, true);

                    // Rebuild and preload every few batches
                    if (i % (BATCH * 3) === 0 || e === this.subtitles.length) {
                        this.rebuildBlocks();
                        // Preload blocks near current playback position
                        if (this.blocks.length > 0) {
                            const currentTime = this.videoEl ? this.videoEl.currentTime : 0;
                            const currentBlockIdx = this.blocks.findIndex(b => b.start >= currentTime);
                            const startIdx = Math.max(0, currentBlockIdx - 1);
                            this.preloadBlocks(startIdx, 5);
                        }
                    }
                }
            }
            this.rebuildBlocks(); // Final rebuild
            this.updateDebug('100% Ready');
            Logger.log('Background translation complete - all audio available');
        }

        async translateRange(s, e) {
            let text = ''; let indices = [];
            for (let i = s; i < e; i++) {
                if (!this.subtitles[i].ready) {
                    text += (text ? ' ~~~~ ' : '') + this.subtitles[i].text;
                    indices.push(i);
                }
            }
            if (!text) return;

            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${this.settings.lang}&dt=t&q=${encodeURIComponent(text)}`;
            return new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method: 'GET', url,
                    onload: (res) => {
                        try {
                            const data = JSON.parse(res.responseText);
                            let combined = '';
                            if (data[0]) data[0].forEach(s => combined += s[0]);
                            const results = combined.split(/\s*~~~~\s*/);
                            Logger.log(`Translation result: ${results.length} segments for ${indices.length} indices`);
                            indices.forEach((idx, i) => {
                                this.subtitles[idx].translatedText = results[i] ? decodeHTML(results[i].trim()) : this.subtitles[idx].text;
                                this.subtitles[idx].ready = true;
                            });
                        } catch (e) {
                            Logger.error('Translation Parse Error', e);
                        }
                        resolve();
                    },
                    onerror: (err) => {
                        Logger.error('Translation Request Error', err);
                        resolve();
                    }
                });
            });
        }

        rebuildBlocks() {
            const old = this.blocks;
            this.blocks = [];
            let cur = null;
            for (let i = 0; i < this.subtitles.length; i++) {
                const sub = this.subtitles[i];
                if (!sub.ready) continue;
                const split = !cur || (cur.text.length + sub.translatedText.length > CONFIG.ttsBlockChars) || (sub.start - cur.lastEnd > CONFIG.maxTimeGap);
                if (split) {
                    if (cur) {
                        cur.dur = cur.lastEnd - cur.start;
                        // Sanity check for duration
                        if (cur.dur > 30) {
                            Logger.warn(`Block duration handling: ${cur.dur.toFixed(2)}s is too long! (Start: ${cur.start.toFixed(2)}, End: ${cur.lastEnd.toFixed(2)}) Text: ${cur.text.substring(0, 20)}...`);
                            // Clamp expected duration?
                            // cur.dur = Math.min(cur.dur, 10); // Maybe clamp? No, let's see log first.
                        }
                        const match = old.find(o => o.text === cur.text && Math.abs(o.start - cur.start) < 0.1);
                        if (match) { cur.audioSrc = match.audioSrc; cur.ready = match.ready; cur.played = match.played; }
                        this.blocks.push(cur);
                        // Assign block index AFTER pushing
                        const blockIdx = this.blocks.length - 1;
                        cur.subIndices.forEach(idx => this.subtitles[idx].blockIdx = blockIdx);
                    }
                    cur = { text: '', start: sub.start, lastEnd: sub.end, subIndices: [], ready: false, played: false };
                }
                cur.text += (cur.text ? ' ' : '') + sub.translatedText;
                cur.lastEnd = sub.end;
                cur.subIndices.push(i);
            }
            if (cur) {
                cur.dur = cur.lastEnd - cur.start;
                if (cur.dur > 30) Logger.warn(`Final Block duration: ${cur.dur.toFixed(2)}s (Start: ${cur.start.toFixed(2)})`);
                const match = old.find(o => o.text === cur.text && Math.abs(o.start - cur.start) < 0.1);
                if (match) { cur.audioSrc = match.audioSrc; cur.ready = match.ready; cur.played = match.played; }
                this.blocks.push(cur);
                // Assign block index AFTER pushing
                const blockIdx = this.blocks.length - 1;
                cur.subIndices.forEach(idx => this.subtitles[idx].blockIdx = blockIdx);
            }
        }

        preloadBlocks(idx, count) {
            if (this.blocks.length === 0) return;
            for (let i = idx; i < Math.min(idx + count, this.blocks.length); i++) this.fetchTTS(this.blocks[i]);
        }

        fetchTTS(block) {
            if (block.audioSrc || block.preparing) return;
            block.preparing = true;
            const voice = this.settings.voice || 'male';
            Logger.log(`Fetching [${voice}] TTS for: ${block.text.substring(0, 30)}... (dur: ${block.dur.toFixed(1)}s)`);
            GM_xmlhttpRequest({
                method: 'POST', url: `${CONFIG.serverUrl}/tts`, headers: { "Content-Type": "application/json" },
                data: JSON.stringify({
                    text: block.text,
                    lang: this.settings.lang,
                    voiceType: voice,
                    useEmotion: this.settings.useEmotion,
                    targetDuration: block.dur
                }),
                onload: (res) => {
                    if (res.status === 200) {
                        try {
                            const data = JSON.parse(res.responseText);
                            if (data.audio) {
                                block.audioSrc = data.audio;
                                block.ready = true;
                                Logger.log(`TTS Ready: ${block.text.substring(0, 30)}...`);
                            }
                        } catch (e) { Logger.error("TTS JSON Error", e); }
                    } else { Logger.warn(`TTS Server Error: ${res.status}`); }
                    block.preparing = false;
                },
                onerror: () => { Logger.error("TTS Network Error"); block.preparing = false; }
            });
        }

        loop() {
            requestAnimationFrame(() => this.loop());
            if (!this.videoEl || this.videoEl.paused || this.subtitles.length === 0) return;

            const t = this.videoEl.currentTime;
            const sub = this.subtitles.find(s => s.start <= t && s.end >= t);

            if (sub && sub.ready) {
                if (this.settings.isSubs) this.showOverlay(sub.translatedText || sub.text, sub.dur);
                if (this.settings.isDubbing && !this.isPlaying && this.blocks.length > 0) {
                    const blockIdx = sub.blockIdx;
                    if (blockIdx !== undefined && blockIdx < this.blocks.length) {
                        const block = this.blocks[blockIdx];
                        // Play if: block exists, has audio, not played yet, and we're within its time range
                        if (block && block.audioSrc && block.ready && !block.played && t >= block.start && t <= (block.start + block.dur)) {
                            Logger.log(`[TRIGGER] Playing block ${blockIdx} at T=${t.toFixed(2)}s (block: ${block.start.toFixed(2)}s-${(block.start + block.dur).toFixed(2)}s)`);
                            block.played = true;
                            this.playBlock(block);
                            this.preloadBlocks(blockIdx + 1, 3);
                        }
                    }
                }
            }
        }

        playBlock(block) {
            if (!block.audioSrc || this.isPlaying) return;

            // Don't play if video is paused
            if (this.videoEl && this.videoEl.paused) {
                Logger.log('Skipping audio - video is paused');
                return;
            }

            this.isPlaying = true;
            const vol = this.videoEl ? this.videoEl.volume : 1.0;
            const vRate = this.videoEl ? this.videoEl.playbackRate : 1.0;

            if (this.videoEl) this.videoEl.volume = vol * 0.25;

            Logger.log(`Playing block: ${block.text.substring(0, 50)}... (T=${this.videoEl ? this.videoEl.currentTime.toFixed(2) : 0})`);

            try {
                this.currentAudio = new Audio();

                const onReady = () => {
                    if (this.currentAudio.dataset.handled) return;
                    this.currentAudio.dataset.handled = "true";

                    clearTimeout(timeout);
                    if (!this.videoEl) return this.endBlock(vol, vRate);

                    let speed = (this.currentAudio.duration / block.dur) * vRate;
                    if (isNaN(speed) || !isFinite(speed) || speed <= 0) speed = 1.0;
                    speed = Math.min(Math.max(speed, 0.5), 2.5);

                    if (speed > 1.35) this.videoEl.playbackRate = vRate * 0.85;
                    this.currentAudio.playbackRate = speed;
                    this.currentAudio.play().catch(e => {
                        Logger.error("Play failed", e);
                        this.endBlock(vol, vRate);
                    });
                };

                const timeout = setTimeout(() => {
                    if (this.isPlaying && this.currentAudio && !this.currentAudio.dataset.handled) {
                        Logger.warn("Audio load timeout - skipping");
                        this.endBlock(vol, vRate);
                    }
                }, 6000);

                this.currentAudio.onloadedmetadata = onReady;
                this.currentAudio.oncanplay = onReady;
                this.currentAudio.onended = () => this.endBlock(vol, vRate);
                this.currentAudio.onerror = (e) => {
                    Logger.error("Audio playback error", e);
                    clearTimeout(timeout);
                    this.endBlock(vol, vRate);
                };

                this.currentAudio.src = block.audioSrc;
                this.currentAudio.load();

                // Firefox/Chrome immediate play fallback if buffer is already there
                if (this.currentAudio.readyState >= 2) onReady();

            } catch (e) {
                Logger.error("Audio creation failed", e);
                this.endBlock(vol, vRate);
            }
        }

        endBlock(v, r) {
            this.isPlaying = false; this.currentAudio = null;
            if (this.videoEl) { this.videoEl.volume = v; this.videoEl.playbackRate = r; }
        }

        showOverlay(text, dur) {
            const p = document.querySelector('.html5-video-player') || document.body;
            if (!this.ui.overlay) {
                this.ui.overlay = document.createElement('div');
                this.ui.overlay.id = 'zendub-overlay';
                this.ui.overlay.style.cssText = `position: absolute; bottom: 85px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.85); backdrop-filter: blur(12px); color: #fff; padding: 12px 24px; font-size: 24px; border-radius: 12px; pointer-events: none; z-index: 2000; text-align: center; font-family: "YouTube Sans", Roboto, sans-serif; max-width: 85%; border: 1px solid rgba(255,255,255,0.25); box-shadow: 0 15px 40px rgba(0,0,0,0.6); font-weight: 500;`;
                p.appendChild(this.ui.overlay);
            }
            this.ui.overlay.style.display = 'block';
            this.ui.overlay.textContent = text;
            if (this.overlayTimer) clearTimeout(this.overlayTimer);
            this.overlayTimer = setTimeout(() => { if (this.ui.overlay) this.ui.overlay.style.display = 'none'; }, dur * 1000);
        }

        generateDebugReport() {
            Logger.log('--- ZEN DUB DEBUG REPORT ---');
            Logger.log('Video ID: ' + this.videoId);
            Logger.log('Intercepted Data: ' + (!!this.interceptedData));
            const w = unsafeWindow || window;
            Logger.log('unsafeWindow.ytInitialPlayerResponse: ' + (!!w.ytInitialPlayerResponse));
            if (w.ytInitialPlayerResponse) console.dir(w.ytInitialPlayerResponse.captions);
            alert('Debug info logged to console (F12).');
        }
    }

    const start = () => { if (window.ZDub) return; window.ZDub = new ZenDubController(); };
    start();
})();
