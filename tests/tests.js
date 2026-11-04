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
 *   sheen js/sheenModel.js's camera solver; glsl/sheen.glsl: Flat = the
 *         swatch, glossier = deeper off-highlight, untinted highlights
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
  // Sheen tests (js/sheenModel.js, glsl/sheen.glsl; sheenSceneRenderer.html)
  // ======================================================================

  const SM = window.SheenModel;
  await test("unit: solveRoom recovers a known camera and room from its lines", () => {
    // A camera with f = 1.9 image widths and 0.4 deg roll, looking into a
    // corner: the back wall's horizontal lines run at -35 deg, the side
    // wall's at +55 deg; the corner at depth 1; the floor 0.3 below the eye.
    const roll = 0.4 * Math.PI / 180, f = 1.9, c = [0.5, 0.42];
    const truth = { c, f, rot: [Math.cos(roll), Math.sin(roll)] };
    const a = -35 * Math.PI / 180, b = a + Math.PI / 2;
    const dB = [Math.sin(a), 0, Math.cos(a)], dS = [Math.sin(b), 0, Math.cos(b)];
    const C0 = [0.05, 0, 1];
    const at = (d, s, y) => [C0[0] + d[0] * s, y, C0[2] + d[2] * s];
    const seg = (d, s1, s2, y) => [...SM.project(truth, at(d, s1, y)), ...SM.project(truth, at(d, s2, y))];
    // The back wall runs from the corner toward the camera's right (-dB),
    // the side wall toward its left (-dS).
    const cornerU = SM.project(truth, C0)[0];
    const g = {
      lines: { a: [seg(dB, -0.3, -0.05, 0.2), seg(dB, -0.35, -0.05, -0.05)],
               b: [seg(dS, -0.25, -0.05, -0.08), seg(dS, -0.3, -0.05, -0.12), seg(dS, -0.2, -0.05, -0.2)] },
      verticals: [[...SM.project(truth, at(dB, -0.2, -0.2)), ...SM.project(truth, at(dB, -0.2, 0.2))]],
      walls: [{ id: "back", dir: "a", through: { u: cornerU } },
              { id: "side", dir: "b", corner: { wall: "back", u: cornerU } }],
      floor: { at: { wall: "back", uv: SM.project(truth, at(dB, -0.25, -0.3)) } }
    };
    const room = SM.solveRoom(g);
    near(room.f, f, 0.019, "focal length (1 %)");
    near(room.report.rollDeg, 0.4, 0.02, "roll (deg)");
    near(room.report.cameraHeight, 0.3, 0.003, "camera height");
    const plane = id => room.planes.find(p => p.id === id).p;
    near(plane("back").slice(0, 3), [-dS[0], 0, -dS[2]], 0.01, "back-wall normal (faces the camera)");
    near(plane("side").slice(0, 3), [-dB[0], 0, -dB[2]], 0.01, "side-wall normal");
    near(plane("back")[3], -(dS[0] * C0[0] + dS[2] * C0[2]), 0.01, "back wall through the corner");
    // The visible wall changes at the corner.
    const v = SM.project(truth, [C0[0], -0.1, 1])[1];
    assert(SM.wallAt(room, [cornerU + 0.05, v]) === "back", "right of the corner: back wall");
    assert(SM.wallAt(room, [cornerU - 0.05, v]) === "side", "left of the corner: side wall");
    return `f ${room.f.toFixed(4)} (1.9), roll ${room.report.rollDeg.toFixed(3)}°, camera height ${room.report.cameraHeight.toFixed(4)}`;
  });
  await test("unit: pointOffWall puts a lamp on its pixel's ray, offset from the wall", () => {
    const room = { c: [0.5, 0.5], f: 1, rot: [1, 0], planes: [{ id: "back", kind: "wall", p: [0, 0, -1, -2] }] };
    const uv = [0.7, 0.4], X = SM.pointOffWall(room, uv, "back", 0.3);
    near(X[2], 1.7, 1e-9, "depth: 0.3 in front of the wall at z = 2");
    near(SM.project(room, X), uv, 1e-9, "still seen at its pixel");
    return `lamp at ${fmt(X)}`;
  });
  await test("unit: placeWindows builds a window from its edge in the photo and its width", () => {
    // A side wall x = 1 (normal -x, facing the camera at the origin); the
    // window's far edge seen at u = 0.9 from v 0.3 to 0.6, 0.4 wide toward the camera.
    const room = { c: [0.5, 0.5], f: 1, rot: [1, 0], planes: [{ id: "side", kind: "wall", p: [-1, 0, 0, -1] }] };
    const [w] = SM.placeWindows(room, [{ wall: "side", edge: [0.9, 0.3, 0.6], width: 0.4, toward: "camera", radiance: 5 }]);
    near(w.O[0], 1, 1e-9, "on the wall");
    near(SM.project(room, w.O), [0.9, 0.6], 1e-9, "bottom corner at its pixel");
    near(SM.project(room, w.O.map((v, i) => v + w.V[i])), [0.9, 0.3], 1e-9, "top corner at its pixel");
    near(w.U, [0, 0, -0.4], 1e-9, "extends toward the camera");
    const [s] = SM.placeWindows(room, [{ wall: "side", edge: [0.9, 0.3, 0.6], start: 0.1, width: 0.2, toward: "camera", radiance: [1, 2, 3] }]);
    near(s.O[2], w.O[2] - 0.1, 1e-9, "start offset");
    near(s.L, [1, 2, 3], 0, "radiance");
    return `O ${fmt(w.O)}, U ${fmt(w.U)}, V ${fmt(w.V)}`;
  });
  await test("unit: the texture gate keeps real texture and drops JPEG blocking", () => {
    // 64 x 64 mid grey, (a) with 8 x 8 blocks of different levels only
    // (compression blocking: no detail inside blocks), (b) with per-pixel
    // texture of +-4 levels (a stippled wall).
    const w = 64, rgba = fn => { const d = new Uint8ClampedArray(w * w * 4);
      for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) { const v = fn(x, y), i = 4 * (y * w + x); d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
      return d; };
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const blocks = SM.textureDetail(rgba((x, y) => 120 + ((((x >> 3) * 7 + (y >> 3) * 3) % 5) - 2) * 2), null, w, w);
    const stipple = SM.textureDetail(rgba(() => 120 + Math.round((rand() - 0.5) * 8)), null, w, w);
    assert(blocks.gain === 0, `blocking kept: gain ${blocks.gain}`);
    assert(stipple.gain === 1, `texture dropped: gain ${stipple.gain} (in-block ${stipple.inBlock.toFixed(2)})`);
    return `blocks: in-block ${blocks.inBlock.toFixed(2)} levels/px, gain 0; stipple: ${stipple.inBlock.toFixed(2)}, gain 1`;
  });
  // ---- calibration helpers (js/sheenCalib.js, sheenCalibrate.html) ----
  const SC = window.SheenCalib;
  /** Luma of a canvas drawn by fn(ctx), n x n. */
  const drawnGray = (n, fn) => {
    const c = document.createElement("canvas"); c.width = c.height = n;
    const x = c.getContext("2d"); fn(x);
    return SC.gray(x.getImageData(0, 0, n, n).data, n, n);
  };
  /** Distance (px) of point (x, y) from the infinite line through a and b. */
  const offLine = ([ax, ay], [bx, by], x, y) => Math.abs((x - ax) * (by - ay) - (y - ay) * (bx - ax)) / Math.hypot(bx - ax, by - ay);
  await test("unit: the line detector finds a polygon's edges to sub-pixel accuracy", () => {
    // A dark quadrilateral on a light ground (anti-aliased by the canvas).
    const n = 400, P = [[61.3, 72.8], [331.7, 95.2], [312.4, 318.9], [83.6, 290.1]];
    const g = drawnGray(n, x => { x.fillStyle = "#c8c8c8"; x.fillRect(0, 0, n, n); x.fillStyle = "#3c3c3c";
      x.beginPath(); P.forEach((p, i) => i ? x.lineTo(...p) : x.moveTo(...p)); x.closePath(); x.fill(); });
    const segs = SC.detectSegments(g, n, n);
    const worst = P.map((a, i) => {
      const b = P[(i + 1) % 4], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const m = segs.filter(s => s.len > 0.7 * L).map(s => Math.max(offLine(a, b, s.x1, s.y1), offLine(a, b, s.x2, s.y2))).sort((x, y) => x - y)[0];
      assert(m !== undefined && m < 0.5, `edge ${i + 1}: nearest long segment ${m === undefined ? "missing" : m.toFixed(2) + " px off"}`);
      return m;
    });
    return `${segs.length} segments; each edge within ${fmt(worst)} px`;
  });
  await test("unit: snapping moves a roughly drawn line onto the edge (RANSAC through texture)", () => {
    // An edge at 3 deg with noise-like texture on both sides; the drawn line
    // is 5 px and 0.8 deg off.
    const n = 300; let seed = 11;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const A = [20, 100], B = [280, 100 + 260 * Math.tan(3 * Math.PI / 180)];
    const g = drawnGray(n, x => {
      x.fillStyle = "#b4b4b4"; x.fillRect(0, 0, n, n);
      x.fillStyle = "#8c8c8c"; x.beginPath(); x.moveTo(0, A[1] - A[0] * Math.tan(3 * Math.PI / 180)); x.lineTo(n, A[1] + (n - A[0]) * Math.tan(3 * Math.PI / 180)); x.lineTo(n, n); x.lineTo(0, n); x.fill();
      for (let i = 0; i < 3000; i++) { x.fillStyle = `rgba(0,0,0,${0.08 * rand()})`; x.fillRect(rand() * n, rand() * n, 1 + 2 * rand(), 1 + 2 * rand()); }
    });
    const drawn = [A[0], A[1] - 5, B[0], B[1] - 5 + 260 * Math.tan(0.8 * Math.PI / 180)].map(v => v / n);
    const r = SC.snapLine(g, n, n, drawn);
    assert(r, "no edge found");
    const s = r.seg.map(v => v * n), e = [offLine(A, B, s[0], s[1]), offLine(A, B, s[2], s[3])];
    assert(Math.max(...e) < 0.4, `snapped ${fmt(e)} px off the edge`);
    return `endpoints ${fmt(e)} px off the edge, ${r.points} of 40 points, RMS ${r.rms.toFixed(2)} px`;
  });
  await test("unit: classifyLines + solveRoom recover a known camera from a cluttered line set", () => {
    // The solveRoom test's camera; lines on two walls and verticals, all
    // with 0.25 px noise (at 2000 px), plus 25 random clutter segments.
    const roll = 0.4 * Math.PI / 180, f = 1.9, truth = { c: [0.5, 0.42], f, rot: [Math.cos(roll), Math.sin(roll)] };
    const a = -35 * Math.PI / 180, b = a + Math.PI / 2, dB = [Math.sin(a), 0, Math.cos(a)], dS = [Math.sin(b), 0, Math.cos(b)], C0 = [0.05, 0, 1];
    let seed = 5; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647, nz = () => (rand() - 0.5) * 0.5 / 2000 * 1.7;
    const at = (d, s, y) => [C0[0] + d[0] * s, y, C0[2] + d[2] * s];
    const seg = (P, Q) => [...SM.project(truth, P), ...SM.project(truth, Q)].map(v => v + nz());
    const lines = [];
    for (const y of [-0.28, -0.2, -0.05, 0.05, 0.12, 0.2]) lines.push(seg(at(dB, -0.35, y), at(dB, -0.05, y)));
    for (const y of [-0.25, -0.12, 0.08, 0.18]) lines.push(seg(at(dS, -0.3, y), at(dS, -0.05, y)));
    for (const s of [-0.3, -0.15, 0]) lines.push(seg(at(dB, s, -0.25), at(dB, s, 0.2)));
    for (let i = 0; i < 25; i++) { const u = rand(), v = rand(), t = rand() * Math.PI, l = 0.03 + 0.08 * rand(); lines.push([u, v, u + l * Math.cos(t), v + l * Math.sin(t)]); }
    const c = SC.classifyLines(lines);
    const room = SM.solveRoom({ lines: { a: c.a, b: c.b }, verticals: c.verticals, walls: [{ id: "w", dir: "a", through: { u: 0.5 } }], floor: { at: { wall: "w", uv: [0.5, 0.9] } } });
    near(room.f, f, 0.02 * f, "focal length (2 %)");
    near(room.report.rollDeg, 0.4, 0.05, "roll (deg)");
    return `f ${room.f.toFixed(3)} (1.9), roll ${room.report.rollDeg.toFixed(3)}°; ${c.a.length} a, ${c.b.length} b, ${c.verticals.length} vertical of ${lines.length}`;
  });
  await test("unit: light detection: day windows are dark at night; bulbs and shades by night", () => {
    // 100 x 100: a window (bright by day, dark at night), a white sofa
    // (bright both), a bulb and a partly clipped shade at night. Mask: all
    // non-wall except a wall band.
    const n = 100, img = fn => { const d = new Uint8ClampedArray(n * n * 4);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const v = fn(x, y), i = 4 * (y * n + x); d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; } return d; };
    const inR = (x, y, r) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];
    const win = [10, 10, 30, 40], sofa = [50, 60, 90, 75], bulb = [70, 20, 73, 23], shade = [40, 15, 52, 30], core = [44, 25, 48, 30];
    const day = img((x, y) => inR(x, y, win) || inR(x, y, sofa) ? 255 : 120);
    const night = img((x, y) => inR(x, y, bulb) || inR(x, y, core) ? 255 : inR(x, y, shade) ? 190 : inR(x, y, sofa) ? 110 : inR(x, y, win) ? 8 : 40);
    const mask = img((x, y) => y > 85 ? 0 : 255);
    const d = SC.detectLights(day, mask, n, n, "day", { night });
    assert(d.length === 1 && d[0].type === "window", `day: ${d.map(e => e.type + " " + fmt(e.rect)).join("; ")}`);
    assert(d[0].rect[0] <= 0.1 && d[0].rect[2] >= 0.3, `window rect ${fmt(d[0].rect)}`);
    const nl = SC.detectLights(night, mask, n, n, "night");
    const types = nl.map(e => e.type).sort().join(",");
    assert(types === "bulb,shade", `night: ${nl.map(e => e.type + " " + fmt(e.rect)).join("; ")}`);
    return `day: window ${fmt(d[0].rect)}; night: ${nl.map(e => e.type).join(", ")}`;
  });
  await test("unit: automatic walls: the corner between two line families, on the right sides", () => {
    // An inside corner at u = 0.6: lines running to the left vanishing point
    // (direction a here) lie right of it, lines to the right one left of it.
    const roll = 0, f = 1.5, truth = { c: [0.5, 0.45], f, rot: [1, 0] };
    const ang = -40 * Math.PI / 180, dA = [Math.sin(ang), 0, Math.cos(ang)], dB = [Math.sin(ang + Math.PI / 2), 0, Math.cos(ang + Math.PI / 2)];
    const C0 = SM.cameraRay(truth, [0.6, 0.45]).map(v => v / SM.cameraRay(truth, [0.6, 0.45])[2]);
    const at = (d, s, y) => [C0[0] + d[0] * s, y, C0[2] + d[2] * s];
    const seg = (P, Q) => [...SM.project(truth, P), ...SM.project(truth, Q)];
    // Back wall (direction a) extends from the corner toward -dA, the side wall toward -dB.
    const a = [-0.2, 0.1, 0.25].map(y => seg(at(dA, -0.5, y), at(dA, -0.05, y)));
    const b = [-0.15, 0.15].map(y => seg(at(dB, -0.4, y), at(dB, -0.05, y)));
    const vpA = SM.intersectLines(a), vpB = SM.intersectLines(b);
    const { walls, corner } = SC.guessWalls({ a, b, vpA, vpB }, new Set([...a, ...b]));
    near(corner, 0.6, 0.03, "corner column");
    const right = vpA[0] > 0.5 ? "b" : "a";      // the family whose lines run left is the right-hand wall
    assert(walls[0].dir === right && walls[1].dir !== right, `walls ${JSON.stringify(walls)}`);
    const room = SM.solveRoom({ lines: { a, b }, verticals: [[0.3, 0.2, 0.3, 0.8]], walls, floor: { at: { wall: walls[0].id, uv: [0.8, 0.9] } } });
    const P = [0.8, 0.3], Q = [0.3, 0.3], onA = SM.wallAt(room, P), onB = SM.wallAt(room, Q);
    assert(onA !== onB, "both sides of the corner show the same wall");
    return `corner ${corner.toFixed(3)} (0.6); right of it: ${onA} along ${walls.find(w => w.id === onA).dir}`;
  });
  await test("unit: automatic floor point and the default room", () => {
    // Mask 100 x 100: wall above a sofa-shaped bump; the wall reaches down
    // to v = 0.8 at the sides.
    const n = 100, d = new Uint8ClampedArray(n * n * 4);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const wall = y < 80 && !(x > 30 && x < 80 && y > 50), i = 4 * (y * n + x);
      d[i] = d[i + 1] = d[i + 2] = wall ? 0 : 255; d[i + 3] = 255;
    }
    const p = SC.guessFloorPoint(d, n);
    near(p[1], 0.8, 0.011, "floor point v");
    const room = SC.defaultRoom();
    near(room.report.hfovDeg, 60, 1e-9, "default field of view");
    assert(SM.wallAt(room, [0.3, 0.4]) === "wall1", "default wall");
    const job = SM.sheenJob("satin", room, { emitters: [], keyLight: [0, 0, 0] });
    assert(job.uniforms.roomPlaneCount === 2, "default room planes");
    return `floor point ${fmt(p)}; default room: 1 wall + floor, 60°`;
  });
  await test("unit: EXIF focal length (35 mm equivalent) and the square's focal length", async () => {
    // A minimal JPEG: SOI, APP1 "Exif" with IFD0 -> Exif IFD -> FocalLengthIn35mmFilm = 26, EOI.
    const tiff = new DataView(new ArrayBuffer(44));
    tiff.setUint16(0, 0x4949); tiff.setUint16(2, 42, true); tiff.setUint32(4, 8, true);
    tiff.setUint16(8, 1, true); tiff.setUint16(10, 0x8769, true); tiff.setUint16(12, 4, true); tiff.setUint32(14, 1, true); tiff.setUint32(18, 26, true); tiff.setUint32(22, 0, true);
    tiff.setUint16(26, 1, true); tiff.setUint16(28, 0xA405, true); tiff.setUint16(30, 3, true); tiff.setUint32(32, 1, true); tiff.setUint16(36, 26, true); tiff.setUint32(40, 0, true);
    const head = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, 0, 52, 0x45, 0x78, 0x69, 0x66, 0, 0]);
    const f35 = await SC.exifFocal35(new Blob([head, tiff.buffer, new Uint8Array([0xFF, 0xD9])]));
    assert(f35 === 26, `read ${f35}`);
    assert(await SC.exifFocal35(new Blob([new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9])])) === null, "no EXIF: null");
    near(SC.focalForSquare(26, 4032, 3024), 26 / 36 * 4032 / 3024, 1e-12, "square focal (landscape)");
    return `26 mm read; a 4032 x 3024 photo's centre square: f = ${SC.focalForSquare(26, 4032, 3024).toFixed(3)} widths`;
  });
  await test("unit: solveRoom with a known focal length needs only one line family", () => {
    const roll = 0.4 * Math.PI / 180, f = 1.9, truth = { c: [0.5, 0.42], f, rot: [Math.cos(roll), Math.sin(roll)] };
    const a = -35 * Math.PI / 180, b = a + Math.PI / 2, dB = [Math.sin(a), 0, Math.cos(a)], dS = [Math.sin(b), 0, Math.cos(b)], C0 = [0.05, 0, 1];
    const at = (d, s, y) => [C0[0] + d[0] * s, y, C0[2] + d[2] * s];
    const seg = (d, s1, s2, y) => [...SM.project(truth, at(d, s1, y)), ...SM.project(truth, at(d, s2, y))];
    const cornerU = SM.project(truth, C0)[0];
    const room = SM.solveRoom({ lines: { a: [seg(dB, -0.3, -0.05, 0.2), seg(dB, -0.35, -0.05, -0.05)], b: [] }, focal: f,
      verticals: [[...SM.project(truth, at(dB, -0.2, -0.2)), ...SM.project(truth, at(dB, -0.2, 0.2))]],
      walls: [{ id: "back", dir: "a", through: { u: cornerU } }, { id: "side", dir: "b", corner: { wall: "back", u: cornerU } }],
      floor: { at: { wall: "back", uv: SM.project(truth, at(dB, -0.25, -0.3)) } } });
    near(room.f, f, 1e-9, "focal length");
    near(room.planes.find(p => p.id === "side").p.slice(0, 3), [-dB[0], 0, -dB[2]], 0.01, "side-wall normal from a's VP and f");
    near(room.report.cameraHeight, 0.3, 0.003, "camera height");
    return `side wall and floor recovered from direction a alone + f`;
  });
  await test("unit: a room config converts to the calibration page's form and solves the same", () => {
    const P = 1 / 2000, px = l => l.map(v => v * P);
    const cfg = { label: "T", geometry: { lines: { a: [px([1060, 90.5, 1285, 36.8]), px([1060, 594.2, 1290, 581.9])], b: [px([360, 881.2, 680, 877.0]), px([360, 946.1, 720, 937.9])] },
                    verticals: [px([870, 120, 870, 920])], walls: [{ id: "back", dir: "a", through: { u: 0.436 } }, { id: "window", dir: "b", corner: { wall: "back", u: 0.436 } }],
                    floor: { at: { wall: "back", uv: px([1900, 1655]) } } },
                  lights: { day: { keyLight: { uv: [0.1, 0.2], wall: "window", offset: 0 }, emitters: [{ rect: [0, 0, 0.07, 0.41], threshold: 0, gain: 7, note: "left pane" }] },
                            night: { keyLight: { uv: [0.4, 0.26], wall: "window", offset: 0.025 }, emitters: [{ rect: [0.35, 0.03, 0.46, 0.5], threshold: 0.85, gain: 1, note: "bulbs (a lamp below)" }],
                                     lamps: [{ uv: [0.415, 0.095], wall: "window", offset: 0.025, radius: 0.004, core: { rect: [0.35, 0.03, 0.46, 0.5], threshold: 0.85, gain: 12 } }] } } };
    const room = SM.solveRoom(cfg.geometry), st = SC.calibStateFromConfig(cfg, room);
    assert(st.lines.length === 5 && st.walls.length === 2 && st.walls[1].joins === "back", "lines and walls");
    const n = st.lights.night;
    assert(n.lamps.length === 1 && n.lamps[0].emitter === 0 && n.emitters[0].gain === 12, `night: ${JSON.stringify(n)}`);
    assert(st.lights.day.emitters[0].type === "window", "day pane is a window");
    const mpu = SC.CAMERA_HEIGHT_M / room.report.cameraHeight;
    near(n.lamps[0].offsetCm / 100 / mpu, 0.025, 0.01 / mpu, "lamp offset round trip (1 cm)");
    return `5 lines, 2 walls; lamp ${n.lamps[0].offsetCm} cm off its wall, ${n.lamps[0].sizeCm} cm across`;
  });
  await test("unit: specular albedo = exact Fresnel + Smith (tests/sheen_check.py reference)", () => {
    // Reference values from tests/sheen_check.py (same quadrature): GGX α
    // 0.025 and 0.075 at cos θ = 1, 0.6, 0.4.
    const ref = [0.04, 0.06489, 0.13201, 0.04008, 0.06485, 0.1256];
    const got = [0.025, 0.075].flatMap(a => [1, 0.6, 0.4].map(n => SM.specularAlbedo(a, n)));
    near(got, ref, 2e-5, "albedo");
    // A smooth lobe approaches the exact Fresnel reflectance of n = 1.5 (0.0892 at 60°).
    return near(SM.specularAlbedo(0.025, 0.5), SM.fresnel(0.5), 0.003, "semi-gloss at 60° vs Fresnel");
  });
  await test("unit: every sheen's parameters are documented and ordered", () => {
    let prev = Infinity;
    for (const k of SM.SHEEN_ORDER) {
      const s = SM.SHEENS[k];
      assert(SM.SHEEN_COPY[k] && SM.SHEEN_COPY[k].look, `${k}: no copy`);
      assert(s.alpha < prev, `${k}: alpha should fall with gloss`);
      prev = s.alpha;
    }
    return SM.SHEEN_ORDER.map(k => `${k} α ${SM.SHEENS[k].alpha} v ${SM.SHEENS[k].v}`).join(", ");
  });

  // GPU: a simple camera whose mirror rays all leave the photo, so every
  // wall pixel reflects the "unseen room" (its own colour and the scene's
  // mean): a room painted one colour, as off-highlight walls usually see.
  let sheenSources;
  const plainCam = { c: [0.5, 0.5], f: 1, rot: [1, 0], planes: [
    { id: "back", kind: "wall", p: [0, 0, -1, -1] }, { id: "side", kind: "wall", p: [1, 0, 0, -10] },
    { id: "floor", kind: "floor", p: [0, 1, 0, -10] }] };
  await test("gpu: the sheen shaders load and compile", async () => {
    sheenSources = await P.loadShaders("../glsl/shaderSceneRender.glsl", { sheenUrl: "../glsl/sheen.glsl" });
    makeSheenPipeline();
    return "RENDER with SHEEN + ENVDOWN";
  });
  function makeSheenPipeline() {
    return new P.LightPipeline(document.createElement("canvas"), {
      analysis: [64, 64], render: [64, 64], sources: sheenSources, sheen: true, preserveDrawingBuffer: true,
      hooks: { onRestored() {}, onError(e) { throw e; } }
    });
  }
  /** Renders `image` in v3 with a sheen and returns the centre pixel's linear RGB. */
  async function runSheen(image, hex, sheen, { mask = null, emitters = [], lamps = [], windows = [], block = [24, 16, 40, 24] } = {}) {
    const pipe = makeSheenPipeline();
    const src = pipe.createSource(64, 64, { srgb: true });
    const maskImg = mask || makeImage(4, 4, () => [0, 0, 0]);
    pipe.upload(src, await SM.photoWithDetail(image, maskImg));   // as the page uploads it (texture map in alpha)
    const m = pipe.createSource(...P.sizeOf(maskImg), { mipmaps: true });
    pipe.upload(m, maskImg);
    const stats = new P.LightStats(32, 32); stats.add(image, maskImg);
    const lightMap = pipe.createLightMap();
    pipe.analyse({ src, mask: m, lightMap, model: "v3", adjust: null, refY: stats.refY });
    pipe.render({ lightMap, src, model: "v3", paint: P.paintSpec(hex), scene: P.sceneSpec(stats, stats), detailGamma: 1,
                  sheen: { mask: m, ...SM.sheenJob(sheen, plainCam, { emitters, keyLight: [0, 0, 0], lamps, windows }) } });
    // Mean of a 16 x 8 block in linear light: one 8-bit pixel carries +-1
    // level of dither, as large as the step between neighbouring sheens on
    // mid-tone paints.
    const [x0, y0, x1, y1] = block, n = (x1 - x0) * (y1 - y0), sum = [0, 0, 0];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++)
      readPixel(pipe, x, y).forEach((v, i) => { sum[i] += P.decodeSrgb(v / 255) / n; });
    return sum;
  }
  const labOf = rgb => {
    const X = P.mat.apply(P.RGB2XYZ, rgb).map((v, i) => v / [0.95047, 1, 1.08883][i]);
    const f = X.map(t => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    return [116 * f[1] - 16, Math.hypot(500 * (f[0] - f[1]), 200 * (f[1] - f[2]))];   // L*, C*
  };
  await test("gpu: Flat shows the same wall as v3 without sheen (the swatch)", async () => {
    const out = [];
    for (const hex of ["#a4aca6", "#2f3d4c", "#e8decd"]) {
      const flat = encoded(await runSheen(white, hex, "flat"));
      const v3 = readPixel(run(makePipeline(64, 64), white, { model: "v3", hex }).pipe, 32, 20);
      near(flat, v3, 1, hex);
      out.push(hex);
    }
    return out.join(" ") + ": within 1 level";
  });
  await test("gpu: glossier = deeper off-highlight, most for dark colours (veil removed)", async () => {
    const rows = [];
    for (const [hex, minDrop] of [["#2f3d4c", 2], ["#607d84", 1]]) {
      const L = []; for (const k of SM.SHEEN_ORDER) L.push(labOf(await runSheen(white, hex, k)));
      for (let i = 1; i < L.length; i++) {
        assert(L[i][0] < L[i - 1][0] + 0.05, `${hex}: ${SM.SHEEN_ORDER[i]} not darker than ${SM.SHEEN_ORDER[i - 1]}`);
        assert(L[i][1] > L[i - 1][1] - 0.05, `${hex}: ${SM.SHEEN_ORDER[i]} not more saturated`);
      }
      assert(L[0][0] - L[3][0] >= minDrop, `${hex}: semi-gloss only ${(L[0][0] - L[3][0]).toFixed(2)} L* darker`);
      rows.push(`${hex} L* ${L.map(l => l[0].toFixed(1)).join(" → ")}, C* ${L[0][1].toFixed(1)} → ${L[3][1].toFixed(1)}`);
    }
    const w = []; for (const k of SM.SHEEN_ORDER) w.push(labOf(await runSheen(white, "#e8decd", k)));
    assert(Math.abs(w[0][0] - w[3][0]) < 1.5, `off-white changed by ${(w[0][0] - w[3][0]).toFixed(2)} L*`);
    rows.push(`#e8decd L* ${w[0][0].toFixed(1)} → ${w[3][0].toFixed(1)}`);
    return rows.join("; ");
  });
  await test("gpu: reflections of a light source add the light's colour, not the paint's", async () => {
    // Top half wall, bottom half a bright light source (emitter x 20): the
    // unseen room is then brighter than the wall's own light, like a highlight.
    const mask = makeImage(64, 64, (x, y) => y < 32 ? [0, 0, 0] : [255, 255, 255]);
    const emitters = [{ rect: [0, 0.5, 1, 1], threshold: 0, gain: 20 }];
    const hex = "#7a1f2b";
    const flat = await runSheen(white, hex, "flat", { mask, emitters });
    const semi = await runSheen(white, hex, "semigloss", { mask, emitters });
    const add = semi.map((v, i) => v - flat[i]);
    assert(add.every(v => v > 0), `semi-gloss not brighter: ${fmt(add)}`);
    const spread = (Math.max(...add) - Math.min(...add)) / Math.max(...add);
    assert(spread < 0.15, `added light is tinted: ${fmt(add)}`);
    const [Lf, Cf] = labOf(flat), [Ls, Cs] = labOf(semi);
    return `added ${fmt(add)} (neutral within ${(spread * 100).toFixed(0)} %); L* ${Lf.toFixed(1)} → ${Ls.toFixed(1)}, C* ${Cf.toFixed(1)} → ${Cs.toFixed(1)}`;
  });

  await test("gpu: a lamp in front of the wall: a neutral highlight that narrows with gloss", async () => {
    // A neutral lamp on the optical axis, halfway to the wall (z = 0.5 of 1):
    // its mirror image is seen at the image centre. Added light = with the
    // lamp - without, at the centre (4 x 4 block) and well away from it.
    const lamps = [{ pos: [0, 0, 0.5], radius: 0.05, I: [0.5, 0.5, 0.5], axis: [0, -1, 0], cone: -1 }];
    const hex = "#7a1f2b", centre = [30, 30, 34, 34], away = [30, 4, 34, 8], rows = [], peaks = [];
    for (const k of SM.SHEEN_ORDER) {
      const at = async (block, withLamp) => await runSheen(white, hex, k, { block, lamps: withLamp ? lamps : [] });
      const add = await at(centre, true), base = await at(centre, false), farL = await at(away, true), farN = await at(away, false);
      const peak = add.map((v, i) => v - base[i]), tail = farL.map((v, i) => v - farN[i]);
      peaks.push(P.luminance(peak));
      if (k === "semigloss") {
        const spread = (Math.max(...peak) - Math.min(...peak)) / Math.max(...peak);
        assert(spread < 0.15, `semi-gloss highlight tinted: ${fmt(peak)}`);
        assert(P.luminance(tail) < 0.1 * P.luminance(peak), `semi-gloss highlight not concentrated: ${fmt(tail)} vs ${fmt(peak)}`);
      }
      rows.push(`${k} +${P.luminance(peak).toFixed(3)}`);
    }
    for (let i = 1; i < peaks.length; i++)
      assert(peaks[i] > peaks[i - 1], `${SM.SHEEN_ORDER[i]} peak not above ${SM.SHEEN_ORDER[i - 1]}'s`);
    assert(peaks[0] < 0.01, `flat shows a highlight: ${peaks[0]}`);
    return "peak added luminance " + rows.join(", ");
  });

  await test("gpu: a window outside the photo is reflected, in its own colour, more with gloss", async () => {
    // Behind the camera (z = -0.5, facing the wall), where the centre's
    // mirror rays go: no plane and no photo there, so without the window they
    // see the unseen room. Added light = with the window - without.
    const windows = [{ O: [-0.6, -0.6, -0.5], U: [1.2, 0, 0], V: [0, 1.4, 0], L: [6, 6, 6] }];
    const hex = "#2f3d4c", adds = [];
    for (const k of SM.SHEEN_ORDER) {
      const withW = await runSheen(white, hex, k, { windows }), without = await runSheen(white, hex, k);
      adds.push(withW.map((v, i) => v - without[i]));
    }
    const lum = adds.map(a => P.luminance(a));
    const semi = adds[3], spread = (Math.max(...semi) - Math.min(...semi)) / Math.max(...semi);
    assert(spread < 0.15, `semi-gloss window reflection tinted: ${fmt(semi)}`);
    for (let i = 2; i < lum.length; i++)
      assert(lum[i] > lum[i - 1], `${SM.SHEEN_ORDER[i]} reflects the window less than ${SM.SHEEN_ORDER[i - 1]}`);
    assert(lum[0] < 0.25 * lum[3], `flat reflects the window: ${lum[0]}`);
    return "added luminance " + SM.SHEEN_ORDER.map((k, i) => `${k} +${lum[i].toFixed(3)}`).join(", ");
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

  // ---------------------------------------------------------------- summary
  const failed = results.filter(r => !r.ok).length;
  document.getElementById("summary").textContent =
    failed ? `${failed} of ${results.length} tests failed` : `All ${results.length} tests passed`;
  document.getElementById("summary").className = failed ? "fail" : "pass";
  window.testResults = results;
})();
