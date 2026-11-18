#!/usr/bin/env node
/**
 * GPT vision judge for a character's mouth / lip-sync quality. A second pair of eyes before a character ships:
 * it scores a QA sheet or a strip of rendered frames against the approved master and returns ranked, concrete fixes.
 *
 *   node tools/judge.mjs --guide master-head.png --render qa.png[,frames.jpg] [--note "context"] [--pass 8] [--out judge.json]
 *
 * --guide  the approved master (head crop is best)        --render  QA sheet(s): every mouth shape, or frames of real speech
 * Verdict = PASS when every score >= --pass (default 8). Key: OPENAI_API_KEY (env or repo .env). Model: CHAR_JUDGE_MODEL.
 * The judge is advice, not a gate you can skip looking through: read its fixes, and look at the sheet yourself too.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const guide = arg('--guide'), renders = (arg('--render') || '').split(',').filter(Boolean);
if (!guide || !renders.length) { console.error('usage: judge.mjs --guide master.png --render sheet.png[,more.png] [--note ..] [--pass 8] [--out r.json]'); process.exit(2); }
const MODEL = arg('--model', process.env.CHAR_JUDGE_MODEL || 'gpt-4o');
const PASS = +arg('--pass', 8);
const key = process.env.OPENAI_API_KEY || (() => {
  const env = path.join(here, '..', '.env');
  const m = fs.existsSync(env) && fs.readFileSync(env, 'utf8').match(/^OPENAI_API_KEY=(\S+)/m);
  if (!m) { console.error('OPENAI_API_KEY not set (env or .env in the repo root)'); process.exit(1); }
  return m[1];
})();

const RUBRIC = `Criteria (score each 0-10):
- likeness: every frame is unmistakably the same person as the GUIDE (face shape, skin, eyes, glasses, hair, beard). The mouth looks like THIS person's mouth.
- integration: the mouth is anatomically part of the face, in the same art style and lighting as the rest. No pasted-on sticker look, no flat cartoon mouth on a painted face, no visible patch edge, seam, halo, blur band or skin-tone step around the mouth.
- facial_hair: moustache and beard are intact in every frame: never erased, thinned, covered by the mouth or replaced by bare skin. (If the person has no facial hair, score 10.)
- rest_pose: with the mouth at rest (X, or silent frames) the face matches the GUIDE's own mouth and expression.
- shapes: the mouth shapes are distinct and readable as speech (closed lips, teeth, open, wide open, rounded, puckered) and sized plausibly for calm classroom speech; nothing looks like shouting, gaping or a frozen grin; teeth and tongue look natural.
- stability: across frames nothing except the mouth and the skin right around it moves or changes: no jumping jaw line, beard outline, nose, cheeks or skin tone between frames.
- overall_naturalness: a viewer who knows this person would accept this as them talking, not find it uncanny or distracting.`;

const img = (p) => { const ext = path.extname(p).slice(1).toLowerCase(); return { type: 'input_image', image_url: `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${fs.readFileSync(p).toString('base64')}`, detail: 'high' }; };
const content = [
  { type: 'input_text', text: `You are a senior 2D animation director reviewing lip-sync for a cartoon character of a real person. The GUIDE is the approved master drawing. The RENDER images are either a labelled sheet of every mouth shape (X rest, A M/B/P closed, B teeth, C open, D wide open, E round, F pucker, G F/V, H tongue) or consecutive frames of the character speaking. Be harsh, specific and practical; production-ready means nothing about the mouth distracts.

${RUBRIC}

${arg('--note') ? 'CONTEXT FROM THE BUILDER: ' + arg('--note') + '\n\n' : ''}Return STRICT JSON only:
{"scores":{"likeness":0-10,"integration":0-10,"facial_hair":0-10,"rest_pose":0-10,"shapes":0-10,"stability":0-10,"overall_naturalness":0-10},"fixes":[{"rank":1,"where":"<which shape or frame, which region>","problem":"<what is wrong, concretely>","fix":"<what to change>"}],"praise":["<what is right, keep>"]}
Give at most 6 fixes, most important first; an empty list if nothing needs fixing.` },
  { type: 'input_text', text: `GUIDE: ${path.basename(guide)}` }, img(guide),
  ...renders.flatMap((r, i) => [{ type: 'input_text', text: `RENDER ${i + 1}: ${path.basename(r)}` }, img(r)]),
];
const res = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: MODEL, input: [{ role: 'user', content }], text: { format: { type: 'json_object' } } }) });
if (!res.ok) { console.error('judge API error', res.status, (await res.text()).slice(0, 400)); process.exit(1); }
const j = await res.json();
const txt = j.output_text ?? j.output?.flatMap((o) => o.content || []).find((c) => c.type === 'output_text')?.text;
let out; try { out = JSON.parse(txt); } catch { console.error('judge returned non-JSON:', String(txt).slice(0, 400)); process.exit(1); }
out.min = Math.min(...Object.values(out.scores || { x: 0 }));
out.verdict = out.min >= PASS ? 'PASS' : 'FAIL';
out.meta = { model: MODEL, pass: PASS, guide: path.basename(guide), renders: renders.map((r) => path.basename(r)), at: new Date().toISOString() };
if (arg('--out')) fs.writeFileSync(arg('--out'), JSON.stringify(out, null, 1));
console.log(`${out.verdict} (min ${out.min}) ` + Object.entries(out.scores).map(([k, v]) => `${k} ${v}`).join(' · '));
for (const f of out.fixes || []) console.log(`  ${f.rank}. [${f.where}] ${f.problem} -> ${f.fix}`);
for (const p of out.praise || []) console.log(`  + ${p}`);
