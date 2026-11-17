# T4_Glamour_Scenes

Paint visualizers that repaint the walls of room photos and videos on the GPU,
so a paint colour can be seen under morning, noon and night light, or under
light that changes as a video plays. No build step, no dependencies, no
generative AI: plain HTML, JavaScript and GLSL (WebGL2).

## Running

The pages read image pixels, which browsers only allow over http:

```bash
bash serve.sh
```

`serve.sh` runs `serve.py`, a small static server (Python 3 standard library)
with byte-range support for the videos and `Cache-Control: no-store`, so edits
always show on reload.

Then open:

| Page | What it shows |
| --- | --- |
| http://localhost:8000/shaderSceneRenderer.html | Two rooms, each in morning, noon and night light (three photos side by side), plus a scene you upload (see "Uploading a scene" below) |
| http://localhost:8000/videoShaderRenderer.html | One room in a video whose light changes; every frame is repainted |
| http://localhost:8000/day-to-night.html | One room from morning to night and back (two videos played as one): autoplay loop, time points, drag through the day |
| http://localhost:8000/sceneVisualizer.html | One scene at a time (the rooms' photos, the two videos, or an uploaded image + mask), repainted with the v4 model: the original wall colour is divided out (estimated, or set by you) so any paint gets the room's own light; 10 random test paints per load plus up to 5 of your own (see "Scene Visualizer" below; `?seed=` repeats a colour set) |
| http://localhost:8000/roomMovie.html | Prototype of the room movie: one room rebuilt live from Blender light layers, with time of day, lamp and paint controls that animate the light itself (see "Room movie prototype" below; `?debug` shows the light levels) |
| http://localhost:8000/tests/ | Automated tests of the colour science and the shaders |

Add `?nogl` to a page's address to see its fallback (plain photos / video).

## How it works

Each photo or video frame is used as a **light map**: the camera recorded how
much light, and of what colour, falls on every point of the (white) walls.
The shaders measure that light per pixel, then light the chosen paint with it.
A CSS luminance mask on top keeps everything that is not wall from the
original image, so only the walls change.

```
shaderSceneRenderer.html ─ js/shaderSceneRender.js ─┐   tiles, rooms, fades, room switching
videoShaderRenderer.html ─ js/videoShaderRender.js ─┤   video frames, frame-locked layers, paint fades
day-to-night.html ──────── js/videoShaderRender.js ─┤   (one renderer per video, shared statistics)
                           js/dayNightSequence.js   │   eased loop and moves, crossfades, scrubbing
                           js/tuningControls.js ────┤   Tinting algo, sliders (markup + wiring)
                           css/visualizer.css       │   shared styles
                                                    └─ js/paintPipeline.js     GPU pipeline, colour science,
                                                       glsl/shaderSceneRender.glsl  statistics, spectral rendering
```

### The GPU pipeline (`LightPipeline` in `js/paintPipeline.js`)

```
photo ── RESAMPLE (linear light) ──> source (SRGB8_ALPHA8, render size R, mipmapped)
video frame ───────────────────────> source (RGBA8, its own size)
  │ DECODE   -> linear light + wall coverage (from the mask), at the analysis size A
  │ ADJUST   -> the Contrast / Saturation sliders (skipped when both are centred)
  │ BLUR x2  -> Gaussian blur weighted by wall coverage (v2, v3)
  │ ANALYSE  -> light map (RGBA16F, A), encoded for the active model
  ▼
light map
  │ RENDER   -> the paint lit by the light map, at R (sRGB or Display P3, dithered)
  ▼
canvas
```

* **Two resolutions.** The light is analysed at A, where JPEG noise, chroma
  subsampling and surface texture average out; the paint is rendered at R,
  sampling the light map smoothly. The photo page picks R from the tiles' size
  on screen (1024–2048 px); the video uses its own size for both.
* **Linear-light resizing.** Photos are stored as sRGB textures, which the GPU
  decodes to linear light before any filtering, so resizing and mipmaps
  average light, not encoded values (encoded averaging made the sharpest
  light edges up to 60 % too dark).
* **Mask-weighted blur.** The blur averages only wall pixels (normalised
  convolution), so furniture next to a wall does not leak its colour or
  darkness into the wall's light.
* **Wide gamut.** On Display P3 screens the pipeline renders in P3, so vivid
  paints in warm light are shown instead of being pulled into sRGB.
* **Statistics** (`LightStats`) are measured on the CPU from point samples
  (256 × 256 per photo; 1/8 of each video frame): medians for the sliders,
  and v3's reference white and scene white. The photo page measures each
  room's three photos together; the video page measures the whole video
  during the first loop. They match full-resolution measurements within 0.001.
* **Video layers.** While painting, the masked top layer is a canvas copy of
  the source video's own frame, drawn in the same callback as the paint, so
  the painted walls and the rest of the room always show the same frame.

## The tinting models ("Tinting algo")

All three use the same light map pipeline; they differ in how they read the
light and apply it to the paint.

| | v1 — HSV | v2 — Perceptual (default) | v3 — Physical |
| --- | --- | --- | --- |
| Light amount | HSV value | Brightest channel, plus a "glow" boost for coloured light | Relative luminance, calibrated to the room's reference white |
| Light colour | HSV hue | A warm/cool estimate from the Oklab hue, mapped onto the blackbody curve (fixed 2700 K / 10000 K ends) | The **measured** chromaticity → colour temperature (McCamy) + exact tint correction |
| Light × paint | RGB multiply | Linear-sRGB multiply | **Spectral**: blackbody spectrum × fitted paint reflectance, integrated against the CIE 1931 observer |
| Bounce light | Constant floor (scaled down in dark scenes) | Fill + paint-coloured bounce (fill scaled down in dark scenes) | Original white walls' bounce replaced by the paint's, computed spectrally over multiple bounces (radiosity) |
| Colour constancy | — | CAT16, per pixel, D = 0.35 | CAT16 toward the **scene's** white, D from CIECAM16 × 0.4 |
| Fine detail | From the 1024 px light map | Smooth (blurred light map) | Brightness detail restored from the full-resolution image |
| Highlights, gamut | Soft clip | Oklab roll-off + gamut mapping | Oklab roll-off + gamut mapping |

Under white light every model shows the paint swatch exactly (v3 within the
effect of interreflection, which darkens dark paints and lightens light ones,
as in a real room). The tests check this.

### Assumptions behind the colour maths

* Photos and video are encoded sRGB, white-balanced so the camera's neutral is
  D65 daylight.
* The original walls are white. The light map is the light falling on them.
* Masks are black (or transparent) on the walls and white elsewhere, with the
  same framing as their image.
* v3's reference white is the 95th percentile of wall brightness across a
  room's photos (or the whole video). Wall areas that bright show the paint as
  its swatch; brighter areas (sunbeams) exceed it.
* The photos carry no absolute light level; v3 assumes 250 cd/m² for the
  reference white when computing CIECAM16's degree of adaptation (which
  depends on it only weakly).
* v3's scene adaptation is scaled down (× 0.4 → D ≈ 0.35) because the
  furniture on screen keeps the camera's unadapted colours; fully adapted
  walls would look disconnected from the room around them.

Every tunable value is in `SHADER_DEFAULTS` in `js/paintPipeline.js`, with
what it means and why it has its value.

### What limits fidelity now: the source images

The photos and video are 8-bit, display-referred and clipped. Measured on the
wall pixels: 57 % of the living-room noon wall and 15 % of its morning wall are
at pure white (≥ 250), so the light there is unknown — those areas can only
show the swatch flat, and sunbeams can't read brighter than the wall around
them. No processing can recover clipped light. The single biggest possible
improvement is **scene-linear HDR sources**: 16-bit or EXR renders/photos (or
HDR video, e.g. 10-bit HLG/PQ), unclipped and without a tone curve. The
pipeline already works in half-float linear light, so it needs only a
different decode step for them.

### day-to-night.html

Two videos of one room (morning to night, and night to morning) play as one
film; `js/dayNightSequence.js` keeps one scene clock for both and crossfades
whenever the film switches video. Moves to a time point are eased (launch at
up to 4x, slow landing, ~0.6 s for 1 s of film, ~1.6 s for all 5 s); autoplay
slows into night and morning and accelerates out; the track can be clicked
or dragged, and the playhead is a keyboard slider. Both videos are painted by
one shared GPU pipeline at the film's size on screen. Smooth seeking depends
on the video encoding: see "Exporting the videos" below.

## Scene Visualizer (sceneVisualizer.html, the v4 model)

The older pages assume the walls in the source image are white, so a
coloured original wall is read as coloured light and tints every new paint.
`sceneVisualizer.html` divides the original paint out instead:

* **The Wall Colour Delta** = photo / original paint, per pixel, in CAT16
  cone space: the room's light at that pixel. The new paint is lit by it,
  with a bounce-light correction (`js/wallPaint.js`, `glsl/sceneVisualizer.glsl`).
* **Original wall colour**: set it on the page, or it is estimated from the
  image (median error 8-10 dE2000 on real before/after photos).
* **Paints**: 10 random colours per load, spread across hue, chroma and
  lightness inside the range of real architectural paints (built from the
  Sherwin-Williams palette); up to 5 custom colours (picker or hex; kept
  between visits). No tinting-algorithm selector.
* **Scenes**: Living Room and Study photos (morning, noon, night), the study
  day-to-night video, the living-room morning-to-night video
  (`prim_hero_morn-to-night_back.mp4`, shown 960 px wide), and one uploaded scene (`room.jpg` or
  .jpeg/.png/.webp, plus `mask.png`, black = wall), kept in the browser.
  Scenes are on top (a room's three times of day side by side), each at
  most half its native size, with the controls underneath.
  Video scenes show a time-of-day selector (the study video: Morning, Noon,
  Sunset, Night; the living-room video: Morning 0 s, Afternoon 2 s, Sunset 3 s,
  Night 4 s) and a timeline with play/pause in place of the title. Videos play
  at 80 % speed. The living-room video is one palindrome file (its second
  5 s are the first 5 s reversed), played as two stacked copies through
  `js/dayNightSequence.js`, so moving to an earlier time plays backwards. The original-wall-colour
  control is hidden by CSS for now (one rule in the page's style block).

Measured on the before/after photos in `images/source/pairs/`: median
dE2000 4.1 with the original paint given, 6.3 when estimated, 13.0 for the
white-wall assumption. Design, measurements and limits:
`docs/scene-visualizer.md` (research and plan: `docs/scene-visualizer-plan.md`).
A guided tour of the shader and JavaScript code, written for JavaScript
developers new to GLSL: `docs/scene-visualizer-code-guide.md`.
Measurement tools: `tools/` (Python: `python3 -m venv .venv && .venv/bin/pip
install numpy pillow scipy`).

## Uploading a scene (shaderSceneRenderer.html)

**Upload Scene**, under the room list, takes four files of one room, by
name (any letter case): `mask.png`, `morning.jpg`, `noon.jpg` and
`night.jpg`. Choose them together, or drop them on the control. The photos
must be taken from the same spot and line up with the mask, whose black
(or transparent) pixels are the walls, as in the built-in masks.

* Each image is cropped to its centre square (the tiles are square) and
  scaled down to 2048² if larger; square images up to 2048² are used
  unchanged. All four must have the same shape.
* The mask must mark some wall but not the whole picture; files that aren't
  images, have other names or are missing are refused with a message, and
  the scene on screen stays.
* The scene joins the room list as **Your Scene** and is shown at once, with
  every paint, tinting algo and slider. Nothing about it is tuned by hand:
  this page's models read all their light from the photos, so an upload of a
  built-in room's photos renders the same pixels as the built-in room.
* It is kept in the browser (IndexedDB, through `js/sceneStore.js`) and
  is still in the list after a reload. A new upload replaces it; **Remove
  this scene** deletes it.

For scripting, the renderer's `addRoom(key, room)` and `removeRoom(key)`
add and remove rooms at run time (`js/shaderSceneRender.js`).

## Room movie prototype (roomMovie.html)

Phase 2 of `docs/room-movie-plan.md`: the room in `images/room_movie/reference.webp`,
rebuilt in Blender and relit live in the browser. Nothing in it is a finished
frame; the shader adds up light layers for the current settings:

* **Time of day** (morning, afternoon sunset, night) moves the sun along its
  path, always forward in time: the patch sweeps across the wall and warms,
  the sun sets, the sky dims, dawn breaks. Sun light from a clear-sky
  atmosphere model; sky light by sun height, twilight included.
* **Lamp** off or 1800 / 2700 / 4000 / 6000 K (blackbody, 800 lm).
* **Paint**: a sample palette. Each colour's spectrum is estimated from its
  hex value for now (the plan calls for measured spectra); the paint changes
  the bounced light through a per-pixel fit of three renders.
* Leaf shadows come from looping videos of a CG tree, projected through the
  window and blurred over the sun's disc; window, lamp and cabinet cast shadows.
* A new paint sweeps across the walls from the far left to the window.

Rebuilding the assets (Blender 5.2, headless; renders take ~15 min on an M2 Pro):

```
B=/Applications/Blender.app/Contents/MacOS/Blender
$B -b --factory-startup -P tools/roomMovie/build_scene.py
$B -b tools/roomMovie/build/room.blend -P tools/roomMovie/render_layers.py -- all   # includes maskhi (the 1920 x 1080 geometry)
$B -b --factory-startup -P tools/roomMovie/fit_layers.py
```

`build_scene.py` solves the camera from points measured on the reference and
the window and morning sun from its sun patch; `render_layers.py` renders
every light at unit strength with the walls at three albedos (clamps off,
24 diffuse bounces, lighting passes denoised one by one);
`fit_layers.py` writes the page's assets to `images/room_movie/`. The
intermediate files (`tools/roomMovie/build/`, ~350 MB) can be deleted.

Scripting: `window.roomMovie` has `setTime("morning" | "sunset" | "night")`,
`setLamp(0 | kelvin)`, `setPaint(hex)`, `settle()` (jump to the targets),
`renderOnce()` (browsers pause animation in hidden tabs) and `debugView = 1`
(the sun's leaf transmission). Tests: `tests/` checks the sun's colour by
elevation against published values, the twilight sky and the adaptation table.

Resolution: the frame is drawn at 1920 x 1080 from geometry rendered at that
size (normals, distance, albedo, surface class), so the sun patch, the
dapples, the shadows and every outline are computed per full-size pixel. The
light layers stay at 960 x 540 and are upsampled edge-aware (only from texels
of the same surface), so light never bleeds across an outline. About 5 ms per
frame on an M2 Pro.

The window view moves with the wind: it is stored as what is behind the tree
and the foliage's colour (per time of day), mixed by the tree's coverage, a
small greyscale video (`window_cov.mp4`) from the same wind loop as the leaf
shadows. The page keeps all the loops on one clock.

At night the window turns into a dark mirror: the lamp-lit room reflected in
the glass is a ninth layer (`lampref`, rendered with a glass pane only the
camera sees, at the three wall albedos), so it changes with the paint and the
lamp's colour; by day it disappears against the bright view, as it does in reality.

Assets: ~21 MB in total, about 13 MB of light layers and geometry plus 8 MB
of video. The float16 layers are packed for compression (`fit_layers.py`
`pack_half`: mantissa rounded to 8 bits, under 0.4 %, for the light and kept
whole for the geometry; row-wise differences; high and low bytes in separate
planes) and gzipped; the page decompresses them with the browser's own
`DecompressionStream` (6.4x smaller than raw; the rendered frames match the
uncompressed ones to within 1 level in 99 % of pixels). A server that adds
`Content-Encoding: gzip` for `.gz` files on its own would break this: serve
them as plain files. KTX2 (Basis UASTC HDR) would also cut GPU memory, but
needs the Basis encoder and transcoder, which this project does not include.

## Controls

* **Tinting algo**: v3 / v2 / v1.
* **Contrast** (−100…+100): the light's contrast around the median brightness
  of the room's photos / the video, before the paint is applied.
* **Saturation** (−100…+100): the strength of the light's colour, scaled per
  pixel by how far it is from pure white relative to the median pixel.
* **Difference from white**: what Saturation measures: *Color + brightness*
  (Oklab distance from white) or *Color only* (Oklab chroma).

At the centre the sliders change nothing: their shader pass is skipped.

## Scripting

Both pages expose their renderer for the console and for automation:
`window.sceneRenderer` (photos) and `window.videoRenderer` (video), with
`setPaint`, `setModel`, `setContrast`, `setSaturation`, `setSatMeasure`, and
on the photo page `setRoom`, `sample(tile, x, y)` (a painted pixel) and
`roomInfo(room)` (statistics and v3 calibration).

## Verification

`tests/reference_check.py` compares the colour maths with official CIE data
(the CIE 1931 1 nm observer, CIE D65 and D-series daylight) and prints:

* v3's spectral rendering vs a 1 nm, D65-referenced reference, for 9 paints
  under blackbody 2000–3500 K and daylight 5000–25000 K: mean ΔE_OK ≤ 0.0042,
  worst 0.0084 (0.02 is a just-noticeable difference). A plain RGB multiply
  errs by up to 0.044 at 2000 K, so the spectral step matters mainly for
  saturated paints under warm light.
* The CMF fit (Wyman et al. 2013) is within 1.4 % / 0.8 % / 1.3 % of the
  x̄ / ȳ / z̄ peaks; McCamy's CCT within 1.2 % from 1800 to 10000 K (22 % low at
  25000 K, which v3's exact chromaticity correction absorbs); Oklab matches its
  published values.
* Daylight sits 0.003 uv off the blackbody curve. v3 models every light as a
  blackbody plus an exact chromaticity correction, which keeps daylight
  within ΔE_OK 0.0024 of rendering with the true daylight spectrum.
* Multi-bounce interreflection computed spectrally differs from an RGB
  estimate by up to ΔE_OK 0.06 for saturated paints (v3 uses the spectral one).

Measured in the browser (Apple M2 Pro, Chrome): every pass takes 2–6 ms at
1280 px; the video is painted at its full 24 fps; frame-to-frame jitter on
static walls is under one 8-bit level; with white paint, v3 reproduces the
original photo within 1–3 levels by day; in Display P3, 0.2–5 % of night-time
wall pixels (lamp-lit, warm paints) fall outside sRGB, under 0.1 % by day.

What can't be verified here: real paints' spectra (the reflectance is a smooth
fit to the swatch colour; with manufacturers' measured spectra it could be
used directly), and the assumed values in `SHADER_DEFAULTS.v3`.

## Tests

`tests/index.html` runs in the browser (WebGL2 is needed): unit tests of the
transfer curves, Oklab, matrices, Display P3, colour temperature, the spectral
paint fit, statistics and adaptation, and GPU tests of every model on small
synthetic images (the swatch identity under white light, interreflection,
mask-weighted blur, the detail layer, warm light, the sliders, P3 output).
Results are listed on the page and in `window.testResults`.

## Editing notes

* `glsl/shaderSceneRender.glsl` must stay pure ASCII, and its `//@@NAME`
  section markers are looked up by name. Uniform types are read from the
  compiled program, so new uniforms need no registration in JS.
* Every stored image has row 0 at the top; only RENDER flips y.
* The scripts are classic scripts (not ES modules) so the pages still load,
  and explain themselves, when opened from `file://`.

## Exporting the videos (day-to-night.html)

Seeking speed (reversals, exact stops, dragging) depends on keyframe spacing.
Export both videos as H.264, High profile, 1920 x 1080, 24 fps, with a
keyframe every 6 frames and no B-frames; export the night-to-day video as the
exact frame reverse of the day-to-night one. The step-by-step Premiere Pro
settings are in `docs/premiere-export.md`.

## Other files

`heroImage*.html`, `heroVideo.html`, `tinted-wall-demo.html`,
`shaders_Reference*.html`, `Lighting_with_shaders.html`, `js/tinted-wall*.js`
and `glsl/wall_lighting.glsl` are earlier experiments; the v1 and v2 models
were first written in `js/tinted-wall-v2.js`.
