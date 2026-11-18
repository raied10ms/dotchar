---
name: char-rig
description: Create, rig, QA and use lip-synced 2D characters as portable .char files (dotchar repo). Use when someone wants a new talking character from a photo/drawing/images, wants an existing character (Bhasha, Fardin, Rifat, …) to say a line in a video, slide or web page, needs a lip-sync track for audio, or wants a multi-character scene rendered.
---

# char-rig: lip-synced characters as `.char` files

You are working in the **dotchar** repo (github.com/raied10ms/dotchar). If you're not inside it, find it first: look for a folder with `SPEC.md` and `characters/*.char`. If there isn't one, clone the repo and run `npm install && npm run setup`.

Read before your first character: `docs/METHOD.md` (how the rig works and the image rules) and `SPEC.md` (the format).

## 0. Preflight (every time)

```sh
node -v            # >= 18
ffmpeg -version    # needed for lipsync + render
ls tools/rhubarb/  # missing -> npm run setup
ls node_modules/playwright-core || npm install
```
Keys come from env or the repo's `.env`:
- `DEEPGRAM_API_KEY` or `OPENAI_API_KEY`: speech-to-text. Better mouth shapes.
- `OPENAI_API_KEY`: image generation and the GPT judge. Models: `CHAR_IMAGE_MODEL`, `CHAR_JUDGE_MODEL`.

Never print the keys. Never commit `.env`.

## 1. Decide the job

| Request | Go to |
|---|---|
| "make X say this", video/reel/slide with an existing character | §2 |
| "make a character from this photo/drawing" | §3 |
| "I have images already" / a `build.json` folder | §3 step D |
| conversation between several characters | §2 scene |

Run `npm run char -- list` to see the library. Run `npm run char -- validate characters/<id>.char` to see that character's talkable poses, silent poses, expressions and cycles. **Only use pose and expression ids that exist.**

## 2. Use a character

1. **Audio.** Use the user's file, or make TTS. If `meta.voice` is set in the char, use that ElevenLabs voice id.
2. **Lip-sync:** `npm run char -- lipsync line.mp3 --stt deepgram`, which writes `line.lipsync.json`. Bangla: add `--lang bn --stt openai`. With no key, skip `--stt` (acoustic only; tell the user it's lower quality).
3. **Output**
   - Video:
     ```
     npm run char -- render --char characters/<id>.char --audio line.mp3 --pose <talkable pose> --expr <mood> --fit bust|face|body --size 1080x1920 -o out.mp4
     ```
     - Transparent overlay: `--bg transparent -o out.webm` (or `.mov`).
     - Background image: `--bg bg.png`.
     - Gestures over time: `--cues cues.json`, e.g. `[{"at":1.2,"pose":"point","dur":1.5},{"at":2,"expr":"surprised"}]`.
   - Claude artifact / single file: Studio → Library → **Copy code for artifact** or **Download .html**. That file embeds a slimmed character, a player and a lip-sync guide. To build on it, keep its `CHAR_DATA` and `PLAYER` script blocks unchanged and write the page around them. Lip-sync inside it, best first:
     - `await who.playAudio(url)`: any voice audio; the mouth follows the sound live, no track needed.
     - `await who.play(track, url)`: a `*.lipsync.json` track from `char lipsync`.
     - `await who.say(text)`: the browser's voice; approximate, and silent in some sandboxes (the mouth still moves).

     Chain lines with `await` (each call resolves when the line ends), start from a user click, and never time lines with your own `setTimeout` guesses or call `speechSynthesis` separately.
   - Web page or slide: `<char-player src=… audio=… track=… pose=… expression=… fit=…>` (see `examples/slide/slide.html`). The page must be served over http (`npm run studio` serves the repo), not opened as `file://`.
   - Scene: copy `examples/scene/scene.json`. In it:
     - `cast`: char path, x/y, `height` in px, `face` L/R
     - `lines`: audio + track
     - `timeline`: `say`; anchor `pose` and `expression` to a line with `{on: lineId}`; `walk: {to}`; `camera: {follow, zoom}`

     Then render with `npm run char -- render --scene scene.json -o out.mp4`.
4. **Check before handing over.** Pull 6–8 frames into a contact sheet and look at them:
   ```
   ffmpeg -i out.mp4 -vf "select='not(mod(n,10))',scale=240:-1,tile=6x2" -frames:v 1 sheet.jpg
   ```
   Check that the mouth is moving, sits on the lips and the pose is right.

Before handing over any character, run `npm run char -- sheet characters/<id>.char` and look at every expression, blink and mouth.

Framing rule: important dialogue goes in `bust` or `face`. In a wide full-body shot only open/closed reads.

## 3. Create a new character

**Fast path: photos of a real person → finished `.char`, no measuring.** Use this unless the user wants control over each step.
1. Make `work/<id>/`, put the photos in `work/<id>/ref/`, and write `work/<id>/character.json`:
   `{"name": "...", "refs": ["ref/1.jpg", ...], "likeness": {"outfit": "..."}, "style": "glossy painterly cel-shaded caricature with crisp clean line work", "lipsSet": "female|male", "poses": "quick|full", "mouths": "drawn"}`
2. `node cli/auto.mjs master work/<id>` (1 image call). Show `work/<id>/master.png` to the user and **wait for their approval**. To redo, put the correction in `"identity"` and run it again.
3. `node cli/auto.mjs rest work/<id>` (about 27 calls for 5 poses, 32 for 10; 5–10 minutes). It draws the eyes, expressions, blinks and poses, finds the mouth and eyes, rigs, builds the eye patches, draws the mouths, packs and runs the judge.
4. Look at `work/<id>/locate-check.png` (orange box on the lips, blue box on eyes and brows), `work/<id>/qa-eyes.png` (every expression and blink) and `work/<id>/qa.png` (every mouth). If a box is off, fix `build.json` and continue from step D below. If a mouth shape is bad, re-roll it as in D2.
5. Result: `work/<id>/<id>.char`. `status.json` lists silent poses and the judge scores. Then go to E and F.

The same flow is the Studio's Create tab (*New character from photos*).

**Step by step (full control):**

Work in a new folder outside `characters/`, e.g. `work/<id>/`.

**A. Brief.** Write `work/<id>/character.json`:
- `name`
- `refs` (paths to the reference images)
- `identity`: one dense paragraph covering age, face, hair, skin, outfit and colours
- `style` (default cartoon style if not given)
- `likeness: {"outfit": "…"}` if the character is a **real person**

Ask the user which lip set to use (`female` or `male`) only if it isn't obvious.

**B. Master (1 image call).**
```
node tools/gen-images.mjs work/<id> --stage master
```
Check `master.png` against `docs/METHOD.md`:
- front-facing,
- lips closed,
- mouth about ⅓ of the face width,
- nothing over the mouth,
- transparent background.

**Show it to the user and get approval before going on.** For real people, the person themselves approves it. After approval **never regenerate the face**: likeness drifts with every regeneration. Fix by hand instead.

**C. Everything else (about 20 calls).**
```
node tools/gen-images.mjs work/<id> --stage face     # mouthless, eyes-closed, 6 expressions
node tools/gen-images.mjs work/<id> --stage blinks   # each expression with its eyes closed
node tools/gen-images.mjs work/<id> --stage poses    # 10 default poses (+ --add <id> "<description>")
node tools/gen-images.mjs work/<id> --stage cycles   # optional walk/run sheets
```
Look at every output. Redo a bad one with `--only <name> --force`. These count as bad:
- the head moved or turned in a pose,
- a hand is on the face,
- an expression changed the mouth or hair a lot, or changed, thinned or dropped the glasses,
- the background isn't transparent.

**D. Rig.** Write `work/<id>/build.json` (format in `SPEC.md`). The values you have to find:
- `mouth.anchor`: the centre of the closed lips, in master pixels.
- `mouth.width`: the drawn mouth width in px. If unsure, use 0.34 × the face width at mouth level.
- `eyes.box`: one box around both eyes **and** brows, clear of the nose and hair if possible.

To measure them, view `master.png`. To check a guess, draw it on a copy:
```
python3 -c "from PIL import Image,ImageDraw as D;im=Image.open('work/<id>/master.png').convert('RGBA');d=D.Draw(im);x,y=496,302;d.line([x-30,y,x+30,y],fill='red',width=2);d.rectangle([380,139,623,245],outline='blue',width=2);im.crop((x-260,y-300,x+260,y+160)).save('/tmp/check.png')"
```
Iterate until the red line sits exactly on the lips and the blue box covers the eyes and brows. List poses by file (`"wave": "pose-wave.png"`); auto-align handles the head offsets. Then build:
```
npm run char -- build work/<id> --sheet work/<id>/qa.png
```
- Every pose with head match < 0.86 becomes silent automatically. That is fine for crying, jumping and similar. For a pose that must talk, fix it with `"head": [dx, dy, scale]` or regenerate the pose.
- Look at `qa.png`. Every mood × viseme should look natural:
  - mouth size is right,
  - lip colour is right,
  - the cover patch is invisible,
  - the jaw stays above the chin.

  Adjust `mouth.width`, `mouth.cover` or `lipColour` (hex), or supply a better `mouthless`, then rebuild.

**D1. Eyes: one patch per expression (always).** On the unpacked character (`npm run char -- unpack <id>.char work/<id>/char`):
```
python3 tools/eye_states.py work/<id>/char --master work/<id>/master.png --dir work/<id> --sheet work/<id>/qa-eyes.png
```
Look at the sheet. Each state must have one set of eyebrows, both eyes must change together, and the glasses must be identical everywhere. If the eye openings were detected wrongly, pass `--eyes x0,y0,x1,y1`. If a drawing changed the glasses, re-roll that drawing; never ship double eyebrows.

**D2. Choose the mouth type by art style. Decide this before step E.**
- Flat cel-shaded cartoon → keep the library mouths from step D.
- Painterly or realistic face, caricature of a real person, or any beard or moustache → **drawn mouths**. Library mouths look pasted on these faces; resizing them or layering the moustache does not fix it.

Drawn mouths (8 image calls; work on the **unpacked** character: `npm run char -- unpack <id>.char work/<id>/char`):
```
python3 tools/drawn_mouths.py prep work/<id>/mouths --master work/<id>/master.png --lips x0,y0,x1,y1
node tools/gen-mouths.mjs work/<id>/mouths --style "the same <painterly/…> style as the supplied image"
python3 tools/drawn_mouths.py apply work/<id>/mouths work/<id>/char --sheet work/<id>/mouths-qa.png
node tools/judge.mjs --guide work/<id>/mouths/crop.png --render work/<id>/mouths-qa.png
npm run char -- pack work/<id>/char -o work/<id>/<id>.char
```
- `--lips` is the box of the drawn lips on the master. Use the master the character was built from, the same file as `poses/master`.
- Look at the sheet yourself, then read the judge's fixes. Re-roll single shapes with `--only D,G --force` (add `--note "…"` for a specific correction) and run `apply` again. Never accept a shape that:
  - erases or thins facial hair,
  - looks like shouting, a grin or a kiss,
  - moves the jaw line.
- The judge is harsh on purpose and rarely returns PASS. Stop when likeness ≥ 8, rest_pose is 10, facial hair is intact and no shape looks wrong at playback size. Two or three rounds is normal. Report the final scores to the user.
- Then judge real speech too. Render a line at `--fit face`, make a frame sheet, and pass it as a second `--render`.

People who prefer clicking can do step D in the Studio: `npm run studio` → Create. It saves the same `build.json`.

**E. Test.** Render one real line at `--fit face` and one at `--fit body` with a pose change (§2). Contact-sheet them and show the user.

**F. Publish.**
1. Copy `<id>.char` into `characters/`.
2. Run `npm run char -- list`, which refreshes `index.json` and `thumbs/`.
3. Commit the `.char`, `index.json` and `thumbs/<id>.webp`.
4. Put the source folder (images + `build.json`) under `sources/<id>/` only if the user wants it versioned. It's large.
5. Open a pull request unless the user says to push directly.

## Rules

- Mouth type follows art style (step D2). Painterly, realistic or bearded faces get drawn mouths; never ship a flat library mouth on them.
- Identity lives in ONE approved image. Every other image is an **edit of the master** on the same canvas. Never redraw the character from scratch.
- Never use a pose or expression id that `validate` doesn't list. Silent poses have no lip-sync, so never put dialogue on them.
- One character = one id forever. If the art changes, bump `version` in build.json and rebuild. Don't rename.
- Real people: consent first, approval of the master by them, no face regeneration after approval.
- Don't open images or videos on the user's screen. Give paths, and show contact sheets inline.
- Report honestly: how many image calls were used, which poses ended up silent, and what still looks off.
