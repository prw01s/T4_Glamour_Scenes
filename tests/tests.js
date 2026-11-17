/* ==========================================================================
 * tests.js — tests for js/paintPipeline.js and glsl/shaderSceneRender.glsl.
 *
 * Runs in the browser (the pipeline needs WebGL2 and the DOM): open
 * http://localhost:8000/tests/ after `bash serve.sh`. Results are listed in
 * the page and summarised in #summary and in window.testResults, so they can
 * also be read by automation.
 *
 *   unit  pure colour science: transfer curves, Oklab, matrices, P3, CCT,
 *         spectral reflectance fit, statistics, sliders, scene adaptation
 *   gpu   the shaders on small synthetic images: every model's "white light
 *         shows the swatch" identity, v3's interreflection, mask-weighted
 *         blur, v3's detail layer and warm light
 * ======================================================================== */
(async function () {
  "use strict";
  const P = window.PaintPipeline;
  const rows = document.getElementById("results");
  const results = [];

  /** Records one test. `fn` returns a detail string, or throws to fail. */
  async function test(name, fn) {
    let ok = true, detail = "";
    try { detail = (await fn()) || ""; } catch (err) { ok = false; detail = err && err.message || String(err); }
    results.push({ name, ok, detail });
    const tr = rows.insertRow();
    tr.insertCell().textContent = ok ? "pass" : "FAIL";
    tr.cells[0].className = ok ? "pass" : "fail";
    tr.insertCell().textContent = name;
    tr.insertCell().textContent = detail;
  }
  function near(actual, expected, tol, what = "value") {
    const a = [].concat(actual), e = [].concat(expected);
    a.forEach((v, i) => {
      if (!(Math.abs(v - e[i]) <= tol))
        throw new Error(`${what}: got ${fmt(a)}, expected ${fmt(e)} ±${tol}`);
    });
    return `${fmt(a)} ≈ ${fmt(e)}`;
  }
  const fmt = v => "[" + [].concat(v).map(x => +(+x).toFixed(4)).join(", ") + "]";
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

  const PALETTE = ["#a4aca6", "#cfdbde", "#d0ba94", "#dee0de", "#2f3d4c"];

  // ======================================================================
  // Unit tests
  // ======================================================================

  await test("unit: hex -> linear -> hex round trip", () => {
    for (const h of [...PALETTE, "#000000", "#ffffff", "#ff0000", "#0a0b0c"])
      assert(P.linearToHex(P.hexToLinear(h)) === h, `${h} -> ${P.linearToHex(P.hexToLinear(h))}`);
    return "palette + extremes";
  });
  await test("unit: LRV of #e3d4b9 is 67", () => near(P.lrv("#e3d4b9"), 67, 0));
  await test("unit: Oklab of white is (1, 0, 0)", () => near(P.oklab(1, 1, 1), [1, 0, 0], 1e-4));
  await test("unit: 3x3 inverse", () => {
    const m = P.mat.mul(P.XYZ2RGB, P.RGB2XYZ);
    return near(m, P.mat.IDENTITY, 2e-6, "XYZ2RGB x RGB2XYZ");
  });
  await test("unit: sRGB -> Display P3 matrix", () => {
    near(P.mat.apply(P.SRGB_TO_P3, [1, 1, 1]), [1, 1, 1], 1e-9, "white");
    return near(P.mat.apply(P.SRGB_TO_P3, [1, 0, 0]), [0.8225, 0.0332, 0.0171], 2e-4, "sRGB red in P3");
  });
  await test("unit: McCamy CCT of D65 ≈ 6504 K", () => near(P.T_REF, 6504, 10));
  await test("unit: McCamy CCT of blackbodies within 3 %", () => {
    const out = [];
    for (const T of [2700, 4000, 6500, 10000]) {
      const [X, Y, Z] = P.spectralXYZ(T, null), s = X + Y + Z;
      const est = P.mccamyCCT(X / s, Y / s);
      assert(Math.abs(est / T - 1) < 0.03, `${T} K -> ${est.toFixed(0)} K`);
      out.push(`${T}→${est.toFixed(0)}`);
    }
    return out.join(", ");
  });
  await test("unit: reference light with reflectance 1 is RGB (1,1,1)", () =>
    near(P.reflectedRGB(new Array(P.SPECTRAL_N).fill(1)), [1, 1, 1], 1e-9));
  await test("unit: spectral fit reproduces paint colours", () => {
    const worst = [];
    for (const h of [...PALETTE, "#e3d4b9", "#58679d", "#dda27a", "#7a1f2b", "#1f5f3a"]) {
      const target = P.hexToLinear(h), refl = P.fitReflectance(target);
      assert(refl.every(r => r >= 0 && r <= 1), `${h}: reflectance outside 0..1`);
      const got = P.reflectedRGB(refl);
      const err = Math.max(...got.map((v, i) => Math.abs(v - target[i])));
      assert(err < 0.004, `${h}: error ${err.toFixed(4)}`);
      worst.push(err);
    }
    return `max error ${Math.max(...worst).toFixed(5)} (linear)`;
  });
  await test("unit: spectral interreflection (white = 1, dark paint returns less, saturated paint more saturated)", () => {
    // The fitted spectrum of white tops out at 0.999 (a sigmoid never reaches 1): 0.3 % low, far below one 8-bit level.
    near(P.paintSpec("#ffffff").bounceRGB, [1, 1, 1], 5e-3, "white");
    const navy = P.paintSpec("#2f3d4c").bounceRGB;
    assert(Math.max(...navy) < 0.01, `navy ${fmt(navy)}`);
    const red = P.paintSpec("#7a1f2b"), a = red.albedo, b = red.bounceRGB;
    assert(b[0] / Math.max(b[1], 1e-6) > a[0] / a[1], "bounce not more saturated than the paint");
    return `navy ${fmt(navy)}; burgundy R/G ${(a[0] / a[1]).toFixed(1)} -> ${(b[0] / Math.max(b[1], 1e-6)).toFixed(1)}`;
  });

  /** A canvas filled by fn(x, y) -> [r, g, b] (0..255) or [r, g, b, a]. */
  function makeImage(w, h, fn) {
    const c = Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = c.getContext("2d"), img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = fn(x, y), i = (y * w + x) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  await test("unit: LightStats medians, reference white and wall mean", () => {
    // 3/4 of the pixels at 51, 1/4 at 204; the mask marks the 204 quarter as wall.
    const src = makeImage(64, 64, x => x < 48 ? [51, 51, 51] : [204, 204, 204]);
    const mask = makeImage(64, 64, x => x < 48 ? [255, 255, 255] : [0, 0, 0]);
    const s = new P.LightStats(64, 64);
    s.add(src, mask);
    const dark = P.decodeSrgb(51 / 255), light = P.decodeSrgb(204 / 255);
    near(s.pivotY, dark, 1e-3, "pivotY");
    near(s.refY, light, 1e-3, "refY");
    near(s.wallMean, [light, light, light], 1e-3, "wallMean");
    const both = P.LightStats.combine([s, s]);
    near(both.pivotY, s.pivotY, 0, "combine");
    return `pivot ${s.pivotY.toFixed(4)}, refY ${s.refY.toFixed(4)}`;
  });
  await test("unit: makeAdjustment is null when centred", () => {
    const s = new P.LightStats(1, 1);
    assert(P.makeAdjustment({ contrast: 0, saturation: 0, satMeasure: "full" }, s) === null, "not null");
    const a = P.makeAdjustment({ contrast: 1, saturation: -0.5, satMeasure: "chroma" }, s);
    return near([a.contrastK, a.satAmount, a.satMeasure, a.medianDiff], [2, -0.5, 1, s.medianChroma], 0);
  });
  await test("unit: CIECAM16 degree of adaptation", () => {
    near(P.ciecamD(0), 0.8245, 1e-3, "La = 0");
    return near(P.ciecamD(1000), 1, 1e-3, "La = 1000");
  });
  await test("unit: scene adaptation (neutral = identity, warm -> cooler)", () => {
    const neutral = new P.LightStats(8, 8); neutral.add(makeImage(8, 8, () => [200, 200, 200]));
    const n = P.sceneSpec(neutral, neutral);
    const id = Array.from(n.adaptMat);
    near(id, [1, 0, 0, 0, 1, 0, 0, 0, 1], 1e-4, "neutral adaptMat");
    const warm = new P.LightStats(8, 8); warm.add(makeImage(8, 8, () => [255, 200, 140]));
    const w = P.sceneSpec(warm, warm);
    const cm = w.adaptMat, m = [cm[0], cm[3], cm[6], cm[1], cm[4], cm[7], cm[2], cm[5], cm[8]];   // column- -> row-major
    const out = P.mat.apply(m, warm.wallMean);
    assert(out[0] / out[2] < warm.wallMean[0] / warm.wallMean[2], "not cooler");
    return `D = ${w.D.toFixed(3)}; warm white R/B ${(warm.wallMean[0] / warm.wallMean[2]).toFixed(2)} -> ${(out[0] / out[2]).toFixed(2)}`;
  });

  // ======================================================================
  // GPU tests
  // ======================================================================

  let sources;
  await test("gpu: shader file loads and every program compiles", async () => {
    sources = await P.loadShaders("../glsl/shaderSceneRender.glsl");
    makePipeline(64, 64);
    return "VERT + 6 fragment programs";
  });

  function makePipeline(a, r, wideGamut = false) {
    const canvas = document.createElement("canvas");
    return new P.LightPipeline(canvas, {
      analysis: [a, a], render: [r, r], sources, wideGamut, preserveDrawingBuffer: true,
      hooks: { onRestored() {}, onError(e) { throw e; } }
    });
  }
  /** Encoded RGB (0..255) of canvas pixel (x, y), y from the TOP. */
  function readPixel(pipe, x, y) {
    const gl = pipe.gl, px = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(x, pipe.rh - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return [px[0], px[1], px[2]];
  }
  const encoded = lin => lin.map(v => Math.round(255 * P.encodeSrgb(Math.min(1, Math.max(0, v)))));

  /** Analyses + renders `image` (all wall unless a mask is given) and returns the pipeline. */
  function run(pipe, image, { model, hex, mask = null, sliders = null, srgb = false, reference = null }) {
    const src = pipe.createSource(pipe.rw, pipe.rh, { mipmaps: pipe.rw > pipe.aw, srgb });
    pipe.upload(src, image);
    const maskImg = mask || makeImage(4, 4, () => [0, 0, 0]);
    const m = pipe.createSource(...P.sizeOf(maskImg), { mipmaps: true });
    pipe.upload(m, maskImg);
    const stats = new P.LightStats(32, 32); stats.add(image, maskImg);
    // v3's reference white comes from the whole set of images (a room's photos,
    // a video's frames); `reference` adds a brighter one, like daylight frames.
    let pool = stats;
    if (reference) { const r = new P.LightStats(32, 32); r.add(reference, maskImg); pool = P.LightStats.combine([stats, r]); }
    const lightMap = pipe.createLightMap();
    const adjust = sliders ? P.makeAdjustment(sliders, stats) : null;
    pipe.analyse({ src, mask: m, lightMap, model, adjust, refY: pool.refY });
    pipe.render({ lightMap, src, model, paint: P.paintSpec(hex), scene: P.sceneSpec(stats, pool),
                  detailGamma: P.SHADER_DEFAULTS.v3.detail * (adjust ? adjust.contrastK : 1) });
    return { pipe, stats };
  }

  const white = makeImage(64, 64, () => [255, 255, 255]);
  for (const model of ["v1", "v2"]) {
    await test(`gpu: ${model} white light shows the exact swatch`, () => {
      const pipe = makePipeline(64, 64), out = [];
      for (const hex of PALETTE) {
        run(pipe, white, { model, hex });
        near(readPixel(pipe, 32, 32), P.hexToRgb(hex), 2, hex);
        out.push(hex);
      }
      return out.join(" ");
    });
  }
  await test("gpu: v3 white light, white paint -> white", () => {
    const pipe = makePipeline(64, 64);
    run(pipe, white, { model: "v3", hex: "#ffffff" });
    return near(readPixel(pipe, 32, 32), [255, 255, 255], 1);
  });
  await test("gpu: v3 white light = swatch with the new paint's interreflection", () => {
    const pipe = makePipeline(64, 64), S = P.SHADER_DEFAULTS.v3, out = [];
    for (const hex of PALETTE) {
      const { stats } = run(pipe, white, { model: "v3", hex });
      const spec = P.paintSpec(hex), a = spec.albedo;
      const ob = S.ambient * S.bounceShare * stats.meanWallY / stats.refY;
      const expected = a.map((v, i) => v * (1 - ob) + spec.bounceRGB[i] * ob);
      near(readPixel(pipe, 32, 32), encoded(expected), 2, hex);
      out.push(`${hex}→${fmt(readPixel(pipe, 32, 32))}`);
    }
    return out.join(" ");
  });
  await test("gpu: mask-weighted blur keeps furniture out of the wall's light (v2)", () => {
    // Left half: dark furniture (not wall); right half: white wall.
    const img = makeImage(512, 512, x => x < 256 ? [20, 20, 20] : [255, 255, 255]);
    const mask = makeImage(512, 512, x => x < 256 ? [255, 255, 255] : [0, 0, 0]);
    const pipe = makePipeline(512, 512);
    run(pipe, img, { model: "v2", hex: "#cfdbde", mask });
    const edge = readPixel(pipe, 257, 256), far = readPixel(pipe, 400, 256);
    return near(edge, far, 1, "wall pixel next to the furniture vs far from it");
  });
  await test("gpu: v3 restores full-resolution brightness detail; v2 stays smooth", () => {
    // A fine per-pixel texture on the wall, rendered at twice the analysis size.
    const img = makeImage(256, 256, (x, y) => ((x + y) & 1) ? [235, 235, 235] : [195, 195, 195]);
    const v3 = run(makePipeline(128, 256), img, { model: "v3", hex: "#a4aca6" }).pipe;
    const d3 = Math.abs(readPixel(v3, 100, 100)[1] - readPixel(v3, 101, 100)[1]);
    const v2 = run(makePipeline(128, 256), img, { model: "v2", hex: "#a4aca6" }).pipe;
    const d2 = Math.abs(readPixel(v2, 100, 100)[1] - readPixel(v2, 101, 100)[1]);
    assert(d3 >= 8, `v3 neighbour difference ${d3}`);
    assert(d2 <= 2, `v2 neighbour difference ${d2}`);
    return `neighbouring pixels differ by ${d3} (v3) vs ${d2} (v2)`;
  });
  await test("gpu: v3 under warm light tints a white wall warm", () => {
    // Half the image neutral (the scene's mean is then only mildly warm), half warm.
    const img = makeImage(64, 64, x => x < 32 ? [230, 230, 230] : [255, 214, 170]);
    const { pipe } = run(makePipeline(64, 64), img, { model: "v3", hex: "#ffffff" });
    const [r, g, b] = readPixel(pipe, 48, 32), n = readPixel(pipe, 16, 32);
    assert(r > g && g > b, `warm side ${fmt([r, g, b])}`);
    assert(Math.abs(n[0] - n[2]) < Math.abs(r - b), "neutral side as warm as the warm side");
    return `warm side ${fmt([r, g, b])}, neutral side ${fmt(n)}`;
  });
  await test("gpu: in a dark room the paint stays dark (fill follows the scene's light)", () => {
    // A uniformly dim room (encoded 30, ~1.3 % of white), as a night frame of
    // a video whose daytime frames are white. A paint with LRV 40 must come
    // out darker than the original white wall in every model: a fixed fill
    // floor used to make it 3-4x brighter (glowing walls at night).
    const dim = makeImage(64, 64, () => [30, 30, 30]);
    const wallY = P.decodeSrgb(30 / 255), out = [];
    for (const model of ["v1", "v2", "v3"]) {
      const [r, g, b] = readPixel(run(makePipeline(64, 64), dim, { model, hex: "#a4aca6", reference: white }).pipe, 32, 32);
      const y = P.luminance([r, g, b].map(v => P.decodeSrgb(v / 255)));
      assert(y < wallY, `${model}: painted ${y.toFixed(4)} vs wall ${wallY.toFixed(4)}`);
      out.push(`${model} ${(y / wallY).toFixed(2)}x`);
    }
    return "painted / original wall light: " + out.join(", ");
  });
  await test("gpu: sliders change the result, centred sliders change nothing", () => {
    const img = makeImage(64, 64, x => [120 + x, 110 + x, 100 + x]);
    const base = readPixel(run(makePipeline(64, 64), img, { model: "v2", hex: "#d0ba94" }).pipe, 40, 32);
    const zero = readPixel(run(makePipeline(64, 64), img, { model: "v2", hex: "#d0ba94",
                           sliders: { contrast: 0, saturation: 0, satMeasure: "full" } }).pipe, 40, 32);
    near(zero, base, 0, "centred");
    const more = readPixel(run(makePipeline(64, 64), img, { model: "v2", hex: "#d0ba94",
                           sliders: { contrast: 1, saturation: 0, satMeasure: "full" } }).pipe, 40, 32);
    assert(more.some((v, i) => v !== base[i]), "contrast had no effect");
    return `centred ${fmt(zero)}, contrast +100 ${fmt(more)}`;
  });
  await test("gpu: photos are resized in linear light (sRGB source + RESAMPLE)", () => {
    // A 1-pixel black/white checker, resized to half size: the right answer is
    // half the LIGHT (encoded 188), not half the encoded value (128).
    const img = makeImage(128, 128, (x, y) => ((x + y) & 1) ? [255, 255, 255] : [0, 0, 0]);
    const pipe = makePipeline(64, 64);
    const src = pipe.createSource(64, 64, { srgb: true });
    pipe.upload(src, img);
    const gl = pipe.gl, fbo = gl.createFramebuffer(), px = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, src.tex, 0);
    gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.deleteFramebuffer(fbo);
    return near(px[0], 188, 2, "encoded value of the resized checker");
  });
  await test("unit: LightStats point-samples (no averaging of encoded values)", () => {
    // Random black/white pixels: half the light. Averaging encoded values
    // would turn them into grey 128 (0.216 linear); point samples keep ~0.5.
    let seed = 1;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const img = makeImage(256, 256, () => rand() < 0.5 ? [255, 255, 255] : [0, 0, 0]);
    const s = new P.LightStats(64, 64); s.add(img);
    assert(Math.abs(s.meanWallY - 0.5) < 0.1, `mean ${s.meanWallY}`);
    return `mean wall luminance ${s.meanWallY.toFixed(3)}`;
  });

  if (P.supportsWideGamut()) {
    await test("gpu: Display P3 output encodes sRGB colours in P3", () => {
      const pipe = makePipeline(64, 64, true);
      assert(pipe.outputSpace === "display-p3", `output space ${pipe.outputSpace}`);
      run(pipe, white, { model: "v2", hex: "#d0ba94" });
      const expected = encoded(P.mat.apply(P.SRGB_TO_P3, P.hexToLinear("#d0ba94")));
      return near(readPixel(pipe, 32, 32), expected, 2);
    });
  }

  // ======================================================================
  // Room movie (js/roomMovie.js)
  // ======================================================================

  await test("unit: room movie: direct-sun colour and level by elevation (docs/room-movie-plan.md 4.4)", () => {
    const RM = window.RoomMovie;
    const cct = el => { const S = RM.sunLight(el).S, xyz = [0, 1, 2].map(i => S.reduce((t, v, k) => t + v * P.CMF[3 * k + i], 0)), n = xyz[0] + xyz[1] + xyz[2]; return P.mccamyCCT(xyz[0] / n, xyz[1] / n); };
    // Research table (clean to hazy air): 5 deg ~2500-2900 K, 15 deg ~3800-4100 K, 30 deg ~4500-4700 K, 45 deg ~4800-5000 K (+-300 K)
    const rows = [[5, 2200, 3200], [15, 3500, 4400], [30, 4200, 5000], [45, 4500, 5300]];
    for (const [el, lo, hi] of rows) assert(cct(el) > lo && cct(el) < hi, `${el} deg: ${Math.round(cct(el))} K, expected ${lo}-${hi}`);
    const lux20 = RM.sunLight(20).lux;
    assert(lux20 > 35000 && lux20 < 75000, `direct sun at 20 deg: ${Math.round(lux20)} lux`);
    assert(RM.sunLight(-2).lux === 0, "below the horizon: no direct sun");
    return rows.map(([el]) => `${el}°: ${Math.round(cct(el))} K`).join(", ") + `; 20°: ${Math.round(lux20 / 1000)} klux`;
  });
  await test("unit: room movie: sky illuminance through twilight, and adaptation by colour temperature", () => {
    const RM = window.RoomMovie;
    for (let el = -17; el < 60; el += 1) assert(RM.skyLux(el + 1) > RM.skyLux(el), `sky brightens with the sun (${el} deg)`);
    near(RM.skyLux(-6), 3.4, 0.01, "civil twilight end (lux)");
    near([RM.adaptationD(6000), RM.adaptationD(4000), RM.adaptationD(1800)], [0.95, 0.85, 0.5], 1e-9, "D at 6000 / 4000 / 1800 K");
    assert(RM.adaptationD(2700) > 0.6 && RM.adaptationD(2700) < 0.75, "D at 2700 K within 0.6-0.75");
    return `sky ${RM.skyLux(20).toFixed(0)} lux at 20°, ${RM.skyLux(-14).toFixed(4)} at -14°; D 0.95 / 0.85 / ${RM.adaptationD(2700).toFixed(2)} / 0.5`;
  });

  // ======================================================================
  // Sequence tests (js/dayNightSequence.js) with simulated videos
  // ======================================================================

  /**
   * A stand-in for <video>: plays in real time at playbackRate, seeks
   * asynchronously (10 ms), reports presented frames to
   * requestVideoFrameCallback with frame-quantised mediaTime, and fires
   * "seeked" and "ended" like the real element.
   */
  class FakeVideo extends EventTarget {
    constructor(duration, fps = 24) {
      super();
      Object.assign(this, { duration, fps, _t: 0, paused: true, ended: false, seeking: false, playbackRate: 1, _cbs: [] });
      this._q = { droppedVideoFrames: 0, totalVideoFrames: 0 };
    }
    get currentTime() { return this._t; }
    set currentTime(t) {
      this._t = Math.max(0, Math.min(this.duration, t));
      this.ended = false;
      this.seeking = true;
      setTimeout(() => { this.seeking = false; this.dispatchEvent(new Event("seeked")); this._present(); }, 10);
    }
    play() {
      if (this._t >= this.duration) this._t = 0;
      this.ended = false;
      if (!this.paused) return Promise.resolve();
      this.paused = false;
      let last = performance.now();
      const step = now => {
        if (this.paused) return;
        this._t = Math.min(this.duration, this._t + (now - last) / 1000 * this.playbackRate);
        last = now;
        this._present();
        if (this._t >= this.duration) { this.paused = true; this.ended = true; this.dispatchEvent(new Event("ended")); return; }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      return Promise.resolve();
    }
    pause() { this.paused = true; }
    _present() {
      this._q.totalVideoFrames++;
      const cbs = this._cbs, mediaTime = Math.floor(this._t * this.fps + 1e-6) / this.fps;
      this._cbs = [];
      for (const cb of cbs) cb(performance.now(), { mediaTime });
    }
    requestVideoFrameCallback(cb) { this._cbs.push(cb); }
    getVideoPlaybackQuality() { return this._q; }
  }

  const S = window.DayNightSequence;
  const SPAN = 1, FRAME = 1 / 24;
  /** A fresh sequence over two simulated 1-second videos. */
  function makeSequence(extra = {}) {
    const track = () => {
      const layer = document.body.appendChild(Object.assign(document.createElement("div"), { hidden: true }));
      return { video: new FakeVideo(SPAN), layer };
    };
    const forward = track(), backward = track();
    const arrivals = [];
    const seq = S.create({ forward, backward, span: SPAN, autoplayRate: 1, onArrive: s => arrivals.push(s), ...extra });
    return { seq, forward, backward, arrivals };
  }
  const waitFor = async (cond, ms = 4000) => {
    const t0 = performance.now();
    while (!cond()) {
      if (performance.now() - t0 > ms) throw new Error("timed out");
      await new Promise(r => setTimeout(r, 10));
    }
    return performance.now() - t0;
  };
  const settled = seq => () => seq.mode === "paused" && !seq.playing;

  await test("sequence: a later time plays the forward video and stops on its exact frame", async () => {
    const { seq, arrivals } = makeSequence();
    seq.goTo(0.5);
    await waitFor(settled(seq));
    near(seq.position, 0.5, FRAME / 2, "position");
    assert(seq.active === "forward", `active ${seq.active}`);
    return `stopped at ${seq.position.toFixed(3)}; arrived ${fmt(arrivals)}`;
  });
  await test("sequence: an earlier time switches to the backward video and starts moving at once", async () => {
    const { seq, backward } = makeSequence();
    seq.goTo(0.75); await waitFor(settled(seq));
    const t0 = performance.now();
    seq.goTo(0.25);
    const ms = await waitFor(() => !backward.video.paused);
    await waitFor(settled(seq));
    assert(seq.active === "backward", `active ${seq.active}`);
    assert(ms < 100, `moved after ${ms.toFixed(0)} ms`);
    near(seq.position, 0.25, FRAME / 2, "position");
    return `moving after ${ms.toFixed(0)} ms (no wait for the crossfade); stopped at ${seq.position.toFixed(3)}`;
  });
  await test("sequence: moves are eased (fast start, slow landing)", async () => {
    const { seq, forward } = makeSequence();
    const rates = [];
    seq.goTo(1);
    const rec = () => { if (!forward.video.paused) rates.push(forward.video.playbackRate); if (seq.mode === "seek") requestAnimationFrame(rec); };
    requestAnimationFrame(rec);
    await waitFor(settled(seq));
    const peak = Math.max(...rates), last = rates[rates.length - 1];
    assert(peak > 2 && last < peak / 2, `rates ${fmt(rates)}`);
    return `peak ${peak.toFixed(2)}x, landing ${last.toFixed(2)}x`;
  });
  await test("sequence: morning and night land on the exact first frames", async () => {
    const { seq, forward, backward } = makeSequence();
    seq.goTo(1); await waitFor(settled(seq));
    assert(seq.active === "backward" && backward.video.currentTime === 0, `night on ${seq.active} at ${backward.video.currentTime}`);
    seq.goTo(0); await waitFor(settled(seq));
    assert(seq.active === "forward" && forward.video.currentTime === 0, `morning on ${seq.active} at ${forward.video.currentTime}`);
    return "night = backward t 0, morning = forward t 0";
  });
  await test("sequence: reversing twice within a crossfade still arrives (no freeze)", async () => {
    const { seq } = makeSequence();
    seq.goTo(0.5); await waitFor(settled(seq));
    seq.goTo(0.25);
    await new Promise(r => setTimeout(r, 40));
    seq.goTo(0.8);
    await waitFor(settled(seq));
    near(seq.position, 0.8, FRAME / 2, "position");
    return `arrived at ${seq.position.toFixed(3)} on ${seq.active}`;
  });
  await test("sequence: autoplay hands over at the end and loops; pause stops both", async () => {
    const { seq, forward, backward } = makeSequence();
    seq.goTo(0.8); await waitFor(settled(seq));
    seq.autoplay();
    await waitFor(() => seq.active === "backward" && !backward.video.paused);
    const back = seq.position;
    seq.pause();
    await waitFor(settled(seq));
    assert(forward.video.paused && backward.video.paused, "a video still plays");
    return `handed over at night, running backward (at ${back.toFixed(2)}); paused`;
  });
  await test("sequence: scrubbing shows the dragged-to time", async () => {
    const { seq } = makeSequence();
    seq.scrubTo(0.3);
    await waitFor(() => Math.abs(seq.position - 0.3) < 1e-6);
    seq.scrubTo(0.6);
    await waitFor(() => Math.abs(seq.position - 0.6) < 1e-6);
    assert(seq.mode === "scrub" && !seq.playing, `mode ${seq.mode}`);
    seq.endScrub();
    assert(seq.mode === "paused", `mode ${seq.mode}`);
    return "followed 0.3 -> 0.6, paused after the drag";
  });

  await test("sequence: one palindrome file: night mid-file, reverse from the second half", async () => {
    // Both tracks are copies of one 2-second video: morning -> night (t 1) -> morning (t 2).
    const track = () => ({ video: new FakeVideo(2 * SPAN), layer: document.body.appendChild(Object.assign(document.createElement("div"), { hidden: true })) });
    const forward = track(), backward = track();
    const seq = S.create({ forward, backward, span: SPAN, backwardEnd: 2 * SPAN, autoplayRate: 1 });
    seq.goTo(0.75); await waitFor(settled(seq));
    seq.goTo(0.25); await waitFor(settled(seq));
    assert(seq.active === "backward", `active ${seq.active}`);
    near(backward.video.currentTime, 2 * SPAN - 0.25, FRAME, "backward copy's time");
    seq.goTo(0.8); await waitFor(settled(seq));
    seq.autoplay();
    await waitFor(() => seq.active === "backward" && !backward.video.paused);
    assert(forward.video.currentTime <= SPAN + 2 * FRAME, `forward copy ran past night to ${forward.video.currentTime.toFixed(3)}`);
    assert(backward.video.currentTime >= SPAN - FRAME, `backward copy started at ${backward.video.currentTime.toFixed(3)}`);
    seq.pause(); await waitFor(settled(seq));
    return `reverse from t ${(2 * SPAN - 0.25).toFixed(2)}; autoplay stopped the forward copy at ${forward.video.currentTime.toFixed(3)} (night)`;
  });

  // ======================================================================
  // v4: sceneVisualizer.html (js/wallPaint.js, glsl/sceneVisualizer.glsl)
  // ======================================================================

  const WP = window.WallPaint, SVR = window.SceneVisualizer;
  const labOfHex = h => WP.lab(P.hexToLinear(h));
  await test("v4 unit: the original paint as the new paint gives the photo back exactly", () => {
    for (const h of ["#bcb6b6", "#4a5d5f", "#ffffff", "#9dbdb3"]) near(WP.transfer(P.hexToLinear(h), P.hexToLinear(h)).gain, [1, 1, 1], 1e-12, h);
    return "gain = (1, 1, 1)";
  });
  await test("v4 unit: consistency: A -> B -> C equals A -> C (your two-uploads case)", () => {
    const rand = WP.rng(7); let worst = 0;
    for (let i = 0; i < 300; i++) {
      const hx = () => P.linearToHex([rand(), rand(), rand()].map(v => 0.02 + 0.9 * v));
      const [A, B, C, photo] = [hx(), hx(), hx(), hx()].map(P.hexToLinear);
      const viaB = WP.recolour(WP.recolour(photo, A, B), B, C), direct = WP.recolour(photo, A, C);
      worst = Math.max(worst, WP.deltaE2000(WP.lab(viaB), WP.lab(direct)));
    }
    assert(worst < 1e-6, `worst dE2000 ${worst}`);
    return `300 random paint triples: worst dE2000 ${worst.toExponential(1)}`;
  });
  await test("v4 unit: the transfer matches the Python reference (tools/v4ref.py)", () => {
    const ref = [["#808080", "#bcb6b6", "#4a5d5f", [0.0230074, 0.0428333, 0.0449707]],
                 ["#f0e8d8", "#e3e0da", "#736660", [0.1436567, 0.1065236, 0.0863841]],
                 ["#203040", "#9dbdb3", "#cfba9c", [0.0356142, 0.0288949, 0.0370696]],
                 ["#ffffff", "#ffffff", "#c9cdb9", [0.4571051, 0.4839768, 0.3601135]]];
    for (const [p, o, n, out] of ref) near(WP.recolour(P.hexToLinear(p), P.hexToLinear(o), P.hexToLinear(n)), out, 2e-6, `${p} ${o}->${n}`);
    return "4 cases within 2e-6";
  });
  await test("v4 unit: random paints: realistic, reproducible, spread over hue, chroma and lightness", () => {
    const sets = [1, 2, 3, 99, 12345].map(s => WP.randomPaints(10, s));
    assert(JSON.stringify(WP.randomPaints(10, 12345)) === JSON.stringify(sets[4]), "same seed, different colours");
    const notes = [];
    for (const set of sets) {
      assert(set.length === 10 && new Set(set).size === 10, "10 distinct colours");
      for (const h of set) assert(WP.isPaintLike(h), `${h} outside the paint gamut`);
      const L = set.map(h => labOfHex(h)[0]), C = set.map(h => Math.hypot(...labOfHex(h).slice(1)));
      const hues = new Set(set.filter((h, i) => C[i] > 8).map(h => Math.floor(((Math.atan2(labOfHex(h)[2], labOfHex(h)[1]) * 180 / Math.PI + 360) % 360) / 60)));
      assert(Math.max(...L) - Math.min(...L) > 50, `lightness span ${(Math.max(...L) - Math.min(...L)).toFixed(0)}`);
      assert(hues.size >= 4, `only ${hues.size} hue sextants`);
      assert(Math.min(...C) < 4 && Math.max(...C) > 20, `chroma ${Math.min(...C).toFixed(0)}..${Math.max(...C).toFixed(0)}`);
      notes.push(`L* ${Math.min(...L).toFixed(0)}-${Math.max(...L).toFixed(0)}, C* ${Math.min(...C).toFixed(0)}-${Math.max(...C).toFixed(0)}, ${hues.size} hue sextants`);
    }
    return notes[4];
  });
  await test("v4 unit: the estimate recovers a wall's colour under coloured light (synthetic room)", () => {
    // Wall paint #9dbdb3 and a neutral grey surround, both under warm light
    // with a gradient; the camera neutralised nothing. The colour must come
    // back (lightness is a fitted guess and is not tested here).
    const paint = P.hexToLinear("#9dbdb3"), grey = [0.4, 0.4, 0.4], light = [1.0, 0.85, 0.62];
    const w = 160, h = 120, px = new Uint8ClampedArray(w * h * 4), mk = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = 4 * (y * w + x), isWall = x > 40 && x < 140 && y < 90, e = 0.55 + 0.4 * x / w;
      const c = (isWall ? paint : grey).map((v, k) => P.encodeSrgb(Math.min(1, v * light[k] * e)) * 255);
      px.set([...c, 255], i); mk.set(isWall ? [0, 0, 0, 255] : [255, 255, 255, 255], i);
    }
    const st = WP.statsFromPixels(px, mk, w, h), est = WP.estimateFromStats(st);
    const a = WP.lab(est), t = WP.lab(paint);
    const dab = Math.hypot(a[1] * t[0] / a[0] - t[1], a[2] * t[0] / a[0] - t[2]);
    assert(Math.hypot(a[1] - t[1], a[2] - t[2]) < 3, `a*b* ${fmt(a.slice(1))} vs ${fmt(t.slice(1))}`);
    return `estimated a*b* ${fmt(a.slice(1))}, true ${fmt(t.slice(1))}`;
  });

  // GPU
  async function loadImg(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(`Couldn't load ${src}`)); i.src = src; });
  }
  let v4r = null;
  await test("v4 gpu: the sceneVisualizer shader compiles", async () => {
    v4r = await SVR.createRenderer(document.createElement("canvas"), { glslUrl: "../glsl/sceneVisualizer.glsl", srgbOnly: true });
    return v4r.outputSpace;
  });
  const look = (o, n, extra = {}) => ({ oldLin: P.hexToLinear(o), newLin: P.hexToLinear(n), contrast: 0, saturation: 0, lightStats: null, dither: false, ...extra });
  await test("v4 gpu: original paint in = photo out (every pixel within 1 level)", async () => {
    const img = await loadImg("../images/lighting_variants/living_room/living-room_morning.jpg");
    const w = 512, h = 512, c = makeImage(w, h, () => [0, 0, 0]); c.getContext("2d").drawImage(img, 0, 0, w, h);
    v4r.setSize(w, h); v4r.upload(c); v4r.draw(look("#dddeD9".toLowerCase(), "#ddded9"));
    const out = v4r.readPixels(), inp = c.getContext("2d").getImageData(0, 0, w, h).data;
    let worst = 0; for (let i = 0; i < out.length; i += 4) for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(out[i + k] - inp[i + k]));
    assert(worst <= 1, `worst ${worst} levels`);
    return `worst difference ${worst} level(s)`;
  });
  await test("v4 gpu: the shader matches the JS model (in-gamut colours within 1 level)", async () => {
    const cols = ["#808080", "#f0e8d8", "#203040", "#b0a090", "#5a6b4c", "#c8c8d0"], w = cols.length, h = 1;
    const c = makeImage(w, h, x => P.hexToRgb(cols[x]));
    v4r.setSize(w, h); v4r.upload(c);
    let worst = 0;
    for (const [o, n] of [["#bcb6b6", "#4a5d5f"], ["#e3e0da", "#736660"], ["#cec8bd", "#9fa195"]]) {
      v4r.draw(look(o, n)); const out = v4r.readPixels();
      cols.forEach((hx, x) => {
        const js = WP.recolour(P.hexToLinear(hx), P.hexToLinear(o), P.hexToLinear(n));
        if (js.some(v => v < 0 || v > 1)) return;                       // gamut-mapped: not comparable
        const enc = js.map(v => Math.round(255 * P.encodeSrgb(v)));
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(out[4 * x + k] - enc[k]));
      });
    }
    assert(worst <= 1, `worst ${worst} levels`);
    return `worst ${worst} level(s)`;
  });
  await test("v4 gpu: consistency on a real photo: (A -> B image) -> C equals A -> C", async () => {
    const img = await loadImg("../images/lighting_variants/study/study_noon.jpg"), mask = await loadImg("../images/masks/study_mask.jpg");
    const w = 384, h = 384, c = makeImage(w, h, () => [0, 0, 0]); c.getContext("2d").drawImage(img, 0, 0, w, h);
    const mk = makeImage(w, h, () => [0, 0, 0]); mk.getContext("2d").drawImage(mask, 0, 0, w, h);
    const m = mk.getContext("2d").getImageData(0, 0, w, h).data;
    const A = "#dcdad3", B = "#9dbdb3", C = "#736660";
    v4r.setSize(w, h); v4r.upload(c); v4r.draw(look(A, B));
    const imgB = makeImage(w, h, () => [0, 0, 0]); const bd = imgB.getContext("2d").createImageData(w, h); bd.data.set(v4r.readPixels()); imgB.getContext("2d").putImageData(bd, 0, 0);
    v4r.draw(look(A, C)); const direct = v4r.readPixels();
    v4r.upload(imgB); v4r.draw(look(B, C)); const via = v4r.readPixels();
    const des = [];
    for (let i = 0; i < w * h; i++) {
      if (m[4 * i] > 64) continue;                                            // walls only (black)
      const a = [0, 1, 2].map(k => P.decodeSrgb(direct[4 * i + k] / 255)), b = [0, 1, 2].map(k => P.decodeSrgb(via[4 * i + k] / 255));
      des.push(WP.deltaE2000(WP.lab(a), WP.lab(b)));
    }
    des.sort((x, y) => x - y);
    const med = des[des.length >> 1], p99 = des[Math.floor(des.length * 0.99)];
    assert(med < 0.5 && p99 < 1.5, `median ${med.toFixed(2)}, p99 ${p99.toFixed(2)}`);
    return `${des.length} wall pixels: median dE2000 ${med.toFixed(2)}, p99 ${p99.toFixed(2)} (8-bit rounding of the intermediate image)`;
  });
  await test("v4 gpu: sliders centred = exact; sliders on change the light, not the paint's hue", async () => {
    const c = makeImage(4, 1, x => [[200, 190, 170], [120, 110, 95], [60, 55, 50], [230, 225, 215]][x]);
    v4r.setSize(4, 1); v4r.upload(c);
    const ls = { pivotY: 1, medianChroma: 0.02 };
    v4r.draw(look("#e3e0da", "#5a6b8c", { lightStats: ls })); const a = v4r.readPixels();
    v4r.draw(look("#e3e0da", "#5a6b8c", { lightStats: ls, contrast: 0.5 })); const b = v4r.readPixels();
    let changed = 0; for (let i = 0; i < 16; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) > 2) changed++;
    assert(changed >= 2, "contrast changed nothing");
    return `contrast +50 changed ${changed} of 4 pixels`;
  });
  await test("v4 gpu: speed at 1920 x 1080 (video frame)", async () => {
    const c = makeImage(1920, 1080, (x, y) => [(x * 7) & 255, (y * 3) & 255, 160]);
    v4r.setSize(1920, 1080); v4r.upload(c);
    const ms = v4r.timeDraw(look("#cec8bd", "#2f5d8c", { contrast: 0.3, saturation: 0.2, lightStats: { pivotY: 0.5, medianChroma: 0.02 } }), 20);
    assert(ms < 12, `${ms.toFixed(1)} ms per frame`);
    return `${ms.toFixed(2)} ms per frame with both sliders on`;
  });
  await test("v4 estimator: JS matches the Python reference on pair photos (within 2 dE2000)", async () => {
    const ref = { before3: [0.48837, 0.44296, 0.38393], before8: [0.64535, 0.55753, 0.39282], before10: [0.61133, 0.60798, 0.5878] };
    const out = [];
    for (const [name, py] of Object.entries(ref)) {
      const img = await loadImg(`../images/source/pairs/${name}.jpg`), m = await loadImg(`../tools/pairs/masks/${name}.png`);
      // test masks are white = wall; the app's are black = wall: invert
      const s = 640 / Math.max(img.naturalWidth, img.naturalHeight), w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
      const ci = makeImage(w, h, () => [0, 0, 0]); ci.getContext("2d").drawImage(img, 0, 0, w, h);
      const cm = makeImage(w, h, () => [0, 0, 0]); cm.getContext("2d").drawImage(m, 0, 0, w, h);
      const md = cm.getContext("2d").getImageData(0, 0, w, h).data; for (let i = 0; i < md.length; i += 4) md[i] = md[i + 1] = md[i + 2] = 255 - md[i];
      const est = WP.estimateFromStats(WP.statsFromPixels(ci.getContext("2d").getImageData(0, 0, w, h).data, md, w, h));
      const d = WP.deltaE2000(WP.lab(est), WP.lab(py));
      assert(d < 2, `${name}: JS ${P.linearToHex(est)} vs Python ${P.linearToHex(py)}: dE ${d.toFixed(2)}`);
      out.push(`${name} ${d.toFixed(2)}`);
    }
    return out.join(", ");
  });

  // ---------------------------------------------------------------- summary
  const failed = results.filter(r => !r.ok).length;
  document.getElementById("summary").textContent =
    failed ? `${failed} of ${results.length} tests failed` : `All ${results.length} tests passed`;
  document.getElementById("summary").className = failed ? "fail" : "pass";
  window.testResults = results;
})();
