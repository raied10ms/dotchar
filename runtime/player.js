/**
 * One character performing one take: lip-sync track + optional pose/expression cues + idle life (blink, breathing).
 * Pure function of time (scrub, render in parallel, sync to any audio clock). For multi-character scenes use scene.js.
 *
 *   const perf = new Performance(puppet, { track, pose: 'explain', expression: 'happy',
 *                                          cues: [{ at: 1.2, pose: 'point', dur: 1.5 }, { at: 2, expr: 'surprised' }] });
 *   perf.draw(ctx, t, perf.fit(canvas.width, canvas.height, 'bust'));
 */
const mix = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; return (h >>> 0) / 4294967296; };

export class Performance {
  constructor(puppet, { track = null, cues = [], pose, expression = 'neutral', gaze = 'camera', life = true, flip = false } = {}) {
    this.puppet = puppet; this.track = track; this.flip = flip; this.life = life;
    const P = puppet.pack.poses || {};
    this.pose0 = pose && P[pose] ? pose : P.idle ? 'idle' : 'master';
    this.expr0 = expression; this.gaze0 = gaze;
    this.cues = [...cues].sort((a, b) => a.at - b.at);
    // blink schedule: irregular but deterministic per character
    this.blinks = []; let t = 0.8 + mix(puppet.pack.id + ':b0') * 1.5;
    for (let i = 1; t < 3600; i++) { this.blinks.push(t); t += 2.4 + 2.8 * mix(`${puppet.pack.id}:b${i}`); }
  }
  get duration() { return this.track ? this.track.duration : Math.max(0, ...this.cues.map((c) => c.at + (c.dur || 0))); }

  /** the value of `field` at t from the cue list (a cue with dur reverts afterwards); returns [value, since] */
  #cue(field, t, dflt) {
    let v = dflt, since = 0;
    for (const c of this.cues) {
      if (c.at > t) break;
      if (c[field] == null) continue;
      if (c.dur != null && t > c.at + c.dur) { v = dflt; since = c.at + c.dur; } else { v = c[field]; since = c.at; }
    }
    return [v, since];
  }

  stateAt(t) {
    const [pose, since] = this.#cue('pose', t, this.pose0);
    const [expr] = this.#cue('expr', t, this.expr0);
    const [gaze] = this.#cue('gaze', t, this.gaze0);
    const st = { pose, expr, gaze, mouth: 'X', open: 0 };
    // pose change passes through the generated halfway drawing for ~3 frames
    if (since > 0 && t - since < 0.1) {
      const P = this.puppet.pack.poses;
      if (P[pose]?.tween) st.tweenOf = pose;
      else { const prev = this.#cue('pose', since - 1e-3, this.pose0)[0]; if (P[prev]?.tween) st.tweenOf = prev; }
    }
    const tr = this.track;
    if (tr && t >= 0 && t < tr.duration) {
      const k = Math.floor(t * tr.fps);
      st.mouth = tr.frames[k] || 'X';
      st.open = tr.open?.[k] ?? 0;
    }
    if (this.life) {
      st.breathe = 0.006 * Math.sin((2 * Math.PI * t) / 3.6);
      if (this.blinks.some((b) => t >= b && t < b + 0.1)) st.eyes = 'closed';
    }
    return st;
  }

  /** rig-space region -> placement that fits it in a w x h canvas. fit: 'body' | 'bust' | 'face' | [x0,y0,x1,y1] */
  fit(w, h, fit = 'body', margin = 0.06) {
    const P = this.puppet.pack, [rx, ry] = P.root, H = P.height;
    const box = P.face?.box;
    let r;
    if (Array.isArray(fit)) r = fit;
    else if (fit === 'face' && box) { const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2, s = (box[2] - box[0]) * 0.62; r = [cx - s, cy - s, cx + s, cy + s]; }
    else if (fit === 'bust') { r = box ? [(box[0] + box[2]) / 2 - (box[2] - box[0]) * 1.05, box[1] - (box[3] - box[1]) * 0.25, (box[0] + box[2]) / 2 + (box[2] - box[0]) * 1.05, box[3] + (box[3] - box[1]) * 0.95] : [rx - H * 0.3, ry - H, rx + H * 0.3, ry - H * 0.55]; } // head and shoulders, sized from the head
    else r = [rx - H * 0.4, ry - H, rx + H * 0.4, ry];
    const rw = r[2] - r[0], rh = r[3] - r[1];
    const scale = Math.min(w / rw, h / rh) * (1 - margin * 2);
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
    // bust: hug the top of the frame (headroom = margin), so a tall canvas fills with more body, not empty space
    const y = fit === 'bust' ? h * margin + (ry - r[1]) * scale : h / 2 + (ry - cy) * scale;
    return { x: w / 2 + (this.flip ? -1 : 1) * (rx - cx) * scale, y, scale, flip: this.flip };
  }

  draw(ctx, t, place) { this.puppet.draw(ctx, this.stateAt(t), place); }
}
