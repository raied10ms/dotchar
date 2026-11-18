#!/usr/bin/env node
/**
 * Ask a vision model where the lips and the eyes are on a master image -> <work>/locate.json (pixel boxes).
 *   node tools/locate.mjs <work>          (reads <work>/master.png)
 * These are estimates; tools/auto_rig.py refines the eyes from the eyes-closed image and draws locate-check.png.
 * Key: OPENAI_API_KEY (env or repo .env). Model: CHAR_JUDGE_MODEL (default gpt-4o).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] || (console.error('usage: locate.mjs <work>'), process.exit(1)));
const MODEL = process.env.CHAR_JUDGE_MODEL || 'gpt-4o';
const key = process.env.OPENAI_API_KEY || (() => {
  const env = path.join(here, '..', '.env');
  const m = fs.existsSync(env) && fs.readFileSync(env, 'utf8').match(/^OPENAI_API_KEY=(\S+)/m);
  if (!m) { console.error('OPENAI_API_KEY not set'); process.exit(1); }
  return m[1];
})();
const buf = fs.readFileSync(path.join(work, 'master.png'));
const W = buf.readUInt32BE(16), H = buf.readUInt32BE(20); // PNG IHDR
const ask = async () => {
  const res = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, text: { format: { type: 'json_object' } }, input: [{ role: 'user', content: [
      { type: 'input_text', text: `This image is ${W} x ${H} pixels: a full-body cartoon character facing the viewer. Measure carefully and return STRICT JSON with pixel coordinates in THIS image (x from the left edge, y from the top edge):
{"lips":[x0,y0,x1,y1],"eyes":[x0,y0,x1,y1],"face":[x0,y0,x1,y1]}
- lips: the tight box around the lips only (both lips, corner to corner). Not the moustache, beard, chin or smile lines.
- eyes: ONE box around both eye openings (left edge of the left eye to right edge of the right eye, top lid to bottom lid). Not the eyebrows or glasses frames.
- face: the box around the face skin from the hairline (or head covering) to the chin, ear to ear.
Sanity: the head is in the top third of the image; the lips are below the nose and above the chin; the eyes box is wider than the lips box.` },
      { type: 'input_image', image_url: `data:image/png;base64,${buf.toString('base64')}`, detail: 'high' }] }] }) });
  if (!res.ok) throw new Error(`vision API ${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return JSON.parse(j.output_text ?? j.output.flatMap((o) => o.content || []).find((c) => c.type === 'output_text').text);
};
const ok = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[2] > b[0] && b[3] > b[1] && b[2] <= W + 2 && b[3] <= H + 2;
let out;
for (let i = 0; i < 3; i++) {
  out = await ask();
  if (ok(out.lips) && ok(out.eyes) && out.eyes[3] < out.lips[1] + 5) break;
  console.warn('implausible boxes, asking again', JSON.stringify(out));
  out = null;
}
if (!out) { console.error('could not locate the face features'); process.exit(1); }
fs.writeFileSync(path.join(work, 'locate.json'), JSON.stringify({ ...out, size: [W, H], model: MODEL }, null, 1));
console.log(`lips ${out.lips} eyes ${out.eyes}`);
