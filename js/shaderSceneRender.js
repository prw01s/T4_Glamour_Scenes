/* ==========================================================================
 * shaderSceneRender.js — the controller behind shaderSceneRenderer.html.
 *
 * Paints a room's walls under morning, noon and night light. Each photo is
 * used as a LIGHT MAP: the wall paint is re-lit by the light at every pixel,
 * then CSS luminance masks keep everything that isn't wall original.
 *
 * The GPU work, colour science and statistics live in js/paintPipeline.js
 * (window.PaintPipeline), which must be loaded first; the shaders are in
 * glsl/shaderSceneRender.glsl. This file owns the page side: the tiles,
 * rooms, fades, room switching, sliders and errors.
 *
 * --------------------------------------------------------------------------
 * DATA FLOW (per photo; see LightPipeline in js/paintPipeline.js)
 *
 *   <img> photo (2048² sRGB JPEG)
 *     │  uploaded once, at the render size R (mipmapped)
 *     ▼
 *   source          RGBA8, R x R
 *     │  analyse(): DECODE -> [ADJUST] -> BLUR -> ANALYSE, at A = 1024
 *     ▼
 *   light map       RGBA16F, A x A, one per photo; cached until the model,
 *                   the sliders or (v3) the calibration change
 *     │  render(): RENDER at R, then copied with drawImage, in the same
 *     ▼  task, into a tile's 2D canvas
 *   tile canvas     R x R
 *
 * R follows the tiles' size on screen (CSS width x devicePixelRatio, in steps
 * of 256), from A up to the photos' own 2048, so large screens get the full
 * resolution and small ones don't pay for it. It is chosen once, at boot.
 *
 * --------------------------------------------------------------------------
 * TILES (one per time of day). The page builds this markup:
 *
 *   figure.scene[data-time]
 *     .scene__frame
 *       .scene__layer--bottom  canvas (base) + canvas (incoming)
 *       .scene__layer--top     img.scene__photo[data-room] per room
 *
 *   base      what is shown, under the masked photo
 *   incoming  the next paint, faded in over base and then committed to it
 *   Under .is-painted, each photo carries a luminance mask whose black (wall)
 *   pixels are transparent, so the painted canvas shows through exactly where
 *   the walls are. renderer[data-room] picks which room's photos are visible.
 *
 * ROOMS: each room has its photos' sources and light maps, its mask (on the
 * GPU too: BLUR keeps furniture out of the wall's light), per-photo
 * LightStats (v3's scene adaptation) and their pooled LightStats (the
 * sliders' medians and v3's reference white).
 *
 * STATE (inside createRenderer): activePaintColor / activeModel / activeRoom
 * and the sliders are what the visitor asked for. shownRoom is the room
 * actually on screen; it lags activeRoom while the new room loads.
 *
 * LIFECYCLE
 *   boot          start(): gates -> shaders -> LightPipeline at size R ->
 *                 prepare the shown room + decode masks -> seed canvases with
 *                 the photos -> add .is-painted -> fade the paint in ->
 *                 prepare other rooms when idle.
 *   paint/model   setPaint() / setModel() -> scheduleRender() (one per frame)
 *                 -> flush() -> staggered fades.
 *   sliders       setContrast() / setSaturation() / setSatMeasure() ->
 *                 scheduleRender(false) -> flush() -> instant repaint, so the
 *                 walls follow the thumb while dragging.
 *   room switch   setRoom() -> prepareRoom() -> settle fades -> view
 *                 transition around swap(): data-room + instant repaint().
 *   context loss  LightPipeline rebuilds itself and its textures, then
 *                 onRestored() repaints (or resumes an interrupted boot).
 *   failure       fail(): drop .is-painted (plain photos) and show a notice.
 *
 * PUBLIC API: window.ShaderSceneRender.createRenderer() returns a
 * SceneRenderer (see its typedef).
 * ======================================================================== */
(function () {
  "use strict";

  const PP = window.PaintPipeline;
  if (!PP) throw new Error("shaderSceneRender: load js/paintPipeline.js first");
  const {
    PaintError, LightPipeline, LightStats, SHADER_DEFAULTS, loadShaders, decodeImage, checkGates, noticeFor,
    normalizeHex, lrv, paintSpec, sceneSpec, makeAdjustment, toAmount, toSatMeasure, toModel, supportsWideGamut
  } = PP;

  // ---------------------------------------------------------------- constants

  /** Analysis size A: light maps are A x A. Noise and texture average out here. */
  const ANALYSIS_SIZE = 1024;
  /** Largest render size R (the photos are 2048²). */
  const MAX_RENDER_SIZE = 2048;
  /** LightStats measure each photo at this size. */
  const STATS_SIZE = 64;
  /** Paint fade duration, and the delay between successive tiles (morning -> noon -> night), in ms. */
  const FADE_MS = 360, STAGGER_MS = 70;
  /** Default location of the shader file, relative to the page. */
  const DEFAULT_GLSL_URL = "glsl/shaderSceneRender.glsl";
  /** This page's file name, for the notices. */
  const PAGE = "shaderSceneRenderer.html";

  /**
   * The render size for tiles shown in `frame`: its device-pixel width,
   * rounded up to a multiple of 256, between ANALYSIS_SIZE and the photo size.
   * @param {HTMLElement} frame
   * @param {number} photoSize
   */
  function renderSizeFor(frame, photoSize) {
    const device = frame.getBoundingClientRect().width * (window.devicePixelRatio || 1);
    return Math.max(ANALYSIS_SIZE, Math.min(MAX_RENDER_SIZE, photoSize, Math.ceil(device / 256) * 256));
  }

  // ======================================================================
  // SceneTile — base canvas + incoming canvas under the masked photo
  // ======================================================================

  /**
   * Controls one tile's two canvases.
   *
   *   base      the committed image the visitor sees under the masked photo
   *   incoming  stacked above base at opacity 0. A new paint is drawn here
   *             and faded in; when the fade ends it is copied into base and
   *             hidden again.
   *
   * Fade state machine: `anim` is null when idle, or the running Animation.
   * Only incoming fades. If both canvases cross-faded, the frame's background
   * would show through at the midpoint (about 25 %).
   */
  class SceneTile {
    /**
     * @param {HTMLElement} figure  A figure.scene (see "TILES" in the header).
     * @param {"srgb" | "display-p3"} colorSpace  Of both canvases (must match
     *   the pipeline's output so nothing is lost in the copy).
     */
    constructor(figure, colorSpace) {
      /** @type {string} The figure's data-time ("morning" | "noon" | "night"). */
      this.time = figure.dataset.time;
      /** @type {HTMLElement} */
      this.frame = figure.querySelector(".scene__frame");
      [this.base, this.incoming] = figure.querySelectorAll("canvas");
      this.baseCtx = this.base.getContext("2d", { colorSpace });
      this.inCtx = this.incoming.getContext("2d", { colorSpace });
      /** @type {Record<string, HTMLImageElement>} This tile's photo for each room key. */
      this.imgs = Object.fromEntries([...figure.querySelectorAll("img")].map(img => [img.dataset.room, img]));
      /** @type {Animation | null} The running fade of `incoming`, if any. */
      this.anim = null;
      this.n = this.base.width;
    }

    /** Sets both canvases to n x n (this clears them). */
    resize(n) {
      this.n = n;
      for (const c of [this.base, this.incoming]) c.width = c.height = n;
    }

    /**
     * Draws the room's original photo into base. Under the mask, the walls then
     * look exactly like the plain photo until the first paint fades in.
     * @param {string} room  Room key.
     */
    seed(room) {
      this.baseCtx.imageSmoothingQuality = "high";
      this.baseCtx.drawImage(this.imgs[room], 0, 0, this.n, this.n);
    }

    /**
     * Shows a new paint, drawn by `draw(ctx)`.
     *  - animate = false: finish any fade, then draw straight into base (instant).
     *  - animate = true: draw into incoming and fade it in after `delay` ms.
     *    If a fade is already running, incoming is simply redrawn and the same
     *    fade carries on. Rapid clicks never restart or stack fades.
     * @param {(ctx: CanvasRenderingContext2D) => void} draw
     * @param {boolean} animate
     * @param {number} [delay=0]  Stagger, in ms.
     * @returns {Promise<void>} Resolves when the tile has settled. Never rejects.
     */
    present(draw, animate, delay = 0) {
      if (!animate) {
        this.settle();
        draw(this.baseCtx);
        return Promise.resolve();
      }
      draw(this.inCtx);
      if (!this.anim) {
        // fill "both": incoming holds opacity 0 during the delay and 1 at the
        // end, until settle() commits it and cancels the animation.
        const anim = this.incoming.animate([{ opacity: 0 }, { opacity: 1 }],
          { duration: FADE_MS, delay, easing: "cubic-bezier(.2, 0, 0, 1)", fill: "both" });
        anim.onfinish = () => { if (this.anim === anim) this.settle(); };
        this.anim = anim;
      }
      return this.anim.finished.then(() => {}, () => {});
    }

    /**
     * Ends any running fade at once. Copying incoming into base BEFORE cancel()
     * (which drops incoming back to opacity 0), in the same task, means no
     * frame ever shows the old paint. Safe to call when idle.
     */
    settle() {
      const anim = this.anim;
      if (!anim) return;
      this.anim = null;
      this.baseCtx.drawImage(this.incoming, 0, 0);
      anim.cancel();
    }
  }

  /**
   * Runs `cb` when the main thread is idle (at the latest after 2 s). Safari has
   * no requestIdleCallback, so there a short timeout is used instead.
   */
  function whenIdle(cb) {
    if ("requestIdleCallback" in window) requestIdleCallback(cb, { timeout: 2000 });
    else setTimeout(cb, 200);
  }

  // ======================================================================
  // createRenderer — the controller for one page
  // ======================================================================

  /**
   * A room's assets.
   * @typedef {Object} Room
   * @property {string} label  Name shown in the room switch and used in alt text.
   * @property {string} mask   Wall mask, same framing as the photos. Black = wall,
   *                           white = everything else.
   * @property {Record<string, string>} photos  One photo per time of day.
   */

  /**
   * @typedef {Object} RendererOptions
   * @property {Record<string, Room>} rooms  Every room, keyed like the photos' data-room values.
   * @property {string} initialPaint  Paint on screen at load (#rrggbb).
   * @property {"v1" | "v2" | "v3"} [initialModel="v2"]  Must match the checked model radio.
   * @property {string} [glslUrl]  Shader file (default "glsl/shaderSceneRender.glsl").
   * @property {Object} elements  Page elements the renderer drives:
   * @property {HTMLElement} elements.app         Gets the .is-painted class.
   * @property {HTMLElement} elements.renderer    Holds the figure.scene tiles; its
   *   data-room is the initially shown room.
   * @property {HTMLFieldSetElement} elements.controls  Tinting algo + sliders; disabled on failure.
   * @property {HTMLElement} elements.notice      role="status" region for notices.
   * @property {HTMLElement} elements.readoutHex  Shows the active paint's hex.
   * @property {HTMLElement} elements.readoutLrv  Shows the active paint's LRV.
   */

  /**
   * Scripting and testing handle returned by createRenderer() (the page
   * exposes it as window.sceneRenderer). Setters return a promise that
   * resolves when the walls show the change.
   * @typedef {Object} SceneRenderer
   * @property {string} activePaintColor  Current paint, lowercase #rrggbb (read-only).
   * @property {string} activeRoom        Requested room key (read-only).
   * @property {string} activeModel       "v1" | "v2" | "v3" (read-only).
   * @property {{ contrast: number, saturation: number, satMeasure: string }} sliders  A copy.
   * @property {number} size              Tile canvas size in pixels (R), once started.
   * @property {string} outputSpace       "srgb" or "display-p3".
   * @property {(hex: string) => Promise<void>} setPaint
   * @property {(room: string) => Promise<void>} setRoom
   * @property {(model: string) => Promise<void>} setModel
   * @property {(amount: number) => Promise<void>} setContrast    -1..1, 0 = as shot.
   * @property {(amount: number) => Promise<void>} setSaturation  -1..1, 0 = as shot.
   * @property {(measure: string) => Promise<void>} setSatMeasure "full" | "chroma".
   * @property {() => Promise<void>} start  Boots paint previews (repeat calls return the same promise).
   * @property {Promise<void> | null} ready  start()'s promise; never rejects.
   * @property {(room: string) => object | undefined} roomInfo  A prepared room's statistics and scene settings.
   * @property {(tile: string | number, x: number, y: number) => number[]} sample
   *   One pixel of a tile's painted canvas, [r, g, b] in encoded sRGB.
   */

  /**
   * Creates the controller for a page whose tiles are already in the DOM.
   * Syncs the paint readout at once; nothing loads or renders until start().
   * @param {RendererOptions} options
   * @returns {SceneRenderer}
   */
  function createRenderer(options) {
    const { rooms, elements } = options;
    const { app, renderer, controls, notice, readoutHex, readoutLrv } = elements;
    const glslUrl = options.glslUrl || DEFAULT_GLSL_URL;

    // ------------------------------------------------------------ state

    /** Paint on the walls, lowercase #rrggbb. Written by setPaint(). */
    let activePaintColor = normalizeHex(options.initialPaint);
    /** Room the visitor asked for (rooms key). Written by setRoom() at once. */
    let activeRoom = renderer.dataset.room;
    /** Lighting model. Written by setModel(). */
    let activeModel = toModel(options.initialModel || "v2");
    /** Slider settings, -1..1 (0 = as shot). Written by the slider setters. */
    const sliders = { contrast: 0, saturation: 0, satMeasure: "full" };
    /** Room actually on screen; changes only inside setRoom()'s swap(). */
    let shownRoom = activeRoom;

    /** @type {LightPipeline | null} Created by startPainting(). */
    let pipeline = null;
    /** True once the paint is live (.is-painted is on and the canvases hold paint). */
    let painting = false;
    /** Set when a failure was caused by context loss, so the restore should retry booting. */
    let resumeOnRestore = false;
    /** start()'s promise, once started. */
    let ready = null;
    /** Read on every change, so the OS setting can change while the page is open. */
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    /** Both tile canvases and the pipeline use this colour space. */
    const colorSpace = supportsWideGamut() ? "display-p3" : "srgb";

    /** The tiles, in DOM order (index = stagger position). */
    const tiles = [...renderer.querySelectorAll(".scene")].map(f => new SceneTile(f, colorSpace));

    // ------------------------------------------------------------ UI sync

    /** Checks the radio in group `name` whose value is `value` and unchecks the others. */
    function syncRadio(name, value) {
      for (const input of app.querySelectorAll(`input[name="${name}"]`)) input.checked = input.value === value;
    }

    /** The --active-paint CSS variable, the checked chip and the hex + LRV readout. */
    function syncPaintUi(hex) {
      document.documentElement.style.setProperty("--active-paint", hex);
      syncRadio("paint", hex);
      readoutHex.textContent = hex.toUpperCase();
      readoutLrv.textContent = `LRV ${lrv(hex)}`;
    }

    /** Shows a notice in the role="status" live region. */
    function showNotice(kind) { notice.innerHTML = noticeFor(kind, PAGE); }

    // ------------------------------------------------------------ rooms

    /**
     * A prepared room.
     * @typedef {Object} RoomData
     * @property {{ img: HTMLImageElement, src: object, lightMap: object, stats: LightStats, scene: object }[]} entries
     *   One per tile, in tile order.
     * @property {object} mask        The mask's source texture.
     * @property {LightStats} stats   Pooled over the room's photos.
     */
    /** @type {Record<string, RoomData>} */
    const roomData = {};
    /** @type {Record<string, Promise<RoomData>>} In-flight or finished loads (deduplicates calls). */
    const roomLoading = {};
    /** @type {Record<string, Promise<HTMLImageElement>>} Decoded masks. */
    const maskLoading = {};

    /** The room's mask, decoded (once). */
    function maskImage(room) {
      return (maskLoading[room] ??= decodeImage(rooms[room].mask).catch(err => { delete maskLoading[room]; throw err; }));
    }

    /** The ADJUST settings for a room's photos, or null when the sliders are centred. */
    function adjustmentFor(data) { return makeAdjustment(sliders, data.stats); }

    /** Runs (or reuses) one photo's analysis for the current model and sliders. */
    function analyse(entry, data) {
      pipeline.analyse({ src: entry.src, mask: data.mask, lightMap: entry.lightMap, model: activeModel,
                         adjust: adjustmentFor(data), refY: data.stats.refY });
    }

    /**
     * Gets a room ready to show, once: waits for its photos and mask to decode,
     * measures their statistics and uploads them. On every call, makes sure
     * each photo is analysed for the CURRENT model and sliders (which is how a
     * hidden room catches up lazily). A failed load can be retried.
     * @param {string} room
     * @returns {Promise<RoomData>}
     * @throws {PaintError} "load" when a photo or mask can't be decoded.
     */
    function prepareRoom(room) {
      roomLoading[room] ??= (async () => {
        const imgs = tiles.map(t => t.imgs[room]);
        // decode() can reject for benign reasons (e.g. already decoded); it
        // counts as a failure only if the image really has no pixels.
        const [maskImg] = await Promise.all([maskImage(room), ...imgs.map(img => img.decode().catch(() => {
          if (!img.naturalWidth) throw new PaintError("load", `Couldn't load ${img.src}`);
        }))]);
        const mask = pipeline.createSource(maskImg.naturalWidth, maskImg.naturalHeight, { mipmaps: true });
        pipeline.upload(mask, maskImg);
        const n = pipeline.rw;
        const entries = imgs.map(img => {
          const stats = new LightStats(STATS_SIZE, STATS_SIZE);
          stats.add(img, maskImg);
          const src = pipeline.createSource(n, n, { mipmaps: n > ANALYSIS_SIZE });
          pipeline.upload(src, img);
          return { img, src, stats, lightMap: pipeline.createLightMap(), scene: null };
        });
        const stats = LightStats.combine(entries.map(e => e.stats));
        for (const e of entries) e.scene = sceneSpec(e.stats, stats);
        return (roomData[room] = { entries, mask, stats });
      })().catch(err => { delete roomLoading[room]; throw err; });
      return roomLoading[room].then(data => {
        for (const entry of data.entries) analyse(entry, data);
        return data;
      });
    }

    // ------------------------------------------------------------ rendering

    /**
     * A draw callback for SceneTile.present(): renders one photo with the
     * current paint, model and sliders, then copies the pipeline's canvas into
     * the tile canvas right away (the next render overwrites it).
     */
    function drawer(entry, data) {
      return ctx => {
        analyse(entry, data);
        const adjust = adjustmentFor(data);
        pipeline.render({
          lightMap: entry.lightMap, src: entry.src, model: activeModel, paint: paintSpec(activePaintColor),
          scene: entry.scene, detailGamma: SHADER_DEFAULTS.v3.detail * (adjust ? adjust.contrastK : 1)
        });
        ctx.drawImage(pipeline.canvas, 0, 0);
      };
    }

    /** @type {Promise<void> | null} The pending frame's promise, shared by every caller in that frame. */
    let frame = null;
    /** Whether the pending frame fades; true if any caller in that frame asked to. */
    let frameAnimates = false;
    /**
     * Requests an update on the next animation frame. Any number of calls
     * before that frame collapse into one flush(), which uses the state as it
     * is then (so the last setPaint wins).
     * @param {boolean} [animate=true]  false = repaint instantly (the sliders).
     * @returns {Promise<void>} Resolves when that frame's fades have finished.
     */
    function scheduleRender(animate = true) {
      frameAnimates ||= animate;
      frame ??= new Promise(resolve => requestAnimationFrame(() => {
        const fades = frameAnimates;
        frame = null; frameAnimates = false;
        resolve(flush(fades));
      }));
      return frame;
    }

    /**
     * Renders the shown room, fading the tiles in one after the other (each
     * STAGGER_MS after the previous one), or instantly with reduced motion or
     * `fades` false. Does nothing before painting starts or while the context
     * is lost.
     * @param {boolean} fades
     */
    function flush(fades) {
      if (!painting || pipeline.lost) return;
      try {
        const data = roomData[shownRoom], animate = fades && !reducedMotion.matches;
        return Promise.all(tiles.map((tile, i) =>
          tile.present(drawer(data.entries[i], data), animate, i * STAGGER_MS))).then(() => {});
      } catch (err) { fail(err); }
    }

    /**
     * Renders the shown room into every base canvas instantly. Used for room
     * swaps (inside the view transition) and after a context restore.
     * @throws {Error} GL errors, which callers route to fail().
     */
    function repaint() {
      const data = roomData[shownRoom];
      tiles.forEach((tile, i) => tile.present(drawer(data.entries[i], data), false));
    }

    /**
     * The single error policy.
     *  - Context lost: wait for webglcontextrestored (onRestored retries the
     *    boot if needed).
     *  - Anything else: stop painting, remove the masks (visitors see the plain
     *    photos), disable the controls and show a notice.
     */
    function fail(err) {
      if (pipeline && pipeline.lost) { resumeOnRestore = true; return; }
      painting = false;
      app.classList.remove("is-painted");
      for (const tile of tiles) tile.settle();
      controls.disabled = true;
      const kind = err instanceof PaintError ? err.kind : "error";
      if (kind === "error" || kind === "webgl") console.warn("shaderSceneRender:", err);
      showNotice(kind);
    }

    /** LightPipeline hook: everything is rebuilt; repaint, or resume the boot. */
    function onRestored() {
      try {
        if (painting) repaint();
        else if (resumeOnRestore) { resumeOnRestore = false; startPainting().catch(fail); }
      } catch (err) { fail(err); }
    }

    // ------------------------------------------------------------ public setters

    /**
     * Sets the wall paint (any #rrggbb). The UI updates at once; the walls fade
     * to it on the next frame.
     * @throws {TypeError} When `hex` isn't #rrggbb.
     */
    function setPaint(hex) {
      hex = normalizeHex(hex);
      activePaintColor = hex;
      syncPaintUi(hex);
      return scheduleRender();
    }

    /**
     * Switches the lighting model ("v1" | "v2" | "v3"). Visible photos are
     * re-analysed on the next frame; hidden rooms catch up when shown.
     * @throws {RangeError} For an unknown model.
     */
    function setModel(model) {
      activeModel = toModel(model);
      syncRadio("model", model);
      return scheduleRender();
    }

    /**
     * Contrast of the photos' light before the paint is applied (-1..1, 0 =
     * as shot): a luminance exponent of 0.5..2 around the room's median.
     * @throws {RangeError} When `amount` isn't a number.
     */
    function setContrast(amount) { sliders.contrast = toAmount(amount); return scheduleRender(false); }

    /**
     * Saturation of the photos' light before the paint is applied (-1..1, 0 =
     * as shot): each pixel's chroma is scaled by 2^(amount x its difference
     * from white / the room's median difference).
     * @throws {RangeError} When `amount` isn't a number.
     */
    function setSaturation(amount) { sliders.saturation = toAmount(amount); return scheduleRender(false); }

    /**
     * How the saturation slider measures difference from white ("full" |
     * "chroma"). No visible change while saturation is 0.
     * @throws {RangeError} For an unknown measure.
     */
    function setSatMeasure(measure) {
      sliders.satMeasure = toSatMeasure(measure);
      syncRadio("satMeasure", measure);
      return scheduleRender(false);
    }

    /** Bumped on every setRoom call; only the latest call may swap rooms. */
    let roomToken = 0;
    /**
     * Shows another room.
     *  1. Updates the requested room and the radios at once.
     *  2. Prepares the room (load, upload, analyse) while the old one stays up.
     *  3. If a newer setRoom call started meanwhile, stops (last call wins).
     *  4. Settles running fades, so the view transition snapshots a stable image.
     *  5. Runs swap() inside document.startViewTransition: flip data-room (CSS
     *     shows the other photos and masks) and repaint the canvases
     *     synchronously, so the "new" snapshot is complete. Without the API,
     *     or with reduced motion, swap() runs directly.
     * If painting has failed, only the photos are swapped.
     * @throws {RangeError} For an unknown room.
     */
    async function setRoom(room) {
      if (!(room in rooms)) throw new RangeError(`Unknown room "${room}"`);
      activeRoom = room;
      syncRadio("room", room);
      const token = ++roomToken;
      if (painting) {
        try { await prepareRoom(room); } catch (err) { fail(err); }
      }
      if (token !== roomToken || room === shownRoom) return;
      for (const tile of tiles) tile.settle();
      const swap = () => {
        shownRoom = room;
        renderer.dataset.room = room;
        if (painting && !pipeline.lost) {
          try { repaint(); } catch (err) { fail(err); }
        }
      };
      if (reducedMotion.matches || !document.startViewTransition) { swap(); return; }
      await document.startViewTransition(swap).finished;
    }

    // ------------------------------------------------------------ boot

    /**
     * Turns paint previews on. Any throw ends up in fail().
     *  1. Gates, cheapest first: ?nogl, file://, CSS luminance mask support.
     *  2. Load the shaders; create the LightPipeline at the render size for
     *     the tiles' current size on screen (it can throw "webgl").
     *  3. Prepare the shown room and decode every mask. If the visitor switched
     *     rooms meanwhile, loop and prepare the new one.
     *  4. Seed each base canvas with the original photo, THEN add .is-painted:
     *     the masks reveal canvases that look identical to the photos.
     *  5. Fade the paint in, and prepare the other rooms when idle.
     */
    async function startPainting() {
      checkGates();
      if (!pipeline) {
        const sources = await loadShaders(glslUrl);
        const firstPhoto = Object.values(tiles[0].imgs)[0];
        const photoSize = firstPhoto.naturalWidth || +firstPhoto.getAttribute("width") || MAX_RENDER_SIZE;
        const n = renderSizeFor(tiles[0].frame, photoSize);
        pipeline = new LightPipeline(document.createElement("canvas"), {
          analysis: [ANALYSIS_SIZE, ANALYSIS_SIZE], render: [n, n], sources,
          hooks: { onRestored, onError: fail },
          wideGamut: colorSpace === "display-p3",
          // The canvas is copied out with drawImage right after each render.
          preserveDrawingBuffer: true
        });
        for (const tile of tiles) tile.resize(n);
      }
      const masks = Promise.all(Object.keys(rooms).map(maskImage));
      let room;
      do {
        room = shownRoom;
        await Promise.all([prepareRoom(room), masks]);
      } while (room !== shownRoom);
      for (const tile of tiles) tile.seed(room);
      painting = true;
      controls.disabled = false;
      notice.textContent = "";
      app.classList.add("is-painted");
      whenIdle(() => {
        for (const other of Object.keys(rooms)) if (other !== shownRoom) prepareRoom(other).catch(fail);
      });
      await scheduleRender();
    }

    // ------------------------------------------------------------ handle

    // 1 x 1 readback canvas for sample() (sRGB). willReadFrequently keeps it on
    // the CPU, so getImageData is cheap; reading the tile canvases directly
    // would push THEM to the CPU and slow every later drawImage into them.
    const sampler = Object.assign(document.createElement("canvas"), { width: 1, height: 1 })
      .getContext("2d", { willReadFrequently: true });
    sampler.imageSmoothingEnabled = false;

    syncPaintUi(activePaintColor);

    /** @type {SceneRenderer} */
    return {
      get activePaintColor() { return activePaintColor; },
      get activeRoom() { return activeRoom; },
      get activeModel() { return activeModel; },
      get ready() { return ready; },
      get sliders() { return { ...sliders }; },
      get size() { return tiles[0].n; },
      get outputSpace() { return pipeline ? pipeline.outputSpace : colorSpace; },
      setPaint, setRoom, setModel, setContrast, setSaturation, setSatMeasure,
      start() { return (ready ??= startPainting().catch(fail)); },
      roomInfo(room) {
        const d = roomData[room];
        return d && { stats: d.stats, photos: d.entries.map(e => ({ stats: e.stats, scene: e.scene })) };
      },
      /**
       * Reads one pixel of the painted canvas UNDER the mask: the wall paint
       * everywhere, not what the visitor sees outside the walls. During a fade
       * it reads incoming (the newest paint); otherwise base.
       * @param {string | number} tile  Tile data-time ("morning", ...) or index.
       * @param {number} x  Canvas pixel column, 0..size-1.
       * @param {number} y  Canvas pixel row, 0..size-1, from the top.
       * @returns {number[]} [r, g, b], 0..255, encoded sRGB.
       */
      sample(tile, x, y) {
        const t = typeof tile === "number" ? tiles[tile] : tiles.find(s => s.time === tile);
        if (!t) throw new RangeError(`Unknown tile "${tile}"`);
        sampler.clearRect(0, 0, 1, 1);
        sampler.drawImage(t.anim ? t.incoming : t.base, Math.round(x), Math.round(y), 1, 1, 0, 0, 1, 1);
        const [r, g, b] = sampler.getImageData(0, 0, 1, 1).data;
        return [r, g, b];
      }
    };
  }

  // ---------------------------------------------------------------- export
  window.ShaderSceneRender = {
    createRenderer, SceneTile,
    ANALYSIS_SIZE, MAX_RENDER_SIZE, STATS_SIZE, FADE_MS, STAGGER_MS, DEFAULT_GLSL_URL
  };
})();
