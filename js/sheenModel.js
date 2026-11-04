/* ==========================================================================
 * sheenModel.js — the paint sheen model behind sheenSceneRenderer.html:
 * what each sheen IS physically (SHEENS), what visitors are told about it
 * (SHEEN_COPY), and the room geometry the reflections need (solveRoom).
 *
 *   SHEENS        Flat / Eggshell / Satin / Semi-gloss as surface-reflection
 *                 parameters, each with its source and its check
 *   SHEEN_COPY    the visitor-facing description of each sheen
 *   solveRoom()   a pinhole camera + the room's walls, floor and ceiling,
 *                 from straight lines measured in the photo
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
  // The reflections are traced in 3-D: each wall pixel's reflected rays are
  // followed to the room's other planes, and the points they reach are looked
  // up in the photo. That needs the camera and the room's planes, recovered
  // from straight lines in the photo (single-view metrology, Criminisi, Reid
  // & Zisserman 1999; Hartley & Zisserman ch. 8):
  //
  //  1. Lines that are horizontal in the room and run in one direction meet
  //     at that direction's vanishing point (VP). Direction "a" (usually the
  //     back wall's) is the least-squares intersection of its lines.
  //  2. The photos have perspective-corrected verticals (a "shift lens"), so
  //     the camera has no pitch: the horizon is a straight line through the
  //     VPs, tilted only by the camera's roll, which the verticals measure.
  //  3. The perpendicular direction "b" has its VP on that horizon, fitted to
  //     its lines (smallest endpoint error). Any lines will do: a side wall's,
  //     a window's, or a rug's edge when no side wall is visible.
  //  4. The principal point is the image centre's column on the horizon (the
  //     shift lens moves it vertically only). The two directions are
  //     perpendicular, so f² = (ua - cx)(cx - ub) along the horizon.
  //  5. Walls are vertical planes along a direction: "a", "b", or "a±b"
  //     (a 45° chamfer). The first is anchored at depth 1 (the scene's scale
  //     is arbitrary); each next one passes through its corner with a wall
  //     already placed. The floor (and a ceiling, if visible) passes through
  //     points on known walls: one point for a level plane, three for a
  //     sloped one.
  //
  // A room seen from inside is (close to) convex, so the wall a pixel shows
  // is the first wall its camera ray reaches, and a reflected ray lands on the
  // first plane it reaches - no corner lines or wall masks are needed, and
  // any number of walls works (glsl/sheen.glsl: visibleWall, traceRoom).
  //
  // Coordinates. Image: u, v in units of the image WIDTH, origin top-left,
  // v down (the photos are square, so both run 0..1). Camera space: x right,
  // y up, z forward (into the room), camera at the origin.

  /**
   * Measured geometry of one room photo, in image units (u, v).
   * @typedef {Object} RoomGeometry
   * @property {{ a: number[][], b?: number[][], bSloped?: number[][] }} lines
   *   [u1, v1, u2, v2] segments that are horizontal in the room, along
   *   direction a and along the perpendicular direction b; or, instead of b,
   *   bSloped: two or more parallel sloped lines in walls of direction b
   *   (a sloped ceiling's edges on two parallel walls), whose VP is straight
   *   above or below b's. Avoid picture frames: large frames hang tilted
   *   forward, so their edges aren't parallel to the wall.
   * @property {number[][]} verticals  Segments that are vertical in the room.
   * @property {WallSpec[]} walls      In order; the first has `through`, the others `corner`.
   * @property {PlaneSpec} floor
   * @property {PlaneSpec} [ceiling]
   * @property {number} [focal]  The focal length (image widths), when known (a photo's EXIF):
   *   then direction b's VP follows from a's (perpendicular directions: qA qB = -f²) and
   *   b lines are optional.
   *
   * @typedef {Object} WallSpec
   * @property {string} id
   * @property {"a" | "b" | "a+b" | "a-b"} dir  The direction its horizontal lines run
   *   ("a±b": a 45° chamfer across a corner).
   * @property {{ u: number, depth?: number }} [through]  First wall: passes through
   *   the point at image column u on the horizon, at depth (default 1).
   * @property {{ wall: string, u: number }} [corner]  Passes through the point of
   *   `wall` at image column u on the horizon (their shared corner).
   *
   * @typedef {{ wall: string, uv: [number, number] }} WallPoint  A point seen at uv, on `wall`.
   * @typedef {{ at: WallPoint } | { through: [WallPoint, WallPoint, WallPoint] }} PlaneSpec
   *   at: a level plane through that point; through: the plane through three points.
   */

  /**
   * The solved camera and room, ready for the shader.
   * @typedef {Object} Room
   * @property {[number, number]} c     Principal point (u, v).
   * @property {number} f               Focal length, in image widths.
   * @property {[number, number]} rot   cos, sin of the roll.
   * @property {{ id: string, kind: "wall" | "floor" | "ceiling", p: number[] }[]} planes
   *   Walls first. p = [nx, ny, nz, h] with n·X = h, n pointing into the room.
   * @property {Object} report          Diagnostics: VPs, field of view, fit error, heights.
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
   * Solves the camera and the room's planes (see the comment block above).
   * @param {RoomGeometry} g
   * @returns {Room}
   */
  function solveRoom(g) {
    // 1. Direction a's VP.
    const vpA = intersectLines(g.lines.a);
    // 2. Roll: the mean lean of the verticals (length-weighted). Rotating the
    // image by the roll turns a vertical's direction (0, 1) into
    // (-sin, cos), so du/dv = -tan(roll), and the horizon's (1, 0) into
    // (cos, sin): its slope dv/du = tan(roll) = -du/dv of the verticals.
    let su = 0, sv = 0;
    for (const [x1, y1, x2, y2] of g.verticals) { const s = y2 > y1 ? 1 : -1; su += s * (x2 - x1); sv += s * (y2 - y1); }
    const slope = -su / sv;                        // horizon: v = vpA.v + slope (u - vpA.u)
    const roll = Math.atan(slope);
    const horizon = u => vpA[1] + slope * (u - vpA[0]);
    // 3. Direction b's VP on the horizon: minimise the RMS endpoint error of
    // its lines when each is redrawn through the VP (pivoting at its midpoint).
    const errFor = lines => u => {
      const vp = [u, horizon(u)];
      let s = 0;
      for (const [x1, y1, x2, y2] of lines) {
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, half = Math.hypot(x2 - x1, y2 - y1) / 2;
        const a1 = Math.atan2(y2 - y1, x2 - x1), a2 = Math.atan2(vp[1] - my, vp[0] - mx);
        let da = Math.abs(a1 - a2) % Math.PI; da = Math.min(da, Math.PI - da);
        s += (half * Math.sin(da)) ** 2;
      }
      return s / lines.length;
    };
    // Perpendicular directions have their VPs on opposite sides of the
    // principal point's column (0.5).
    let best = null;
    if (g.focal && !g.lines.bSloped) {
      // Known focal length: b's VP is where perpendicularity puts it. On the
      // horizon, the unrolled offset from the principal point is
      // (u - 0.5)(cos + sin slope); qA qB = -f².
      const cs = Math.cos(roll), sn = Math.sin(roll), k = cs + sn * slope;
      const qA = k * (vpA[0] - 0.5);                          // vpA lies on the horizon
      const qB = -g.focal * g.focal / qA;
      best = { u: 0.5 + qB / k, e: g.lines.b && g.lines.b.length ? errFor(g.lines.b)(0.5 + qB / k) : 0 };
    } else if (g.lines.bSloped) {
      // Alternative: sloped lines that lie in walls of direction b (e.g.
      // where a sloped ceiling meets two parallel walls) are parallel in 3-D
      // and vertical-plane-bound, so - with no pitch - their VP is straight
      // above or below b's: it gives b's column.
      const p = intersectLines(g.lines.bSloped);
      best = { u: p[0] - slope * (p[1] - horizon(p[0])), e: 0 };   // along the (rolled) vertical to the horizon
    } else {
      const err = errFor(g.lines.b), dir = vpA[0] < 0.5 ? 1 : -1;
      for (let i = 1; i <= 4000; i++) {
        const u = 0.5 + dir * i * 0.0025;          // up to 10 image widths away
        const e = err(u);
        if (!best || e < best.e) best = { u, e };
      }
      for (let step = 0.00125; step > 1e-7; step /= 2) {   // refine
        for (const u of [best.u - step, best.u + step]) { const e = err(u); if (e < best.e) best = { u, e }; }
      }
    }
    const vpB = [best.u, horizon(best.u)];
    // 4. Principal point and focal length, in roll-corrected coordinates.
    const cos = Math.cos(roll), sin = Math.sin(roll);
    const c = [0.5, horizon(0.5)];
    const unroll = ([u, v]) => { const x = u - c[0], y = v - c[1]; return [cos * x + sin * y, -sin * x + cos * y]; };
    const qA = unroll(vpA), qB = unroll(vpB);
    const f = Math.sqrt(-qA[0] * qB[0]);
    const cam = { c, f, rot: [cos, sin] };
    // Directions of horizontal lines (camera space).
    const dirs = { a: v3.norm([qA[0] / f, 0, 1]), b: v3.norm([qB[0] / f, 0, 1]) };
    // A 45° chamfer across the corner of an a-wall and a b-wall.
    dirs["a+b"] = v3.norm(v3.add(dirs.a, dirs.b));
    dirs["a-b"] = v3.norm(v3.sub(dirs.a, dirs.b));
    // 5. Planes.
    const planes = [], byId = {};
    const horizonPoint = u => cameraRay(cam, [u, horizon(u)]);   // a ray at camera height
    const onPlane = (p, ray) => v3.scale(ray, p[3] / v3.dot(p, ray));
    const inward = (n, P) => {                    // orient n toward the camera: n·(0 - P) > 0
      if (v3.dot(n, P) > 0) n = v3.scale(n, -1);
      return [n[0], n[1], n[2], v3.dot(n, P)];
    };
    for (const w of g.walls) {
      let P;
      if (w.through) { const r = horizonPoint(w.through.u); P = v3.scale(r, (w.through.depth || 1) / r[2]); }
      else P = onPlane(byId[w.corner.wall].p, horizonPoint(w.corner.u));
      const d = dirs[w.dir];
      const entry = { id: w.id, kind: "wall", p: inward(v3.norm(v3.cross(d, [0, 1, 0])), P) };
      planes.push(entry); byId[w.id] = entry;
    }
    const pointAt = ({ wall, uv }) => onPlane(byId[wall].p, cameraRay(cam, uv));
    const planeFrom = (spec, kind) => {
      if (spec.at) { const P = pointAt(spec.at); return { id: kind, kind, p: inward([0, kind === "floor" ? 1 : -1, 0], P) }; }
      const [P0, P1, P2] = spec.through.map(pointAt);
      return { id: kind, kind, p: inward(v3.norm(v3.cross(v3.sub(P1, P0), v3.sub(P2, P0))), P0) };
    };
    planes.push(planeFrom(g.floor, "floor"));
    if (g.ceiling) planes.push(planeFrom(g.ceiling, "ceiling"));
    const deg = r => r * 180 / Math.PI;
    const floorY = planes.find(p => p.kind === "floor").p[3];
    return {
      c, f, rot: [cos, sin], planes,
      report: {
        vpA, vpB, rollDeg: deg(roll), hfovDeg: deg(2 * Math.atan(0.5 / f)),
        angleADeg: deg(Math.atan(qA[0] / f)), angleBDeg: deg(Math.atan(qB[0] / f)),
        bLineRmsErr: Math.sqrt(best.e), cameraHeight: -floorY,
        walls: planes.filter(p => p.kind === "wall").map(p => `${p.id}: distance ${(-p.p[3]).toFixed(3)}`)
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
   * The 3-D point on a plane seen at image point (u, v), moved `offset`
   * (scene units) into the room along the plane's normal. For placing lights.
   * @param {Room} room
   * @param {[number, number]} uv
   * @param {string} id  A plane's id (a wall's, "floor" or "ceiling").
   * @param {number} [offset=0]
   */
  function pointOnWall(room, uv, id, offset = 0) {
    const pl = room.planes.find(p => p.id === id);
    if (!pl) throw new RangeError(`No plane "${id}"`);
    const p = pl.p, d = cameraRay(room, uv);
    const X = v3.scale(d, p[3] / v3.dot(p, d));
    return v3.add(X, v3.scale(p, offset));
  }

  /**
   * The 3-D point seen at image point (u, v) that is `offset` (scene units)
   * in front of plane `id`: on the camera ray, where the ray's distance to
   * the plane is offset. This places an object (a lamp) that the photo shows
   * in front of a wall: it is on its pixel's ray, not on the wall behind it.
   * @param {Room} room
   * @param {[number, number]} uv
   * @param {string} id
   * @param {number} offset
   */
  function pointOffWall(room, uv, id, offset) {
    const pl = room.planes.find(p => p.id === id);
    if (!pl) throw new RangeError(`No plane "${id}"`);
    const p = pl.p, d = cameraRay(room, uv);
    return v3.scale(d, (p[3] + offset) / v3.dot(p, d));   // n·X = h + offset
  }

  /**
   * Which wall the camera sees at image point (u, v): the first wall its ray
   * reaches (the room is convex). Mirrors visibleWall() in glsl/sheen.glsl.
   * @returns {string} The wall's id.
   */
  function wallAt(room, uv) {
    const d = cameraRay(room, uv);
    let best = null, tBest = Infinity;
    for (const pl of room.planes) {
      if (pl.kind !== "wall") continue;
      const dn = v3.dot(pl.p, d);
      if (dn < -1e-5) { const t = pl.p[3] / dn; if (t > 0 && t < tBest) { tBest = t; best = pl.id; } }
    }
    return best;
  }

  // ======================================================================
  // The wall's texture, and whether the photo really shows it
  // ======================================================================
  //
  // Glints come from the wall's texture: in a photo, a surface tilted toward
  // the light is brighter, so small brightness variations give the tilts
  // (glsl/sheen.glsl, micro-normals). But JPEG compression and 8-bit
  // quantisation add variations of their own. Measured on these photos'
  // walls, brightness steps across the JPEG's 8 x 8 block edges are 1.3-4.8x
  // those inside blocks (1.0 = no blocking), and the detail INSIDE blocks -
  // which the blocking doesn't reach - is 2.7 / 4.0 (living room 2, day /
  // night), 1.7 / 2.4 (deck), 0.35 / 0.68 (living room) and 0.21 / 0.31
  // (study) 8-bit levels per pixel, against a noise floor of about 0.3-0.7.
  // In the living room and the study the walls show no measurable texture:
  // their "texture" was compression, and glossy finishes reflected it as
  // patchy mosaics. (Smoothing the block averages away was tried; JPEG's
  // in-block ramps leave the steps, so it didn't help.)
  //
  // So each photo's texture map is scaled by how far its in-block wall
  // detail stands above that noise floor: 0 below 0.8 levels/px, rising
  // smoothly to 1 at 2.0. The map itself is the luminance over its local
  // mean (3 box blurs of radius 3, Gaussian-like, sigma ≈ 3.5 px) minus 1,
  // stored in the photo's alpha channel (128 + 512 x detail, ±0.25), which
  // RENDER reads: no extra GPU memory.

  /** sRGB byte -> linear, as a lookup table. */
  const LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
    const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });

  /** In-place box blur of radius r, rows then columns (`tmp` is scratch of the same size). */
  function boxBlur(a, tmp, w, h, r) {
    const n = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const o = y * w;
      let s = 0;
      for (let x = -r; x <= r; x++) s += a[o + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[o + x] = s / n;
        s += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = s / n;
        s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
  }

  /**
   * A photo's texture measurements.
   * @param {Uint8ClampedArray} rgba  The photo's pixels (getImageData).
   * @param {Uint8ClampedArray | null} mask  The wall mask at the same size (black = wall), or null.
   * @param {number} w
   * @param {number} h
   * @returns {{ detail: Float32Array, inBlock: number, blockiness: number, gain: number }}
   *   detail   luminance / local mean - 1, per pixel
   *   inBlock  mean |step| between horizontal neighbours inside 8 x 8 blocks, on
   *            wall pixels, in 8-bit levels of luma (the texture's strength)
   *   blockiness  steps across block edges / steps inside blocks
   *   gain     the factor the texture map is stored with (see above)
   */
  function textureDetail(rgba, mask, w, h) {
    const Y = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++)
      Y[i] = 0.2126729 * LINEAR[rgba[4 * i]] + 0.7151522 * LINEAR[rgba[4 * i + 1]] + 0.0721750 * LINEAR[rgba[4 * i + 2]];
    let inS = 0, inN = 0, edS = 0, edN = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x + 1 < w; x++) {
      const i = y * w + x;
      if (mask && (mask[4 * i] > 40 || mask[4 * (i + 1)] > 40)) continue;
      const luma = j => 0.299 * rgba[4 * j] + 0.587 * rgba[4 * j + 1] + 0.114 * rgba[4 * j + 2];
      const g = Math.abs(luma(i + 1) - luma(i));
      if ((x & 7) === 7) { edS += g; edN++; } else { inS += g; inN++; }
    }
    const inBlock = inN ? inS / inN : 0, blockiness = inS > 0 ? (edS / edN) / inBlock : 1;
    const t = Math.min(1, Math.max(0, (inBlock - 0.8) / 1.2)), gain = t * t * (3 - 2 * t);
    const mean = Float32Array.from(Y), tmp = new Float32Array(w * h);
    for (let k = 0; k < 3; k++) boxBlur(mean, tmp, w, h, 3);
    for (let i = 0; i < w * h; i++) Y[i] = mean[i] > 1e-4 ? Y[i] / mean[i] - 1 : 0;
    return { detail: Y, inBlock, blockiness, gain };
  }

  /**
   * The photo to upload for sheen rendering: its pixels, with its texture map
   * (scaled by the texture gain) in the alpha channel: 128 + 512 x detail.
   * Uploaded without premultiplication, so the colours are exactly the photo's.
   * @param {HTMLImageElement} img   Decoded, same-origin.
   * @param {HTMLImageElement} [maskImg]  The room's wall mask (any size).
   * @returns {Promise<ImageBitmap & { texture?: object }>}  `.texture` holds the measurements.
   */
  async function photoWithDetail(img, maskImg) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;   // an <img> or a canvas
    const ctx = Object.assign(document.createElement("canvas"), { width: w, height: h }).getContext("2d", { willReadFrequently: true });
    let mask = null;
    if (maskImg) { ctx.drawImage(maskImg, 0, 0, w, h); mask = ctx.getImageData(0, 0, w, h).data; ctx.clearRect(0, 0, w, h); }
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, w, h);
    const tex = textureDetail(data.data, mask, w, h);
    for (let i = 0; i < w * h; i++)
      data.data[4 * i + 3] = Math.round(128 + 512 * Math.max(-0.25, Math.min(0.248, tex.gain * tex.detail[i])));
    const bitmap = await createImageBitmap(data, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    bitmap.texture = { inBlock: tex.inBlock, blockiness: tex.blockiness, gain: tex.gain };
    return bitmap;
  }

  // ======================================================================
  // Lamps: small light sources off the walls
  // ======================================================================
  //
  // The environment treats everything in the photo as lying on the room's
  // planes. That is right for windows (in a wall) but not for lamps that
  // stand or hang off the walls: a bulb 20 cm from a wall reflects in a glossy
  // wall displaced by about twice that distance, while the environment puts
  // it on the wall, where its "reflection" falls behind the lamp itself. So
  // lamps are lights in 3-D: placed off a wall, and reflected analytically
  // (GGX highlight of a sphere light, glsl/sheen.glsl lampSpecular).
  //
  // Their intensity comes from the photo. Every configured lamp uses its own
  // pixels ("core"): the linear RGB of the pixels above a threshold, summed,
  // x one pixel's area at the lamp's depth (radiance x area = intensity),
  // x the emitter gain the camera's tone curve took off (12 for bare bulbs,
  // 5 for lit shades: the same gains the environment uses).
  //
  // The physically better route - fit I so that the lamp brightens the wall
  // around it as much as the photo shows (irradiance I cos / r², least
  // squares per channel over rings at 0.5-2x its distance) - is implemented
  // too (no `core`), but failed on all four photos: their walls show no
  // inverse-square falloff (fits gave zero or one-channel intensities, R²
  // < 0.15). The night photos are tone-mapped, possibly generated; their
  // light pools are painted, not photometric. See docs/sheen-science.md §5B.

  /**
   * A lamp as configured.
   * @typedef {Object} LampSpec
   * @property {[number, number]} uv     Where the lamp is in the photo (it is on that pixel's ray).
   * @property {string} wall             The plane it is in front of.
   * @property {number} offset           Its distance from that plane (scene units).
   * @property {number} radius           Its radius (scene units).
   * @property {[number, number, number]} [axis]  Main direction, for a shaded lamp...
   * @property {number} [cone]           ... and the cosine of its half-angle (default: all around).
   * @property {[number, number]} [glow] A wall point it visibly lights (default: the
   *   point of `wall` nearest to it).
   * @property {{ rect: number[], threshold: number, gain: number }} [core]  Use its own
   *   pixels instead (rect in image units).
   */

  /**
   * Calibrates the lamps of one photo (see above).
   * @param {Room} room
   * @param {LampSpec[]} specs
   * @param {HTMLImageElement} img      The photo, decoded.
   * @param {HTMLImageElement} maskImg  The room's mask, decoded.
   * @returns {{ pos: number[], radius: number, I: number[], axis: number[], cone: number, report: string }[]}
   *   I in the photo's linear units x scene units² (RENDER divides by refY).
   */
  function calibrateLamps(room, specs, img, maskImg) {
    if (!specs || !specs.length) return [];
    const w = img.naturalWidth, h = img.naturalHeight;
    const ctx = Object.assign(document.createElement("canvas"), { width: w, height: h }).getContext("2d", { willReadFrequently: true });
    ctx.drawImage(maskImg, 0, 0, w, h);
    const mask = ctx.getImageData(0, 0, w, h).data;
    ctx.drawImage(img, 0, 0);
    const pix = ctx.getImageData(0, 0, w, h).data;
    const rgbAt = ([u, v], r = 4) => {             // mean linear RGB of wall pixels around (u, v)
      const cx = Math.round(u * w), cy = Math.round(v * h), s = [0, 0, 0];
      let n = 0;
      for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = 4 * (y * w + x);
        if (mask[i] > 40) continue;
        for (let k = 0; k < 3; k++) s[k] += LINEAR[pix[i + k]];
        n++;
      }
      return n ? s.map(c => c / n) : null;
    };
    const lum = c => 0.2126729 * c[0] + 0.7151522 * c[1] + 0.0721750 * c[2];
    return specs.map(sp => {
      const pl = room.planes.find(p => p.id === sp.wall).p, n = [pl[0], pl[1], pl[2]];
      const pos = pointOffWall(room, sp.uv, sp.wall, sp.offset);
      const axis = sp.axis ? v3.norm(sp.axis) : [0, -1, 0], cone = sp.cone ?? -1;
      let I = null, report;
      if (sp.core) {
        // A clipped core is white whatever the lamp's colour (measured: bulb
        // cores 1.05 : 1 : 0.8 R:G:B against 1.6 : 0.9 : 0.25 in their
        // unclipped halos). Then the colour comes from the halo - the pixels
        // at 50-100 % of the threshold, mostly the bulb's own bloom - and
        // the luminance from the core.
        const [u0, v0, u1, v1] = sp.core.rect, s = [0, 0, 0], halo = [0, 0, 0];
        let count = 0, clipped = 0, haloN = 0;
        for (let y = Math.floor(v0 * h); y < v1 * h; y++) for (let x = Math.floor(u0 * w); x < u1 * w; x++) {
          const i = 4 * (y * w + x), c = [LINEAR[pix[i]], LINEAR[pix[i + 1]], LINEAR[pix[i + 2]]], l = lum(c);
          if (l < sp.core.threshold) {
            if (l >= 0.5 * sp.core.threshold) { for (let k = 0; k < 3; k++) halo[k] += c[k]; haloN++; }
            continue;
          }
          for (let k = 0; k < 3; k++) s[k] += c[k];
          count++;
          if (Math.max(pix[i], pix[i + 1], pix[i + 2]) >= 250) clipped++;
        }
        const area = (pos[2] / room.f / w) ** 2;  // one pixel's area at the lamp's depth (image width = 1)
        const useHalo = count > 0 && clipped > 0.25 * count && haloN >= 20 && lum(halo) > 0;
        const colour = useHalo ? v3.scale(halo, lum(s) / lum(halo)) : s;
        I = colour.map(c => c * area * sp.core.gain);
        report = `core: ${count} px (${Math.round(100 * clipped / Math.max(1, count))} % clipped)` +
                 (useHalo ? `, colour from ${haloN} halo px` : "");
      } else {
        // Samples of the visible wall around the lamp: rings at 0.5-2x its
        // distance from the wall, around its foot (or a given lit point).
        // Each gives dW = wall - ambient and the geometric factor
        // g = 0.88 cos / (pi r²) (the cone too, for a shaded lamp); I is the
        // least-squares fit dW = I g (per channel). Ambient: the median of a
        // ring at 4x the distance.
        const G = sp.glow ? pointOnWall(room, sp.glow, sp.wall) : v3.sub(pos, v3.scale(n, sp.offset));
        const t = v3.norm(v3.cross(n, [0, 1, 0])), up = [0, 1, 0], base = sp.offset;
        const around = (R, k) => { const a = 2 * Math.PI * k / 16; return v3.add(G, v3.add(v3.scale(t, R * Math.cos(a)), v3.scale(up, R * Math.sin(a)))); };
        const ring = [];
        for (let k = 0; k < 16; k++) { const P = around(4 * base, k); if (P[2] > 0) { const c = rgbAt(project(room, P)); if (c) ring.push(c); } }
        const samples = [];
        for (const f of [0, 0.5, 1, 1.5, 2]) for (let k = 0; k < (f ? 16 : 1); k++) {
          const P = around(f * base, k); if (P[2] <= 0) continue;
          const c = rgbAt(project(room, P)); if (!c) continue;
          const toL = v3.sub(pos, P), r = Math.hypot(...toL), cos = v3.dot(n, toL) / r;
          const coneW = cone < -0.99 ? 1 : Math.min(1, Math.max(0, (v3.dot(v3.scale(toL, -1 / r), axis) - cone + 0.1) / 0.2));
          if (cos > 0 && coneW > 0) samples.push({ c, g: 0.88 * cos * coneW / (Math.PI * r * r) });
        }
        if (ring.length >= 4 && samples.length >= 3) {
          ring.sort((x, y) => lum(x) - lum(y));
          const amb = ring[Math.floor(ring.length / 2)];
          let gg = 0; const gw = [0, 0, 0];
          for (const sm of samples) { gg += sm.g * sm.g; for (let k = 0; k < 3; k++) gw[k] += sm.g * (sm.c[k] - amb[k]); }
          I = gw.map(v => Math.max(0, v / gg));
          report = `glow: ${samples.length} wall samples, ambient ${lum(amb).toFixed(3)}`;
        } else { I = [0, 0, 0]; report = `glow: too few wall samples (${samples.length}, ring ${ring.length})`; }
      }
      return { pos, radius: sp.radius, I, axis, cone, report };
    });
  }

  // ======================================================================
  // Uniforms for one photo
  // ======================================================================

  /** RENDER's emitter slots (glsl/sheen.glsl: emitRect / emitGain arrays). */
  const MAX_EMITTERS = 6;
  /** RENDER's plane slots (glsl/sheen.glsl: roomPlanes). */
  const MAX_PLANES = 8;
  /** RENDER's lamp slots (glsl/sheen.glsl: lampPos / lampI / lampAxis). */
  const MAX_LAMPS = 4;
  /** RENDER's window slots (glsl/sheen.glsl: winO / winU / winV / winL). */
  const MAX_WINDOWS = 3;

  // ======================================================================
  // Windows outside the photo
  // ======================================================================
  //
  // The environment only holds what the photo shows. A window outside the
  // frame (or mostly outside: the living room's, whose edge shows at the
  // photo's right border) lights the room and is mirrored by glossy walls,
  // but no reflected ray finds it in the photo. Such windows are rectangles
  // on a room plane, given by one vertical edge seen in the photo and a width
  // along their wall; a reflected ray that reaches one reads its radiance
  // (glsl/sheen.glsl radianceFrom, filtered to the ray's cone like the
  // environment).

  /**
   * A window as configured.
   * @typedef {Object} WindowSpec
   * @property {string} wall              The plane it is in (a wall's id).
   * @property {[number, number, number]} edge  One vertical edge in the photo: [u, vTop, vBottom]
   *   (image units; u may lie outside 0..1 if extrapolated).
   * @property {number} [start=0]         Where it starts along the wall from that edge (scene
   *   units, in the `toward` direction): for a window known only from a reflection.
   * @property {number} width             Its width along the wall (scene units).
   * @property {"camera" | "away"} toward Which way along the wall it extends from that edge.
   * @property {number | number[]} radiance  Linear radiance in the photo's units (1 = a
   *   white the photo just reaches), a number (neutral) or RGB.
   */

  /**
   * Places windows in 3-D.
   * @param {Room} room
   * @param {WindowSpec[]} specs
   * @returns {{ O: number[], U: number[], V: number[], L: number[] }[]}  O the bottom
   *   corner on the edge, U along the wall (width), V up (height), L radiance.
   */
  function placeWindows(room, specs) {
    return (specs || []).map(sp => {
      const pl = room.planes.find(p => p.id === sp.wall);
      if (!pl) throw new RangeError(`No plane "${sp.wall}"`);
      const [u, vTop, vBot] = sp.edge;
      const top = pointOnWall(room, [u, vTop], sp.wall), bot = pointOnWall(room, [u, vBot], sp.wall);
      let t = v3.norm(v3.cross([0, 1, 0], pl.p.slice(0, 3)));          // horizontal, along the wall
      const toCamera = v3.dot(t, v3.scale(bot, -1)) > 0;
      if (toCamera !== (sp.toward === "camera")) t = v3.scale(t, -1);
      const L = typeof sp.radiance === "number" ? [sp.radiance, sp.radiance, sp.radiance] : sp.radiance;
      return { O: v3.add(bot, v3.scale(t, sp.start || 0)), U: v3.scale(t, sp.width), V: v3.sub(top, bot), L };
    });
  }

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
   * @param {Room} room
   * @param {{ emitters: Emitter[], keyLight: number[], lamps?: object[], windows?: object[] }} photo
   *   keyLight: camera-space position of the light that rakes the walls
   *   (from pointOnWall), for the micro-normals. lamps: from calibrateLamps.
   * @returns {{ uniforms: Record<string, any>, envKey: string }}
   */
  function sheenJob(sheenKey, room, photo) {
    const s = SHEENS[toSheen(sheenKey)];
    if (photo.emitters.length > MAX_EMITTERS) throw new RangeError(`At most ${MAX_EMITTERS} emitters`);
    if (room.planes.length > MAX_PLANES) throw new RangeError(`At most ${MAX_PLANES} planes`);
    const rects = new Float32Array(4 * MAX_EMITTERS), gains = new Float32Array(2 * MAX_EMITTERS);
    photo.emitters.forEach((e, i) => {
      rects.set(e.rect, 4 * i);
      gains.set([e.threshold, e.gain], 2 * i);
    });
    for (let i = photo.emitters.length; i < MAX_EMITTERS; i++) gains.set([2, 1], 2 * i);   // unused: gain 1
    const planes = new Float32Array(4 * MAX_PLANES);
    room.planes.forEach((pl, i) => planes.set(pl.p, 4 * i));
    const lamps = (photo.lamps || []).slice(0, MAX_LAMPS);
    const lampPos = new Float32Array(4 * MAX_LAMPS), lampI = new Float32Array(3 * MAX_LAMPS), lampAxis = new Float32Array(4 * MAX_LAMPS);
    lamps.forEach((l, i) => { lampPos.set([...l.pos, l.radius], 4 * i); lampI.set(l.I, 3 * i); lampAxis.set([...l.axis, l.cone], 4 * i); });
    const wins = photo.windows || [];
    if (wins.length > MAX_WINDOWS) throw new RangeError(`At most ${MAX_WINDOWS} windows`);
    const winO = new Float32Array(3 * MAX_WINDOWS), winU = new Float32Array(3 * MAX_WINDOWS),
          winV = new Float32Array(3 * MAX_WINDOWS), winL = new Float32Array(3 * MAX_WINDOWS);
    wins.forEach((w, i) => { winO.set(w.O, 3 * i); winU.set(w.U, 3 * i); winV.set(w.V, 3 * i); winL.set(w.L, 3 * i); });
    return {
      uniforms: {
        sheenP: [s.alpha, s.v, s.k], sheenAlb: albedoTable(s.alpha), sheenIor: BINDER_N, sheenFloor: DARKEN_FLOOR,
        camC: room.c, camF: room.f, camRot: room.rot,
        roomPlanes: planes, roomWalls: room.planes.filter(p => p.kind === "wall").length, roomPlaneCount: room.planes.length,
        keyLight: photo.keyLight, emitRect: rects, emitGain: gains,
        lampPos, lampI, lampAxis, lampCount: lamps.length,
        winO, winU, winV, winL, winCount: wins.length
      },
      // The environment holds the photo and the painted walls, not the sheen,
      // so it only depends on the geometry and the emitters.
      envKey: JSON.stringify([room.c, room.f, room.planes.map(p => p.p), photo.emitters])
    };
  }

  // ---------------------------------------------------------------- export
  window.SheenModel = {
    SURFACE_F0, BINDER_N, DARKEN_FLOOR, SHEENS, SHEEN_ORDER, SHEEN_COPY, MAX_EMITTERS, ALBEDO_N, toSheen,
    fresnel, specularAlbedo, albedoTable,
    MAX_PLANES, intersectLines, solveRoom, cameraRay, project, pointOnWall, pointOffWall, wallAt, sheenJob,
    textureDetail, photoWithDetail, calibrateLamps, MAX_LAMPS, placeWindows, MAX_WINDOWS
  };
})();
