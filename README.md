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

Then open:

| Page | What it shows |
| --- | --- |
| http://localhost:8000/shaderSceneRenderer.html | Two rooms, each in morning, noon and night light (three photos side by side) |
| http://localhost:8000/videoShaderRenderer.html | One room in a video whose light changes; every frame is repainted |
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
| Bounce light | Constant floor | Fixed fill + paint-coloured bounce | Original white walls' bounce replaced by the paint's, computed spectrally over multiple bounces (radiosity) |
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

## Other files

`heroImage*.html`, `heroVideo.html`, `tinted-wall-demo.html`,
`shaders_Reference*.html`, `Lighting_with_shaders.html`, `js/tinted-wall*.js`
and `glsl/wall_lighting.glsl` are earlier experiments; the v1 and v2 models
were first written in `js/tinted-wall-v2.js`.
