/* ==========================================================================
 * sheenModel.js — the paint sheen model behind sheenSceneRenderer.html:
 * what each sheen IS physically (SHEENS), what visitors are told about it
 * (SHEEN_COPY), and the room geometry the reflections need (solveCamera).
 *
 *   SHEENS        Flat / Eggshell / Satin / Semi-gloss as surface-reflection
 *                 parameters, each with its source and its check
 *   SHEEN_COPY    the visitor-facing description of each sheen
 *   solveCamera() a pinhole camera + the two wall planes + the floor, from
 *                 straight lines measured in the photo
 *   sheenJob()    everything RENDER's sheen code needs for one photo, as
 *                 uniforms (consumed by LightPipeline.render in paintPipeline.js)
 *
 * The shading itself is in glsl/sheen.glsl; the research behind every number
 * is in docs/sheen-science.md; tests/sheen_check.py checks the numbers
 * against the gloss standards and the colour research.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL IN ONE PARAGRAPH
 *
 * Paint reflects light in two ways (the dichromatic model, Shafer 1985):
 * BODY reflection, light that entered the paint film and was scattered back
 * out by the pigment, which carries the paint's colour; and SURFACE
 * reflection, the ~4 % mirror-like (Fresnel) reflection at the air/binder
 * interface (binder n ≈ 1.5 → F0 = ((n-1)/(n+1))² = 0.04), which carries the
 * LIGHT's colour. Every sheen has the same ~4 % surface reflection and the
 * same total reflectance (an SCI measurement doesn't change with sheen;
 * Konica Minolta, X-Rite, HunterLab). Sheens differ only in how that 4 % is
 * SPREAD: flats are formulated above the critical pigment volume
 * concentration, so pigment and extender particles break through the binder
 * and scatter it into every direction - a faint white veil over the colour;
 * glossy paints have a smooth binder surface that concentrates it around the
 * mirror direction - reflections and highlights, and, away from them, a
 * deeper, more saturated colour (the veil is gone). Gloss meters (ASTM D523)
 * measure exactly that concentration.
 *
 * Loaded as a classic script (like the others). Exposes window.SheenModel.
 * ======================================================================== */
(function () {
  "use strict";

  // ======================================================================
  // Sheens
  // ======================================================================

  /**
   * Fresnel reflectance of paint at normal incidence: binder refractive
   * index n ≈ 1.49-1.50 (acrylic / PMMA, refractiveindex.info; Disney 2012
   * uses n = 1.5 as its representative dielectric) -> ((n-1)/(n+1))² = 0.04.
   * The same for every sheen: sheens differ in roughness, not in F0.
   */
  const SURFACE_F0 = 0.04;
  /** The binder's refractive index (F0 = 0.04); the shader uses exact Fresnel with it. */
  const BINDER_N = 1.5;

  /**
   * Darkening floor. A glossier finish removes the surface veil from the
   * colour seen away from highlights, which can't take more than the veil
   * the swatch contains. A swatch darker than a 4 % veil in some channel
   * (#2f3d4c: red = 0.028 linear) is physically impossible as a specular-
   * included measurement, so the removal is compressed smoothly so that no
   * channel loses more than (1 - DARKEN_FLOOR) of itself (0.35: the perception
   * literature's estimate for keeping near-blacks from crushing; see
   * applySheen in glsl/sheen.glsl and limit() in tests/sheen_check.py).
   */
  const DARKEN_FLOOR = 0.35;

  /**
   * @typedef {Object} Sheen
   * @property {string} label    Visible name.
   * @property {string} mpi      MPI gloss level (MPI Architectural Painting Manual).
   * @property {[number, number]} gu60  MPI 60° gloss range, GU.
   * @property {number} alpha    GGX roughness α (NOT "perceptual roughness" = √α)
   *   of the concentrated part of the surface reflection. Sets how sharp
   *   reflections are: the reflected image of a point spreads over a cone of
   *   roughly ±2·atan(1.5α) (70 % of the GGX lobe's energy).
   * @property {number} v        Diffused share, 0..1: the part of the surface
   *   reflection scattered so widely it acts as a uniform veil (pigment
   *   particles protruding through the binder). The rest, (1 - v), forms
   *   the GGX lobe.
   * @property {number} k        Grazing-sheen coefficient 4πσ/λ (σ = RMS surface
   *   height, λ = 0.55 µm). At grazing angles any surface looks smoother
   *   (Rayleigh criterion): exp(-(k cos θ)²) of the WHOLE surface reflection
   *   (lobe and diffused share alike: both are scattered by the same
   *   roughness) becomes a sharp mirror reflection. This is why MPI's 85°
   *   ("sheen") readings exceed the 60° readings for eggshell and satin, and
   *   why flat paint shows a little sheen at grazing (a few GU at 85°).
   *
   * How the values were chosen. A virtual gloss meter (tests/sheen_check.py:
   * the ASTM D523 receptor apertures, Westlund & Meyer 2001; GGX + Smith +
   * exact Fresnel, n = 1.5; divided by the n = 1.567 black-glass standard)
   * predicts each sheen's reading. α, v and k were set so that the
   * prediction lands inside the MPI band, using the single-lobe GGX fit
   * (60° GU: α 0.02 → 61, 0.03 → 47, 0.05 → 31, 0.07 → 21, 0.10 → 14,
   * 0.30 → 2) and the hazy-gloss idea of a sharp lobe plus a diffuse part
   * (Barla et al. 2018). Pellacini et al. 2000 used Ward α 0.04-0.10 for
   * glossy paints, consistent with these values. The Micom Labs SCI/SCE
   * measurements of one material in three finishes (3 / 7 / 81 GU) anchor
   * v: the 3 GU finish keeps ~95 % of its veil (v ≈ 0.95 for Flat).
   *
   * Predicted readings (tests/sheen_check.py), GU at 20° / 60° / 85°:
   *   Flat        0.1 /  0.2 (2.3 for a white flat: body light leaks into
   *               the aperture) /  3.5      MPI G1:  60° 0-5,   85° ≤ 10
   *   Eggshell    1.3 / 10.9 / 22.1         MPI G3:  60° 10-25, 85° 10-35
   *   Satin       4.3 / 23.7 / 47.8         MPI G4:  60° 20-35, 85° ≥ 35
   *   Semi-gloss 14.7 / 48.5 / 84.9         MPI G5:  60° 35-70 (target 50)
   *
   * Off-highlight shift against the swatch (= Flat), mirror direction seeing
   * walls of the same colour, ΔL* / chroma ratio (tests/sheen_check.py):
   *   navy #2f3d4c   eggshell -4.6 / 1.22  satin -5.2 / 1.25  semi-gloss -5.7 / 1.28
   *   sage #a4aca6   eggshell -1.1 / 1.05  satin -1.3 / 1.06  semi-gloss -1.7 / 1.08
   *   off-white      eggshell -0.3 / 1.03  satin -0.4 / 1.04  semi-gloss -0.5 / 1.05
   * Dark colours deepen most, whites barely change: what Micom's SCI/SCE data
   * and every manufacturer's guidance (Behr, Dulux, Farrow & Ball) describe.
   *
   * @type {Record<"flat" | "eggshell" | "satin" | "semigloss", Sheen>}
   */
  const SHEENS = {
    flat:      { label: "Flat",       mpi: "G1", gu60: [0, 5],   alpha: 0.30,  v: 0.95, k: 21.0 },
    eggshell:  { label: "Eggshell",   mpi: "G3", gu60: [10, 25], alpha: 0.075, v: 0.45, k: 16.0 },
    satin:     { label: "Satin",      mpi: "G4", gu60: [20, 35], alpha: 0.045, v: 0.30, k: 12.0 },
    semigloss: { label: "Semi-gloss", mpi: "G5", gu60: [35, 70], alpha: 0.025, v: 0.10, k: 6.5 }
  };
  /** Display order. */
  const SHEEN_ORDER = ["flat", "eggshell", "satin", "semigloss"];

  /**
   * Visitor-facing description of each sheen. Trusted constant text (the page
   * writes it with textContent).
   *   look    how the finish looks on a wall
   *   colour  how it changes the colour
   *   use     where it is typically used
   */
  const SHEEN_COPY = {
    flat: {
      look: "Scatters its surface reflection in every direction, so it shows no reflections and hides wall texture and patches.",
      colour: "Shows the colour exactly as the chip. In dark colours a faint, chalky veil softens the colour slightly.",
      use: "Ceilings and low-traffic walls; walls with imperfections."
    },
    eggshell: {
      look: "A soft, low glow where the wall faces a window or lamp at an angle; reflections are too blurred to read.",
      colour: "A touch deeper and richer than flat away from the glow, most noticeable in mid and dark colours.",
      use: "Living rooms, bedrooms and hallways: the most common wall finish."
    },
    satin: {
      look: "A pearl-like sheen: windows and lamps appear as soft bright bands, and roller texture starts to show under raking light.",
      colour: "Dark and mid colours look noticeably deeper and more saturated off the highlights; light colours change little.",
      use: "Kitchens, bathrooms, kids' rooms: walls that are cleaned often."
    },
    semigloss: {
      look: "Recognisable, softly blurred reflections of windows and lamps, and sparkle on the wall's texture; reveals surface imperfections.",
      colour: "The deepest, most saturated colour away from highlights, and the brightest highlights, which take on the light's colour.",
      use: "Trim, doors, cabinets; walls in hard-wearing or damp areas."
    }
  };

  // ---- specular albedo -----------------------------------------------------

  /** Exact unpolarised Fresnel reflectance of a smooth dielectric at cos θ. */
  function fresnel(cos, n = BINDER_N) {
    const s = Math.sqrt(Math.max(0, 1 - cos * cos)) / n;
    if (s >= 1) return 1;
    const ct = Math.sqrt(1 - s * s);
    const rs = (cos - n * ct) / (cos + n * ct), rp = (n * cos - ct) / (n * cos + ct);
    return 0.5 * (rs * rs + rp * rp);
  }

  /**
   * Directional albedo of a GGX lobe: the share of light from even
   * surroundings that the lobe reflects toward a viewer at cos θ = nov.
   * Exact Fresnel (n = 1.5) at the half vector and height-correlated Smith
   * masking-shadowing (Heitz 2014), integrated with stratified half-vector
   * samples (the same quadrature as albedo() in tests/sheen_check.py).
   *
   * The first version used Karis' EnvBRDFApprox (Schlick Fresnel), which is
   * 12-27 % low at 50-66° from the normal, where this room's back wall is
   * seen (tests/sheen_check.py, section C): reflections and the off-
   * highlight deepening were both a fifth too weak.
   */
  function specularAlbedo(alpha, nov, N = 64, M = 16) {
    const lam = c => 0.5 * (-1 + Math.sqrt(1 + alpha * alpha * (1 - c * c) / (c * c)));
    const vx = Math.sqrt(Math.max(0, 1 - nov * nov));
    let s = 0;
    for (let i = 0; i < N; i++) {
      const u = (i + 0.5) / N;
      const ct = Math.sqrt((1 - u) / (1 + (alpha * alpha - 1) * u)), st = Math.sqrt(1 - ct * ct);
      for (let j = 0; j < M; j++) {
        const ph = 2 * Math.PI * (j + 0.5) / M;
        const voh = vx * st * Math.cos(ph) + nov * ct;
        if (voh <= 0) continue;
        const lz = 2 * voh * ct - nov;
        if (lz <= 0) continue;
        s += fresnel(voh) / (1 + lam(nov) + lam(lz)) * voh / (ct * nov);
      }
    }
    return s / (N * M);
  }

  /** Entries of the shader's albedo table, at cos θ = (i + 0.5) / ALBEDO_N. */
  const ALBEDO_N = 32;
  /** @type {Map<number, Float32Array>} */
  const albedoTables = new Map();
  /** The albedo table of a GGX α (cached; the shader's sheenAlb uniform, vec4[8]). */
  function albedoTable(alpha) {
    let t = albedoTables.get(alpha);
    if (!t) {
      t = Float32Array.from({ length: ALBEDO_N }, (_, i) => specularAlbedo(alpha, (i + 0.5) / ALBEDO_N));
      albedoTables.set(alpha, t);
    }
    return t;
  }

  /**
   * @returns {keyof SHEENS}
   * @throws {RangeError} For an unknown sheen.
   */
  function toSheen(key) {
    if (!Object.hasOwn(SHEENS, key)) throw new RangeError(`Unknown sheen "${key}"`);
    return key;
  }

  // ======================================================================
  // Camera and room geometry
  // ======================================================================
  //
  // The reflections are traced in 3-D: each wall pixel's mirror ray is
  // followed to the other wall or the floor, and that point is looked up in
  // the photo. That needs the camera and the room's planes, which are
  // recovered from straight lines in the photo (single-view metrology,
  // Criminisi, Reid & Zisserman 1999; Hartley & Zisserman ch. 8):
  //
  //  1. Lines that are horizontal in the room and run along one wall meet at
  //     that wall's vanishing point (VP). The back wall's VP is their least-
  //     squares intersection.
  //  2. The photos have perspective-corrected verticals (a "shift lens"), so
  //     the camera has no pitch: the horizon is a straight line through the
  //     VPs, tilted only by the camera's roll, which the near-vertical lines
  //     measure.
  //  3. The window wall's VP lies on that horizon; its position is fitted to
  //     the window wall's lines (smallest endpoint error).
  //  4. The principal point is the image centre's column on the horizon (the
  //     shift lens moves it vertically only). The walls are perpendicular, so
  //     their VP directions are too: f² = (xL - cx)(cx - xR) along the horizon.
  //  5. The corner (a vertical line) fixes where the walls meet; the scene's
  //     scale is arbitrary, so the corner is put at depth 1. A point where
  //     the back wall meets the floor fixes the floor's height.
  //
  // Coordinates. Image: u, v in units of the image WIDTH, origin top-left,
  // v down (the photos are square, so both run 0..1). Camera space: x right,
  // y up, z forward (into the room), camera at the origin.

  /**
   * Measured geometry of one room photo, all in image units (u, v).
   * @typedef {Object} RoomGeometry
   * @property {number[][]} backLines  [u1, v1, u2, v2] segments that are horizontal
   *   in the room and lie along the back wall.
   * @property {number[][]} sideLines  Same, along the side (window) wall.
   * @property {number[][]} verticals  Segments that are vertical in the room.
   * @property {number} cornerU       u of the wall corner (a vertical line).
   * @property {"left" | "right"} sideWall  Which side of the corner the side wall is on.
   * @property {[number, number]} floorPoint  A point where the back wall meets the floor.
   */

  /**
   * The solved camera and room, ready for the shader.
   * @typedef {Object} Camera
   * @property {[number, number]} c     Principal point (u, v).
   * @property {number} f               Focal length, in image widths.
   * @property {[number, number]} rot   cos, sin of the roll.
   * @property {number[]} side          Side-wall plane: [nx, ny, nz, h] with n·X = h,
   *                                    n pointing into the room (toward the camera).
   * @property {number[]} back          Back-wall plane, likewise.
   * @property {number} floorY          Floor plane y = floorY (camera height is -floorY).
   * @property {number} cornerX         The corner's x in roll-corrected image offsets
   *                                    (u - cx after the roll), as RENDER tests it.
   * @property {number} sideSign        +1 if the side wall is right of the corner, -1 if left.
   * @property {Object} report          Diagnostics: VPs, horizontal FOV, wall angles, fit error.
   */

  const v3 = {
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    norm: a => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; }
  };

  /** Least-squares intersection point of 2-D lines (each [u1, v1, u2, v2]), weighted by length². */
  function intersectLines(lines) {
    // Each line: n·p = d with unit normal n. Minimise Σ w (n·p - d)².
    let a = 0, b = 0, c = 0, e = 0, g = 0;
    for (const [x1, y1, x2, y2] of lines) {
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy), w = len * len;
      const nx = -dy / len, ny = dx / len, d = nx * x1 + ny * y1;
      a += w * nx * nx; b += w * nx * ny; c += w * ny * ny; e += w * nx * d; g += w * ny * d;
    }
    const det = a * c - b * b;
    return [(c * e - b * g) / det, (a * g - b * e) / det];
  }

  /**
   * Solves the camera and the room planes (see the comment block above).
   * @param {RoomGeometry} g
   * @returns {Camera}
   */
  function solveCamera(g) {
    // 1. Back wall VP.
    const vpB = intersectLines(g.backLines);
    // 2. Roll: the mean lean of the verticals (length-weighted). Rotating the
    // image by the roll turns a vertical's direction (0, 1) into
    // (-sin, cos), so du/dv = -tan(roll), and the horizon's (1, 0) into
    // (cos, sin): its slope dv/du = tan(roll) = -du/dv of the verticals.
    let su = 0, sv = 0;
    for (const [x1, y1, x2, y2] of g.verticals) { const s = y2 > y1 ? 1 : -1; su += s * (x2 - x1); sv += s * (y2 - y1); }
    const slope = -su / sv;                        // horizon: v = vpB.v + slope (u - vpB.u)
    const roll = Math.atan(slope);
    const horizon = u => vpB[1] + slope * (u - vpB[0]);
    // 3. Side wall VP on the horizon: minimise the RMS endpoint error of the
    // side lines when each is redrawn through the VP (pivoting at its midpoint).
    const err = u => {
      const vp = [u, horizon(u)];
      let s = 0;
      for (const [x1, y1, x2, y2] of g.sideLines) {
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, half = Math.hypot(x2 - x1, y2 - y1) / 2;
        const a1 = Math.atan2(y2 - y1, x2 - x1), a2 = Math.atan2(vp[1] - my, vp[0] - mx);
        let da = Math.abs(a1 - a2) % Math.PI; da = Math.min(da, Math.PI - da);
        s += (half * Math.sin(da)) ** 2;
      }
      return s / g.sideLines.length;
    };
    // The VP is on the far side of the image from the back wall's VP.
    const dir = vpB[0] < 0.5 ? 1 : -1;
    let best = null;
    for (let i = 1; i <= 4000; i++) {
      const u = 0.5 + dir * i * 0.005;             // up to 20 image widths away
      const e = err(u);
      if (!best || e < best.e) best = { u, e };
    }
    for (let step = 0.0025; step > 1e-7; step /= 2) {   // refine
      for (const u of [best.u - step, best.u + step]) { const e = err(u); if (e < best.e) best = { u, e }; }
    }
    const vpS = [best.u, horizon(best.u)];
    // 4. Principal point and focal length, in roll-corrected coordinates.
    const cos = Math.cos(roll), sin = Math.sin(roll);
    const c = [0.5, horizon(0.5)];
    const unroll = ([u, v]) => { const x = u - c[0], y = v - c[1]; return [cos * x + sin * y, -sin * x + cos * y]; };
    const qB = unroll(vpB), qS = unroll(vpS);
    const f = Math.sqrt(-qB[0] * qS[0]);
    // Directions of the walls' horizontal lines (camera space).
    const dB = v3.norm([qB[0] / f, 0, 1]), dS = v3.norm([qS[0] / f, 0, 1]);
    // 5. Corner at depth 1, on the horizon (camera height). Plane normals
    // are horizontal, perpendicular to each wall's direction, oriented toward
    // the camera.
    const corner = unroll([g.cornerU, horizon(g.cornerU)]);
    const C0 = [corner[0] / f, 0, 1];
    const plane = d => {
      let n = v3.norm(v3.cross(d, [0, 1, 0]));
      if (v3.dot(n, C0) > 0) n = v3.scale(n, -1);  // n·(camera - C0) > 0
      return [n[0], n[1], n[2], v3.dot(n, C0)];
    };
    const back = plane(dB), side = plane(dS);
    // Floor: the ray through floorPoint, on the back wall.
    const fp = unroll(g.floorPoint);
    const ray = [fp[0] / f, -fp[1] / f, 1];
    const t = back[3] / v3.dot(back, ray);
    const floorY = ray[1] * t;
    const deg = r => r * 180 / Math.PI;
    return {
      c, f, rot: [cos, sin], side, back, floorY, cornerX: corner[0], sideSign: g.sideWall === "right" ? 1 : -1,
      report: {
        vpBack: vpB, vpSide: vpS, rollDeg: deg(roll), hfovDeg: deg(2 * Math.atan(0.5 / f)),
        backWallAngleDeg: deg(Math.atan(qB[0] / f)), sideWallAngleDeg: deg(Math.atan(qS[0] / f)),
        sideLineRmsErr: Math.sqrt(best.e), orthogonality: v3.dot(dB, dS), cameraHeight: -floorY
      }
    };
  }

  /** The camera-space ray through image point (u, v). Mirrors camRay() in glsl/sheen.glsl. */
  function cameraRay(cam, [u, v]) {
    const x = u - cam.c[0], y = v - cam.c[1], [cos, sin] = cam.rot;
    const qx = cos * x + sin * y, qy = -sin * x + cos * y;
    return v3.norm([qx / cam.f, -qy / cam.f, 1]);
  }

  /** Image point (u, v) of camera-space point X. Mirrors project() in glsl/sheen.glsl. */
  function project(cam, X) {
    const qx = X[0] / X[2] * cam.f, qy = -X[1] / X[2] * cam.f, [cos, sin] = cam.rot;
    return [cam.c[0] + cos * qx - sin * qy, cam.c[1] + sin * qx + cos * qy];
  }

  /**
   * The 3-D point on a wall seen at image point (u, v), moved `offset` (scene
   * units; the corner is at depth 1) into the room. For placing lights.
   * @param {Camera} cam
   * @param {[number, number]} uv
   * @param {"side" | "back"} wall
   * @param {number} [offset=0]
   */
  function pointOnWall(cam, uv, wall, offset = 0) {
    const p = cam[wall], d = cameraRay(cam, uv);
    const X = v3.scale(d, p[3] / v3.dot(p, d));
    return v3.add(X, v3.scale(p, offset));
  }

  // ======================================================================
  // Uniforms for one photo
  // ======================================================================

  /** RENDER's emitter slots (glsl/sheen.glsl: emitRect / emitGain arrays). */
  const MAX_EMITTERS = 4;

  /**
   * A region of the photo whose light sources the camera compressed: the
   * photo shows a window or a bulb barely brighter than a white wall, while
   * in the room it is many times brighter. The ENV pass multiplies the
   * region's pixels (those at or above `threshold`, linear luminance) by
   * `gain` before they are reflected, so glossy walls reflect a light source
   * as a light source. (Khan et al. 2006 needed HDR input for the same
   * reason; 8-bit photos clip or compress emitters.)
   * @typedef {{ rect: [number, number, number, number], threshold: number, gain: number, note?: string }} Emitter
   *   rect = [u0, v0, u1, v1] in image units.
   */

  /**
   * The sheen part of a RenderJob for one photo: uniforms (names as in
   * glsl/sheen.glsl) plus a key for the cached environment.
   * @param {keyof SHEENS} sheenKey
   * @param {Camera} cam
   * @param {{ emitters: Emitter[], keyLight: number[] }} photo
   *   keyLight: camera-space position of the light that rakes the walls
   *   (from pointOnWall), for the micro-normals.
   * @returns {{ uniforms: Record<string, any>, envKey: string }}
   */
  function sheenJob(sheenKey, cam, photo) {
    const s = SHEENS[toSheen(sheenKey)];
    const rects = new Float32Array(4 * MAX_EMITTERS), gains = new Float32Array(2 * MAX_EMITTERS);
    photo.emitters.slice(0, MAX_EMITTERS).forEach((e, i) => {
      rects.set(e.rect, 4 * i);
      gains.set([e.threshold, e.gain], 2 * i);
    });
    for (let i = photo.emitters.length; i < MAX_EMITTERS; i++) gains.set([2, 1], 2 * i);   // unused: gain 1
    return {
      uniforms: {
        sheenP: [s.alpha, s.v, s.k], sheenAlb: albedoTable(s.alpha), sheenIor: BINDER_N, sheenFloor: DARKEN_FLOOR,
        camC: cam.c, camF: cam.f, camRot: cam.rot,
        planeSide: cam.side, planeBack: cam.back, floorY: cam.floorY, cornerX: cam.cornerX, sideSign: cam.sideSign,
        keyLight: photo.keyLight, emitRect: rects, emitGain: gains
      },
      // The environment holds the photo and the painted walls, not the sheen,
      // so it only depends on the geometry and the emitters.
      envKey: JSON.stringify([cam.c, cam.f, cam.side, cam.back, photo.emitters])
    };
  }

  // ---------------------------------------------------------------- export
  window.SheenModel = {
    SURFACE_F0, BINDER_N, DARKEN_FLOOR, SHEENS, SHEEN_ORDER, SHEEN_COPY, MAX_EMITTERS, ALBEDO_N, toSheen,
    fresnel, specularAlbedo, albedoTable,
    intersectLines, solveCamera, cameraRay, project, pointOnWall, sheenJob
  };
})();
