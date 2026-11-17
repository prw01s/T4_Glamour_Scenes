# Room movie with live paint and lighting: implementation plan

Status: plan, verified by research; decisions made and reference image received (10 Nov 2026). Nothing is built yet.

Reference image: `images/room_movie/reference.webp` (see §3.0).

## 1. Goal

A movie of a room that the visitor can repaint and relight, in any combination:

* **Paint**: any of ~1500 colours, shown accurately.
* **Interior lights**: off, or on at one of four colour temperatures (requested range 1500–6000 K; decided: 1800, 2700, 4000 and 6000 K, §10).
* **Time of day**: Morning, Afternoon Sunset, Night.

The scene: a fixed camera; nothing in the room moves; one window at the right edge of the frame; daylight falls across an empty wall that fills the centre and left; a tree outside casts moving leaf shadows.

Every change should be an animated transition, not a cross-fade, and the download should be small.

## 2. Core idea

Do not ship finished frames. Ship the room as a few separately lit **light layers** and one small **greyscale video** of the moving leaves. A GPU shader rebuilds each frame live from the current settings.

* **Light adds linearly.** A room under several lights equals the sum of the room under each light alone, each scaled by that light's brightness and colour (Haeberli 1992; Debevec's relighting work). So 3 times of day × (off + 4 colour temperatures) = 15 lighting states, × 1500 paints = 22,500 combinations, all come from one set of layers.
* **Settings become physical parameters**: sun position, sun and sky spectra, lamp level and colour temperature, the paint's reflectance spectrum, exposure. Transitions animate those parameters. The sun patch sweeps across the wall as the sun moves; the light warms; the sky dims; the paint changes spectrally.
* **Download**: a few MB instead of ~24 full videos (200–350 MB).

## 3. Production route: one reference image plus a Blender scene

### 3.0 The reference image (received 10 Nov 2026)

`images/room_movie/reference.webp`: 1442 × 811 (16:9), 8-bit sRGB WebP, 56 KB, no camera metadata. It looks like a 3D render or an AI-generated image, not a camera photo.

**What it shows**

* **An inside corner** at x ≈ 805 px. The **main wall** (left) faces the window and recedes to the right toward the corner; the **window wall** (right) recedes to the left toward it. The window wall's horizontal lines (sill, cabinet top) meet at a vanishing point near (−1000, 551), so the horizon is at y ≈ 551, below the image centre, while the verticals are parallel: the camera is level with a vertical lens shift (common in architectural renders). There are no ceiling or floor lines.
* **Walls**: dark charcoal, both painted the same, including the deep window reveal. A thin vertical seam on the main wall at x ≈ 578 (panel joint or flush door).
* **Sun patch** on the main wall: two bright panes separated by a mullion shadow; the right edge (the window jamb's shadow, cast from close by) is sharp, while the leaf shadows (cast from several metres away) are soft round dapples, and the patch softens and dims away from the window. **This is what the shadow model in §4.3 predicts.**
* **Window**: black frames, at least three panes; the window head is above the frame. Outside: an over-exposed, defocused tree.
* **Furniture**: a long black cabinet along the window wall, its left end reaching the main wall, with a glossy dark top; on it a **table lamp** (white dome shade, brass stem, black base; off), a dark bowl, and a vase with olive branches. None of it is in the sun's path in this view.

**Consequences for the plan**

* **The whole frame is rebuilt in Blender**, with the image as the art-direction target for composition, camera, materials and mood. At 1442 px, heavily compressed and not linear, it cannot supply surface colours or textures at production resolution, so the photo-based steps in §3.1–3.2 (RAW capture, grey card, fit-and-divide) are not used. They remain the method if a real photo is used later.
* **Benefits**: every layer is linear and clean, rendered at any resolution (e.g. 2560 × 1440 or 3840 × 2160), with exact geometry and no baked-in light to remove. All surface colours are known material values.
* **Camera**: the window wall's vanishing point and the level verticals fix the rotation and the lens shift. The focal length cannot come from metadata; it is fitted by matching the rebuilt geometry (cabinet, window, lamp) to the image, which is easy in Blender because the scene is ours.
* **The exterior** is out of focus in the reference. Rendering it with the same depth of field also hides the main realism risk of a CG tree.
* **The reference's lighting is one state**: daytime (sun at a moderate height through a sun-facing window), lamp off. It is the target look for one time of day; the others follow from the physics.
* **Interior lights**: the table lamp, the only fixture in view, is the only interior light (§10, decision 7). It lights the cabinet and the wall around it; most of the main wall stays dark at night.

The room's look comes from **the Blender scene** matched to the image (or, with a real photo, from that photo); the lighting comes from the same scene. The shader multiplies each surface's own colour by the lighting, so every light stays controllable.

### 3.1 A real photo (requirements; not used with the current reference)

* **RAW** (Apple ProRAW or Android DNG). Phone JPEG/HEIC, including HDR/gain-map HEIC, is tone-mapped locally (up to ~3× in shadows) and cannot be made linear reliably.
  * Process linearly: no tone curve, no local tone map (ignore the DNG ProfileGainTableMap / ProfileToneCurve; on Apple, CIRAWFilter with localToneMapAmount, boostAmount, shadowBias and baselineExposure at 0 and gamut mapping off).
  * **Do** apply the DNG lens-shading GainMap opcode, or vignetting and colour casts end up in the surface colours.
  * Convert camera RGB to linear Rec.709 with the DNG colour matrices; use the same white balance in Blender.
* **Soft, even light, with no sun patch** in the room. Baked-in sun and leaf shadows cannot be cancelled by the CG tree.
* **A grey card or ColorChecker** in one extra frame from the same position. Without a reference, a surface's colour cannot be separated from its light (scale and colour ambiguity).
* **Measurements**: ceiling height (real rooms vary 2.3–2.7 m), window size and position, and where the lamps are if they are off-frame.
* **Focal length** from the photo's EXIF (FocalLengthIn35mmFilm). A camera facing the wall squarely gives too few converging lines to solve the field of view; vanishing points are used only for the camera's rotation.

### 3.2 Matching the scene

1. **Camera**: rotation from vanishing points (the project's own `solveRoom` solver), focal length from EXIF, scale from the measured ceiling height. fSpy is unmaintained (last release 2020); not needed.
2. **Geometry**: walls, floor, ceiling, window (frame, mullions, glass), trim. Off-frame walls are invented plausibly; they affect bounce light.
3. **Depth sanity check** (optional): MoGe-2 (MIT licence). Do not use Apple Depth Pro (weights licensed for research only).
4. **Surface colours ("albedo") by fit-and-divide**:
   * Render each light layer in Blender, fit the light intensities so the render matches the photo, then divide the photo by the rendered lighting.
   * Pin absolute scale and colour with the grey card.
   * Iterate: interreflection depends on the albedo itself, so re-render with the new estimate and divide again until stable.
   * Mask and fill what the divide gets wrong: clipped window pixels, cast and contact shadows from unmodelled objects, floor shine, and halos at geometry edges (erode masks, edge-aware smoothing, per-surface low-order albedo on plain walls).
   * Learned intrinsic-decomposition models (Careaga & Aksoy, RGB↔X) are research-only licences and not calibrated; at most use one as a hint.
   * The wall's own albedo is replaced by the paint anyway; only its fine texture (drywall, roller marks) is kept, as a detail ratio, as in the existing v3 pipeline.

### 3.3 Blender settings (Blender 5.2 LTS, Cycles, Metal GPU on the M2 Pro)

Blender is driven headless by Python (`blender -b scene.blend -P script.py`; set the Cycles device to METAL in the script). It must be installed from blender.org first.

* **Clamp Direct = 0 and Clamp Indirect = 0.** The default Clamp Indirect of 10 caps bright bounced light per sample; layers rendered with it cannot be rescaled correctly.
* **Diffuse bounces 16–32** (default 4) and Total to match; **Transparent bounces 32–64** for foliage (default 8).
* **Wall material: plain Diffuse BSDF.** The Principled BSDF adds a specular layer, so its Base Color is not the true albedo.
* **One render per light**, other lights disabled. With light groups in one render, adaptive sampling follows only the Combined pass and the light tree favours bright lights, so dim layers stay noisy. Denoise each layer with OIDN (GPU on Apple Silicon), using the albedo and normal guide passes.
* **Render each light at unit strength**; the shader applies real levels. Output multilayer OpenEXR (linear, no view transform), lossless compression; use 32-bit float where the sky or sun is directly visible (half float overflows above 65504).
* **Sky**: the Multiple Scattering sky (default since 5.0) accepts sun elevations below the horizon. Set the sky's sun disc (default 0.545°) and the Sun lamp's angle (default 0.526°) to the same value, and never count the sun twice (sky disc plus lamp).
* **Tree**: Poly Haven trees (CC0) or Sapling Tree Gen 1.0 (a rewrite released 4 Nov 2026; test first). Wind from animated noise in Geometry Nodes or a Displace modifier, weighted by distance from the trunk (wind force fields do not move plain meshes). Keep noise seeds fixed so frames do not flicker independently.
* Blender light units are radiometric watts (sun: W/m²) and only roughly convertible to lumens; absolute levels are set in the shader, so this does not affect accuracy.

### 3.4 What Blender renders

| Output | Notes |
|---|---|
| **Lamp layers**, one per fixture group | Rendered with white light at unit strength; colour temperature is applied in the shader |
| **Sky layer**, per time-of-day keyframe | The sky's brightness distribution changes with sun position |
| **Sun-bounce layers** at 6–10 sun positions along the sun's path | The sun patch is the room's main fill light; its bounce changes as it moves. Low resolution (bounce is smooth); blended between keyframes |
| Each of the above **at three wall reflectances** (0, 0.45, 0.9) | Gives the paint-dependent bounce (§4.2) |
| **Leaf transmission patterns** in the window plane, for the morning and sunset sun directions, as animated loops | The sun passes through different branches at different angles |
| **Exterior foliage**: animated cut-out (coverage) and shading signals | Same wind animation as the shadows, so inside and outside stay in sync |
| **Night window reflection** layer | The glass mirrors the lit room at night |
| **Validation renders**: the full sun (direct and bounce) at each keyframe | To check the shader's computed sun patch against Blender |
| **Shadow masks of furniture** in the sun's path, per keyframe (only if furniture is there) | Or simple stand-in shapes in the shader |

## 4. The rendering model (shader)

### 4.1 Per pixel

```
radiance = albedo × [ Σ_lamps E_lamp(ρ) · lampLevel · SPD_lamp(CCT)
                    + E_sky(ρ; sun) · SPD_sky(sun)
                    + E_sunDirect(x; sun, leaves) · SPD_sun(sun)
                    + E_sunBounce(ρ; sun) · SPD_sun(sun) ]
→ chromatic adaptation → exposure → tone and gamut mapping → display
```

On wall pixels, albedo is the paint's reflectance spectrum (with the photo's wall texture as a detail ratio); elsewhere it is the surface colour from §3.2. The spectral product is computed per wavelength band (as v3 does now), then converted to XYZ with the CIE 1931 2° observer.

### 4.2 Paint-dependent bounce

Light reaching any pixel depends on the wall paint: a white room's walls light each other far more than a navy room's. Per pixel and per light layer,

```
E(ρ) = A + B·ρ / (1 − ρ·F)
```

where A is light that never touched a painted surface, B the first bounce off one, and F how much painted surface sees itself. A, B and F come from the three renders at ρ = 0, 0.45 and 0.9 (A directly from the ρ = 0 render). B and F are smooth, so they are stored at low resolution. The shader evaluates this per wavelength band with the paint's ρ(λ). This matches the published closed form for interreflection (Moon/Langer).

**Decision needed**: which surfaces get the paint (the main wall only, or all walls including off-frame ones). It changes A, B and F.

### 4.3 Direct sun, computed

For each surface point, the shader traces toward the sun:

* **Patch**: lit if the ray passes through the window opening (with mullions).
* **Leaves**: transmission is read from the leaf pattern in the window plane, for the current sun direction (blended between the morning and sunset patterns while the sun moves).
* **Edge softness**: blur width ≈ (distance from leaves to the surface) × 0.0093 (sun diameter 0.524°–0.542°), stretched into an ellipse along the plane of incidence. Implemented with a blur (mip) pyramid, regenerated per video frame (cheap at 512–768 px).
* **Expected look**: with the tree 5–10 m from the wall, small gaps project as round or elliptical sun images 5–9 cm across; a 5 cm leaf loses its dark core beyond ~5.4 m; branches and clumps over ~15–20 cm stay readable but soft. A mix of dapples and soft shapes, not crisp leaf outlines.
* **Furniture** in the patch: per-keyframe shadow masks from Blender or stand-in shapes.
* Checked against the Blender validation renders at each keyframe.

### 4.4 Light spectra

| Light | Model |
|---|---|
| **Direct sun** | Extraterrestrial solar spectrum × atmospheric transmittance (Rayleigh, aerosol, ozone) for the air mass: NREL SMARTS, or the simpler SPCTRAL2 (Bird & Riordan). CIE D-series is wrong here (defined 4000–25000 K, describes sun plus sky, fails in twilight) |
| **Sky light** | CIE D-series is acceptable at 4000 K and above; twilight needs ozone (Chappuis) absorption, which causes most of the blue at blue hour. Blender's sky model or a precomputed spectral table per keyframe |
| **Lamps** | A Planckian (blackbody) spectrum at the chosen colour temperature, or measured spectra of the real bulbs if real products are represented (an LED differs from a blackbody of the same CCT by ~ΔE 2–4 on saturated colours at CRI 80–90) |
| **Moon** (optional) | ~4100–4700 K physically, but shown in the conventional desaturated blue, on the exterior only |

Direct-sun colour temperature by elevation (computed; ±200–300 K):

| Sun elevation | Clean air | Hazy air |
|---|---|---|
| 2° | ~2040 K | ~1680 K |
| 5° | ~2900 K | ~2500 K |
| 10° | ~3700 K | ~3300 K |
| 15° | ~4100 K | ~3800 K |
| 30° | ~4700 K | ~4500 K |
| 45° | ~5000 K | ~4800 K |

For the sun to land on the wall rather than the floor it must be low (below ~22° for a 2.1 m window head and a 4 m deep room), so **morning light on the wall is ~3300–4400 K**, and the **2000–3000 K sunset glow belongs to the last ~30 minutes** before sunset (sun at 3–5°). One hour before sunset the sun is at 6–11° (35–50°N), ~3000–4100 K.

### 4.5 Time-of-day parameters

| | Morning | Afternoon Sunset | Night |
|---|---|---|---|
| Sun elevation | low (≤ ~22°) | ~3–8° | below the horizon |
| Direct sun CCT | ~3300–4400 K | ~2000–3500 K | none |
| Sky | blue; ~7000–10000 K toward the sun-side sky the window sees | warm near the sun, darker opposite | blue hour (~9000–16000 K) fading to dark |
| Contrast | high | lower: the patch dims, haze optional | none |
| Exterior | daylight foliage | backlit, warm | dark sky; optional moon or streetlight |

**Why sunset shadows look softer**: mainly geometry (the low sun stretches each edge across the wall) and a dimmer patch against relatively more fill. The glow around the sun (circumsolar light) is only 1–5% of direct light in clear air; it matters only in haze. Through a window facing the sun, direct sun outweighs sky light ~10:1 at 5–15° elevation, so indoors the main fill is light bounced off sunlit surfaces (hence the sun-bounce keyframes). An optional **haze** parameter gives a softer, lower-contrast sunset deliberately.

**Window orientation (decision needed)**: one window gets direct sun both in the morning and within an hour of sunset only if it faces roughly south (northern hemisphere), from about October to February. In summer the setting sun is behind the facade; east-, west- and south-east-facing windows cannot get both. The sun directions can follow physics or be art-directed; either way the patch must land on the main wall at both times.

**Night**: moonlight is 0.05–0.3 lux and streetlight on a wall ~0.5–10 lux, against 100–300 lux from interior lamps. A moon or streetlight patch can only be seen with the lamps off. Apply the night-vision look (blue shift, lower colour) to the exterior only, never to the paint.

### 4.6 Colour output

* **Chromatic adaptation**: two-step CAT16 (Smet / Zhai & Luo), with incomplete adaptation under warm light (evidence: Zhai & Luo 2018; Wei & Chen 2019; Huang & Wei 2021; Wei, Li & Zhang 2022). The CAM16 D formula depends only on luminance, so set D by colour temperature. Starting values, to be tuned by user testing (no data exists below 2700 K):

  | CCT | Starting D |
  |---|---|
  | 6000 K | ~0.95 |
  | 4000 K | ~0.85 |
  | 2700 K | ~0.6–0.75 |
  | 1500 K | ~0.4–0.5 |

* **Exposure**: follows scene brightness with a short lag, like eyes adjusting; also makes transitions feel natural.
* **Tone mapping**: the project's own Oklab roll-off, with the shoulder above the paint range (≥ ~0.95). **Do not use the stock Khronos PBR Neutral operator**: it subtracts a 0.04 offset (meant to cancel a glossy Fresnel term this matte wall does not have), darkening every paint and crushing dark ones (linear 0.05, L\* ≈ 27, becomes ≈ 0.016, L\* ≈ 13), and its compression starts at 0.76, below popular whites (LRV 80–94).
* **Gamut**: Display-P3 output where supported (WebGL `drawingBufferColorSpace`: Chrome 104+, Safari/iOS 16.4+, Firefox 132+; Android WebView to be tested on devices), Oklab gamut mapping. Compute which paints exceed sRGB from measured data, not hex (hex values are already clipped).

## 5. Paint accuracy

### 5.1 Data

Paint makers publish hex/RGB/LRV only; hex values are designer renderings, not colorimetric conversions. Spectral data exists inside their tinting systems. Options, best first:

1. **License the spectra** from the manufacturer (400–700 nm, 10 nm).
2. **Measure the 1500 chips** with a sphere spectrophotometer (e.g. X-Rite Ci64: inter-instrument agreement ~0.13 ΔE\*ab average; repeatability ~0.04). Measure SCI (specular included). Chips made with real paint are close to the real paint (~0.25 ΔE claimed); printed cards are not (~2). Roughly a few days of work.
3. **Estimate spectra** from Lab (Jakob & Hanika 2019, or PCA bases). Under incandescent light expect a mean error ~1 ΔE with outliers of 5–10, worse at 1500 K and for blues and greens. Avoid methods that produce blocky spectra (Mallett & Yuksel 2019).

Use the **2° observer throughout**. Paint data is often D65/10°; mixing observers alone can cost ~1 ΔE00.

Download size for spectra: 1500 × 31 values ≈ 90 KB.

### 5.2 Definition of "accurate"

* A painted room does **not** look like the chip, and should not: interreflection shifts light colours by up to 17–19 ΔE where walls face each other (Langer 2001), and large painted areas look lighter and more colourful (Xiao et al. 2011).
* So accuracy has two parts:
  1. The paint's own colour is exact: a **reference swatch in the interface**, rendered through the same pipeline under the neutral reference light, matches the measured paint within ΔE00 < 1 on an ideal sRGB/P3 display.
  2. Everything the wall does beyond that (bounce, light colour, adaptation) is correct physics.
* An average uncalibrated screen is off by ~4.7 ΔE00 (Apple devices near 1). Define accuracy against an ideal display and add a "confirm with a physical chip" note, as Sherwin-Williams and Benjamin Moore do.
* Automated check: render all 1500 paints under all 15 lighting states and compare with the colour-science prediction (as `tests/reference_check.py` does now).

## 6. Transitions

The state is a set of continuous parameters (sun angle, colour temperature in mireds, lamp level, sky and sun spectra, exposure, paint spectrum), each animated with a damped spring. Any combination of changes runs at once; a new click mid-transition redirects the motion instead of restarting it.

* **Time of day**: the sun moves along its arc over ~2.5–4 s; the patch sweeps the wall, the light warms, shadows soften, the sky dims, the leaf pattern blends between its morning and sunset versions. Sunset → Night: the patch climbs the wall and fades into blue hour. Night → Morning: play dawn forward.
* **Lamps on/off**: a quick fade, optional "dim-to-warm" ramp, slight stagger between fixtures; exposure then adapts.
* **Colour temperature**: along the blackbody curve, interpolated in mireds (10⁶/K). Equal mired steps vary ~1.8× in visible size across 1500–10000 K, against ~44× for equal kelvin steps.
* **Paint**: blend the reflectance spectra; optionally a reveal that sweeps across the wall's 3D plane in correct perspective (roller-width edge, brief wet sheen).
* `prefers-reduced-motion`: short simple fades.

## 7. The moving leaves and exterior

* **Source**: Blender renders of the animated tree (§3.4). Fallbacks: a real 20–30 s clip of leaf shadows (extract the pattern by shadow matting, Chuang et al. 2003) or a still pattern with wind computed in the shader.
* **Seamless loop**: author the animation so it crossfades into itself (or select loop points: Schödl's Video Textures; Liao, Finch & Hoppe for per-pixel loops).
* **One greyscale video, tiled side by side** with gutters: morning and sunset leaf patterns, exterior foliage coverage and shading. Never pack separate signals into R, G and B: 4:2:0 chroma subsampling and the YCbCr matrix bleed them into each other. Limited-range luma gives ~220 grey levels.
* **Exterior sky**: computed from the sun position; the foliage is tinted by the same sun and sky light as the room.

## 8. Delivery

### 8.1 Renderer

* **WebGL2, GLSL ES 3.0**, reusing `js/paintPipeline.js` (spectral paint × light, CAT16, Oklab mapping, P3 output, context-loss recovery), the blur pyramid and the test harness. WebGL2 is on by default from iOS 15.
* **Apps (version 1)**: the same renderer in WKWebView (iOS) and Android WebView. App Store rule 4.2 is fine for a WebView app with real functionality.
  * iOS: before creating the web view, `allowsInlineMediaPlayback = true` and `mediaTypesRequiringUserActionForPlayback = []`; the video needs `muted playsinline`.
  * Android: `setMediaPlaybackRequiresUserGesture(false)`.
* **Later native port**: react-native-webgpu (Dawn) is active but pre-1.0, and its video support is under a month old. WGSL would be shared only if the web build also moved to WebGPU. Revisit later.
* **Context loss** on iOS is a recurring WebKit issue: keep full `webglcontextlost` / `webglcontextrestored` handling that re-uploads every texture (test by killing Safari's GPU process).

### 8.2 HDR light layers

Browsers decode images to 8 bits before WebGL sees them, so **AVIF/PNG cannot deliver HDR**. Use one of:

* **KTX2 with Basis UASTC HDR 4×4** (preferred): standard ASTC HDR, uploaded directly where supported (iPhone 11 / A13 and newer through ANGLE-Metal; on Android check `getSupportedProfiles().includes('hdr')`), otherwise transcoded in WASM to BC6H (desktop), RGB9E5 or RGBA16F. three.js KTX2Loader handles it in WebGL2.
* **Fallbacks**: RGBE (.hdr) or EXR decoded in JS; RGBE/LogLuv packed in lossless 8-bit PNG/WebP and decoded in the shader; raw half-float data compressed with Brotli.

GPU formats: RGBA16F is filterable and renderable everywhere that matters; **avoid RGBA32F** (only ~53% of iOS devices can filter it).

**Memory**: eight 1920×1080 RGBA16F layers with mipmaps ≈ 177 MB, risky on 3–4 GB iPhones. Store smooth layers (sky, bounce, the B and F maps) at half resolution or lower, and use ASTC HDR (~2.8 MB each with mipmaps).

### 8.3 Video

* MP4 (H.264 is enough at this size; not HLS). `requestVideoFrameCallback`: Chrome 83+, Safari/iOS 15.4+, Firefox 132+.
* `<video loop>` can hitch at the loop point in Safari. Use WebCodecs VideoDecoder (Safari/iOS 16.4+) for frame-exact looping, with two alternating `<video>` elements as the fallback.
* A decoded texture atlas instead of video is too large (20 s × 20 fps × 768² ≈ 236 MB).

### 8.4 Download budget (estimate)

| Asset | Size |
|---|---|
| Light layers (lamps, sky keyframes, sun-bounce keyframes, A/B/F maps), mostly half or quarter resolution, HDR | 2–4 MB |
| Surface colours and wall texture, full resolution | 0.5–1 MB |
| Greyscale video (leaf patterns, exterior signals) | 0.5–1.5 MB |
| Paint spectra | ~0.1 MB |
| **Total** | **~3–6.5 MB**, loaded progressively (the initial state first) |

## 9. Phases

1. **Decisions and data** (§10), Blender 5.2 LTS installed, the reference image analysed (§3.0).
2. **Prototype** from a quick Blender scene: computed sun with a leaf pattern, lamp layers, paint-dependent bounce, the time-of-day transition. Judge the look before refining the reconstruction.
3. **Asset pipeline**: scripted Blender scene matched to the reference image (§3.0), all renders of §3.4, packing (KTX2, video tiles), with calibration done here, not in the app.
4. **Production renderer and controls**: spring-based transitions, progressive loading, colour tests over all 1500 paints and 15 lighting states, performance on low-end phones, context-loss tests.
5. **Apps** in WebViews; native WebGPU port later if needed.

## 9A. Phase 2 prototype: status and findings (10 Nov 2026)

Built: `roomMovie.html`, `js/roomMovie.js`, `glsl/roomMovie.glsl`, and the Blender scripts in `tools/roomMovie/` (README, "Room movie prototype").

* **Camera** solved from the reference to ~7 px RMS: 51° horizontal field of view, 0.98 m high, looking into the corner.
* **The reference is not exact geometry.** The panes seen on the window (~0.26 m) disagree with their own shadow (~0.33–0.38 m). The window's size was taken from the shadow: sill 0.91 m, head 1.87 m, jamb 0.34 m from the corner.
* **The morning sun implied by the reference's patch is 20° high** (azimuth 37° off the window's normal), a low sun of ~4500 K, consistent with the physics in §4.4. Sunset: 4°, slightly more grazing, chosen so its warm band crosses the middle of the wall.
* **The lamp shades part of the sun patch.** The reference omits this shadow, but the lamp stands in the light's path; the prototype keeps it.
* **Paint-dependent bounce** (§4.2): the three-render fit reproduces the renders with a median error of 0.07–0.3%; bounce terms are smoothed within each surface to suppress render noise.
* **Leaf shadows**: what the patch "sees" must be ONE layer of foliage. A uniform scatter of leaves, or a deep crown whose clusters overlap along the ray, blurs to even part-shade at these distances. The prototype puts a thin spray of dense leaf clusters (12-24 cm, with gaps) across each sun's path 2.8 m from the window, and keeps the rest of the crown out of the paths; the blur there is ~3.7 cm, so the clusters throw distinct dapples.
* **Shadow blur** must be a disc (the sun's image), not a coarse mip level: at grazing angles, box-filtered texels stretch into visible blocks along the wall. The shader averages 12 taps on a disc.
* **Render noise**: the paint-bounce fit amplifies it. The walls' light is split into direct light (kept sharp) and bounced light (fitted and smoothed within each wall plane, never across a corner).
* **Exposure** follows the ambient light on the walls (lamp, sky, bounce), as a photographer would; the sun patch (~5x brighter in the morning, ~1.5x at sunset; the moon patch ~6x) rolls off above it, with a shoulder from 0.6 that keeps gradation up to ~3.4x. Below ~1/100 of daylight, adaptation is reduced, so a moonlit room reads dim rather than grey.
* **Paint changes sweep** across the walls from the far left to the window with a soft edge (spectral blend at the edge).

* **Full resolution without full-resolution layers**: only the geometry (normal, distance from the camera, albedo, class) is rendered at 1920 x 1080; the sun, the leaves, the shadows and all outlines are computed per full-size pixel, and the smooth light layers (960 x 540) are upsampled edge-aware: a texel counts only if it is the same surface (class, facing, plane). ~5 ms per frame on an M2 Pro; the geometry adds 25 MB, against ~150 MB for full-size layers.

* **Moving window view**: the exterior is stored per time of day as what is behind the tree and the foliage's colour (derived from renders with and without the tree, smoothed with the coverage as weight), and mixed by the tree's coverage of the view: one greyscale video (0.5 MB, through the camera's depth of field) from the same wind animation as the leaf-shadow loops, so the tree outside and its shadows inside move together. Coverage depends only on geometry, so one video serves every time of day. The page re-syncs the loops when they drift by more than 60 ms.

* **Night window reflection**: the lamp-lit room reflected in the window glass is a ninth layer, rendered with a 6 mm glass pane that only camera rays see (so the room's lighting is unchanged) at the three wall albedos, and fitted like the others, so the reflection follows the paint and the lamp's colour. It is added to the window view in proportion to the lamp; by day it is lost against the exterior, as in reality.

* **Asset compression (no new tools)**: the float16 layers are packed (mantissa rounded to 8 bits for the light, under 0.4 %; whole for the geometry; row-wise differences; byte planes) and gzipped, decoded in the page with the browser's own DecompressionStream: 86 MB -> 13.4 MB (6.4x); with the four videos the page loads ~21 MB. Frames match the uncompressed renders to within 1 level (of 255) in 99 % of pixels. The plan's 3-6.5 MB budget assumed half-resolution layers and KTX2; reaching it needs the Basis Universal encoder/transcoder (a download) and lower-resolution smooth layers.

Not yet done: measured paint spectra; KTX2 (GPU memory).

## 10. Decisions (made 10 Nov 2026)

1. **Sun directions: art-directed within physics.** Each time of day keeps the sun height, colour, brightness and shadow softness that belong together; the compass direction is chosen so each patch is well composed on the main wall, with the morning and sunset patches clearly apart so the transition reads as the sun moving.
2. **Painted surfaces: all walls**, including the window wall, the window reveal and the walls behind the camera. Ceiling and trim stay white; the cabinet and window frames stay black. No switch.
3. **Paint spectra: estimated from Lab for the prototype; request measured spectra in parallel** (400–700 nm, 10 nm, SCI, as CxF or a spreadsheet) from the colour lab or tinting team, or measure the chips. Swapping them in is a data change.
4. **Lamp colour temperatures: 1800, 2700, 4000 and 6000 K**, as ideal blackbody light. Switch to measured bulb spectra if the app ever represents specific bulbs.
5. **Night window: dark blue sky with the tree silhouetted, plus faint moonlight leaf shadows when the lamps are off.**
6. **Source image: the reference image in §3.0**, rebuilt fully in Blender (it is not a RAW photo).
7. **Interior lights: the table lamp only** (decided 10 Nov 2026). Consequence: at night with the lamp on, the light falls mainly on the cabinet top and the walls near the lamp; most of the main wall gets only weak bounce light, so it reads dark, as it would in the real room, and exposure adaptation lifts it only partly. Default: the dome shade is opal (light-diffusing) glass, so it glows and spreads some light upward and sideways; an opaque metal shade would confine the light to a downward pool and make the room darker. One lamp layer in Blender (§3.4).

Still open:

8. **The image's origin**: is there a higher-resolution version, or a 3D scene file behind it? A scene file would replace most of the modelling work.

## 11. Risks

* **Paint spectra** unavailable: colour under warm lamps is less certain (§5.1).
* **Reconstruction**: unmodelled objects and invented off-frame walls make bounce plausible rather than measured; furniture in the sun's path needs extra work.
* **Leaf motion realism** from a CG tree: the prototype decides whether a real clip is needed.
* **1500 K and night viewing** are outside all published adaptation data: tune by user testing.
* **Android WebView** P3 output and ASTC HDR support vary by device: test on hardware.

## 12. Sources

Relighting and rendering
* Debevec, Virtual Cinematography: Relighting through Computation — https://www.pauldebevec.com/Publications/DEBEVEC-IEEE-Computer-200608-high.pdf
* Survey of image-based relighting — https://www.cse.iitb.ac.in/~sharat/papers/grapp.pdf
* Blender passes and light groups — https://docs.blender.org/manual/en/latest/render/layers/passes.html
* Light-group noise and denoising discussion — https://developer.blender.org/T78008 , https://developer.blender.org/T101418
* Blender light objects and units — https://docs.blender.org/manual/en/latest/render/lights/light_object.html
* Blender sky texture — https://docs.blender.org/manual/en/latest/render/shader_nodes/textures/sky.html
* Blender 5.0 rendering release notes — https://developer.blender.org/docs/release_notes/5.0/rendering/
* Blender GPU rendering — https://docs.blender.org/manual/en/latest/render/cycles/gpu_rendering.html
* Sapling Tree Gen versions — https://extensions.blender.org/add-ons/sapling-tree-gen/versions/
* Poly Haven licence — https://polyhaven.com/license

Sun, sky, shadows
* NASA Sun fact sheet — https://nssdc.gsfc.nasa.gov/planetary/factsheet/sunfact.html
* Dappled-light shaders — https://jzhao.xyz/posts/dappled-light
* Shadow matting and compositing (Chuang et al. 2003) — https://grail.cs.washington.edu/projects/digital-matting/shadow-matting/
* Fast computation of seamless video loops — https://hhoppe.com/fastloops.pdf
* Spitschan et al. 2016, twilight spectra — https://pmc.ncbi.nlm.nih.gov/articles/PMC4895134/
* Hernández-Andrés et al. 2001, sky colour temperature — https://pubmed.ncbi.nlm.nih.gov/11205988/
* "Why is the sky blue?" (ozone at sunset), ACP 2023 — https://acp.copernicus.org/articles/23/14829/2023/
* NREL SMARTS — https://www.nlr.gov/grid/solar-resource/smarts
* pvlib Ineichen clear-sky model — https://pvlib-python.readthedocs.io/en/stable/reference/generated/pvlib.clearsky.ineichen.html
* Circumsolar radiation (Blanc et al. 2014) — https://www.middletonsolar.com/documents/DNI_CircumsolarIssue_2014.pdf
* Hosek–Wilkie sky model — https://cgg.mff.cuni.cz/projects/SkylightModelling/
* Bruneton atmospheric scattering — https://ebruneton.github.io/precomputed_atmospheric_scattering/
* Kyba et al. 2017, moonlight — https://academic.oup.com/astrogeo/article/58/1/1.31/2938119
* ILP GN01/21, obtrusive light — https://nsip-documents.planninginspectorate.gov.uk/published-documents/EN010116-000832-GN01_-_ILP_Guidance_Note_1_the_reduction_of_obtrusive_....pdf
* Thompson, Shirley & Ferwerda, night scenes — https://www.cis.rit.edu/people/faculty/ferwerda/publications/jgt02_paper.pdf
* Ohno (NIST), LED colour rendering — https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=841839

Colour
* Khronos PBR Neutral source — https://github.com/KhronosGroup/ToneMapping/blob/main/PBR_Neutral/pbrNeutral.glsl
* Jakob & Hanika 2019 — https://rgl.epfl.ch/publications/Jakob2019Spectral
* Ayala et al. 2006, spectral reconstruction under illuminant A — https://opg.optica.org/josaa/abstract.cfm?uri=josaa-23-8-2020
* Zhai & Luo 2018, chromatic adaptation — https://opg.optica.org/oe/fulltext.cfm?uri=oe-26-6-7724
* Wei, Li & Zhang 2022, adaptation to real lighting on a phone — https://library.imaging.org/admin/apis/public/api/ist/website/downloadArticle/ei/34/15/COLOR-181
* Langer 2001, interreflection — https://cim.mcgill.ca/~langer/MY_PAPERS/Langer-COLOR-01.pdf
* Sherwin-Williams downloadable palettes — https://www.sherwin-williams.com/painting-contractors/color/color-tools/downloadable-color-palettes
* X-Rite Ci64 — https://www.xrite.com/categories/portable-spectrophotometers/ci6x-family/ci64
* WebGL colour management support — https://web-platform-dx.github.io/web-features-explorer/features/webgl-color-management/

Photo and reconstruction
* Apple ProRAW (WWDC21) — https://developer.apple.com/videos/play/wwdc2021/10160/
* CIRAWFilter localToneMapAmount — https://developer.apple.com/documentation/coreimage/cirawfilter/localtonemapamount
* Pixel DNG gain tables (darktable) — https://github.com/darktable-org/darktable/pull/22678
* Vanishing-point accuracy — https://arxiv.org/html/2207.12934
* MoGe — https://github.com/microsoft/MoGe
* Depth Pro model licence — https://huggingface.co/apple/DepthPro
* fSpy releases — https://github.com/stuffmatic/fSpy/releases

Delivery
* WebGL2 specification — https://registry.khronos.org/webgl/specs/latest/2.0/
* UASTC HDR 4×4 specification — https://github.com/BinomialLLC/basis_universal/wiki/UASTC-HDR-4x4-Texture-Specification
* Basis Universal — https://github.com/BinomialLLC/basis_universal
* WebGL extension survey — https://web3dsurvey.com/webgl2/extensions/WEBGL_compressed_texture_astc
* requestVideoFrameCallback support — https://caniuse.com/mdn-api_htmlvideoelement_requestvideoframecallback
* WebCodecs support — https://caniuse.com/webcodecs
* WKWebView autoplay — https://developer.apple.com/documentation/webkit/wkwebviewconfiguration/mediatypesrequiringuseractionforplayback
* WebKit context-loss bug — https://bugs.webkit.org/show_bug.cgi?id=261331
* react-native-webgpu — https://github.com/wcandillon/react-native-webgpu
* WebGPU implementation status — https://github.com/gpuweb/gpuweb/wiki/Implementation-Status
* App Store Review Guidelines — https://developer.apple.com/app-store/review/guidelines/
