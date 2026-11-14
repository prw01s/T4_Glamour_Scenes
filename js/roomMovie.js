/* ==========================================================================
 * roomMovie.js - the room-movie prototype (roomMovie.html).
 *
 * Rebuilds each frame of the room live from light layers rendered in Blender
 * (tools/roomMovie/), so any paint and any lighting state can be shown, and
 * every change animates the physics rather than cross-fading pictures
 * (docs/room-movie-plan.md). Needs js/paintPipeline.js (colour science).
 *
 * State (all animated by springs, so changes can overlap and be redirected):
 *   p        time of day, cyclic: 0 morning, 1 afternoon sunset, 2 night,
 *            3 = morning again. It only moves forward, so the sun sets,
 *            night falls and dawn breaks in order.
 *   lamp     level 0..1 and colour temperature (in mireds)
 *   paint    reflectance spectrum (18 bands), blended spectrally
 *   exposure follows the scene's brightness with a lag, like eyes adjusting
 *
 * Light levels are physical (lux / 683 in Blender's units): direct sun from a
 * clear-sky atmosphere model, sky from typical diffuse illuminance by sun
 * height (twilight included), the lamp at 800 lm, the moon at 0.15 lux.
 * Classic script: defines window.RoomMovie.
 * ======================================================================== */
(function () {
  "use strict";
  const PP = window.PaintPipeline;
  if (!PP) throw new Error("roomMovie: load js/paintPipeline.js first");
  const { mat, XYZ2RGB, RGB2XYZ, CAT16, SRGB_TO_P3, LAMBDAS, CMF, planck, fitReflectance, hexToLinear,
          mccamyCCT, T_REF, supportsWideGamut, normalizeHex, lrv } = PP;
  const NB = LAMBDAS.length;
  const BASE = "images/room_movie/";
  const LUX_PER_UNIT = 683;          // Blender: a white light of 1 W/m2
  const GLASS = 0.85;                // window glass transmittance (light and view)
  const LAMP_LM = 800;               // a 60 W-equivalent lamp
  const MOON_LUX = 0.15;             // a bright full moon
  // Night: the sun 14 deg below the horizon (past nautical twilight). The night
  // sky layer itself was rendered at blue hour (render_info night_sun_el) for
  // its colour and shape; its brightness follows this elevation.
  const NIGHT_EL = -14;
  // A wall in the ambient light shows the paint at this fraction of its swatch
  // (in daylight); the shader's highlight shoulder takes the sun patch above it.
  const EXPOSURE_SCALE = 0.8;
  const SKY_SLICE = { morning: 1, sunset: 2, night: 3 };
  const SUNB_SLICE = { morning: 4, mid: 5, sunset: 6 };
  const LAYER_ORDER = ["lamp", "sky_morning", "sky_sunset", "sky_night", "sunb_morning", "sunb_mid", "sunb_sunset", "sunb_moon", "lampref"];
  const EXT_ORDER = ["morning", "sunset", "night"];
  const LEAF_ORDER = ["morning", "sunset", "moon"];

  // ---------------------------------------------------------------- spectra
  const ySum = S => S.reduce((t, v, k) => t + v * CMF[3 * k + 1], 0);
  const normY = S => { const y = ySum(S); return S.map(v => v / y); };
  const xyzOf = S => [0, 1, 2].map(i => S.reduce((t, v, k) => t + v * CMF[3 * k + i], 0));
  const rgbOf = S => mat.apply(XYZ2RGB, xyzOf(S));
  /** Spectrum x CMF per band (the shader's uW* arrays), Y-normalised. */
  const weightsOf = S => { const n = normY(S), w = new Float32Array(NB * 3); for (let k = 0; k < NB; k++) for (let i = 0; i < 3; i++) w[3 * k + i] = n[k] * CMF[3 * k + i]; return w; };
  const blackbody = T => LAMBDAS.map(l => planck(l, T));
  /** A smooth light spectrum with a given linear-sRGB colour (Jakob-Hanika fit x the reference light). */
  function spectrumForRGB(rgb) {
    const m = Math.max(...rgb) / 0.95, refl = fitReflectance(rgb.map(v => v / m)), ref = blackbody(T_REF);
    return refl.map((r, k) => r * ref[k]);
  }

  /** Kasten & Young (1989) relative air mass for an apparent elevation in degrees. */
  const airMass = el => 1 / (Math.sin(el * Math.PI / 180) + 0.50572 * Math.pow(el + 6.07995, -1.6364));
  const SUN_TOP = blackbody(5778);
  const EXTRA_LUX = 128000;          // illuminance of the sun above the atmosphere
  /**
   * Direct sunlight at a sun elevation: the extraterrestrial spectrum (5778 K)
   * through Rayleigh scattering, aerosol (Angstrom, beta 0.06, alpha 1.3) and
   * ozone (Chappuis band), along the air mass (docs/room-movie-plan.md 4.4).
   * @returns {{ S: number[], lux: number }}
   */
  function sunLight(el) {
    if (el < -0.5) return { S: SUN_TOP, lux: 0 };
    const m = airMass(Math.max(el, -0.5));
    const S = LAMBDAS.map((l, k) => {
      const u = l / 1000;
      const tauR = 0.008569 * Math.pow(u, -4) * (1 + 0.0113 * Math.pow(u, -2) + 0.00013 * Math.pow(u, -4));
      const tauA = 0.06 * Math.pow(u, -1.3);
      const tauO = 0.035 * Math.exp(-(((l - 600) / 60) ** 2));
      return SUN_TOP[k] * Math.exp(-m * (tauR + tauA + tauO));
    });
    const fade = Math.min(1, Math.max(0, (el + 0.5) / 1.0));        // the disc sinking below the horizon
    return { S, lux: EXTRA_LUX * ySum(S) / ySum(SUN_TOP) * fade };
  }
  /** Diffuse sky illuminance (lux) on a horizontal surface by sun elevation (clear sky; civil to nautical twilight below 0). */
  const SKY_LUX = [[-18, 0.0008], [-12, 0.008], [-9, 0.3], [-6, 3.4], [-3, 60], [0, 700], [2, 2000], [5, 4000], [10, 6500], [15, 8300], [20, 9600], [30, 11800], [45, 14000], [60, 15500]];
  function skyLux(el) {
    if (el <= SKY_LUX[0][0]) return SKY_LUX[0][1];
    for (let i = 1; i < SKY_LUX.length; i++) {
      const [e0, v0] = SKY_LUX[i - 1], [e1, v1] = SKY_LUX[i];
      if (el <= e1) { const t = (el - e0) / (e1 - e0); return Math.exp(Math.log(v0) + t * (Math.log(v1) - Math.log(v0))); }
    }
    return SKY_LUX[SKY_LUX.length - 1][1];
  }
  /** Degree of chromatic adaptation by colour temperature (incomplete under warm light; plan 4.6). */
  function adaptationD(T) {
    const pts = [[1e6 / 6500, 0.95], [1e6 / 6000, 0.95], [1e6 / 4000, 0.85], [1e6 / 2700, 0.68], [1e6 / 1800, 0.5], [1e6 / 1500, 0.45]];
    const m = 1e6 / Math.max(T, 1000);
    if (m <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) if (m <= pts[i][0]) { const t = (m - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]); return pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1]); }
    return pts[pts.length - 1][1];
  }

  // ---------------------------------------------------------------- small vector helpers
  const v3 = { add: (a, b) => a.map((v, i) => v + b[i]), sub: (a, b) => a.map((v, i) => v - b[i]), mul: (a, s) => a.map(v => v * s),
               dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], norm: a => { const l = Math.hypot(...a); return a.map(v => v / l); } };
  function slerp(a, b, t) {
    const d = Math.min(1, Math.max(-1, v3.dot(a, b))), th = Math.acos(d);
    if (th < 1e-6) return a.slice();
    const s = Math.sin(th);
    return a.map((v, i) => (Math.sin((1 - t) * th) * v + Math.sin(t * th) * b[i]) / s);
  }
  const dirFromAzEl = (az, el) => { const a = az * Math.PI / 180, e = el * Math.PI / 180; return [Math.cos(e) * Math.cos(a), -Math.cos(e) * Math.sin(a), -Math.sin(e)]; };
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  /** A critically damped spring (no overshoot; redirectable mid-flight). */
  class Spring {
    constructor(v, omega) { this.x = v; this.v = 0; this.target = v; this.omega = omega; }
    step(dt) {
      const w = this.omega, n = Math.max(1, Math.ceil(dt / 0.008)), h = dt / n;
      for (let i = 0; i < n; i++) { this.v += (w * w * (this.target - this.x) - 2 * w * this.v) * h; this.x += this.v * h; }
      return Math.abs(this.target - this.x) > 1e-4 || Math.abs(this.v) > 1e-4;
    }
  }

  // ---------------------------------------------------------------- GL helpers
  function compile(gl, type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  function arrayTexture(gl, w, h, depth, internal, format, type, filter, mips = false) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : filter);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const levels = mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, internal, w, h, depth);
    return t;
  }
  /** A gzipped file, decompressed with the browser's own DecompressionStream. */
  async function fetchGz(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Couldn't load ${url}`);
    return new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  }
  /**
   * A packed float16 file (tools/roomMovie/fit_layers.py pack_half): for each
   * array [h, w, c] in turn, per channel a high-byte plane and a low-byte plane
   * of row-wise differences. Returns the arrays as interleaved float16 codes,
   * one after another (what texImage/texSubImage with HALF_FLOAT take).
   * @param {string} url
   * @param {number[][]} shapes  [[h, w, c], ...]
   */
  async function fetchPacked(url, shapes) {
    const b = await fetchGz(url);
    const out = new Uint16Array(shapes.reduce((t, [h, w, c]) => t + h * w * c, 0));
    let src = 0, dst = 0;
    for (const [h, w, c] of shapes) {
      const n = h * w;
      for (let ch = 0; ch < c; ch++, src += 2 * n) {
        const hi = src, lo = src + n;
        for (let y = 0; y < h; y++) {
          let acc = 0;
          for (let x = 0, i = y * w; x < w; x++, i++) {
            acc = (acc + ((b[hi + i] << 8) | b[lo + i])) & 0xFFFF;
            out[dst + i * c + ch] = acc;
          }
        }
      }
      dst += n * c;
    }
    return out;
  }

  // ---------------------------------------------------------------- the window, for the exposure estimate (no softness)
  function apertureJS(P, s, w) {
    if (s[0] <= 1e-4) return 0;
    const inside = (x, X) => { const H = v3.sub(P, v3.mul(s, (P[0] - x) / s[0])); return H[1] > X[0] && H[1] < X[1] && H[2] > X[2] && H[2] < X[3]; };
    if (!inside(0, [w.y1, w.y2, w.sill, w.head]) || !inside(-w.wall_t, [w.y1, w.y2, w.sill, w.head])) return 0;
    const H = v3.sub(P, v3.mul(s, (P[0] - w.frame_x) / s[0]));
    if (w.mullions.some(([a, b]) => H[1] > a && H[1] < b)) return 0;
    return 1;
  }

  /**
   * Creates the room-movie renderer on a canvas.
   * @param {HTMLCanvasElement} canvas
   * @param {{ paint: string, time?: "morning"|"sunset"|"night", lamp?: number }} initial  lamp: 0 = off, else kelvin
   */
  async function create(canvas, initial) {
    const [scene, manifest, src] = await Promise.all([
      fetch(BASE + "scene.json").then(r => r.json()),
      fetch(BASE + "manifest.json").then(r => r.json()),
      fetch("glsl/roomMovie.glsl").then(r => r.text())
    ]);
    const W = manifest.width, H = manifest.height;
    // The frame is drawn at the size of the high-resolution geometry (the light
    // layers, W x H, are upsampled to it in the shader).
    const HI = manifest.hi || { width: W, height: H };
    canvas.width = HI.width; canvas.height = HI.height;
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 is not available");
    const wide = supportsWideGamut();
    if (wide) gl.drawingBufferColorSpace = "display-p3";
    const vs = src.split("//@@FRAG")[0].replace("//@@VERT", "").trim(), fs = src.split("//@@FRAG")[1].trim();
    const prog = program(gl, vs, fs);
    gl.useProgram(prog);
    const U = new Proxy({}, { get: (c, n) => (n in c ? c[n] : (c[n] = gl.getUniformLocation(prog, n))) });

    // ---- textures
    const texA = arrayTexture(gl, W, H, LAYER_ORDER.length, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
    const texC = arrayTexture(gl, W / 2, H / 2, LAYER_ORDER.length, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
    const texGeo = arrayTexture(gl, W, H, 2, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);   // the upsampling guide: [P, class], [N]
    const crop = manifest.ext_crop;
    // the window view, per time of day: behind the tree (sun, sky), then the foliage's colour (sun, sky)
    const texExt = arrayTexture(gl, crop.w, crop.h, EXT_ORDER.length * 4, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
    const leafSize = 256;
    const texLeaves = arrayTexture(gl, leafSize, leafSize, LEAF_ORDER.length, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR, true);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const files = await Promise.all([
      ...LAYER_ORDER.map(n => fetchPacked(BASE + manifest.layers[n].file, [[H, W, 4], [H / 2, W / 2, 4]])),
      fetchPacked(BASE + manifest.geo, [[H, W, 4], [H, W, 4]]),
      ...EXT_ORDER.map(k => fetchPacked(BASE + manifest.ext[k], Array(4).fill([manifest.ext_crop.h, manifest.ext_crop.w, 4])))
    ]);
    const nA = W * H * 4, nC = (W / 2) * (H / 2) * 4;
    LAYER_ORDER.forEach((n, i) => {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texA);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, W, H, 1, gl.RGBA, gl.HALF_FLOAT, files[i].subarray(0, nA));
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texC);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, W / 2, H / 2, 1, gl.RGBA, gl.HALF_FLOAT, files[i].subarray(nA, nA + nC));
    });
    const geo = files[LAYER_ORDER.length];
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texGeo);
    for (let s = 0; s < 2; s++) gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, s, W, H, 1, gl.RGBA, gl.HALF_FLOAT, geo.subarray(s * nA, (s + 1) * nA));
    const nE = crop.w * crop.h * 4;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texExt);
    EXT_ORDER.forEach((k, i) => {
      const f = files[LAYER_ORDER.length + 1 + i];
      for (let part = 0; part < 4; part++)
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 4 * i + part, crop.w, crop.h, 1, gl.RGBA, gl.HALF_FLOAT, f.subarray(part * nE, (part + 1) * nE));
    });

    // ---- videos: the leaf patterns (morning, sunset, moon) and the tree's
    // coverage of the window view, all from the same wind loop
    const makeVideo = src => {
      const v = document.createElement("video");
      Object.assign(v, { src, muted: true, loop: true, playsInline: true, autoplay: true, preload: "auto" });
      v.setAttribute("playsinline", ""); v.setAttribute("muted", "");
      return v;
    };
    const videos = LEAF_ORDER.map(k => makeVideo(BASE + manifest.leaves[k].video));
    const winCov = manifest.window_cov ? makeVideo(BASE + manifest.window_cov.video) : null;
    if (winCov) videos.push(winCov);
    await Promise.all(videos.map(v => new Promise((res, rej) => { v.addEventListener("loadeddata", res, { once: true }); v.addEventListener("error", () => rej(new Error("Couldn't load " + v.src)), { once: true }); })));
    await Promise.all(videos.map(v => v.play().catch(() => {})));
    /** Keeps every loop on the first one's clock (they are one animation; decoders drift apart). */
    function syncVideos() {
      const m = videos[0], d = m.duration;
      if (!(d > 0) || m.paused) return;
      for (const v of videos.slice(1)) {
        let diff = Math.abs(v.currentTime - m.currentTime) % d;
        diff = Math.min(diff, d - diff);
        if (diff > 0.06) v.currentTime = m.currentTime;
      }
    }
    const texWinCov = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texWinCov);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    const meanCanvas = Object.assign(document.createElement("canvas"), { width: 32, height: 32 }).getContext("2d", { willReadFrequently: true });
    const leafMean = [0.5, 0.5, 0.5];
    function measureLeafMean(i) {
      meanCanvas.drawImage(videos[i], 0, 0, 32, 32);
      const d = meanCanvas.getImageData(8, 8, 16, 16).data;     // the window's footprint, roughly the middle
      let s = 0; for (let j = 0; j < d.length; j += 4) s += d[j];
      leafMean[i] = s / (d.length / 4) / 255;
    }

    // ---- constant uniforms
    // ---- full-size geometry: [N.xyz, distance] (half float) and [albedo, class] (bytes)
    const tex2D = (internal, format, type, data, filter) => {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, HI.width, HI.height, 0, format, type, data);
      return t;
    };
    const [hiGeo, hiGeo8] = await Promise.all([fetchPacked(BASE + HI.geo, [[HI.height, HI.width, 4]]), fetchGz(BASE + HI.geo8)]);
    const texGeoHi = tex2D(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, hiGeo, gl.NEAREST);
    const texGeoHi8 = tex2D(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, hiGeo8, gl.NEAREST);
    const T = [texA, texC, texGeo, texExt, texLeaves];
    ["uA", "uC", "uGeo", "uExt", "uLeaves"].forEach((n, i) => gl.uniform1i(U[n], i));
    gl.uniform1i(U.uGeoHi, 5); gl.uniform1i(U.uGeoHi8, 6); gl.uniform1i(U.uWinCov, 7);
    // the camera (scene.json; its focal length and horizon are in reference-image pixels)
    {
      const c = scene.camera, k = HI.width / scene.image.width;
      gl.uniform3fv(U.uCamPos, c.pos);
      gl.uniform3f(U.uCamFwd, -Math.sin(c.yaw), Math.cos(c.yaw), 0);
      gl.uniform3f(U.uCamRight, Math.cos(c.yaw), Math.sin(c.yaw), 0);
      gl.uniform3f(U.uCamK, c.f_px * k, scene.image.horizon_y * k, HI.width / 2);
    }
    const w = scene.window;
    gl.uniform1f(U.uY1, w.y1); gl.uniform1f(U.uY2, w.y2); gl.uniform1f(U.uSill, w.sill); gl.uniform1f(U.uHead, w.head);
    gl.uniform1f(U.uWallT, w.wall_t); gl.uniform1f(U.uFrameX, w.frame_x); gl.uniform1f(U.uFrameW, w.frame_w);
    const mu = w.mullions.concat([[9, 9], [9, 9]]);
    gl.uniform4f(U.uMull, mu[0][0], mu[0][1], mu[1][0], mu[1][1]);
    gl.uniform4f(U.uLampGeo, scene.lamp.x, scene.lamp.y, scene.cabinet.h, scene.lamp.shade_z);
    gl.uniform3f(U.uCab, scene.cabinet.d, scene.cabinet.len, scene.cabinet.h);
    gl.uniform1f(U.uGlass, GLASS);
    gl.uniform2f(U.uSize, W, H);
    gl.uniform4f(U.uExtRect, crop.x, crop.y, crop.w, crop.h);
    gl.uniformMatrix3fv(U.uXYZ2RGB, false, mat.toGL(XYZ2RGB));
    gl.uniformMatrix3fv(U.uOut, false, mat.toGL(wide ? SRGB_TO_P3 : mat.IDENTITY));
    const leafO = [], leafE1 = [], leafE2 = [], leafS = [];
    LEAF_ORDER.forEach(k => {
      const L = manifest.leaves[k];
      leafO.push(...L.origin, L.size); leafE1.push(...L.e1, 0); leafE2.push(...L.e2, 0); leafS.push(...L.dir, L.leaf_depth);
    });
    gl.uniform4fv(U.uLeafO, leafO); gl.uniform4fv(U.uLeafE1, leafE1); gl.uniform4fv(U.uLeafE2, leafE2); gl.uniform4fv(U.uLeafS, leafS);

    // ---- keyframes
    const keys = scene.sun_keys;
    const D = { morning: keys.morning.dir, mid: keys.mid.dir, sunset: keys.sunset.dir, moon: keys.moon.dir };
    const lum = rgb => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    const EH = Object.fromEntries(Object.entries(manifest.sky_Eh).map(([k, v]) => [k, lum(v)]));
    const skySpec = Object.fromEntries(["morning", "sunset", "night"].map(k => [k, normY(spectrumForRGB(manifest.layers["sky_" + k].wall_mean))]));
    const WM = Object.fromEntries(Object.entries(manifest.layers).map(([k, v]) => [k, v.wall_median_lum]));
    const samples = manifest.wall_samples;
    /** Extent of the walls along the sweep coordinate u = y - x (the paint sweep). */
    const U_RANGE = samples.reduce(([lo, hi], sm) => [Math.min(lo, sm[1] - sm[0]), Math.max(hi, sm[1] - sm[0])], [Infinity, -Infinity]);
    const moonSpec = (() => { const s = sunLight(35).S; return normY(s.map((v, k) => v * Math.pow(LAMBDAS[k] / 560, 0.6))); })();

    /** Everything that follows from the time of day p (see the header). */
    function timeOfDay(pRaw) {
      const p = ((pRaw % 3) + 3) % 3, seg = Math.floor(p), t = p - seg;
      let dir, sky, sunb, leafW, ext, moonOn;
      if (seg === 0) {                                 // morning -> sunset
        dir = t < 0.5 ? slerp(D.morning, D.mid, 2 * t) : slerp(D.mid, D.sunset, 2 * t - 1);
        sky = [["morning", 1 - t], ["sunset", t]];
        sunb = t < 0.5 ? [[SUNB_SLICE.morning, 1 - 2 * t], [SUNB_SLICE.mid, 2 * t]] : [[SUNB_SLICE.mid, 2 - 2 * t], [SUNB_SLICE.sunset, 2 * t - 1]];
        leafW = [1 - smooth(0.2, 0.8, t), smooth(0.2, 0.8, t)];
        ext = [["morning", 1 - t], ["sunset", t]];
        moonOn = 0;
      } else if (seg === 1) {                          // sunset -> night: the sun sinks on along the sunset azimuth
        dir = dirFromAzEl(keys.sunset.az, keys.sunset.el + t * (NIGHT_EL - keys.sunset.el));
        sky = [["sunset", 1 - t], ["night", t]];
        sunb = [[SUNB_SLICE.sunset, 1], [SUNB_SLICE.sunset, 0]];
        leafW = [0, 1];
        ext = [["sunset", 1 - t], ["night", t]];
        moonOn = smooth(0.55, 1, t);
      } else {                                         // night -> morning: dawn on the morning azimuth
        dir = dirFromAzEl(keys.morning.az, NIGHT_EL + t * (keys.morning.el - NIGHT_EL));
        sky = [["night", 1 - t], ["morning", t]];
        sunb = [[SUNB_SLICE.morning, 1], [SUNB_SLICE.morning, 0]];
        leafW = [1, 0];
        ext = [["night", 1 - t], ["morning", t]];
        moonOn = 1 - smooth(0, 0.35, t);
      }
      dir = v3.norm(dir);
      const el = Math.asin(-dir[2]) * 180 / Math.PI;
      const sun = sunLight(el);
      const skyL = skyLux(el) / LUX_PER_UNIT;
      return { el, dir, sunLevel: sun.lux / LUX_PER_UNIT, sunS: normY(sun.S), sky: sky.map(([k, wt]) => [k, wt * skyL / EH[k]]),
               skyS: normY(skySpec[sky[0][0]].map((v, i) => v * sky[0][1] + skySpec[sky[1][0]][i] * sky[1][1])),
               sunb, leafW, ext, moonLevel: moonOn * MOON_LUX / LUX_PER_UNIT };
    }

    // ---- state
    const st = {
      p: new Spring({ morning: 0, sunset: 1, night: 2 }[initial.time || "morning"], 1.6),
      lampLevel: new Spring(initial.lamp ? 1 : 0, 7),
      lampMired: new Spring(1e6 / (initial.lamp || 2700), 6),
      paintMix: new Spring(1, 3.2),
      logExposure: null,
    };
    let paintFrom = paintOf(initial.paint), paintTo = paintFrom;
    function paintOf(hex) { hex = normalizeHex(hex); const rgb = hexToLinear(hex); return { hex, rgb, refl: fitReflectance(rgb) }; }
    function currentPaint() {
      const t = Math.min(1, Math.max(0, st.paintMix.x));
      return { refl: paintFrom.refl.map((v, k) => v + (paintTo.refl[k] - v) * t), rgb: paintFrom.rgb.map((v, k) => v + (paintTo.rgb[k] - v) * t) };
    }

    /** The scene's adapting white and key brightness for the current state. */
    function analyse(td, lampLevel, lampS, leafT) {
      const shares = [];   // [luminance on the walls, normalised spectrum]
      shares.push([lampLevel * WM.lamp, lampS]);
      shares.push([td.sky.reduce((t, [k, s]) => t + s * WM["sky_" + k], 0), td.skyS]);
      const bounce = td.sunLevel * leafT * GLASS * td.sunb.reduce((t, [sl, wt]) => t + wt * WM[LAYER_ORDER[sl]], 0);
      let dsum = 0;
      for (const sm of samples) {
        const c = -v3.dot(sm.slice(3), td.dir);
        if (c > 0) dsum += c * apertureJS(sm.slice(0, 3), td.dir, w);
      }
      const directMean = td.sunLevel * leafT * GLASS * dsum / samples.length / Math.PI;
      shares.push([bounce + directMean, td.sunS]);
      shares.push([td.moonLevel * (WM.sunb_moon + 0.3), moonSpec]);
      const xyz = shares.reduce((acc, [y, S]) => v3.add(acc, v3.mul(xyzOf(S), y)), [0, 0, 0]);
      // Exposure follows the AMBIENT light on the walls (lamp, sky, bounce), as a
      // photographer would: a sun or moon patch is brighter than that and rolls off.
      const ambient = lampLevel * WM.lamp + shares[1][0] + bounce + td.moonLevel * WM.sunb_moon;
      let moonDirect = 0;
      if (td.moonLevel > 0) {
        const md = D.moon; let ms = 0;
        for (const sm of samples) { const c = -v3.dot(sm.slice(3), md); if (c > 0) ms += c * apertureJS(sm.slice(0, 3), md, w); }
        moonDirect = td.moonLevel * leafMean[2] * GLASS * ms / samples.length / Math.PI;
      }
      return { ambient, direct: directMean + moonDirect, xyz };
    }
    // The exposure key: the ambient light on the walls (a sun or moon patch is
    // brighter than that by about the same factor by day and by moonlight).
    const keyOf = a => a.ambient;
    const morningKey = keyOf(analyse(timeOfDay(0), 0, normY(blackbody(2700)), 0.5));

    let last = performance.now(), frameCount = 0;
    function draw(now) {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      st.p.step(dt); st.lampLevel.step(dt); st.lampMired.step(dt); st.paintMix.step(dt);
      const td = timeOfDay(st.p.x);
      const lampT = 1e6 / st.lampMired.x, lampS = normY(blackbody(lampT));
      const lampLevel = Math.max(0, st.lampLevel.x) * LAMP_LM / LUX_PER_UNIT;
      if (frameCount++ % 20 === 0) for (let i = 0; i < LEAF_ORDER.length; i++) if (videos[i].readyState >= 2) measureLeafMean(i);
      if (frameCount % 60 === 0) syncVideos();
      const leafT = td.leafW[0] * leafMean[0] + td.leafW[1] * leafMean[1];
      const paint = currentPaint();
      const A = analyse(td, lampLevel, lampS, leafT);
      // exposure: partial adaptation to brightness, with a lag. Darker scenes look
      // darker: down to 1/100 of daylight (a lamp-lit room) the eye adapts 85 %;
      // below that (moonlight, mesopic vision) only 55 %, so a moonlit room is dim.
      const key = keyOf(A), ratio = key / morningKey, LOW = 0.01;
      const logB = ratio >= LOW ? 0.15 * Math.log(ratio) : 0.15 * Math.log(LOW) + 0.45 * Math.log(ratio / LOW);
      const target = logB - Math.log(key) + Math.log(EXPOSURE_SCALE);
      st.logExposure = st.logExposure == null ? target : st.logExposure + (target - st.logExposure) * (1 - Math.exp(-dt * 2.2));
      // chromatic adaptation to the scene's light (CAT16, degree by colour temperature)
      const white = A.xyz.map(v => v / A.xyz[1]);
      const cct = mccamyCCT(white[0] / (white[0] + white[1] + white[2]), white[1] / (white[0] + white[1] + white[2]));
      const Dg = adaptationD(cct);
      const toCat = mat.mul(CAT16, RGB2XYZ), fromCat = mat.inverse(toCat);
      const wSrc = mat.apply(CAT16, white), wDst = mat.apply(toCat, [1, 1, 1]);
      const gain = wSrc.map((s, i) => Dg * wDst[i] / Math.max(s, 1e-9) + 1 - Dg);
      const adapt = mat.mul(fromCat, mat.mul(mat.diag(gain), toCat));
      api.debug = { p: st.p.x, el: td.el, cct, D: Dg, key, ambient: A.ambient, direct: A.direct, loops: videos.map(v => +v.currentTime.toFixed(3)), exposure: Math.exp(st.logExposure), leafT };

      // ---- upload leaf frames (only the patterns in use)
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D_ARRAY, texLeaves);
      const inUse = [td.leafW[0] > 0, td.leafW[1] > 0, td.moonLevel > 0];
      videos.forEach((v, i) => { if (inUse[i] && v.readyState >= 2) gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, leafSize, leafSize, 1, gl.RGBA, gl.UNSIGNED_BYTE, v); });
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
      T.forEach((t, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D_ARRAY, t); });
      gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, texGeoHi);
      gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, texGeoHi8);
      gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, texWinCov);
      if (winCov && winCov.readyState >= 2) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, winCov);

      // ---- uniforms
      // the sweep: the edge travels along the walls (u = y - x) from the far left to the window
      const tS = Math.min(1, Math.max(0, st.paintMix.x)), SW = 0.18;
      gl.uniform1fv(U.uPaintA, paintFrom.refl); gl.uniform1fv(U.uPaintB, paintTo.refl);
      gl.uniform3f(U.uSweep, U_RANGE[0] - SW + tS * (U_RANGE[1] - U_RANGE[0] + 2 * SW), SW, 1);
      gl.uniform3fv(U.uPaintRGB, paint.rgb);
      gl.uniform3fv(U.uWLamp, weightsOf(lampS)); gl.uniform3fv(U.uWSky, weightsOf(td.skyS));
      gl.uniform3fv(U.uWSun, weightsOf(td.sunS)); gl.uniform3fv(U.uWMoon, weightsOf(moonSpec));
      gl.uniform3fv(U.uLampRGB, rgbOf(lampS)); gl.uniform3fv(U.uSunRGB, rgbOf(td.sunS)); gl.uniform3fv(U.uMoonRGB, rgbOf(moonSpec));
      gl.uniform1f(U.uLamp, lampLevel);
      gl.uniform2i(U.uSkySlice, SKY_SLICE[td.sky[0][0]], SKY_SLICE[td.sky[1][0]]);
      gl.uniform2f(U.uSkyW, GLASS * td.sky[0][1], GLASS * td.sky[1][1]);
      gl.uniform2i(U.uSunbSlice, td.sunb[0][0], td.sunb[1][0]);
      const sb = td.sunLevel * leafT * GLASS;
      gl.uniform2f(U.uSunbW, sb * td.sunb[0][1], sb * td.sunb[1][1]);
      gl.uniform1f(U.uMoonbW, td.moonLevel * leafMean[2] * GLASS);
      gl.uniform3fv(U.uSunDir, td.dir); gl.uniform1f(U.uSunE, td.sunLevel);
      gl.uniform3fv(U.uMoonDir, D.moon); gl.uniform1f(U.uMoonE, td.moonLevel);
      gl.uniform2f(U.uLeafW, td.leafW[0], td.leafW[1]);
      const ek = td.ext.map(([k]) => EXT_ORDER.indexOf(k) * 4);
      gl.uniform2i(U.uExtSlice, ek[0], ek[1]);
      const skyScale = k => skyLux(td.el) / LUX_PER_UNIT / EH[k];
      gl.uniform4f(U.uExtW, td.sunLevel * td.ext[0][1] * (td.ext[0][0] === "night" ? 0 : 1), skyScale(td.ext[0][0]) * td.ext[0][1],
                   td.sunLevel * td.ext[1][1] * (td.ext[1][0] === "night" ? 0 : 1), skyScale(td.ext[1][0]) * td.ext[1][1]);
      gl.uniformMatrix3fv(U.uAdapt, false, mat.toGL(adapt));
      gl.uniform1f(U.uExposure, Math.exp(st.logExposure));
      gl.uniform1i(U.uDebug, api.debugView || 0);
      gl.viewport(0, 0, HI.width, HI.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    const loop = now => { draw(now); raf = requestAnimationFrame(loop); };
    let raf = requestAnimationFrame(loop);

    const api = {
      debug: null,
      /** 0 normal; 1 the sun's leaf transmission (tests). */
      debugView: 0,
      /** "morning" | "sunset" | "night": the sun moves forward in time to it. */
      setTime(key) {
        const k = { morning: 0, sunset: 1, night: 2 }[key];
        if (k == null) throw new RangeError("Unknown time " + key);
        const cur = st.p.target, d = ((k - (cur % 3)) % 3 + 3) % 3;
        st.p.target = cur + d;
      },
      /** 0 = off, else the lamp's colour temperature in kelvin. */
      setLamp(kelvin) {
        if (kelvin) { st.lampLevel.target = 1; st.lampMired.target = 1e6 / kelvin; if (st.lampLevel.x < 0.01) st.lampMired.x = st.lampMired.target; }
        else st.lampLevel.target = 0;
      },
      setPaint(hex) {
        const cur = currentPaint();
        paintFrom = { hex: paintTo.hex, rgb: cur.rgb, refl: cur.refl };
        paintTo = paintOf(hex);
        st.paintMix.x = 0; st.paintMix.v = 0; st.paintMix.target = 1;
      },
      /** Draws one frame now (tests: browsers pause animation frames in hidden tabs). */
      renderOnce() { draw(performance.now()); },
      /** Jump straight to the targets (tests, screenshots). */
      settle() { for (const s of [st.p, st.lampLevel, st.lampMired, st.paintMix]) { s.x = s.target; s.v = 0; } st.logExposure = null; },
      get outputSpace() { return wide ? "display-p3" : "srgb"; },
      stop() { cancelAnimationFrame(raf); videos.forEach(v => v.pause()); }
    };
    return api;
  }

  window.RoomMovie = { create, sunLight, skyLux, adaptationD };
})();
