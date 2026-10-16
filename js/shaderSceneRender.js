/* ==========================================================================
 * shaderSceneRender.js — the engine behind shaderSceneRenderer.html.
 *
 * Paints a room's walls under morning, noon and night light. Each photo is
 * used as a LIGHT MAP: the wall colour is re-lit by the light at every pixel,
 * then CSS luminance masks keep everything that isn't wall original.
 *
 * The shaders live in glsl/shaderSceneRender.glsl and are fetched at runtime
 * by loadShaders(). They and the WebGL host helpers are ported from
 * js/tinted-wall-v2.js (v2 perception-aware model + v1 HSV model; v1 also
 * lives in glsl/wall_lighting.glsl). Unlike TintedWall.create(), which
 * allocates a full-size GPU pipeline per image (~170 MB at 2048²), all photos
 * here share one off-DOM WebGL2 context at a fixed N x N working size.
 *
 * Loaded as a classic script (not an ES module), so it also loads from
 * file://. The page can then still build its markup and show the
 * "needs http" notice instead of a blank page.
 *
 * --------------------------------------------------------------------------
 * DATA FLOW (per photo, all on the GPU except the first and last hop)
 *
 *   <img> photo (2048² sRGB JPEG)
 *     │  drawImage into an N x N scratch 2D canvas (high-quality downscale)
 *     ▼
 *   texA            RGBA8, N x N, one per photo ("entry")
 *     │  P0  DECODE   sRGB -> linear light                    -> lin
 *     │  P0b BLUR     separable Gaussian, v2 only              -> tmp -> blurred
 *     │  P1  ANALYSE  light minus white light, per pixel       -> entry.theArray
 *     ▼
 *   theArray        RGBA16F, N x N, one per photo; cached until the model changes
 *     │  P2  RENDER   wall paint lit by theArray               -> drawing buffer
 *     ▼
 *   WebGL canvas    copied with drawImage, in the same task, into a tile's 2D canvas
 *
 * N is fixed for every surface because DECODE reads texA with texelFetch at
 * gl_FragCoord, and RENDER walks theArray with row * W + col: texA, the
 * scratch targets, theArray and the drawing buffer must all be N x N.
 * Memory at N = 1024: 3 shared RGBA16F targets (24 MB) + 6 x (RGBA8 texA
 * 4 MB + RGBA16F theArray 8 MB) + drawing buffer ≈ 135 MB.
 *
 * --------------------------------------------------------------------------
 * TILES (one per time of day). The page builds this markup:
 *
 *   figure.scene[data-time]
 *     .scene__frame
 *       .scene__layer--bottom  canvas (base) + canvas (incoming), N x N
 *       .scene__layer--top     img.scene__photo[data-room] per room
 *
 *   base      what is shown, under the masked photo
 *   incoming  the next paint, faded in over base and then committed to it
 *   Under .is-painted, each photo carries a luminance mask whose black (wall)
 *   pixels are transparent, so the painted canvas shows through exactly where
 *   the walls are. renderer[data-room] picks which room's photos are visible.
 *
 * STATE (inside createRenderer): activePaintColor / activeModel / activeRoom
 * are what the visitor asked for. shownRoom is the room actually on screen;
 * it lags activeRoom while the new room's photos load and analyse.
 *
 * LIFECYCLE
 *   boot          start(): feature gates -> load shaders -> WallShader ->
 *                 prepare the shown room + decode masks -> seed canvases with
 *                 the photos -> add .is-painted -> fade the paint in ->
 *                 prepare other rooms when idle.
 *   paint/model   setPaint() / setModel() -> scheduleRender() (one per frame)
 *                 -> flush() -> staggered fades.
 *   room switch   setRoom() -> prepareRoom() -> settle fades -> view
 *                 transition around swap(): data-room + instant repaint().
 *   context loss  WallShader rebuilds itself on webglcontextrestored, then
 *                 onRestored() repaints (or resumes an interrupted boot).
 *   failure       fail(): drop .is-painted (plain photos) and show a notice.
 *
 * PUBLIC API: window.ShaderSceneRender (see the export at the end). The page
 * calls ShaderSceneRender.createRenderer(), which returns a SceneRenderer.
 * ======================================================================== */
(function () {
  "use strict";

  // ---------------------------------------------------------------- constants

  /**
   * Working size in pixels. Every photo is downscaled to N x N, and every GPU
   * surface and tile canvas is N x N (see "DATA FLOW" above for why it must be
   * one fixed size). The page uses it for the tile canvases' width/height.
   * @type {number}
   */
  const N = 1024;           // working size of every photo (texA, targets and drawing buffer must match)

  /** Paint fade duration, and the delay between successive tiles (morning -> noon -> night), in ms. */
  const FADE_MS = 360, STAGGER_MS = 70;

  /** Default location of the shader file, relative to the page. */
  const DEFAULT_GLSL_URL = "glsl/shaderSceneRender.glsl";

  /**
   * Lighting-model settings passed to the shaders as uniforms (see RENDER in
   * the .glsl file). Same values as DEFAULTS in js/tinted-wall-v2.js, minus
   * `replaceImage`.
   *
   *  model        Ignored here: the renderer's activeModel is used instead.
   *  wallHSL      Ignored here: the paint comes from activePaintColor via hexToHsl().
   *  warmCCT      Colour temperature, in kelvin, of the warmest light in a photo
   *               (warm = +1 in theArray). Lower = more orange (2700 K ≈ tungsten).
   *  warmTint     Duv offset of the warm light from the blackbody curve, in CIE 1960
   *               uv units (≈ ±0.02 is a lot). + = greener/golden, - = rosier.
   *  skyCCT       Colour temperature of cool light (warm = -1) and of the shadow fill.
   *               10000 K ≈ blue skylight.
   *  adaptation   CAT16 degree of adaptation D, 0..1. 0 = the camera sees the light's
   *               colour cast fully; 1 = the eye fully discounts it (colour constancy).
   *  fill         Share (0..1) of ambient fill light that remains in the deepest
   *               shadow, so walls never go fully black.
   *  bounce       Share (0..1) of that fill that is light bounced off the painted
   *               wall itself (it takes the paint's colour); the rest is skylight.
   *  glow         Extra intensity of strongly coloured (warm or cool) direct light,
   *               so sunbeams read brighter than neutral light of the same exposure.
   *  shadowCurve  Exponent on exposure. 1 = linear; > 1 = deeper shadows.
   *  penumbra     Softness of the light map: Gaussian sigma as a % of image width
   *               (0.2 % of 1024 px ≈ 2 px). Hides JPEG noise and hard texture edges.
   *  dither       Add ±1 LSB triangular noise before 8-bit output (prevents banding).
   *  v1           Settings for the legacy HSV model only (see renderV1).
   */
  const SHADER_DEFAULTS = {
    model:        "v2",              // "v2" (this version) or "v1" (previous HSV version)
    wallHSL:      [0.5, 0.43, 0.76], // hue in degrees, S and L in 0..1
    warmCCT:      2700,  // colour temperature of ImageA's warm light (K)
    warmTint:     0.0,   // Duv tint of the warm light: 0 = true blackbody, + = golden/greener, - = rosier
    skyCCT:       10000, // colour temperature of the shadow fill / cool light (K)
    adaptation:   0.35,  // colour constancy: 0 = camera at daylight, 1 = eye fully adapted
    fill:         0.12,  // fill (ambient) light in the deepest shadow
    bounce:       0.4,   // share of the fill that is pink light bounced off the wall
    glow:         0.5,   // extra intensity of the warm light
    shadowCurve:  1.0,   // >1 = deeper shadows
    penumbra:     0.2,   // light-map softness, % of image width
    dither:       true,
    // v1-only settings (used when model === "v1")
    v1: { ambient: 0.12, shadowCurve: 1.0, warmth: 0.8, glow: 1.2 }
  };

  /**
   * Visitor-facing text for each PaintErrorKind, telling them what to do.
   * Trusted constant HTML (it is assigned with innerHTML), so never put
   * untrusted input here. Override per page with createRenderer({ notices }).
   * @type {Record<PaintErrorKind, string>}
   */
  const NOTICES = {
    nogl:   "Paint previews are turned off. Remove <b>?nogl</b> from the address to turn them on.",
    origin: "Paint previews need http. Run <b>bash serve.sh</b> in this folder and open " +
            `<a href="http://localhost:8000/shaderSceneRenderer.html">http://localhost:8000/shaderSceneRenderer.html</a>.`,
    webgl:  "Paint previews need WebGL2. Open this page in a current version of Chrome, Edge, Firefox or Safari.",
    mask:   "Paint previews need CSS luminance masks. Open this page in a current version of Chrome, Edge, Firefox or Safari.",
    load:   "Some files didn't load. Check the images and glsl folders, then reload the page.",
    error:  "Paint previews stopped working. Reload the page to try again."
  };

  // ---------------------------------------------------------------- errors

  /**
   * @typedef {"nogl" | "origin" | "webgl" | "mask" | "load" | "error"} PaintErrorKind
   *   nogl    ?nogl is in the URL (forced fallback for testing)
   *   origin  page opened from file://, so the photos' pixels can't be read
   *   webgl   no WebGL2, no float render targets, or N is above the GPU limit
   *   mask    the browser can't do `mask-mode: luminance`
   *   load    a photo, mask or the shader file failed to load or parse
   *   error   anything unexpected (non-PaintError exceptions map here)
   */

  /**
   * An expected reason paint previews can't run. fail() shows NOTICES[kind]
   * and falls back to the plain photos.
   */
  class PaintError extends Error {
    /**
     * @param {PaintErrorKind} kind
     * @param {string} [message]  Developer-facing detail (defaults to `kind`).
     */
    constructor(kind, message) { super(message || kind); this.kind = kind; }
  }

  // ======================================================================
  // Shader loading
  // ======================================================================

  /** Section names expected in the .glsl file (see its header). */
  const SECTIONS = ["VERT", "COMMON", "DECODE", "BLUR", "ANALYSE", "RENDER"];

  /**
   * Complete GLSL sources, ready to compile.
   * @typedef {Object} ShaderSources
   * @property {string} vert     Vertex shader shared by every pass.
   * @property {string} decode   P0 fragment shader (COMMON + DECODE).
   * @property {string} blur     P0b fragment shader (COMMON + BLUR).
   * @property {string} analyse  P1 fragment shader (COMMON + ANALYSE).
   * @property {string} render   P2 fragment shader (COMMON + RENDER).
   */

  /**
   * Fetches the shader file and cuts it into programs at its "//@@NAME"
   * marker lines. A section's text runs from the line after its marker to
   * the next marker, so "#version 300 es" stays the first line of VERT and
   * COMMON. Everything above the first marker (the file header) is dropped.
   * Each fragment program is COMMON + "\n" + its section.
   * Needs http(s): fetch() can't read file:// URLs.
   * @param {string} [url=DEFAULT_GLSL_URL]  Relative to the page.
   * @returns {Promise<ShaderSources>}
   * @throws {PaintError} "load" when the file can't be fetched or a section is missing.
   */
  async function loadShaders(url = DEFAULT_GLSL_URL) {
    let text;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (err) {
      throw new PaintError("load", `Couldn't load ${url}: ${err.message}`);
    }
    // Marker lines: "//@@NAME" at the start of a line (anything after NAME is ignored).
    const markers = [...text.matchAll(/^\/\/@@(\w+)[^\n]*(?:\n|$)/gm)];
    /** @type {Record<string, string>} */
    const parts = {};
    markers.forEach((m, i) => {
      const start = m.index + m[0].length;
      const end = i + 1 < markers.length ? markers[i + 1].index : text.length;
      parts[m[1]] = text.slice(start, end);
    });
    for (const name of SECTIONS)
      if (!(name in parts)) throw new PaintError("load", `${url} has no //@@${name} section`);
    const fragment = body => parts.COMMON + "\n" + body;
    return {
      vert: parts.VERT,
      decode: fragment(parts.DECODE),
      blur: fragment(parts.BLUR),
      analyse: fragment(parts.ANALYSE),
      render: fragment(parts.RENDER)
    };
  }

  // ======================================================================
  // WebGL host helpers (ported from js/tinted-wall-v2.js; makeProgram now
  // takes the vertex source as a parameter instead of a global)
  // ======================================================================

  /**
   * Compiles one shader stage.
   * @param {WebGL2RenderingContext} gl
   * @param {GLenum} type  gl.VERTEX_SHADER or gl.FRAGMENT_SHADER.
   * @param {string} src   GLSL ES 3.00 source.
   * @returns {WebGLShader}
   * @throws {Error} With the driver's info log when compilation fails (also
   *   when the context is lost, because COMPILE_STATUS then reads as null).
   */
  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error("Shader compile error:\n" + gl.getShaderInfoLog(s));
    return s;
  }

  /**
   * Links a vertex and a fragment shader into a program.
   * @param {WebGL2RenderingContext} gl
   * @param {string} vert  Vertex shader source (the shared fullscreen triangle).
   * @param {string} frag  Fragment shader source.
   * @returns {{ p: WebGLProgram, loc: Record<string, WebGLUniformLocation> }}
   *   The program, plus a map from uniform name to location built by asking
   *   the linked program for its active uniforms. Uniforms the compiler
   *   optimised away are absent, which WallShader#draw() treats as "skip".
   * @throws {Error} With the info log when compiling or linking fails.
   */
  function makeProgram(gl, vert, frag) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vert));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error("Program link error:\n" + gl.getProgramInfoLog(p));
    const loc = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const u = gl.getActiveUniform(p, i); loc[u.name] = gl.getUniformLocation(p, u.name); }
    return { p, loc };
  }

  /**
   * Creates a 2-D texture with clamp-to-edge wrapping. It is left bound to
   * TEXTURE_2D on the active unit.
   * @param {WebGL2RenderingContext} gl
   * @param {number} W  Width in pixels (used only when `data` is null).
   * @param {number} H  Height in pixels (used only when `data` is null).
   * @param {GLenum} internal  Sized internal format, e.g. gl.RGBA8 or gl.RGBA16F.
   * @param {GLenum} fmt   Pixel format, e.g. gl.RGBA.
   * @param {GLenum} type  Pixel type, e.g. gl.UNSIGNED_BYTE or gl.HALF_FLOAT.
   * @param {TexImageSource | null} data  An image, canvas, etc. to upload (its
   *   own size is used), or null to allocate an empty W x H texture. These are
   *   the two texImage2D overloads.
   * @param {boolean} linear  LINEAR filtering (for blurring) or NEAREST (for
   *   exact per-pixel data such as theArray).
   * @returns {WebGLTexture}
   * @throws {DOMException} SecurityError when `data` is cross-origin/tainted.
   */
  function makeTexture(gl, W, H, internal, fmt, type, data, linear) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    const f = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (data) gl.texImage2D(gl.TEXTURE_2D, 0, internal, fmt, type, data);
    else      gl.texImage2D(gl.TEXTURE_2D, 0, internal, W, H, 0, fmt, type, null);
    return t;
  }

  /**
   * Creates an offscreen render target: an RGBA16F texture attached to a
   * framebuffer. Half floats hold the signed and > 1 values of linear light
   * and theArray (RGBA8 would clamp them to 0..1 and band them), at half the
   * memory of RGBA32F. Rendering to them needs EXT_color_buffer_float or
   * EXT_color_buffer_half_float. The framebuffer is left bound.
   * @param {WebGL2RenderingContext} gl
   * @param {number} W
   * @param {number} H
   * @param {boolean} linear  Texture filtering when the target is later sampled.
   * @returns {{ tex: WebGLTexture, fbo: WebGLFramebuffer }}
   * @throws {Error} When the framebuffer is incomplete (no half-float
   *   rendering, or the context is lost).
   */
  function makeTarget(gl, W, H, linear) {
    const tex = makeTexture(gl, W, H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, null, linear);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error("This GPU/browser can't render to half-float textures.");
    return { tex, fbo };
  }

  /**
   * Uniforms that must be set with uniform1i: the sampler units and the GLSL
   * `int`s. Every other numeric uniform is a float (uniform1f). A JS number
   * doesn't say which one it is, hence this list.
   * @type {Set<string>}
   */
  const INT_UNIFORMS = new Set(["src", "lightLin", "sharpLin", "theArray", "W", "H", "model", "dither"]);

  /**
   * Settings merge from the source file (shallow, plus a one-level merge of
   * `v1`). UNUSED here, because SHADER_DEFAULTS is used as-is. It is kept so
   * this port stays comparable with js/tinted-wall-v2.js.
   * @param {object} base
   * @param {object} [extra]
   * @returns {object}
   */
  function merge(base, extra) {
    const out = Object.assign({}, base, extra || {});
    out.v1 = Object.assign({}, base.v1, (extra && extra.v1) || {});
    return out;
  }

  // ======================================================================
  // WallShader — one off-DOM WebGL2 context shared by every photo
  // ======================================================================

  /**
   * One photo's GPU state.
   * @typedef {Object} Entry
   * @property {HTMLImageElement} img  The source photo. Kept so the textures can
   *   be rebuilt after a context loss.
   * @property {WebGLTexture} texA  The photo, downscaled to N x N, RGBA8 sRGB.
   * @property {{ tex: WebGLTexture, fbo: WebGLFramebuffer }} theArray  The P1
   *   output for this photo (RGBA16F, NEAREST).
   * @property {string | null} analysedFor  Cache key ("model|sigma") of the
   *   analysis currently in theArray, or null when it must be re-run.
   */

  /**
   * Owns one WebGL2 context, on a canvas that is never in the DOM, and runs the
   * whole pipeline for any number of photos.
   *
   * Resources:
   *   shared     lin, tmp, blurred: RGBA16F scratch targets, reused by every
   *              analyse(). They only hold data during a single analyse() call.
   *   per entry  texA (RGBA8) + theArray (RGBA16F). Keeping theArray per photo
   *              means that changing the paint only costs one RENDER pass.
   *
   * Context loss: webglcontextlost is preventDefault()-ed, which tells the
   * browser we want the context back. On webglcontextrestored every GL object is
   * gone, so #restore() rebuilds programs, targets and every entry's textures
   * from entry.img, then calls hooks.onRestored() (or hooks.onError(err)).
   */
  class WallShader {
    /** @type {{ onRestored: () => void, onError: (err: unknown) => void }} */
    #hooks;
    /** @type {CanvasRenderingContext2D} N x N canvas used to downscale photos before upload. */
    #scratch;
    /** @type {ShaderSources} Kept to recompile after a context restore. */
    #sources;

    /**
     * @param {number} n  Working size (N).
     * @param {ShaderSources} sources  From loadShaders().
     * @param {{ onRestored: () => void, onError: (err: unknown) => void }} hooks
     *   Called after a lost context has been rebuilt, or when rebuilding fails.
     * @throws {PaintError} "webgl" when WebGL2 or float render targets are missing.
     * @throws {Error} When a shader fails to compile or link.
     */
    constructor(n, sources, hooks) {
      this.n = n;
      this.#sources = sources;
      this.#hooks = hooks;
      /** @type {Set<Entry>} Every entry, so they can be rebuilt after context loss. */
      this.entries = new Set();
      this.canvas = Object.assign(document.createElement("canvas"), { width: n, height: n });
      this.canvas.addEventListener("webglcontextlost", e => e.preventDefault());
      this.canvas.addEventListener("webglcontextrestored", () => this.#restore());
      // Context options:
      //   alpha: false                 the output is opaque, and an opaque buffer
      //                                composites and copies faster
      //   antialias/depth/stencil off  fullscreen 2-D passes don't need them,
      //                                and they cost memory
      //   premultipliedAlpha: false    no alpha maths applied to output colours
      //   preserveDrawingBuffer: true  the drawing buffer keeps its pixels after
      //                                compositing, so drawImage can always read it
      this.gl = this.canvas.getContext("webgl2", {
        alpha: false, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: false, preserveDrawingBuffer: true
      });
      if (!this.gl) throw new PaintError("webgl", "WebGL2 is not supported in this browser.");
      // Photos are downscaled to N x N through this canvas before upload
      this.#scratch = Object.assign(document.createElement("canvas"), { width: n, height: n }).getContext("2d");
      this.#init();
    }

    /** True while the GPU context is lost. GL calls are then silent no-ops. */
    get lost() { return this.gl.isContextLost(); }

    /**
     * Creates every context-level resource. Runs at construction and again
     * after a context restore (every old GL object is invalid by then).
     * @throws {PaintError} "webgl" when float render targets or the size aren't supported.
     * @throws {Error} When a shader fails to compile or link.
     */
    #init() {
      const gl = this.gl, n = this.n, src = this.#sources;
      // Either extension makes RGBA16F colour-renderable (needed for every target)
      if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float"))
        throw new PaintError("webgl", "This GPU/browser can't render to floating-point textures.");
      if (n > gl.getParameter(gl.MAX_TEXTURE_SIZE))
        throw new PaintError("webgl", `Working size is larger than this GPU's limit.`);
      // Let the browser convert any embedded colour profile (e.g. Display P3) to sRGB
      if ("unpackColorSpace" in gl) gl.unpackColorSpace = "srgb";
      // Upload rows top-to-bottom, as stored (RENDER's main() flips back), with
      // no alpha premultiplication, and with the browser's colour management.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
      this.progs = { decode: makeProgram(gl, src.vert, src.decode), blur: makeProgram(gl, src.vert, src.blur),
                     analyse: makeProgram(gl, src.vert, src.analyse), render: makeProgram(gl, src.vert, src.render) };
      // Shared scratch targets; each entry keeps only texA and its own theArray.
      // lin, tmp and blurred are LINEAR-filtered so BLUR's spaced taps interpolate.
      this.lin = makeTarget(gl, n, n, true);
      this.tmp = makeTarget(gl, n, n, true);
      this.blurred = makeTarget(gl, n, n, true);
      // VERT reads no attributes, but WebGL2 still wants a VAO bound to draw.
      gl.bindVertexArray(gl.createVertexArray());
      // Every pass renders a full N x N surface, so the viewport never changes.
      gl.viewport(0, 0, n, n);
      gl.activeTexture(gl.TEXTURE0);
    }

    /**
     * webglcontextrestored handler: rebuilds the context resources and every
     * entry, then lets the page repaint. The analyses are re-run lazily
     * (analysedFor is reset to null by #upload).
     */
    #restore() {
      try {
        this.#init();
        for (const entry of this.entries) this.#upload(entry);
      } catch (err) { this.#hooks.onError(err); return; }
      this.#hooks.onRestored();
    }

    /**
     * (Re)creates an entry's GPU textures from its photo: downscale to N x N
     * through the scratch canvas, upload as texA, allocate theArray, and mark
     * the analysis stale.
     * @param {Entry} entry
     * @throws {PaintError} "origin" when the photo's pixels can't be read (file://).
     * @throws {Error} When theArray can't be allocated.
     */
    #upload(entry) {
      const gl = this.gl, n = this.n, ctx = this.#scratch;
      // "high" smoothing gives a filtered (not nearest-pixel) downscale, so
      // fine detail doesn't alias into the light map.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.clearRect(0, 0, n, n);
      ctx.drawImage(entry.img, 0, 0, n, n);
      try { entry.texA = makeTexture(gl, n, n, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, ctx.canvas, false); }
      catch (err) {
        // On file:// the scratch canvas is silently tainted; the upload is where it fails
        if (err && err.name === "SecurityError") throw new PaintError("origin", "The browser blocked reading the photo's pixels.");
        throw err;
      }
      entry.theArray = makeTarget(gl, n, n, false);
      entry.analysedFor = null;
    }

    /**
     * Uploads a decoded photo and registers it. The analysis is not run yet;
     * call ensureAnalysed() before rendering.
     * @param {HTMLImageElement} img  Must be fully decoded and same-origin.
     * @returns {Entry}
     * @throws {PaintError | Error} See #upload().
     */
    createEntry(img) {
      const entry = { img, texA: null, theArray: null, analysedFor: null };
      this.#upload(entry);
      this.entries.add(entry);
      return entry;
    }

    /**
     * Runs one fullscreen pass.
     * @param {{ p: WebGLProgram, loc: Record<string, WebGLUniformLocation> }} prog
     * @param {{ fbo: WebGLFramebuffer } | null} target  Offscreen target, or null
     *   for the canvas's drawing buffer.
     * @param {WebGLTexture} tex  Bound to texture unit 0 (the active unit).
     * @param {Record<string, number | number[]>} uniforms  Numbers are set as int
     *   or float according to INT_UNIFORMS; arrays of length 2/3/4 as vec2/3/4.
     *   Names the program doesn't use are skipped.
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
      // Three vertices = VERT's fullscreen triangle.
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /** Blur radius in pixels: penumbra is a % of the image width. */
    #sigma() { return Math.max(0, SHADER_DEFAULTS.penumbra) / 100 * this.n; }
    /**
     * Cache key for theArray's contents. It covers everything the analysis
     * depends on except the photo itself, which is fixed per entry.
     * @param {"v1" | "v2"} model
     */
    #key(model) { return model + "|" + this.#sigma().toFixed(3); }

    // P0 decode -> P0b blur (v2) -> P1 theArray
    /**
     * Fills entry.theArray for `model`. The shared targets hold whichever
     * photo was analysed last, so the decode is redone for every call; it is
     * one cheap pass.
     * @param {Entry} entry
     * @param {"v1" | "v2"} model
     */
    analyse(entry, model) {
      const gl = this.gl, P = this.progs, isV1 = model === "v1", sigma = this.#sigma();
      this.#draw(P.decode, this.lin, entry.texA, { src: 0 });
      let lightTex = this.lin.tex;
      // Only v2 blurs. Below about 0.3 px the Gaussian is effectively a single tap.
      if (!isV1 && sigma >= 0.3) {
        this.#draw(P.blur, this.tmp, this.lin.tex, { src: 0, dir: [1, 0], sigma });
        this.#draw(P.blur, this.blurred, this.tmp.tex, { src: 0, dir: [0, 1], sigma });
        lightTex = this.blurred.tex;
      }
      // lightLin on unit 0, sharpLin on unit 1
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.lin.tex); gl.activeTexture(gl.TEXTURE0);
      this.#draw(P.analyse, entry.theArray, lightTex, { lightLin: 0, sharpLin: 1, model: isV1 ? 1 : 2 });
      // Unbind unit 1 so `lin` is never left bound while the next analyse()
      // renders into it (a feedback loop WebGL rejects). TEXTURE0 stays the
      // active unit, as #draw() assumes.
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, null); gl.activeTexture(gl.TEXTURE0);
      entry.analysedFor = this.#key(model);
    }

    /**
     * Re-runs analyse() only if theArray was built for a different model or
     * blur, or has been invalidated by a context restore.
     * @param {Entry} entry
     * @param {"v1" | "v2"} model
     */
    ensureAnalysed(entry, model) {
      if (entry.analysedFor !== this.#key(model)) this.analyse(entry, model);
    }

    // P2: light the wall, then copy the drawing buffer out in the same task
    /**
     * Renders the wall for one photo and paint into `ctx2d`. The single
     * drawing buffer is shared by every photo, so the copy must happen right
     * away, before any other render overwrites it.
     * @param {Entry} entry  Must already be analysed for `model`.
     * @param {"v1" | "v2"} model
     * @param {string} hex  Paint colour, #rrggbb.
     * @param {CanvasRenderingContext2D} ctx2d  An N x N tile canvas.
     */
    renderTo(entry, model, hex, ctx2d) {
      const S = SHADER_DEFAULTS, n = this.n, isV1 = model === "v1";
      this.#draw(this.progs.render, null, entry.theArray.tex, {
        theArray: 0, W: n, H: n, model: isV1 ? 1 : 2, dither: S.dither ? 1 : 0,
        wallHSL: hexToHsl(hex), warmCCT: +S.warmCCT, warmTint: +S.warmTint, skyCCT: +S.skyCCT,
        adaptation: +S.adaptation, fill: +S.fill, bounce: +S.bounce,
        glow: +S.glow, shadowCurve: +S.shadowCurve,
        v1p: [S.v1.ambient, S.v1.shadowCurve, S.v1.warmth, S.v1.glow]
      });
      ctx2d.drawImage(this.canvas, 0, 0);
    }
  }

  // ---------------------------------------------------------------- colour

  /**
   * Validates and canonicalises a paint colour.
   * @param {string} hex  "#rrggbb" in any case, with optional surrounding whitespace.
   * @returns {string} Lowercase "#rrggbb".
   * @throws {TypeError} For anything else (including the 3-digit "#rgb" form).
   */
  function normalizeHex(hex) {
    const h = String(hex).trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(h)) throw new TypeError(`Expected a colour like "#e3d4b9", got "${hex}"`);
    return h;
  }

  /**
   * @param {string} hex  "#rrggbb".
   * @returns {[number, number, number]} 8-bit encoded sRGB channels, 0..255.
   */
  function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  /**
   * Encoded sRGB -> HSL, the form RENDER's `wallHSL` uniform expects (the
   * shader turns it back into RGB with hsl2rgb). The round trip is exact up to
   * float precision.
   * @param {string} hex  "#rrggbb".
   * @returns {[number, number, number]} [hue in degrees 0..360, saturation 0..1, lightness 0..1].
   */
  function hexToHsl(hex) {   // hue in degrees, S and L in 0..1
    const [r, g, b] = hexToRgb(hex).map(c => c / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
    let h = 0, s = 0;
    // Greys (d = 0) keep hue 0 and saturation 0.
    if (d > 0) {
      // HSL saturation: chroma relative to the largest chroma possible at this lightness.
      s = d / (1 - Math.abs(2 * l - 1));
      // The hue sector is chosen by the largest channel (as in rgb2hsv in COMMON).
      if      (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else               h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return [h, s, l];
  }

  /**
   * Light reflectance value: the share of visible light a paint reflects, on
   * a 0 (black) to 100 (perfect white) scale, as printed on paint charts. It is
   * the colour's relative luminance Y x 100, where Y comes from linearised sRGB
   * and the Rec. 709 weights, the same as lum() in COMMON. It is not perceptual
   * lightness: LRV 50 looks much lighter than "halfway".
   * Example: #e3d4b9 -> linear (0.768, 0.658, 0.485) -> Y ≈ 0.669 -> LRV 67.
   * @param {string} hex  "#rrggbb".
   * @returns {number} Integer 0..100.
   */
  function lrv(hex) {        // light reflectance value = relative luminance x 100
    const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const [r, g, b] = hexToRgb(hex).map(lin);
    return Math.round(100 * (0.2126729 * r + 0.7151522 * g + 0.0721750 * b));
  }

  // ======================================================================
  // SceneTile — base canvas + incoming canvas under the masked photo
  // ======================================================================

  /**
   * Controls one tile's two canvases.
   *
   *   base      the committed image the visitor sees under the masked photo
   *   incoming  stacked above base at opacity 0. A new paint is rendered here
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
     * @param {number} n  Canvas size (N).
     */
    constructor(figure, n) {
      this.n = n;
      /** @type {string} The figure's data-time ("morning" | "noon" | "night"). */
      this.time = figure.dataset.time;
      [this.base, this.incoming] = figure.querySelectorAll("canvas");
      this.baseCtx = this.base.getContext("2d");
      this.inCtx = this.incoming.getContext("2d");
      /** @type {Record<string, HTMLImageElement>} This tile's photo for each room key. */
      this.imgs = Object.fromEntries([...figure.querySelectorAll("img")].map(img => [img.dataset.room, img]));
      /** @type {Animation | null} The running fade of `incoming`, if any. */
      this.anim = null;
    }

    // Base starts as the original photo, so turning masks on changes nothing
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
     * Shows `entry` painted with `hex` under `model`.
     *  - animate = false: finish any fade, then render straight into base (instant).
     *  - animate = true: render into incoming and fade it in after `delay` ms.
     *    If a fade is already running, incoming is simply redrawn with the newer
     *    paint and the same fade carries on. Rapid clicks never restart or stack
     *    fades.
     * @param {WallShader} shader
     * @param {Entry} entry  Must already be analysed for `model`.
     * @param {"v1" | "v2"} model
     * @param {string} hex  Paint colour, #rrggbb.
     * @param {boolean} animate
     * @param {number} [delay=0]  Stagger, in ms.
     * @returns {Promise<void>} Resolves when the tile has settled. Never rejects,
     *   even when the fade is cancelled.
     */
    present(shader, entry, model, hex, animate, delay = 0) {
      if (!animate) {
        this.settle();
        shader.renderTo(entry, model, hex, this.baseCtx);
        return Promise.resolve();
      }
      shader.renderTo(entry, model, hex, this.inCtx);
      if (!this.anim) {      // mid-fade changes just redraw incoming and let the fade continue
        // fill "both": incoming holds opacity 0 during the delay and 1 at the
        // end, until settle() commits it and cancels the animation.
        const anim = this.incoming.animate([{ opacity: 0 }, { opacity: 1 }],
          { duration: FADE_MS, delay, easing: "cubic-bezier(.2, 0, 0, 1)", fill: "both" });
        // Ignore stale animations: settle() may already have replaced this one.
        anim.onfinish = () => { if (this.anim === anim) this.settle(); };
        this.anim = anim;
      }
      return this.anim.finished.then(() => {}, () => {});
    }

    // Finish now: commit incoming to base and drop incoming back to opacity 0
    /**
     * Ends any running fade at once. Copying incoming into base BEFORE cancel()
     * (which drops incoming back to its CSS opacity of 0), in the same task,
     * means no frame ever shows the old paint. Safe to call when idle.
     */
    settle() {
      const anim = this.anim;
      if (!anim) return;
      this.anim = null;
      this.baseCtx.drawImage(this.incoming, 0, 0);
      anim.cancel();
    }
  }

  // ---------------------------------------------------------------- small utilities

  /**
   * Fetches and decodes an image off-DOM. It is used to have the masks fully
   * decoded before .is-painted turns them on, so a mask never pops in late. This
   * avoids <link rel=preload>, which warns in the console if the resource isn't
   * used soon enough.
   * @param {string} src
   * @returns {Promise<void>}
   * @throws {PaintError} "load" when the image fails.
   */
  function decodeImage(src) {
    const img = new Image();
    img.src = src;
    return img.decode().catch(() => { throw new PaintError("load", `Couldn't load ${src}`); });
  }

  /**
   * Runs `cb` when the main thread is idle (at the latest after 2 s). Safari has
   * no requestIdleCallback, so there a short timeout is used instead.
   * @param {() => void} cb
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
   *                           white = everything else, so `mask-mode: luminance`
   *                           hides exactly the walls of the photo above the canvas.
   * @property {Record<string, string>} photos  One photo per time of day.
   */

  /**
   * @typedef {Object} RendererOptions
   * @property {Record<string, Room>} rooms  Every room, keyed like the photos'
   *   data-room values. Used to validate setRoom() and to pre-decode masks.
   * @property {string} initialPaint  Paint on screen at load (#rrggbb).
   * @property {"v1" | "v2"} [initialModel="v2"]  Must match the checked model radio.
   * @property {string} [glslUrl]  Shader file (default "glsl/shaderSceneRender.glsl").
   * @property {Partial<Record<PaintErrorKind, string>>} [notices]  Overrides for NOTICES.
   * @property {Object} elements  Page elements the renderer drives:
   * @property {HTMLElement} elements.app         Gets the .is-painted class.
   * @property {HTMLElement} elements.renderer    Holds the figure.scene tiles; its
   *   data-room is the initially shown room.
   * @property {HTMLFieldSetElement} elements.modelFieldset  Disabled on failure.
   * @property {HTMLElement} elements.notice      role="status" region for notices.
   * @property {HTMLElement} elements.readoutHex  Shows the active paint's hex.
   * @property {HTMLElement} elements.readoutLrv  Shows the active paint's LRV.
   */

  /**
   * Scripting and testing handle returned by createRenderer() (the page
   * exposes it as window.sceneRenderer).
   * @typedef {Object} SceneRenderer
   * @property {string} activePaintColor  Current paint, lowercase #rrggbb (read-only).
   * @property {string} activeRoom        Requested room key (read-only); may run
   *   ahead of what is on screen while the room loads.
   * @property {"v1" | "v2"} activeModel  Current lighting model (read-only).
   * @property {number} size              Tile canvas size in pixels (N), for sample().
   * @property {(hex: string) => Promise<void>} setPaint   See setPaint().
   * @property {(room: string) => Promise<void>} setRoom   See setRoom().
   * @property {(model: "v1" | "v2") => Promise<void>} setModel  See setModel().
   * @property {() => Promise<void>} start  Boots paint previews (call once; repeat
   *   calls return the same promise).
   * @property {Promise<void> | null} ready  start()'s promise; settles after boot
   *   (painted or fallback) and never rejects. Null until start() is called.
   * @property {(tile: string | number, x: number, y: number) => number[]} sample
   *   One pixel of a tile's painted canvas.
   */

  /**
   * Creates the controller for a page whose tiles are already in the DOM.
   * Syncs the paint readout at once; nothing loads or renders until start().
   * The page wires its radios' change events to setPaint / setRoom / setModel.
   * @param {RendererOptions} options
   * @returns {SceneRenderer}
   */
  function createRenderer(options) {
    const { rooms, elements } = options;
    const { app, renderer, modelFieldset, notice, readoutHex, readoutLrv } = elements;
    const glslUrl = options.glslUrl || DEFAULT_GLSL_URL;
    const notices = Object.assign({}, NOTICES, options.notices);

    // ------------------------------------------------------------ state
    // Written only by the public setters (setPaint, setModel, setRoom) and swap().

    /** Paint on the walls, lowercase #rrggbb. Written by setPaint(). */
    let activePaintColor = normalizeHex(options.initialPaint);
    /** Room the visitor asked for (rooms key). Written by setRoom() at once. */
    let activeRoom = renderer.dataset.room;
    /** Lighting model: "v2" (perceptual) or "v1" (HSV). Written by setModel(). */
    let activeModel = options.initialModel || "v2";
    /**
     * Room actually on screen. Changes only inside setRoom()'s swap(), once the
     * room's photos are loaded and analysed, so rendering never waits on a load.
     */
    let shownRoom = activeRoom;

    /** @type {WallShader | null} Created lazily by startPainting(). */
    let shader = null;
    /**
     * True once the paint is live (.is-painted is on and the canvases hold paint).
     * While it is false, nothing renders and visitors see the plain photos.
     */
    let painting = false;
    /** Set when a failure was caused by context loss, so the restore should retry booting. */
    let resumeOnRestore = false;
    /** start()'s promise, once started. */
    let ready = null;
    /** Read on every change, so the OS setting can change while the page is open. */
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

    /** The tiles, in DOM order (index = stagger position). */
    const tiles = [...renderer.querySelectorAll(".scene")].map(f => new SceneTile(f, N));

    // ------------------------------------------------------------ UI sync

    /**
     * Checks the radio in group `name` whose value is `value` and unchecks the
     * others. If no radio matches (e.g. a paint that isn't in the palette), all
     * of them end up unchecked.
     * @param {"paint" | "room" | "model"} name
     * @param {string} value
     */
    function syncRadio(name, value) {
      for (const input of app.querySelectorAll(`input[name="${name}"]`)) input.checked = input.value === value;
    }

    /**
     * Updates everything in the UI that shows the active paint: the --active-paint
     * CSS variable, the checked chip, and the hex + LRV readout. No rendering.
     * @param {string} hex  Normalised "#rrggbb".
     */
    function syncPaintUi(hex) {
      document.documentElement.style.setProperty("--active-paint", hex);
      syncRadio("paint", hex);
      readoutHex.textContent = hex.toUpperCase();
      readoutLrv.textContent = `LRV ${lrv(hex)}`;
    }

    /**
     * Shows a notice in the role="status" live region (screen readers announce it).
     * @param {PaintErrorKind} kind
     */
    function showNotice(kind) { notice.innerHTML = notices[kind] || notices.error; }

    // ------------------------------------------------------------ rooms

    /**
     * roomEntries[room]: the room's entries in tile order, once created.
     * roomLoading[room]: the in-flight or finished promise of those entries
     * (deduplicates concurrent prepareRoom calls).
     * @type {Record<string, Entry[]>}
     */
    const roomEntries = {}, roomLoading = {};

    /**
     * Gets a room ready to show: waits for its photos to decode, uploads them
     * (once per room, memoised), and makes sure every entry is analysed for the
     * CURRENT activeModel. That last step runs on every call, which is how a
     * hidden room catches up lazily after a model toggle.
     * If loading fails, the memo is cleared so a later call can retry.
     * @param {string} room  Room key.
     * @returns {Promise<Entry[]>} The entries, in tile order.
     * @throws {PaintError} "load" when a photo can't be decoded; others from createEntry.
     */
    function prepareRoom(room) {
      roomLoading[room] ??= (async () => {
        const imgs = tiles.map(t => t.imgs[room]);
        // decode() can reject for benign reasons (for example, the image is
        // already decoded in some engines). It counts as a failure only if the
        // image really has no pixels.
        await Promise.all(imgs.map(img => img.decode().catch(() => {
          if (!img.naturalWidth) throw new PaintError("load", `Couldn't load ${img.src}`);
        })));
        return (roomEntries[room] = imgs.map(img => shader.createEntry(img)));
      })().catch(err => { delete roomLoading[room]; throw err; });
      return roomLoading[room].then(list => {
        for (const entry of list) shader.ensureAnalysed(entry, activeModel);
        return list;
      });
    }

    // ------------------------------------------------------------ rendering

    /** @type {Promise<void> | null} The pending frame's promise, shared by every caller in that frame. */
    let frame = null;
    /**
     * Requests a paint/model update on the next animation frame. Any number of
     * calls before that frame collapse into one flush(), which uses the state as
     * it is then (so the last setPaint wins).
     * @returns {Promise<void>} Resolves when that frame's fades have finished.
     */
    function scheduleRender() {      // coalesced per animation frame
      frame ??= new Promise(resolve => requestAnimationFrame(() => { frame = null; resolve(flush()); }));
      return frame;
    }

    /**
     * Renders the shown room with the current paint and model, fading the tiles
     * in one after the other (each STAGGER_MS after the previous one), or
     * instantly with reduced motion. Does nothing before painting starts or
     * while the context is lost.
     * @returns {Promise<void[]> | undefined}
     */
    function flush() {
      if (!painting || shader.lost) return;
      try {
        const list = roomEntries[shownRoom];
        const animate = !reducedMotion.matches;
        return Promise.all(tiles.map((tile, i) => {
          // Re-analyse the visible photos if the model has changed since the last render.
          shader.ensureAnalysed(list[i], activeModel);
          return tile.present(shader, list[i], activeModel, activePaintColor, animate, i * STAGGER_MS);
        }));
      } catch (err) { fail(err); }
    }

    /**
     * Renders the shown room into every base canvas instantly, with no fade.
     * Used for room swaps (inside the view transition) and after a context restore.
     * @throws {Error} GL errors, which callers route to fail().
     */
    function repaint() {             // instant, no fade
      const list = roomEntries[shownRoom];
      tiles.forEach((tile, i) => {
        shader.ensureAnalysed(list[i], activeModel);
        tile.present(shader, list[i], activeModel, activePaintColor, false);
      });
    }

    /**
     * The single error policy.
     *  - Context lost: most GL calls fail while the context is gone. Don't treat
     *    that as fatal; wait for webglcontextrestored (onRestored retries the
     *    boot if needed).
     *  - Anything else: stop painting, remove the masks (visitors see the plain
     *    photos), disable the shader toggle and show a notice. Unexpected errors
     *    are also logged.
     * @param {unknown} err
     */
    function fail(err) {
      if (shader && shader.lost) { resumeOnRestore = true; return; }   // wait for webglcontextrestored
      painting = false;
      app.classList.remove("is-painted");
      for (const tile of tiles) tile.settle();
      modelFieldset.disabled = true;
      const kind = err instanceof PaintError ? err.kind : "error";
      if (kind === "error" || kind === "webgl") console.warn("shaderSceneRender:", err);
      showNotice(kind);
    }

    /**
     * WallShader hook, called after the context and every entry are rebuilt.
     * Repaints instantly if the paint was live; if the context was lost during
     * boot, starts the boot again.
     */
    function onRestored() {
      try {
        if (painting) repaint();
        else if (resumeOnRestore) { resumeOnRestore = false; startPainting().catch(fail); }
      } catch (err) { fail(err); }
    }

    // ------------------------------------------------------------ public setters

    /**
     * Sets the wall paint. Any #rrggbb is accepted, not only the palette colours.
     * The UI updates at once; the walls update on the next frame.
     * @param {string} hex
     * @returns {Promise<void>} Resolves when the walls have faded to the new paint.
     * @throws {TypeError} When `hex` isn't #rrggbb.
     */
    function setPaint(hex) {
      hex = normalizeHex(hex);
      activePaintColor = hex;
      syncPaintUi(hex);
      return scheduleRender();
    }

    /**
     * Switches the lighting model. Visible photos are re-analysed on the next
     * frame; hidden rooms catch up in prepareRoom() when they are shown.
     * @param {"v1" | "v2"} model
     * @returns {Promise<void>} Resolves when the walls have faded to the new model.
     * @throws {RangeError} For an unknown model.
     */
    function setModel(model) {
      if (model !== "v1" && model !== "v2") throw new RangeError(`Unknown shader model "${model}"`);
      activeModel = model;
      syncRadio("model", model);
      return scheduleRender();
    }

    /** Bumped on every setRoom call; only the latest call may swap rooms. */
    let roomToken = 0;
    /**
     * Shows another room.
     *  1. Updates the requested room and the radios at once.
     *  2. Prepares the room's entries (load, upload, analyse) while the old room
     *     stays on screen.
     *  3. If a newer setRoom call started in the meantime, stops here
     *     (last call wins).
     *  4. Settles running fades, so the view transition snapshots a stable image.
     *  5. Runs swap() inside document.startViewTransition: flip data-room (which
     *     shows the other photos and masks via CSS) and repaint the canvases
     *     synchronously, so the "new" snapshot is complete. The browser
     *     cross-fades each frame (duration set in the page's CSS). Without the
     *     API, or with reduced motion, swap() runs directly.
     * If painting has failed, only the photos are swapped.
     * @param {string} room  Room key.
     * @returns {Promise<void>} Resolves when the switch (and its transition) is done.
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
      if (token !== roomToken || room === shownRoom) return;   // the last call wins
      for (const tile of tiles) tile.settle();
      const swap = () => {
        shownRoom = room;
        renderer.dataset.room = room;
        if (painting && !shader.lost) {
          try { repaint(); } catch (err) { fail(err); }
        }
      };
      if (reducedMotion.matches || !document.startViewTransition) { swap(); return; }
      await document.startViewTransition(swap).finished;
    }

    // ------------------------------------------------------------ boot

    /**
     * Turns paint previews on. Any throw ends up in fail(), which leaves the
     * plain photos and a notice.
     *  1. Gates, cheapest first: ?nogl, file://, CSS luminance mask support.
     *  2. Load the shaders and create the WallShader (it can throw "webgl").
     *  3. Prepare the shown room and decode every mask in parallel. If the
     *     visitor switched rooms meanwhile, loop and prepare the new one.
     *  4. Seed each base canvas with the original photo, THEN add .is-painted.
     *     The masks reveal canvases that look identical to the photos, so turning
     *     them on is invisible.
     *  5. Fade the paint in, and prepare the other rooms when the browser is idle.
     * @returns {Promise<void>} Resolves once the first paint has faded in.
     * @throws {PaintError | Error}
     */
    async function startPainting() {
      if (new URLSearchParams(location.search).has("nogl")) throw new PaintError("nogl");
      if (location.protocol === "file:") throw new PaintError("origin");
      if (!CSS.supports("mask-mode", "luminance")) throw new PaintError("mask");
      shader ??= new WallShader(N, await loadShaders(glslUrl), { onRestored, onError: fail });
      const masks = Promise.all(Object.values(rooms).map(r => decodeImage(r.mask)));
      let room;
      do {                           // the visitor may switch rooms while we load
        room = shownRoom;
        await Promise.all([prepareRoom(room), masks]);
      } while (room !== shownRoom);
      for (const tile of tiles) tile.seed(room);
      painting = true;
      modelFieldset.disabled = false;
      notice.textContent = "";
      app.classList.add("is-painted");
      whenIdle(() => {
        for (const other of Object.keys(rooms)) if (other !== shownRoom) prepareRoom(other).catch(fail);
      });
      await scheduleRender();        // the paint fades in
    }

    // ------------------------------------------------------------ handle

    // 1 x 1 readback canvas for sample(). willReadFrequently keeps it on the CPU,
    // so getImageData is cheap. Reading from the tile canvases directly would push
    // THEM to the CPU and slow every later drawImage into them.
    const sampler = Object.assign(document.createElement("canvas"), { width: 1, height: 1 })
      .getContext("2d", { willReadFrequently: true });
    sampler.imageSmoothingEnabled = false;

    // The readout starts empty in the HTML, so it can never show a stale paint.
    syncPaintUi(activePaintColor);

    /** @type {SceneRenderer} */
    return {
      get activePaintColor() { return activePaintColor; },
      get activeRoom() { return activeRoom; },
      get activeModel() { return activeModel; },
      get ready() { return ready; },
      size: N,
      setPaint, setRoom, setModel,
      start() { return (ready ??= startPainting().catch(fail)); },
      // Pixel [r, g, b] of a tile's painted canvas; tile = its data-time or index,
      // x and y in canvas pixels (0..size-1, top-left origin)
      /**
       * Reads one pixel of the painted canvas UNDER the mask: the wall paint
       * everywhere, not what the visitor sees outside the walls. During a fade it
       * reads incoming (the newest paint); otherwise base.
       * @param {string | number} tile  Tile data-time ("morning", ...) or index.
       * @param {number} x  Canvas pixel column, 0..size-1 (rounded).
       * @param {number} y  Canvas pixel row, 0..size-1, from the top (rounded).
       * @returns {number[]} [r, g, b], 0..255, encoded sRGB.
       * @throws {RangeError} For an unknown tile.
       */
      sample(tile, x, y) {
        const t = typeof tile === "number" ? tiles[tile] : tiles.find(s => s.time === tile);
        if (!t) throw new RangeError(`Unknown tile "${tile}"`);
        const src = t.anim ? t.incoming : t.base;
        sampler.clearRect(0, 0, 1, 1);
        sampler.drawImage(src, Math.round(x), Math.round(y), 1, 1, 0, 0, 1, 1);
        const [r, g, b] = sampler.getImageData(0, 0, 1, 1).data;
        return [r, g, b];
      }
    };
  }

  // ---------------------------------------------------------------- export
  /**
   * The library's global namespace. Pages normally only need createRenderer,
   * lrv (for palette labels) and N (for the tile canvases' size). The rest is
   * exposed for testing and reuse (js/videoShaderRender.js builds on the
   * shader loader, GL helpers and colour functions).
   */
  window.ShaderSceneRender = {
    createRenderer, loadShaders,
    WallShader, SceneTile, PaintError,
    makeProgram, makeTexture, makeTarget, INT_UNIFORMS, decodeImage,
    normalizeHex, hexToRgb, hexToHsl, lrv,
    N, FADE_MS, STAGGER_MS, SHADER_DEFAULTS, NOTICES, DEFAULT_GLSL_URL
  };
})();
