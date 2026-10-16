/* ==========================================================================
 * paintPipeline.js — the shared core of both paint visualizer pages.
 *
 *   shaderSceneRenderer.html  -> js/shaderSceneRender.js  (photos)  ┐
 *   videoShaderRenderer.html  -> js/videoShaderRender.js  (video)   ┴-> this file
 *                                                                       + glsl/shaderSceneRender.glsl
 *
 * Contents, in order:
 *   errors         PaintError and the visitor-facing NOTICES
 *   settings       MODELS and SHADER_DEFAULTS (every tunable constant, with
 *                  what it means and why it has its value)
 *   shader loading loadShaders(): fetch the .glsl file, cut it into programs
 *   GL helpers     compile / link (uniform types read from the program),
 *                  textures, render targets
 *   colour         hex <-> linear, LRV, Oklab, 3x3 matrices, Display P3
 *   spectral       CIE observer, Planck, McCamy CCT, paint reflectance fit,
 *                  paintSpec(): everything RENDER needs to know about a paint
 *   statistics     LightStats: medians / percentiles / wall mean of images
 *   sliders        makeAdjustment(), toAmount(), toSatMeasure()
 *   scene          sceneSpec(): v3's per-scene calibration and adaptation
 *   LightPipeline  one WebGL2 context: DECODE -> ADJUST -> BLUR -> ANALYSE
 *                  -> RENDER, its textures, and context-loss recovery
 *
 * ASSUMPTIONS the colour maths rests on (see README.md):
 *   - The photos and the video are encoded sRGB, white-balanced so that the
 *     camera's neutral (encoded white) is D65 daylight.
 *   - The original walls are white (paint swatch units: reflectance 1).
 *   - Masks are black on the walls and white elsewhere, with the same framing
 *     as the image they belong to.
 *
 * Loaded as a classic script (not an ES module), so it also loads from
 * file://, where the pages can then still show the "needs http" notice.
 * Exposes window.PaintPipeline.
 * ======================================================================== */
(function () {
  "use strict";

  // ======================================================================
  // Errors
  // ======================================================================

  /**
   * @typedef {"nogl" | "origin" | "webgl" | "mask" | "load" | "error"} PaintErrorKind
   *   nogl    ?nogl is in the URL (forced fallback for testing)
   *   origin  page opened from file://, so the images' pixels can't be read
   *   webgl   no WebGL2, no float render targets, or a size above the GPU limit
   *   mask    the browser can't do `mask-mode: luminance`
   *   load    an image, mask, video or the shader file failed to load or parse
   *   error   anything unexpected (non-PaintError exceptions map here)
   */

  /** An expected reason paint previews can't run; the pages show NOTICES[kind]. */
  class PaintError extends Error {
    /**
     * @param {PaintErrorKind} kind
     * @param {string} [message]  Developer-facing detail (defaults to `kind`).
     */
    constructor(kind, message) { super(message || kind); this.kind = kind; }
  }

  /**
   * Visitor-facing text for each PaintErrorKind, telling them what to do.
   * Trusted constant HTML (pages assign it with innerHTML), so never put
   * untrusted input here. `{page}` is replaced with the page's file name.
   * @type {Record<PaintErrorKind, string>}
   */
  const NOTICES = {
    nogl:   "Paint previews are turned off. Remove <b>?nogl</b> from the address to turn them on.",
    origin: "Paint previews need http. Run <b>bash serve.sh</b> in this folder and open " +
            `<a href="http://localhost:8000/{page}">http://localhost:8000/{page}</a>.`,
    webgl:  "Paint previews need WebGL2. Open this page in a current version of Chrome, Edge, Firefox or Safari.",
    mask:   "Paint previews need CSS luminance masks. Open this page in a current version of Chrome, Edge, Firefox or Safari.",
    load:   "Some files didn't load. Check the images and glsl folders, then reload the page.",
    error:  "Paint previews stopped working. Reload the page to try again."
  };

  /**
   * The notice for `kind` on page `page` (e.g. "shaderSceneRenderer.html").
   * @param {PaintErrorKind} kind
   * @param {string} page
   * @returns {string} Trusted HTML.
   */
  function noticeFor(kind, page) { return (NOTICES[kind] || NOTICES.error).replaceAll("{page}", page); }

  // ======================================================================
  // Settings
  // ======================================================================

  /**
   * The "Tinting algo" models: the value of the radio -> the shader's `model`
   * uniform (MODEL_V1/V2/V3 in the .glsl file).
   * @typedef {"v1" | "v2" | "v3"} Model
   */
  const MODELS = { v1: 1, v2: 2, v3: 3 };

  /**
   * Every tunable constant of the lighting models, passed to the shaders as
   * uniforms or used to build them. v1 and v2 values are those of
   * js/tinted-wall-v2.js, tuned by eye on the original photos; v3 values are
   * physical estimates, with sources noted.
   *
   * Shared
   *  penumbra     Softness of the light map: Gaussian sigma as a % of the
   *               analysis width (0.2 % of 1024 px ≈ 2 px). Hides JPEG noise,
   *               chroma subsampling and surface texture in the light's
   *               COLOUR; v3 restores fine BRIGHTNESS detail separately.
   *  dither       Add ±1 LSB triangular noise before 8-bit output (no banding).
   *
   * v2 (perception-aware)
   *  warmCCT      Colour temperature, in kelvin, of the warmest light in a photo
   *               (warm = +1 in the light map). 2700 K ≈ tungsten.
   *  warmTint     Duv offset of the warm light from the blackbody curve, in CIE
   *               1960 uv units (±0.02 is a lot). + = greener/golden, - = rosier.
   *  skyCCT       Colour temperature of cool light (warm = -1) and of the shadow
   *               fill. 10000 K ≈ blue skylight.
   *  adaptation   CAT16 degree of adaptation D, 0..1, applied PER PIXEL. 0 = the
   *               camera sees the light's colour cast fully; 1 = fully discounted.
   *               0.35 keeps the walls consistent with the unprocessed furniture,
   *               which shows the camera's (unadapted) colours.
   *  fill         Share (0..1) of ambient light in the deepest shadow.
   *  bounce       Share (0..1) of that fill that bounced off the painted wall.
   *  glow         Extra intensity of strongly coloured light, so sunbeams read
   *               brighter than neutral light of the same exposure: a stand-in
   *               for the Helmholtz–Kohlrausch and Hunt effects.
   *  shadowCurve  Exponent on exposure. 1 = linear; > 1 = deeper shadows.
   *
   * v1 (HSV): ambient, shadowCurve, warmth, glow; see renderV1 in the .glsl file.
   *
   * v3 (physically based)
   *  whitePercentile  The reference white: this percentile of the wall
   *               pixels' luminance, over all of a room's photos (or the whole
   *               video). Those well-lit wall areas show the paint exactly as
   *               its swatch; brighter areas (sunbeams) exceed it.
   *  whiteLuminance   Assumed absolute luminance of that reference white, in
   *               cd/m², for the CIECAM16 degree of adaptation. 250 cd/m² is a
   *               bright interior wall by day. The photos carry no absolute
   *               level, so this sets the scale; D depends on it only weakly.
   *  adaptationScale  Multiplies CIECAM16's degree of adaptation D (≈ 0.85–0.95
   *               for interiors). CIECAM16 predicts what an observer IN the room
   *               sees; the furniture on screen keeps the camera's colours, so
   *               fully adapted walls would look unrelated to the room around
   *               them. 0.4 gives D ≈ 0.35, matching v2's tuned look, while
   *               keeping CIECAM16's dependence on the light level.
   *  ambient      Indirect (bounced) light as a share of the scene's mean wall
   *               light: about 10–20 % in furnished rooms.
   *  bounceShare  Share of that indirect light that came off the walls (the
   *               rest: ceiling, floor, sky).
   *  interreflection  Form factor f: share of wall-bounced light that reaches
   *               other walls again. Multiple bounces scale indirect light by
   *               ρ / (1 - f ρ) for a wall reflectance ρ (radiosity).
   *  detail       Strength of the full-resolution brightness detail, 0..1.
   */
  const SHADER_DEFAULTS = {
    penumbra:     0.2,
    dither:       true,
    // v2
    warmCCT:      2700,
    warmTint:     0.0,
    skyCCT:       10000,
    adaptation:   0.35,
    fill:         0.12,
    bounce:       0.4,
    glow:         0.5,
    shadowCurve:  1.0,
    v1: { ambient: 0.12, shadowCurve: 1.0, warmth: 0.8, glow: 1.2 },
    v3: {
      whitePercentile: 0.95,
      whiteLuminance:  250,
      adaptationScale: 0.4,
      ambient:         0.15,
      bounceShare:     0.5,
      interreflection: 0.5,
      detail:          1.0
    }
  };

  // ======================================================================
  // Shader loading
  // ======================================================================

  /** Section names expected in the .glsl file (see its header). */
  const SECTIONS = ["VERT", "COMMON", "DECODE", "ADJUST", "BLUR", "ANALYSE", "RENDER"];

  /**
   * Complete GLSL sources, ready to compile: the vertex shader and one
   * fragment shader per pass (COMMON + "\n" + its section).
   * @typedef {{ vert: string, decode: string, adjust: string, blur: string, analyse: string, render: string }} ShaderSources
   */

  /**
   * Fetches the shader file and cuts it into programs at its "//@@NAME"
   * marker lines. A section runs from the line after its marker to the next
   * marker, so "#version 300 es" stays the first line of VERT and COMMON.
   * Needs http(s): fetch() can't read file:// URLs.
   * @param {string} url  Relative to the page.
   * @returns {Promise<ShaderSources>}
   * @throws {PaintError} "load" when the file can't be fetched or a section is missing.
   */
  async function loadShaders(url) {
    let text;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (err) {
      throw new PaintError("load", `Couldn't load ${url}: ${err.message}`);
    }
    const markers = [...text.matchAll(/^\/\/@@(\w+)[^\n]*(?:\n|$)/gm)];
    /** @type {Record<string, string>} */
    const parts = {};
    markers.forEach((m, i) => {
      const end = i + 1 < markers.length ? markers[i + 1].index : text.length;
      parts[m[1]] = text.slice(m.index + m[0].length, end);
    });
    for (const name of SECTIONS)
      if (!(name in parts)) throw new PaintError("load", `${url} has no //@@${name} section`);
    const fragment = name => parts.COMMON + "\n" + parts[name];
    return {
      vert: parts.VERT, decode: fragment("DECODE"), adjust: fragment("ADJUST"),
      blur: fragment("BLUR"), analyse: fragment("ANALYSE"), render: fragment("RENDER")
    };
  }

  // ======================================================================
  // WebGL helpers
  // ======================================================================

  /**
   * Compiles one shader stage.
   * @throws {Error} With the driver's info log (also when the context is lost).
   */
  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error("Shader compile error:\n" + gl.getShaderInfoLog(s));
    return s;
  }

  /**
   * One active uniform of a linked program.
   * @typedef {{ loc: WebGLUniformLocation, type: GLenum, size: number }} UniformInfo
   * @typedef {{ p: WebGLProgram, uniforms: Record<string, UniformInfo> }} Program
   */

  /**
   * Links a program and lists its active uniforms with their GLSL types, so
   * setUniform() knows how to set each one. Arrays are listed under their
   * plain name ("cmf", not "cmf[0]"). Uniforms the compiler optimised away
   * are absent, and are skipped when set.
   * @returns {Program}
   * @throws {Error} With the info log when compiling or linking fails.
   */
  function makeProgram(gl, vert, frag) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vert));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error("Program link error:\n" + gl.getProgramInfoLog(p));
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const u = gl.getActiveUniform(p, i);
      uniforms[u.name.replace(/\[0\]$/, "")] = { loc: gl.getUniformLocation(p, u.name), type: u.type, size: u.size };
    }
    return { p, uniforms };
  }

  /**
   * Sets a uniform from a JS value according to its GLSL type.
   * @param {WebGL2RenderingContext} gl
   * @param {UniformInfo} u
   * @param {number | boolean | ArrayLike<number>} v  Numbers for scalars;
   *   arrays for vectors, arrays of vectors and matrices (column-major).
   */
  function setUniform(gl, u, v) {
    switch (u.type) {
      case gl.FLOAT:      gl.uniform1f(u.loc, +v); break;
      case gl.INT: case gl.BOOL: case gl.SAMPLER_2D:
                          gl.uniform1i(u.loc, +v); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, v); break;
      default: throw new Error(`Unsupported uniform type 0x${u.type.toString(16)}`);
    }
  }

  /**
   * Creates an empty 2-D texture with clamp-to-edge wrapping, left bound.
   * @param {WebGL2RenderingContext} gl
   * @param {number} w
   * @param {number} h
   * @param {GLenum} internal  Sized internal format (gl.RGBA8, gl.RGBA16F).
   * @param {GLenum} type      gl.UNSIGNED_BYTE or gl.HALF_FLOAT.
   * @param {"nearest" | "linear" | "mipmap"} filter  "mipmap" = trilinear
   *   minification (call generateMipmap after filling it).
   * @returns {WebGLTexture}
   */
  function makeTexture(gl, w, h, internal, type, filter) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    const mag = filter === "nearest" ? gl.NEAREST : gl.LINEAR;
    const min = filter === "mipmap" ? gl.LINEAR_MIPMAP_LINEAR : mag;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
    return t;
  }

  /**
   * An offscreen RGBA16F render target. Half floats hold the signed and > 1
   * values of linear light and light maps (RGBA8 would clamp and band them).
   * Rendering to them needs EXT_color_buffer_float or EXT_color_buffer_half_float.
   * @typedef {{ tex: WebGLTexture, fbo: WebGLFramebuffer, w: number, h: number }} Target
   * @returns {Target}
   * @throws {Error} When the framebuffer is incomplete.
   */
  function makeTarget(gl, w, h) {
    const tex = makeTexture(gl, w, h, gl.RGBA16F, gl.HALF_FLOAT, "linear");
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error("This GPU/browser can't render to half-float textures.");
    return { tex, fbo, w, h };
  }

  /** Pixel size of any image source. */
  function sizeOf(src) {
    return [src.naturalWidth || src.videoWidth || src.width, src.naturalHeight || src.videoHeight || src.height];
  }

  // ======================================================================
  // Colour
  // ======================================================================

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

  /** @returns {[number, number, number]} 8-bit encoded sRGB channels of "#rrggbb". */
  function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  /** sRGB transfer: encoded 0..1 -> linear 0..1 (IEC 61966-2-1). */
  const decodeSrgb = c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  /** Inverse: linear 0..1 -> encoded 0..1. */
  const encodeSrgb = c => c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;

  /** @returns {[number, number, number]} "#rrggbb" as linear sRGB, 0..1. */
  function hexToLinear(hex) { return /** @type {[number, number, number]} */ (hexToRgb(hex).map(c => decodeSrgb(c / 255))); }

  /** Linear sRGB (clamped to 0..1) -> "#rrggbb". */
  function linearToHex(lin) {
    return "#" + lin.map(c => Math.round(255 * encodeSrgb(Math.min(1, Math.max(0, c)))).toString(16).padStart(2, "0")).join("");
  }

  /** Relative luminance Y of linear sRGB (Rec. 709 weights; lum() in the shader). */
  const luminance = ([r, g, b]) => 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;

  /**
   * Light reflectance value: relative luminance x 100, as printed on paint
   * charts (0 = black, 100 = perfect white). Not perceptual lightness.
   * Example: #e3d4b9 -> Y ≈ 0.669 -> LRV 67.
   * @param {string} hex
   * @returns {number} Integer 0..100.
   */
  function lrv(hex) { return Math.round(100 * luminance(hexToLinear(hex))); }

  /**
   * Linear sRGB -> Oklab (Ottosson 2020), the same matrices as oklab() in the
   * shader's COMMON.
   * @returns {[number, number, number]} [L, a, b].
   */
  function oklab(r, g, b) {
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  }

  // ---- 3x3 matrices: row-major arrays of 9 numbers --------------------------

  const mat = {
    /** a x b */
    mul(a, b) {
      const o = new Array(9);
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
        o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
      return o;
    },
    /** m x v */
    apply(m, [x, y, z]) {
      return [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
    },
    /** m^-1 (adjugate / determinant) */
    inverse(m) {
      const [a, b, c, d, e, f, g, h, i] = m;
      const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
      const det = a * A + b * B + c * C;
      return [A, -(b * i - c * h), b * f - c * e,
              B, a * i - c * g, -(a * f - c * d),
              C, -(a * h - b * g), a * e - b * d].map(v => v / det);
    },
    diag([x, y, z]) { return [x, 0, 0, 0, y, 0, 0, 0, z]; },
    /** Column-major Float32Array, as uniformMatrix3fv expects. */
    toGL(m) { return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]); },
    IDENTITY: [1, 0, 0, 0, 1, 0, 0, 0, 1]
  };

  /** Linear sRGB -> CIE XYZ (D65). Same as RGB2XYZ in the shader. */
  const RGB2XYZ = [0.4124564, 0.3575761, 0.1804375,
                   0.2126729, 0.7151522, 0.0721750,
                   0.0193339, 0.1191920, 0.9503041];
  /** CIE XYZ (D65) -> linear sRGB. Same as XYZ2RGB in the shader. */
  const XYZ2RGB = [ 3.2404542, -1.5371385, -0.4985314,
                   -0.9692660,  1.8760108,  0.0415560,
                    0.0556434, -0.2040259,  1.0572252];
  /** CAT16 (CIECAM16's chromatic adaptation transform). Same as CAT16 in the shader. */
  const CAT16 = [ 0.401288, 0.650173, -0.051461,
                 -0.250268, 1.204414,  0.045854,
                 -0.002079, 0.048952,  0.953127];

  /**
   * RGB -> XYZ matrix of an RGB space from its primaries' and white's xy.
   * Columns are the primaries' XYZ, scaled so RGB (1,1,1) -> the white (Y = 1).
   */
  function rgbToXyzMatrix([[xr, yr], [xg, yg], [xb, yb]], [xw, yw]) {
    const P = [xr / yr, xg / yg, xb / yb, 1, 1, 1, (1 - xr - yr) / yr, (1 - xg - yg) / yg, (1 - xb - yb) / yb];
    const S = mat.apply(mat.inverse(P), [xw / yw, 1, (1 - xw - yw) / yw]);
    return mat.mul(P, mat.diag(S));
  }

  /** D65 white point, CIE 1931 xy. */
  const D65_XY = [0.3127, 0.3290];
  /**
   * Linear sRGB -> linear Display P3 (both D65; primaries from IEC 61966-2-1
   * and SMPTE EG 432-1). Both matrices are derived from the primaries, so
   * white maps to exactly white.
   */
  const SRGB_TO_P3 = mat.mul(
    mat.inverse(rgbToXyzMatrix([[0.680, 0.320], [0.265, 0.690], [0.150, 0.060]], D65_XY)),
    rgbToXyzMatrix([[0.640, 0.330], [0.300, 0.600], [0.150, 0.060]], D65_XY));

  /**
   * True when this browser and display can show Display P3 from WebGL and 2D
   * canvases. Then the pipeline renders in P3, so colours outside sRGB (vivid
   * paints in warm light) are shown instead of gamut-mapped.
   */
  function supportsWideGamut() {
    return typeof matchMedia === "function" && matchMedia("(color-gamut: p3)").matches &&
           typeof WebGL2RenderingContext !== "undefined" &&
           "drawingBufferColorSpace" in WebGL2RenderingContext.prototype;
  }

  // ======================================================================
  // Spectral rendering (v3)
  // ======================================================================
  //
  // Reflected light = light spectrum x paint reflectance, wavelength by
  // wavelength. An RGB multiply only approximates that. Every light in v3 is
  // a blackbody (its spectrum is Planck's law at the measured colour
  // temperature), so the exact product is cheap: SPECTRAL_N samples.
  //
  // The paint is known only as an sRGB colour, so a smooth reflectance
  // spectrum is fitted to it (Jakob & Hanika 2019: a sigmoid of a quadratic,
  // which keeps reflectance in 0..1 and smooth like real paints). The fit
  // targets the paint's colour under the REFERENCE light: the blackbody at
  // the colour temperature of D65, which is what the camera's neutral means.

  /** Wavelength samples: 380..720 nm in 20 nm steps. The shader uses the same. */
  const SPECTRAL_N = 18, LAMBDA0 = 380, LAMBDA_STEP = 20;
  const LAMBDAS = Array.from({ length: SPECTRAL_N }, (_, i) => LAMBDA0 + LAMBDA_STEP * i);

  /**
   * CIE 1931 2-degree colour-matching functions, from the multi-lobe Gaussian
   * fit of Wyman, Sloan & Shirley 2013 ("Simple Analytic Approximations to the
   * CIE XYZ Color Matching Functions"), accurate to about 1 % of the peak.
   * @param {number} l  Wavelength in nm.
   * @returns {[number, number, number]} [x̄, ȳ, z̄].
   */
  function cieCMF(l) {
    const g = (mu, s1, s2) => { const t = (l - mu) / (l < mu ? s1 : s2); return Math.exp(-0.5 * t * t); };
    return [1.056 * g(599.8, 37.9, 31.0) + 0.362 * g(442.0, 16.0, 26.7) - 0.065 * g(501.1, 20.4, 26.2),
            0.821 * g(568.8, 46.9, 40.5) + 0.286 * g(530.9, 16.3, 31.1),
            1.217 * g(437.0, 11.8, 36.0) + 0.681 * g(459.0, 26.0, 13.8)];
  }
  /** The CMFs at LAMBDAS, flattened (the shader's `cmf` uniform). */
  const CMF = new Float32Array(LAMBDAS.flatMap(cieCMF));

  /** Planck's law (relative; same as planck() in the shader). λ in nm, T in K. */
  function planck(lambdaNm, T) {
    const l = lambdaNm / 1000;
    return 1 / (l ** 5 * (Math.exp(14387.77 / (l * T)) - 1));
  }

  /** Correlated colour temperature from CIE 1931 xy (McCamy 1992; mccamyCCT() in the shader). */
  function mccamyCCT(x, y) {
    const n = (x - 0.3320) / (0.1858 - y);
    return ((449 * n + 3525) * n + 6823.3) * n + 5520.33;
  }

  /** The reference light's colour temperature: McCamy's CCT of D65 (≈ 6504 K). */
  const T_REF = mccamyCCT(...D65_XY);

  /**
   * XYZ of a blackbody at T reflected by `refl` (or of the light itself when
   * refl is null), normalised to a light of luminance 1.
   * @param {number} T
   * @param {ArrayLike<number> | null} refl  Reflectance at each of LAMBDAS.
   */
  function spectralXYZ(T, refl) {
    let X = 0, Y = 0, Z = 0, Yw = 0;
    for (let i = 0; i < SPECTRAL_N; i++) {
      const p = planck(LAMBDAS[i], T), r = refl ? refl[i] : 1;
      X += p * r * CMF[i * 3]; Y += p * r * CMF[i * 3 + 1]; Z += p * r * CMF[i * 3 + 2];
      Yw += p * CMF[i * 3 + 1];
    }
    return [X / Yw, Y / Yw, Z / Yw];
  }

  /**
   * Per-channel scale that maps the reference light (reflectance 1) to exactly
   * RGB (1,1,1): the camera's neutral. (The blackbody at D65's CCT is not
   * exactly D65; this absorbs the 0.003 Duv difference.)
   */
  const WHITE_NORM = mat.apply(XYZ2RGB, spectralXYZ(T_REF, null)).map(v => 1 / v);

  /** Linear RGB (reference-normalised) of reflectance `refl` under the reference light. */
  function reflectedRGB(refl) {
    return mat.apply(XYZ2RGB, spectralXYZ(T_REF, refl)).map((v, i) => v * WHITE_NORM[i]);
  }

  /** Jakob–Hanika reflectance: sigmoid of a quadratic in normalised wavelength. */
  function sigmoidReflectance([c0, c1, c2]) {
    return LAMBDAS.map(l => {
      const t = (l - 550) / 170, x = (c0 * t + c1) * t + c2;
      return 0.5 + x / (2 * Math.sqrt(1 + x * x));
    });
  }

  /**
   * Fits a smooth reflectance spectrum to a linear sRGB colour (damped
   * Gauss–Newton on the three coefficients). Targets are kept inside
   * 0.001..0.999 (a sigmoid never reaches 0 or 1); RENDER's paintFix removes
   * the remaining error, so the paint is exact under the reference light.
   * @param {number[]} target  Linear sRGB.
   * @returns {number[]} Reflectance at each of LAMBDAS.
   */
  function fitReflectance(target) {
    const t = target.map(v => Math.min(0.999, Math.max(0.001, v)));
    const y = luminance(t);
    let c = [0, 0, (2 * y - 1) / (2 * Math.sqrt(y * (1 - y)))];   // a flat grey of the right luminance
    const residual = cc => reflectedRGB(sigmoidReflectance(cc)).map((v, i) => v - t[i]);
    for (let iter = 0; iter < 60; iter++) {
      const r = residual(c);
      if (Math.hypot(...r) < 1e-7) break;
      const J = [], h = 1e-5;          // numeric Jacobian, 3 x 3, row-major
      const cols = [0, 1, 2].map(k => { const d = c.slice(); d[k] += h; return residual(d).map((v, i) => (v - r[i]) / h); });
      for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) J[i * 3 + k] = cols[k][i];
      let step = mat.apply(mat.inverse(J), r).map(v => -v);
      if (!step.every(Number.isFinite)) break;
      const len = Math.hypot(...step);
      if (len > 5) step = step.map(v => v * 5 / len);   // damping: no wild jumps
      c = c.map((v, k) => v + step[k]);
    }
    return sigmoidReflectance(c);
  }

  /**
   * Everything RENDER needs to know about one paint.
   * @typedef {Object} PaintSpec
   * @property {string} hex
   * @property {number[]} albedo       Linear sRGB (all models).
   * @property {Float32Array} paintW   v3: reflectance x CMF at each wavelength.
   * @property {number[]} paintFix     v3: per-channel exactness correction (≈ 1).
   * @property {number} bounceScale    v3: interreflection relative to the original white walls.
   */

  /** @type {Map<string, PaintSpec>} paintSpec() cache (paint fades create many). */
  const paintCache = new Map();

  /**
   * @param {string} hex  "#rrggbb".
   * @returns {PaintSpec}
   */
  function paintSpec(hex) {
    hex = normalizeHex(hex);
    let spec = paintCache.get(hex);
    if (spec) return spec;
    const albedo = hexToLinear(hex);
    const refl = fitReflectance(albedo);
    const paintW = new Float32Array(SPECTRAL_N * 3);
    for (let i = 0; i < SPECTRAL_N * 3; i++) paintW[i] = refl[Math.floor(i / 3)] * CMF[i];
    const fitted = reflectedRGB(refl);
    // Radiosity: indirect light grows as ρ / (1 - f ρ); relative to the
    // original white walls (ρ = 1).
    const f = SHADER_DEFAULTS.v3.interreflection, rho = Math.max(luminance(albedo), 1e-4);
    spec = {
      hex, albedo, paintW,
      paintFix: albedo.map((v, i) => fitted[i] > 1e-6 ? v / fitted[i] : 1),
      bounceScale: (rho / (1 - f * rho)) * (1 - f)
    };
    if (paintCache.size > 256) paintCache.clear();
    paintCache.set(hex, spec);
    return spec;
  }

  /**
   * A paint part-way between two others, for fades: every field is mixed
   * linearly, in floats (no 8-bit rounding). Mixing reflectances linearly is
   * how light from two surfaces side by side adds up.
   * @param {PaintSpec} a
   * @param {PaintSpec} b
   * @param {number} k  0 = a, 1 = b.
   * @returns {PaintSpec}
   */
  function mixPaint(a, b, k) {
    if (k <= 0) return a;
    if (k >= 1) return b;
    const lerp = (x, y) => x + (y - x) * k;
    return {
      hex: b.hex,
      albedo: a.albedo.map((v, i) => lerp(v, b.albedo[i])),
      paintW: a.paintW.map((v, i) => lerp(v, b.paintW[i])),
      paintFix: a.paintFix.map((v, i) => lerp(v, b.paintFix[i])),
      bounceScale: lerp(a.bounceScale, b.bounceScale)
    };
  }

  // ======================================================================
  // Statistics: LightStats
  // ======================================================================

  /** Encoded sRGB byte -> linear, as a lookup table (LightStats runs it per pixel). */
  const LINEAR_LUT = Float32Array.from({ length: 256 }, (_, i) => decodeSrgb(i / 255));

  /**
   * Histogram resolution, and the largest values counted: luminance (1 =
   * white), Oklab distance from white (black is 1.0) and Oklab chroma (the
   * sRGB gamut reaches about 0.32).
   */
  const STATS_BINS = 1024, DE_MAX = 1.5, CHROMA_MAX = 0.4;

  /** Histogram bin of `v` in 0..max (out-of-range values go to the end bins). */
  function binOf(v, max) { return Math.min(STATS_BINS - 1, Math.max(0, Math.floor(v / max * STATS_BINS))); }

  /** The q-quantile (0..1) of a histogram over 0..max, as the centre of its bin. */
  function quantileOf(hist, q, max) {
    let total = 0;
    for (const n of hist) total += n;
    if (!total) return NaN;
    for (let i = 0, run = 0; i < STATS_BINS; i++) {
      run += hist[i];
      if (run >= total * q) return (i + 0.5) / STATS_BINS * max;
    }
    return max;
  }

  /**
   * Statistics of a set of images (a room's photos, or a video's frames),
   * measured on the CPU from small copies:
   *
   *   over ALL pixels (the sliders compare each pixel with these)
   *     pivotY        median luminance (the Contrast slider's fixed point)
   *     medianDE      median Oklab distance from pure white   } Saturation's
   *     medianChroma  median Oklab chroma                     } references
   *   over WALL pixels, weighted by the mask (v3's calibration)
   *     refY          the reference white: the SHADER_DEFAULTS.v3.whitePercentile
   *                   of wall luminance
   *     wallMean      mean linear RGB of the wall light (the scene's white for
   *                   adaptation)
   *     meanWallY     mean wall luminance
   *
   * add() measures one image; combine() pools several (a room = its photos).
   */
  class LightStats {
    #w; #h; #ctx = null;
    #lum = new Float64Array(STATS_BINS);
    #de = new Float64Array(STATS_BINS);
    #chroma = new Float64Array(STATS_BINS);
    #wallLum = new Float64Array(STATS_BINS);
    #wallSum = [0, 0, 0];
    #wallW = 0;
    /** @type {WeakMap<object, Float32Array>} Wall weights per mask image, at this size. */
    #maskCache = new WeakMap();

    /**
     * @param {number} w  Measuring size: images are downscaled to w x h first.
     * @param {number} h
     */
    constructor(w, h) {
      this.#w = w; this.#h = h;
      this.pivotY = 0.18; this.medianDE = 0.5; this.medianChroma = 0.02;   // placeholders until add()
      this.refY = 1; this.wallMean = [1, 1, 1]; this.meanWallY = 1;
    }

    /** Draws `src` at the measuring size and returns its RGBA bytes. */
    #pixels(src) {
      if (!this.#ctx) {
        // willReadFrequently keeps this canvas on the CPU, so getImageData is cheap.
        this.#ctx = Object.assign(document.createElement("canvas"), { width: this.#w, height: this.#h })
          .getContext("2d", { willReadFrequently: true });
        this.#ctx.imageSmoothingQuality = "high";
      }
      this.#ctx.clearRect(0, 0, this.#w, this.#h);
      this.#ctx.drawImage(src, 0, 0, this.#w, this.#h);
      return this.#ctx.getImageData(0, 0, this.#w, this.#h).data;
    }

    /** Wall weight per pixel (1 = wall) for a mask image, cached. */
    #wallWeights(mask) {
      let wts = this.#maskCache.get(mask);
      if (!wts) {
        const px = this.#pixels(mask);
        wts = new Float32Array(this.#w * this.#h);
        // As CSS luminance masks (and DECODE): mask value = brightness x alpha; 0 = wall.
        for (let i = 0; i < wts.length; i++) wts[i] = 1 - (px[i * 4] / 255) * (px[i * 4 + 3] / 255);
        this.#maskCache.set(mask, wts);
      }
      return wts;
    }

    /**
     * Adds every pixel of one image.
     * @param {CanvasImageSource} src  Decoded, same-origin.
     * @param {CanvasImageSource | null} [mask]  Its wall mask; without one
     *   every pixel counts as wall.
     */
    add(src, mask = null) {
      const wts = mask ? this.#wallWeights(mask) : null;
      const px = this.#pixels(src);
      for (let p = 0, i = 0; p < px.length; p += 4, i++) {
        const r = LINEAR_LUT[px[p]], g = LINEAR_LUT[px[p + 1]], b = LINEAR_LUT[px[p + 2]];
        const Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
        const [L, A, B] = oklab(r, g, b);
        this.#lum[binOf(Y, 1)]++;
        this.#de[binOf(Math.hypot(1 - L, A, B), DE_MAX)]++;
        this.#chroma[binOf(Math.hypot(A, B), CHROMA_MAX)]++;
        const w = wts ? wts[i] : 1;
        if (w > 0) {
          this.#wallLum[binOf(Y, 1)] += w;
          this.#wallSum[0] += w * r; this.#wallSum[1] += w * g; this.#wallSum[2] += w * b;
          this.#wallW += w;
        }
      }
      this.#update();
    }

    /**
     * Pools several LightStats (e.g. a room's photos) into a new one.
     * @param {LightStats[]} list
     * @returns {LightStats}
     */
    static combine(list) {
      const out = new LightStats(1, 1);
      for (const s of list) {
        for (const k of ["lum", "de", "chroma", "wallLum"]) {
          const from = s.#hist(k), to = out.#hist(k);
          for (let i = 0; i < STATS_BINS; i++) to[i] += from[i];
        }
        for (let c = 0; c < 3; c++) out.#wallSum[c] += s.#wallSum[c];
        out.#wallW += s.#wallW;
      }
      out.#update();
      return out;
    }

    #hist(k) { return k === "lum" ? this.#lum : k === "de" ? this.#de : k === "chroma" ? this.#chroma : this.#wallLum; }

    #update() {
      this.pivotY = quantileOf(this.#lum, 0.5, 1);
      this.medianDE = quantileOf(this.#de, 0.5, DE_MAX);
      this.medianChroma = quantileOf(this.#chroma, 0.5, CHROMA_MAX);
      if (this.#wallW > 0) {
        this.refY = Math.max(quantileOf(this.#wallLum, SHADER_DEFAULTS.v3.whitePercentile, 1), 1e-3);
        this.wallMean = this.#wallSum.map(v => v / this.#wallW);
        this.meanWallY = luminance(this.wallMean);
      }
    }
  }

  // ======================================================================
  // Sliders: Contrast, Saturation, "Difference from white"
  // ======================================================================

  /**
   * How the saturation slider measures a pixel's "difference from pure white":
   *   "full"    Oklab distance from white: lightness and colour both count, so
   *             dark pixels count as far from white even when they are grey.
   *   "chroma"  Oklab chroma only: just the colour cast, whatever the lightness.
   * @typedef {"full" | "chroma"} SatMeasure
   */
  /** SatMeasure -> the shader's satMeasure uniform. */
  const SAT_MEASURES = { full: 0, chroma: 1 };

  /**
   * The slider settings.
   * @typedef {{ contrast: number, saturation: number, satMeasure: SatMeasure }} Sliders
   *   contrast and saturation in -1..1; 0 = unchanged.
   */

  /**
   * The settings ADJUST runs with (uniform names in the .glsl file).
   * @typedef {Object} Adjustment
   * @property {number} contrastK   Exponent on luminance; 1 = unchanged.
   * @property {number} satAmount   -1..1; 0 = unchanged.
   * @property {0 | 1} satMeasure   SAT_MEASURES value.
   * @property {number} pivotY      LightStats#pivotY.
   * @property {number} medianDiff  LightStats#medianDE or #medianChroma, per satMeasure.
   */

  /**
   * The ADJUST settings for the sliders, or null when both amounts are 0
   * (ADJUST is then skipped, so the output is exactly as without sliders).
   * Contrast -1..1 maps to a luminance exponent of 0.5..2.
   * @param {Sliders} sliders
   * @param {LightStats} stats
   * @returns {Adjustment | null}
   */
  function makeAdjustment({ contrast, saturation, satMeasure }, stats) {
    if (contrast === 0 && saturation === 0) return null;
    return {
      contrastK: 2 ** contrast, satAmount: saturation, satMeasure: SAT_MEASURES[satMeasure], pivotY: stats.pivotY,
      medianDiff: satMeasure === "chroma" ? stats.medianChroma : stats.medianDE
    };
  }

  /**
   * Validates a slider amount.
   * @returns {number} `amount`, clamped to -1..1.
   * @throws {RangeError} When it isn't a finite number.
   */
  function toAmount(amount) {
    const n = Number(amount);
    if (!Number.isFinite(n)) throw new RangeError(`Expected a number from -1 to 1, got "${amount}"`);
    return Math.max(-1, Math.min(1, n));
  }

  /**
   * @returns {SatMeasure}
   * @throws {RangeError} For an unknown measure.
   */
  function toSatMeasure(measure) {
    if (!Object.hasOwn(SAT_MEASURES, measure)) throw new RangeError(`Unknown saturation measure "${measure}"`);
    return /** @type {SatMeasure} */ (measure);
  }

  /**
   * @returns {Model}
   * @throws {RangeError} For an unknown model.
   */
  function toModel(model) {
    if (!Object.hasOwn(MODELS, model)) throw new RangeError(`Unknown shader model "${model}"`);
    return /** @type {Model} */ (model);
  }

  // ======================================================================
  // Scene calibration (v3)
  // ======================================================================

  /**
   * v3's per-scene settings.
   * @typedef {Object} SceneSpec
   * @property {number} refY          The room's / video's reference white luminance.
   * @property {Float32Array} adaptMat  Scene-wide CAT16 adaptation (column-major).
   * @property {number} D             The degree of adaptation used.
   * @property {number} oldBounce     Light the original white walls bounced, in reference-white units.
   */

  /**
   * CIECAM16 degree of adaptation for an adapting luminance La (cd/m²), in an
   * average surround (F = 1): D = F (1 - (1/3.6) e^((-La - 42) / 92)).
   */
  function ciecamD(La) { return 1 - Math.exp((-La - 42) / 92) / 3.6; }

  /**
   * v3 calibration and adaptation for one scene (one photo, or the video).
   *
   * Adaptation: the eye adapts to the scene's light as a whole, not pixel by
   * pixel, so a sunbeam stays warmer than the light around it. The scene's
   * white is its mean wall light (`scene.wallMean`). The degree D comes from
   * CIECAM16 for the scene's adapting luminance (20 % of the white's, the
   * usual grey-world assumption, scaled by how bright this scene is relative
   * to the reference white), times adaptationScale (see SHADER_DEFAULTS).
   * The matrix is a von Kries gain in CAT16 space: from the scene white
   * toward neutral, by D.
   *
   * @param {LightStats} scene  This scene's statistics (one photo / the video).
   * @param {LightStats} room   The pooled statistics that set the reference white.
   * @returns {SceneSpec}
   */
  function sceneSpec(scene, room) {
    const S = SHADER_DEFAULTS.v3, refY = room.refY;
    const La = 0.2 * S.whiteLuminance * Math.min(4, scene.meanWallY / refY);
    const D = Math.min(1, Math.max(0, S.adaptationScale * ciecamD(La)));
    const toCat = mat.mul(CAT16, RGB2XYZ), fromCat = mat.inverse(toCat);
    const white = scene.wallMean.map(v => v / Math.max(luminance(scene.wallMean), 1e-6));
    const wSrc = mat.apply(toCat, white), wDst = mat.apply(toCat, [1, 1, 1]);
    const gain = wSrc.map((s, i) => D * wDst[i] / Math.max(s, 1e-6) + 1 - D);
    const adapt = mat.mul(fromCat, mat.mul(mat.diag(gain), toCat));
    return {
      refY, D,
      adaptMat: mat.toGL(adapt),
      oldBounce: S.ambient * S.bounceShare * Math.min(4, scene.meanWallY / refY)
    };
  }

  // ======================================================================
  // LightPipeline — one WebGL2 context running every pass
  // ======================================================================

  /**
   * A GPU image: a source texture (RGBA8, encoded sRGB) or a light map
   * (RGBA16F render target). Handles keep their identity across a context
   * loss; the pipeline recreates their GL objects and refills sources.
   * @typedef {Object} SourceHandle
   * @property {"source"} kind
   * @property {WebGLTexture} tex
   * @property {number} w
   * @property {number} h
   * @property {boolean} mipmaps
   * @property {TexImageSource | null} image  Last upload, kept for restores.
   * @property {number} version  Bumped on every upload (part of the analysis key).
   *
   * @typedef {Object} LightMapHandle
   * @property {"lightMap"} kind
   * @property {Target} target
   * @property {string | null} analysedFor  Analysis cache key, null = stale.
   */

  /**
   * What analyse() needs.
   * @typedef {Object} AnalyseJob
   * @property {SourceHandle} src
   * @property {SourceHandle} mask
   * @property {LightMapHandle} lightMap
   * @property {Model} model
   * @property {Adjustment | null} adjust
   * @property {number} refY  v3's reference white (ignored by v1/v2).
   */

  /**
   * What render() needs.
   * @typedef {Object} RenderJob
   * @property {LightMapHandle} lightMap
   * @property {SourceHandle} src
   * @property {Model} model
   * @property {PaintSpec} paint
   * @property {SceneSpec} scene
   * @property {number} detailGamma  v3: detail strength x the contrast exponent.
   */

  /**
   * Owns one WebGL2 context on `canvas` and runs every pass:
   *
   *   analyse()  DECODE (source -> lin, at the analysis size A)
   *              ADJUST (sliders, optional) -> BLUR x2 (v2, v3) -> ANALYSE
   *              -> the job's light map
   *   render()   RENDER the light map and paint into the canvas (size R)
   *
   * Shared scratch targets at A: lin, adj, tmp, blurred, raw. They only hold
   * data during one analyse() call. Callers own sources, masks and light maps
   * (created here, so they can be rebuilt after a context loss).
   *
   * The output colour space is Display P3 when `wideGamut` and the browser
   * supports it, otherwise sRGB (see outputSpace).
   */
  class LightPipeline {
    /** @type {{ onRestored: () => void, onError: (err: unknown) => void }} */
    #hooks;
    /** @type {ShaderSources} */
    #sources;
    /** @type {Set<SourceHandle | LightMapHandle>} */
    #handles = new Set();
    /** @type {CanvasRenderingContext2D | null} Resizes images whose size differs from their texture. */
    #scratch = null;
    #wideGamut;

    /**
     * @param {HTMLCanvasElement} canvas  Resized to the render size.
     * @param {Object} o
     * @param {[number, number]} o.analysis  A: width, height of the light maps.
     * @param {[number, number]} o.render    R: width, height of the output.
     * @param {ShaderSources} o.sources
     * @param {{ onRestored: () => void, onError: (err: unknown) => void }} o.hooks
     * @param {boolean} [o.wideGamut=false]  Render in Display P3 if supported.
     * @param {boolean} [o.preserveDrawingBuffer=false]  Keep the canvas pixels
     *   after compositing (true when they are copied out with drawImage later).
     * @throws {PaintError} "webgl" when WebGL2, float targets or the sizes aren't supported.
     */
    constructor(canvas, o) {
      this.canvas = canvas;
      [this.aw, this.ah] = o.analysis;
      [this.rw, this.rh] = o.render;
      canvas.width = this.rw; canvas.height = this.rh;
      this.#sources = o.sources;
      this.#hooks = o.hooks;
      this.#wideGamut = !!o.wideGamut;
      canvas.addEventListener("webglcontextlost", e => e.preventDefault());
      canvas.addEventListener("webglcontextrestored", () => this.#restore());
      // alpha: false (opaque output, faster to composite and copy); no
      // antialias/depth/stencil (fullscreen 2-D passes don't need them).
      this.gl = canvas.getContext("webgl2", {
        alpha: false, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: false, preserveDrawingBuffer: !!o.preserveDrawingBuffer
      });
      if (!this.gl) throw new PaintError("webgl", "WebGL2 is not supported in this browser.");
      this.#init();
    }

    /** True while the GPU context is lost. GL calls are then silent no-ops. */
    get lost() { return this.gl.isContextLost(); }

    /** "display-p3" or "srgb": the canvas's colour space. */
    get outputSpace() { return this.gl.drawingBufferColorSpace || "srgb"; }

    /** Creates every context-level resource (again after a context restore). */
    #init() {
      const gl = this.gl, src = this.#sources;
      if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float"))
        throw new PaintError("webgl", "This GPU/browser can't render to floating-point textures.");
      if (Math.max(this.aw, this.ah, this.rw, this.rh) > gl.getParameter(gl.MAX_TEXTURE_SIZE))
        throw new PaintError("webgl", "The working size is larger than this GPU's limit.");
      if ("unpackColorSpace" in gl) gl.unpackColorSpace = "srgb";
      if (this.#wideGamut && "drawingBufferColorSpace" in gl) gl.drawingBufferColorSpace = "display-p3";
      // Rows top-to-bottom as stored (RENDER flips back), no premultiplication,
      // with the browser's colour management.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
      this.progs = Object.fromEntries(["decode", "adjust", "blur", "analyse", "render"]
        .map(k => [k, makeProgram(gl, src.vert, src[k])]));
      this.scratch = Object.fromEntries(["lin", "adj", "tmp", "blurred", "raw"]
        .map(k => [k, makeTarget(gl, this.aw, this.ah)]));
      // VERT reads no attributes, but WebGL2 still wants a VAO bound to draw.
      gl.bindVertexArray(gl.createVertexArray());
    }

    /** webglcontextrestored: rebuild everything, refill sources, then let the page repaint. */
    #restore() {
      try {
        this.#init();
        for (const h of this.#handles) this.#build(h);
      } catch (err) { this.#hooks.onError(err); return; }
      this.#hooks.onRestored();
    }

    /** (Re)creates a handle's GL objects (and refills a source from its last image). */
    #build(h) {
      const gl = this.gl;
      if (h.kind === "lightMap") { h.target = makeTarget(gl, this.aw, this.ah); h.analysedFor = null; return; }
      h.tex = makeTexture(gl, h.w, h.h, gl.RGBA8, gl.UNSIGNED_BYTE, h.mipmaps ? "mipmap" : "linear");
      if (h.image) this.#fill(h, h.image);
    }

    /**
     * A source texture: a photo, a video frame or a mask. RGBA8 holding
     * encoded sRGB; DECODE and RENDER convert to linear.
     * @param {number} w
     * @param {number} h
     * @param {{ mipmaps?: boolean }} [o]  Mipmaps for sources larger than the
     *   analysis size, so DECODE's downscale averages properly.
     * @returns {SourceHandle}
     */
    createSource(w, h, { mipmaps = false } = {}) {
      const handle = { kind: "source", tex: null, w, h, mipmaps, image: null, version: 0 };
      this.#build(handle);
      this.#handles.add(handle);
      return handle;
    }

    /** @returns {LightMapHandle} An RGBA16F light map at the analysis size. */
    createLightMap() {
      const handle = { kind: "lightMap", target: null, analysedFor: null };
      this.#build(handle);
      this.#handles.add(handle);
      return handle;
    }

    /** Frees a handle's GL objects. */
    release(h) {
      const gl = this.gl;
      this.#handles.delete(h);
      if (h.kind === "lightMap") { gl.deleteTexture(h.target.tex); gl.deleteFramebuffer(h.target.fbo); }
      else gl.deleteTexture(h.tex);
    }

    /**
     * Uploads an image (photo, canvas, video element: its current frame) into
     * a source. Images of another size are resized through a 2-D canvas.
     * @param {SourceHandle} h
     * @param {TexImageSource} image  Same-origin, decoded / with a frame.
     * @throws {PaintError} "origin" when the pixels can't be read (file://).
     */
    upload(h, image) {
      h.image = image;
      this.#fill(h, image);
      h.version++;
    }

    #fill(h, image) {
      const gl = this.gl;
      const [iw, ih] = sizeOf(image);
      let data = image;
      if (iw !== h.w || ih !== h.h) {
        if (!this.#scratch) this.#scratch = document.createElement("canvas").getContext("2d");
        const ctx = this.#scratch;
        if (ctx.canvas.width !== h.w || ctx.canvas.height !== h.h) Object.assign(ctx.canvas, { width: h.w, height: h.h });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.clearRect(0, 0, h.w, h.h);
        ctx.drawImage(image, 0, 0, h.w, h.h);
        data = ctx.canvas;
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, h.tex);
      try { gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, data); }
      catch (err) {
        if (err && err.name === "SecurityError") throw new PaintError("origin", "The browser blocked reading the image's pixels.");
        throw err;
      }
      if (h.mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    /**
     * Runs one fullscreen pass.
     * @param {Program} prog
     * @param {Target | null} target  null = the canvas.
     * @param {Record<string, WebGLTexture>} textures  Sampler name -> texture;
     *   bound to units 0, 1, ... and unbound afterwards, so no texture stays
     *   bound while a later pass renders into it (a feedback loop).
     * @param {Record<string, any>} uniforms  Name -> value (see setUniform).
     */
    #draw(prog, target, textures, uniforms) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
      gl.viewport(0, 0, target ? target.w : this.rw, target ? target.h : this.rh);
      gl.useProgram(prog.p);
      let unit = 0;
      for (const [name, tex] of Object.entries(textures)) {
        const u = prog.uniforms[name];
        if (!u) continue;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(u.loc, unit++);
      }
      for (const [name, v] of Object.entries(uniforms)) {
        const u = prog.uniforms[name];
        if (u) setUniform(gl, u, v);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);    // three vertices = VERT's fullscreen triangle
      while (unit > 0) { gl.activeTexture(gl.TEXTURE0 + --unit); gl.bindTexture(gl.TEXTURE_2D, null); }
    }

    /** Blur radius in pixels: penumbra is a % of the analysis width. */
    get sigma() { return Math.max(0, SHADER_DEFAULTS.penumbra) / 100 * this.aw; }

    /** Two BLUR passes, input -> output, through tmp. */
    #blur(input, output) {
      const P = this.progs.blur, sigma = this.sigma;
      this.#draw(P, this.scratch.tmp, { src: input.tex }, { dir: [1, 0], sigma, blurStep: 1 });
      this.#draw(P, output, { src: this.scratch.tmp.tex }, { dir: [0, 1], sigma, blurStep: 2 });
    }

    /**
     * Fills job.lightMap, unless it already holds this exact analysis (same
     * source version, model, sliders and reference white).
     * @param {AnalyseJob} job
     */
    analyse({ src, mask, lightMap, model, adjust, refY }) {
      const key = [src.version, model, this.sigma, model === "v3" ? refY : "",
                   ...(adjust ? Object.values(adjust) : [])].join("|");
      if (lightMap.analysedFor === key) return;
      const P = this.progs, T = this.scratch, blurs = model !== "v1" && this.sigma >= 0.3;
      this.#draw(P.decode, T.lin, { src: src.tex, wallMask: mask.tex }, { size: [this.aw, this.ah] });
      let light = T.lin;                                       // unblurred, adjusted
      if (adjust) { this.#draw(P.adjust, T.adj, { src: T.lin.tex }, adjust); light = T.adj; }
      let soft = light, raw = T.lin;                            // blurred: adjusted / unadjusted
      if (blurs) {
        this.#blur(light, T.blurred); soft = T.blurred;
        if (model === "v3") { if (adjust) { this.#blur(T.lin, T.raw); raw = T.raw; } else raw = T.blurred; }
      }
      this.#draw(P.analyse, lightMap.target, { lightLin: soft.tex, sharpLin: light.tex, rawLin: raw.tex },
                 { model: MODELS[model], refY });
      lightMap.analysedFor = key;
    }

    /**
     * RENDER: paints the canvas from an analysed light map. The canvas holds
     * the result until the next render (copy it out right away if several
     * images share this pipeline).
     * @param {RenderJob} job
     */
    render({ lightMap, src, model, paint, scene, detailGamma }) {
      const S = SHADER_DEFAULTS;
      this.#draw(this.progs.render, null, { lightMap: lightMap.target.tex, src: src.tex }, {
        size: [this.rw, this.rh], model: MODELS[model], dither: S.dither ? 1 : 0,
        albedo: paint.albedo,
        toOutput: mat.toGL(this.outputSpace === "display-p3" ? SRGB_TO_P3 : mat.IDENTITY),
        // v1 / v2
        warmCCT: S.warmCCT, warmTint: S.warmTint, skyCCT: S.skyCCT, adaptation: S.adaptation,
        fill: S.fill, bounce: S.bounce, glow: S.glow, shadowCurve: S.shadowCurve,
        v1p: [S.v1.ambient, S.v1.shadowCurve, S.v1.warmth, S.v1.glow],
        // v3
        cmf: CMF, paintW: paint.paintW, whiteNorm: WHITE_NORM, paintFix: paint.paintFix,
        adaptMat: scene.adaptMat, oldBounce: scene.oldBounce, bounceScale: paint.bounceScale, detailGamma
      });
    }
  }

  // ---------------------------------------------------------------- small utilities

  /**
   * Fetches and decodes an image off-DOM (e.g. a mask, so it is ready before
   * the CSS mask is switched on and never pops in late).
   * @param {string} src
   * @returns {Promise<HTMLImageElement>}
   * @throws {PaintError} "load" when the image fails.
   */
  async function decodeImage(src) {
    const img = new Image();
    img.src = src;
    try { await img.decode(); } catch { throw new PaintError("load", `Couldn't load ${src}`); }
    return img;
  }

  /**
   * The feature gates every page checks before starting, cheapest first.
   * @throws {PaintError} "nogl", "origin" or "mask".
   */
  function checkGates() {
    if (new URLSearchParams(location.search).has("nogl")) throw new PaintError("nogl");
    if (location.protocol === "file:") throw new PaintError("origin");
    if (!CSS.supports("mask-mode", "luminance")) throw new PaintError("mask");
  }

  // ---------------------------------------------------------------- export
  window.PaintPipeline = {
    // errors + settings
    PaintError, NOTICES, noticeFor, MODELS, SHADER_DEFAULTS, toModel,
    // shaders + GL
    loadShaders, makeProgram, setUniform, makeTexture, makeTarget, LightPipeline,
    // colour
    normalizeHex, hexToRgb, hexToLinear, linearToHex, decodeSrgb, encodeSrgb, luminance, lrv, oklab,
    mat, RGB2XYZ, XYZ2RGB, CAT16, SRGB_TO_P3, D65_XY, rgbToXyzMatrix, supportsWideGamut,
    // spectral
    SPECTRAL_N, LAMBDAS, CMF, cieCMF, planck, mccamyCCT, T_REF, WHITE_NORM,
    spectralXYZ, reflectedRGB, fitReflectance, paintSpec, mixPaint,
    // statistics, sliders, scenes
    LightStats, SAT_MEASURES, makeAdjustment, toAmount, toSatMeasure, ciecamD, sceneSpec,
    // utilities
    decodeImage, checkGates, sizeOf
  };
})();
