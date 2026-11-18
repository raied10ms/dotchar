/** Validate a char.json + its files (Node). Returns { errors, warnings, info }. Rules: SPEC.md. */
const VISEMES = ['X', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const isPt = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const isAffine = (m) => Array.isArray(m) && m.length === 2 && m.every((r) => Array.isArray(r) && r.length === 3 && r.every(Number.isFinite));

export function validate(c, has) {
  const E = [], W = [];
  const img = (t, where) => {
    if (!t || typeof t.image !== 'string') return E.push(`${where}: missing "image"`);
    if (!has(t.image)) E.push(`${where}: file not found ${t.image}`);
  };
  if (c.format !== 'dotchar') E.push('format must be "dotchar"');
  if (c.formatVersion !== 1) E.push('formatVersion must be 1');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(c.id || '')) E.push('id must be lowercase letters, digits, dashes');
  if (!c.name) E.push('name missing');
  if (!isPt(c.canvas)) E.push('canvas must be [w, h]');
  if (!isPt(c.root)) E.push('root must be [x, y] (feet centre in canvas px)');
  if (!(c.height > 0)) E.push('height must be the body height in canvas px');
  const poses = c.poses || {};
  if (!poses.master) E.push('poses.master is required');
  for (const [id, p] of Object.entries(poses)) {
    img(p, `poses.${id}`);
    if (p.talkable && !isAffine(p.head)) E.push(`poses.${id}: talkable pose needs head [[a,c,e],[b,d,f]]`);
    if (p.tween) { img(p.tween, `poses.${id}.tween`); if (p.tween.talkable && !isAffine(p.tween.head)) E.push(`poses.${id}.tween: head missing`); }
    if (p.talkable && p.match != null && p.match < 0.86) W.push(`poses.${id}: head match ${p.match} < 0.86, face may drift`);
  }
  for (const [id, cy] of Object.entries(c.cycles || {})) {
    if (!Array.isArray(cy.frames) || !cy.frames.length) { E.push(`cycles.${id}: frames missing`); continue; }
    cy.frames.forEach((f, i) => { img(f, `cycles.${id}[${i}]`); if (!isPt(f.at) || !isPt(f.size)) E.push(`cycles.${id}[${i}]: at/size missing`); });
    if (!['L', 'R'].includes(cy.facing)) W.push(`cycles.${id}: facing should be "R" or "L"`);
  }
  const F = c.face;
  const exprs = new Set(['neutral']);
  if (!F) W.push('no face: character cannot talk (body-only)');
  else {
    if (F.cover || F.mouthStyle !== 'drawn') img(F.cover, 'face.cover'); // drawn mouths carry their own skin: no cover
    if (!isPt(F.mouthAnchor)) E.push('face.mouthAnchor must be [x, y]');
    if (!F.mouths?.neutral) E.push('face.mouths.neutral is required');
    for (const [e, set] of Object.entries(F.mouths || {})) {
      exprs.add(e);
      for (const v of VISEMES) {
        const m = set[v];
        if (!m) { E.push(`face.mouths.${e}.${v} missing`); continue; }
        img(m, `face.mouths.${e}.${v}`);
        if (!isPt(m.at) || !isPt(m.size)) E.push(`face.mouths.${e}.${v}: at/size missing`);
      }
    }
    if (F.states) {
      for (const [e, set] of Object.entries(F.states)) {
        exprs.add(e);
        if (!set.camera) E.push(`face.states.${e}.camera missing`);
        for (const [k, t] of Object.entries(set)) img(t, `face.states.${e}.${k}`);
      }
      if (!F.states.neutral?.closed) W.push('face.states.neutral.closed missing: character never blinks');
    } else {
      if (!F.blink) W.push('face.blink missing: character never blinks');
      for (const k of ['blink', 'eyesBase', 'visor', 'marks', 'hairLock']) if (F[k]) img(F[k], `face.${k}`);
      for (const [e, x] of Object.entries(F.expressions || {})) {
        exprs.add(e);
        if (x.image) img(x, `face.expressions.${e}`);
        if (x.brows) img(x.brows, `face.expressions.${e}.brows`);
        if (x.blink) img(x.blink, `face.expressions.${e}.blink`);
      }
    }
    if (F.marks && F.states) img(F.marks, 'face.marks');
    if (F.overMouth) img(F.overMouth, 'face.overMouth');
  }
  if (c.thumbnail && !has(c.thumbnail)) W.push(`thumbnail not found: ${c.thumbnail}`);
  const P = Object.entries(poses);
  return {
    errors: E, warnings: W,
    info: {
      id: c.id, name: c.name, version: c.version, lips: c.meta?.lips,
      talkable: P.filter(([, p]) => p.talkable).map(([k]) => k), silent: P.filter(([, p]) => !p.talkable).map(([k]) => k),
      expressions: [...exprs], cycles: Object.keys(c.cycles || {}), faceFlavour: F ? (F.states ? 'states' : 'layers') : 'none',
    },
  };
}
