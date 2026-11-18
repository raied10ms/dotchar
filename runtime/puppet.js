/**
 * Pose-library puppet (v2). Body = one generated image per activity; face = layers drawn through the pose's
 * head affine (master -> pose): skin cover over the pose's own mouth, expression eyes/brows, blink, library mouth.
 * Canvas 2D, no deps. Format: SPEC.md (.char). Two face flavours: `states` (one image per expression x eye state)
 * and `layers` (eyesBase + expression eyes/brows + blink).
 */
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const T = (x, y) => [1, 0, 0, 1, x, y];
const S = (x, y) => [x, 0, 0, y, 0, 0];

/** Every image path a pack/char.json references. */
export function imagePaths(pack) {
  const want = new Set();
  const f = pack.face;
  for (const p of Object.values(pack.poses || {})) { want.add(p.image); if (p.tween) want.add(p.tween.image); }
  for (const c of Object.values(pack.cycles || {})) for (const fr of c.frames) want.add(fr.image);
  const ex = f ? Object.values(f.expressions || {}) : [];
  if (f) for (const t of [f.cover, f.blink, f.eyesBase, f.hairLock, f.visor, f.marks, ...ex, ...ex.flatMap((e) => [e.blink, e.brows, ...Object.values(e.gaze || {})]), ...Object.values(f.gaze || {})]) if (t && t.image) want.add(t.image);
  if (f && f.states) for (const set of Object.values(f.states)) for (const t of Object.values(set)) want.add(t.image);
  if (f) for (const set of Object.values(f.mouths || {})) for (const m of Object.values(set)) want.add(m.image);
  want.delete(undefined);
  return [...want];
}

/** Unpacked character folder: url = .../char.json (or a legacy pack.json). For .char files use loadChar (char.js). */
export async function loadPack(url) {
  const base = new URL('.', url).href;
  const pack = await (await fetch(url)).json();
  const img = (p) => new Promise((ok, err) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => err(new Error('missing ' + p)); i.src = base + p; });
  const images = {};
  await Promise.all(imagePaths(pack).map(async (p) => (images[p] = await img(p))));
  return new Puppet(pack, images);
}

export class Puppet {
  constructor(pack, images) { this.pack = pack; this.images = images; this.root = pack.root; }
  has(pose) { return pose in this.pack.poses; }
  /** what this character can do: talkable/silent poses, expressions, cycles, mouth shapes */
  info() {
    const P = this.pack, F = P.face || {};
    const poses = Object.entries(P.poses || {});
    return {
      id: P.id, name: P.name,
      talkable: poses.filter(([, p]) => p.talkable).map(([k]) => k),
      silent: poses.filter(([, p]) => !p.talkable).map(([k]) => k),
      expressions: [...new Set(['neutral', ...Object.keys(F.expressions || {}), ...Object.keys(F.states || {})])],
      cycles: Object.keys(P.cycles || {}),
      visemes: Object.keys((F.mouths || {}).neutral || {}),
    };
  }

  /** state: { pose, cycle:{id,frame}?, expr, mouth, open, eyes, squash } ; place: { x, y, scale, flip } */
  draw(ctx, st, { x = 0, y = 0, scale = 1, flip = false } = {}) {
    const P = this.pack, [rx, ry] = this.root;
    const sq = st.squash || 0, br = st.breathe || 0;
    let view = mul(T(x, y), mul(S((flip ? -scale : scale) * (1 + sq * 0.5), scale * (1 - sq + br)), T(-rx, -ry)));
    ctx.save();
    if (st.cycle) {
      const fr = P.cycles[st.cycle.id].frames[st.cycle.frame % P.cycles[st.cycle.id].frames.length];
      ctx.setTransform(...view);
      ctx.drawImage(this.images[fr.image], fr.at[0], fr.at[1], fr.size[0], fr.size[1]);
      ctx.restore();
      return;
    }
    let pose = P.poses[st.pose] || P.poses.idle || P.poses.master;
    if (st.tweenOf && P.poses[st.tweenOf]?.tween) pose = P.poses[st.tweenOf].tween;
    ctx.setTransform(...view);
    ctx.drawImage(this.images[pose.image], 0, 0);
    if (pose.talkable && P.face) {
      const [[a, c, e], [b, d, f]] = pose.head;
      const m = mul(view, [a, b, c, d, e, f]);
      ctx.setTransform(...m);
      const F = P.face, put = (t) => t?.image && ctx.drawImage(this.images[t.image], t.at[0], t.at[1]);
      if (F.states) { this.#drawStates(ctx, st, flip); ctx.restore(); return; } // v4: one image per visible state
      put(F.cover);
      if (F.eyesBase) put(F.eyesBase); // master eyes: a pose's own redrawn eyes never show
      const ex = st.expr && F.expressions[st.expr];
      if (st.eyes === 'closed') { // closed eyes look the same in any mood: neutral lids + this expression's brows
        if (ex?.blink) put(ex.blink); else { put(F.blink); if (ex?.brows) put(ex.brows); }
      } else {
        if (ex) put(ex);
        // gaze: screen direction -> rig direction (a mirrored puppet looking screen-left looks rig-right)
        if (st.gaze && st.gaze !== 'camera' && !globalThis.GAZE_OFF) {
          let g = st.gaze;
          if (flip) g = g.replace(/left|right/, (m) => (m === 'left' ? 'right' : 'left'));
          const G = (ex ? ex.gaze : F.gaze) || F.gaze || {};
          const tileG = G[g] || G[g.split('-').pop()] || (g.startsWith('down') ? G.down : null);
          if (tileG) put(tileG);
        }
      }
      if (F.hairLock) put(F.hairLock); // opt-in locked side hair
      if (F.visor) put(F.visor); // locked eye mask / glasses frame: openings never move
      if (F.marks) put(F.marks); // locked identity marks (bindi, face paint)
      const set = F.mouths[ex?.mouths || st.expr] || F.mouths.neutral;
      const v = set[st.mouth] || set.X;
      const live = st.mouth === 'X' || st.mouth === 'A' ? 1 : 1 + 0.1 * Math.max(-0.5, Math.min(0.6, (st.open || 0) - 0.4));
      ctx.drawImage(this.images[v.image], v.at[0], v.at[1], v.size[0], v.size[1] * live);
    }
    ctx.restore();
  }

  /** states face: eye state for this frame: closed while blinking, else the gaze direction, camera by default */
  eyeState(st, flip = false) {
    if (st.eyes === 'closed') return 'closed';
    let g = st.gaze;
    if (!g || g === 'camera' || globalThis.GAZE_OFF) return 'camera';
    if (g.startsWith('down')) return 'down';
    // screen direction -> rig direction (a mirrored puppet looking screen-left looks rig-right)
    if (flip) g = g === 'left' ? 'right' : g === 'right' ? 'left' : g;
    return g === 'left' || g === 'right' ? g : 'camera';
  }

  /** v4 face, already in head space: cover -> states[expr][eye] -> visor/marks -> library mouth. Nothing else. */
  #drawStates(ctx, st, flip) {
    const F = this.pack.face, put = (t) => t?.image && ctx.drawImage(this.images[t.image], t.at[0], t.at[1]);
    put(F.cover);
    const set = F.states[st.expr] || F.states.neutral;
    const tile = set[this.eyeState(st, flip)] || set.camera;
    if (tile) put(tile);
    if (F.visor) put(F.visor);
    if (F.marks) put(F.marks);
    const ms = F.mouths[F.expressions?.[st.expr]?.mouths || st.expr] || F.mouths.neutral;
    const v = ms[st.mouth] || ms.X;
    const live = st.mouth === 'X' || st.mouth === 'A' ? 1 : 1 + 0.1 * Math.max(-0.5, Math.min(0.6, (st.open || 0) - 0.4));
    ctx.drawImage(this.images[v.image], v.at[0], v.at[1], v.size[0], v.size[1] * live);
  }
}
