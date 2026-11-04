# Paint sheen: the science behind `sheenSceneRenderer.html`

This document collects the research the sheen renderer is built on, and how each finding became shader code.
- Code: `glsl/sheen.glsl` and `js/sheenModel.js`.
- Checks: `tests/sheen_check.py` and the sheen tests in `tests/tests.js`.

The **[S]** and **[E]** labels mark what is sourced and what is my estimate or calculation.

---

## 1. Summary

1. **Sheen is roughness, not reflectivity.** Every paint reflects about 4 % of light at its surface, the Fresnel reflection of a binder with n ≈ 1.5. That reflection is the **light's** colour. The rest of what we see is body reflection from the pigment, which is the **paint's** colour.
   - Flat paints scatter their 4 % in every direction.
   - Glossy paints concentrate it around the mirror direction.
2. **Total reflectance doesn't change with sheen**, so neither does an SCI measurement. Under perfectly even light, every sheen would look the same.
3. **In a real room the light is uneven.**
   - Where a glossy wall's mirror direction sees something darker than the wall's own light, its colour looks **darker and more saturated**: the white veil that flat paint spreads over the colour has gone into the highlights. Dark colours are affected most and whites barely change.
   - Where the mirror direction sees a window or a lamp, glossy paint shows a **sheen band, a reflection or a hotspot**, in the light's colour.
4. **Gloss lobes narrow with sheen**: Flat → Eggshell → Satin → Semi-gloss. Reflections go from absent, to a soft glow, to soft bands, to recognisable blurred images. The wall's texture starts to glint once the lobe is narrower than the texture's tilts.
5. **The renderer implements exactly that.**
   - The existing physical model (v3) gives the Flat look, which equals the swatch.
   - Each sheen then swaps the swatch's veil for what a GGX gloss lobe of the right width reflects. That reflection is traced through a camera and room model recovered from the photo, by importance-sampling the lobe for each pixel's viewing direction.
   - A second review pass corrected five things (§5A).
   - A third pass rendered four rooms (living room, living room 2, deck, study) by day and by night in every sheen, measured the results, and corrected what they showed (§5B).

---

## 2. Physics of gloss

### 2.1 Measurement (ASTM D523 / ISO 2813)

- **Gloss units.** Gloss is the light a surface sends into a receptor aperture around the mirror direction, relative to polished black glass (n_D = 1.567), which is defined as 100 GU at each geometry [S]. Because the reference glass reflects only at its first surface, gloss units measure the **interface (Fresnel) reflection**.
  - NIST, *Specular Gloss*: https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=841838
  - ASTM D523: https://www.astm.org/Standards/D523.htm
  - Konica Minolta, *Understanding gloss standards*: https://sensing.konicaminolta.us/us/blog/understanding-gloss-standards-units/
- **Which angle to use.** 60° is the general geometry. Use 20° above 70 GU and 85° below 10 GU [S]. A 5 GU difference is just visible to a trained observer [S]: https://www.hunterlab.com/en/blog/what-you-need-to-know-about-gloss-standards/
- **"Sheen" means the 85° reading.** Hunter (1937) defined sheen as shininess at grazing angles on otherwise matte surfaces. He listed six kinds of gloss: specular gloss, sheen, contrast gloss, absence of bloom (haze), distinctness of image, and absence of texture [S].
  - Wikipedia, *Gloss (optics)*: https://en.wikipedia.org/wiki/Gloss_(optics)
  - Sherwin-Williams, *Gloss & sheen*: https://www.sherwin-williams.com/architects-specifiers-designers/inspiration/styles-and-techniques/sw-art-gloss-sheen-differences
- **Receptor apertures** (in-plane × perpendicular): 20°: 1.8° × 3.6°; 60°: 4.4° × 11.7°; 85°: 4.0° × 6.0° [S]. Source: Westlund & Meyer, SIGGRAPH 2001, https://www-users.cse.umn.edu/~gmeyer/papers/westlund-meyer-siggraph-2001.pdf

**MPI gloss levels** [S] (MPI Architectural Painting Manual, Guide Spec 09 91 23: https://www.mpi.net/assets/images/GuideSpec/Int_Painting_099123_April2022.pdf; also https://www.roddapaint.com/how-to/selecting-gloss-level/)

| MPI | Name | 60° GU | 85° GU |
|---|---|---|---|
| G1 | Flat / matte | 0–5 | ≤ 10 |
| G2 | Velvet | 0–10 | 10–35 |
| G3 | **Eggshell** | 10–25 | 10–35 |
| G4 | **Satin** | 20–35 | ≥ 35 |
| G5 | **Semi-gloss** | 35–70 (target 50) | — |
| G6 | Gloss | 70–85 | — |
| G7 | High gloss | > 85 | — |

Two other definitions agree:
- **GA-214** (Gypsum Association) defines flat as 0–5 GU at 60° and 0–10 GU at 85°: https://www.americangypsum.com/sites/default/files/2022-05/ga-214-2021_17.pdf
- **Brand names aren't standardised**, which is why MPI's table exists: https://en.wikipedia.org/wiki/Paint_sheen

### 2.2 Why paints differ

- **PVC vs CPVC.** Flats are formulated at a pigment volume concentration (PVC) above the critical PVC (CPVC, typically 30–60 %). The binder no longer fills the voids, so pigment and extender particles protrude through the surface and scatter the interface reflection diffusely. Gloss paints use a low PVC (about 15–25 %) and have a smooth binder surface [S].
  - https://www.sciencedirect.com/topics/engineering/critical-pigment-volume-concentration
  - https://justpaint.org/pigment-volume-concentration-and-its-role-in-color/
- **Binder index.** Acrylic has n ≈ 1.49, so F0 = ((n − 1)/(n + 1))² ≈ 0.039–0.04 [S/E]: https://refractiveindex.info/?shelf=3d&book=plastics&page=pmma
  - Disney's BRDF uses n = 1.5 as its representative dielectric [S]: https://media.disneyanimation.com/uploads/production/publication_asset/48/asset/s2012_pbs_disney_brdf_notes_v3.pdf
  - The effective F0 is about 0.03–0.05 for every sheen. **Sheens differ in roughness, not F0** [E].
- **Dichromatic reflection model** (Shafer 1985). L(λ) = m_b·c_b(λ) + m_s·c_s(λ). Body reflection carries the pigment colour; interface reflection carries the illuminant's spectrum, so **specular is never tinted by the paint** (metallics excepted) [S].
  - https://onlinelibrary.wiley.com/doi/10.1002/col.5080100409
  - https://en.wikipedia.org/wiki/Dichromatic_reflectance_model

**Fresnel reflectance, n = 1.5** [E, exact Fresnel]:

| Angle | 0° | 45° | 60° | 75° | 80° | 85° |
|---|---|---|---|---|---|---|
| R | 0.040 | 0.050 | 0.089 | 0.25 | 0.39 | 0.61 |

Under fully diffuse light the hemispherical average is about 0.092 [E], which matches the Saunderson-correction literature [S]: https://infoscience.epfl.ch/server/api/core/bitstreams/4f7e81e7-97b3-48e2-b4e7-876d4dac4f46/content

- **SCI is invariant.** Sanding a glossy part moves energy from the specular lobe into diffuse directions, but total reflectance (SCI, specular included) is unchanged [S]: https://www.konicaminolta.com/instruments/knowledge/color/part3/02.html
- **Grazing sheen.** By the Rayleigh criterion a surface acts smooth when its height variation Δh < λ/(8 cos i). The coherent (mirror) fraction of the surface reflection is exp(−(4πσ cos i/λ)²) (Beckmann–Spizzichino) [S].
  - At 85°, cos i = 0.087, so the surface looks about 6× smoother than at 60°. Combined with Fresnel's rise to 0.61, this is why even low-sheen paints shine at grazing angles, and why eggshell's and satin's 85° readings exceed their 60° readings [S/E].
  - Source: https://www.stevenabbott.co.uk/practical-coatings/gloss.php

### 2.3 Other appearance attributes [S]

- **Haze (ASTM E430)** is light scattered about 2–5° from the specular direction, a milky bloom.
- **DOI** is the sharpness of a reflected image. Equal 60° gloss can come with very different DOI because of orange peel.
- **Flashing / sheen non-uniformity**: porous patches absorb binder and dry duller. It is worse in higher sheens and under raking light.
- **Texture.** GA-214 asks for a Level 5 (skim-coated) drywall finish under non-flat or deep-colour paints and under "critical lighting", meaning strong side light from windows or fixtures.

Sources:
- https://www.rhopointinstruments.com/faqs/what-is-orange-peel-and-doi-and-how-is-it-measured/
- https://www.ppgpaints.com/pro-tips/how-to-fix-poor-paint-sheen-uniformity
- GA-214 (above)

### 2.4 Roughness from gloss units

**Reference BRDF parameters.** Pellacini, Ferwerda & Greenberg (SIGGRAPH 2000) chose the Ward model because it "gives parameters that represent measured properties of a range of glossy paints" [S]. They used ρs ∈ {0.033, 0.066, 0.099} and α ∈ {0.04, 0.07, 0.10}. Their perceptual axes are contrast gloss c = ∛(ρs + ρd/2) − ∛(ρd/2) and distinctness d = 1 − α: https://jamesferwerda.com/wp-content/uploads/2015/06/j07_pellacini00_sig.pdf

**Virtual gloss meter (after Westlund & Meyer 2001).** A GGX + Smith + exact-Fresnel (n = 1.5) lobe is integrated over the ASTM apertures and divided by the black-glass standard. Single-lobe readings [E]:

| GGX α | 0.01 | 0.02 | 0.03 | 0.04 | 0.05 | 0.07 | 0.10 | 0.16 | 0.30 |
|---|---|---|---|---|---|---|---|---|---|
| 60° GU | 79 | 61 | 47 | 38 | 31 | 21 | 14 | 6.6 | 2.0 |

A single lobe can't match both 60° and 85° for eggshell and satin: its 85° reading comes out *below* the 60° reading. The coherent grazing term (§2.2) supplies the difference.

### 2.5 Substrate texture

Roller stipple and orange peel tilt the surface normal by about ±1–5° [E, from the standards' descriptions and appearance literature]. Glints appear once the gloss lobe is narrower than those tilts: satin's lobe is about ±3–4° and semi-gloss's about ±1.5–2°. On flat paint the tilts are smeared out, and texture only shows through diffuse shading under raking light.

---

## 3. Perception of colour and gloss

### 3.1 The veil

Matte paint spreads its surface reflection over every viewing direction. That adds an illuminant-coloured veil, so the colour looks lighter, less saturated and "chalky". Gloss gathers the veil into highlights, so away from them the colour looks darker and more saturated, or "deeper" [S].
- HunterLab, *SCI vs SCE*: https://www.hunterlab.com/en/blog/sci-vs-sce/
- Konica Minolta: https://sensing.konicaminolta.us/us/blog/specular-component-included-sci-vs-specular-component-excluded-sce/
- X-Rite, *SPIN vs SPEX*: https://www.xrite.com/blog/specular-included-or-specular-excluded-which-is-best
- Quality Magazine: https://www.qualitymag.com/articles/91148-color-vs-appearance

**Micom Labs** measured one dark bronze moulding in three finishes, D65 [S]: https://www.micomlab.com/wp-content/uploads/2014/06/True-Color-vs-Perceived-Color.pdf

| Finish | SCI L\* | SCE L\* | SCE C\* |
|---|---|---|---|
| 81 GU | 30.97 | **19.61** | **8.2** |
| 7 GU | 30.48 | 29.07 | 4.5 |
| 3 GU | 30.84 | 30.54 | 4.0 |

- In SCI all three are within ΔE 0.5. In SCE, gloss is ΔE ≈ 11.7 darker and doubles in chroma.
- ΔY(SCI − SCE, gloss) = 0.0375, almost exactly the 4 % Fresnel term [E].
- **BYK-Gardner** reported the same for black drawdowns at 90.6 vs 2.5 GU: an instrument ΔE of only 0.28, but visibly "darker and more saturated" [S]: https://www.pcimag.com/articles/94108-measure-color-and-gloss-at-the-same-time
- **Print** shows the same effect: maximum density is about 1.6–1.7 on matte paper vs 2.0–2.3 on gloss [S]: https://www.imatest.com/imaging/dmax/

**How the effect scales** [E: a neutral veil k added in linear sRGB]:

| Colour | k = 0.04: ΔL\* | C\* ratio |
|---|---|---|
| Navy (L\* 25) | +9.8 | 0.70 |
| Terracotta (L\* 51) | +4.3 | 0.85 |
| Sage (L\* 71) | +2.6 | 0.94 |
| Off-white (L\* 93.5) | +1.7 | 0.97 |

### 3.2 Psychophysics

- **Xiao & Brainard 2008** [S]: glossier spheres were matched darker and more saturated, more so for the darker colour. Observers discounted highlights: material influence indices were only 0.16–0.21 of the physical shift. https://color2.psych.upenn.edu/brainard/papers/Xiao_Brainard_08.pdf
- **Giesel & Gegenfurtner 2010** [S]: observers judge lightness from the brightest *non-highlight* region. https://jov.arvojournals.org/article.aspx?articleid=2191507
- **Motoyoshi et al. 2007** [S]: positively skewed luminance histograms (glints) look glossier and darker. https://www.nature.com/articles/nature05724
  - Kim & Anderson 2010 qualify this: https://jov.arvojournals.org/article.aspx?articleid=2191661
  - Kim, Marlow & Anderson 2011: highlights must agree with the shading. https://jov.arvojournals.org/article.aspx?articleid=2121251
- **Honson et al. 2020 and Isherwood et al. 2021** [S]: broad, rough specular reflection is partly misattributed to body colour, raising perceived lightness and lowering saturation.
  - https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2020.00485/full
  - https://pmc.ncbi.nlm.nih.gov/articles/PMC7888285/
- **Chadwick & Kentridge 2015** (review) [S]: https://www.sciencedirect.com/science/article/pii/S0042698914002594

### 3.3 Manufacturer guidance, reconciled

- **"Higher sheen looks darker"** [S]:
  - Behr: https://www.behr.com/pro/onthejob/blog/paint-sheen-differences/
  - Dulux: https://www.duluxtradepaintexpert.co.uk/en/editorial/how-light-and-finish-affects-colour
  - Farrow & Ball, especially for dark colours: https://www.farrow-ball.com/paint/applications/sheen-levels-explained
- **"Higher gloss enriches and brightens"** [S]: Sherwin-Williams. Its own summary is geometric: dark glossy finishes look darker straight on, while light glossy finishes skew brighter.
- **Both are the same physics** [E]:
  - Off-highlight, gloss is darker and more saturated, which dominates for mid and dark colours.
  - Near highlights, gloss is lighter. For light colours the off-highlight darkening is only about 1 L\*, so the bright bands dominate and people say "brighter".
  - LRV is measured specular-included, so it doesn't change with sheen.

### 3.4 What the renderer takes from this

1. **Render the physics; don't add perceptual corrections.** Highlights are discounted by the viewer and off-highlight darkening is seen in full. A physical render on screen gets the same treatment from the viewer's eye as the real wall would. (This follows v3's approach to brightness.)
2. **No extra wash-out near highlights, and no colour boost.**
3. **Glints come from the wall's own texture**, so they agree with the shading (Kim et al. 2011).

---

## 4. Measurements

### 4.1 `reference/sheen_examples.jpg`

Linear luminance per panel band [E, measured with CoreGraphics]:

| Panel | Top band Y (off-highlight) | Highlight band p99/p50 | Skew | Texture SD/mean, top |
|---|---|---|---|---|
| Dead Flat | 0.082 | 1.03 | −0.2 … −0.8 | 4.3 % |
| Flat | 0.076 | 1.07 | −0.3 … −0.7 | 6.4 % |
| Eggshell | 0.072 | 1.12 | +0.2 | 8.8 % |
| Satin | 0.072 | 1.36 | +1.2 … +1.5 | 8.8 % |
| Semi-gloss | 0.074 | 1.65 | +0.8 … +2.8 | 9.1 % |
| Hi-gloss | 0.075 | 2.0+ | +1.4 … +3.5 | 9.9 % |

- **The flat veil**: off-highlight, flats read about 12 % lighter.
- **Glints are positively skewed.**
- **The veil hides texture.**

### 4.2 The room photos (`images/sheens/`)

Four scenes, each a day photo, a night photo and a wall mask (black = wall). Cameras from `solveRoom` (straight lines in the photo; `sheenSceneRenderer.html` ROOMS lists every measured line):

| Scene | Files | Camera | Walls | Light sources |
|---|---|---|---|---|
| Living room | `living-room_*`, `living_room_mask.jpg` | f 3043 px (36°) | back wall; the window wall (direction b, hidden behind the curtain, corner at x 1550) | day: two windows in the window wall, **almost entirely out of frame** (only a strip of glass shows at the right edge); night: a wall-arm downlight, candles |
| Living room 2 | `living_room-2-*` | f 4532 px (25°) | back + window wall, corner at x 872 | day: window panes; night: a string of bare bulbs on the window wall |
| Deck | `living_room_deck_*` | f 848 px (99°, a wide-angle lens), camera 0.43 units above the floor | back, left, a 45° chamfer and right wall; a sloped ceiling (3 points) | day: door, clerestory and dining windows; night: two shaded lamps, a floor lamp, a pendant |
| Study | `study_*` | f 4172 px (27°) | back + left wall, corner at x 1055 | day: glass doors, a tall window, a clerestory; night: a floor lamp |

- **Verticals** are perspective-corrected in all four (roll ≤ 0.1°). The deck still has a slight pitch (verticals lean 0.3–0.8°), which the solver ignores.
- **Picture frames hang crooked** (0.3–1°) and the deck's large frames are tilted on purpose, so they are useless as lines; the deck's direction b comes from where the sloped ceiling meets two parallel walls (`bSloped`).
- **Clipping.** The living room's day wall is clipped (p99 = 0.99); the others aren't.
- **Texture** (8-bit levels per pixel inside JPEG blocks, day / night): living room 2: 2.7 / 4.0; deck: 1.7 / 2.4; living room: 0.35 / 0.68; study: 0.21 / 0.31. The noise floor is 0.3–0.7. Steps across 8 × 8 block edges are 1.3–4.8× those inside blocks.

---

## 5. The model (`js/sheenModel.js`, `glsl/sheen.glsl`)

**The equation.** For each wall pixel, in v3's linear units:

```
c' = c + t · [ (1 − S)(1 − v) · A(NoV) · (Ll − W)  +  S · F(NoV) · (Lm − W) ]
```

- `c`: v3's render of the paint. This is the **Flat look and equals the swatch**, because paint colours are measured specular-included (d/8 SCI).
- `W`: the same light on a white matte wall, i.e. the irradiance in the light's colour. The swatch's veil is the same surface reflection spread evenly, so it equals the albedo times W.
- `A`: the GGX lobe's directional albedo: **exact Fresnel (n = 1.5) and height-correlated Smith**, tabulated per sheen at load (`specularAlbedo`).
- `Ll`: what the lobe reflects, from filtered importance sampling through the room model (§5.1).
- `S = exp(−(k·NoV)²)`: the coherent (mirror) share of the **whole** surface reflection near grazing. `F` is exact Fresnel and `Lm` the mirror radiance.
- `v`: the diffused share, which reflects the veil itself and cancels.
- `t`: the darkening limiter. A swatch darker than a 4 % veil in some channel is compressed smoothly so that no channel loses more than 65 % of itself, and the change keeps its hue.
- **Under even surroundings** Ll = Lm = W, so every sheen equals the swatch exactly.

**Parameters** (each lands in its MPI band in `tests/sheen_check.py`):

| Sheen | α (GGX) | v (diffused share) | k (grazing) | 20° / 60° / 85° GU | MPI |
|---|---|---|---|---|---|
| Flat | 0.30 | 0.95 | 21 | 0.1 / 0.2 (2.3 for a white flat) / 3.5 | G1: 60° 0–5, 85° ≤ 10 |
| Eggshell | 0.075 | 0.45 | 16 | 1.3 / 10.9 / 22.1 | G3: 10–25, 85° 10–35 |
| Satin | 0.045 | 0.30 | 12 | 4.3 / 23.7 / 47.8 | G4: 20–35, 85° ≥ 35 |
| Semi-gloss | 0.025 | 0.10 | 6.5 | 14.7 / 48.5 / 84.9 | G5: 35–70 |

**Colour shift off-highlight** vs the swatch, when the mirror direction sees walls of the same colour (`tests/sheen_check.py`, NoV = cos 40°):

| Paint | Eggshell ΔL\* / C\*× | Satin | Semi-gloss |
|---|---|---|---|
| Navy #2F3D4C | −4.6 / 1.22 | −5.2 / 1.25 | −5.7 / 1.28 |
| Teal grey #607D84 | −2.2 / 1.09 | −2.7 / 1.11 | −3.3 / 1.14 |
| Sage #A4ACA6 | −1.1 / 1.05 | −1.3 / 1.06 | −1.7 / 1.08 |
| Off-white #E8DECD | −0.3 / 1.03 | −0.4 / 1.04 | −0.5 / 1.05 |

**Comparison with Micom.** In SCE (a dark room), the bronze comes out at L\* 30.5 / 26.4 / 25.4 / 24.2 for Flat / Eggshell / Satin / Semi-gloss. That sits between Micom's measured 7 GU sample (29.1) and 81 GU sample (19.6), in gloss order.

**Measured in the app** (teal #607D84, back wall, CIELAB):

| | Eggshell | Satin | Semi-gloss |
|---|---|---|---|
| Day, off-highlight ΔL\* | −0.9 | −1.5 | −2.1 |
| Night, off-highlight ΔL\* | −1.3 | −1.8 | −2.4 |
| Day, window reflection ΔL\* | +12.6 | +19.7 | +28.7 |

- Off-highlight, chroma rises (9.8 → 10.7 by day, 6.6 → 8.1 by night).
- In the window reflection, chroma falls (11.0 → 4.4), because the highlight is the light's colour.

### 5.1 Reflections

1. **Ray to wall.** The camera ray meets its wall at X. The room is up to 8 planes from `solveRoom` (walls, floor, an optional ceiling); the visible wall is the first one the ray reaches (the room is convex).
2. **Filtered importance sampling** (Křivánek & Colbert 2008, *GPU Gems 3* ch. 20).
   - 16 half vectors are drawn from the GGX distribution for **this pixel's viewing direction**, on a Fibonacci lattice rotated per pixel.
   - Each reflected ray is traced to the nearest other plane and projected back into the photo.
   - Each is read from the blur pyramid at the level whose texel covers the solid angle that sample stands for, accounting for the distance and the angles at the hit point. No +1 bias is added, because the pyramid is already Gaussian-like.
   - Samples are weighted by N·L (Karis 2013 prefiltering).
   - This gives the blur's correct size, which grows with the distance to what is reflected, and its correct **shape**: at the back wall's 50–60° the lobe is 1.75–2× narrower out of the plane of incidence than in it, so reflections stretch along the wall.
3. **The environment.** An HDR copy of the photo in which the **walls carry the new paint** (a navy wall reflects navy).
   - Light sources are restored by emitter gains: window panes ×7 by day, bulb and lamp cores ×12 by night (§5.3).
   - The gain is applied to 4 full-resolution samples per texel before averaging, so bulb edges keep their light.
   - The pyramid uses Jimenez's 13-tap downsample (*CoD: AW*, SIGGRAPH 2014), which approximates a Gaussian.
4. **Rays that leave the photo** see the unseen room: 53 % walls in the paint's own colour (a 4 × 5 × 2.5 m room has 45 m² of walls against 40 m² of floor and ceiling) and 47 % the photo's mean, blending into a ceiling (0.8 × the photo's mean) as the ray turns upward. The outer 8 % of the frame fades to it.
5. **Light sources show unpainted.** Bulb cores show the photo, even where the mask is grey.
6. **Lamps off the walls are lights in 3-D** (§5B.4): a sphere placed on its pixel's ray in front of its wall, reflected analytically (GGX widened by the lamp's size, exact Fresnel, Smith visibility, an optional cone for shades).

### 5.2 Glints

Linear shape-from-shading (Pentland 1988): a normal tilted by δ toward the light changes brightness by δ·t, with t = tan θᵢ for the key light (each photo's main window or lamp).

- **The texture map** is luminance over its local mean (σ ≈ 3.5 px) minus 1, computed once per photo in JS (`textureDetail`) and stored in the photo's alpha channel.
- **JPEG gate.** The map is scaled by how far the wall's in-block detail stands above the compression and 8-bit noise floor: 0 below 0.8 levels/px, 1 from 2.0 (§5B.3). The living room and study walls have no measurable texture, so they get no glints.
- **Regularised inverse.** δ = dev·t / (t² + 0.25), capped at 1.4° (0.025 rad). Under raking light that is dev/t; under frontal light, where shading barely depends on tilt, it fades to 0 instead of amplifying noise. Large deviations (frames, shadow edges) are ignored.
- **No per-sheen gain is needed.** Glints appear by themselves on Satin and Semi-gloss, whose lobes are narrower than the tilts.
- **Limit: only the tilt toward the light is recovered.** A photo's shading only shows tilt toward its light.

### 5.3 Emitter gains, from energy balance

The photos are tone-mapped, so light sources appear barely brighter than the walls they light. I first tried a photometric regression, fitting wall brightness against the computed form factors (window) or cos θ/r² (bulbs) over 1366 wall samples. It **failed**: R² was 0.05–0.17, because tone mapping and the generated night image flatten the physical falloff.

Energy balance at the wall points each source dominates is robust to that. The scene scale is about **9 m per scene unit**, consistent from the sofa back (0.094 units), the window sill (0.100) and the radiator (0.080). That puts the camera at 1.3 m, 4.3 m from the back wall.

- **Window (day).** The 60 back-wall samples the window lights most have form factor × reflectance (0.88) = 0.059 and luminance 0.675. The window wall can't see its own window, so it shows the ambient level: 0.42. The window's radiance is then (0.675 − 0.42)/0.059 = 4.3, which is **×7.2** the photo's panes (0.60). Using half that ambient would give ×13, so ×7 is the conservative end.
- **Bulbs (night).** The middle bulb's glow on the back wall is 34 cm wide at half height, which for a point source means 18 cm from the wall, and it stands 0.15–0.3 above the surrounding wall. That intensity, divided by the core's area in the photo, gives **×9–17**. I used ×12, for the lamp as well.
- **Earlier values.** The first version used ×6 and ×30, set by eye. The bulbs were 2–3× too bright.
- **The other rooms** (§5B.2): the regression failed there too (R² ≤ 0.15; the deck's fit gave ×0.3, less light than a white wall). Their windows use the same physical prior as living room 2 (the window supplies about 60 % of the wall's light where it dominates): ×5–7. Lamps use ×12 for bare bulbs and ×5 for lit shades.

---

## 5A. Review and corrections (second pass)

Every part of the logic was re-checked numerically. Five things were wrong or coarser than necessary:

| # | Finding | Size of the error | Fix |
|---|---|---|---|
| 1 | The lobe's albedo used Karis' `EnvBRDFApprox` (Schlick Fresnel) | 12–27 % **too weak** at the back wall's 50–66° (`tests/sheen_check.py` §C). Reflections and off-highlight deepening were both about a fifth too weak. | Exact Fresnel (n = 1.5) and height-correlated Smith, tabulated per sheen; matches the Python reference to 2e-5 |
| 2 | Reflections were blurred isotropically (three disk blurs) | At 55–60° the true lobe is 1.75–2× narrower out of the plane of incidence, so reflections were smeared vertically by up to 2× | Filtered importance sampling with the true view direction (§5.1) |
| 3 | The grazing (Rayleigh) mirror share applied only to the gloss lobe | Flat read 0.1 GU at 85°, where real flats read about 2–5 (MPI ≤ 10) | S applies to the whole surface reflection; Flat's k = 21 gives 3.5 GU. Mirror term uses exact Fresnel |
| 4 | Emitter gains set by eye | Bulbs about 2–3× too bright (×30 vs ×9–17) | Energy balance (§5.3): window ×7, bulbs ×12 |
| 5 | Emitter threshold applied after downsampling | Soft edges of bulb cores fell below the threshold, so part of their light was lost | Gain applied to 4 full-resolution samples before averaging |

**Confirmed correct.**
- The SCI anchor (Flat = swatch).
- The veil's size (Micom ΔY 0.0377 ≈ the Fresnel term).
- Invariance under even light (exact, now at every angle).
- The CDF of the GGX half-vector distribution.
- The camera solver (it recovers a synthetic camera exactly).
- The darkening limiter.
- Untinted highlights (the dichromatic model, tested).

**Investigated and kept.** For a GPU test that failed after the changes (Satin vs Eggshell chroma on a mid-tone paint), the cause was ±1-level dither noise in a single 8-bit pixel. Over a pixel block, the ordering holds.

---

## 5B. Four scenes: testing and corrections (third pass)

Each room was rendered by day and by night in all four sheens (32 renders, teal #607D84) and measured on the wall pixels only (mask = black): median L\* and C\*, the 99th percentile, the luminance skew, and the share of pixels that got darker (> 0.5 L\*) or brighter (> 3 L\*) than Flat. The renders were also inspected at full resolution around every light source, corner and frame edge.

### 5B.1 Final measurements

| Scene / light | L\* p50, Flat → Semi-gloss | C\* p50 | L\* p99 | Skew | Darker / brighter |
|---|---|---|---|---|---|
| Living room, day | 48.9 → 46.7 | 11.2 → 11.6 | 49.7 → 77.1 | −1.20 → 1.91 | 77 % / 10.6 % |
| Living room, night | 22.5 → 20.9 | 4.2 → 4.6 | 45.7 → 42.7 | 1.04 → 1.05 | 81 % / 0 % |
| Living room 2, day | 44.7 → 42.8 | 9.8 → 10.6 | 51.6 → 73.1 | −1.00 → 1.63 | 71 % / 20 % |
| Living room 2, night | 33.9 → 30.8 | 8.8 → 10.0 | 47.0 → 53.9 | (bulb-dominated) | 97 % / 1.4 % |
| Deck, day | 42.8 → 43.8 | 8.2 → 9.3 | 52.6 → 58.8 | −0.23 → 0.41 | 49 % / 19 % |
| Deck, night | 20.1 → 24.4 | 4.4 → 5.1 | 46.8 → 42.8 | 1.47 → 2.93 | 43 % / 35 % |
| Study, day | 41.0 → 40.7 | 9.7 → 9.8 | 51.6 → 67.1 | 0.38 → 1.38 | 72 % / 23 % |
| Study, night | 27.2 → 24.9 | 5.2 → 6.1 | 39.3 → 36.9 | 0.44 → 0.77 | 96 % / 0.5 % |

What the numbers show, against the research (§3):

- **Off-highlight deepening is consistent everywhere.** 43–97 % of wall pixels get darker with gloss: −1.5 to −3.1 L\* at the median, with chroma up by 5–14 %. That is the size §5's table predicts for this mid-tone paint (−2 to −3 L\*).
- **Highlights carry the gloss cue.** Where the photo shows a light source that the walls can reflect (living room 2, deck and study by day; the deck and living room 2 by night), the top percentile and the skew rise steadily from Flat to Semi-gloss, as in the reference photo (skew 0.2 → 1.5 → 2.8 → 3.5).
- **Lamp-lit pools dim slightly with gloss** (night p99 falls 2–4 L\* where no lamp is mirrored). This is right: a glossy wall sends the lamp's surface reflection toward the lamp's mirror image instead of spreading it toward the camera.
- **The deck by night gets lighter overall** (median +4.3 L\*). With its 99° lens the camera looks up at much of the wall, so the mirror directions see the lamp-lit ceiling and lampshades, which are brighter than the wall's own light.
- **The living room by day** showed almost no gloss (0.6 % of pixels brightened) until its windows outside the photo were added (§5B.6); the row above is with them.

### 5B.2 Photometric calibration fails on these photos

Fitting emitter gains to the falloff of their light on the walls (§5.3) was tried in every room. R² was 0.00–0.15 everywhere, and the deck's window came out ×0.3. The photos are tone-mapped (and the night ones appear to be generated): their light pools have no inverse-square falloff to measure. All gains are therefore physical priors, uncertain by about ±40 %.

### 5B.3 JPEG blocking made fake glints (fixed)

The first renders of the living room and study showed patchy mosaics on Satin and Semi-gloss. These walls have no texture above the noise floor (0.2–0.7 levels/px), so their "texture" was the JPEG's 8 × 8 blocking, which the micro-normals turned into tilted tiles.
- Smoothing the blocks' averages away was tried. It didn't help, because JPEG's in-block ramps keep the steps.
- **Fix:** the texture map is scaled by a gate on the in-block detail (§5.2). The gate is 0 for the living room and study, 1 for living room 2 and 0.95–1 for the deck. The inverse was also regularised, so frontal light no longer amplifies noise. No mosaics remain.

### 5B.4 Lamps off the walls (new)

The environment puts everything in the photo on the room's planes. That is right for windows but not for a lamp 10–50 cm in front of a wall: its true reflection is displaced by about twice that distance. Before this fix, the deck's left lamp reflected behind its own shade.

- Lamps are now spheres on their pixel's ray, `offset` in front of their wall (`pointOffWall`), reflected analytically.
- **Intensity** comes from the lamp's own pixels (`calibrateLamps`): Σ linear RGB above a threshold × one pixel's area at the lamp's depth × the emitter gain.
- **Bug found and fixed: the sphere-light normalisation.** The highlight used GGX widened to α' = α + r/2d **and** Karis's factor (α/α')². That factor belongs with D at the original α toward the sphere's representative point. Applied to the widened D, it threw away 1 − (α/α')² of the energy, most for the glossiest finishes. In a test with a lamp on the optical axis, semi-gloss's highlight was no brighter than satin's. Without the factor, D(α') integrates to 1, and the peak, L·F·r²/(4α'²d²), can never exceed the lamp's own radiance × Fresnel (a mirror image). Peak added luminance is now Flat 0.002, Eggshell 0.18, Satin 0.36, Semi-gloss 0.64 (`tests/tests.js`). In the scenes, the deck's night skew now rises with gloss (1.47 → 2.93) where it used to fall.
- **Bug found and fixed: clipped lamp colour.** The bulb cores are clipped to white (R:G:B 1.05 : 1 : 0.8), while their unclipped halos show the light's real colour (1.6 : 0.9 : 0.25). Highlights were therefore near-white under warm bulbs. When over 25 % of a core is clipped, the colour now comes from the pixels at 50–100 % of the threshold and the luminance from the core. Six of the seven lamps switched.

### 5B.5 Other corrections and remaining gaps

- **Missing ceiling (fixed).** The study's upper walls reflected the frame's edge fade as a visible seam where rays left the photo. The unseen room now blends into a ceiling for upward rays. The deck has a real, sloped ceiling plane.
- **Out-of-frame light sources (fixed for the living room, §5B.6).** The environment only knows what the photo shows, so a window outside it is never reflected.
- **Clipped walls.** In the living room by day, the clipped wall leaves the light map flat (Y p99/p50 = 1.03), so there are no lighting cues for highlights.
- **Pitch** (deck, ≤ 0.8°) is ignored. Its error is under 1 % in the reflection directions.

### 5B.6 Windows outside the photo, located and measured in the picture glass

The living room's daylight comes from windows that the photo barely shows. Its two framed prints are glazed, and smooth glass (n ≈ 1.52) is the same kind of reflector as a gloss meter's standard. Each print's glass mirrors part of the room behind the camera, so the photo contains its own measurement of what a glossy back wall would reflect.

- **Where the window wall is.** The window sash's top edge, at the photo's top-right corner, slopes at −0.31. Lines of the room's second direction (b) slope at −0.35 there, and lines parallel to the back wall at +0.22. So the windows are in a wall perpendicular to the back wall, and the back wall can mirror them. A window in the back wall itself could never be mirrored by it. The corner is hidden by the curtain and placed at the curtain's left edge (x 1550).
- **Where the windows are.** The right print's glass shows a clear window with a mullion at u 0.50–0.60. Mirrored through the back wall, that is 0.04–0.22 along the window wall from the glass edge seen at x 1945, and the edge itself mirrors to u 0.63. The left print's glass shows a window with sheer curtains at u 0.20–0.315, which is 0.66–1.1 along the wall, beside the camera.
- **How bright they are.** The glass adds the window's radiance × Fresnel to the print behind it. On the right print, the reflection adds 0.53 (linear, blue channel) at 32° incidence (F = 0.044), giving **≈ 12× the photo's white**. Red and green clip, so this is a lower bound. On the left print, it adds 0.33 in the unclipped red channel at 21° (F = 0.043), giving **≈ 7.7×** for the sheer-covered window. This is the only scene where a light source could be calibrated photometrically, and it shows the ×6 prior used before was too low. The visible strip of glass now gets ×12 in the environment too.
- **How they are rendered** (`placeWindows`, `glsl/sheen.glsl` `windowCover`):
  - Each window is a rectangle on its plane. A lobe sample whose ray reaches it before any nearer room plane reads its radiance.
  - The sample's cone footprint (side √π × the cone radius × distance, stretched by the slant) is box-filtered against the rectangle. That is the same filtering the environment's mip reads get, so window edges blur with the lobe and don't alias.
- **Result.**
  - The windows' mirror images fall mostly behind the two prints, which is exactly why the prints' glass shows them. On the wall they appear below and beside the prints. On Semi-gloss, the clear window shows below the right print as a soft-edged bright patch ending at the sill's mirror line. Satin and Eggshell show progressively wider, fainter glows.
  - Wall statistics, Flat → Eggshell → Satin → Semi-gloss: p99 L\* 49.7 → 61.9 → 68.9 → 77.1, skew −1.20 → −0.49 → 0.57 → 1.91, and 10.6–11.5 % of the wall brightens by more than 3 L\*. The median still deepens, by 2.2 L\*. Night is unchanged.
- **Uncertain.** The windows' widths and the second window's position (to about ±0.05 units, from reading the reflections' edges), and the radiances (lower bounds where channels clip).

---

## 6. Limits and what would improve it

- **Estimated values:**
  - the per-sheen v (from one Micom material plus the MPI bands);
  - the 53 % wall share;
  - the darkening floor;
  - the emitter gains (energy-balanced, but with a ±40 % range from the ambient share and the bulb distance).
- **One bounce of gloss.** Gloss between the walls is left out: walls reflect each other in their flat colour.
- **Parallax.** Lamps are placed in 3-D (§5B.4), but other off-plane objects are reflected as if on the room's planes: furniture via the floor, the bulb cord via the window wall.
- **Out-of-frame reflections** (behind the camera, the ceiling where none is modelled) use the unseen-room estimate. Light sources outside the photo are reflected only where they are configured as windows (§5B.6).
- **Convex rooms only.** Alcoves, columns and furniture don't occlude reflections (no specular occlusion).
- **Glints only along the light** (§5.2).
- **The biggest single improvement** would be scene-linear HDR photos. Light sources would carry their real brightness, and the photometric fit of §5.3 would work directly.
- **No real paint data.** Real paints' measured BRDFs (gonio-photometer data per product and sheen) could replace the GGX fits directly.

---

## 8. Calibrating new rooms (`sheenCalibrate.html`, `js/sheenCalib.js`)

The shaders and the model hold nothing specific to a photo. Each room is a description in `ROOMS` (`sheenSceneRenderer.html`): the lines that give the camera, the walls, the emitters, lamps and windows. The four built-in rooms were measured by hand. The calibration page makes that semi-automatic.

**Detection** (all of it proposes; the user checks the live room grid and corrects):

- **Line segments.** A simplified LSD (von Gioi et al. 2012):
  - 2 × 2 gradients, region growing by level-line angle (±22.5°), and gradient-weighted principal axes.
  - LSD's a-contrario test is replaced by length, thinness and density tests.
  - On a synthetic polygon it finds the edges to 0.01 px. A 1000 px photo takes 70–260 ms.
- **Directions.**
  - Verticals: within 3° of vertical, agreeing with the weighted median lean within 0.5°. They also give the roll. Converging verticals (a tilted camera, which the solver doesn't model) are reported.
  - Horizontal directions: RANSAC pairs for direction a (vanishing points in homogeneous coordinates). For each of the 25 best distinct candidates, the best b on its horizon, on the other side of the principal column and within a 15–130° field of view. The pair explaining the most weight wins.
  - Weights: length² (long room edges outweigh textures of many short parallel lines, such as the study's ribbed panel), × 3 for lines with wall on one side (frames, baseboards, reveals).
- **Snapping** drawn lines (`snapLine`):
  - At 40 points along the line, the 3 strongest brightness steps within ±10 px.
  - RANSAC: the line through two of them that the most points support within 1 px, within 3° of the drawn direction. Then least squares.
  - It recovers an edge through texture to 0.06 px. On the real photos, hand-measured lines drawn 2–4 px off came back within about 1 px. One was found 5 px off in the hand calibration (living room 2's corner: the brightness step is at x 875, not 870).
- **Light sources** (`detectLights`):
  - Day windows: non-wall, ≥ 0.6 by day and < 0.06 at night. Glass goes dark at night, while white frames, sills, prints and sofas, which clip by day like glass, stay lamp-lit.
  - Night: bulbs are clipped cores (≥ 0.85), merged within 2 %. Shades are ≥ 0.35 regions that are 5–60 % clipped. Lit surfaces rarely clip, and a region that is mostly core is a bulb.
- **Uncertainty.** Every solve is repeated 24 times with line endpoints jittered by 0.5 px (Gaussian, at 2000 px). The spread of the focal length and wall angles is reported, with the line family whose noise matters most.

**Tested on the four built-in rooms** (detection alone, against the hand calibration):

| | Lights (night) | Windows (day) | Camera from detected lines alone |
|---|---|---|---|
| Living room | wall lamp ✓ (+ a lamp-lit white print, wrongly) | edge window ✓ | f +155 % ✗ (the second direction has one usable line, the rug's edge) |
| Living room 2 | 3 bulb clusters ✓ | both panes ✓ | f −14 % ✗ |
| Deck | floor lamp ✓, one shade in part, one missed | 1 of 3 | f +9 % (the hand calibration needed the sloped-ceiling lines) |
| Study | floor lamp ✓ | clerestory, tall window, doors ✓ | f −54 % ✗ (a ribbed art panel outvotes the room) |

Light detection is close to the hand work. Camera detection alone is not reliable on these photos: the second horizontal direction usually has very few lines, and furniture or texture outvote it. That is why the page is semi-automatic, and why line checking (step 2) is required.

With the lines checked and redrawn (snapped), living room 2 came out at f = 4346 px against 4532 px by hand. That is inside the solution's own uncertainty: ±0.5 px of line noise moves f by ±3.5–4 % and the wall angles by ±1°, for both line sets. A wall seen nearly square-on puts its vanishing point far away, where small line errors move it a lot. The hand calibration is no more certain than that either.

**Uploads** (`sheenSceneRenderer.html`, *Your own room*; `autoCalibrate`) accept all of the above without review:

- **Walls.** An inside corner seen from the room shows the wall whose lines run to the right-hand vanishing point on the corner's left, and the other on its right (confirmed on living room 2, the study and the deck). So only the corner's column is searched: the one that puts the most wall-adjacent line length of each family on its own side, taking the middle of the best-scoring range. A family with under 15 % of that length means a single wall.
- **Floor.** The lowest point where the mask's wall comes down, smoothed over 5 neighbouring columns, skipping columns where the wall runs off the photo's bottom. Furniture hides the foot of the wall in most columns, so a median or 90th percentile lands on sofas and tables. Against the hand points: study (1005, 1350) vs (1000, 1352); living room 2 (1849, 1640) vs (1900, 1655), the same baseboard; living room within 45 px at the photo's edge; deck the left wall's foot instead of the back wall's.
- **Scale.** A camera 1.2 m above the floor.
- **Fallback.** Without a plausible camera (field of view outside 20–110°, or too few lines): one wall facing the camera, a 60° field of view, the floor 0.35 wall-distances below the eye. The colour shift and soft sheen come from the light map and still hold. Reflections are approximate.
- **Tested.** Uploading living room 2's photos as `day.jpg`, `night.jpg` and `mask.png` gave a 29° camera (the hand calibration's 25°), the corner at 45 % across (hand: 43.6 %), the three bulb clusters and both window panes. The reported ±0.4 % "uncertainty" of that solution covers only line noise. Its real error, from detected lines that aren't square to the room, is 15 %, which the calibration page's report now says.

**Uploads compared with the built-in rooms.** Each room's three photos were uploaded as `day.jpg`, `night.jpg` and `mask.png`, rendered in every sheen (teal #607D84), and compared with the preloaded room on the wall pixels. The figure is the sheen's own contribution, (sheen − Flat) uploaded vs. preloaded, as mean ΔE (CIELAB) for Eggshell → Semi-gloss; Flat itself matches within 0.3–0.6.

| Upload | Day | Night |
|---|---|---|
| Deck, fully automatic (before this pass) | 3.3 → 5.5 | 4.0 → 6.1 |
| Deck, fully automatic | 3.3 → 5.5 | 3.6 → 5.7 |
| Deck, automatic with a known focal length (as from EXIF) | 2.1 → 3.7 | 3.0 → 4.7 |
| Deck, hand geometry + automatic lights | 1.0 → 1.4 | 1.2 → 1.5 |
| Living room 2, fully automatic | 1.0 → 1.5 | 1.3 → 1.8 |
| Study, fully automatic | 2.8 → 5.1 | 0.9 → 1.5 |
| Living room, fully automatic | 2.3 → 2.8 | 0.7 → 1.0 |
| Any built-in room's photos, recognised | 0.4 | 0.4 |

- **Geometry is about three quarters of the gap.** The deck with the hand geometry and automatic lights is at ΔE 1.0–1.5, against 3.3–5.7 fully automatic. Automatic layout finds two walls where the deck has four, no sloped ceiling, and a floor point that puts the camera at twice its height. The study's camera comes out at f 1920 px against 4172, and its daylit glazing then reflects in the wrong places (p95 ΔE 17). The living room's daylight comes from windows outside the photo, which only the hand calibration models (§5B.6).
- **Fixed in this pass:**
  - **Lamps reflected twice.** A night light made a 3-D lamp also kept a ×12 gain in the environment, so it was reflected twice, the second time painted onto the wall behind it, 12× too bright. The calibration page had the same bug.
  - **Lamp sizes.** These came from bounding boxes, so a string of bulbs became one huge bulb. They now come from the light's own pixel area.
  - **Lampshades.** A shade's glow grown without limit merged with the lit ceiling and floor, and its open, clipped top was cut off from its fabric by a darker rim. Growth is now windowed around the core and bridges 2 px gaps: the deck's left shade comes out at [223–642, 1136–1392] px against [215–660, 1140–1455] by hand. Lamp-lit white surfaces next to bulbs (a print, a window frame) can still be mistaken for shades.
- **Added:**
  - **EXIF.** The 35 mm-equivalent focal length is read from a photo's EXIF. With it, direction b's vanishing point follows from a's (qA qB = −f²; `solveRoom` `focal`), so only the strongest line family is needed. The built-in photos carry empty EXIF blocks, so this was measured by supplying the true focal length.
  - **Recognising the built-in photos.** An upload whose three images match a built-in room's (24 × 24 thumbnails within 2.5 levels on average) gets that room's measured calibration, and the status line says so.
- **What would close the rest.** A learned room-layout estimator, or a depth and normal model, for walls, floor and ceiling. Or the calibration page, which reaches the hand calibration's accuracy (living room 2: f within the solution's own ±3.5 %).

---

## 7. Rendering references

- Heitz et al. 2016, *Real-Time Polygonal-Light Shading with Linearly Transformed Cosines*: https://eheitzresearch.wordpress.com/415-2/
- von Gioi, Jakubowicz, Morel & Randall 2012, *LSD: a Line Segment Detector*, IPOL: https://www.ipol.im/pub/art/2012/gjmr-lsd/
- Karis, *Real Shading in Unreal Engine 4*, SIGGRAPH 2013: https://blog.selfshadow.com/publications/s2013-shading-course/karis/s2013_pbs_epic_notes_v2.pdf
- Karis, *Physically Based Shading on Mobile* (EnvBRDFApprox, replaced by exact tables after review): https://www.unrealengine.com/blog/physically-based-shading-on-mobile
- Křivánek & Colbert 2008, *Real-time shading with filtered importance sampling*; Colbert & Křivánek, *GPU-Based Importance Sampling*, GPU Gems 3 ch. 20: https://developer.nvidia.com/gpugems/gpugems3/part-iii-rendering/chapter-20-gpu-based-importance-sampling
- Heitz 2014, *Understanding the Masking-Shadowing Function in Microfacet-Based BRDFs* (height-correlated Smith): https://jcgt.org/published/0003/02/03/
- Filament, *Physically Based Rendering*: https://google.github.io/filament/Filament.md.html
- LearnOpenGL, *Specular IBL*: https://learnopengl.com/PBR/IBL/Specular-IBL
- Screen-space glossy reflections (cone tracing over blurred mips): https://willpgfx.com/2015/07/screen-space-glossy-reflections/
- Boyadzhiev et al. 2015, *Band-sifting decomposition for image-based material editing*: https://www.cs.cornell.edu/projects/band_sifting_filters/
- Criminisi, Reid & Zisserman 1999, *Single View Metrology*: https://www.robots.ox.ac.uk/~vgg/publications/1999/Criminisi99/criminisi99.pdf
- Commercial visualizers (ColorSnap, Dulux, Benjamin Moore and others) show no evidence of simulating sheen: https://compositepaint.com/tools/paint-color-visualizer-apps/
