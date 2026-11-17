# sceneVisualizer.html: the v4 tinting model, as built

The research and the plan behind it are in `docs/scene-visualizer-plan.md`.
This document records what was built, the measured results, and what is
still uncertain. Every number here can be reproduced with the scripts in
`tools/` (run with `.venv/bin/python -I <script>`).

## 1. Files

| File | Role |
|---|---|
| `sceneVisualizer.html` | The page: the scene on top (a room's morning, noon and night photos side by side; videos one at a time; each at most half its native size), controls underneath: the original-colour control (hidden by CSS for now), random and custom paints, sliders, uploads (`room.jpg` + `mask.png`) |
| `js/wallPaint.js` | The model: transfer, original-paint estimator, paint gamut, random paints, CIELAB / CIEDE2000 |
| `js/sceneVisualizer.js` | The WebGL2 renderer (one pass per frame) |
| `glsl/sceneVisualizer.glsl` | The shader |
| `js/sceneStore.js` | Keeps an uploaded scene in IndexedDB |
| `tools/v4ref.py` | Python reference of the model; the tests check the JS and GLSL against it |
| `tools/build_paint_gamut.py` | Builds the paint gamut table from the Sherwin-Williams palette |
| `tools/pairs/` | Ground-truth measurements on `images/source/pairs/`: hand-marked patches, approximate test masks, the fits and the reports |

The other pages, and the v1 / v2 / v3 models, are unchanged.

## 2. The model

### The Wall Colour Delta

For every pixel, in **CAT16 sharpened cone space**, using linear light with
white = (1,1,1):

```
delta = photo / old_paint                      # the Wall Colour Delta: the light at this pixel
out   = delta * new_paint * G(new) / G(old)    # G(r) = 1 / (1 - 0.40 r)
```

* **What the delta is.** It is everything the room did to the paint at that
  pixel: brightness, the light's colour, shadows, sun patches, the
  photographer's exposure and white balance. Dividing by the *old paint*,
  instead of assuming the walls were white, is what makes the result
  independent of the original wall colour.
* **Why CAT16.** Illumination change is closest to a per-channel scaling in
  sharpened cone space (Finlayson et al. 1994; Ward 2002). Linear sRGB and
  XYZ are worse. On the pairs, CAT16 and linear sRGB tie.
* **The bounce term `G`.** Part of the light on a wall has bounced off other
  walls, so it was filtered by the paint. Repainting changes that light.
  * The integrating-sphere gain `1/(1 − κρ)` is used, with κ = 0.40 fitted on
    the pairs. Leaving each pair out of the fit, it improves the median from
    5.7 to 5.5 ΔE, which is within the noise.
  * Example: a white room repainted a mid sage comes out about 10% darker
    than a plain swap, which is how real rooms behave.
* **A tone-compression exponent was tested and rejected.** The best fit was
  "none" (γ = 1.0).

### Properties, verified by tests

* **The original paint as the new paint returns the photo exactly** (0
  levels of difference).
* **Your two-uploads case, A → B → C equals A → C.** Across 300 random paint
  triples, the worst ΔE2000 is 2×10⁻¹³. On a real photo, with an 8-bit
  intermediate image, the wall median is ΔE 0.00 and p99 is 1.4.
* **The shader equals the JS model** (0 levels), and the JS model equals the
  Python reference (within 2×10⁻⁶).
* **Speed:** 0.3 ms per 1920×1080 frame with both sliders on (M2 Pro).

### Display

* **Gamut mapping** into sRGB or Display P3 at constant Oklab hue, the same
  roll-off as the other pages. Displayable colours are untouched.
* **Dithering:** ±½ of an 8-bit step.
* **Nothing outside the wall changes.** The page lays the original image over
  the canvas, masked by the wall segmentation (CSS mask, black = wall). For
  videos, the original frame is copied into that top layer in the same
  frame callback that repaints the canvas, so the two layers can't drift.

### Sliders

Contrast and Saturation change the **light** (the delta), not the paint:
* contrast is an exponent on the light's luminance around its median;
* saturation scales the light's Oklab chroma.

Centred sliders take an exact shortcut. The "Difference from white" toggle
is gone.

## 3. The original wall colour

* **If you set it,** in the page's "Original wall colour" control, it is used
  as is. It is remembered per scene.
* **Otherwise it is estimated from the image alone:**
  * **Colour:** the wall's middle luminance band (30–70%) divided by the
    room's light. The light is Shades-of-Grey (p = 6) over the non-wall
    pixels. The middle band is used because direct-sun patches sit in the
    bright band and carry the sun's colour. The study video showed this:
    the brightest band made a greige wall read beige.
  * **Lightness:** `L*_paint = 38.38 + 0.501 × L*_wall as photographed`,
    fitted on the 25 photos with known paint.
    * Photographers expose walls toward a typical brightness, so the photo
      only constrains the paint's lightness through this compressed relation.
    * White-trim "anchoring", the textbook cue, was tested and was *worse* on
      these professionally edited photos: 10.5 vs 5.5 median ΔL\*.
  * **Several photos or video frames:** lightness comes from the
    brightest-lit one. Colour is the median over the well-lit ones (5 frames
    are sampled from a video).
* **Accuracy,** scored leaving each room out:
  * median **8–10 ΔE2000**, p90 about 23;
  * good in light rooms (2–6);
  * poor for very dark walls (23–28), which is a hard limit of single-photo
    estimation: a dark wall brightly exposed looks like a light wall.

  The page states this next to the estimate.

## 4. End-to-end accuracy on the before/after photos

Each after photo's wall is predicted from its before photo plus the paints,
after correcting each photo's exposure and white balance with surfaces that
didn't change (`tools/pairs/final_report.py`). Median ΔE2000:

| Original paint | 7 pairs | Without pair 7 |
|---|---|---|
| Given | **4.1** | 4.1 |
| Estimated from the before photo | **6.3** | 5.8 |
| Assumed white (the older pages) | 13.0 | 13.4 |

**Limits of this test.**
* The pairs are different photographs: different viewpoint, furniture,
  editing and often lighting. That alone puts about ±4 ΔE of noise on every
  number.
* Pair 7's exposure reference (brick) is unreliable. Pairs 4 and 6 were
  dropped for the same reason. Pair 9's after image is another tool's
  digital recolour, not a real repaint.
* ΔE against photographs measures photographic fidelity. **No data available
  here measures what a person in the room perceives.** The model keeps the
  wall consistent with its untouched surroundings, which is what perception
  judges against.

## 5. Random test colours

10 colours per page load, inside the realistic range of architectural paints:

* **The gamut:** the largest CIELAB chroma per hue and lightness among the
  1,526 Sherwin-Williams ColorSnap colours, built offline by
  `tools/build_paint_gamut.py`. Only that small table is in the project.
* **Hues:** 8 colours on evenly spaced hues with a random rotation, plus 2
  near-neutrals.
* **Lightness:** one per lightness band from L\* 21 to 96 (about LRV 3–90).
* **Chroma:** one per chroma band, with the strongest band given to where a
  strong paint exists.
* **Measured over 500 draws:** every set spans at least 60 L\*, and every set
  includes a colour of C\* 26 or more.
* `?seed=` reproduces a set. "New random colours" draws another.

**Custom colours:** up to 5, from a colour picker or hex box. They are kept in
localStorage, and a 6th replaces the oldest. Colours outside the paint range
are allowed but labelled.

## 6. What is still uncertain

1. **κ (bounce light)** is one global number fitted on a few noisy pairs. Real
   rooms vary with shape and furnishing.
2. **Clipped highlights** on the original wall carry no light information.
   They render as light as the paint allows.
3. **Mixed light colours across one wall** (lamp and window) are handled
   per pixel by the delta. A single original-paint estimate can still be
   pulled by them.
4. **Edited photos.** Local tone mapping (HDR) is not invertible from one
   image. The pairs showed no global tone compression, but individual photos
   can have it.
5. **Metamerism.** Paints are known only as hex values (3 channels, no
   spectra). Under strongly coloured light, real paints can shift in ways RGB
   can't predict.
