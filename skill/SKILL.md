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
- `OPENAI_API_KEY`: image generation.

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

Framing rule: important dialogue goes in `bust` or `face`. In a wide full-body shot only open/closed reads.

## 3. Create a new character

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
node tools/gen-images.mjs work/<id> --stage poses    # 10 default poses (+ --add <id> "<description>")
node tools/gen-images.mjs work/<id> --stage cycles   # optional walk/run sheets
```
Look at every output. Redo a bad one with `--only <name> --force`. These count as bad:
- the head moved or turned in a pose,
- a hand is on the face,
- an expression changed the mouth or hair a lot,
- the background isn't transparent.

**D. Rig.** Write `work/<id>/build.json` (format in `SPEC.md`). The values you have to find:
- `mouth.anchor`: the centre of the closed lips, in master pixels.
- `mouth.width`: the drawn mouth width in px. If unsure, use 0.34 × the face width at mouth level.
- `eyes.box`: one box around both eyes **and** brows, clear of the nose and hair if possible.

To measure them, view `master.png`. To check a guess, draw it on a copy:
```
python3 -c "from PIL import Image,ImageDraw as D;im=Image.open('work/<id>/master.png').convert('RGBA');d=D.Draw(im);x,y=496,302;d.line([x-30,y,x+30,y],fill='red',width=2);d.rectangle([380,139,623,245],outline='blue',width=2);im.crop((x-260,y-300,x+260,y+160)).save('/tmp/check.png')"
```
Iterate until the red line sits exactly on the lips and the blue box covers the eyes and brows. **Beard or moustache:** add `"facialHair": true` and `"lipsWidth": <drawn lip width>` to `mouth`, and set `width` to about 0.85 × lipsWidth. In the QA sheet the moustache must stay over every mouth, and the beard under the lip must not be painted over with skin. List poses by file (`"wave": "pose-wave.png"`); auto-align handles the head offsets. Then build:
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

People who prefer clicking can do step D in the Studio: `npm run studio` → Create. It saves the same `build.json`.

**E. Test.** Render one real line at `--fit face` and one at `--fit body` with a pose change (§2). Contact-sheet them and show the user.

**F. Publish.**
1. Copy `<id>.char` into `characters/`.
2. Run `npm run char -- list`, which refreshes `index.json` and `thumbs/`.
3. Commit the `.char`, `index.json` and `thumbs/<id>.webp`.
4. Put the source folder (images + `build.json`) under `sources/<id>/` only if the user wants it versioned. It's large.
5. Open a pull request unless the user says to push directly.

## Rules

- Identity lives in ONE approved image. Every other image is an **edit of the master** on the same canvas. Never redraw the character from scratch.
- Never use a pose or expression id that `validate` doesn't list. Silent poses have no lip-sync, so never put dialogue on them.
- One character = one id forever. If the art changes, bump `version` in build.json and rebuild. Don't rename.
- Real people: consent first, approval of the master by them, no face regeneration after approval.
- Don't open images or videos on the user's screen. Give paths, and show contact sheets inline.
- Report honestly: how many image calls were used, which poses ended up silent, and what still looks off.
