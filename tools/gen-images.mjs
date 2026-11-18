#!/usr/bin/env node
/**
 * Generate the image set for a new character with an OpenAI image model, then load the files into the studio
 * (Create tab) to rig and export the .char. Identity lives in ONE image (master); everything else is an edit of it.
 *
 *   node tools/gen-images.mjs <dir> --stage master     # ref photo/drawing(s) -> front-facing full-body master.png
 *   node tools/gen-images.mjs <dir> --stage face       # mouthless.png, eyes-closed.png, expr-<mood>.png (6 moods)
 *   node tools/gen-images.mjs <dir> --stage blinks     # blink-<mood>.png: each expression with the eyes closed (after face)
 *   node tools/gen-images.mjs <dir> --stage poses      # pose-<id>.png (10 defaults + yours), head locked
 *   node tools/gen-images.mjs <dir> --stage cycles     # cycle-walk.png, cycle-run.png (4-frame side-view sheets)
 *   node tools/gen-images.mjs <dir> --stage poses --add hold-book "holding a red book against the chest with both hands"
 *   flags: --force (redo existing files) · --only a,b (ids) · --model <id> (or CHAR_IMAGE_MODEL)
 *
 * <dir>/character.json:
 *   { "name": "Tuhin", "refs": ["ref/photo1.jpg"], "refNote": "the boy in the blue shirt",
 *     "identity": "Tuhin, 10, ...outfit, hair, colours", "style": "clean 2D cartoon, bold outlines, flat cel shading",
 *     "likeness": { "outfit": "..." },   // real people (teachers): sends every ref photo, keeps beard/glasses
 *     "poses": { "hold-book": "..." } }
 * Key: OPENAI_API_KEY (env or the repo's .env). About 20 image calls per character. Check every image before using it:
 * Approve the master first; NEVER regenerate the face after approval (likeness drifts). Fix by hand instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes(k);
const dir = path.resolve(process.argv[2] || die('usage: gen-images.mjs <dir> --stage master|face|blinks|poses|cycles'));
const stage = arg('--stage', 'master'), force = flag('--force'), only = arg('--only')?.split(',');
const MODEL = arg('--model', process.env.CHAR_IMAGE_MODEL || 'gpt-image-1');
function die(m) { console.error(m); process.exit(1); }
const cfgPath = path.join(dir, 'character.json');
if (!fs.existsSync(cfgPath)) die(`${cfgPath} missing (see the header of this file)`);
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const out = (f) => path.join(dir, f);
const master = out('master.png');

const key = (() => {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const env = path.join(here, '..', '.env');
  const m = fs.existsSync(env) && fs.readFileSync(env, 'utf8').match(/^OPENAI_API_KEY=(\S+)/m);
  return m ? m[1] : die('OPENAI_API_KEY not set (env or .env in the repo root)');
})();

// ---------------------------------------------------------------- prompts (the rules that make lip-sync work)
const STYLE = cfg.style || 'clean 2D cartoon, bold consistent outlines, flat cel shading with one soft shadow tone';
const IDENTITY = cfg.identity ? `Character identity: ${cfg.identity}` : '';
const FACE_RULES = 'Face (needed for lip-sync): front-on, symmetrical, open readable face; mouth roughly one third of the face width; at least one mouth-width of clear chin skin below the mouth; small simple nose well above the mouth; nothing covering or touching the mouth (no hand, hair, scarf or mask over it).';
const HEAD_LOCK = 'The HEAD stays EXACTLY as in the supplied image: same face, expression, hair, size, angle and position on the canvas, facing the viewer. Do not move, tilt, turn or redraw the head. Hands and arms never cover or touch the face.';
const TAIL = `${IDENTITY}\nNo motion lines, speed lines, sweat drops or other effects.\nSame drawing style, outline, colours and proportions. Same canvas, character the same size and position. Genuinely transparent background, no ground shadow, no text, no props unless stated.`;
const KEEP = 'Keep everything else EXACTLY unchanged: same pixels, position, size, hair, outfit, colours. Transparent background stays transparent.';
export const POSES = {
  idle: 'standing relaxed and natural, weight slightly on one leg, both arms hanging loosely at the sides',
  point: "pointing with the arm on the viewer's RIGHT extended out to the side at shoulder height, index finger extended, the other arm relaxed",
  wave: "waving hello: the hand on the viewer's RIGHT raised beside the head (not in front of the face), palm open toward the viewer",
  explain: 'explaining: both forearms raised forward at waist height, palms open and up, friendly talking gesture',
  happy: 'happy cheer: both fists raised at shoulder height in excitement, body bouncy and upright',
  sad: 'sad: shoulders slumped forward, arms hanging limp in front, hands loosely together (head unchanged)',
  surprised: 'surprised: both hands raised open at chest height, palms out, fingers spread, leaning back slightly; hands stay below the chin',
  shrug: 'shrugging: both shoulders raised, forearms out to the sides with palms up, elbows bent',
  'hands-hips': 'confident: both hands on the hips, elbows out',
  'thumbs-up': "thumbs up with the hand on the viewer's RIGHT at chest height, the other arm relaxed",
};
const MOODS = {
  happy: 'HAPPY: eyebrows raised and softly arched, eyes bright and friendly, eyes stay fully OPEN; no lines or creases under the eyes',
  sad: 'SAD: inner ends of the eyebrows raised and pinched together, upper lids slightly lowered, eyes looking a little down',
  surprised: 'SURPRISED: eyebrows raised HIGH and round, eyes opened WIDE with more white showing around small pupils',
  angry: 'ANGRY: eyebrows pulled DOWN and together into a sharp V, upper lids lowered into a glare',
  worried: 'WORRIED: eyebrows raised in the middle and wavy, eyes wide, anxious',
  excited: 'EXCITED: eyes opened WIDE and sparkling with big highlights, eyebrows raised HIGH and arched, thrilled',
};
const eyesOnly = (what) => `Edit the supplied character image: change ONLY the EYEBROWS and the EYES (eyelids, eye shape) to: ${what}. Same iris colour, lashes and art style. If the character wears glasses they stay EXACTLY as drawn: same frames, same thickness and colour, same position, clear lenses. Never add glasses, masks or face paint that are not already there. Do NOT change the mouth, nose, hair or face shape. ${KEEP}`;

const refs = (cfg.refs || (cfg.ref ? [cfg.ref] : [])).map((r) => path.resolve(dir, r));
const jobs = [];
const want = (id) => !only || only.includes(id);
const job = (file, prompt, images, size = '1024x1536') => want(file.replace(/\.png$/, '')) && jobs.push(() => edit(out(file), prompt, images, size));

if (stage === 'master') {
  if (!refs.length) die('character.json needs "refs": [reference images]');
  const L = cfg.likeness === true ? {} : cfg.likeness;
  const prompt = L
    ? `Draw a full-body CARICATURE PORTRAIT of the real person in the supplied photos for a 2D animated series. It must be UNMISTAKABLY this person. Image 1 is the main face reference; the others are the same person from other angles: copy their exact face shape, hairline, eyes, nose, lips, skin tone, beard, moustache and glasses.
${IDENTITY}
${L.outfit ? `Outfit: ${L.outfit}` : 'Outfit: as in image 1.'}
Pose: full body, standing upright facing the viewer straight on, arms slightly away from the body, legs slightly apart, LIPS GENTLY CLOSED (no teeth), eyes open looking at the viewer.
Rig constraints: the lips and a narrow margin around them are bare skin (moustache above, beard below, never on the lips); glasses (if worn) have clear lenses larger than the eyes; no hair across the brows or eyes.
Style: ${STYLE}. One character, centred, whole body inside the frame with padding, feet ~60px above the bottom. Genuinely transparent background, no shadow, no text.`
    : `From the reference image, take ${cfg.refNote || 'the main character'} and redraw them as the MASTER model sheet for a 2D animated series.
${IDENTITY}
Full body, facing the viewer straight on, standing upright, arms hanging slightly away from the body, legs slightly apart, neck visible. Neutral friendly expression, lips gently closed, eyes open looking at the viewer.
${FACE_RULES}
Preserve identity, face, skin tone, hair, outfit, colours and proportions from the reference. Style: ${STYLE}.
One character only, centred, whole body inside the frame with padding, feet ~60px above the bottom. Genuinely transparent background; no ground shadow, scenery or text.`;
  job('master.png', prompt, refs);
} else {
  if (!fs.existsSync(master)) die('master.png missing: run --stage master first (and approve it)');
  if (stage === 'face') {
    job('mouthless.png', `Edit the supplied character image: REMOVE THE MOUTH completely. Where the lips were, paint smooth continuous skin matching the surrounding cheek and chin colour and shading. Only the lips become skin: a moustache or beard stays exactly as drawn. ${KEEP}`, [master]);
    job('eyes-closed.png', `Edit the supplied character image: close BOTH EYES gently and calmly, a relaxed blink (not squeezed): each eye becomes one smooth downward-curved lid line with a few lashes. Change ONLY the eye openings; eyebrows and everything else stay. Glasses (if worn) stay EXACTLY as drawn: same frames, thickness, colour and position. ${KEEP}`, [master]);
    for (const [m, t] of Object.entries(MOODS)) job(`expr-${m}.png`, eyesOnly(t), [master]);
  } else if (stage === 'blinks') {
    // each expression's own blink: same brows, eyes closed (run after --stage face). Without these, a blink during an
    // expression would have to borrow the neutral lids.
    for (const m of Object.keys(MOODS)) if (fs.existsSync(out(`expr-${m}.png`)))
      job(`blink-${m}.png`, `Edit the supplied character image: close BOTH EYES gently and calmly, a relaxed blink (not squeezed): each eye becomes one smooth downward-curved lid line with a few lashes. Change ONLY the eye openings. The EYEBROWS stay exactly as they are now (same shape, height and angle: this is a blink of this exact expression). Glasses (if worn) stay EXACTLY as drawn: same frames, thickness, colour and position. ${KEEP}`, [out(`expr-${m}.png`)]);
  } else if (stage === 'poses') {
    const add = arg('--add');
    if (add) { cfg.poses = { ...(cfg.poses || {}), [add]: process.argv[process.argv.indexOf('--add') + 2] }; fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2)); }
    for (const [id, text] of Object.entries({ ...POSES, ...(cfg.poses || {}) })) if (!add || id === add)
      job(`pose-${id}.png`, `Edit the supplied character image. Change the BODY pose only: ${text}.\n${HEAD_LOCK}\n${TAIL}`, [master]);
  } else if (stage === 'cycles') {
    const C = { walk: 'a 4-frame WALK CYCLE in side view facing RIGHT: contact, down, passing, up; arms swinging opposite to the legs',
      run: 'a 4-frame RUN CYCLE in side view facing RIGHT: contact, push-off, flight (both feet off the ground), landing; arms pumping, body leaning forward' };
    for (const [id, t] of Object.entries(C)) job(`cycle-${id}.png`, `Using the supplied character as the exact design reference (same face, hair, outfit, colours, proportions, style), draw ${t}. 4 full-body frames side by side in ONE row, evenly spaced, same size, feet on the same baseline, clear gaps between frames.\n${IDENTITY}\nGenuinely transparent background, no ground, no shadow, no text, no frame borders or numbers.`, [master], '1536x1024');
  } else die(`unknown stage ${stage}`);
}

async function edit(file, prompt, images, size) {
  if (fs.existsSync(file) && !force) return console.log(`skip ${path.basename(file)} (exists; --force to redo)`);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const form = new FormData();
    form.append('model', MODEL); form.append('prompt', prompt); form.append('size', size);
    form.append('quality', 'high'); form.append('background', 'transparent'); form.append('output_format', 'png');
    for (const im of images) form.append('image[]', new Blob([fs.readFileSync(im)], { type: im.endsWith('.png') ? 'image/png' : im.endsWith('.webp') ? 'image/webp' : 'image/jpeg' }), path.basename(im));
    const res = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: e.message }) }));
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.data?.[0]?.b64_json) {
      fs.writeFileSync(file, Buffer.from(j.data[0].b64_json, 'base64'));
      fs.writeFileSync(file.replace(/\.png$/, '.prompt.txt'), `model: ${MODEL}\ninputs: ${images.map((i) => path.basename(i)).join(', ')}\n\n${prompt}\n`);
      return console.log(`ok   ${path.basename(file)}`);
    }
    const retry = res.status === 429 || res.status >= 500 || res.status === 0;
    console.warn(`${retry ? 'retry' : 'fail'} ${path.basename(file)} ${res.status} ${JSON.stringify(j.error || j).slice(0, 200)}`);
    if (!retry) return;
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
}

const q = [...jobs];
await Promise.all(Array.from({ length: 4 }, async () => { while (q.length) await q.shift()(); }));
console.log(`done: ${jobs.length} image job(s) in ${dir}. Next: open the studio (npm run studio) -> Create, and load these files.`);
