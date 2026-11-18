#!/usr/bin/env node
/**
 * Draw the 8 speaking mouth shapes for one character, in that character's own art style (step 2 of tools/drawn_mouths.py).
 * Each is an edit of <work>/crop.png (the approved master's head). The rest shape X is the master itself.
 *
 *   node tools/gen-mouths.mjs <work> [--only D,F] [--force] [--style "painterly cel-shaded caricature"] [--note "..."]
 *   --note  extra instruction appended to every prompt (e.g. what the judge asked for)
 * Key: OPENAI_API_KEY (env or repo .env). Model: CHAR_IMAGE_MODEL (default gpt-image-1).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const work = path.resolve(process.argv[2] || (console.error('usage: gen-mouths.mjs <work> [--only D,F] [--force]'), process.exit(1)));
const only = arg('--only')?.split(','), force = process.argv.includes('--force');
const MODEL = arg('--model', process.env.CHAR_IMAGE_MODEL || 'gpt-image-1');
const STYLE = arg('--style', 'the exact art style and rendering of the supplied image');
const NOTE = arg('--note', '');
const key = process.env.OPENAI_API_KEY || (() => {
  const env = path.join(here, '..', '.env');
  const m = fs.existsSync(env) && fs.readFileSync(env, 'utf8').match(/^OPENAI_API_KEY=(\S+)/m);
  if (!m) { console.error('OPENAI_API_KEY not set (env or .env in the repo root)'); process.exit(1); }
  return m[1];
})();

// Preston-Blair shapes, described the way an animator would brief an artist
export const SHAPES = {
  A: 'lips pressed gently together, fully CLOSED and relaxed (the "M / B / P" sound). Neutral: the mouth corners are level, not lifted into a smile',
  B: 'lips parted only slightly, upper and lower teeth nearly together and just visible between the lips (the "EE / S / T" sound). About as wide as the original mouth; a talking shape, NOT a grin',
  C: 'mouth open a SMALL-to-MEDIUM amount (the "EH" sound as in "bed"): lips parted by about one lip-height, the lower edge of the upper teeth just visible, a little dark interior. Mouth corners level, not smiling',
  D: 'mouth OPEN for the "AH" sound as in "father", said in a calm voice: an open oval about two lip-heights tall and no wider than the original mouth. Ordinary speech, NOT a shout, laugh, smile or yawn: the mouth corners stay level and relaxed. The upper teeth are mostly hidden by the upper lip (softly shaded), only a little of the tongue shows low in the mouth, soft dark interior with gentle depth. The lower lip stays ABOVE any hair under the lip',
  E: 'lips gently ROUNDED (the "OH" sound as in "go"): the mouth corners move inward so the mouth is about two thirds as wide as the original, with a soft rounded opening and NO teeth visible. The lips keep their original thickness: not plumped, not glossy',
  F: 'the "OO / W" sound as in "you": lips PURSED and pushed slightly forward, the corners pulled well inward so the mouth is less than half as wide as the original. The opening is only a tiny dark dot; NO teeth and no tongue visible. Clearly different from an open "O". Relaxed, not a kiss: no gloss, no inflated lips; the lips keep their original thickness',
  G: 'the "F / V" sound: the LOWER LIP is tucked up and in under the upper front teeth. Only the bottom edge of the upper incisors is visible, pressing into the lower lip with a small soft contact shadow. NO lower teeth, no dark gap, no open interior. The mouth is narrow and relaxed: not a grin, not a grimace, not clenched teeth',
  H: 'the "L" sound: mouth open a small amount. Behind the upper front teeth sits the tongue: a soft, ROUNDED tongue tip raised and pressed against the back of the upper teeth, softly shaded and low in contrast, filling the space just under the upper teeth. Not a pointed wedge, not a mound on the floor of the mouth. Mouth corners level, not smiling',
};
const prompt = (desc) => `Edit the supplied portrait. Change ONLY THE MOUTH to this speaking shape: ${desc}.
This is one animation frame of the same person talking, so everything except the mouth must stay identical to the supplied image: same head size, angle and position, same eyes, eyebrows, glasses, nose, cheeks, skin tone, lighting, hair and clothing. Do not change the expression in the eyes.
Facial hair: any moustache and beard stay exactly as drawn, every hair in place; the moustache stays above the upper lip and is never erased, thinned or covered; any hair under the lower lip (soul patch, chin hair) stays visible with the same density; the beard outline and the head silhouette do not move (the jaw drops only inside the face).
Calm classroom speech: restrained shapes, never exaggerated. The lips keep the original mouth's thickness, colour and asymmetry; the shape changes by moving the lips, not by redrawing different lips.
Draw the mouth in ${STYLE}: natural adult teeth as a simple clean row, slightly shaded (not bright white, no outlines around single teeth), natural tongue, soft dark mouth interior. It must look like this person's own mouth, anatomically joined to the face, not a sticker.
${NOTE}
Transparent background stays transparent. No text.`;

async function edit(v) {
  const out = path.join(work, `viseme-${v}.png`);
  if (fs.existsSync(out) && !force) return console.log(`skip viseme-${v}.png (exists; --force to redo)`);
  const src = path.join(work, 'crop.png');
  for (let attempt = 1; attempt <= 5; attempt++) {
    const form = new FormData();
    form.append('model', MODEL); form.append('prompt', prompt(SHAPES[v])); form.append('size', '1024x1024');
    form.append('quality', 'high'); form.append('background', 'transparent'); form.append('output_format', 'png');
    form.append('image[]', new Blob([fs.readFileSync(src)], { type: 'image/png' }), 'crop.png');
    const res = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: e.message }) }));
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.data?.[0]?.b64_json) {
      fs.writeFileSync(out, Buffer.from(j.data[0].b64_json, 'base64'));
      fs.writeFileSync(out.replace(/\.png$/, '.prompt.txt'), `model: ${MODEL}\n\n${prompt(SHAPES[v])}\n`);
      return console.log(`ok   viseme-${v}.png`);
    }
    const retry = res.status === 429 || res.status >= 500 || res.status === 0;
    console.warn(`${retry ? 'retry' : 'fail'} viseme-${v} ${res.status} ${JSON.stringify(j.error || j).slice(0, 200)}`);
    if (!retry) return;
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
}
const list = Object.keys(SHAPES).filter((v) => !only || only.includes(v));
const q = [...list];
await Promise.all(Array.from({ length: 4 }, async () => { while (q.length) await edit(q.shift()); }));
console.log(`done. Next: python3 tools/drawn_mouths.py apply ${work} <char_folder> --sheet qa.png`);
