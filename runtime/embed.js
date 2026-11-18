/*! dotchar embed player: one self-contained script, no imports, no network. Used by the Studio's "single-file" export
 *  (Claude artifacts, LMS pages, anything that cannot load outside files).
 *
 *  const who = await DotChar.mount(canvas, CHAR_DATA, { pose: 'explain', expression: 'happy', fit: 'bust' });
 *  who.setPose('wave'); who.setExpression('surprised'); who.setFit('face' | 'bust' | 'body');
 *
 *  LIP-SYNC, three ways (all return a Promise that resolves when the line ends, so lines can be chained with await):
 *   1. await who.playAudio(url)          BEST for any recorded or generated voice. The mouth follows the sound itself
 *                                        (live audio analysis), so it is always in sync. url = file, blob: or data: URL.
 *   2. await who.play(track, url)        Studio quality: track = the *.lipsync.json made by `char lipsync` for that audio.
 *   3. await who.say('Hello there!')     No audio file: the browser's own voice speaks, the mouth follows the words.
 *                                        Sync is approximate and some sandboxes mute the browser voice (the mouth still moves).
 *  Rules: start the first line from a click (browsers block sound before one). One line at a time per character:
 *  a new say/play stops the previous one. who.stop() ends speech. who.speaking is true while a line runs.
 *  who.mouthTest() shows the 9 mouth shapes; who.info() lists poses and expressions.
 */
(function () {
  const OPEN = { X: 0, A: 0, B: 0.25, C: 0.6, D: 1, E: 0.6, F: 0.3, G: 0.2, H: 0.45 };
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; return (h >>> 0) / 4294967296; };

  // text -> mouth shapes (rough English/Banglish letter rules; good enough for a browser voice)
  const RULES = [[/^th/, 'H'], [/^(sh|ch)/, 'B'], [/^(oo|ou|ow)/, 'F'], [/^(ee|ea)/, 'B'], [/^[mbp]/, 'A'], [/^[fv]/, 'G'], [/^l/, 'H'], [/^[wuq]/, 'F'], [/^o/, 'E'], [/^a/, 'D'], [/^[e]/, 'C'], [/^[iy]/, 'B'], [/^r/, 'E'], [/^[a-z]/, 'B']];
  function wordShapes(w) {
    const out = []; let s = w.toLowerCase().replace(/[^a-z]/g, '');
    while (s) { for (const [re, v] of RULES) { const m = s.match(re); if (m) { if (out[out.length - 1] !== v) out.push(v); s = s.slice(m[0].length); break; } } }
    return out.length ? out : ['C'];
  }

  class Char {
    constructor(pack, images) { this.pack = pack; this.images = images; }
    info() {
      const P = this.pack, F = P.face || {};
      return { id: P.id, name: P.name, poses: Object.keys(P.poses), talkable: Object.keys(P.poses).filter((k) => P.poses[k].talkable),
        expressions: [...new Set(['neutral', ...Object.keys(F.expressions || {}), ...Object.keys(F.states || {})])] };
    }
    draw(ctx, st, { x, y, scale, flip }) {
      const P = this.pack, I = this.images, [rx, ry] = P.root;
      const view = mul([1, 0, 0, 1, x, y], mul([(flip ? -scale : scale), 0, 0, scale * (1 + (st.breathe || 0)), 0, 0], [1, 0, 0, 1, -rx, -ry]));
      const pose = P.poses[st.pose] || P.poses.idle || P.poses.master || Object.values(P.poses)[0];
      ctx.save(); ctx.setTransform(...view);
      ctx.drawImage(I[pose.image], 0, 0, P.canvas[0], P.canvas[1]);
      const F = P.face;
      if (pose.talkable && F) {
        const [[a, c, e], [b, d, f]] = pose.head;
        ctx.setTransform(...mul(view, [a, b, c, d, e, f]));
        const put = (t) => { if (!t || !t.image) return; const im = I[t.image], s = t.size || [im.width, im.height]; ctx.drawImage(im, t.at[0], t.at[1], s[0], s[1]); };
        put(F.cover);
        const closed = st.eyes === 'closed';
        if (F.states) { const set = F.states[st.expr] || F.states.neutral; put((closed && set.closed) || set.camera); }
        else {
          put(F.eyesBase);
          const ex = st.expr && (F.expressions || {})[st.expr];
          if (closed) { if (ex && ex.blink) put(ex.blink); else { put(F.blink); if (ex) put(ex.brows); } } else put(ex);
          put(F.hairLock);
        }
        put(F.visor); put(F.marks);
        const set = F.mouths[((F.expressions || {})[st.expr] || {}).mouths || st.expr] || F.mouths.neutral;
        const v = set[st.mouth] || set.X;
        const live = F.mouthStretch === false || st.mouth === 'X' || st.mouth === 'A' ? 1 : 1 + 0.1 * Math.max(-0.5, Math.min(0.6, (st.open || 0) - 0.4));
        ctx.drawImage(I[v.image], v.at[0], v.at[1], v.size[0], v.size[1] * live);
        put(F.overMouth);
      }
      ctx.restore();
    }
  }

  class Player {
    constructor(canvas, char, o) {
      this.canvas = canvas; this.char = char; this.ctx = canvas.getContext('2d');
      const info = char.info();
      this.pose = o.pose && char.pack.poses[o.pose] ? o.pose : info.poses[0];
      this.expr = o.expression || 'neutral'; this.fit = o.fit || 'body'; this.flip = !!o.flip; this.background = o.background || null;
      this.mode = null; this.blinks = []; let t = 1; for (let i = 0; i < 2000; i++) { this.blinks.push(t); t += 2.4 + 2.8 * hash(char.pack.id + i); }
      const tick = () => { if (!this.dead) { this.frame(); requestAnimationFrame(tick); } }; tick();
    }
    info() { return this.char.info(); }
    setPose(p) { if (this.char.pack.poses[p]) this.pose = p; return this; }
    setExpression(e) { this.expr = e; return this; }
    setFit(f) { this.fit = f; return this; }
    destroy() { this.stop(); this.dead = true; }
    stop() { if (this.audio) this.audio.pause(); this.audio = null; if (this.mode === 'say' && window.speechSynthesis) speechSynthesis.cancel(); this.sayS = null; this.live = null; this._end(); }
    /** a real voice line: track from `char lipsync`, audio = url / data URL (optional) */
    play(track, audio) { const done = this._begin('track'); this.track = track; this.t0 = performance.now() / 1000; this.audio = audio ? new Audio(audio) : null; if (this.audio) this.audio.play().catch(() => {}); return done; }
    mouthTest() { const frames = [...'XABCDEFGHX'].map((v) => v.repeat(14)).join(''); return this.play({ fps: 30, duration: frames.length / 30, frames, open: [...frames].map((v) => OPEN[v]) }); }
    /** current mouth shape letter (X = closed). Handy for tests and captions. */
    get mouth() { return this._mouth || 'X'; }
    _begin(mode) { this.stop(); this.mode = mode; return new Promise((ok) => { this._done = ok; }); }
    _end() { this.mode = null; const d = this._done; this._done = null; if (d) d(); }
    get speaking() { return !!this.mode; }
    /** speak text with the browser's voice; the mouth follows the words. opts: { rate, pitch, voice (name contains), lang, silent } */
    say(text, o = {}) {
      const wasSpeaking = this.mode === 'say';
      const done = this._begin('say');
      const rate = o.rate || 1, cps = 14.5 * rate;                             // browser voices read ~14.5 characters a second
      const words = []; text.replace(/\S+/g, (w, i) => { words.push({ at: i, len: w.length, shapes: wordShapes(w), pause: /[.!?।]$/.test(w) ? 0.38 : /[,;:]$/.test(w) ? 0.2 : 0.06 }); return w; });
      const S = this.sayS = { words, t0: performance.now() / 1000, cps, started: false, synced: 0 };
      const plan = () => { let t = 0.12; for (const w of words) { w.t = t; w.dur = Math.max(0.12, w.len / S.cps); t += w.dur + w.pause / rate; } S.end = t; };
      plan();
      if (!o.silent && window.speechSynthesis) {
        const u = new SpeechSynthesisUtterance(text); u.rate = rate; if (o.pitch) u.pitch = o.pitch; if (o.lang) u.lang = o.lang;
        if (o.voice) { const v = speechSynthesis.getVoices().find((x) => x.name.toLowerCase().includes(o.voice.toLowerCase())); if (v) u.voice = v; }
        u.onstart = () => { S.started = true; S.t0 = performance.now() / 1000; };
        u.onboundary = (e) => {                                                 // the voice tells us which word it is on: lock to it
          if (e.name && e.name !== 'word') return;
          const now = performance.now() / 1000, k = words.findIndex((x) => x.at <= e.charIndex && e.charIndex < x.at + x.len + 1);
          if (k < 0) return;
          if (k > 2 && S.lastK != null && k > S.lastK) {                       // learn this voice's real speed from the words so far
            const real = (now - S.lastT) / Math.max(1, words[k].at - words[S.lastK].at);
            if (real > 0.02 && real < 0.3) { S.cps = 0.6 * S.cps + 0.4 / real; const t = words[k].t; plan(); S.t0 += words[k].t - t; }
          }
          S.t0 = now - words[k].t; S.lastK = k; S.lastT = now; S.synced++;
        };
        u.onend = u.onerror = () => { if (this.sayS === S && this.mode === 'say') this._end(); };
        // Chrome drops an utterance spoken straight after cancel(): give it a beat
        setTimeout(() => { if (this.sayS === S && this.mode === 'say') speechSynthesis.speak(u); }, wasSpeaking ? 120 : 0);
        this.utter = u;                                                        // keep a reference: some browsers garbage-collect a speaking utterance and never fire onend
      } else S.silent = true;
      return done;
    }
    /** play any audio and lip-sync to the SOUND itself, live (no track needed). src = url | data: | blob: | HTMLAudioElement */
    playAudio(src, o = {}) {
      const done = this._begin('live');
      const el = src instanceof HTMLMediaElement ? src : new Audio(src);
      if (!(src instanceof HTMLMediaElement)) el.crossOrigin = 'anonymous';
      this.audio = el;
      const AC = window.AudioContext || window.webkitAudioContext;
      try {
        const ac = (Player.ac ||= new AC()); if (ac.state === 'suspended') ac.resume();
        const node = (el._dcNode ||= ac.createMediaElementSource(el));
        const an = ac.createAnalyser(); an.fftSize = 1024; an.smoothingTimeConstant = 0.35;
        node.connect(an); an.connect(ac.destination);
        this.live = { an, freq: new Uint8Array(an.frequencyBinCount), time: new Uint8Array(an.fftSize), hz: ac.sampleRate / an.fftSize, peak: 0.08, cur: 'X', since: 0, gain: o.gain || 1 };
      } catch (e) { this.live = null; console.warn('dotchar: live lip-sync unavailable, playing sound only', e); }
      el.onended = () => { if (this.audio === el) this._end(); };
      el.onerror = () => { if (this.audio === el) this._end(); };
      el.play().catch(() => { if (this.audio === el) this._end(); });
      return done;
    }
    /** mouth shape for this instant of sound: loudness = how open, colour of the sound = which shape */
    _liveShape(now) {
      const L = this.live; if (!L) return ['X', 0];
      L.an.getByteTimeDomainData(L.time); L.an.getByteFrequencyData(L.freq);
      let sum = 0; for (let i = 0; i < L.time.length; i++) { const v = (L.time[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / L.time.length) * L.gain;
      L.peak = Math.max(rms, L.peak * 0.9995);                                 // slow-decaying loudness reference
      const lvl = Math.min(1, rms / (L.peak * 0.75 + 1e-6));
      const band = (a, b) => { let s = 0, n = 0; for (let i = Math.max(1, Math.round(a / L.hz)); i < Math.min(L.freq.length, Math.round(b / L.hz)); i++) { s += L.freq[i]; n++; } return n ? s / n : 0; };
      const low = band(120, 500), mid = band(500, 2200), high = band(2800, 7500);
      let v;
      if (lvl < 0.17) v = 'X';
      else if (high > mid * 1.05 && high > low * 0.9) v = lvl > 0.5 ? 'B' : 'G';   // hissy: S, SH, T / F, V
      else if (lvl < 0.3) v = 'B';
      else if (low > mid * 1.9) v = lvl > 0.6 ? 'E' : 'F';                          // dark, rounded: OH / OO
      else v = lvl > 0.72 ? 'D' : lvl > 0.42 ? 'C' : 'B';                           // open vowels by loudness
      if (v !== L.cur) {
        const closing = v === 'X' && L.cur !== 'X' && L.cur !== 'A';
        if (now - L.since >= (closing ? 0.05 : 0.07)) { L.prev = L.cur; L.cur = closing && lvl < 0.05 ? 'X' : v; L.since = now; } // hold each shape 2 frames: no flicker
      }
      return [L.cur, lvl];
    }
    place() {
      const P = this.char.pack, w = this.canvas.width, h = this.canvas.height, [rx, ry] = P.root, H = P.height, box = P.face && P.face.box, m = 0.06;
      let r;
      if (this.fit === 'face' && box) { const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2, s = (box[2] - box[0]) * 0.62; r = [cx - s, cy - s, cx + s, cy + s]; }
      else if (this.fit === 'bust') { r = box ? [(box[0] + box[2]) / 2 - (box[2] - box[0]) * 1.05, box[1] - (box[3] - box[1]) * 0.25, (box[0] + box[2]) / 2 + (box[2] - box[0]) * 1.05, box[3] + (box[3] - box[1]) * 0.95] : [rx - H * 0.3, ry - H, rx + H * 0.3, ry - H * 0.55]; }
      else r = [rx - H * 0.4, ry - H, rx + H * 0.4, ry];
      const scale = Math.min(w / (r[2] - r[0]), h / (r[3] - r[1])) * (1 - m * 2), cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
      return { x: w / 2 + (this.flip ? -1 : 1) * (rx - cx) * scale, y: this.fit === 'bust' ? h * m + (ry - r[1]) * scale : h / 2 + (ry - cy) * scale, scale, flip: this.flip };
    }
    frame() {
      const now = performance.now() / 1000, st = { pose: this.pose, expr: this.expr, mouth: 'X', open: 0, breathe: 0.006 * Math.sin((2 * Math.PI * now) / 3.6) };
      const lt = now % 3600; if (this.blinks.some((b) => lt >= b && lt < b + 0.1)) st.eyes = 'closed';
      if (this.mode === 'track') {
        const tr = this.track, t = this.audio && !this.audio.paused ? this.audio.currentTime : now - this.t0;
        if (t > tr.duration + 0.2 && (!this.audio || this.audio.ended)) this._end();
        else { const k = Math.floor(t * tr.fps); st.mouth = tr.frames[k] || 'X'; st.open = (tr.open && tr.open[k]) || OPEN[st.mouth] || 0; }
      } else if (this.mode === 'live') {
        const [v, lvl] = this._liveShape(now); st.mouth = v; st.open = Math.max(OPEN[v], lvl * 0.8);
      } else if (this.mode === 'say') {
        const S = this.sayS, t = now - S.t0; let w = null;
        for (const x of S.words) { if (x.t <= t) w = x; else break; }
        if (w && t < w.t + w.dur) { const k = Math.min(w.shapes.length - 1, Math.floor(((t - w.t) / w.dur) * w.shapes.length)); st.mouth = w.shapes[k]; st.open = OPEN[st.mouth]; }
        // the voice is still talking past our estimate and never reported word positions: keep the mouth moving, don't freeze shut
        if (t >= S.end && !S.synced && !S.silent && S.started && window.speechSynthesis && speechSynthesis.speaking) { st.mouth = 'BCDCBEXC'[Math.floor(t / 0.09) % 8]; st.open = OPEN[st.mouth]; }
        // no voice (muted sandbox, or silent:true): the text timeline is the clock, end when it runs out
        const voiceGone = S.silent || (!S.started && t > 1.5) || !(window.speechSynthesis && (speechSynthesis.speaking || speechSynthesis.pending));
        if (t > S.end + 0.3 && voiceGone) this._end();
      }
      const c = this.ctx; c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, this.canvas.width, this.canvas.height);
      if (this.background) { c.fillStyle = this.background; c.fillRect(0, 0, this.canvas.width, this.canvas.height); }
      this._mouth = st.mouth;
      this.char.draw(c, st, this.place());
    }
  }

  window.DotChar = {
    /** data = { pack, images: { path: dataURL } } (the Studio's single-file export). Returns a Player. */
    async mount(canvas, data, opts) {
      const images = {};
      await Promise.all(Object.entries(data.images).map(([k, src]) => new Promise((ok, err) => { const i = new Image(); i.onload = () => { images[k] = i; ok(); }; i.onerror = () => err(new Error('bad image ' + k)); i.src = src; })));
      return new Player(canvas, new Char(data.pack, images), opts || {});
    },
  };
})();
