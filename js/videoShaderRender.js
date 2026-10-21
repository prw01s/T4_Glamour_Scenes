/* ==========================================================================
 * videoShaderRender.js — the controller behind videoShaderRenderer.html.
 *
 * The video counterpart of js/shaderSceneRender.js. Instead of analysing a
 * few still photos once, it analyses EVERY frame of a playing video and paints
 * the walls of that frame, so the paint follows the light as it changes.
 *
 * The GPU work, colour science and statistics live in js/paintPipeline.js
 * (window.PaintPipeline), which must be loaded first; the shaders are in
 * glsl/shaderSceneRender.glsl.
 *
 * --------------------------------------------------------------------------
 * LAYERS (the page builds this markup):
 *
 *   .video                       the frame, at the video's aspect ratio
 *     .video__layer--bottom
 *       video.video__media--source   the PROCESSED copy; its frames feed WebGL
 *       canvas.video__canvas         the painted frames, covering the source
 *     .video__layer--top
 *       video.video__media--top      the UNPROCESSED copy: shown until painting
 *                                    starts, and again if it fails
 *       canvas.video__copy           while painting: a copy of the SOURCE
 *                                    video's current frame, masked so its
 *                                    walls are transparent
 *
 *   The painted canvas replaces the source video on screen. Where the mask is
 *   black (the walls), the frame copy is transparent and the painted canvas
 *   shows through. Both canvases are drawn from the same decoded frame, in
 *   the same callback, so they always show the same frame. (The first
 *   version masked the second <video> instead; two decoders drift, and even
 *   with playback-rate correction 16 % of displayed frames differed by one.)
 *   The second <video> is paused while painting. Without .is-painted the
 *   canvases are hidden and the second video shows unmasked, so a failure
 *   falls back to the plain video.
 *
 * --------------------------------------------------------------------------
 * DATA FLOW (per video frame; W x H = the video's own size, used for both
 * the analysis and the render size)
 *
 *   source <video> frame --upload--> source texture --analyse()--> light map
 *   --render()--> the visible canvas
 *
 * Paint changes, paint fades and slider changes re-run only what they need
 * on the frame already uploaded, so they also work while the video is paused.
 *
 * STATISTICS: VideoStats (a LightStats) measures the whole video during the
 * first loop: the sliders' medians, and v3's reference white and scene white.
 * Until the loop completes they cover the part seen so far.
 *
 * TIMING: new frames arrive through requestVideoFrameCallback, which runs in
 * the same rendering step that puts the frame on screen, so the painted
 * canvas and the top video show the same frame. Paint fades are driven by
 * requestAnimationFrame; both pass the frame's timestamp, and a frame is never
 * rendered twice for the same timestamp.
 *
 * SYNC: while painting, nothing needs syncing: both visible layers come from
 * the source video's frames. When painting stops, the top video resumes from
 * the source's position.
 *
 * PUBLIC API: window.VideoShaderRender.createVideoRenderer() returns a
 * VideoRenderer (see its typedef).
 * ======================================================================== */
(function () {
  "use strict";

  const PP = window.PaintPipeline;
  if (!PP) throw new Error("videoShaderRender: load js/paintPipeline.js first");
  const {
    PaintError, LightPipeline, LightStats, SHADER_DEFAULTS, loadShaders, decodeImage, checkGates, noticeFor,
    normalizeHex, paintSpec, mixPaint, sceneSpec, makeAdjustment, toAmount, toSatMeasure, toModel, supportsWideGamut
  } = PP;

  // ---------------------------------------------------------------- constants

  /** Default location of the shader file, relative to the page. */
  const DEFAULT_GLSL_URL = "glsl/shaderSceneRender.glsl";
  /** This page's file name, for the notices. */
  const PAGE = "videoShaderRenderer.html";
  /** Paint fade duration, in ms (as the photo page). */
  const FADE_MS = 360;

  /** VideoStats: frames are point-sampled on a grid of 1/STATS_DOWNSCALE of their size... */
  const STATS_DOWNSCALE = 8;
  /** ...once per STATS_BUCKET_S seconds of the video, until all are covered. */
  const STATS_BUCKET_S = 0.1;

  /** Ease-out cubic: fast start, gentle landing (close to the photo tiles' fade curve). */
  const easeOut = t => 1 - (1 - t) ** 3;

  // ======================================================================
  // VideoStats — whole-video statistics
  // ======================================================================

  /**
   * LightStats over ALL frames of the video, not just the current one, so the
   * sliders' effect and v3's calibration don't flicker as the light changes.
   * During the first loop, sample() adds the frame (point-sampled at 1/STATS_DOWNSCALE size)
   * once per STATS_BUCKET_S of video time; once every slice has been seen it
   * does nothing. `version` counts the samples (scene settings depend on them).
   * One VideoStats can measure several videos of the same scene (see the
   * `shareStats` option): it keeps track of the slices of each video.
   */
  class VideoStats extends LightStats {
    /** @type {Map<HTMLVideoElement, { seen: Uint8Array, left: number }>} */
    #videos = new Map();
    #mask;

    /**
     * @param {HTMLVideoElement} video  With metadata loaded.
     * @param {HTMLImageElement} mask   The wall mask.
     */
    constructor(video, mask) {
      super(Math.max(1, Math.round(video.videoWidth / STATS_DOWNSCALE)),
            Math.max(1, Math.round(video.videoHeight / STATS_DOWNSCALE)));
      this.#mask = mask;
      this.version = 0;
    }

    /** True once every part of every sampled video has been measured. */
    get complete() { return [...this.#videos.values()].every(v => v.left === 0); }

    /** Adds the video's current frame, unless its slice was already measured. */
    sample(video) {
      let v = this.#videos.get(video);
      if (!v) {
        const d = video.duration, n = d > 0 && isFinite(d) ? Math.ceil(d / STATS_BUCKET_S) : 1;
        this.#videos.set(video, v = { seen: new Uint8Array(n), left: n });
      }
      if (v.left === 0) return;
      const i = Math.min(v.seen.length - 1, Math.floor(video.currentTime / STATS_BUCKET_S));
      if (v.seen[i]) return;
      v.seen[i] = 1;
      v.left--;
      this.add(video, this.#mask);
      this.version++;
    }
  }

  // ---------------------------------------------------------------- small utilities

  /**
   * Resolves once the video has a frame to show.
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
   * Calls `cb(now)` once per new frame of `video`, from the rendering step
   * that presents it. Falls back to polling currentTime on every animation
   * frame where requestVideoFrameCallback is missing.
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
   * @property {string} mask  Wall mask URL (black = wall).
   * @property {string} initialPaint  Paint on screen at load (#rrggbb).
   * @property {"v1" | "v2" | "v3"} [initialModel="v2"]  Must match the checked model radio.
   * @property {string} [glslUrl]  Shader file (default "glsl/shaderSceneRender.glsl").
   * @property {{ stats?: VideoStats }} [shareStats]  Renderers given the same
   *   object share one VideoStats (the first to start creates it), so videos of
   *   the same scene get the same slider medians and v3 calibration.
   * @property {Object} elements  Page elements the renderer drives:
   * @property {HTMLElement} elements.app          Gets the .is-painted class.
   * @property {HTMLElement} [elements.ui]         Holds the paint / model radios it keeps checked (default: app).
   * @property {HTMLVideoElement} elements.source  The processed video (frame source).
   * @property {HTMLVideoElement | null} [elements.top]  The unprocessed video shown when
   *   not painting. Optional: without it, the source video itself shows then.
   * @property {HTMLCanvasElement} elements.canvas The painted frames.
   * @property {HTMLCanvasElement} elements.copy   The unpainted frames (frame-locked top layer).
   * @property {HTMLFieldSetElement} elements.controls  Tinting algo + sliders; disabled on failure.
   * @property {HTMLElement} elements.notice       role="status" region for notices.
   */

  /**
   * Scripting and testing handle (the page exposes it as window.videoRenderer).
   * @typedef {Object} VideoRenderer
   * @property {string} activePaintColor  Current paint, lowercase #rrggbb (read-only).
   * @property {string} activeModel  "v1" | "v2" | "v3" (read-only).
   * @property {{ contrast: number, saturation: number, satMeasure: string }} sliders  A copy.
   * @property {string} outputSpace  "srgb" or "display-p3".
   * @property {(hex: string) => void} setPaint  Fades to the paint (unless reduced motion).
   * @property {(model: string) => void} setModel
   * @property {(amount: number) => void} setContrast    -1..1, 0 = as filmed.
   * @property {(amount: number) => void} setSaturation  -1..1, 0 = as filmed.
   * @property {(measure: string) => void} setSatMeasure "full" | "chroma".
   * @property {() => void} play  Starts both videos (for when autoplay was blocked).
   * @property {() => Promise<void>} start  Boots paint previews (repeat calls return the same promise).
   * @property {Promise<void> | null} ready  start()'s promise; never rejects.
   * @property {number} framesPainted  Video frames painted so far.
   * @property {VideoStats | null} stats  The whole-video statistics.
   */

  /**
   * Creates the controller. Nothing loads or renders until start().
   * @param {VideoRendererOptions} options
   * @returns {VideoRenderer}
   */
  function createVideoRenderer(options) {
    const { app, source, canvas, copy, controls, notice } = options.elements;
    const top = options.elements.top || null;
    const ui = options.elements.ui || app;
    const glslUrl = options.glslUrl || DEFAULT_GLSL_URL;

    // ------------------------------------------------------------ state

    /** Paint the visitor picked, lowercase #rrggbb. Written by setPaint(). */
    let activePaintColor = normalizeHex(options.initialPaint);
    /** Lighting model. Written by setModel(). */
    let activeModel = toModel(options.initialModel || "v2");
    /** Slider settings, -1..1 (0 = as filmed). Written by the slider setters. */
    const sliders = { contrast: 0, saturation: 0, satMeasure: "full" };
    /**
     * The running paint fade, or null: `from` is the paint on screen when it
     * started (itself possibly mid-fade); it always ends at activePaintColor.
     * @type {{ from: object, start: number } | null}
     */
    let fade = null;

    /** @type {LightPipeline | null} */
    let pipeline = null;
    /** @type {VideoStats | null} */
    let stats = null;
    /** GPU resources: the frame, the mask and the light map. */
    let src = null, mask = null, lightMap = null;
    /** @type {CanvasRenderingContext2D | null} The frame-locked top layer. */
    let copyCtx = null;
    /** v3 scene settings, and the stats version they were built from. */
    let scene = null, sceneVersion = -1;
    /** True once the canvas holds painted frames and .is-painted is on. */
    let painting = false;
    let resumeOnRestore = false;
    /** True once onEveryFrame() is attached (it must be attached only once). */
    let watching = false;
    /** Timestamp of the last render, so rVFC and rAF never render the same frame twice. */
    let lastRenderAt = -1;
    let framesPainted = 0;
    let ready = null;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

    // ------------------------------------------------------------ UI sync

    function syncRadio(name, value) {
      for (const input of ui.querySelectorAll(`input[name="${name}"]`)) input.checked = input.value === value;
    }

    /** The --active-paint CSS variable and the checked chip. */
    function syncPaintUi(hex) {
      document.documentElement.style.setProperty("--active-paint", hex);
      syncRadio("paint", hex);
    }

    function showNotice(kind) { notice.innerHTML = noticeFor(kind, PAGE); }

    // ------------------------------------------------------------ rendering

    /** The paint to draw at time `now`: the active one, or part-way through a fade. */
    function paintAt(now) {
      const target = paintSpec(activePaintColor);
      if (!fade) return target;
      const t = Math.min(1, Math.max(0, (now - fade.start) / FADE_MS));
      if (t >= 1) { fade = null; return target; }
      return mixPaint(fade.from, target, easeOut(t));
    }

    /** v3 scene settings, rebuilt whenever the statistics gained a sample. */
    function currentScene() {
      if (sceneVersion !== stats.version) { scene = sceneSpec(stats, stats); sceneVersion = stats.version; }
      return scene;
    }

    /**
     * Paints the canvas. With `newFrame`, first uploads the source video's
     * current frame (the analysis then re-runs) and afterwards copies the same
     * frame into the top layer; otherwise reuses the frame already uploaded.
     * @param {number} now  Frame timestamp (rVFC / rAF), or performance.now().
     * @param {boolean} newFrame
     */
    function render(now, newFrame) {
      if (!painting || pipeline.lost) return;
      if (newFrame) { stats.sample(source); pipeline.upload(src, source); framesPainted++; }
      else if (now === lastRenderAt) return;
      lastRenderAt = now;
      const adjust = makeAdjustment(sliders, stats);
      pipeline.analyse({ src, mask, lightMap, model: activeModel, adjust, refY: stats.refY });
      pipeline.render({
        lightMap, src, model: activeModel, paint: paintAt(now), scene: currentScene(),
        detailGamma: SHADER_DEFAULTS.v3.detail * (adjust ? adjust.contrastK : 1)
      });
      if (newFrame) copyCtx.drawImage(source, 0, 0, copy.width, copy.height);
    }

    /** @type {number | null} Pending requestAnimationFrame id. */
    let rafId = null;
    /**
     * Re-renders on the next animation frame, and keeps doing so while a paint
     * fade runs. Used for paint, model and slider changes, which must show
     * even when the video is paused.
     */
    function requestRender() {
      rafId ??= requestAnimationFrame(now => {
        rafId = null;
        try { render(now, false); } catch (err) { fail(err); return; }
        if (fade) requestRender();
      });
    }

    /** onEveryFrame() callback for the source video. */
    function onFrame(now) {
      try { render(now, true); } catch (err) { fail(err); }
    }

    /**
     * The single error policy (as the photo page): wait out a context loss;
     * otherwise stop painting, show the plain video, disable the controls and
     * show a notice.
     */
    function fail(err) {
      if (pipeline && pipeline.lost) { resumeOnRestore = true; return; }
      painting = false;
      fade = null;
      app.classList.remove("is-painted");
      // The second video takes over: same position, playing.
      if (top) {
        if (isFinite(source.currentTime)) top.currentTime = source.currentTime;
        if (!source.paused) top.play().catch(() => {});
      }
      controls.disabled = true;
      const kind = err instanceof PaintError ? err.kind : "error";
      if (kind === "error" || kind === "webgl") console.warn("videoShaderRender:", err);
      showNotice(kind);
    }

    /** LightPipeline hook: everything is rebuilt; redraw the current frame (or resume the boot). */
    function onRestored() {
      try {
        if (painting) render(performance.now(), true);
        else if (resumeOnRestore) { resumeOnRestore = false; startPainting().catch(fail); }
      } catch (err) { fail(err); }
    }

    // ------------------------------------------------------------ public setters

    /**
     * Sets the wall paint (any #rrggbb). The UI updates at once; the walls fade
     * to it over FADE_MS (instantly with reduced motion).
     * @throws {TypeError} When `hex` isn't #rrggbb.
     */
    function setPaint(hex) {
      hex = normalizeHex(hex);
      const now = performance.now();
      const shown = paintAt(now);                 // where a running fade has got to
      activePaintColor = hex;
      syncPaintUi(hex);
      fade = painting && !reducedMotion.matches ? { from: shown, start: now } : null;
      requestRender();
    }

    /** Switches the lighting model ("v1" | "v2" | "v3"). @throws {RangeError} */
    function setModel(model) {
      activeModel = toModel(model);
      syncRadio("model", model);
      requestRender();
    }

    /** Contrast of the video's light before the paint (-1..1, 0 = as filmed). @throws {RangeError} */
    function setContrast(amount) { sliders.contrast = toAmount(amount); requestRender(); }

    /** Saturation of the video's light before the paint (-1..1, 0 = as filmed). @throws {RangeError} */
    function setSaturation(amount) { sliders.saturation = toAmount(amount); requestRender(); }

    /** How saturation measures difference from white ("full" | "chroma"). @throws {RangeError} */
    function setSatMeasure(measure) {
      sliders.satMeasure = toSatMeasure(measure);
      syncRadio("satMeasure", measure);
      requestRender();
    }

    /** Starts the video(s); needed only if the browser blocked autoplay. */
    function play() {
      for (const video of painting || !top ? [source] : [source, top]) if (video.paused) video.play().catch(() => {});
    }

    // ------------------------------------------------------------ boot

    /**
     * Turns paint previews on. Any throw ends up in fail(), which leaves the
     * plain video and a notice.
     *  1. Gates: ?nogl, file://, CSS luminance mask support.
     *  2. In parallel: load the shaders, decode the mask, wait for the first frame.
     *  3. Create the LightPipeline at the video's own size, its textures, and
     *     the VideoStats.
     *  4. Paint the current frame and copy it into the top layer, THEN add
     *     .is-painted. CSS swaps the top video for the masked frame copy and
     *     fades the painted canvas in over the source video (the same frame,
     *     unpainted), so the paint fades in over the original walls.
     *  5. Paint every new frame from now on.
     */
    async function startPainting() {
      checkGates();
      const [sources, maskImg] = await Promise.all([loadShaders(glslUrl), decodeImage(options.mask), videoReady(source)]);
      if (!pipeline) {
        const size = [source.videoWidth, source.videoHeight];
        pipeline = new LightPipeline(canvas, {
          analysis: size, render: size, sources, hooks: { onRestored, onError: fail },
          wideGamut: supportsWideGamut()
        });
        src = pipeline.createSource(...size);
        mask = pipeline.createSource(maskImg.naturalWidth, maskImg.naturalHeight, { mipmaps: true });
        pipeline.upload(mask, maskImg);
        lightMap = pipeline.createLightMap();
        stats = options.shareStats ? (options.shareStats.stats ??= new VideoStats(source, maskImg))
                                   : new VideoStats(source, maskImg);
        Object.assign(copy, { width: size[0], height: size[1] });
        copyCtx = copy.getContext("2d");
      }
      painting = true;
      render(performance.now(), true);
      if (top) top.pause();            // the frame copy replaces it (and saves a decoder)
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
      get sliders() { return { ...sliders }; },
      get stats() { return stats; },
      get outputSpace() { return pipeline ? pipeline.outputSpace : "srgb"; },
      setPaint, setModel, setContrast, setSaturation, setSatMeasure, play,
      start() { return (ready ??= startPainting().catch(fail)); }
    };
  }

  // ---------------------------------------------------------------- export
  window.VideoShaderRender = {
    createVideoRenderer, VideoStats,
    DEFAULT_GLSL_URL, FADE_MS, STATS_DOWNSCALE, STATS_BUCKET_S
  };
})();
