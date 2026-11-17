/* ==========================================================================
 * sceneVisualizer.js - the WebGL2 renderer of sceneVisualizer.html: draws a
 * photo or video frame with its walls repainted by the v4 model
 * (glsl/sceneVisualizer.glsl, js/wallPaint.js).
 *
 * One canvas, one program, one draw per frame: the source is uploaded as an
 * sRGB texture (so the GPU decodes it to linear light), and RENDER writes the
 * repainted image at the source's size. Only wall pixels are ever seen: the
 * page lays the original image over the canvas with the wall mask as a CSS
 * mask.
 *
 * Classic script. Needs js/paintPipeline.js and js/wallPaint.js first.
 * Defines window.SceneVisualizer.
 * ======================================================================== */
(function () {
  "use strict";
  const PP = window.PaintPipeline, WP = window.WallPaint;
  if (!PP || !WP) throw new Error("sceneVisualizer.js needs js/paintPipeline.js and js/wallPaint.js first");
  const { mat, makeProgram, SRGB_TO_P3, supportsWideGamut, PaintError } = PP;

  /** Fetches the shader file and cuts it at its "//@@NAME" lines. */
  async function loadSources(url) {
    let text;
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (err) { throw new PaintError("load", `Couldn't load ${url}: ${err.message}`); }
    const parts = {}, marks = [...text.matchAll(/^\/\/@@(\w+)[^\n]*(?:\n|$)/gm)];
    marks.forEach((m, i) => { parts[m[1]] = text.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : text.length); });
    for (const k of ["VERT", "COMMON", "RENDER"]) if (!(k in parts)) throw new PaintError("load", `${url} has no //@@${k} section`);
    return { vert: parts.VERT, frag: parts.COMMON + "\n" + parts.RENDER };
  }

  /**
   * @typedef {Object} Look  Everything a frame is drawn with.
   * @property {number[]} oldLin   The original wall paint, linear sRGB.
   * @property {number[]} newLin   The new paint, linear sRGB.
   * @property {number} contrast   -1..1 (0 = as shot)
   * @property {number} saturation -1..1 (0 = as shot)
   * @property {{ pivotY: number, medianChroma: number }} lightStats  Of the wall's light (WallPaint.lightStats).
   */

  /**
   * Creates a renderer on `canvas`.
   * @param {HTMLCanvasElement} canvas
   * @param {{ glslUrl?: string, onRestored?: () => void, srgbOnly?: boolean }} [o]
   *   srgbOnly: never render in Display P3 (the tests compare sRGB values).
   * @returns {Promise<{ canvas: HTMLCanvasElement, outputSpace: string, setSize: (w: number, h: number) => void,
   *   upload: (source: TexImageSource) => void, draw: (look: Look) => void, timeDraw: (look: Look, n?: number) => number }>}
   */
  async function createRenderer(canvas, o = {}) {
    const src = await loadSources(o.glslUrl || "glsl/sceneVisualizer.glsl");
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new PaintError("webgl", "WebGL2 is not supported in this browser.");
    const wide = !o.srgbOnly && supportsWideGamut() && "drawingBufferColorSpace" in gl;
    let prog, uni;
    /** One texture per source, so several images can be redrawn without re-uploading: key -> { tex, w, h, source } */
    const slots = new Map();

    function init() {
      if ("unpackColorSpace" in gl) gl.unpackColorSpace = "srgb";
      if (wide) gl.drawingBufferColorSpace = "display-p3";
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
      const made = makeProgram(gl, src.vert, src.frag);       // { p, uniforms: { name: { loc } } }
      prog = made.p;
      uni = Object.fromEntries(Object.entries(made.uniforms).map(([k, u]) => [k, u.loc]));
      gl.bindVertexArray(gl.createVertexArray());
      for (const [key, sl] of slots) { sl.tex = null; upload(sl.source, key); }       // after a context loss
    }
    function newTexture() {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
        gl.texParameteri(gl.TEXTURE_2D, k, v);
      return tex;
    }
    const sizeOf = src => [src.videoWidth || src.naturalWidth || src.width, src.videoHeight || src.naturalHeight || src.height];
    canvas.addEventListener("webglcontextlost", e => e.preventDefault());
    canvas.addEventListener("webglcontextrestored", () => { init(); o.onRestored && o.onRestored(); });
    init();

    /** Sets the drawing size (draw() also sets it from the source it draws). */
    function setSize(w, h) {
      if (Math.max(w, h) > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new PaintError("webgl", "This image is larger than this GPU's limit.");
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    }
    /**
     * Uploads a photo, canvas or the current video frame into slot `key`
     * (one texture per key; upload again to replace it, e.g. every video frame).
     */
    function upload(source, key = "main") {
      let sl = slots.get(key);
      if (!sl) slots.set(key, (sl = { tex: null, w: 0, h: 0, source }));
      if (!sl.tex) sl.tex = newTexture();
      [sl.w, sl.h] = sizeOf(source); sl.source = source;
      gl.bindTexture(gl.TEXTURE_2D, sl.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
    /** Frees slot `key`. */
    function release(key) { const sl = slots.get(key); if (sl) { gl.deleteTexture(sl.tex); slots.delete(key); } }
    /** Draws slot `key` with `look`, at the source's size (the canvas is resized to it). */
    function draw(look, key = "main") {
      const sl = slots.get(key);
      if (!sl) throw new Error(`Nothing uploaded for "${key}"`);
      setSize(sl.w, sl.h);
      const { old16, gain } = WP.transfer(look.oldLin, look.newLin);
      const sliders = look.contrast !== 0 || look.saturation !== 0;
      gl.useProgram(prog);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sl.tex);
      gl.uniform1i(uni.src, 0);
      gl.uniformMatrix3fv(uni.to16, false, mat.toGL(WP.TO16));
      gl.uniformMatrix3fv(uni.from16, false, mat.toGL(WP.FROM16));
      gl.uniformMatrix3fv(uni.toOutput, false, mat.toGL(wide ? SRGB_TO_P3 : mat.IDENTITY));
      gl.uniform3fv(uni.old16, old16);
      gl.uniform3fv(uni.gain, gain);
      gl.uniform1i(uni.sliders, sliders ? 1 : 0);
      gl.uniform1i(uni.dither, look.dither === false ? 0 : 1);
      if (uni.contrastK) gl.uniform1f(uni.contrastK, 2 ** look.contrast);
      if (uni.satAmount) gl.uniform1f(uni.satAmount, look.saturation);
      if (uni.pivotY) gl.uniform1f(uni.pivotY, look.lightStats ? look.lightStats.pivotY : 0.18);
      if (uni.medianChroma) gl.uniform1f(uni.medianChroma, look.lightStats ? look.lightStats.medianChroma : 0.02);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    /** Mean GPU time of `n` draws in ms (for the tests and the speed check). */
    function timeDraw(look, n = 20) {
      draw(look); gl.finish();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) draw(look);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      return (performance.now() - t0) / n;
    }
    /** Reads back the drawn image (top-down RGBA), for the tests. */
    function readPixels() {
      const w = canvas.width, h = canvas.height, out = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
      const flip = new Uint8Array(out.length);
      for (let y = 0; y < h; y++) flip.set(out.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      return flip;
    }
    return { canvas, gl, get outputSpace() { return wide ? "display-p3" : "srgb"; }, setSize, upload, release, draw, timeDraw, readPixels };
  }

  window.SceneVisualizer = { createRenderer, loadSources };
})();
