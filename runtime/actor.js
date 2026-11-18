/**
 * Actor = puppet + timed actions. poseAt(t) is a PURE function of time (scrubbable, deterministic, parallel-renderable).
 *
 *   { at, pose: 'point', dur? }            switch body pose (any generated pose id); returns to idle after dur
 *   { at, point: target, dur=2 }           'point' pose, turned to face the target (actor name or [x,y])
 *   { at, expression: 'happy', dur? }      eyes/brows + the matching mouth set (talks happy / sad / ...)
 *   { at, say: 'lineId' }                  lip-sync track
 *   { at, walk|run: { to, speed } }        cycle frames advance by distance (no foot sliding), faces travel direction
 *   { at, face: 'L'|'R'|actorName }
 *   { at, look: 'left'|'right'|'down'|'down-left'|'down-right'|'camera'|actorName|'auto', dur? }   eye direction
 *        explicit look wins; 'auto' (default) = while anyone speaks: speaker looks at the nearest other actor,
 *        listeners look at the speaker; between lines keep the last gaze; work poses look down.
 *   { at, react: 'nod'|'tilt'|'bounce'|'jolt'|'bob', dur?, amp?, dir?, count? }   head/body beat (additive, eased in and out)
 *        nod = head dips forward (count 1|2) · tilt = head tilts and holds (questions) · bounce = two happy hops (laughs)
 *        jolt = small startle up (gasps) · bob = tiny dip on a stressed syllable (speakers). Written by episode.mjs auto-react.
 * cast options: { still: true } = no idle life at all (no breathing, sway, drift, squash, reactions, gaze shifts):
 *                                  fx / flipbook / stage actors. Only mouth + blinks move.
 *               { gaze: 'camera' } = this actor's auto default when alone / addressing the audience
 *
 * IDLE LIFE, on by default for every non-still actor, deterministic per actor id (seeded by name):
 *   breathing ±0.6 % scale / 3.6 s · weight sway ±0.4° (pivot at the feet) · head drift ±0.5° · blinks every 2.4-5.2 s
 *   · one gaze shift every 3-6 s while listening (glance at another actor or a short drift, then back to the speaker).
 *   State fields: breathe (scale), lean (deg, whole figure about the feet), headRot (deg), lift (px, +down).
 *   The puppet renders lean + lift (+ headRot folded into lean at HEAD_FOLD) through a transform wrapper below, until it
 *   draws a separate head layer itself (set `puppet.drawsHeadRot = true` and it gets headRot untouched, no fold).
 */
const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; };
const mix = (s) => { // FNV-1a + murmur3 finaliser: neighbouring keys (blink:7, blink:8) give unrelated values
  let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};
const rnd = (name, kind, i) => mix(`${name}:${kind}:${i}`);
const ss = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));          // smoothstep
const bump = (k) => (k <= 0 || k >= 1 ? 0 : Math.sin(Math.PI * k) ** 2);    // 0 -> 1 -> 0, zero slope at both ends
export const LIFE = { breathe: 0.006, breathePeriod: 3.6, sway: 0.4, drift: 0.5, blinkMin: 2.4, blinkMax: 5.2, blinkDur: 0.1,
  glanceMin: 3, glanceMax: 6, glanceDur: [0.7, 1.2], HEAD_FOLD: 0.35 };
const REACT = { // default dur (s), amplitude (fraction of body height for lift, degrees for rotation)
  nod: { dur: 0.6, lift: 0.009, rot: 1.6 }, tilt: { dur: 1.5, rot: 4 }, bounce: { dur: 0.9, lift: 0.02 },
  jolt: { dur: 0.45, lift: 0.012, rot: 0.8 }, bob: { dur: 0.34, lift: 0.005, rot: 0.7 },
};
// A character may opt out of side glances per expression: char.json face.gazeCameraOnly = ['sad', ...] or ['*'].
const gazeSkip = (puppet, expr, g) => { const o = puppet.pack.face?.gazeCameraOnly; return g !== 'camera' && o && (o.includes(expr) || o.includes('*')) ? 'camera' : g; };
const OPEN = { X: 0, A: 0, B: 0.25, C: 0.6, D: 1, E: 0.6, F: 0.3, G: 0.2, H: 0.45 };

export class Actor {
  constructor(name, puppet, { x = 0, y = 0, scale = 0.5, face = 'R', idle = 'idle', expression = 'neutral', still = false, gaze = null, actions = [] } = {}) {
    Object.assign(this, { name, puppet, x0: x, y, scale, face0: face, idle: puppet.has(idle) ? idle : 'master', expr0: expression, still, gaze0: gaze });
    this.actions = [...actions].sort((a, b) => a.at - b.at);
    this.seed = hash(name);
    this.reacts = this.actions.filter((a) => a.react && REACT[a.react]);
    this._sched = {};
    // idle-life phases / periods, fixed per actor id
    const r = (k) => rnd(name, 'life', k);
    this.life = { ph: [0, 1, 2, 3, 4].map((k) => r(k) * 2 * Math.PI), swayT: 4.6 + 1.4 * r(5), swayT2: 2.7 + 0.6 * r(6),
      driftT: 6.2 + 1.6 * r(7), driftT2: 3.9 + 0.8 * r(8), tiltDir: r(9) < 0.5 ? -1 : 1 };
    wrapPuppet(puppet);
    this.moves = []; let cx = x, tt = 0;
    for (const a of this.actions) {
      const m = a.walk || a.run;
      if (!m) continue;
      // default speeds match the drawn stride (feet don't slide): walk 0.9 body-heights/s, run 2.2
      const kind = a.walk ? 'walk' : 'run', H = puppet.pack.height * scale, sp = m.speed || (kind === 'walk' ? 0.9 : 2.2) * H;
      const t0 = Math.max(a.at, tt), dur = Math.abs(m.to - cx) / sp;
      this.moves.push({ t0, t1: t0 + dur, x0: cx, x1: m.to, kind }); cx = m.to; tt = t0 + dur;
    }
  }

  xAt(t) {
    let x = this.x0;
    for (const m of this.moves) {
      if (t >= m.t1) { x = m.x1; continue; }
      if (t > m.t0) { const k = (t - m.t0) / (m.t1 - m.t0); return { x: m.x0 + (m.x1 - m.x0) * k, move: m, dist: Math.abs(m.x1 - m.x0) * k }; }
    }
    return { x, move: null, dist: 0 };
  }

  anchor(t, what = 'head') {
    const { x } = this.xAt(t), P = this.puppet.pack, [rx, ry] = P.root;
    const p = what === 'head' ? P.face.mouthAnchor : [rx, ry - P.height * 0.45];
    return [x + (p[0] - rx) * this.scale, this.y + (p[1] - ry) * this.scale];
  }

  /** body pose id at time t (actions only; used to find what we are transitioning from) */
  #poseOnly(t) {
    let pose = this.idle;
    for (const a of this.actions) {
      if (a.at > t) break;
      if (a.pose) pose = a.dur == null || t < a.at + a.dur ? a.pose : this.idle;
      if (a.point != null) pose = t < a.at + (a.dur ?? 2) ? 'point' : pose === 'point' ? this.idle : pose;
    }
    return this.puppet.has(pose) ? pose : this.idle;
  }

  /** screen direction ('left'|'right') toward another actor, from x positions */
  dirTo(other, t, x) { const ox = other.xAt(t).x; return ox < x ? 'left' : 'right'; }

  /** deterministic event times [t0, t1, ...] up to `until`: first at off+rand*first, then gaps in [min, max] */
  schedule(kind, min, max, until, first = max) {
    const c = (this._sched[kind] ||= []);
    if (!c.length) c.push(rnd(this.name, kind, 0) * first + 0.4);
    while (c[c.length - 1] < until) c.push(c[c.length - 1] + min + (max - min) * rnd(this.name, kind, c.length));
    return c;
  }

  /** 0 while walking/running (cycle frames carry their own motion), eased back in over 0.3 s around each move */
  lifeWeight(t) {
    if (this.still) return 0;
    let w = 1;
    for (const m of this.moves) {
      if (t >= m.t0 && t <= m.t1) return 0;
      const d = t < m.t0 ? m.t0 - t : t - m.t1;
      w = Math.min(w, ss(d / 0.3));
    }
    return w;
  }

  /** listening glance (F1): inside a scheduled window returns a gaze target, else null */
  #listenGlance(t, ctx, x, sp, others) {
    const L = LIFE, times = this.schedule('glance', L.glanceMin, L.glanceMax, t + 1, 3);
    let i = times.length - 1; while (i > 0 && times[i] > t) i--;
    const t0 = times[i]; if (t < t0) return null;
    const dur = L.glanceDur[0] + (L.glanceDur[1] - L.glanceDur[0]) * rnd(this.name, 'gdur', i);
    if (t >= t0 + dur) return null;
    // another on-stage actor (not the speaker, not fx/stage stand-ins parked off-screen) or a short drift
    const near = others.filter((o) => !o.still && o.name !== sp.name && Math.abs(o.xAt(t0).x - x) < 1400 && Math.abs(o.xAt(t0).x - x) > 1);
    const pick = rnd(this.name, 'gwho', i);
    if (near.length && pick < 0.6) return this.dirTo(near[Math.floor(pick / 0.6 * near.length) % near.length], t0, x);
    const spDir = ctx.actors[sp.name] ? this.dirTo(ctx.actors[sp.name], t0, x) : 'right';
    const drift = near.length ? (pick - 0.6) / 0.4 : pick;   // short drift: down, or away from the speaker
    return drift < 0.5 ? 'down' : spDir === 'left' ? 'right' : 'left';
  }

  /** eye direction at t (pure). Explicit look > work pose > auto conversation rule > cast default. */
  gazeAt(t, ctx = {}, x = this.xAt(t).x, pose = null) {
    let look = null;
    for (const a of this.actions) {
      if (a.at > t) break;
      if ('look' in a && (a.dur == null || t < a.at + a.dur)) look = a.look;
      else if ('look' in a && a.dur != null && t >= a.at + a.dur && look === a.look) look = null;
    }
    const actors = ctx.actors || {};
    if (look && look !== 'auto') {
      if (actors[look]) return this.dirTo(actors[look], t, x);
      return look;
    }
    const WORK = /^(notebook|write-exam|build-robot|tinker|water|lie-prone-writing|sit-bench-eat|eat-chips|hold-book|hold-diary|tear-diary|count|watch)$/;
    if (pose && (WORK.test(pose) || this.puppet.pack.poses[pose]?.look === 'down')) return 'down';
    // auto: who is speaking (or spoke last)?
    const sp = ctx.speakerAt ? ctx.speakerAt(t) : null;
    const others = Object.values(actors).filter((a) => a !== this);
    if (!sp || !others.length) return this.gaze0 || 'camera';
    if (sp.name === this.name) {
      if (sp.camera) return 'camera';
      const near = others.sort((a, b) => Math.abs(a.xAt(t).x - x) - Math.abs(b.xAt(t).x - x))[0];
      return this.dirTo(near, t, x);
    }
    if (!actors[sp.name]) return this.gaze0 || 'camera';
    const glance = this.still ? null : this.#listenGlance(t, ctx, x, sp, others);
    this._listening = true; this._glancing = !!glance;
    return glance || this.dirTo(actors[sp.name], t, x);
  }

  /** idle life + reaction beats at t: { breathe, lean, headRot, lift } (pure) */
  lifeAt(t, face) {
    const w = this.lifeWeight(t);
    if (!w) return { breathe: 0, lean: 0, headRot: 0, lift: 0 };
    const L = LIFE, l = this.life, ph = l.ph, TAU = 2 * Math.PI;
    const breathe = L.breathe * Math.sin(TAU * t / L.breathePeriod + ph[0]);
    let lean = L.sway * (0.75 * Math.sin(TAU * t / l.swayT + ph[1]) + 0.25 * Math.sin(TAU * t / l.swayT2 + ph[2]));
    let headRot = L.drift * (0.6 * Math.sin(TAU * t / l.driftT + ph[3]) + 0.4 * Math.sin(TAU * t / l.driftT2 + ph[4]));
    let lift = 0;
    const H = this.puppet.pack.height * this.scale, fwd = face === 'L' ? -1 : 1;
    for (const a of this.reacts) {
      const R = REACT[a.react], d = a.dur ?? R.dur, k = (t - a.at) / d;
      if (k <= 0 || k >= 1) continue;
      const amp = a.amp ?? 1;
      if (a.react === 'tilt') { // ease in 0.3 s, hold, ease out 0.45 s
        const e = ss((t - a.at) / Math.min(0.3, d / 3)) * ss((a.at + d - t) / Math.min(0.45, d / 3));
        headRot += R.rot * amp * e * (a.dir ?? l.tiltDir);
      } else if (a.react === 'nod') {
        const n = a.count ?? 1, b = bump((k * n) % 1);
        lift += R.lift * amp * H * b; headRot += R.rot * amp * b * fwd;
      } else if (a.react === 'bounce') {
        lift -= R.lift * amp * H * Math.sin(TAU * k) ** 2 * (1 - 0.35 * k);
      } else if (a.react === 'jolt') {
        const b = bump(k) * (1 - 0.5 * k);
        lift -= R.lift * amp * H * b; headRot -= R.rot * amp * b * fwd;
      } else if (a.react === 'bob') {
        const b = bump(k);
        lift += R.lift * amp * H * b; headRot += R.rot * amp * b * fwd;
      }
    }
    return { breathe: breathe * w, lean: lean * w, headRot: headRot * w, lift: lift * w };
  }

  poseAt(t, ctx = {}) {
    const { x, move, dist } = this.xAt(t);
    const st = { pose: this.idle, expr: this.expr0, mouth: 'X', open: 0, eyes: 'open' };
    let face = this.face0, poseStart = 0;
    const faceTo = (target) => {
      const p = typeof target === 'string' ? ctx.actors?.[target]?.anchor(t) : target;
      return p ? (p[0] < x ? 'L' : 'R') : face;
    };
    for (const a of this.actions) {
      if (a.at > t) break;
      const live = a.dur == null || t < a.at + a.dur;
      if (a.face) face = a.face === 'L' || a.face === 'R' ? a.face : faceTo(a.face);
      if (a.pose) { st.pose = live ? a.pose : this.idle; poseStart = live ? a.at : a.at + a.dur; }
      if (a.point != null) {
        const d = a.dur ?? 2;
        if (t < a.at + d) { st.pose = 'point'; face = faceTo(a.point); poseStart = a.at; } else if (st.pose === 'point') { st.pose = this.idle; poseStart = a.at + d; }
      }
      if (a.expression) st.expr = live ? a.expression : this.expr0;
    }
    if (!this.puppet.has(st.pose)) st.pose = this.idle;
    // in-between drawing for ~3 frames on every pose change (idle <-> pose: its tween; pose A -> B: A's then B's)
    const TW = 0.1, since0 = t - poseStart;
    if (poseStart > 0 && since0 >= 0 && since0 < TW) {
      const prev = this.#poseOnly(poseStart - 0.001), P = this.puppet.pack.poses;
      const into = st.pose !== this.idle && P[st.pose]?.tween, outOf = prev !== this.idle && P[prev]?.tween;
      if (into && outOf) st.tweenOf = since0 < TW / 2 ? prev : st.pose;
      else if (into) st.tweenOf = st.pose;
      else if (outOf) st.tweenOf = prev;
    }
    // speech
    for (const a of this.actions) if (a.say && ctx.tracks?.[a.say]) {
      const tr = ctx.tracks[a.say], lt = t - a.at;
      if (lt >= 0 && lt < tr.duration) { const k = Math.floor(lt * tr.fps); st.mouth = tr.frames[k] || 'X'; st.open = tr.open[k] ?? OPEN[st.mouth]; }
    }
    // locomotion: cycle frame by distance travelled (stride in screen px)
    if (move && this.puppet.pack.cycles[move.kind]) {
      const H = this.puppet.pack.height * this.scale;
      const step = (move.kind === 'walk' ? 0.9 / 12 : 2.2 / 15) * H; // 12 / 15 drawings per second at default speed
      st.cycle = { id: move.kind, frame: Math.floor(dist / step) };
      face = move.x1 > move.x0 ? 'R' : 'L';
    }
    // life (F1): breathing, weight sway, head drift + scripted/auto reaction beats; a quick squash on pose changes
    Object.assign(st, this.lifeAt(t, face));
    const since = t - poseStart;
    st.squash = !this.still && poseStart > 0 && since >= 0 && since < 0.12 ? 0.03 * (1 - since / 0.12) : 0;
    // ---- gaze
    const gazeOff = ctx.gazeOff || globalThis.GAZE_OFF;  // global kill switch: eyes always at camera, no gaze blinks
    this._listening = false; this._glancing = false;
    st.gaze = gazeOff ? 'camera' : gazeSkip(this.puppet, st.expr, this.gazeAt(t, ctx, x, st.pose));
    const listening = this._listening, glancing = this._glancing;
    const gPrev = gazeOff ? 'camera' : gazeSkip(this.puppet, st.expr, this.gazeAt(Math.max(0, t - 0.08), ctx, this.xAt(Math.max(0, t - 0.08)).x, st.pose));
    // gaze changes blink (hides the tile swap), except the return from a listening glance: eyes just slide back
    if (gPrev !== st.gaze && !(this._glancing && !glancing)) this._gazeChange = t;
    const blinkOnLook = this._gazeChange != null && t - this._gazeChange >= 0 && t - this._gazeChange < 0.1;
    // blinks: irregular deterministic schedule (gaps 2.4-5.2 s, per actor), 3 frames shut
    const bl = this.schedule('blink', LIFE.blinkMin, LIFE.blinkMax, t + 1, 2.8);
    // (a scheduled blink within 0.9 s of a listening-glance boundary is dropped: the gaze change already blinks)
    const gl = this.still ? [] : this.schedule('glance', LIFE.glanceMin, LIFE.glanceMax, t + 2, 3);
    const nearGlance = (bt) => gl.some((g, i) => {
      const gd = LIFE.glanceDur[0] + (LIFE.glanceDur[1] - LIFE.glanceDur[0]) * rnd(this.name, 'gdur', i);
      return Math.abs(bt - g) < 0.9 || Math.abs(bt - g - gd) < 0.9;
    });
    for (let i = bl.length - 1; i >= 0 && bl[i] > t - LIFE.blinkDur; i--) if (t >= bl[i] && !(st.gaze !== 'camera' && listening && nearGlance(bl[i]))) st.eyes = 'closed';
    if (blinkOnLook) st.eyes = 'closed';
    return { state: st, place: { x, y: this.y, scale: this.scale, flip: face === 'L' } };
  }
}

/**
 * Render lean / lift / headRot without touching puppet.js: every setTransform the puppet issues during draw() is
 * pre-multiplied by  translate(x, y + lift) · rotate(lean [+ HEAD_FOLD·headRot]) · translate(-x, -y)  (pivot = feet).
 * Composes with scene.js' camera wrapper (which also overrides ctx.setTransform). The ground shadow is drawn
 * outside draw(), so it stays planted while the figure hops / leans.
 */
function wrapPuppet(puppet) {
  if (puppet.__lifeWrapped) return;
  const raw = puppet.draw;
  puppet.draw = function (ctx, st = {}, place = {}, ...rest) {
    const rot = (st.lean || 0) + (this.drawsHeadRot ? 0 : LIFE.HEAD_FOLD * (st.headRot || 0)), lift = st.lift || 0;
    if (Math.abs(rot) < 1e-4 && Math.abs(lift) < 1e-3) return raw.call(this, ctx, st, place, ...rest);
    const x = place.x || 0, y = place.y || 0;
    const M = new DOMMatrix().translate(x, y + lift).rotate(rot).translate(-x, -y);
    const own = Object.prototype.hasOwnProperty.call(ctx, 'setTransform'), prev = ctx.setTransform;
    ctx.setTransform = (...m) => prev.call(ctx, M.multiply(m.length === 6 ? new DOMMatrix(m) : m[0] instanceof DOMMatrix ? m[0] : new DOMMatrix(m[0] ? [m[0].a, m[0].b, m[0].c, m[0].d, m[0].e, m[0].f] : undefined)));
    try { return raw.call(this, ctx, st, place, ...rest); } finally { if (own) ctx.setTransform = prev; else delete ctx.setTransform; }
  };
  puppet.__lifeWrapped = true;
}
