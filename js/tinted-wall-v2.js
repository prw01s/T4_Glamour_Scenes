/* ==========================================================================
 * tinted-wall-v2.js  —  perception-aware version (WebGL2)
 *
 * Takes <img id="tintedScene"> ("ImageA") as a LIGHT MAP and renders the
 * dusty-pink wall hsl(0.5, 43%, 76%) lit by it ("ImageB") once the page and
 * all assets have loaded. The canvas takes the image's place on the page.
 *
 * Pipeline (all on the GPU):
 *   P0  decode ImageA from sRGB to linear light
 *   P0b soft penumbra: separable Gaussian blur of the LINEAR light map
 *   P1  STEP 1  theArray[row*W+col] = light at that pixel minus white light:
 *                 x = exposure - 1        (how much light; white = 0)
 *                 y = warm/cool amount    (-1 cool ... 0 neutral ... +1 warm)
 *                 z = light saturation    (white = 0)
 *               Light colour is analysed in Oklab (perceptually uniform hue).
 *   P2  STEPS 2-4 for each ImageB pixel, in the same order:
 *        - warm/cool amount -> colour temperature on the blackbody curve
 *          (interpolated in mireds, which are perceptually even)
 *        - direct light + cool sky / pink bounce fill light
 *        - light x wall colour in linear sRGB (most accurate 3-channel
 *          option for this wall, measured against spectral rendering)
 *        - partial colour constancy: CAT16 von Kries adaptation, degree D
 *        - highlight roll-off + gamut mapping in Oklab at constant hue
 *        - triangular dither before 8-bit output (no banding)
 *
 * API
 *   window.TINTED_WALL_SETTINGS = {...}   // optional, before this script
 *   renderTintedScene({ warmCCT: 2400 })  // re-render the page's scene
 *   TintedWall.create(imgElement, settings) -> { canvas, update(s), sample(x,y) }
 * ======================================================================== */
(function () {
  "use strict";

  const DEFAULTS = {
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
    v1: { ambient: 0.12, shadowCurve: 1.0, warmth: 0.8, glow: 1.2 },
    replaceImage: true
  };

  // ======================================================================
  // GLSL
  // ======================================================================
  const VERT = `#version 300 es
  void main() {
    vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
    gl_Position = vec4(p, 0.0, 1.0);
  }`;

  const COMMON = `#version 300 es
  precision highp float;
  precision highp int;
  precision highp sampler2D;
  out vec4 fragOut;

  // ---- transfer functions ------------------------------------------------
  vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
  vec3 toSRGB(vec3 c)   { c = max(c, 0.0);
                          return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
  float lum(vec3 c)     { return dot(c, vec3(0.2126729, 0.7151522, 0.0721750)); }

  // ---- matrices (written as rows, transposed into GLSL column order) -------
  const mat3 RGB2XYZ = transpose(mat3(0.4124564, 0.3575761, 0.1804375,
                                      0.2126729, 0.7151522, 0.0721750,
                                      0.0193339, 0.1191920, 0.9503041));
  const mat3 XYZ2RGB = transpose(mat3( 3.2404542, -1.5371385, -0.4985314,
                                      -0.9692660,  1.8760108,  0.0415560,
                                       0.0556434, -0.2040259,  1.0572252));
  const mat3 CAT16   = transpose(mat3( 0.401288, 0.650173, -0.051461,
                                      -0.250268, 1.204414,  0.045854,
                                      -0.002079, 0.048952,  0.953127));

  // ---- Oklab (Ottosson 2020) -----------------------------------------------
  vec3 cbrt3(vec3 v) { return sign(v) * pow(abs(v), vec3(1.0 / 3.0)); }
  vec3 oklab(vec3 c) {
    vec3 lms = vec3(dot(c, vec3(0.4122214708, 0.5363325363, 0.0514459929)),
                    dot(c, vec3(0.2119034982, 0.6806995451, 0.1073969566)),
                    dot(c, vec3(0.0883024619, 0.2817188376, 0.6299787005)));
    lms = cbrt3(lms);
    return vec3(dot(lms, vec3(0.2104542553,  0.7936177850, -0.0040720468)),
                dot(lms, vec3(1.9779984951, -2.4285922050,  0.4505937099)),
                dot(lms, vec3(0.0259040371,  0.7827717662, -0.8086757660)));
  }
  vec3 oklabToRGB(vec3 L) {
    vec3 lms = vec3(dot(L, vec3(1.0,  0.3963377774,  0.2158037573)),
                    dot(L, vec3(1.0, -0.1055613458, -0.0638541728)),
                    dot(L, vec3(1.0, -0.0894841775, -1.2914855480)));
    lms = lms * lms * lms;
    return vec3(dot(lms, vec3( 4.0767416621, -3.3077115913,  0.2309699292)),
                dot(lms, vec3(-1.2684380046,  2.6097574011, -0.3413193965)),
                dot(lms, vec3(-0.0041960863, -0.7034186147,  1.7076147010)));
  }

  // ---- HSV / HSL ------------------------------------------------------------
  vec3 rgb2hsv(vec3 c) {
    float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), d = mx - mn;
    float H = 0.0;
    if (d > 1e-6) {
      if      (mx == c.r) H = mod((c.g - c.b) / d, 6.0);
      else if (mx == c.g) H = (c.b - c.r) / d + 2.0;
      else                H = (c.r - c.g) / d + 4.0;
      H *= 60.0;
    }
    return vec3(H, mx > 1e-6 ? d / mx : 0.0, mx);
  }
  vec3 hsv2rgb(vec3 c) {
    vec3 k = mod(vec3(5.0, 3.0, 1.0) + mod(c.x, 360.0) / 60.0, 6.0);
    return c.z - c.z * c.y * clamp(min(k, 4.0 - k), 0.0, 1.0);
  }
  vec3 hsl2rgb(vec3 hsl) {
    vec3 k = mod(vec3(0.0, 8.0, 4.0) + mod(hsl.x, 360.0) / 30.0, 12.0);
    float a = hsl.y * min(hsl.z, 1.0 - hsl.z);
    return hsl.z - a * clamp(min(k - 3.0, 9.0 - k), -1.0, 1.0);
  }

  // ---- blackbody (Planckian) light colour, Kim et al. 2002 -----------------
  vec2 planckXY(float T) {                      // chromaticity of a blackbody
    T = clamp(T, 1667.0, 25000.0);
    float T2 = T * T, T3 = T2 * T, x, y;
    if (T <= 4000.0) x = -0.2661239e9 / T3 - 0.2343589e6 / T2 + 0.8776956e3 / T + 0.179910;
    else             x = -3.0258469e9 / T3 + 2.1070379e6 / T2 + 0.2226347e3 / T + 0.240390;
    float x2 = x * x, x3 = x2 * x;
    if      (T <= 2222.0) y = -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683;
    else if (T <= 4000.0) y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
    else                  y =  3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483;
    return vec2(x, y);
  }
  vec2 xy2uv(vec2 c) { return vec2(4.0 * c.x, 6.0 * c.y) / (-2.0 * c.x + 12.0 * c.y + 3.0); }
  vec2 uv2xy(vec2 c) { return vec2(3.0 * c.x, 2.0 * c.y) / (2.0 * c.x - 8.0 * c.y + 4.0); }
  // Light of colour temperature T with a Duv tint (CIE 1960 uv distance from the
  // blackbody curve; + = toward green/yellow, - = toward magenta). Linear sRGB, Y = 1.
  vec3 planckRGB(float T, float duv) {
    vec2 uv = xy2uv(planckXY(T));
    vec2 t  = normalize(xy2uv(planckXY(T * 1.01)) - uv);
    vec2 n  = vec2(-t.y, t.x); if (n.y < 0.0) n = -n;
    vec2 xy = uv2xy(uv + duv * n);
    return XYZ2RGB * vec3(xy.x / xy.y, 1.0, (1.0 - xy.x - xy.y) / xy.y);
  }
  // light colour relative to the neutral (6500 K) light, luminance 1
  vec3 lightRGB(float T, float duv) { vec3 c = planckRGB(T, duv) / planckRGB(6500.0, 0.0); return c / lum(c); }
  `;

  // P0: decode sRGB ImageA -> linear light
  const DECODE = COMMON + `
  uniform sampler2D src;
  void main() { fragOut = vec4(toLinear(texelFetch(src, ivec2(gl_FragCoord.xy), 0).rgb), 1.0); }`;

  // P0b: separable Gaussian blur of linear light (soft penumbra)
  const BLUR = COMMON + `
  uniform sampler2D src;
  uniform vec2 dir;        // (1,0) or (0,1)
  uniform float sigma;     // pixels
  void main() {
    vec2 size = vec2(textureSize(src, 0));
    float stepPx = max(1.0, ceil(3.0 * sigma / 48.0));
    int n = int(ceil(3.0 * sigma / stepPx));
    vec3 acc = vec3(0.0); float wsum = 0.0;
    for (int i = -n; i <= n; i++) {
      float o = float(i) * stepPx;
      float w = exp(-0.5 * o * o / (sigma * sigma));
      acc += w * texture(src, (gl_FragCoord.xy + dir * o) / size).rgb;
      wsum += w;
    }
    fragOut = vec4(acc / wsum, 1.0);
  }`;

  // P1 / STEP 1: theArray = light at each pixel minus white light
  const ANALYSE = COMMON + `
  uniform sampler2D lightLin;   // blurred linear light map (v2)
  uniform sampler2D sharpLin;   // unblurred linear ImageA   (v1)
  uniform int model;            // 2 = v2, 1 = v1
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    if (model == 1) {                                        // v1: HSV(pixel) - HSV(white)
      fragOut = vec4(rgb2hsv(toSRGB(texelFetch(sharpLin, p, 0).rgb)) - vec3(0.0, 0.0, 1.0), 1.0);
      return;
    }
    vec3 lin = texelFetch(lightLin, p, 0).rgb;
    // Exposure: how close the pixel is to the brightest displayable version of
    // its own colour. (Plain luminance would make the yellow beams darker than
    // the plain wall, because sRGB yellow can't be as luminous as white.)
    float exposure = max(lin.r, max(lin.g, lin.b));
    vec3  enc = toSRGB(lin);
    float mx = max(enc.r, max(enc.g, enc.b)), mn = min(enc.r, min(enc.g, enc.b));
    float sat = mx > 1e-4 ? (mx - mn) / mx : 0.0;            // stable near white
    // Warm/cool direction from the Oklab hue. Real lights sit on the blackbody
    // curve: warm lights have Oklab hue ~70 deg, cool skylight ~ -100 deg.
    // Green/magenta deviations are discarded (no real light source has them).
    vec3  lab  = oklab(lin);
    float hue  = atan(lab.z, lab.y);
    float warm = clamp(2.0 * cos(hue - radians(70.0)), -1.0, 1.0) * sat;
    fragOut = vec4(exposure - 1.0, warm, sat, 1.0);
  }`;

  // P2 / STEPS 2-4: light the wall
  const RENDER = COMMON + `
  uniform sampler2D theArray;
  uniform int   W, H, model, dither;
  uniform vec3  wallHSL;
  uniform float warmCCT, warmTint, skyCCT, adaptation, fill, bounce, glow, shadowCurve;
  uniform vec4  v1p;            // ambient, shadowCurve, warmth, glow

  // ---- previous version, kept for side-by-side comparison --------------------
  vec3 renderV1(vec3 d, vec3 albedo) {
    float Hh = d.x, S = d.y, V = 1.0 + d.z;
    float exposure = pow(max(V, 0.0), 2.2 * v1p.y);
    vec3  lightCol = toLinear(hsv2rgb(vec3(Hh, 1.0, 1.0)));
    vec3  tint     = mix(vec3(1.0), lightCol, S * v1p.z);
    float boost    = 1.0 + v1p.w * S * exposure;
    vec3  c = albedo * (v1p.x + (1.0 - v1p.x) * exposure * boost * tint);
    float m = max(c.r, max(c.g, c.b));
    if (m > 1.0) c = mix(c / m, vec3(1.0), clamp((m - 1.0) * 0.5, 0.0, 1.0));
    return clamp(c, 0.0, 1.0);
  }

  // ---- highlight roll-off + gamut mapping at constant Oklab hue --------------
  bool inGamut(vec3 c) { return all(greaterThanEqual(c, vec3(-1e-4))) && all(lessThanEqual(c, vec3(1.0 + 1e-4))); }
  vec3 compress(vec3 c) {
    if (inGamut(c)) return c;                        // untouched when displayable
    // Over-bright light: first fit the exposure (divide by the largest channel,
    // which keeps hue AND saturation), then let the excess bleach the colour
    // toward white the way over-bright light does, at constant Oklab hue.
    float m = max(c.r, max(c.g, c.b));
    vec3 lab = oklab(m > 1.0 ? c / m : c);
    float t = m > 1.0 ? 1.0 - exp(-0.7 * (m - 1.0)) : 0.0;   // how blown-out
    lab.x  = mix(lab.x, 1.0, 0.5 * t);
    lab.yz *= 1.0 - t;
    lab.x = clamp(lab.x, 0.0, 1.0);
    if (inGamut(oklabToRGB(lab))) return oklabToRGB(lab);
    float lo = 0.0, hi = 1.0;                        // shrink chroma, keep hue + lightness
    for (int i = 0; i < 16; i++) {
      float mid = 0.5 * (lo + hi);
      if (inGamut(oklabToRGB(vec3(lab.x, lab.yz * mid)))) lo = mid; else hi = mid;
    }
    return clamp(oklabToRGB(vec3(lab.x, lab.yz * lo)), 0.0, 1.0);
  }

  vec3 renderV2(vec3 d, vec3 albedo) {
    float exposure = pow(max(1.0 + d.x, 0.0), shadowCurve);
    float warm = d.y, sat = d.z;

    // 1. colour temperature of the light (blackbody), interpolated in mireds
    float mN = 1e6 / 6500.0;
    float mired = warm >= 0.0 ? mix(mN, 1e6 / warmCCT, warm) : mix(mN, 1e6 / skyCCT, -warm);
    vec3  direct = lightRGB(1e6 / mired, max(warm, 0.0) * warmTint) * exposure * (1.0 + glow * abs(warm) * exposure);

    // 2. fill light: cool sky mixed with pink light bounced off the wall itself
    vec3 fillCol = mix(lightRGB(skyCCT, 0.0), albedo / lum(albedo), bounce);
    fillCol /= lum(fillCol);
    vec3 total   = fill * fillCol + (1.0 - fill) * direct;
    vec3 neutral = fill * fillCol + (1.0 - fill) * vec3(1.0);
    vec3 light   = total / neutral;          // white in ImageA -> exactly (1,1,1)

    // 3. light x wall, per channel in linear sRGB
    vec3 c = albedo * light;

    // 4. partial colour constancy (CAT16 von Kries, degree D) toward neutral
    float Ll = lum(light);
    if (Ll > 1e-5) {
      vec3 wSrc = CAT16 * (RGB2XYZ * (light / Ll));
      vec3 wDst = CAT16 * (RGB2XYZ * vec3(1.0));
      vec3 gain = adaptation * wDst / wSrc + (1.0 - adaptation);
      c = XYZ2RGB * (inverse(CAT16) * (gain * (CAT16 * (RGB2XYZ * c))));
    }

    // 5. highlight roll-off and gamut mapping in Oklab
    return compress(c);
  }

  float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }

  void main() {
    int col = int(gl_FragCoord.x);
    int row = H - 1 - int(gl_FragCoord.y);               // canvas y=0 is the bottom
    int index = row * W + col;                            // walk theArray in order
    vec3 d = texelFetch(theArray, ivec2(index % W, index / W), 0).xyz;
    vec3 albedo = toLinear(hsl2rgb(wallHSL));
    vec3 c = model == 1 ? renderV1(d, albedo) : renderV2(d, albedo);
    vec3 enc = toSRGB(c);
    if (dither == 1) {                                    // triangular-PDF dither, +-1 LSB
      float n = hash(gl_FragCoord.xy) + hash(gl_FragCoord.xy + 17.3) - 1.0;
      enc += n / 255.0;
    }
    fragOut = vec4(clamp(enc, 0.0, 1.0), 1.0);
  }`;

  // ======================================================================
  // JavaScript host
  // ======================================================================
  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error("Shader compile error:\n" + gl.getShaderInfoLog(s));
    return s;
  }
  function makeProgram(gl, frag) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error("Program link error:\n" + gl.getProgramInfoLog(p));
    const loc = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const u = gl.getActiveUniform(p, i); loc[u.name] = gl.getUniformLocation(p, u.name); }
    return { p, loc };
  }
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
  function makeTarget(gl, W, H, linear) {
    const tex = makeTexture(gl, W, H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, null, linear);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error("This GPU/browser can't render to half-float textures.");
    return { tex, fbo };
  }
  const INT_UNIFORMS = new Set(["src", "lightLin", "sharpLin", "theArray", "W", "H", "model", "dither"]);
  function merge(base, extra) {
    const out = Object.assign({}, base, extra || {});
    out.v1 = Object.assign({}, base.v1, (extra && extra.v1) || {});
    return out;
  }

  function create(img, userSettings) {
    let S = merge(DEFAULTS, userSettings);
    const W = img.naturalWidth, H = img.naturalHeight;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", img.alt || "Tinted scene");

    const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error("WebGL2 is not supported in this browser.");
    if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float"))
      throw new Error("This GPU/browser can't render to floating-point textures.");
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (W > max || H > max) throw new Error(`Image is larger than this GPU's limit (${max}px).`);

    // Let the browser convert any embedded colour profile (e.g. Display P3) to sRGB
    if ("unpackColorSpace" in gl) gl.unpackColorSpace = "srgb";
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    let texA;
    try { texA = makeTexture(gl, W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img, false); }
    catch (e) {
      throw new Error("The browser blocked reading the image's pixels. Serve the page and image from the " +
                      "same origin (not file://), or use crossorigin=\"anonymous\" with CORS headers.");
    }

    const progs = { decode: makeProgram(gl, DECODE), blur: makeProgram(gl, BLUR),
                    analyse: makeProgram(gl, ANALYSE), render: makeProgram(gl, RENDER) };
    const lin = makeTarget(gl, W, H, true), tmp = makeTarget(gl, W, H, true),
          blurred = makeTarget(gl, W, H, true), theArray = makeTarget(gl, W, H, false);
    gl.bindVertexArray(gl.createVertexArray());
    gl.viewport(0, 0, W, H);
    gl.activeTexture(gl.TEXTURE0);

    const draw = (prog, target, tex, uniforms) => {
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
    };

    // P0: decode once
    draw(progs.decode, lin, texA, { src: 0 });

    let lastLight = null;
    function render() {
      const sigma = Math.max(0, S.penumbra) / 100 * W;
      const isV1 = S.model === "v1";
      const key = isV1 + "|" + sigma.toFixed(3);
      if (key !== lastLight) {
        let lightTex = lin.tex;
        if (!isV1 && sigma >= 0.3) {                          // P0b soft penumbra
          draw(progs.blur, tmp, lin.tex, { src: 0, dir: [1, 0], sigma });
          draw(progs.blur, blurred, tmp.tex, { src: 0, dir: [0, 1], sigma });
          lightTex = blurred.tex;
        }
        // P1 / STEP 1 — theArray (lightLin on unit 0, sharpLin on unit 1)
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, lin.tex); gl.activeTexture(gl.TEXTURE0);
        draw(progs.analyse, theArray, lightTex, { lightLin: 0, sharpLin: 1, model: isV1 ? 1 : 2 });
        lastLight = key;
      }
      // P2 / STEPS 2-4 — ImageB on the canvas
      draw(progs.render, null, theArray.tex, {
        theArray: 0, W, H, model: isV1 ? 1 : 2, dither: S.dither ? 1 : 0,
        wallHSL: S.wallHSL, warmCCT: +S.warmCCT, warmTint: +S.warmTint, skyCCT: +S.skyCCT,
        adaptation: +S.adaptation, fill: +S.fill, bounce: +S.bounce,
        glow: +S.glow, shadowCurve: +S.shadowCurve,
        v1p: [S.v1.ambient, S.v1.shadowCurve, S.v1.warmth, S.v1.glow]
      });
    }
    render();

    return {
      canvas,
      get settings() { return S; },
      update(extra) { S = merge(S, extra); render(); },
      sample(x, y) {                                   // ImageB pixel, top-left origin
        const px = new Uint8Array(4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(x, H - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return [px[0], px[1], px[2]];
      }
    };
  }

  // ---------------------------------------------------------------- page hookup
  let mainInstance = null;
  function renderTintedScene(overrides) {
    if (overrides instanceof Event) overrides = null;
    if (mainInstance) { mainInstance.update(overrides); return mainInstance; }
    const img = document.getElementById("tintedScene");
    if (!img) { console.error("tinted-wall: no element with id 'tintedScene'"); return null; }
    if (!img.complete || !img.naturalWidth) { console.error("tinted-wall: #tintedScene failed to load"); return null; }
    const settings = merge(merge(DEFAULTS, window.TINTED_WALL_SETTINGS), overrides);
    try { mainInstance = create(img, settings); }
    catch (e) {
      console.error("tinted-wall:", e.message);
      document.dispatchEvent(new CustomEvent("tintedscene:error", { detail: { error: e } }));
      return null;
    }
    const c = mainInstance.canvas;
    c.id = "tintedSceneResult";
    c.className = img.className;
    c.style.cssText = img.style.cssText; c.style.display = "";
    if (img.getAttribute("width"))  c.style.width  = img.width + "px";
    if (img.getAttribute("height")) c.style.height = img.height + "px";
    img.insertAdjacentElement("afterend", c);
    if (settings.replaceImage) img.style.display = "none";
    document.dispatchEvent(new CustomEvent("tintedscene:rendered", { detail: { instance: mainInstance } }));
    return mainInstance;
  }

  window.TintedWall = { create, DEFAULTS };
  window.renderTintedScene = renderTintedScene;

  if (document.readyState === "complete") renderTintedScene();
  else window.addEventListener("load", () => renderTintedScene(), { once: true });
})();
