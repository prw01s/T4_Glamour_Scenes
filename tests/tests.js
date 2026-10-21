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

  // ---------------------------------------------------------------- summary
  const failed = results.filter(r => !r.ok).length;
  document.getElementById("summary").textContent =
    failed ? `${failed} of ${results.length} tests failed` : `All ${results.length} tests passed`;
  document.getElementById("summary").className = failed ? "fail" : "pass";
  window.testResults = results;
})();
