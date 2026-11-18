#!/usr/bin/env node
/**
 * Draw clean walk / run cycle sheets for a character: 4 key drawings of ONE step, in order, side view facing right.
 * A step from the other leg looks the same from the side, so these 4 loop into a full walk.
 *
 *   node tools/gen-cycles.mjs <work> [--only walk|run] [--force] [--note "the sari hides the legs: only the feet show"]
 *   reads <work>/master.png (+ character.json "identity" if present)  ->  <work>/cycle-walk.png, <work>/cycle-run.png
 * Then: python3 tools/cycle_fit.py <work> <char_folder> --sheet cycles-qa.png   (same size, feet on one ground line)
 * Key: OPENAI_API_KEY (env or repo .env). Model: CHAR_IMAGE_MODEL.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const work = path.resolve(process.argv[2] || (console.error('usage: gen-cycles.mjs <work> [--only walk|run] [--force] [--note "..."]'), process.exit(1)));
const only = arg('--only'), force = process.argv.includes('--force'), NOTE = arg('--note', '');
const MODEL = arg('--model', process.env.CHAR_IMAGE_MODEL || 'gpt-image-1');
const key = process.env.OPENAI_API_KEY || (() => {
  const env = path.join(here, '..', '.env');
  const m = fs.existsSync(env) && fs.readFileSync(env, 'utf8').match(/^OPENAI_API_KEY=(\S+)/m);
  if (!m) { console.error('OPENAI_API_KEY not set'); process.exit(1); }
  return m[1];
})();
const cfgFile = path.join(work, 'character.json');
const identity = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')).identity : '';

const FRAMES = {
  walk: `A WALK, one step, 4 drawings in this exact order from left to right:
1. CONTACT: the legs at their WIDEST. Front leg straight, its heel just touching the ground ahead; back leg straight behind, heel lifted, toes on the ground. Arms swung opposite to the legs (the arm on the back-leg side is forward).
2. DOWN: the front foot is now flat on the ground under a slightly bent knee and carries the weight; the back foot is peeling off the ground. The feet are about HALF as far apart as in drawing 1. Body at its lowest.
3. PASSING: the standing leg is straight and vertical under the body. The other leg is bent and its foot passes right beside the standing leg's knee: the two legs OVERLAP. Arms hang close to the sides. Body at its tallest.
4. UP: the body tips into the next step. The standing leg pushes off on its toes behind; the swinging leg reaches forward, foot off the ground, not landed yet. The legs are about HALF apart again, opening.
Calm, natural walk. Each drawing must be clearly different from its neighbours: wide, half, overlapping, half.`,
  run: `A RUN, one stride, 4 drawings in this exact order from left to right:
1. CONTACT: the front foot lands under the body, knee bent; the back leg is folded up behind with the heel near the hip. Body leaning forward.
2. PUSH-OFF: the standing leg is stretched out behind, pushing off its toes; the other knee drives forward and UP to hip height.
3. FLIGHT: BOTH feet off the ground. The legs are at their WIDEST split: front leg reaching forward, back leg trailing behind. The whole body is higher than in the other drawings.
4. LANDING: the front leg stretches down toward the ground, about to land, foot still just above it; the back heel is kicked up behind.
Arms bent at 90 degrees and pumping opposite to the legs in every drawing. Energetic but not exaggerated.`,
};
const prompt = (kind) => `Using the supplied character as the exact design reference, draw a ${kind.toUpperCase()} CYCLE model sheet for 2D animation.
${FRAMES[kind]}
Layout: the 4 full-body drawings side by side in ONE row, strict SIDE VIEW (profile), all facing RIGHT, evenly spaced with a clear empty gap between them; nothing overlaps or touches the image edge.
Consistency: the SAME character in all 4: same face, hair, outfit, colours, proportions and drawing style as the reference; same head size and same body height in every drawing. Every foot that is on the ground stands on ONE straight invisible ground line shared by all 4 drawings.
${identity ? `Character identity: ${identity}` : ''}
${NOTE}
Genuinely transparent background. No ground line, no shadow, no motion lines, no text, no numbers, no frame borders.`;

async function gen(kind) {
  const out = path.join(work, `cycle-${kind}.png`);
  if (fs.existsSync(out) && !force) return console.log(`skip cycle-${kind}.png (exists; --force to redo)`);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const form = new FormData();
    form.append('model', MODEL); form.append('prompt', prompt(kind)); form.append('size', '1536x1024');
    form.append('quality', 'high'); form.append('background', 'transparent'); form.append('output_format', 'png');
    form.append('image[]', new Blob([fs.readFileSync(path.join(work, 'master.png'))], { type: 'image/png' }), 'master.png');
    const res = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: e.message }) }));
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.data?.[0]?.b64_json) { fs.writeFileSync(out, Buffer.from(j.data[0].b64_json, 'base64')); fs.writeFileSync(out.replace(/\.png$/, '.prompt.txt'), `model: ${MODEL}\n\n${prompt(kind)}\n`); return console.log(`ok   cycle-${kind}.png`); }
    const retry = res.status === 429 || res.status >= 500 || res.status === 0;
    console.warn(`${retry ? 'retry' : 'fail'} cycle-${kind} ${res.status} ${JSON.stringify(j.error || j).slice(0, 200)}`);
    if (!retry) return;
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
}
await Promise.all(['walk', 'run'].filter((k) => !only || only === k).map(gen));
console.log(`done. Next: python3 tools/cycle_fit.py ${work} <char_folder> --sheet cycles-qa.png`);
