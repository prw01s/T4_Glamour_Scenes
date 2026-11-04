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
| http://localhost:8000/shaderSceneRenderer.html | Two rooms, each in morning, noon and night light (three photos side by side) |
| http://localhost:8000/videoShaderRenderer.html | One room in a video whose light changes; every frame is repainted |
| http://localhost:8000/day-to-night.html | One room from morning to night and back (two videos played as one): autoplay loop, time points, drag through the day |
| http://localhost:8000/sheenSceneRenderer.html | Four rooms (chosen from a Scene list), each by day and by night in Flat, Eggshell, Satin or Semi-gloss: reflections, sheen bands and the colour shift of each finish (see "Paint sheen" below; `?calib` draws the solved room geometry) |
| http://localhost:8000/sheenCalibrate.html | Calibrates a new room for the sheen page from a day photo, a night photo and a wall mask (see "Calibrating a new room" below); `sheenSceneRenderer.html?custom` then shows it |
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
sheenSceneRenderer.html ── js/shaderSceneRender.js ─┤   (sheen mode) + js/sheenModel.js: sheens, rooms, lamps
                           glsl/sheen.glsl          │   ENV + ENVDOWN passes, sheen code in RENDER
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

## Paint sheen (sheenSceneRenderer.html)

Sheen is roughness, not reflectivity: every paint reflects ~4 % of light at
its surface, in the light's colour (Fresnel, binder n ≈ 1.5); flats scatter
it everywhere (a faint white veil over the colour), glossy paints gather it
into reflections. So, away from highlights, glossier paint looks deeper and
more saturated (most for dark colours), and near windows and lamps it shows
sheen bands, reflections and hotspots in the light's colour. The full
research, with sources and measurements, is in `docs/sheen-science.md`.

* **Flat = the swatch.** The page renders v3 (the physical model). Paint
  colours are measured specular-included, which is the matte look, so v3's
  result is Flat; each other sheen swaps the swatch's surface veil for what
  a GGX gloss lobe actually reflects: `c' = c + (1 − v) Fs (Ls − W)`.
* **Sheens** (`SHEENS` in `js/sheenModel.js`): GGX α 0.30 / 0.075 / 0.045 /
  0.025, diffused share v 0.95 / 0.45 / 0.30 / 0.10, grazing coefficient for
  85° sheen. A virtual ASTM D523 gloss meter puts them inside the MPI levels:
  60° GU 0.2 / 10.9 / 23.7 / 48.5, 85° 3.5 / 22.1 / 47.8 / 84.9 (G1, G3, G4,
  G5). The lobe's albedo uses exact Fresnel (n = 1.5) and Smith masking.
* **Four scenes** (Scene list; `ROOMS` in the page): living room, living
  room 2, deck and study, each with a day and a night photo. Every room's
  geometry is measured lines in its photo (`?calib` overlays the result).
* **Reflections are traced**: `solveRoom` recovers the camera (f from 848 px
  / 99° on the deck to 4532 px / 25°) and up to 8 planes - walls at any of
  4 directions, the floor and a ceiling - from straight lines in the photo;
  for each wall pixel, 16 directions drawn from the GGX lobe for that
  pixel's viewing direction are traced to the nearest plane and read from an HDR
  blur pyramid of the photo whose walls carry the new paint (filtered
  importance sampling), so reflections have the right blur and stretch.
  Window panes and bulbs are restored to light-source brightness with gains
  from energy balance (×5–7, ×12), and show unpainted. Lamps that stand
  off the walls are lights in 3-D, calibrated from their own pixels.
* **Glints** come from the wall's own texture (linear shape from shading
  against each photo's key light), so they sit where real ones would; a
  gate drops texture that is only JPEG blocking.
* Measured in the app (teal #607D84, back wall): off-highlight ΔL\* −0.9 /
  −1.5 / −2.1 (day) and −1.3 / −1.8 / −2.4 (night) for Eggshell / Satin /
  Semi-gloss, with chroma rising; in the window's reflection +13 / +20 / +29
  with chroma falling (the light's colour). docs/sheen-science.md §5A lists
  what a second review corrected and §5B the four-scene evaluation (wall
  statistics per scene and the fixes it led to).
* **Windows outside the photo** (`windows` in a room's lights;
  `placeWindows`): rectangles on a room plane that reflected rays can reach.
  The living room's two windows are located and measured in the reflections
  in its framed prints' glass (radiance ×12 and ×7.7).

`python3 -I tests/sheen_check.py` prints the gloss-meter readings and the
colour shifts for sample paints, and fails if a sheen leaves its MPI band.

## Your own room (upload in sheenSceneRenderer.html)

The panel's **Your own room** box takes three files, by name: `day.jpg`,
`night.jpg` and `mask.png` (black = wall), taken from the same spot. Choose
or drop all three at once. They are cropped to their centre squares,
calibrated automatically (`autoCalibrate` in `js/sheenCalib.js`), stored in
the browser with the images (IndexedDB, `js/sheenCustomRoom.js`) and shown at
once as **Your room**, in every sheen and colour. The current sheen and paint
carry over (`?custom&sheen=…&paint=…`). The room stays in the scene list on
later visits until *Remove this room*.

The automatic calibration accepts every proposal of the calibration page:
* the camera and walls from the photo's lines (an inside corner shows the
  wall whose lines run to the right vanishing point on its left, so only the
  corner's column is searched);
* the floor where the mask's wall comes lowest without running off the
  photo;
* a camera 1.2 m above the floor;
* the light sources and lamps.
Uploads of a built-in room's own photos are recognised and get that room's
measured calibration. A photo's EXIF focal length (35 mm equivalent), when
recorded, fixes the camera's field of view. Measured against the built-in
rooms (docs/sheen-science.md §8), fully automatic uploads differ from the
preloaded rooms by ΔE 1.0-1.8 (living room 2) up to 3.3-5.7 (the deck: four
walls and a sloped ceiling, which automatic layout doesn't find); about three
quarters of that is geometry. When the lines give no plausible camera, a
default room (one wall facing the camera, 60° field of view) is used: the colour shift and soft sheen still
work, reflections are approximate. The status line says which. The camera
from lines alone is often off (−54 % to +155 % in focal length on the built-in
rooms), so *Refine the calibration* opens the calibration page with
everything filled in. Uploading replaces any work in progress there.

## Calibrating a new room (sheenCalibrate.html)

The sheen shaders and `js/sheenModel.js` hold nothing specific to a photo:
each room is a description - straight lines that give the camera, the walls,
the light sources - in `ROOMS` in `sheenSceneRenderer.html`. The four built-in
rooms were measured by hand. `sheenCalibrate.html` does it semi-automatically
for new photos (square or centre-cropped; the same camera by day and night;
a wall mask, black = wall; upright verticals, i.e. perspective-corrected):

1. **Photos**: load the three images.
2. **Camera lines**: *Detect lines* finds straight segments (`js/sheenCalib.js`:
   a simplified LSD line detector) and sorts them into verticals and the two
   horizontal directions at right angles (RANSAC for vanishing-point pairs on
   a common horizon, long lines and lines along walls weighted most). Click a
   line to change its type; draw missing ones - drawn lines snap to the edge
   under them (sub-pixel, RANSAC through texture).
3. **Walls**: add each wall (its direction, its corner with a wall already
   placed), a floor point, optionally the ceiling. The room grid is drawn
   live; the report gives the camera and its **uncertainty** (re-solved with
   ±0.5 px line noise) and says which line family to strengthen.
4. **Lights**: *Detect lights* proposes emitters - by day, regions bright in
   the day photo and dark in the night photo (window glass; white objects
   indoors stay lit at night); by night, bulbs (clipped cores) and lit
   shades (partly clipped) - with lamps placed in front of them. Edit gains,
   distances and sizes; optionally add windows outside the photo.
5. **Use it**: *Open in the visualizer* stores the room and its images in the
   browser (IndexedDB; `js/sheenCustomRoom.js`) and opens
   `sheenSceneRenderer.html?custom`; *Copy config* / *Download JSON* give a
   `ROOMS` entry to add to the page for good (copy the images to the path set
   in step 1). Work in progress is kept between visits.

How well it works on the four built-in rooms (docs/sheen-science.md §8):
night lights are found as measured by hand (bulb clusters, the study's
lamp); day windows mostly (the deck's only in part); the camera from
detection alone is often wrong (the rooms' second direction has few lines -
furniture outvotes it), so step 2 needs a look every time. With the lines
checked and snapped, living room 2 came out at f = 4346 px against 4532 px by
hand, inside the tool's own ±3.5 % uncertainty.

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
Calibration: the line detector finds a polygon's edges to 0.01 px, snapping
recovers an edge through texture to 0.06 px, detection + solving recover a
known camera (f within 2 %) from a cluttered line set, and light detection
tells windows from white objects and bulbs from shades; the automatic walls
find a corner between two line families on the correct sides; the automatic
floor point skips furniture; the default room renders.
Sheen: the room solver recovers a known camera and its walls; lamps sit on
their pixel's ray; the texture gate drops JPEG blocking; Flat equals v3's swatch;
each glossier sheen is darker and more saturated off-highlight (most for
dark paints, < 1.5 L\* for off-white); reflected light adds the light's
colour, not the paint's; a lamp's highlight is neutral and sharpens and
brightens from Flat to Semi-gloss; a window outside the photo is placed from
its edge in the photo and reflected in its own colour.
Results are listed on the page and in `window.testResults`.

## Editing notes

* `glsl/shaderSceneRender.glsl` and `glsl/sheen.glsl` must stay pure ASCII,
  and their `//@@NAME` section markers are looked up by name. The sheen code
  is compiled into RENDER only under `#define SHEEN`, so the other pages
  compile exactly as before. Uniform types are read from the
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
