/* ==========================================================================
 * videoShaderRender.js — the engine behind videoShaderRenderer.html.
 *
 * The video counterpart of js/shaderSceneRender.js. Instead of analysing a
 * few still photos once, it analyses EVERY frame of a playing video and paints
 * the walls of that frame, so the paint follows the light as it changes.
 *
 * It runs the same shaders (glsl/shaderSceneRender.glsl, plus its video-only
 * ADJUST section) and reuses
 * the shader loader, GL helpers and colour functions exported by
 * js/shaderSceneRender.js, which must be loaded first.
 *
 * --------------------------------------------------------------------------
 * LAYERS (the page builds this markup):
 *
 *   .video                       the frame, at the video's aspect ratio
 *     .video__layer--bottom
 *       video.video__media--source   the PROCESSED copy; its frames feed WebGL
 *       canvas.video__canvas         the painted frames, covering the source
 *     .video__layer--top
 *       video.video__media--top      the UNPROCESSED copy, masked under
 *                                    .is-painted so its walls are transparent
 *
 *   The canvas replaces the source video on screen: each new source frame is
 *   painted and drawn into it. Where the mask is black (the walls), the top
 *   video is transparent and the painted canvas shows through. Without
 *   .is-painted the canvas is hidden and the top video shows unmasked, so a
 *   failure falls back to the plain video.
 *
 * --------------------------------------------------------------------------
 * DATA FLOW (per video frame, all on the GPU; W x H = the video's own size)
 *
 *   source <video> frame
 *     │  texSubImage2D (the browser converts YUV to sRGB)
 *     ▼
 *   texA            RGBA8, W x H
 *     │  P0  DECODE   sRGB -> linear light                    -> lin
 *     │  P0a ADJUST   contrast + saturation sliders            -> adj
 *     │               (skipped when both are centred: lin is used as-is)
 *     │  P0b BLUR     separable Gaussian, v2 only              -> tmp -> blurred
 *     │  P1  ANALYSE  light minus white light, per pixel       -> theArray
 *     ▼
 *   theArray        RGBA16F, W x H; kept until the next frame, or a model or
 *                   slider change
 *     │  P2  RENDER   wall paint lit by theArray
 *     ▼
 *   the visible canvas's drawing buffer
 *
 * Paint changes and paint fades only re-run RENDER, and slider changes re-run
 * the passes from DECODE on the frame already in texA, so all of them also
 * work while the video is paused.
 *
 * STATISTICS: ADJUST compares each pixel with the whole video: the median
 * luminance (the contrast's fixed point) and the median difference from white
 * (the saturation's reference; one median per way of measuring it). VideoStats
 * (a LightStats from js/shaderSceneRender.js) measures them on the CPU from a
 * small copy of the frames during the first loop, then stops.
 *
 * TIMING: new frames arrive through requestVideoFrameCallback, which runs in
 * the same rendering step that puts the frame on screen, so the painted
 * canvas and the top video show the same frame. Paint fades are driven by
 * requestAnimationFrame; both pass the frame's timestamp, and a frame is never
 * rendered twice for the same timestamp.
 *
 * SYNC: the two <video> elements decode independently and would drift apart.
 * The source video leads. On every painted frame, the top video's playback
 * rate is nudged toward the source's position (or it seeks, if far off).
 *
 * PUBLIC API: window.VideoShaderRender.createVideoRenderer(), which returns a
 * VideoRenderer (see its typedef).
 * ======================================================================== */
(function () {
  "use strict";

  const base = window.ShaderSceneRender;
  if (!base) throw new Error("videoShaderRender: load js/shaderSceneRender.js first");
  const {
    loadShaders, makeProgram, makeTexture, makeTarget, INT_UNIFORMS, decodeImage,
    PaintError, SHADER_DEFAULTS, NOTICES: BASE_NOTICES, FADE_MS,
    LightStats, makeAdjustment, toAmount, toSatMeasure,
    normalizeHex, hexToRgb, hexToHsl
  } = base;

  // ---------------------------------------------------------------- constants

  /** Default location of the shader file, relative to the page. */
  const DEFAULT_GLSL_URL = "glsl/shaderSceneRender.glsl";

  /**
   * Drift between the two videos, in seconds, below which the top video plays
   * at normal speed. About one frame of a 30 fps video.
   */
  const HOLD_DRIFT = 1 / 30;
  /** Drift above which the top video seeks instead of catching up gradually. */
  const SEEK_DRIFT = 0.5;
  /** Largest playback-rate change used to catch up (0.1 = 0.9x .. 1.1x). */
  const MAX_RATE_NUDGE = 0.1;

  /** VideoStats: frames are measured at 1/STATS_DOWNSCALE of their size... */
  const STATS_DOWNSCALE = 20;
  /** ...once per STATS_BUCKET_S seconds of the video, until all are covered. */
  const STATS_BUCKET_S = 0.1;

  /**
   * Visitor-facing text for each PaintErrorKind. Trusted constant HTML (it is
   * assigned with innerHTML). Same as js/shaderSceneRender.js, with this
   * page's URL and folders.
   * @type {Record<import("./shaderSceneRender.js").PaintErrorKind, string>}
   */
  const NOTICES = Object.assign({}, BASE_NOTICES, {
    origin: "Paint previews need http. Run <b>bash serve.sh</b> in this folder and open " +
            `<a href="http://localhost:8000/videoShaderRenderer.html">http://localhost:8000/videoShaderRenderer.html</a>.`,
    load:   "Some files didn't load. Check the images and glsl folders, then reload the page."
  });

  // ======================================================================
  // VideoShader — the WebGL2 pipeline, drawing into the visible canvas
  // ======================================================================

  /**
   * Owns the visible canvas's WebGL2 context and runs the pipeline for one
   * video. Every surface is W x H, the video's own size, because DECODE reads
   * texA with texelFetch at gl_FragCoord and RENDER walks theArray with
   * row * W + col (see the header of js/shaderSceneRender.js).
   *
   * Context loss: webglcontextlost is preventDefault()-ed. On
   * webglcontextrestored, #init() rebuilds everything and hooks.onRestored()
   * lets the controller re-upload the current frame.
   */
  class VideoShader {
    /** @type {{ onRestored: () => void, onError: (err: unknown) => void }} */
    #hooks;
    /** @type {import("./shaderSceneRender.js").ShaderSources} Kept to recompile after a context restore. */
    #sources;

    /**
     * @param {HTMLCanvasElement} canvas  The visible canvas; resized to W x H.
     * @param {number} w  Video width in pixels.
     * @param {number} h  Video height in pixels.
     * @param {import("./shaderSceneRender.js").ShaderSources} sources  From loadShaders().
     * @param {{ onRestored: () => void, onError: (err: unknown) => void }} hooks
     * @throws {PaintError} "webgl" when WebGL2 or float render targets are missing.
     * @throws {PaintError} "load" when the shader file has no ADJUST section.
     * @throws {Error} When a shader fails to compile or link.
     */
    constructor(canvas, w, h, sources, hooks) {
      this.canvas = canvas;
      this.w = canvas.width = w;
      this.h = canvas.height = h;
      if (!sources.adjust) throw new PaintError("load", "The shader file has no //@@ADJUST section.");
      this.#sources = sources;
      this.#hooks = hooks;
      canvas.addEventListener("webglcontextlost", e => e.preventDefault());
      canvas.addEventListener("webglcontextrestored", () => this.#restore());
      // Same options as WallShader, except preserveDrawingBuffer: this canvas
      // is shown directly (never copied), and is redrawn on every change.
      this.gl = canvas.getContext("webgl2", {
        alpha: false, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: false, preserveDrawingBuffer: false
      });
      if (!this.gl) throw new PaintError("webgl", "WebGL2 is not supported in this browser.");
      this.#init();
    }

    /** True while the GPU context is lost. GL calls are then silent no-ops. */
    get lost() { return this.gl.isContextLost(); }

    /**
     * Creates every context-level resource. Runs at construction and again
     * after a context restore.
     * @throws {PaintError} "webgl" when float render targets or the size aren't supported.
     * @throws {Error} When a shader fails to compile or link.
     */
    #init() {
      const gl = this.gl, w = this.w, h = this.h, src = this.#sources;
      if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float"))
        throw new PaintError("webgl", "This GPU/browser can't render to floating-point textures.");
      if (Math.max(w, h) > gl.getParameter(gl.MAX_TEXTURE_SIZE))
        throw new PaintError("webgl", "The video is larger than this GPU's limit.");
      if ("unpackColorSpace" in gl) gl.unpackColorSpace = "srgb";
      // Rows top-to-bottom as stored (RENDER's main() flips back), as in WallShader.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
      this.progs = { decode: makeProgram(gl, src.vert, src.decode), blur: makeProgram(gl, src.vert, src.blur),
                     analyse: makeProgram(gl, src.vert, src.analyse), render: makeProgram(gl, src.vert, src.render),
                     adjust: makeProgram(gl, src.vert, src.adjust) };
      // texA is allocated once; each frame overwrites it with texSubImage2D.
      // adj is LINEAR-filtered like lin, because BLUR may read either.
      this.texA = makeTexture(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null, false);
      this.lin = makeTarget(gl, w, h, true);
      this.adj = makeTarget(gl, w, h, true);
      this.tmp = makeTarget(gl, w, h, true);
      this.blurred = makeTarget(gl, w, h, true);
      this.theArray = makeTarget(gl, w, h, false);
      /** @type {string | null} Cache key of theArray's analysis; null = re-run. */
      this.analysedFor = null;
      gl.bindVertexArray(gl.createVertexArray());
      gl.viewport(0, 0, w, h);
      gl.activeTexture(gl.TEXTURE0);
    }

    /** webglcontextrestored handler: rebuild, then let the controller re-upload. */
    #restore() {
      try { this.#init(); } catch (err) { this.#hooks.onError(err); return; }
      this.#hooks.onRestored();
    }

    /**
     * Copies the video's current frame into texA and marks the analysis stale.
     * @param {HTMLVideoElement} video  Same-origin, readyState >= HAVE_CURRENT_DATA.
     * @throws {PaintError} "origin" when the frame's pixels can't be read (file://).
     */
    upload(video) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.texA);
      try { gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video); }
      catch (err) {
        if (err && err.name === "SecurityError") throw new PaintError("origin", "The browser blocked reading the video's pixels.");
        throw err;
      }
      this.analysedFor = null;
    }

    /**
     * Runs one fullscreen pass (same as WallShader#draw).
     * @param {{ p: WebGLProgram, loc: Record<string, WebGLUniformLocation> }} prog
     * @param {{ fbo: WebGLFramebuffer } | null} target  null = the canvas.
     * @param {WebGLTexture} tex  Bound to texture unit 0.
     * @param {Record<string, number | number[]>} uniforms
     */
    #draw(prog, target, tex, uniforms) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
      gl.useProgram(prog.p);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      for (const [k, v] of Object.entries(uniforms)) {
        const l = prog.loc[k]; if (!l) continue;
        if (typeof v === "number") (INT_UNIFORMS.has(k) ? gl.uniform1i : gl.uniform1f).call(gl, l, v);
        else if (v.length === 2) gl.uniform2fv(l, v);
        else if (v.length === 3) gl.uniform3fv(l, v);
        else gl.uniform4fv(l, v);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /** Blur radius in pixels: penumbra is a % of the video width. */
    #sigma() { return Math.max(0, SHADER_DEFAULTS.penumbra) / 100 * this.w; }

    /**
     * P0 decode -> P0a adjust (if any) -> P0b blur (v2) -> P1 theArray, for the
     * frame in texA. Skipped when theArray already holds this frame analysed
     * with the same model and adjustment.
     * @param {"v1" | "v2"} model
     * @param {import("./shaderSceneRender.js").Adjustment | null} adjust  null = leave the light as decoded.
     */
    ensureAnalysed(model, adjust) {
      const key = adjust ? [model, ...Object.values(adjust)].join("|") : model;
      if (this.analysedFor === key) return;
      const gl = this.gl, P = this.progs, isV1 = model === "v1", sigma = this.#sigma();
      this.#draw(P.decode, this.lin, this.texA, { src: 0 });
      // `light` is the unblurred linear light that BLUR and ANALYSE read.
      let light = this.lin;
      if (adjust) { this.#draw(P.adjust, this.adj, this.lin.tex, { src: 0, ...adjust }); light = this.adj; }
      let lightTex = light.tex;
      if (!isV1 && sigma >= 0.3) {
        this.#draw(P.blur, this.tmp, light.tex, { src: 0, dir: [1, 0], sigma });
        this.#draw(P.blur, this.blurred, this.tmp.tex, { src: 0, dir: [0, 1], sigma });
        lightTex = this.blurred.tex;
      }
      // lightLin on unit 0, sharpLin on unit 1; unbind unit 1 afterwards so
      // lin/adj is never bound while the next DECODE/ADJUST renders into it.
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, light.tex); gl.activeTexture(gl.TEXTURE0);
      this.#draw(P.analyse, this.theArray, lightTex, { lightLin: 0, sharpLin: 1, model: isV1 ? 1 : 2 });
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, null); gl.activeTexture(gl.TEXTURE0);
      this.analysedFor = key;
    }

    /**
     * P2: paints the walls of the analysed frame into the canvas.
     * @param {"v1" | "v2"} model  Must match ensureAnalysed().
     * @param {[number, number, number]} hsl  Paint, as from hexToHsl().
     */
    render(model, hsl) {
      const S = SHADER_DEFAULTS, isV1 = model === "v1";
      this.#draw(this.progs.render, null, this.theArray.tex, {
        theArray: 0, W: this.w, H: this.h, model: isV1 ? 1 : 2, dither: S.dither ? 1 : 0,
        wallHSL: hsl, warmCCT: +S.warmCCT, warmTint: +S.warmTint, skyCCT: +S.skyCCT,
        adaptation: +S.adaptation, fill: +S.fill, bounce: +S.bounce,
        glow: +S.glow, shadowCurve: +S.shadowCurve,
        v1p: [S.v1.ambient, S.v1.shadowCurve, S.v1.warmth, S.v1.glow]
      });
    }
  }

  // ---------------------------------------------------------------- colour

  /** Encoded sRGB 0..255 -> linear 0..1, per channel. */
  const toLinear = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  /** Linear 0..1 -> encoded sRGB 0..255, per channel. */
  const toEncoded = c => 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

  /**
   * @param {string} hex  "#rrggbb".
   * @returns {[number, number, number]} Linear sRGB, 0..1.
   */
  function hexToLinear(hex) { return /** @type {[number, number, number]} */ (hexToRgb(hex).map(toLinear)); }

  /**
   * @param {number[]} lin  Linear sRGB, 0..1.
   * @returns {string} "#rrggbb".
   */
  function linearToHex(lin) {
    return "#" + lin.map(c => Math.round(toEncoded(Math.min(1, Math.max(0, c)))).toString(16).padStart(2, "0")).join("");
  }

  /** Ease-out cubic: fast start, gentle landing (close to the tiles' fade curve). */
  const easeOut = t => 1 - (1 - t) ** 3;

  // ======================================================================
  // VideoStats — whole-video medians for the ADJUST pass
  // ======================================================================

  /**
   * The medians ADJUST compares each pixel with (LightStats, shared with the
   * photo page), measured over ALL frames of the video, not just the current
   * one, so the sliders' effect doesn't flicker as the light changes.
   *
   * During the first loop, sample() adds the frame (at 1/STATS_DOWNSCALE
   * size) once per STATS_BUCKET_S of video time. Once every bucket has been
   * seen it does nothing. Until then the medians cover the part of the video
   * seen so far.
   */
  class VideoStats extends LightStats {
    /** @type {Uint8Array} 1 for each STATS_BUCKET_S slice of the video already measured. */
    #seen;
    #left;

    /** @param {HTMLVideoElement} video  With metadata loaded. */
    constructor(video) {
      super(Math.max(1, Math.round(video.videoWidth / STATS_DOWNSCALE)),
            Math.max(1, Math.round(video.videoHeight / STATS_DOWNSCALE)));
      const d = video.duration;
      this.#seen = new Uint8Array(d > 0 && isFinite(d) ? Math.ceil(d / STATS_BUCKET_S) : 1);
      this.#left = this.#seen.length;
    }

    /** True once every part of the video has been measured. */
    get complete() { return this.#left === 0; }

    /**
     * Adds the video's current frame, unless its slice was already measured.
     * @param {HTMLVideoElement} video
     */
    sample(video) {
      if (this.#left === 0) return;
      const i = Math.min(this.#seen.length - 1, Math.floor(video.currentTime / STATS_BUCKET_S));
      if (this.#seen[i]) return;
      this.#seen[i] = 1;
      this.#left--;
      this.add(video);
    }
  }

  // ---------------------------------------------------------------- small utilities

  /**
   * Resolves once the video has a frame to show.
   * @param {HTMLVideoElement} video
   * @returns {Promise<void>}
   * @throws {PaintError} "load" when the video fails to load.
   */
  function videoReady(video) {
    const failed = () => new PaintError("load", `Couldn't load ${video.currentSrc || video.src}`);
    if (video.error) return Promise.reject(failed());
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
    return new Promise((resolve, reject) => {
      video.addEventListener("loadeddata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(failed()), { once: true });
    });
  }

  /**
   * Calls `cb(now)` once per new frame of `video`, from the
   * rendering step that presents it. Falls back to polling currentTime on
   * every animation frame where requestVideoFrameCallback is missing.
   * @param {HTMLVideoElement} video
   * @param {(now: number) => void} cb
   */
  function onEveryFrame(video, cb) {
    if ("requestVideoFrameCallback" in video) {
      const tick = now => { video.requestVideoFrameCallback(tick); cb(now); };
      video.requestVideoFrameCallback(tick);
      return;
    }
    let last = -1;
    const tick = now => {
      requestAnimationFrame(tick);
      const t = video.currentTime;
      if (t !== last && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) { last = t; cb(now); }
    };
    requestAnimationFrame(tick);
  }

  // ======================================================================
  // createVideoRenderer — the controller for one page
  // ======================================================================

  /**
   * @typedef {Object} VideoRendererOptions
   * @property {string} mask  Wall mask URL (black = wall). Decoded before the
   *   mask is switched on, so it never pops in late.
   * @property {string} initialPaint  Paint on screen at load (#rrggbb).
   * @property {"v1" | "v2"} [initialModel="v2"]  Must match the checked model radio.
   * @property {string} [glslUrl]  Shader file (default "glsl/shaderSceneRender.glsl").
   * @property {Object} elements  Page elements the renderer drives:
   * @property {HTMLElement} elements.app          Gets the .is-painted class.
   * @property {HTMLVideoElement} elements.source  The processed video (frame source).
   * @property {HTMLVideoElement} elements.top     The unprocessed, masked video.
   * @property {HTMLCanvasElement} elements.canvas The painted frames.
   * @property {HTMLFieldSetElement} elements.controls  Tinting algo + sliders; disabled on failure.
   * @property {HTMLElement} elements.notice       role="status" region for notices.
   */

  /**
   * Scripting and testing handle (the page exposes it as window.videoRenderer).
   * @typedef {Object} VideoRenderer
   * @property {string} activePaintColor  Current paint, lowercase #rrggbb (read-only).
   * @property {"v1" | "v2"} activeModel  Current lighting model (read-only).
   * @property {(hex: string) => void} setPaint  Sets the paint (fades unless reduced motion).
   * @property {(model: "v1" | "v2") => void} setModel  Switches the lighting model.
   * @property {(amount: number) => void} setContrast    -1..1, 0 = unchanged (see ADJUST).
   * @property {(amount: number) => void} setSaturation  -1..1, 0 = unchanged (see ADJUST).
   * @property {number} contrast    Current contrast amount (read-only).
   * @property {number} saturation  Current saturation amount (read-only).
   * @property {(measure: SatMeasure) => void} setSatMeasure  How saturation measures difference from white.
   * @property {SatMeasure} satMeasure  Current measure (read-only).
   * @property {VideoStats | null} stats  The whole-video medians, once measuring has started.
   * @property {() => void} play  Starts both videos (for when autoplay was blocked).
   * @property {() => Promise<void>} start  Boots paint previews (repeat calls return the same promise).
   * @property {Promise<void> | null} ready  start()'s promise; never rejects.
   * @property {number} framesPainted  Video frames painted so far (read-only).
   */

  /**
   * Creates the controller. Nothing loads or renders until start().
   * @param {VideoRendererOptions} options
   * @returns {VideoRenderer}
   */
  function createVideoRenderer(options) {
    const { app, source, top, canvas, controls, notice } = options.elements;
    const glslUrl = options.glslUrl || DEFAULT_GLSL_URL;

    // ------------------------------------------------------------ state

    /** Paint the visitor picked, lowercase #rrggbb. Written by setPaint(). */
    let activePaintColor = normalizeHex(options.initialPaint);
    /** Lighting model: "v2" (perceptual) or "v1" (HSV). Written by setModel(). */
    let activeModel = options.initialModel || "v2";
    /**
     * Slider settings, written by setContrast / setSaturation / setSatMeasure.
     * Amounts are -1..1; 0 (the default) leaves the video's light as it is.
     * @type {{ contrast: number, saturation: number, satMeasure: SatMeasure }}
     */
    const sliders = { contrast: 0, saturation: 0, satMeasure: "full" };
    /**
     * The running paint fade, or null. `from` is the linear colour on screen
     * when it started; it always ends at activePaintColor.
     * @type {{ from: number[], start: number } | null}
     */
    let fade = null;

    /** @type {VideoShader | null} */
    let shader = null;
    /** @type {VideoStats | null} Created by startPainting(). */
    let stats = null;
    /** True once the canvas holds painted frames and .is-painted is on. */
    let painting = false;
    /** Set when a failure was caused by context loss, so the restore retries the boot. */
    let resumeOnRestore = false;
    /** True once onEveryFrame() is attached (it must be attached only once). */
    let watching = false;
    /** Timestamp of the last render, so rVFC and rAF never render the same frame twice. */
    let lastRenderAt = -1;
    let framesPainted = 0;
    let ready = null;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

    // ------------------------------------------------------------ UI sync

    /** Checks the radio in group `name` whose value is `value`. */
    function syncRadio(name, value) {
      for (const input of app.querySelectorAll(`input[name="${name}"]`)) input.checked = input.value === value;
    }

    /** Updates the --active-paint CSS variable and the checked chip. */
    function syncPaintUi(hex) {
      document.documentElement.style.setProperty("--active-paint", hex);
      syncRadio("paint", hex);
    }

    function showNotice(kind) { notice.innerHTML = NOTICES[kind] || NOTICES.error; }

    // ------------------------------------------------------------ rendering

    /**
     * The paint to draw at time `now`: activePaintColor, or the in-between
     * colour while a fade runs (mixed in linear light). Ends the fade when it
     * is done.
     * @param {number} now  A performance.now()-style timestamp.
     * @returns {string} "#rrggbb".
     */
    function paintAt(now) {
      if (!fade) return activePaintColor;
      const t = Math.min(1, Math.max(0, (now - fade.start) / FADE_MS));
      if (t >= 1) { fade = null; return activePaintColor; }
      const to = hexToLinear(activePaintColor), k = easeOut(t);
      return linearToHex(fade.from.map((c, i) => c + (to[i] - c) * k));
    }

    /**
     * Paints the canvas. With `newFrame`, first copies the source video's
     * current frame to the GPU (it is then analysed); otherwise only RENDER
     * runs, unless the model or sliders changed since the last analysis.
     * @param {number} now  Frame timestamp (rVFC / rAF), or performance.now().
     * @param {boolean} newFrame
     */
    function render(now, newFrame) {
      if (!painting || shader.lost) return;
      if (newFrame) { stats.sample(source); shader.upload(source); framesPainted++; }
      else if (now === lastRenderAt) return;     // this frame is already drawn
      lastRenderAt = now;
      shader.ensureAnalysed(activeModel, makeAdjustment(sliders, stats));
      shader.render(activeModel, hexToHsl(paintAt(now)));
    }

    /** @type {number | null} Pending requestAnimationFrame id. */
    let rafId = null;
    /**
     * Re-renders on the next animation frame, and keeps doing so while a paint
     * fade runs. Used for paint, model and slider changes, which must show even
     * when the video is paused.
     */
    function requestRender() {
      rafId ??= requestAnimationFrame(now => {
        rafId = null;
        try { render(now, false); } catch (err) { fail(err); return; }
        if (fade) requestRender();
      });
    }

    /**
     * Keeps the top video on the source video's frame. Both positions are read
     * at the same instant, so any reporting lag cancels out. Drift is measured
     * the short way round the loop point, then corrected by a small
     * playback-rate change, or by a seek when it is large.
     */
    function syncTop() {
      const d = source.duration, t = source.currentTime;
      if (!(d > 0) || top.seeking) return;
      if (source.paused !== top.paused) {
        if (source.paused) top.pause(); else top.play().catch(() => {});
      }
      let drift = top.currentTime - t;
      drift -= d * Math.round(drift / d);
      let rate = 1;
      if (Math.abs(drift) > SEEK_DRIFT) top.currentTime = t;
      else if (Math.abs(drift) > HOLD_DRIFT) rate = 1 - Math.max(-MAX_RATE_NUDGE, Math.min(MAX_RATE_NUDGE, drift));
      if (top.playbackRate !== rate) top.playbackRate = rate;
    }

    /** onEveryFrame() callback for the source video. */
    function onFrame(now) {
      syncTop();
      try { render(now, true); } catch (err) { fail(err); }
    }

    /**
     * The single error policy (same as js/shaderSceneRender.js): wait out a
     * context loss; otherwise stop painting, show the plain video, disable the
     * controls and show a notice.
     */
    function fail(err) {
      if (shader && shader.lost) { resumeOnRestore = true; return; }
      painting = false;
      fade = null;
      app.classList.remove("is-painted");
      controls.disabled = true;
      const kind = err instanceof PaintError ? err.kind : "error";
      if (kind === "error" || kind === "webgl") console.warn("videoShaderRender:", err);
      showNotice(kind);
    }

    /** VideoShader hook: the context is back, so redraw the current frame (or resume the boot). */
    function onRestored() {
      try {
        if (painting) render(performance.now(), true);
        else if (resumeOnRestore) { resumeOnRestore = false; startPainting().catch(fail); }
      } catch (err) { fail(err); }
    }

    // ------------------------------------------------------------ public setters

    /**
     * Sets the wall paint. Any #rrggbb is accepted. The UI updates at once; the
     * walls fade to the new paint over FADE_MS (instantly with reduced motion).
     * @param {string} hex
     * @throws {TypeError} When `hex` isn't #rrggbb.
     */
    function setPaint(hex) {
      hex = normalizeHex(hex);
      const now = performance.now();
      const shown = hexToLinear(paintAt(now));       // where a running fade has got to
      activePaintColor = hex;
      syncPaintUi(hex);
      fade = painting && !reducedMotion.matches ? { from: shown, start: now } : null;
      requestRender();
    }

    /**
     * Switches the lighting model. The current frame is re-analysed on the next
     * render.
     * @param {"v1" | "v2"} model
     * @throws {RangeError} For an unknown model.
     */
    function setModel(model) {
      if (model !== "v1" && model !== "v2") throw new RangeError(`Unknown shader model "${model}"`);
      activeModel = model;
      syncRadio("model", model);
      requestRender();
    }

    /**
     * Contrast of the video's light before the paint is applied. 0 = as shot;
     * -1..1 maps to a luminance exponent of 0.5..2 around the video's median
     * luminance. Re-analyses the current frame on the next render.
     * @param {number} amount  -1..1.
     */
    function setContrast(amount) { sliders.contrast = toAmount(amount); requestRender(); }

    /**
     * Saturation of the video's light before the paint is applied. 0 = as shot;
     * each pixel's chroma is scaled by 2^(amount x its distance from white /
     * the video's median distance), so -1 flattens and +1 strengthens the
     * colour of the light, most where it differs most from white.
     * @param {number} amount  -1..1.
     */
    function setSaturation(amount) { sliders.saturation = toAmount(amount); requestRender(); }

    /**
     * Chooses how the saturation slider measures each pixel's difference from
     * pure white (see SatMeasure). No visible change while saturation is 0.
     * @param {SatMeasure} measure
     * @throws {RangeError} For an unknown measure.
     */
    function setSatMeasure(measure) {
      sliders.satMeasure = toSatMeasure(measure);
      syncRadio("satMeasure", measure);
      requestRender();
    }

    /** Starts both videos; needed only if the browser blocked autoplay. */
    function play() {
      for (const video of [source, top]) if (video.paused) video.play().catch(() => {});
    }

    // ------------------------------------------------------------ boot

    /**
     * Turns paint previews on. Any throw ends up in fail(), which leaves the
     * plain video and a notice.
     *  1. Gates, cheapest first: ?nogl, file://, CSS luminance mask support.
     *  2. In parallel: load the shaders, decode the mask, wait for the first frame.
     *  3. Create the VideoShader at the video's own size, and the VideoStats.
     *  4. Paint the current frame, THEN add .is-painted. CSS switches the mask
     *     on and fades the canvas in over the source video, which shows the
     *     same frame unpainted, so the paint fades in over the original walls.
     *  5. Paint every new frame from now on.
     * @returns {Promise<void>}
     * @throws {PaintError | Error}
     */
    async function startPainting() {
      if (new URLSearchParams(location.search).has("nogl")) throw new PaintError("nogl");
      if (location.protocol === "file:") throw new PaintError("origin");
      if (!CSS.supports("mask-mode", "luminance")) throw new PaintError("mask");
      const [sources] = await Promise.all([loadShaders(glslUrl), decodeImage(options.mask), videoReady(source)]);
      shader ??= new VideoShader(canvas, source.videoWidth, source.videoHeight, sources, { onRestored, onError: fail });
      stats ??= new VideoStats(source);
      painting = true;
      render(performance.now(), true);
      controls.disabled = false;
      notice.textContent = "";
      app.classList.add("is-painted");
      if (!watching) { watching = true; onEveryFrame(source, onFrame); }
    }

    syncPaintUi(activePaintColor);

    /** @type {VideoRenderer} */
    return {
      get activePaintColor() { return activePaintColor; },
      get activeModel() { return activeModel; },
      get ready() { return ready; },
      get framesPainted() { return framesPainted; },
      get contrast() { return sliders.contrast; },
      get saturation() { return sliders.saturation; },
      get satMeasure() { return sliders.satMeasure; },
      get sliders() { return { ...sliders }; },
      get stats() { return stats; },
      setPaint, setModel, setContrast, setSaturation, setSatMeasure, play,
      start() { return (ready ??= startPainting().catch(fail)); }
    };
  }

  // ---------------------------------------------------------------- export
  window.VideoShaderRender = {
    createVideoRenderer, VideoShader, VideoStats,
    hexToLinear, linearToHex,
    NOTICES, DEFAULT_GLSL_URL, HOLD_DRIFT, SEEK_DRIFT, MAX_RATE_NUDGE
  };
})();
