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
| http://localhost:8000/sheenSceneRenderer.html | Four rooms (chosen from a Scene list), each by day and by night in Flat, Eggshell, Satin or Semi-gloss: reflections, sheen bands and the colour shift of each finish (see "Paint sheen" below; `?calib` draws the solved room geometry) |
| http://localhost:8000/sheenCalibrate.html | Calibrates a new room for the sheen page from a day photo, a night photo and a wall mask (see "Calibrating a new room" below); `sheenSceneRenderer.html?custom` then shows it |
| http://localhost:8000/sheenVideo.html | One room in a video from morning to night: paint colour and sheen (Flat / Eggshell / Satin / Semi-gloss, each with a ±50 % degree slider) on every frame, with the day-to-night timeline (see "sheenVideo.html" below) |
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
sheenSceneRenderer.html ── js/shaderSceneRender.js ─┤   (sheen mode) + js/sheenModel.js: sheens, rooms, lamps
sheenVideo.html ────────── js/videoShaderRender.js ─┤   (sheen option, v2) + the timeline of day-to-night
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

## sheenVideo.html (paint colour and sheen on a video)

One room (`images/videos/primary_hero_morning-to-night.mp4`) from morning to
night, its walls repainted in a chosen colour and sheen on every frame.

* **The film** works as day-to-night.html (`js/dayNightSequence.js`: timeline
  with Morning 0 s, Afternoon 1 s, Sunset 3 s, Night; autoplay; eased moves;
  scrubbing). The file runs morning -> night -> morning (239 frames; frame k
  mirrors frame 238 - k, night = frame 119), so the two tracks are two copies
  of it: the forward copy plays the first half, the backward copy the second
  (`backwardEnd: 2 × span`). A move to an earlier time crossfades to the
  backward copy, which looks like the film playing in reverse.
* **Tinting**: Perceptual (v2) only, with the Contrast and Saturation sliders
  (`TuningControls.mount(…, { models: false })`), plus v2's optional detail
  layer (`v2Detail`): v2 lights the paint from the blurred light map, which
  smooths away leaf-shadow edges and the panel seam; as v3 does, the fine
  brightness detail is restored from the full-resolution frame (its
  luminance / the blurred luminance, light map .w). Off on every other page.
* **Sheen**: the sheen model of sheenSceneRenderer.html (glsl/sheen.glsl),
  now also on top of v2 (`v2Lit` / `v2Finish` in the RENDER shader; the sheen
  code works in v2's units, refY = 1) and on 16:9 frames (`camAspect`). The
  room comes from the Blender reconstruction of this room
  (`images/room_movie/scene.json`, `SheenModel.roomFromCamera`): two walls,
  floor, ceiling and the walls behind the camera. Where the sheen shows
  (docs/sheen-science.md §5D-5E): in the light already on the walls. In the
  sunlit patches between the leaves' shadows (the frame's light above the
  local shade, reflected toward the sun's direction: the camera sees the main
  wall 9-17° from its mirror direction near the corner), and in the light
  the table lamp casts (its modelled light on the wall x each finish's 60°
  gloss reading) plus its mirror highlight. The smooth sheen is rolled off
  at 2x the paint's own lit light so it reads as shine, not more light; the
  wall texture's glints on top are not (as on the photo page; §5F). The room's reflections only deepen the colour; the window is not
  reflected. The frames carry no
  wall-texture map; the procedural relief below stands in for it.
* **Sharp and hazy reflections** (docs/sheen-science.md §5C). Every sheen
  but Flat reflects through a sharp core plus a wider haze halo (two GGX
  lobes, after Barla et al. 2018). The halo's share is solved with the
  virtual gloss meter so the 60° and 85° readings stay in their MPI bands
  (`python3 -I tests/sheen_check.py`, §D). The core is one exact mirror
  lookup, crisp near contact and soft far away; the reflection environment
  is at the render size. The cabinet top is a surface the wall reflects
  where it meets it. The walls carry a procedural relief
  (waviness 0.15°, roller stipple 0.15° at 1.5 mm) that bends reflected
  edges and adds a fine grain.
* **Degree of sheen** (±50 % per sheen, `SheenModel.sheenAtDegree`): the
  film's roughness scaled by 1 / degree (GGX α and the grazing coefficient k)
  and the gloss lobe's share by degree. Moving a sheen's slider selects it.
* **Speed**: autoplay runs at the video's own speed (1×), eased into
  morning and night. Per frame (M2 Pro, 1920 × 1080): ~16 ms of GPU for the
  paint and sheen - the light map and reflection environment at half size
  (`analysisScale: 0.5`; the reflection environment stays full size),
  8 halo samples per pixel (`lobeSamples`) plus one core lookup,
  and no sheen work on pixels the mask shows as not wall.
* **Mask**: `images/masks/primary_hero_mask.png`, built from shapes measured
  on the frames by `tools/primaryHeroMask.html` (preview over any frame,
  download). It can be retouched by hand.
* Scripting: `window.sheenVideo` (`setSheen`, `setSheenDegree`, `sequence`,
  `renderers`); `?sheen=satin&paint=2f3d4c` set the start.

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
* **Sheens** (`SHEENS` in `js/sheenModel.js`): a sharp core plus a haze
  halo (docs/sheen-science.md §5C): core GGX α 0.30 / 0.035 / 0.018 / 0.010,
  halo α – / 0.14 / 0.09 / 0.07 with share 0 / 0.66 / 0.63 / 0.43; diffused
  share v 0.95 / 0.45 / 0.30 / 0.10, grazing coefficient for 85° sheen. A
  virtual ASTM D523 gloss meter puts them inside the MPI levels: 60° GU
  0.2 / 10.9 / 23.7 / 48.4, 85° 3.5 / 22.6 / 47.4 / 81.2 (G1, G3, G4, G5).
  The lobes' albedos use exact Fresnel (n = 1.5) and Smith masking.
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
* It is kept in the browser (IndexedDB, through `js/sheenCustomRoom.js`) and
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
