# The `.char` format, version 1

A `.char` file is one lip-sync-ready 2D character: body images, face layers, mouth shapes and the data that ties them together. Any page, slide, video renderer or game that includes `runtime/` can use it. It needs no rigging, no extra images and no AI calls.

## Container

A `.char` file is a **ZIP archive**. Rename it to `.zip` to look inside.

```
bhasha.char
├── char.json            required, at the root
├── thumb.webp           256×256 head-and-shoulders picture (optional)
├── poses/<id>.webp      one full-canvas image per body pose (+ tween-<id>.webp in-betweens)
├── cycles/<id>/<n>.webp walk / run frames
├── face/cover.*         skin patch that hides the mouth drawn on the body images
├── face/states/*.png    eye tiles, one per (expression × eye state)     (states face)
├── face/*.png           eyes-base / expression eyes / brows / blink      (layers face)
└── mouths/<mood>/<V>.*  9 visemes × 7 moods, already sized and coloured for this face
```

- Images may be WebP or PNG (alpha required). Body images are usually lossy WebP. Face and mouth layers are usually lossless, because they are composited on every frame.
- Paths inside `char.json` are relative to the archive root and use forward slashes.
- An **unpacked folder** with the same layout is also valid (`loadChar('folder/char.json')`). `npm run char -- pack folder` zips it and `unpack` reverses that.

## Coordinates

Every character has a **canvas**, e.g. 1024×1536. The master pose and every other pose fill that canvas. All face and mouth positions (`at` = top-left corner, in px) are in **master canvas space**.

- `root` = `[x, y]` is the point between the feet, where the character stands. Renderers place this point.
- `height` = body height in px (top of the hair to the soles). Scenes use it to make different characters the same size on screen.
- A pose's `head` is a 2×3 affine `[[a, c, e], [b, d, f]]` that maps master space to that pose's head position. The face layers are drawn through it, so one set of face layers works on every pose. The identity matrix means the head sits exactly where it does in the master.

## `char.json`

```jsonc
{
  "format": "dotchar", "formatVersion": 1,
  "id": "bhasha",                       // lowercase, digits, dashes; unique in a library
  "name": "Bhasha",
  "version": "1.0.0",                   // bump when you change the art
  "meta": {
    "lips": "female",                   // which shared mouth set: female | male
    "description": "…", "tags": ["main-cast"],
    "voice": { "provider": "elevenlabs", "id": "…", "model": "eleven_v3" },   // or null
    "credits": "…", "license": "…"
  },
  "canvas": [1024, 1536], "root": [542, 1435], "height": 1352,
  "thumbnail": "thumb.webp",

  "poses": {
    "master":  { "image": "poses/master.webp", "head": [[1,0,0],[0,1,0]], "talkable": true, "match": 1 },
    "explain": { "image": "poses/explain.webp", "head": [[1.006,-0.004,-1.8],[-0.002,0.999,0.5]], "talkable": true, "match": 0.983,
                 "tween": { "image": "poses/tween-explain.webp", "head": [[…]], "talkable": true } },
    "cry":     { "image": "poses/cry.webp", "talkable": false }          // silent pose: own face, no lip-sync
  },
  "cycles": {
    "walk": { "facing": "R", "frames": [ { "image": "cycles/walk/0.webp", "at": [190, 152], "size": [640, 1290] }, … ] }
  },

  "face": {
    "mouthAnchor": [501, 406],          // centre of the rest mouth
    "box": [328, 136, 727, 526],        // head region (framing, thumbnails)
    "cover": { "image": "face/cover.png", "at": [440, 375] },   // required unless mouthStyle is "drawn"
    "mouths": {                          // REQUIRED: neutral; usually + happy sad surprised angry worried excited
      "neutral": { "X": { "image": "mouths/neutral/X.png", "at": [459, 389], "size": [84, 31] }, "A": {…}, … "H": {…} }
    },
    "expressions": { "happy": { "mouths": "happy" }, … },   // expression -> which mouth set it talks with
    "mouthSpec": { "lips": "female", "scale": 0.3166, "restWidthPx": 82 },
    "mouthStyle": "drawn", "mouthStretch": false,   // optional: drawn mouths (each viseme = a soft-edged patch of the
                                                    // character's own face). No cover; only a "neutral" set; no stretch.

    // ONE of the two eye systems. Use states: each tile covers eyes AND eyebrows, so nothing of the neutral face shows
    // through. The layers system is kept only for old files (it can show double eyebrows).
    "states": {                          // (a) states face: one tile per expression × eye state
      "neutral": { "camera": {"image": "face/states/neutral-camera.png", "at": [364, 212]},
                   "closed": {…}, "left": {…}, "right": {…}, "down": {…} },
      "happy":   { "camera": {…}, "closed": {…} }
    },
    // (b) layers face: "eyesBase", "blink", "expressions": { "happy": { "image", "at", "brows": {…}, "blink": {…} } }
    "visor": {…}, "marks": {…},          // optional locked layers (glasses frames, bindi, face paint)
    "overMouth": { "image": "face/over-mouth.png", "at": [x, y] },   // optional: moustache drawn AFTER the mouth
    "gazeCameraOnly": ["sad"]            // optional: expressions that never glance sideways
  }
}
```

### Visemes (Preston-Blair, as used by Rhubarb)

| Key | Mouth | Sounds |
|---|---|---|
| X | rest, closed | silence |
| A | lips pressed | M B P |
| B | teeth slightly apart | K S T D N EE |
| C | open | EH AE IH |
| D | wide open | AA |
| E | rounded | AO ER OH |
| F | puckered | UW OW W |
| G | teeth on lower lip | F V |
| H | tongue up | L TH |

### Draw order (per frame)

1. Pose image, or the cycle frame for walk/run, at canvas origin. The renderer transform maps `root` to the stage.
2. If the pose is `talkable`, switch to the pose's `head` transform and draw:
   1. `cover`
   2. eyes: `states[expr][eyeState]`, falling back to `states[expr].camera` and then to `states.neutral`. On a layers face, draw `eyesBase` → expression eyes (or `blink` + brows when closed) instead.
   3. `visor`, `marks`
   4. the mouth `mouths[expressions[expr].mouths || expr][viseme]`, falling back to `neutral`. Its height may stretch by ±10% with the lip-sync `open` value, unless `mouthStretch` is `false`.
   5. `overMouth` (moustache), if present, so the mouth opens behind it.

A silent pose (`talkable: false`) draws only its image. Use silent poses for beats with no dialogue: crying, laughing, jumping.

## Lip-sync track (`*.lipsync.json`)

Made by `npm run char -- lipsync audio.mp3 [--stt deepgram]`. Every character can use the same track.

```jsonc
{ "version": 1, "fps": 30, "duration": 3.11, "mode": "rhubarb+text",
  "frames": "XXXXBBCCDDA…",             // one viseme per frame
  "open":   [0, 0, 0.2, 0.55, …],       // 0..1 jaw-open per frame (subtle stretch, head beats)
  "cues":   [{ "start": 0, "end": 0.13, "v": "X" }, …],
  "words":  [{ "word": "hi", "start": 0.1, "end": 0.3 }, …] }
```

## Source format: `build.json` (images in, `.char` out)

The studio's **Save build.json** writes this file and `npm run char -- build <folder>` reads it. It is the editable source of a character. Keep it in the same folder as the images it names.

```jsonc
{
  "name": "Mother", "lips": "female", "description": "…",
  "master": "master.webp",                       // required
  "mouthless": "mouthless.webp",                 // optional: master with the lips painted out (best cover)
  "mouth": { "anchor": [496, 302], "width": 60, "lipColour": "auto", "cover": [1.35, 0.55] },
  // beard / moustache: "facialHair": true, "lipsWidth": <drawn lip width px> -> lips-only cover + moustache over the mouth
  "eyes": { "box": [380, 139, 623, 245], "closed": "eyes-closed.webp", "happy": "expr-happy.webp", "sad": "…" },
  "poses": { "explain": "pose-explain.webp",
             "wave": { "image": "pose-wave.webp", "talkable": true, "head": [0, 0, 1] } },   // head = [dx, dy, scale]; omit = auto-align
  "cycles": { "walk": "cycle-walk.webp", "run": ["run-0.png", "run-1.png", "run-2.png", "run-3.png"] }   // one sheet = split into 4
}
```

## Versioning

- `formatVersion` changes only on breaking changes. Readers must reject versions they don't know.
- Unknown keys must be ignored, so new optional features don't break old players.
- When a character's art changes, bump `version` and keep `id`. Videos that are already published keep their own copy of the old file.
