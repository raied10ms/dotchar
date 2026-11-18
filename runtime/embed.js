/*! dotchar embed player: one self-contained script, no imports, no network. Used by the Studio's "single-file" export
 *  (Claude artifacts, LMS pages, emails-to-self, anything that cannot load outside files).
 *
 *  const who = await DotChar.mount(canvas, CHAR_DATA, { pose: 'explain', expression: 'happy', fit: 'bust' });
 *  who.setPose('wave'); who.setExpression('surprised'); who.setFit('face' | 'bust' | 'body');
 *  who.say('Hello! Welcome to class.');             // browser voice + mouth movement from the text (no audio file needed)
 *  who.play(track, 'line.mp3');                     // a real voice line: track = *.lipsync.json made by `char lipsync`
 *  who.mouthTest(); who.stop(); who.info()          // info(): { poses, expressions }
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
    stop() { if (this.audio) this.audio.pause(); this.audio = null; if (this.mode === 'say' && window.speechSynthesis) speechSynthesis.cancel(); this.mode = null; }
    /** a real voice line: track from `char lipsync`, audio = url / data URL (optional) */
    play(track, audio) { this.stop(); this.track = track; this.t0 = performance.now() / 1000; this.audio = audio ? new Audio(audio) : null; if (this.audio) this.audio.play().catch(() => {}); this.mode = 'track'; return this; }
    mouthTest() { const frames = [...'XABCDEFGHX'].map((v) => v.repeat(14)).join(''); return this.play({ fps: 30, duration: frames.length / 30, frames, open: [...frames].map((v) => OPEN[v]) }); }
    /** speak text with the browser's voice; the mouth follows the words. opts: { rate, pitch, voice (name contains), lang, silent } */
    say(text, o = {}) {
      this.stop();
      const words = []; text.replace(/\S+/g, (w, i) => { words.push({ at: i, shapes: wordShapes(w) }); return w; });
      const rate = o.rate || 1, per = 0.085 / rate;
      let t = 0.15; for (const w of words) { w.t = t; t += w.shapes.length * per + 0.09 / rate; }
      this.sayS = { words, per, t0: performance.now() / 1000, end: t };
      this.mode = 'say';
      if (!o.silent && window.speechSynthesis) {
        const u = new SpeechSynthesisUtterance(text); u.rate = rate; if (o.pitch) u.pitch = o.pitch; if (o.lang) u.lang = o.lang;
        if (o.voice) { const v = speechSynthesis.getVoices().find((x) => x.name.toLowerCase().includes(o.voice.toLowerCase())); if (v) u.voice = v; }
        const S = this.sayS;
        u.onstart = () => { S.t0 = performance.now() / 1000; };
        u.onboundary = (e) => { const w = words.find((x) => x.at === e.charIndex); if (w) S.t0 = performance.now() / 1000 - w.t; }; // re-sync on every spoken word
        u.onend = () => { if (this.sayS === S) this.mode = null; };
        speechSynthesis.speak(u);
      }
      return this;
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
        if (t > tr.duration + 0.2 && (!this.audio || this.audio.ended)) this.mode = null;
        else { const k = Math.floor(t * tr.fps); st.mouth = tr.frames[k] || 'X'; st.open = (tr.open && tr.open[k]) || OPEN[st.mouth] || 0; }
      } else if (this.mode === 'say') {
        const S = this.sayS, t = now - S.t0; let w = null;
        for (const x of S.words) { if (x.t <= t) w = x; else break; }
        if (w) { const k = Math.floor((t - w.t) / S.per); st.mouth = w.shapes[k] || 'X'; st.open = OPEN[st.mouth]; }
        if (t > S.end + 0.4 && !(window.speechSynthesis && speechSynthesis.speaking)) this.mode = null;
      }
      const c = this.ctx; c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, this.canvas.width, this.canvas.height);
      if (this.background) { c.fillStyle = this.background; c.fillRect(0, 0, this.canvas.width, this.canvas.height); }
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
