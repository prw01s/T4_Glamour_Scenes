/* ==========================================================================
 * sheenCalib.js - automatic first guesses for calibrating a new room
 * (sheenCalibrate.html): straight lines, the camera's vanishing points, and
 * the light sources of a day and a night photo. Everything here proposes;
 * the calibration page shows the proposals over the photo for the user to
 * accept or correct, and js/sheenModel.js solveRoom does the solving.
 *
 * Classic script: defines window.SheenCalib. Uses window.SheenModel.
 *
 * Coordinates: image units (u, v) in 0..1 across a SQUARE photo, v down, as
 * everywhere in the sheen code.
 * ======================================================================== */
(function () {
  "use strict";

  const DEG = Math.PI / 180;
  /** sRGB byte -> linear. */
  const LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
    const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const lumLin = (r, g, b) => 0.2126729 * LINEAR[r] + 0.7151522 * LINEAR[g] + 0.0721750 * LINEAR[b];

  // ======================================================================
  // Line segments
  // ======================================================================
  //
  // A simplified LSD (von Gioi et al. 2012, "LSD: a Line Segment Detector",
  // IPOL): pixels are grouped by region growing from the strongest
  // gradients, joining 8-neighbours whose level-line angle (the edge's
  // direction) is within 22.5 deg of the region's; each region that is long
  // and thin is a segment, fitted by gradient-weighted principal axes (sub-
  // pixel). LSD's a-contrario validation is replaced by plain length /
  // thinness / density tests: the vanishing-point stage that follows rejects
  // stray segments anyway.

  /**
   * Luma (0..255, encoded) of RGBA pixels.
   * @param {Uint8ClampedArray} rgba
   * @param {number} w
   * @param {number} h
   */
  function gray(rgba, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = 0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2];
    return g;
  }

  /**
   * Straight segments of a grey image.
   * @param {Float32Array} img  Luma 0..255, row-major.
   * @param {number} w
   * @param {number} h
   * @param {{ minLength?: number, gradMin?: number, tol?: number }} [o]
   *   minLength in pixels (default 3 % of the larger side); gradMin the
   *   weakest gradient used (levels/px; LSD's 5.2); tol the angle tolerance (rad).
   * @returns {{ x1: number, y1: number, x2: number, y2: number, len: number, width: number, contrast: number }[]}
   *   Pixel coordinates, continuous (the image spans 0..w, 0..h).
   */
  function detectSegments(img, w, h, o = {}) {
    const minLength = o.minLength ?? 0.03 * Math.max(w, h), gradMin = o.gradMin ?? 5.2, tol = o.tol ?? 22.5 * DEG;
    // Light smoothing ([1 2 1] / 4 both ways, sigma ~0.7): JPEG and sensor
    // noise otherwise split edges into short pieces.
    const s = new Float32Array(w * h), t = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, l = x > 0 ? i - 1 : i, r = x < w - 1 ? i + 1 : i;
      t[i] = 0.25 * img[l] + 0.5 * img[i] + 0.25 * img[r];
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, u = y > 0 ? i - w : i, d = y < h - 1 ? i + w : i;
      s[i] = 0.25 * t[u] + 0.5 * t[i] + 0.25 * t[d];
    }
    // 2 x 2 gradient (LSD): at the corner between 4 pixels, i.e. at
    // continuous position (x + 1, y + 1).
    const W = w - 1, H = h - 1, n = W * H;
    const mag = new Float32Array(n), ang = new Float32Array(n);
    let maxMag = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * w + x, a = s[i], b = s[i + 1], c = s[i + w], d = s[i + w + 1];
      const gx = 0.5 * (b + d - a - c), gy = 0.5 * (c + d - a - b), k = y * W + x;
      mag[k] = Math.hypot(gx, gy);
      ang[k] = Math.atan2(gx, -gy);                 // level-line angle: along the edge
      if (mag[k] > maxMag) maxMag = mag[k];
    }
    // Pixels by decreasing gradient (bucket sort), weak ones out.
    const BINS = 1024, counts = new Uint32Array(BINS), bin = k => Math.min(BINS - 1, Math.floor(mag[k] / maxMag * BINS));
    const used = new Uint8Array(n);
    let m = 0;
    for (let k = 0; k < n; k++) { if (mag[k] < gradMin) used[k] = 1; else { counts[bin(k)]++; m++; } }
    const start = new Uint32Array(BINS);
    for (let b = BINS - 2; b >= 0; b--) start[b] = start[b + 1] + counts[b + 1];
    const order = new Uint32Array(m), fill = start.slice();
    for (let k = 0; k < n; k++) if (!used[k]) order[fill[bin(k)]++] = k;

    const segs = [], region = [];
    const diff = (a, b) => { let d = Math.abs(a - b) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; };
    for (let oi = 0; oi < m; oi++) {
      const seed = order[oi];
      if (used[seed]) continue;
      region.length = 0; region.push(seed); used[seed] = 1;
      let sx = Math.cos(ang[seed]), sy = Math.sin(ang[seed]), theta = ang[seed];
      for (let r = 0; r < region.length; r++) {
        const k = region[r], x = k % W, y = (k - x) / W;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const q = yy * W + xx;
          if (used[q] || diff(ang[q], theta) > tol) continue;
          used[q] = 1; region.push(q);
          sx += Math.cos(ang[q]); sy += Math.sin(ang[q]); theta = Math.atan2(sy, sx);
        }
      }
      if (region.length < minLength * 0.8) continue;
      // Gradient-weighted principal axes.
      let sw = 0, cx = 0, cy = 0;
      for (const k of region) { const x = k % W + 1, y = (k - k % W) / W + 1, wt = mag[k]; sw += wt; cx += wt * x; cy += wt * y; }
      cx /= sw; cy /= sw;
      let sxx = 0, sxy = 0, syy = 0;
      for (const k of region) {
        const x = k % W + 1 - cx, y = (k - k % W) / W + 1 - cy, wt = mag[k];
        sxx += wt * x * x; sxy += wt * x * y; syy += wt * y * y;
      }
      const phi = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(phi), uy = Math.sin(phi);
      let lo = Infinity, hi = -Infinity, plo = Infinity, phi2 = -Infinity;
      for (const k of region) {
        const x = k % W + 1 - cx, y = (k - k % W) / W + 1 - cy, l = x * ux + y * uy, p = -x * uy + y * ux;
        if (l < lo) lo = l; if (l > hi) hi = l; if (p < plo) plo = p; if (p > phi2) phi2 = p;
      }
      const len = hi - lo, width = Math.max(1, phi2 - plo);
      if (len < minLength || width > 2.5 + 0.04 * len || region.length < 0.5 * len * Math.min(width, 3)) continue;
      segs.push({ x1: cx + ux * lo, y1: cy + uy * lo, x2: cx + ux * hi, y2: cy + uy * hi, len, width, contrast: sw / region.length });
    }
    return segs.sort((a, b) => b.len - a.len);
  }

  /**
   * Snaps a roughly drawn line to the image edge under it: at 40 points
   * along it, the 3 strongest brightness steps within +-`reach` px across it
   * (sub-pixel by a parabola through each peak); the line through two of
   * them that most points support within 1 px (RANSAC over all pairs, within
   * 3 deg of the drawn direction; wall texture adds candidates but no
   * consistent line); then least squares through its support. The
   * endpoints keep their positions along the line.
   * @param {Float32Array} img  Luma 0..255.
   * @param {number} w
   * @param {number} h
   * @param {number[]} seg  [u1, v1, u2, v2] in image units.
   * @param {number} [reach=10]
   * @param {number} [minStep=4]  The weakest step that counts as the edge (levels across 1 px).
   *   Soft edges (a wall corner seen as a change of shading) need about 1.5.
   * @returns {{ seg: number[], rms: number, points: number } | null}  null if no edge was found.
   */
  function snapLine(img, w, h, [u1, v1, u2, v2], reach = 10, minStep = 4) {
    const x1 = u1 * w, y1 = v1 * h, x2 = u2 * w, y2 = v2 * h, L = Math.hypot(x2 - x1, y2 - y1);
    if (L < 8) return null;
    const dx = (x2 - x1) / L, dy = (y2 - y1) / L, nx = -dy, ny = dx;
    const at = (x, y) => {                    // bilinear; pixel i's centre is at i + 0.5
      x -= 0.5; y -= 0.5;
      const xi = Math.max(0, Math.min(w - 2, Math.floor(x))), yi = Math.max(0, Math.min(h - 2, Math.floor(y))), fx = x - xi, fy = y - yi, i = yi * w + xi;
      return (img[i] * (1 - fx) + img[i + 1] * fx) * (1 - fy) + (img[i + w] * (1 - fx) + img[i + w + 1] * fx) * fy;
    };
    // Up to 3 candidate edge points per sample (the strongest local maxima
    // of the brightness step across the line, either polarity).
    const K = 40, cands = [];
    for (let k = 0; k < K; k++) {
      const t = (k + 0.5) / K, cx = x1 + (x2 - x1) * t, cy = y1 + (y2 - y1) * t, g = [];
      for (let o = -reach; o <= reach; o += 0.5) g.push(Math.abs(at(cx + nx * (o + 0.5), cy + ny * (o + 0.5)) - at(cx + nx * (o - 0.5), cy + ny * (o - 0.5))));
      const peaks = [];
      for (let i = 1; i < g.length - 1; i++) if (g[i] >= minStep && g[i] >= g[i - 1] && g[i] > g[i + 1]) {
        const den = g[i - 1] - 2 * g[i] + g[i + 1], sub = den < 0 ? 0.5 * (g[i - 1] - g[i + 1]) / den : 0, off = -reach + (i + sub) * 0.5;
        peaks.push([cx + nx * off, cy + ny * off, g[i], k]);
      }
      peaks.sort((a, b) => b[2] - a[2]);
      cands.push(...peaks.slice(0, 3));
    }
    if (cands.length < 8) return null;
    // RANSAC: the line through two candidates (far apart along the line,
    // within 3 deg of the drawn direction) that the most samples support
    // within 1 px (the strongest supporting candidate per sample).
    const support = (px, py, ux, uy) => {
      const best = new Map();
      for (const c of cands) {
        const d = Math.abs(-(c[0] - px) * uy + (c[1] - py) * ux);
        if (d < 1 && (!best.has(c[3]) || best.get(c[3])[2] < c[2])) best.set(c[3], c);
      }
      return [...best.values()];
    };
    let bestSet = null, bestScore = 0;
    for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) {
      const A = cands[i], B = cands[j];
      if (Math.abs(A[3] - B[3]) < K / 4) continue;
      const ex = B[0] - A[0], ey = B[1] - A[1], el = Math.hypot(ex, ey), ux = ex / el, uy = ey / el;
      if (Math.abs(ux * dy - uy * dx) > Math.sin(3 * Math.PI / 180)) continue;
      const set = support(A[0], A[1], ux, uy), sc = set.reduce((a, c) => a + c[2], 0);
      if (sc > bestScore) { bestScore = sc; bestSet = set; }
    }
    if (!bestSet || bestSet.length < 8) return null;
    const fit = P => {
      let sw = 0, mx = 0, my = 0; for (const [x, y, wt] of P) { sw += wt; mx += wt * x; my += wt * y; } mx /= sw; my /= sw;
      let sxx = 0, sxy = 0, syy = 0; for (const [x, y, wt] of P) { sxx += wt * (x - mx) ** 2; sxy += wt * (x - mx) * (y - my); syy += wt * (y - my) ** 2; }
      const phi = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      return { mx, my, ux: Math.cos(phi), uy: Math.sin(phi) };
    };
    const dist = (f, [x, y]) => Math.abs(-(x - f.mx) * f.uy + (y - f.my) * f.ux);
    let f = fit(bestSet);
    const kept = support(f.mx, f.my, f.ux, f.uy);
    if (kept.length < 8) return null;
    f = fit(kept);
    const rms = Math.sqrt(kept.reduce((a, p) => a + dist(f, p) ** 2, 0) / kept.length);
    const proj = (x, y) => { const l = (x - f.mx) * f.ux + (y - f.my) * f.uy; return [(f.mx + f.ux * l) / w, (f.my + f.uy * l) / h]; };
    return { seg: [...proj(x1, y1), ...proj(x2, y2)], rms, points: kept.length };
  }

  // ======================================================================
  // Vanishing points
  // ======================================================================
  //
  // solveRoom's model: verticals are vertical in the photo up to a roll (a
  // shift-lens / perspective-corrected photo, no pitch), and the room's two
  // horizontal directions a and b, at right angles, have vanishing points on
  // the horizon. So:
  // 1. verticals: segments within 3 deg of vertical whose lean agrees with
  //    the weighted median within 0.6 deg (the roll);
  // 2. a: RANSAC over the other segments (length-weighted), vanishing points
  //    in homogeneous coordinates so a wall seen square-on (vanishing point
  //    at infinity) works; inlier = direction within 1 deg of the line from
  //    its midpoint to the point;
  // 3. b: the point on the horizon through a's, on the other side of the
  //    principal point's column (perpendicular directions), that the most
  //    remaining segment length agrees with, within a plausible field of
  //    view (15-130 deg).
  // Converging verticals (a tilted camera) are reported: the solver ignores
  // pitch, so such photos calibrate poorly.

  const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const lineOf = ([x1, y1, x2, y2]) => cross3([x1, y1, 1], [x2, y2, 1]);
  /** Angle (rad) between a segment and the line from its midpoint to the homogeneous point p. */
  function vpError([x1, y1, x2, y2], p) {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, dx = x2 - x1, dy = y2 - y1;
    const vx = p[0] - p[2] * mx, vy = p[1] - p[2] * my;
    const c = Math.abs(dx * vy - dy * vx) / (Math.hypot(dx, dy) * Math.hypot(vx, vy) || 1);
    return Math.asin(Math.min(1, c));
  }
  /** A seeded PRNG (mulberry32), so detection is repeatable. */
  function rng(seed) {
    return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }

  /**
   * How much each segment is architecture rather than furniture: segments
   * with wall on at least one side (picture frames, baseboards, corners,
   * window reveals - things built square to the walls) weigh 3x the others
   * (rugs, tables, sofas, which are often not quite square).
   * @param {number[][]} segs  [u1, v1, u2, v2]
   * @param {Uint8ClampedArray} mask  RGBA, black = wall.
   * @param {number} w
   * @param {number} h
   * @returns {number[]}
   */
  function wallWeights(segs, mask, w, h) {
    const isWall = (u, v) => { const x = Math.floor(u * w), y = Math.floor(v * h);
      return x >= 0 && y >= 0 && x < w && y < h && mask[4 * (y * w + x)] < 128; };
    return segs.map(([x1, y1, x2, y2]) => {
      const L = Math.hypot(x2 - x1, y2 - y1), nx = -(y2 - y1) / L, ny = (x2 - x1) / L, off = 4 / w;
      let hit = 0;
      for (let i = 0; i < 9; i++) {
        const t = (i + 0.5) / 9, u = x1 + (x2 - x1) * t, v = y1 + (y2 - y1) * t;
        if (isWall(u + nx * off, v + ny * off) || isWall(u - nx * off, v - ny * off)) hit++;
      }
      return hit >= 5 ? 3 : 1;
    });
  }

  /**
   * Sorts segments into verticals and the room's two horizontal directions.
   * @param {number[][]} segs  [u1, v1, u2, v2] in image units.
   * @param {{ weights?: number[], iterations?: number, inlierDeg?: number }} [o]
   *   weights multiply each segment's length (wallWeights).
   * @returns {{ verticals: number[][], a: number[][], b: number[][], other: number[][],
   *   vpA: number[] | null, vpB: number[] | null, rollDeg: number, hfovDeg: number | null, warnings: string[] }}
   */
  function classifyLines(segs, o = {}) {
    const iterations = o.iterations ?? 3000, tol = (o.inlierDeg ?? 1) * DEG, warnings = [];
    // Weight: length squared (as solveRoom's least squares), so long room
    // edges outweigh textures of many short parallel lines (a ribbed panel,
    // floorboards, blinds), x the architecture weight.
    const wOf = new Map(segs.map((s, i) => [s, Math.hypot(s[2] - s[0], s[3] - s[1]) ** 2 * (o.weights ? o.weights[i] : 1)]));
    // 1. Verticals and the roll.
    const lean = s => { const dx = s[2] - s[0], dy = s[3] - s[1], sg = dy >= 0 ? 1 : -1; return Math.atan2(sg * dx, sg * dy); };
    const cand = segs.filter(s => Math.abs(lean(s)) < 3 * DEG);
    let med = 0;
    if (cand.length) {
      const sorted = cand.map(s => [lean(s), wOf.get(s)]).sort((x, y) => x[0] - y[0]);
      const total = sorted.reduce((a, x) => a + x[1], 0);
      let acc = 0; for (const [l, wt] of sorted) { acc += wt; if (acc >= total / 2) { med = l; break; } }
    }
    const verticals = cand.filter(s => Math.abs(lean(s) - med) < 0.5 * DEG);
    let su = 0, sv = 0;
    for (const s of verticals) { const [x1, y1, x2, y2] = s, sg = y2 > y1 ? 1 : -1, k = wOf.get(s) / Math.hypot(x2 - x1, y2 - y1) ** 2; su += k * sg * (x2 - x1); sv += k * sg * (y2 - y1); }
    const slope = sv ? -su / sv : 0, roll = Math.atan(slope);
    if (verticals.length < 2) warnings.push("Fewer than 2 vertical lines found: draw some (door frames, wall corners, window sides).");
    else {
      // Pitch check: leans that change across the image (converging verticals).
      let sw = 0, su2 = 0, sl = 0, suu = 0, sul = 0;
      for (const s of verticals) { const wt = wOf.get(s), u = (s[0] + s[2]) / 2, l = lean(s); sw += wt; su2 += wt * u; sl += wt * l; suu += wt * u * u; sul += wt * u * l; }
      const k = (sw * sul - su2 * sl) / (sw * suu - su2 * su2 || 1);
      if (Math.abs(k) > 1.5 * DEG) warnings.push(`Vertical lines converge (lean changes ${(k / DEG).toFixed(1)}° across the photo): the camera was tilted. The solver assumes perspective-corrected verticals, so expect errors.`);
    }
    const unrollX = (u, v, c) => Math.cos(roll) * (u - c[0]) + Math.sin(roll) * (v - c[1]);

    // 2. Candidates for direction a: RANSAC pairs, scored alone.
    const rest = segs.filter(s => Math.abs(lean(s)) > 8 * DEG);
    const total = rest.reduce((a, s) => a + wOf.get(s), 0), rand = rng(12345);
    const pick = () => { let r = rand() * total; for (let i = 0; i < rest.length; i++) { r -= wOf.get(rest[i]); if (r <= 0) return i; } return rest.length - 1; };
    const inliers = (p, set) => set.filter(s => vpError(s, p) < tol);
    const score = (p, set) => { let sc = 0; for (const s of set) if (vpError(s, p) < tol) sc += wOf.get(s); return sc; };
    const cands = [];
    for (let it = 0; it < iterations && rest.length >= 2; it++) {
      const i = pick(), j = pick(); if (i === j) continue;
      const p = cross3(lineOf(rest[i]), lineOf(rest[j]));
      if (Math.abs(p[2]) < 1e-12) continue;                      // at infinity: the horizon's height is unknown
      const q = [p[0] / p[2], p[1] / p[2], 1];
      if (Math.abs(q[1] - 0.5) > 4 * Math.max(1, Math.abs(q[0] - 0.5))) continue;   // a vertical-ish point
      cands.push({ q, sc: score(q, rest) });
    }
    cands.sort((x, y) => y.sc - x.sc);
    // Distinct candidates (inlier sets overlapping by under 70 %), best 25.
    const tops = [];
    for (const c of cands) {
      if (tops.length >= 25) break;
      const inl = new Set(inliers(c.q, rest));
      if (tops.some(t => { let k = 0; for (const s of inl) if (t.inl.has(s)) k++; return k > 0.7 * Math.min(inl.size, t.inl.size); })) continue;
      tops.push({ ...c, inl });
    }
    // 3. For each, the best b on its horizon (perpendicular: the other side
    // of the principal column, a plausible field of view); keep the pair
    // that explains the most.
    const bestB = (vpA, set) => {
      const horizonAt = u => vpA[1] + slope * (u - vpA[0]), c = [0.5, horizonAt(0.5)];
      const qA = unrollX(vpA[0], vpA[1], c), H = cross3([0, horizonAt(0), 1], [1, horizonAt(1), 1]);
      let best = null;
      for (const s of set) {
        const p = cross3(lineOf(s), H);
        if (Math.abs(p[2]) < 1e-12) continue;
        const u = p[0] / p[2], qB = unrollX(u, horizonAt(u), c);
        if (qA * qB >= 0) continue;
        const f = Math.sqrt(-qA * qB), fov = 2 * Math.atan(0.5 / f) / DEG;
        if (fov < 15 || fov > 130) continue;
        const sc = score([u, horizonAt(u), 1], set);
        if (!best || sc > best.sc) best = { vp: [u, horizonAt(u)], sc, fov };
      }
      return best;
    };
    let best = null;
    for (const t of tops) {
      const others = rest.filter(s => !t.inl.has(s)), b = bestB(t.q, others);
      const sc = t.sc + (b ? b.sc : 0);
      if (!best || sc > best.sc) best = { a: t, b, sc };
    }
    if (!best) return { verticals, a: [], b: [], other: rest, vpA: null, vpB: null, rollDeg: roll / DEG, hfovDeg: null,
                        warnings: [...warnings, "Not enough slanted lines to find the room's directions."] };
    // 4. Refine a (least squares over its inliers), then b again.
    let a = [...best.a.inl];
    const vpA = window.SheenModel.intersectLines(a);
    a = inliers([vpA[0], vpA[1], 1], rest);
    const others = rest.filter(s => !a.includes(s)), B = bestB(vpA, others);
    let b = [], vpB = null, hfov = null;
    if (B) { b = inliers([B.vp[0], B.vp[1], 1], others); vpB = B.vp; hfov = B.fov; }
    else warnings.push("No second horizontal direction found: draw lines along a wall at right angles to the first (or along the floor).");
    if (a.length < 2) warnings.push("Fewer than 2 lines in the main direction.");
    return { verticals, a, b, other: others.filter(s => !b.includes(s)), vpA, vpB, rollDeg: roll / DEG, hfovDeg: hfov, warnings };
  }

  // ======================================================================
  // Light sources
  // ======================================================================
  //
  // Proposals in the categories the sheen renderer uses (sheenSceneRenderer.html
  // explains the gains):
  // * day, "window": non-wall regions at >= 0.85 linear luminance (clipped
  //   glass), at least 0.1 % of the photo; threshold 0, gain 6 (energy-balance
  //   prior: x5-7 in the calibrated rooms);
  // * night, "bulb": regions at >= 0.85 anywhere (bulbs can be grey in a
  //   mask), threshold 0.85, gain 12;
  // * night, "shade": non-wall regions at >= 0.35 with a bright core (>= 0.85)
  //   of 5-60 % of them - a glowing lampshade, partly clipped (the deck's
  //   shades: 24-35 %); lit surfaces (a table top, the floor, a window frame
  //   next to bulbs) rarely clip, and a region that is mostly core is a
  //   bulb; threshold 0.35, gain 5.
  // White frames, sills, prints and sofas clip by day like glass does; the
  // night photo tells them apart: window glass goes dark at night (< 0.06),
  // white things indoors stay lamp-lit. So with the night photo given, a
  // day window must also be dark at night - and then it need only be >= 0.6
  // by day (glass showing a sunny view is often not clipped). Proposals
  // still need checking.
  // The strongest (summed luminance) are kept, up to RENDER's emitter slots.

  /**
   * Connected regions (4-neighbour) of a boolean grid.
   * @returns {{ n: number, x0: number, y0: number, x1: number, y1: number, sx: number, sy: number, energy: number, core: number }[]}
   */
  function components(on, w, h, value, core) {
    const label = new Int32Array(w * h).fill(-1), out = [], stack = [];
    for (let i = 0; i < w * h; i++) {
      if (!on[i] || label[i] >= 0) continue;
      const c = { n: 0, x0: w, y0: h, x1: 0, y1: 0, sx: 0, sy: 0, energy: 0, core: 0 };
      label[i] = out.length; stack.push(i);
      while (stack.length) {
        const k = stack.pop(), x = k % w, y = (k - x) / w;
        c.n++; c.sx += x; c.sy += y; c.energy += value[k]; if (core && core[k]) c.core++;
        if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
        for (const q of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1])
          if (q >= 0 && on[q] && label[q] < 0) { label[q] = out.length; stack.push(q); }
      }
      out.push(c);
    }
    return out;
  }

  /**
   * Proposed emitters of one photo.
   * @param {Uint8ClampedArray} rgba  The photo (square, any size; 400-1000 px is plenty).
   * @param {Uint8ClampedArray | null} mask  The wall mask at the same size (black = wall), or null.
   * @param {number} w
   * @param {number} h
   * @param {"day" | "night"} time
   * @param {{ max?: number, night?: Uint8ClampedArray }} [o]  night: the night photo at the same
   *   size, for day windows (glass is dark at night).
   * @returns {{ type: string, rect: number[], threshold: number, gain: number, centroid: number[], area: number, energy: number }[]}
   */
  function detectLights(rgba, mask, w, h, time, o = {}) {
    const max = o.max ?? (window.SheenModel ? window.SheenModel.MAX_EMITTERS : 6);
    const N = w * h, Y = new Float32Array(N);
    for (let i = 0; i < N; i++) Y[i] = lumLin(rgba[4 * i], rgba[4 * i + 1], rgba[4 * i + 2]);
    const nonWall = i => !mask || mask[4 * i] >= 128;
    const pad = 0.006, found = [];
    const rectOf = c => [Math.max(0, c.x0 / w - pad), Math.max(0, c.y0 / h - pad), Math.min(1, (c.x1 + 1) / w + pad), Math.min(1, (c.y1 + 1) / h + pad)];
    const add = (c, type, threshold, gain) => found.push({ type, rect: rectOf(c), threshold, gain, centroid: [(c.sx / c.n + 0.5) / w, (c.sy / c.n + 0.5) / h], area: c.n / N, energy: c.energy });
    if (time === "day") {
      const on = new Uint8Array(N);
      const nt = o.night;
      for (let i = 0; i < N; i++)
        on[i] = Y[i] >= (nt ? 0.6 : 0.85) && nonWall(i) && (!nt || lumLin(nt[4 * i], nt[4 * i + 1], nt[4 * i + 2]) < 0.06) ? 1 : 0;
      for (const c of components(on, w, h, Y)) if (c.n >= 0.001 * N) add(c, "window", 0, 6);
    } else {
      // Each bright core's glow is grown only in a window around it (its
      // size again on every side, at least 3 % of the photo): grown freely,
      // a lampshade's glow joins the lit ceiling or floor and its core share
      // falls below 5 % (the deck's left lamp).
      const bright = new Uint8Array(N), glow = new Uint8Array(N), taken = new Uint8Array(N);
      for (let i = 0; i < N; i++) { bright[i] = Y[i] >= 0.85 ? 1 : 0; glow[i] = Y[i] >= 0.35 && nonWall(i) ? 1 : 0; }
      const cores = components(bright, w, h, Y).filter(c => c.n >= Math.max(2, 2e-5 * N)).sort((a, b) => b.n - a.n);
      for (const c of cores) {
        const cx = Math.round(c.sx / c.n), cy = Math.round(c.sy / c.n);
        if (taken[cy * w + cx]) continue;                         // inside a shade grown already
        const pad = Math.max(c.x1 - c.x0, c.y1 - c.y0, Math.round(0.03 * w));
        const X0 = Math.max(0, c.x0 - pad), X1 = Math.min(w - 1, c.x1 + pad), Y0 = Math.max(0, c.y0 - pad), Y1 = Math.min(h - 1, c.y1 + pad);
        const g = { n: 0, x0: w, y0: h, x1: 0, y1: 0, sx: 0, sy: 0, energy: 0, core: 0 }, stack = [], seen = new Set();
        for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) { const i = y * w + x; if (bright[i]) { stack.push(i); seen.add(i); } }
        while (stack.length) {
          const k = stack.pop(), x = k % w, y = (k - x) / w;
          g.n++; g.sx += x; g.sy += y; g.energy += Y[k]; if (bright[k]) g.core++;
          if (x < g.x0) g.x0 = x; if (x > g.x1) g.x1 = x; if (y < g.y0) g.y0 = y; if (y > g.y1) g.y1 = y;
          // 8 directions, bridging gaps of up to 2 px: a shade's clipped
          // opening is often ringed by a darker rim.
          for (const [dx, dy] of DIRS8) for (let st = 1; st <= 3; st++) {
            const xx = x + dx * st, yy = y + dy * st;
            if (xx < X0 || xx > X1 || yy < Y0 || yy > Y1) break;
            const q = yy * w + xx;
            if (glow[q] || bright[q]) { if (!seen.has(q)) { seen.add(q); stack.push(q); } break; }
          }
        }
        const isShade = g.n >= 0.0005 * N && g.core >= 0.05 * g.n && g.core <= 0.25 * g.n;
        if (isShade) { for (const k of seen) taken[k] = 1; add(g, "shade", 0.35, 5); }
        else add(c, "bulb", 0.85, 12);
      }
    }
    // Bulbs close together (a string of lights) become one emitter, and
    // window regions that overlap one: merge rectangles of the same type
    // that overlap after padding (2 % for bulbs, 0.5 % for windows).
    {
      for (let changed = true; changed;) {
        changed = false;
        for (let i = 0; i < found.length && !changed; i++) for (let j = i + 1; j < found.length && !changed; j++) {
          const A = found[i], B = found[j];
          if (A.type !== B.type || A.type === "shade") continue;
          const g = A.type === "bulb" ? 0.02 : 0.005;
          if (A.rect[0] - g < B.rect[2] && B.rect[0] - g < A.rect[2] && A.rect[1] - g < B.rect[3] && B.rect[1] - g < A.rect[3]) {
            const e = A.energy + B.energy;
            found[i] = { ...A, rect: [Math.min(A.rect[0], B.rect[0]), Math.min(A.rect[1], B.rect[1]), Math.max(A.rect[2], B.rect[2]), Math.max(A.rect[3], B.rect[3])],
                         centroid: [(A.centroid[0] * A.energy + B.centroid[0] * B.energy) / e, (A.centroid[1] * A.energy + B.centroid[1] * B.energy) / e],
                         area: A.area + B.area, energy: e };
            found.splice(j, 1); changed = true;
          }
        }
      }
    }
    return found.sort((a, b) => b.energy - a.energy).slice(0, max);
  }

  // ======================================================================
  // Images
  // ======================================================================

  /**
   * An image file as a square image Blob: the centre square, at most
   * `maxSide` px (the sheen pipeline works on square photos).
   * @param {Blob} file
   * @param {string} type  "image/jpeg" or "image/png".
   * @param {number} [maxSide=2048]
   * @returns {Promise<{ blob: Blob, cropped: boolean, size: number, width: number, height: number }>}
   */
  async function squareImage(file, type, maxSide = 2048) {
    const bmp = await createImageBitmap(file);
    const s = Math.min(bmp.width, bmp.height), out = Math.min(s, maxSide);
    const cv = Object.assign(document.createElement("canvas"), { width: out, height: out });
    cv.getContext("2d").drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, out, out);
    const { width, height } = bmp;
    bmp.close();
    const blob = await new Promise((resolve, reject) => cv.toBlob(b => b ? resolve(b) : reject(new Error("Couldn't encode the image")), type, 0.93));
    return { blob, cropped: width !== height, size: out, width, height };
  }

  /** RGBA of a drawable image at n x n. */
  function pixelsOf(img, n) {
    const cv = Object.assign(document.createElement("canvas"), { width: n, height: n });
    const c = cv.getContext("2d", { willReadFrequently: true });
    c.drawImage(img, 0, 0, n, n);
    return c.getImageData(0, 0, n, n).data;
  }

  /**
   * The camera's focal length from a JPEG's EXIF, as the 35 mm-equivalent
   * (tag 0xA405, FocalLengthIn35mmFilm: what phones and most cameras
   * record), or null. Only the first 256 kB are read.
   * @param {Blob} file
   * @returns {Promise<number | null>}  mm (35 mm equivalent)
   */
  async function exifFocal35(file) {
    const d = new DataView(await file.slice(0, 262144).arrayBuffer());
    if (d.byteLength < 4 || d.getUint16(0) !== 0xFFD8) return null;
    let o = 2;
    while (o + 4 <= d.byteLength) {
      const marker = d.getUint16(o), len = d.getUint16(o + 2);
      if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) return null;            // not a marker / image data
      if (marker === 0xFFE1 && o + 10 < d.byteLength && d.getUint32(o + 4) === 0x45786966) {   // "Exif"
        const t = o + 10, le = d.getUint16(t) === 0x4949;
        const u16 = p => d.getUint16(p, le), u32 = p => d.getUint32(p, le);
        const tag = (ifd, want) => {
          if (t + ifd + 2 > d.byteLength) return null;
          const n = u16(t + ifd);
          for (let i = 0; i < n; i++) { const e = t + ifd + 2 + 12 * i; if (e + 12 > d.byteLength) return null; if (u16(e) === want) return e; }
          return null;
        };
        const ptr = tag(u32(t + 4), 0x8769);                   // the Exif sub-IFD
        if (!ptr) return null;
        const e = tag(u32(ptr + 8), 0xA405);
        if (!e) return null;
        const v = u16(e + 8);
        return v > 0 ? v : null;
      }
      o += 2 + len;
    }
    return null;
  }

  /**
   * The focal length in image widths of the centre square cut from a W x H
   * photo, from its 35 mm-equivalent focal length (the 36 mm frame width
   * spans the photo's long side).
   */
  function focalForSquare(f35, W, H) { return f35 / 36 * Math.max(W, H) / Math.min(W, H); }

  // ======================================================================
  // Automatic calibration
  // ======================================================================
  //
  // For photos uploaded straight into the visualizer: everything the
  // calibration page proposes, accepted as is.
  // * Camera: classifyLines' verticals and two directions.
  // * Walls: an inside corner shows the wall whose lines run to the RIGHT
  //   vanishing point on the left of the corner, and vice versa (living
  //   room 2, the study and the deck all confirm it). So only the corner's
  //   position is unknown: the column that puts the most wall-adjacent line
  //   length of each family on its own side. A family with under 15 % of
  //   that length means one wall.
  // * Floor: where the wall comes lowest in the mask - furniture hides the
  //   foot of the wall in most columns, so the lowest point over all
  //   columns, after taking each column's lowest wall pixel as the highest
  //   of its 5 neighbours' (a stray mask pixel can't win), skipping columns
  //   where the wall runs off the photo's bottom (no floor shows there) -
  //   if that is below the horizon.
  // * Scale: a camera 1.2 m above the floor; lamps 30 cm off their walls
  //   (25 cm for shades).
  // * Lights: detectLights for each photo; a lamp in front of each night
  //   bulb or shade.
  // When the lines give no plausible camera (field of view outside
  // 20-110 deg, or too few lines), a default room is used: one wall facing
  // the camera, a 60 deg field of view, the floor 0.35 wall-distances below
  // the eye. The sheen still works there (its colour shift and soft sheen
  // come from the light map); its reflections are approximate.

  const CAMERA_HEIGHT_M = 1.2;

  /** The corner column and walls (solveRoom form) from classified lines. */
  function guessWalls(c, wallAdj) {
    const fam = (lines, vp) => ({ lines: lines.filter(s => wallAdj.has(s)), right: vp[0] > 0.5 });
    const A = fam(c.a, c.vpA), B = fam(c.b, c.vpB);
    const leftFam = A.right ? A : B, rightFam = A.right ? B : A;                  // wall left / right of the corner
    const dirOf = f => f === A ? "a" : "b";
    const w2 = s => (s[2] - s[0]) ** 2 + (s[3] - s[1]) ** 2;
    const tl = leftFam.lines.reduce((x, s) => x + w2(s), 0), tr = rightFam.lines.reduce((x, s) => x + w2(s), 0), tot = tl + tr;
    if (!tot) return { walls: [{ id: "wall1", dir: "a", through: { u: 0.5 } }], corner: null };
    if (tl < 0.15 * tot) return { walls: [{ id: "wall1", dir: dirOf(rightFam), through: { u: 0.5 } }], corner: null };
    if (tr < 0.15 * tot) return { walls: [{ id: "wall1", dir: dirOf(leftFam), through: { u: 0.5 } }], corner: null };
    // Score: the share of each line's length on its own side of u (lines
    // may cross the corner's column a little: frames near the corner,
    // perspective). The corner is the middle of the best-scoring range: the
    // gap between where one wall's lines end and the other's begin.
    const leftOf = (s, u) => { const x0 = Math.min(s[0], s[2]), x1 = Math.max(s[0], s[2]); return Math.min(1, Math.max(0, (u - x0) / (x1 - x0 || 1e-9))); };
    const scores = [];
    for (let u = 0.03; u <= 0.97 + 1e-9; u += 0.005) {
      let sc = 0;
      for (const s of leftFam.lines) sc += w2(s) * leftOf(s, u);
      for (const s of rightFam.lines) sc += w2(s) * (1 - leftOf(s, u));
      scores.push([u, sc]);
    }
    const top = Math.max(...scores.map(x => x[1])), near = scores.filter(x => x[1] >= top * 0.995).map(x => x[0]);
    const best = { u: (near[0] + near[near.length - 1]) / 2 };
    return { walls: [{ id: "wall1", dir: dirOf(rightFam), through: { u: best.u } },
                     { id: "wall2", dir: dirOf(leftFam), corner: { wall: "wall1", u: best.u } }], corner: best.u };
  }

  /**
   * Where the wall comes lowest in the mask: [u, v], or null.
   * @param {(uv: number[]) => boolean} [accept]  Only points it accepts (e.g. on the anchor wall).
   */
  function guessFloorPoint(mask, n, accept) {
    const lows = [];
    for (let x = 2; x < n - 2; x += 2) {
      let low = -1;
      for (let y = n - 1; y >= 0; y--) if (mask[4 * (y * n + x)] < 128) { low = y; break; }
      if (low >= 0) lows.push([low < n - 3 ? low : -1, x]);      // a wall running off the photo's bottom shows no floor
    }
    if (lows.length < 5) return null;
    let best = null;
    for (let i = 2; i < lows.length - 2; i++) {
      const win = lows.slice(i - 2, i + 3);
      if (win.some(l => l[0] < 0) || win.some(l => Math.abs(l[1] - lows[i][1]) > 6)) continue;
      const y = Math.min(...win.map(l => l[0]));                          // the 5 columns agree down to y
      if (accept && !accept([(lows[i][1] + 0.5) / n, (y + 1) / n])) continue;
      if (!best || y > best[0]) best = [y, lows[i][1]];
    }
    if (!best) return null;
    const [y, x] = best;
    return [(x + 0.5) / n, (y + 1) / n];
  }

  /** The default room: one wall facing the camera (60 deg field of view). */
  function defaultRoom() {
    return { c: [0.5, 0.5], f: 0.5 / Math.tan(30 * DEG), rot: [1, 0],
             planes: [{ id: "wall1", kind: "wall", p: [0, 0, -1, -1] }, { id: "floor", kind: "floor", p: [0, 1, 0, -0.35] }],
             report: { cameraHeight: 0.35, hfovDeg: 60, rollDeg: 0, walls: ["wall1: distance 1.000"] } };
  }

  /**
   * The light sources of both photos for a solved room (detectLights), as
   * a ROOMS entry's `lights` and in the calibration page's form.
   * - Every night bulb or shade becomes a lamp off its wall (up to
   *   MAX_LAMPS), 30 cm (bulbs) or 25 cm (shades) in front of it; its radius
   *   is that of a disc with the light's own area (its pixels above the
   *   threshold), at its depth - the bounding box of a string of bulbs or a
   *   wide shade's clipped rim is far larger than the light.
   * - A light made a lamp keeps its pixels in the environment at gain 1
   *   (the analytic lamp reflects it, where its mirror image falls); as an
   *   emitter of gain 12 too it was reflected twice, the second time
   *   painted onto the wall plane behind it and 12x too bright.
   * @param {{ day: CanvasImageSource, night: CanvasImageSource, mask: CanvasImageSource }} imgs
   * @param {object} room  A solved Room.
   * @param {number} mpu   Metres per scene unit.
   */
  function autoLights(imgs, room, mpu) {
    const SM = window.SheenModel, m = 800, maskM = pixelsOf(imgs.mask, m), nightM = pixelsOf(imgs.night, m);
    const found = { day: detectLights(pixelsOf(imgs.day, m), maskM, m, m, "day", { night: nightM }), night: detectLights(nightM, maskM, m, m, "night") };
    const r5 = x => Array.isArray(x) ? x.map(r5) : typeof x === "number" ? Math.round(x * 1e5) / 1e5 : x;
    const lights = {}, calibLights = {};
    for (const t of ["day", "night"]) {
      const em = found[t], lamps = [], calibLamps = [], isLamp = new Set();
      if (t === "night") em.forEach((e, i) => {
        if (e.type === "window" || lamps.length >= SM.MAX_LAMPS) return;
        const offsetCm = e.type === "shade" ? 25 : 30, wall = SM.wallAt(room, e.centroid), offset = offsetCm / 100 / mpu;
        const pos = SM.pointOffWall(room, e.centroid, wall, offset);
        const radius = Math.sqrt(e.area / Math.PI) * pos[2] / room.f;
        lamps.push({ uv: r5(e.centroid), wall, offset: r5(offset), radius: r5(radius),
                     core: { rect: r5(e.rect), threshold: Math.max(e.threshold, 0.35), gain: e.gain }, note: e.type });
        calibLamps.push({ uv: e.centroid, emitter: i, offsetCm, sizeCm: r5(200 * radius * mpu), emits: "all" });
        isLamp.add(i);
      });
      const keyUV = t === "night" && lamps.length ? lamps[0].uv : em[0] ? [(em[0].rect[0] + em[0].rect[2]) / 2, (em[0].rect[1] + em[0].rect[3]) / 2] : [0.5, 0.35];
      lights[t] = { keyLight: { uv: r5(keyUV), wall: SM.wallAt(room, keyUV), offset: t === "night" && lamps.length ? lamps[0].offset : 0 },
                    emitters: em.map((e, i) => ({ rect: r5(e.rect), threshold: e.threshold, gain: isLamp.has(i) ? 1 : e.gain, note: e.type + (isLamp.has(i) ? " (a lamp below)" : "") })),
                    lamps, windows: [] };
      // (The calibration page keeps each emitter's own gain and sets gain 1
      // in the environment itself for those a lamp stands for.)
      calibLights[t] = { emitters: em.map(e => ({ type: e.type, rect: e.rect, threshold: e.threshold, gain: e.gain })), lamps: calibLamps, key: null, windows: [] };
    }
    return { lights, calibLights };
  }

  /**
   * A room config (a ROOMS entry, or an export) in the calibration page's
   * form, so a built-in room's measured calibration can be refined there.
   * Distances become metres with the page's camera-height scale.
   * @param {object} cfg   { geometry, lights }
   * @param {object} room  Its solved Room.
   */
  function calibStateFromConfig(cfg, room) {
    const g = cfg.geometry, mpu = CAMERA_HEIGHT_M / room.report.cameraHeight;
    let id = 1;
    const lines = [];
    for (const [cls, list] of [["a", g.lines.a], ["b", g.lines.b], ["s", g.lines.bSloped], ["v", g.verticals]])
      for (const seg of list || []) lines.push({ id: id++, seg, cls, src: "drawn" });
    const walls = g.walls.map(w => ({ id: w.id, dir: w.dir, u: w.through ? w.through.u : w.corner.u, joins: w.corner ? w.corner.wall : null }));
    const pts = p => p ? (p.at ? [p.at.uv] : p.through.map(q => q.uv)) : [];
    const typeOf = e => /window|pane|door|clerestory/i.test(e.note || "") ? "window" : /shade/i.test(e.note || "") || e.threshold <= 0.5 && e.threshold > 0 ? "shade" : e.threshold > 0 ? "bulb" : "window";
    const lights = {};
    for (const [t, L] of Object.entries(cfg.lights)) {
      const emitters = L.emitters.map(e => ({ type: typeOf(e), rect: e.rect, threshold: e.threshold, gain: e.gain }));
      const lamps = (L.lamps || []).map(l => {
        let i = emitters.findIndex(e => l.core && e.rect.every((v, k) => Math.abs(v - l.core.rect[k]) < 1e-6));
        if (i < 0 && l.core) { emitters.push({ type: l.core.threshold > 0.5 ? "bulb" : "shade", rect: l.core.rect, threshold: l.core.threshold, gain: l.core.gain }); i = emitters.length - 1; }
        else if (i >= 0 && l.core) emitters[i].gain = l.core.gain;     // the lamp's intensity gain (the page sets 1 in the environment)
        return { uv: l.uv, emitter: i >= 0 ? i : null, offsetCm: Math.round(l.offset * mpu * 100), sizeCm: Math.round(l.radius * mpu * 200),
                 emits: l.axis ? (l.axis[1] < 0 ? "down" : "up") : "all" };
      });
      lights[t] = { emitters, lamps, key: L.keyLight ? { uv: L.keyLight.uv, offsetCm: Math.round(L.keyLight.offset * mpu * 100) } : null,
                    windows: (L.windows || []).map(w => ({ wall: w.wall, edge: w.edge, widthM: +(w.width * mpu).toFixed(2), startM: +((w.start || 0) * mpu).toFixed(2), toward: w.toward, radiance: w.radiance })) };
    }
    return { name: cfg.label || "Room", prefix: "images/sheens/", lines, walls, floor: pts(g.floor)[0] || null, ceiling: pts(g.ceiling),
             cameraHeightM: CAMERA_HEIGHT_M, lights };
  }

  /**
   * Calibrates a room from its three images without help.
   * @param {{ day: CanvasImageSource, night: CanvasImageSource, mask: CanvasImageSource }} imgs  Square, aligned.
   * @param {{ focal?: number }} [o]  focal: the focal length in image widths, when known (EXIF;
   *   focalForSquare): then the camera needs only one family of lines.
   * @returns {{ entry: object, room: object, method: "lines" | "exif" | "default", notes: string[], calibState: object }}
   *   entry: a ROOMS entry for sheenSceneRenderer.html without photos, mask
   *   and label (with `solved` when the default room is used); calibState:
   *   the same proposals in sheenCalibrate.html's form, to refine there.
   */
  function autoCalibrate(imgs, o = {}) {
    const SM = window.SheenModel, n = 1000, notes = [];
    const dayPx = pixelsOf(imgs.day, n), maskPx = pixelsOf(imgs.mask, n);
    const segs = detectSegments(gray(dayPx, n, n), n, n).map(s => [s.x1 / n, s.y1 / n, s.x2 / n, s.y2 / n]);
    const weights = wallWeights(segs, maskPx, n, n);
    const c = classifyLines(segs, { weights });
    const wallAdj = new Set(segs.filter((s, i) => weights[i] > 1));
    // A known focal length (EXIF) fixes b's VP from a's: the b lines are then
    // those that agree with it (the strongest family is the most reliable
    // part of line detection; the second family is where it fails).
    if (o.focal && c.a.length >= 2 && c.verticals.length >= 1) {
      try {
        const probe = SM.solveRoom({ lines: { a: c.a, b: [] }, verticals: c.verticals, focal: o.focal,
                                     walls: [{ id: "w", dir: "a", through: { u: 0.5 } }], floor: { at: { wall: "w", uv: [0.5, 0.97] } } });
        const vpB = probe.report.vpB, rest = [...c.b, ...c.other];
        c.vpB = vpB; c.b = rest.filter(s => vpError(s, [vpB[0], vpB[1], 1]) < 1.5 * DEG);
      } catch (e) { notes.push("Focal length from EXIF unusable: " + e.message); }
    }
    let room = null, geometry = null, walls = null, floorUV = null;
    if (c.a.length >= 2 && (c.b.length >= 1 || o.focal) && c.verticals.length >= 1 && c.vpB) {
      walls = guessWalls(c, wallAdj);
      try {
        const g0 = { lines: { a: c.a, b: c.b }, verticals: c.verticals, walls: walls.walls, floor: { at: { wall: "wall1", uv: [0.5, 0.97] } } };
        if (o.focal) g0.focal = o.focal;
        const first = SM.solveRoom(g0);
        const horizon = first.c[1];
        // The floor point on the anchor wall if it shows its foot (its plane
        // is the best determined), else on any wall.
        floorUV = guessFloorPoint(maskPx, n, uv => SM.wallAt(first, uv) === "wall1") || guessFloorPoint(maskPx, n);
        if (!floorUV || floorUV[1] < horizon + 0.03) { floorUV = [0.5, 0.98]; notes.push("The floor line wasn't visible in the mask; the floor is placed at the photo's bottom edge."); }
        geometry = { ...g0, floor: { at: { wall: SM.wallAt(first, floorUV), uv: floorUV } } };
        room = SM.solveRoom(geometry);
        const fov = room.report.hfovDeg;
        if (!isFinite(room.f) || fov < 20 || fov > 110 || !(room.report.cameraHeight > 0)) {
          notes.push(`The lines gave an implausible camera (${isFinite(fov) ? fov.toFixed(0) + "° field of view" : "no solution"}).`);
          room = null; geometry = null;
        }
      } catch (e) { notes.push("Solver: " + e.message); room = null; geometry = null; }
    } else notes.push("Too few straight lines in the room's directions.");
    const method = room ? (o.focal ? "exif" : "lines") : "default";
    if (!room) { room = defaultRoom(); notes.push("Using a default camera and a single wall: reflections are approximate. Refine the scene in the calibration page for accurate ones."); }
    else notes.push(`Camera from ${o.focal ? "the photo's EXIF focal length and its lines" : "the photo's lines"}: ${room.report.hfovDeg.toFixed(0)}° field of view, ${walls.corner === null ? "one wall" : "two walls, corner at " + Math.round(walls.corner * 100) + " % across"}. Automatic detection is often wrong in this step; check it in the calibration page.`);
    const mpu = CAMERA_HEIGHT_M / room.report.cameraHeight;

    const { lights, calibLights } = autoLights(imgs, room, mpu);
    const r5 = x => Array.isArray(x) ? x.map(r5) : typeof x === "number" ? Math.round(x * 1e5) / 1e5 : x;
    const entry = { lights };
    if (geometry && o.focal) geometry.focal = o.focal;
    if (geometry) entry.geometry = r5(geometry); else entry.solved = room;
    // The same in the calibration page's form (its lines, walls with their
    // corner columns, the floor point, the lights).
    const cls = new Map([...c.verticals.map(s => [s, "v"]), ...c.a.map(s => [s, "a"]), ...c.b.map(s => [s, "b"])]);
    const calibWalls = geometry ? geometry.walls.map((w, i) => ({ id: w.id, dir: w.dir, u: w.through ? w.through.u : w.corner.u, joins: i ? geometry.walls[i - 1].id : null })) : [];
    const calibState = { name: "Uploaded photos", prefix: "images/sheens/", lines: segs.map((s, i) => ({ id: i + 1, seg: s, cls: cls.get(s) || "off", src: "auto" })),
                         walls: calibWalls, floor: geometry ? floorUV : null, ceiling: [], cameraHeightM: CAMERA_HEIGHT_M, lights: calibLights };
    return { entry, room, method, notes, calibState };
  }

  // ---------------------------------------------------------------- export
  window.SheenCalib = { gray, detectSegments, snapLine, wallWeights, classifyLines, detectLights, vpError, LINEAR,
                        squareImage, pixelsOf, guessWalls, guessFloorPoint, defaultRoom, autoLights, autoCalibrate, CAMERA_HEIGHT_M,
                        exifFocal35, focalForSquare, calibStateFromConfig };
})();
