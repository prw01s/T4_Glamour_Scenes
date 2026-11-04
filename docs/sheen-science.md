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

- **Alignment.** Day (2000²) and night (2048²) align with the 4000² mask and with each other within 1 px.
- **Wall light.** Wall luminance p50 is 0.60 by day and 0.35 by night (warm). Nothing is clipped.
- **Texture.** The wall texture's relative SD is 3.5–8 %, from raking light.
- **Camera** (`solveCamera`, from straight lines; see `sheenSceneRenderer.html`):
  - Verticals are perspective-corrected (shift lens), with no roll. The wall corner at x = 870 px and the right frame are exactly vertical; the left frame hangs 0.3° crooked.
  - Back-wall vanishing point from the frames' edges: (−1621, 730) px.
  - Window-wall vanishing point from the window rail, sill and radiator, fitted on the horizon to 1 px RMS.
  - Result: **f ≈ 4530 px (25° field of view)**, looking diagonally into the corner. The back wall is seen at 49–61° incidence and the window wall at 19–28°, so each wall mirrors the other.
- **Light sources.**
  - Day: window panes at x 0–135 and 255–540 px, y ≤ 820.
  - Night: bulb cores (Y > 0.85) in three clusters along the cord at x 700–920, and a lamp at the right edge.

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

1. **Ray to wall.** The camera ray meets its wall at X (the walls are planes from `solveCamera`).
2. **Filtered importance sampling** (Křivánek & Colbert 2008, *GPU Gems 3* ch. 20).
   - 16 half vectors are drawn from the GGX distribution for **this pixel's viewing direction**, on a Fibonacci lattice rotated per pixel.
   - Each reflected ray is traced to the other wall or the floor and projected back into the photo.
   - Each is read from the blur pyramid at the level whose texel covers the solid angle that sample stands for, accounting for the distance and the angles at the hit point. No +1 bias is added, because the pyramid is already Gaussian-like.
   - Samples are weighted by N·L (Karis 2013 prefiltering).
   - This gives the blur's correct size, which grows with the distance to what is reflected, and its correct **shape**: at the back wall's 50–60° the lobe is 1.75–2× narrower out of the plane of incidence than in it, so reflections stretch along the wall.
3. **The environment.** An HDR copy of the photo in which the **walls carry the new paint** (a navy wall reflects navy).
   - Light sources are restored by emitter gains: window panes ×7 by day, bulb and lamp cores ×12 by night (§5.3).
   - The gain is applied to 4 full-resolution samples per texel before averaging, so bulb edges keep their light.
   - The pyramid uses Jimenez's 13-tap downsample (*CoD: AW*, SIGGRAPH 2014), which approximates a Gaussian.
4. **Rays that leave the photo** see the unseen room: 53 % walls in the paint's own colour (a 4 × 5 × 2.5 m room has 45 m² of walls against 40 m² of floor and ceiling), and 47 % the photo's mean. The outer 5 % of the frame fades to it.
5. **Light sources show unpainted.** Bulb cores show the photo, even where the mask is grey.

### 5.2 Glints

Linear shape-from-shading (Pentland 1988): a normal tilted by δ toward the light changes brightness by δ·tan θᵢ. So δ = (ratio − 1)/tan θᵢ, where ratio is v3's detail ratio (sharp / blurred luminance) and θᵢ comes from each photo's key light (the window by day, the bulbs by night).

- **Cap.** δ is capped at 1.4°, the top of this photo's measured 0.6–1.4° and the low end of roller stipple's 1–5°.
- **Large ratios are ignored.** Shadow edges and frames are not texture.
- **No per-sheen gain is needed.** Glints appear by themselves on Satin and Semi-gloss, whose lobes are narrower than the tilts.
- **Limit: only the tilt toward the light is recovered.** A photo's shading only shows tilt toward its light. Both of these photos are lit from the left, so photometric stereo (combining them) isn't possible either.

### 5.3 Emitter gains, from energy balance

The photos are tone-mapped, so light sources appear barely brighter than the walls they light. I first tried a photometric regression, fitting wall brightness against the computed form factors (window) or cos θ/r² (bulbs) over 1366 wall samples. It **failed**: R² was 0.05–0.17, because tone mapping and the generated night image flatten the physical falloff.

Energy balance at the wall points each source dominates is robust to that. The scene scale is about **9 m per scene unit**, consistent from the sofa back (0.094 units), the window sill (0.100) and the radiator (0.080). That puts the camera at 1.3 m, 4.3 m from the back wall.

- **Window (day).** The 60 back-wall samples the window lights most have form factor × reflectance (0.88) = 0.059 and luminance 0.675. The window wall can't see its own window, so it shows the ambient level: 0.42. The window's radiance is then (0.675 − 0.42)/0.059 = 4.3, which is **×7.2** the photo's panes (0.60). Using half that ambient would give ×13, so ×7 is the conservative end.
- **Bulbs (night).** The middle bulb's glow on the back wall is 34 cm wide at half height, which for a point source means 18 cm from the wall, and it stands 0.15–0.3 above the surrounding wall. That intensity, divided by the core's area in the photo, gives **×9–17**. I used ×12, for the lamp as well.
- **Earlier values.** The first version used ×6 and ×30, set by eye. The bulbs were 2–3× too bright.

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

## 6. Limits and what would improve it

- **Estimated values:**
  - the per-sheen v (from one Micom material plus the MPI bands);
  - the 53 % wall share;
  - the darkening floor;
  - the emitter gains (energy-balanced, but with a ±40 % range from the ambient share and the bulb distance).
- **One bounce of gloss.** Gloss between the walls is left out: walls reflect each other in their flat colour.
- **Parallax.** Off-plane objects carry small parallax errors: the bulbs hang about 18–25 cm from the walls and are reflected as if on the window-wall plane, and the sofa is reflected via the floor plane.
- **Out-of-frame reflections** (behind the camera, the ceiling) use the unseen-room estimate.
- **Glints only along the light** (§5.2).
- **The biggest single improvement** would be scene-linear HDR photos. Light sources would carry their real brightness, and the photometric fit of §5.3 would work directly.
- **No real paint data.** Real paints' measured BRDFs (gonio-photometer data per product and sheen) could replace the GGX fits directly.

---

## 7. Rendering references

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
