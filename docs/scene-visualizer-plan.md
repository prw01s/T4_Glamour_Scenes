# sceneVisualizer.html: research, findings and plan

Status: **approved and implemented.** What was built, and how it differs from
this plan (no tone parameter: the fit chose none; the estimator's lightness
comes from a fit, not white-trim anchoring), is in `docs/scene-visualizer.md`.
Measurement tools: `tools/pairs/` (run with `.venv/bin/python -I tools/pairs/evaluate.py`).

---

## 1. The goal, restated

For every wall pixel, separate:

* **ρ_old**: the paint that is on the wall (its reflectance), and
* **the Wall Colour Delta**: everything the room's light did to that paint
  at that pixel (brightness, light colour, shading, bounce light, texture),

then render **ρ_new** under exactly that Delta, as a person in the room
would perceive it. Everything outside the wall mask stays as photographed.
Success is measured in **ΔE2000** (CIEDE2000; D65 white).

---

## 2. Why the current pages are inconsistent (root cause)

Every existing model (v1, v2, v3) assumes **the original walls are white**
(`js/paintPipeline.js`, header: "The original walls are white"). The light
is read straight off the wall pixels. So when the same room is uploaded
twice with different wall colours, the code reads each wall colour as a
*different light colour* and multiplies it into the new paint. A sage wall
makes every new paint greener, and a beige wall makes it warmer. That is
exactly the inconsistency you saw.

Measured on the before/after pairs (§4), this assumption costs about
**2× the error** of a model that knows the original paint (median ΔE2000
12.6 vs about 6).

---

## 3. What the research says

Full report with sources: summarised here. Confidence is in brackets.

1. **The industry baseline is crude.**
   * Behr's patent (US9857888B2) keeps a lightness *ratio* in CIELAB, sets
     a\*b\* to the paint's own, and adds heuristic fudges.
   * Reviewers report that most brand visualizers apply flat colour that
     ignores shadows.
   * Keeping L\* and replacing a\*b\* is not physical: real shadows lower
     a\* and b\* along with L\*. So that approach over-saturates shadows.
     [established]
2. **The physically right core is a per-channel ratio in linear light:**
   `new = photo × ρ_new / ρ_old`.
   * This is the model in the Corel/Lindbloom patent (US8358306B2).
   * Finlayson's spectral sharpening work shows illumination change is
     modelled best as a diagonal (per-channel) scaling in a *sharpened*
     cone space, such as CAT16 or Bradford, and worst in XYZ. [established]
   * Oklab, CAM16-UCS and CIELAB are for *measuring* colour difference.
     Ratios in them have no physical meaning. [established]
3. **Knowing ρ_old is the key.** Once the old paint is known, separating
   paint from light inside the mask is one division per pixel. No
   intrinsic-image algorithm (Retinex, SIRFS) is needed, and those are
   unreliable on rooms anyway (best non-learned WHDR is about 21%).
   [established]
4. **Bounce light (interreflection) changes with the paint.** Light
   bounced between walls is filtered by the paint on every bounce.
   * A saturated or dark new colour makes the room darker *and* the walls
     more saturated than a simple ratio predicts.
   * The standard gain is `G(ρ) = 1/(1 − κρ)` per channel (integrating-sphere
     theory). For a room κ is not calibrated, so it has to be fitted.
     [established in principle; room magnitude weakly evidenced]
5. **Perception.**
   * People adapt only partially to the colour of the light, with a degree
     of adaptation D ≈ 0.7–0.9 in real rooms. Under warm or dim light a
     white wall still looks yellowish. [established]
   * Colourfulness rises with light level (the Hunt effect). [established]
   * The "colours look stronger on the wall" folklore is mostly the
     bounce-light physics in item 4. The lab "large-area effect" makes
     colours *lighter*, which contradicts the folklore. The evidence
     conflicts. [weak]
   * There is **no dataset** that measures "what a person perceives" in
     these rooms. ΔE against photos measures photographic fidelity.
6. **Estimating the old paint from the photo alone** is ambiguous for
   lightness: albedo × light can't be separated from one region.
   * The best non-learned cue is *anchoring*: the brightest large,
     diffuse, near-neutral surface (white trim or ceiling) is assumed to
     be white paint (LRV ≈ 85). The wall is then read relative to it under
     the same light.
   * Colour-constancy algorithms (Shades-of-Grey, Grey-Edge) add about
     3–5° of light-colour error, but only serve as cross-checks.
   * There is no published ΔE accuracy for this in rooms. [gap; I will
     measure it]
7. **ΔE metric:** CIEDE2000 as primary, CAM16-UCS as secondary.
   * ~1 is just noticeable for flat patches.
   * In complex images, about 2.3 is noticeable and about 6 is acceptable.
   * A realistic target for this tool is a **wall mean of 2–3 ΔE2000**.
8. **Published paint hex values are colorimetric.**
   * SW hex → luminance matches SW's published LRVs within about 0.3 on
     200 colours, so the hexes are measured D65 renditions, not artistic
     picks. LRV = CIE Y.
   * Your list matches too, except **#E3E0DA (84 vs 74.7), #767665 (13 vs
     17.7) and #C9CDB9 (50 vs 59.6)**. Per your note, the hex-derived values
     are used.
9. **The paint gamut.** No published gamut for architectural paints was
   found.
   * Pointer's real-surface gamut is an upper bound, and paints sit well
     inside it.
   * The defensible approach is to build `C*max(hue, L*)` from a
     manufacturer's full fan deck.

---

## 4. What the ground-truth pairs show (measured)

Tools: `tools/pairs/patches.py` (hand-marked wall patches, plus unchanged
surfaces used to cancel each photo's exposure and white balance),
`measure.py` and `evaluate.py`.

1. **Photographed lightness barely reflects the paint.**
   * Wall brightness relative to its paint's own reflectance ranges
     **0.08× to 1.8×** across the photos, because of exposure and lighting.
   * before1 (#BCB6B6, LRV 48) is photographed almost white.
2. **The camera or the editor neutralises the wall's colour.**
   * #9DBDB3, a clear sage (a\* −12.8), comes out nearly grey (a\* −2.1).
   * #CEC8BD loses most of its b\* in 3 of 4 photos.
   * The wall fills the frame, so auto white balance treats it as grey.
   * This is the same trap as §2, made by the camera.
3. **The same paint (#9FA195) varies by about 5–8 ΔE across six photos.**
   That spread is the real lighting delta the model must carry.
4. **Scoring** (predict the after wall from the before photo plus both
   paints, then compare with the actual after photo, exposure-corrected):

   | Model | Median ΔE2000 (10 pairs) |
   |---|---|
   | Current: original wall assumed white | 12.6 |
   | Ratio in linear sRGB (old paint known) | 6.8 |
   | Ratio in CAT16 cone space | 6.9 |
   | Keep the photo's CIELAB offset from the paint | 6.4 |
   | Ratio + bounce-light gain (κ = 0.35) | **6.1** |

   * **Pairs 4 and 6:** the exposure-correction reference failed (the sofa
     is lit differently, and the floor was refinished).
   * **Pair 9:** a digital recolour by another tool, not a real repaint.
   * On the **6 trustworthy pairs**, the known-paint models score about
     **1–6 ΔE**, against 4–27 for the current model.
5. **Limitation:** the pairs are different photos (different viewpoint,
   furniture, editing). Their noise floor is about ±4 ΔE. They can rank a
   poor model against a good one, but they **cannot prove** sub-3 ΔE
   accuracy or choose between the good models. The decisive tests have to
   be synthetic (§7).

---

## 5. Proposed algorithm ("v4", sceneVisualizer.html only)

All steps run in WebGL2 shaders, except per-image statistics, which run in
JS or a small GPU reduction. Existing pages and v1–v3 are untouched; v1–v3
stay in the code as references.

**Step 1. Decode.** sRGB → linear (exact inverse EOTF) → **CAT16 sharpened
cone space** (one 3×3 matrix).

**Step 2. Original paint ρ_old.**

* If a hex is supplied (per scene, editable on the page): use it.
* Otherwise estimate it automatically, once per photo, and once per video
  from a few frames:
  1. **Anchor:** the brightest large, flat, near-neutral non-wall region
     (trim, ceiling, white doors). Exclude windows, lamps and clipped
     pixels. Assume it is white paint, LRV 85.
  2. **Old paint = wall ÷ anchor × anchor's white**, per channel, taken
     where both are lit similarly (the robust median of the wall's upper
     brightness range against the anchor).
  3. **Fallbacks and confidence:**
     * Anchor missing or doubtful (night scenes, colour-drenched rooms
       where trim is the wall colour): use Shades-of-Grey over the
       non-wall pixels for the light colour, plus a typical lightness
       prior (wall LRV ≈ 60).
     * The page shows the estimate and its confidence, so you can
       override it.
  4. **Snap to the paint gamut:** clamp into the realistic paint gamut.

**Step 3. Wall Colour Delta per pixel.**
`Δ(x) = photo(x) ⊘ ρ_old` (per channel, CAT16 space).
This is the light at that pixel, *including* the editor's white balance and
exposure. Keeping both is what keeps the wall consistent with the untouched
pixels around it.

**Step 4. Bounce-light correction** (low-frequency, global):
`Δ_new = Δ ⊙ G(ρ_new) ⊘ G(ρ_old)`, with `G(ρ) = 1/(1 − κρ)`.

* κ is fitted on the trustworthy pairs, and checked on the ones left out
  of the fit.
* Optionally, κ is raised near the wall mask's inside corners, where
  bounce is strongest.

**Step 5. Light the new paint.** `out = ρ_new ⊙ Δ_new` → back to linear
sRGB.

**Step 6. Perception and output.**

* **Tone handling:** professional edits compress shadows and highlights.
  A single global tone-compression parameter, fitted on the pairs and
  checked on held-out pairs, keeps dark new paints from going blacker
  than the photo's own tone curve allows.
  * Pair 3 (light wall → dark brown) hints at this: there the Lab-offset
    model beat the ratio models by 6 ΔE.
* **Highlights and clipped pixels:** near-white clipped wall pixels keep
  their light-coloured component instead of being scaled by the paint.
* **Gamut mapping** into the display gamut (Display P3 or sRGB) in Oklab,
  constant hue, reusing the existing `compress()` approach.
* **What I deliberately do NOT do:** apply a separate "adaptation" to the
  wall alone.
  * The photo, with its white balance, is already the editor's rendition
    of how the room looks.
  * Shifting only the wall would put it at odds with its untouched
    surroundings. The research says the eye judges a surface *relative to
    its surround*, so consistency with the photo *is* the perceptual
    requirement.
  * The size/area effect is left out because the evidence conflicts.
    (Your call: §9 Q4.)

**Sliders.** Saturation and Contrast act on Δ (the light) before the paint,
with the same meaning as today. The "Difference from white" toggle is
removed.

**Cost.** About 2 matrix multiplies and a few divides per pixel, plus one
blur for the low-frequency bounce term. Well within 24 fps video.

---

## 6. The page

* **`sceneVisualizer.html`** + `js/sceneVisualizer.js` (controller) +
  `glsl/sceneVisualizer.glsl` (v4 passes) + `js/wallPaint.js` (estimation,
  paint gamut, random colours, pure functions with tests). Reuses
  `paintPipeline.js` helpers only, so no shared behaviour changes.
* **Scenes:** every existing room scene that has a mask:
  * Living Room, photos at morning, noon and night;
  * Study, photos at morning, noon and night;
  * Study day-to-night video;
  * the warm-light video (`hero_mobile_4k_warm-light.mp4`).

  One scene at a time, chosen from a scene list. Videos loop, with play
  and pause.
* **Upload:** one room image plus its mask, through a link or button, kept
  in IndexedDB (`js/sceneStore.js`) with a remove button.
* **Display:** the tinted image, with the original image on top masked by
  the segmentation map (CSS mask), as today.
* **Original wall colour:**
  * "Auto: #xxxxxx (estimated, confidence …)", with a colour picker and
    hex box to override it.
  * Remembered per scene.
* **Paints:**
  * Row 1: **10 random colours** per page load, stratified across hue,
    lightness (LRV about 4–88) and chroma, inside the realistic paint
    gamut. `?seed=…` reproduces a set.
  * Row 2: **up to 5 custom colours**: a native colour picker plus a hex
    box, each with a remove button. A 6th replaces the oldest. They are
    remembered across reloads (localStorage).
  * No names on chips. The readout shows the hex and its LRV.
* **No tinting-algorithm selector.**

---

## 7. How it will be tested (ΔE2000 throughout)

1. **Round-trip consistency (your exact complaint).** Take a scene. Render
   its wall in colour A, and separately in colour B, using the forward
   model. Then recolour both versions to colour C.
   * With the old paint supplied, the two results must match within
     **ΔE2000 < 0.5** on every wall pixel.
   * With the old paint auto-estimated, they must match within the
     estimator's error.
   * Run over hundreds of random paint triples.
2. **Estimator accuracy:** on all 25 pair photos (approximate masks drawn
   by me), estimated ρ_old vs the known hex, reported as ΔE2000 median and
   p95, split into lightness and colour.
3. **Pair prediction:** the §4 table, re-run with the shipped
   implementation. Report per pair, and fit κ and tone compression with
   leave-one-out.
4. **Swatch identity:** under neutral uniform light at the reference
   exposure, the wall renders as the paint's own hex (ΔE < 0.5).
5. **GPU = reference:** a Python reference implementation of v4
   (`tools/`) and the GLSL output agree within 1 code value.
6. **Gamut and stress tests:** all 10-colour random draws plus extremes
   (LRV 3 and 92, max chroma at each hue): no clipping artefacts, and hue
   preserved through gamut mapping.
7. **Performance:** video frame time stays under about 10 ms at display
   size.

---

## 8. Questioning my own assumptions

| Belief | How it could be wrong | What I'll do |
|---|---|---|
| Per-channel ratio is the right transfer | Edited photos apply tone curves and local HDR, so linear sRGB isn't scene-linear. The pairs showed the Lab-offset model *better* on pair 3. | Fit one tone-compression parameter on the pairs, cross-validated. Keep the ratio as the default only if it wins or ties. |
| The pairs are ground truth | Different shots, editing and furniture: ±4 ΔE noise. Two of ten references failed, and pair 9 is synthetic. | Use the pairs only to rank models. Rely on the synthetic round-trip for consistency, and say so in every report. |
| ΔE on photos = perception | It measures fidelity to an *edited photograph*, not to a person in the room. | State it plainly. Perceptual extras stay optional and off by default until there's evidence. |
| White trim is a reliable anchor | Colour-drenched rooms (after7, after11: trim painted the wall colour), night scenes, windows as brightest region, off-white trim. | Confidence score, fallbacks, override UI. Measured on all 25 photos before shipping. |
| κ (bounce light) is one global number | It depends on room shape, furniture and how much ceiling and floor are visible. | Fit globally first. Check whether a corner-weighted version wins on held-out pairs; if not, keep it simple. |
| CAT16 beats linear sRGB | On the pairs they tie (6.8 vs 6.9). The theoretical gain is small for near-neutral paints. | Use CAT16 (costs nothing). Report both on the synthetic tests. |
| The editor's white balance can be kept | A real photographer would re-balance after repainting (wall dominates the frame). | Correct for your requirement, since non-wall pixels must not change. Documented. |
| sRGB hex = paint colour | Hexes are D65 renditions. Three of your LRVs disagree with their hexes. | Use hex-derived LRV (your instruction). Flag any colour outside the paint gamut. |
| Approximate masks are good enough | Mask errors bias statistics near edges. | Erode masks by a few pixels for every measurement. |

---

## 9. Decisions I need from you

1. **Paint gamut source (for the random colours).** Choose one:
   * **(a) Recommended:** download Sherwin-Williams' public "downloadable
     colour palette" (name, number, hex for about 1,700 colours) from
     sherwin-williams.com. I'd use it once, offline, to build a small
     `C*max(hue, lightness)` table. The page would ship only the table, not
     the palette.
   * **(b)** Use Pointer's published real-surface gamut, an upper bound,
     shrunk by a fixed factor. No download, but less accurate.
2. **Scenes:** the four listed in §6. OK, or add or remove any? The primary
   hero video lost its mask with the sheen removal, so it's excluded unless
   you want it back.
3. **Video controls:** a simple loop with play/pause, or the day-to-night
   timeline?
4. **The "large-area effect"** (paint on a whole wall looks lighter and more
   colourful than a chip): off by default (the evidence conflicts), or as an
   on/off option?
