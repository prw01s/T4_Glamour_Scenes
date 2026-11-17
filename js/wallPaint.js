/* ==========================================================================
 * wallPaint.js - the paint maths behind sceneVisualizer.html ("v4"):
 *
 *   transfer     how a new paint is lit by the light measured on the old
 *                paint (the Wall Colour Delta), in CAT16 cone space; the
 *                uniforms glsl/sceneVisualizer.glsl needs
 *   estimate     the original wall paint from the image alone, when it is
 *                not given
 *   gamut        the realistic range of architectural paints (built from the
 *                Sherwin-Williams ColorSnap palette by tools/build_paint_gamut.py)
 *   random       random test paints spread over hue, chroma and lightness
 *                inside that range
 *
 * The model and every constant are explained, measured and justified in
 * docs/scene-visualizer-plan.md and docs/scene-visualizer.md; tools/v4ref.py
 * is the Python reference the tests compare against.
 *
 * Classic script (works from file:// too). Needs js/paintPipeline.js first.
 * Defines window.WallPaint.
 * ======================================================================== */
(function () {
  "use strict";
  const PP = window.PaintPipeline;
  if (!PP) throw new Error("wallPaint.js needs js/paintPipeline.js loaded first");
  const { mat, RGB2XYZ, CAT16, hexToLinear, linearToHex, luminance, decodeSrgb } = PP;

  // ======================================================================
  // Transfer (the model)
  // ======================================================================

  /**
   * Linear sRGB -> CAT16 "sharpened cone" space, scaled so white (1,1,1)
   * stays (1,1,1). Illumination change is close to a per-channel scaling in
   * sharpened sensors (Finlayson, Drew & Funt 1994), which is why the light
   * is divided out and the new paint multiplied in here, not in sRGB or XYZ.
   */
  const TO16 = (() => {
    const m = mat.mul(CAT16, RGB2XYZ);
    const w = mat.apply(m, [1, 1, 1]);
    return m.map((v, k) => v / w[Math.floor(k / 3)]);
  })();
  const FROM16 = mat.inverse(TO16);

  /**
   * Bounce light (interreflection): part of the light on a wall has bounced
   * off the other walls first, so it was filtered by the paint. In a room
   * whose walls have reflectance r (per channel), the light is multiplied by
   * G(r) = 1 / (1 - KAPPA r) (integrating-sphere theory). Fitted on the
   * before/after photos, leaving each pair out: 0.40 (tools/pairs/fit_transfer.py).
   */
  const KAPPA = 0.40;
  const bounceGain = r => 1 / (1 - KAPPA * Math.min(Math.max(r, 0), 1));

  /**
   * The per-channel factor that turns the old paint's light into the new
   * paint's, in CAT16 space:  out16 = photo16 / old16 * new16 * G(new16) / G(old16).
   * Identical paints give exactly (1,1,1): the photo is returned unchanged.
   * @param {number[]} oldLin  The original paint, linear sRGB reflectance.
   * @param {number[]} newLin  The new paint, linear sRGB reflectance.
   * @returns {{ old16: number[], new16: number[], gain: number[] }}
   *   gain = new16 * G(new16) / (old16 * G(old16))
   */
  function transfer(oldLin, newLin) {
    const o = mat.apply(TO16, oldLin).map(v => Math.max(v, 1e-4));
    const n = mat.apply(TO16, newLin).map(v => Math.max(v, 1e-4));
    const gain = n.map((v, i) => (v * bounceGain(v)) / (o[i] * bounceGain(o[i])));
    return { old16: o, new16: n, gain };
  }

  /**
   * The model on one linear colour (no sliders, no gamut mapping): what the
   * shader computes, for tests and tools.
   * @returns {number[]} Linear sRGB (may be out of gamut).
   */
  function recolour(photoLin, oldLin, newLin) {
    const { gain } = transfer(oldLin, newLin);
    const p = mat.apply(TO16, photoLin);
    return mat.apply(FROM16, p.map((v, i) => v * gain[i]));
  }

  // ======================================================================
  // CIELAB (D65) helpers
  // ======================================================================

  const WHITE_XYZ = mat.apply(RGB2XYZ, [1, 1, 1]);
  const XYZ2RGB = mat.inverse(RGB2XYZ);
  const f = t => (t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
  const fInv = t => (t > 6 / 29 ? t ** 3 : 3 * (6 / 29) ** 2 * (t - 4 / 29));
  /** Linear sRGB -> CIELAB (D65 white). */
  function lab(lin) {
    const xyz = mat.apply(RGB2XYZ, lin).map((v, i) => f(v / WHITE_XYZ[i]));
    return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
  }
  /** CIELAB (D65) -> linear sRGB (may be out of gamut). */
  function labToLinear([L, a, b]) {
    const fy = (L + 16) / 116;
    const xyz = [fInv(fy + a / 500), fInv(fy), fInv(fy - b / 200)].map((v, i) => v * WHITE_XYZ[i]);
    return mat.apply(XYZ2RGB, xyz);
  }
  const lOfY = Y => (Y > (6 / 29) ** 3 ? 116 * Math.cbrt(Y) - 16 : Y * (29 / 3) ** 3);
  const yOfL = L => (L > 8 ? ((L + 16) / 116) ** 3 : L / (29 / 3) ** 3);

  /** CIEDE2000 colour difference between two CIELAB colours. */
  function deltaE2000([L1, a1, b1], [L2, a2, b2]) {
    const rad = Math.PI / 180, C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
    const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
    const a1p = (1 + G) * a1, a2p = (1 + G) * a2, C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
    const hp = (a, b) => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
    const h1 = hp(a1p, b1), h2 = hp(a2p, b2);
    let dh = h2 - h1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; if (C1p * C2p === 0) dh = 0;
    const dL = L2 - L1, dC = C2p - C1p, dH = 2 * Math.sqrt(C1p * C2p) * Math.sin(dh * rad / 2);
    const Lb = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
    let hb = Math.abs(h1 - h2) <= 180 ? (h1 + h2) / 2 : (h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2);
    if (C1p * C2p === 0) hb = h1 + h2;
    const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
    const SL = 1 + 0.015 * (Lb - 50) ** 2 / Math.sqrt(20 + (Lb - 50) ** 2), SC = 1 + 0.045 * Cbp, SH = 1 + 0.015 * Cbp * T;
    const RT = -2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hb - 275) / 25) ** 2)) * rad);
    return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
  }

  // ======================================================================
  // The realistic paint gamut
  // ======================================================================

  /**
   * The largest CIELAB chroma C* of any Sherwin-Williams ColorSnap colour
   * near each hue (rows, 0..350 deg in 10 deg steps) and lightness (columns,
   * L* 10..100 in steps of 5), smoothed over hue. Built by
   * tools/build_paint_gamut.py from the palette sherwin-williams.com publishes.
   */
  const GAMUT = {
    source: "Sherwin-Williams ColorSnap palette (1526 colours), CIELAB D65",
    hueStep: 10, lStart: 10, lStep: 5,
    lrvRange: [2.8, 92.6], lRange: [19.1, 97.1],
    cMax: [
    [0, 5.2, 11.6, 21, 34.5, 46.7, 46.9, 48.2, 48.9, 43.7, 37.8, 35.6, 33.9, 29.9, 19.7, 19.7, 11.5, 0, 0],
    [0, 5.2, 15.9, 25.1, 35.6, 52.1, 52.2, 48.9, 50.6, 50, 43.8, 40.8, 36.6, 36.2, 22, 20, 11.5, 0, 0],
    [0, 5.6, 16.8, 29.4, 37.6, 57, 58.9, 53.7, 54.5, 50.2, 46.6, 43.7, 37.6, 36.8, 24.8, 18.2, 12.1, 0, 0],
    [0, 11.5, 16.8, 32.2, 39.2, 56.9, 64.3, 62.1, 62.2, 53.5, 51, 46.4, 38.3, 37.9, 25.9, 18, 13.9, 0, 0],
    [0, 11.5, 16.3, 29.2, 34.9, 50.6, 60, 64.5, 68.2, 63.8, 59.5, 52.2, 40.8, 39.3, 25.6, 21.2, 15.4, 1.8, 0],
    [0, 3.8, 16.7, 21.9, 26.5, 39.2, 43.9, 57.1, 65.7, 65.7, 64.6, 62, 50.9, 46.4, 29.7, 25.3, 16.6, 5.4, 0],
    [0, 0, 12.9, 16, 23.7, 28.6, 30.1, 46.7, 56, 56.8, 64.9, 68.3, 63.9, 61.2, 46.7, 34.9, 20.9, 8, 0],
    [0, 0, 4.3, 10.9, 21.8, 23.3, 25.9, 41.5, 46.9, 50.4, 64, 68.1, 68.1, 74.8, 70.2, 57, 38.6, 13.7, 0],
    [0, 0, 0, 5.1, 15.1, 23.2, 26.3, 36.8, 41.4, 50.8, 62.3, 65.8, 67.9, 81, 82.9, 78.1, 63.1, 26.5, 0],
    [0, 0, 0, 2.8, 9.7, 27, 28.3, 29.9, 39.1, 54, 59.9, 63.1, 71.8, 81, 77.1, 79.7, 71.2, 38.2, 0.8],
    [0, 0, 0, 4.9, 9.4, 28.9, 28.9, 31.3, 41.2, 53.2, 54.9, 56.4, 75.7, 78.1, 58.3, 63.2, 56.9, 37.9, 2.3],
    [0, 0, 0, 6.7, 12.8, 27.1, 28.5, 38.8, 44.8, 48.6, 44.6, 47.4, 75.4, 75.4, 42, 44.1, 34.2, 25.2, 2.3],
    [0, 0, 0, 7.1, 13.3, 25.8, 30, 39.2, 50.1, 50.1, 35.1, 42.3, 64.6, 64.1, 33.7, 31.5, 22.1, 12, 0.8],
    [0, 0, 0, 5.4, 12.6, 27.6, 31.8, 32.8, 57.9, 57.9, 33, 39.6, 46.7, 45.2, 29.6, 24.2, 19, 7.3, 0],
    [0, 0, 1.2, 4.3, 18.1, 32.7, 35.5, 32.6, 59.9, 59.9, 35, 38.2, 36.8, 34.7, 27.1, 22.1, 16.2, 6.4, 0],
    [0, 0, 3.5, 7.5, 24.9, 36.8, 40.9, 40.8, 53.9, 54.7, 39.9, 38, 32.5, 30.7, 24.1, 21.2, 13.3, 5.7, 0],
    [0, 0, 3.5, 7.5, 24.6, 32.5, 41.3, 42.9, 43.7, 50.2, 46.1, 35.9, 28.4, 27.8, 22.7, 19, 11.3, 7.3, 0],
    [0, 0, 2.4, 7.5, 21.1, 23.8, 36, 36.5, 35.1, 45.4, 44.1, 31.8, 27.4, 27.4, 24.3, 21.1, 12.1, 7.1, 0],
    [0, 0, 4.9, 15.4, 22, 22, 31.2, 31.2, 33.7, 38.4, 33.3, 28.5, 27.4, 27.4, 27.4, 26.5, 13.4, 4.9, 0],
    [0, 0, 8.3, 21.2, 23.2, 23.9, 29.2, 29.2, 34.2, 34.2, 27.8, 29.1, 29.3, 26.8, 26.9, 26.2, 13.1, 5.1, 0],
    [0, 0, 7, 16.1, 16.7, 24.2, 28, 28.3, 32.9, 32.9, 29.8, 33.8, 34.2, 25.7, 23, 20.2, 13.1, 6.6, 0],
    [0, 0, 4.7, 9.1, 11.1, 24, 27.3, 28.3, 31.6, 31.6, 32.1, 36.1, 34.8, 24.6, 21.4, 17.2, 14.3, 5.2, 0],
    [0, 0, 7, 11.1, 17.2, 23.7, 27, 29, 30.6, 30.4, 33.5, 34.9, 31.2, 24.9, 22.7, 18.1, 13.9, 1.7, 0],
    [0, 0, 7.6, 16.6, 22.7, 24.9, 27, 30.8, 31.1, 31.9, 35.3, 34.2, 29.5, 25.5, 24.7, 17.8, 10.9, 0, 0],
    [0, 0, 4.5, 20.2, 22.4, 27.6, 28.1, 32.7, 32.7, 36.3, 37.4, 32.4, 28.1, 25.1, 22, 14.9, 8.1, 0, 0],
    [0, 0, 5.5, 22.5, 23.7, 31.5, 31.7, 34.7, 33, 35.2, 35.2, 27.9, 23.6, 22.6, 14.4, 11.6, 6.7, 0, 0],
    [0, 0, 10.3, 25.7, 28.6, 35.5, 36.2, 36.9, 31.1, 28.7, 28.7, 24.6, 19.4, 19.4, 11, 10.4, 5.6, 0, 0],
    [0, 0, 9.4, 30.5, 34, 36.9, 33.2, 36.1, 29.3, 22.2, 25.3, 24, 18.2, 18.2, 12.6, 11, 3.7, 0, 0],
    [0, 0.2, 3.3, 31.9, 35.2, 35.5, 18.8, 32.1, 29.5, 12.6, 25, 24.6, 18.6, 18.6, 10.3, 8.6, 1.2, 0, 0],
    [0, 0.5, 1.6, 30.2, 33.2, 33.3, 12.5, 29.6, 29.6, 6.5, 24.8, 24.8, 19.4, 18.5, 6.4, 5.8, 1.2, 0, 0],
    [0, 0.5, 3.8, 27.7, 31, 31.8, 23.8, 29.6, 29.2, 10.3, 25.2, 25.2, 20.8, 18.3, 10.7, 8.8, 4, 0, 0],
    [0, 0.4, 4.6, 25.6, 29, 31.1, 31.9, 31.1, 29.9, 16, 26.2, 26.2, 21, 19, 17.5, 11.9, 5.9, 0, 0],
    [0, 0.6, 3.9, 26.6, 28.1, 27.7, 30.4, 30.4, 28.6, 20.7, 25.8, 24.2, 20.2, 19.7, 17.6, 12.1, 6.3, 0, 0],
    [0, 0.6, 3.3, 22.6, 25.7, 21.8, 25.4, 25.4, 23.4, 20.7, 21.6, 18.2, 15.9, 16.9, 14.7, 12.9, 4.8, 0, 0],
    [0, 0.2, 2.3, 13.8, 25.1, 25.1, 26.5, 27.7, 26.3, 20.6, 20.6, 17.4, 13.8, 11.9, 14.8, 14.8, 4.3, 0, 0],
    [0, 1.7, 4.6, 14.7, 30.4, 37.8, 37.8, 40.7, 40.3, 30.8, 28.5, 26, 23.7, 16.8, 17.3, 17.3, 8.3, 0, 0]
    ]
  };

  /** Largest C* a paint reaches at hue h (degrees) and lightness L* (bilinear). */
  function chromaMax(h, L) {
    const t = GAMUT.cMax, nh = t.length, nl = t[0].length;
    const x = (((h % 360) + 360) % 360) / GAMUT.hueStep, i0 = Math.floor(x) % nh, i1 = (i0 + 1) % nh, fx = x - Math.floor(x);
    const y = Math.min(Math.max((L - GAMUT.lStart) / GAMUT.lStep, 0), nl - 1), j0 = Math.floor(y), j1 = Math.min(j0 + 1, nl - 1), fy = y - j0;
    const row = i => t[i][j0] * (1 - fy) + t[i][j1] * fy;
    return row(i0) * (1 - fx) + row(i1) * fx;
  }

  /** True when the colour is a realistic paint (inside the gamut, with 10 % slack). */
  function isPaintLike(hex) {
    const [L, a, b] = lab(hexToLinear(hex));
    if (L < GAMUT.lRange[0] - 3 || L > GAMUT.lRange[1] + 1) return false;
    return Math.hypot(a, b) <= chromaMax(Math.atan2(b, a) * 180 / Math.PI, L) * 1.1 + 2;
  }

  /** Small, fast, seedable PRNG (mulberry32). */
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /** A random permutation of 0..n-1. */
  function shuffled(n, rand) {
    const a = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  /**
   * `n` random paint colours that together span the realistic paint range:
   * stratified so every draw covers it evenly instead of clumping.
   *   hue        n - 2 colours on evenly spaced hues (random rotation and
   *              jitter); 2 near-neutrals (whites, greys, blacks are common paints)
   *   lightness  one per lightness band, L* from the darkest to the lightest
   *              paint (about LRV 3..92), bands shuffled over the hues
   *   chroma     a share of the largest chroma paints reach at that hue and
   *              lightness, also one per band (from muted to the strongest)
   * @param {number} [n=10]
   * @param {number} [seed]  Same seed, same colours.
   * @returns {string[]} #rrggbb, all inside sRGB.
   */
  function randomPaints(n = 10, seed = (Math.random() * 2 ** 32) >>> 0) {
    const rand = rng(seed);
    const [Lmin, Lmax] = [GAMUT.lRange[0] + 2, GAMUT.lRange[1] - 1];
    const lBand = shuffled(n, rand);
    const nNeutral = Math.min(2, n), nHue = n - nNeutral, rot = rand() * 360;
    // Hue and lightness first; then the chroma bands go to the hue/lightness
    // slots in order of how much chroma paints reach there, so the strongest
    // band lands where a strong paint exists (a light yellow can be vivid, a
    // light violet can't).
    const slots = [...Array(n).keys()].map(i => {
      const L = Lmin + (lBand[i] + rand()) * (Lmax - Lmin) / n;
      const h = i < nHue ? rot + (i + 0.15 + 0.7 * rand()) * 360 / nHue : rand() * 360;
      return { i, L, h, cm: i < nHue ? chromaMax(h, L) : 0 };
    });
    const byReach = slots.slice(0, nHue).sort((a, b) => a.cm - b.cm);
    byReach.forEach((s, rank) => { s.share = 0.12 + 0.88 * (rank + rand()) / nHue; });
    const out = [];
    for (const { i, L, h, cm, share } of slots) {
      let C = i < nHue ? cm * share : 1.5 * rand();
      // Lab -> sRGB; shrink chroma until displayable (the deck is all in sRGB,
      // so this only trims interpolation overshoot).
      let lin;
      for (let k = 0; k < 40; k++) {
        lin = labToLinear([L, C * Math.cos(h * Math.PI / 180), C * Math.sin(h * Math.PI / 180)]);
        if (lin.every(v => v >= 0 && v <= 1)) break;
        C *= 0.93;
      }
      out.push(linearToHex(lin.map(v => Math.min(Math.max(v, 0), 1))));
    }
    return shuffled(n, rand).map(i => out[i]);
  }

  // ======================================================================
  // Estimating the original paint from the image
  // ======================================================================

  /**
   * Estimator constants (fitted and scored leaving each room out on the
   * before/after photos, tools/pairs/fit_estimator.py; median error 8-10 dE2000,
   * good in light rooms, poor for very dark walls):
   *   colour     wall / light, light = Shades-of-Grey (p = 6) of the non-wall pixels
   *   lightness  L*_paint = L0 + L1 * L*_wall as photographed
   */
  const ESTIMATE = { L0: 38.38, L1: 0.501, sogP: 6, workSize: 640, erode: 3, dilate: 4 };

  /** Square erosion / dilation of a 0/1 map with an integral image (radius r). */
  function morph(src, w, h, r, dilate) {
    const I = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) { row += dilate ? src[y * w + x] : 1 - src[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
    }
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      const s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
      out[y * w + x] = dilate ? (s > 0 ? 1 : 0) : (s > 0 ? 0 : 1);
    }
    return out;
  }
  /** numpy-style linear-interpolated percentile of a sorted array. */
  function pct(sorted, p) {
    if (!sorted.length) return NaN;
    const x = (sorted.length - 1) * p / 100, i = Math.floor(x), f = x - i;
    return i + 1 < sorted.length ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i];
  }
  const median = a => pct(Float64Array.from(a).sort(), 50);

  /** Draws an image / video frame / canvas at `w` x `h` and returns its RGBA bytes. */
  function pixelsOf(source, w, h) {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
    ctx.drawImage(source, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  }

  /**
   * The image statistics the estimate and the sliders need, from one image
   * (or video frame) and its mask (black / transparent = wall), at about
   * ESTIMATE.workSize px.
   * @param {CanvasImageSource} source
   * @param {CanvasImageSource} mask
   * @param {number} srcW  Source width (its natural / video size).
   * @param {number} srcH
   * @returns {{ wallRef: number[], wallMid: number[], light: number[], wallY: number, sample: Float32Array }}
   *   wallRef  median linear colour of the wall's 60..90th luminance percentile
   *            (its lightness: what the lightness fit was made with)
   *   wallMid  the same for the 30..70th percentile: its colour (direct sun
   *            patches sit in the upper band and carry the sun's colour)
   *   light    Shades-of-Grey (p = 6) of the non-wall, unclipped pixels
   *   wallY    luminance of wallRef
   *   sample   up to 4096 wall pixels (linear RGB triples) for the slider statistics
   */
  function imageStats(source, mask, srcW, srcH) {
    const s = ESTIMATE.workSize / Math.max(srcW, srcH);
    const w = Math.max(8, Math.round(srcW * s)), h = Math.max(8, Math.round(srcH * s));
    const px = pixelsOf(source, w, h), mk = pixelsOf(mask, w, h);
    return statsFromPixels(px, mk, w, h);
  }

  /** imageStats on raw RGBA arrays (exposed for tests). */
  function statsFromPixels(px, mk, w, h) {
    const n = w * h, wall = new Uint8Array(n), clip = new Uint8Array(n);
    const lin = new Float32Array(n * 3), Y = new Float32Array(n);
    const LUT = Float32Array.from({ length: 256 }, (_, i) => decodeSrgb(i / 255));
    for (let i = 0; i < n; i++) {
      const m = (0.2126 * mk[4 * i] + 0.7152 * mk[4 * i + 1] + 0.0722 * mk[4 * i + 2]) / 255 * (mk[4 * i + 3] / 255);
      wall[i] = m < 0.5 ? 1 : 0;
      const r = LUT[px[4 * i]], g = LUT[px[4 * i + 1]], b = LUT[px[4 * i + 2]];
      lin[3 * i] = r; lin[3 * i + 1] = g; lin[3 * i + 2] = b;
      Y[i] = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
      clip[i] = px[4 * i] > 251 || px[4 * i + 1] > 251 || px[4 * i + 2] > 251 ? 1 : 0;
    }
    let core = morph(wall, w, h, ESTIMATE.erode, false);
    if (core.reduce((a, v) => a + v, 0) < 50) core = wall;
    const near = morph(wall, w, h, ESTIMATE.dilate, true), clipped = morph(clip, w, h, 3, true);
    const ys = [];
    for (let i = 0; i < n; i++) if (core[i]) ys.push(Y[i]);
    if (ys.length < 20) throw new Error("The mask marks almost no wall.");
    const sorted = Float64Array.from(ys).sort(), lo = pct(sorted, 60), hi = pct(sorted, 90);
    const m0 = pct(sorted, 30), m1 = pct(sorted, 70);
    const R = [], G = [], B = [], Rm = [], Gm = [], Bm = [];
    const p = ESTIMATE.sogP, sog = [0, 0, 0];
    let nOff = 0;
    const sample = [], every = Math.max(1, Math.floor(ys.length / 4096));
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (core[i]) {
        if (Y[i] >= lo && Y[i] <= hi) { R.push(lin[3 * i]); G.push(lin[3 * i + 1]); B.push(lin[3 * i + 2]); }
        if (Y[i] >= m0 && Y[i] <= m1) { Rm.push(lin[3 * i]); Gm.push(lin[3 * i + 1]); Bm.push(lin[3 * i + 2]); }
        if (k++ % every === 0) sample.push(lin[3 * i], lin[3 * i + 1], lin[3 * i + 2]);
      } else if (!near[i] && !clipped[i]) {
        sog[0] += lin[3 * i] ** p; sog[1] += lin[3 * i + 1] ** p; sog[2] += lin[3 * i + 2] ** p; nOff++;
      }
    }
    const wallRef = [median(R), median(G), median(B)], wallMid = [median(Rm), median(Gm), median(Bm)];
    const light = nOff > 100 ? sog.map(v => (v / nOff) ** (1 / p)) : [1, 1, 1];
    return { wallRef, wallMid, light, wallY: luminance(wallRef), sample: Float32Array.from(sample) };
  }

  /**
   * The original paint from image statistics (one image, or the most
   * representative frame of a set; see estimateFromSet).
   * @returns {number[]} Linear sRGB reflectance.
   */
  function estimateFromStats(st) {
    return withLightness(colourOf(st), st);
  }
  /** The paint's colour at unit luminance: the wall's middle band over the light. */
  function colourOf({ wallMid, light }) {
    const c = wallMid.map((v, i) => v / Math.max(light[i], 1e-6));
    const cy = Math.max(luminance(c), 1e-6);
    return c.map(v => v / cy);
  }
  /** A unit-luminance colour at the lightness the fit predicts from the photographed wall. */
  function withLightness(c, { wallRef }) {
    const L = Math.min(Math.max(ESTIMATE.L0 + ESTIMATE.L1 * lOfY(luminance(wallRef)), 20), 97);
    const Y = yOfL(L);
    return c.map(v => Math.min(Math.max(v * Y, 0.003), 0.95));
  }

  /**
   * The original paint of a room seen in several images (times of day, video
   * frames). The paint is the same in all of them:
   *   lightness  from the brightest-lit image (largest wall luminance), the
   *              most like how rooms are normally photographed (night images
   *              under lamps would read as a darker paint)
   *   colour     the per-channel median of each well-lit image's colour (wall
   *              luminance at least a quarter of the brightest), so one image
   *              with a strong sun patch or lamp cast can't decide it alone
   * @param {ReturnType<typeof imageStats>[]} statsList
   */
  function estimateFromSet(statsList) {
    const best = statsList.reduce((a, b) => (b.wallY > a.wallY ? b : a));
    const lit = statsList.filter(s => s.wallY >= 0.25 * best.wallY).map(colourOf);
    const c = [0, 1, 2].map(k => median(lit.map(x => x[k])));
    const cy = Math.max(luminance(c), 1e-6);
    return withLightness(c.map(v => v / cy), best);
  }

  /**
   * Slider statistics of the wall's light (the Wall Colour Delta), for the
   * Contrast and Saturation sliders: its median luminance (the contrast
   * pivot) and its median Oklab chroma (the saturation scale).
   * @param {Float32Array} sample  Wall pixels, linear RGB triples.
   * @param {number[]} oldLin  The original paint.
   */
  function lightStats(sample, oldLin) {
    const o = mat.apply(TO16, oldLin).map(v => Math.max(v, 1e-4));
    const ys = [], cs = [];
    for (let i = 0; i < sample.length; i += 3) {
      const p = mat.apply(TO16, [sample[i], sample[i + 1], sample[i + 2]]);
      const d = mat.apply(FROM16, p.map((v, k) => v / o[k]));
      ys.push(luminance(d));
      const ok = PP.oklab(...d.map(v => Math.max(v, 0)));
      cs.push(Math.hypot(ok[1], ok[2]));
    }
    return { pivotY: Math.max(median(ys), 1e-4), medianChroma: Math.max(median(cs), 1e-4) };
  }

  window.WallPaint = {
    TO16, FROM16, KAPPA, bounceGain, transfer, recolour,
    lab, labToLinear, deltaE2000, lOfY, yOfL,
    GAMUT, chromaMax, isPaintLike, randomPaints, rng,
    ESTIMATE, imageStats, statsFromPixels, estimateFromStats, estimateFromSet, lightStats, morph
  };
})();
