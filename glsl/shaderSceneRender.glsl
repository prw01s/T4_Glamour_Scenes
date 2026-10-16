// ============================================================================
// shaderSceneRender.glsl  -  GLSL ES 3.00 (WebGL2) shaders for
// shaderSceneRenderer.html, run by js/shaderSceneRender.js.
//
// Ported from js/tinted-wall-v2.js (v2 perception-aware model + v1 HSV model;
// v1 also lives in glsl/wall_lighting.glsl). The shader logic is unchanged.
//
// FILE FORMAT
//   The file is split into sections by marker lines of the form "//@@NAME"
//   (the same convention as glsl/wall_lighting.glsl). loadShaders() in
//   js/shaderSceneRender.js fetches this file and cuts it at the markers.
//   Everything above the first marker (this header) is ignored.
//
//     VERT     the vertex shader shared by every pass (complete program)
//     COMMON   the fragment prelude: #version, precision, output, helpers
//     DECODE   P0   fragment body: sRGB photo -> linear light
//     BLUR     P0b  fragment body: separable Gaussian blur (v2 only)
//     ANALYSE  P1   fragment body: light minus white light -> theArray
//     RENDER   P2   fragment body: the wall paint lit by theArray
//     ADJUST   P0a  fragment body, optional: contrast + saturation of the
//                   linear light before BLUR/ANALYSE. Used only by
//                   videoShaderRenderer.html (js/videoShaderRender.js).
//
//   Each fragment program is built in JS as COMMON + "\n" + section, so only
//   VERT and COMMON start with "#version 300 es". That line must remain the
//   very first line of those two sections; put nothing between the marker
//   and it.
//
// RULES FOR EDITING
//   - Keep this file pure ASCII, including comments. Some WebGL
//     implementations reject shader source containing other characters.
//   - Section names are fixed: js/shaderSceneRender.js looks them up by name.
//
// PIPELINE (per photo; every surface is N x N, see js/shaderSceneRender.js)
//   texA (RGBA8 sRGB) --DECODE--> lin --BLUR x2--> blurred --ANALYSE--> theArray
//   theArray (RGBA16F) --RENDER--> canvas drawing buffer (8-bit sRGB)
//   The video page can insert ADJUST after DECODE: lin --ADJUST--> adj.
// ============================================================================

//@@VERT
#version 300 es
// The "fullscreen triangle". With no vertex buffer, drawArrays(TRIANGLES, 0, 3)
// gives vertex IDs 0, 1 and 2, which map to clip-space (-1,-1), (3,-1) and
// (-1,3). That one triangle covers the whole [-1,1]^2 viewport (the overhang
// is clipped), so every pixel of the target runs the fragment shader exactly
// once, with no diagonal seam as with two triangles.
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}

//@@COMMON
#version 300 es
// COMMON: the prelude shared by every fragment shader: precision, the single
// output, and the colour-science helpers. JS prepends it to DECODE, BLUR,
// ANALYSE and RENDER.
// highp everywhere: theArray holds signed, > 1 values and the colour maths
// (cube roots, matrix chains) loses visible precision at mediump.
precision highp float;
precision highp int;
precision highp sampler2D;
// Every pass writes one RGBA value per pixel.
out vec4 fragOut;

// ---- transfer functions ------------------------------------------------
// sRGB electro-optical transfer function (IEC 61966-2-1). Encoded values at or
// below 0.04045 sit on a linear toe (c / 12.92); above it the curve is
// ((c + 0.055) / 1.055)^2.4. step() picks the branch per channel without an if:
// mix(a, b, 0) = a, mix(a, b, 1) = b.
vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
// Inverse: linear light -> encoded sRGB. The knee is 0.0031308 (= 0.04045 / 12.92).
// Negative input is clamped first, because pow() of a negative number is undefined.
vec3 toSRGB(vec3 c)   { c = max(c, 0.0);
                        return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
// Relative luminance Y of linear sRGB (the Y row of RGB2XYZ: Rec. 709
// primaries, D65 white). 1.0 = the luminance of white.
float lum(vec3 c)     { return dot(c, vec3(0.2126729, 0.7151522, 0.0721750)); }

// ---- matrices (written as rows, transposed into GLSL column order) -------
// GLSL's mat3(...) constructor fills COLUMNS, so a matrix typed out row by row
// as on paper must be transposed before M * v gives the textbook result.
//
// RGB2XYZ: linear sRGB -> CIE 1931 XYZ, D65 white. White (1,1,1) maps to
// XYZ ~ (0.9505, 1.0, 1.089).
const mat3 RGB2XYZ = transpose(mat3(0.4124564, 0.3575761, 0.1804375,
                                    0.2126729, 0.7151522, 0.0721750,
                                    0.0193339, 0.1191920, 0.9503041));
// XYZ2RGB: the inverse of RGB2XYZ (XYZ, D65 -> linear sRGB). Colours outside
// the sRGB gamut come out with channels < 0 or > 1.
const mat3 XYZ2RGB = transpose(mat3( 3.2404542, -1.5371385, -0.4985314,
                                    -0.9692660,  1.8760108,  0.0415560,
                                     0.0556434, -0.2040259,  1.0572252));
// CAT16: the chromatic adaptation transform of CIECAM16 (Li et al. 2017).
// It maps XYZ into a "sharpened" cone-like RGB space, where scaling each
// channel separately (a von Kries gain) best predicts how a colour looks
// after the eye adapts to a different light.
const mat3 CAT16   = transpose(mat3( 0.401288, 0.650173, -0.051461,
                                    -0.250268, 1.204414,  0.045854,
                                    -0.002079, 0.048952,  0.953127));

// ---- Oklab (Ottosson 2020) -----------------------------------------------
// Oklab is a perceptually uniform colour space: equal distances look like
// roughly equal differences, and its hue angle stays steady as lightness or
// chroma change (unlike HSV/HSL hue). Components:
//   L  lightness, 0 (black) .. 1 (white)
//   a  green (-) .. red (+)
//   b  blue (-)  .. yellow (+)
// chroma = length(ab), hue = atan(b, a).
//
// Signed cube root. pow() is undefined for negative bases, and out-of-gamut
// linear colours can have negative LMS values, so take the root of |v| and
// restore the sign. This keeps oklab() invertible for every input.
vec3 cbrt3(vec3 v) { return sign(v) * pow(abs(v), vec3(1.0 / 3.0)); }
// Linear sRGB -> Oklab: linear RGB -> LMS cone response (M1), cube-root
// compression (roughly the eye's non-linear response), -> Lab (M2).
vec3 oklab(vec3 c) {
  vec3 lms = vec3(dot(c, vec3(0.4122214708, 0.5363325363, 0.0514459929)),
                  dot(c, vec3(0.2119034982, 0.6806995451, 0.1073969566)),
                  dot(c, vec3(0.0883024619, 0.2817188376, 0.6299787005)));
  lms = cbrt3(lms);
  return vec3(dot(lms, vec3(0.2104542553,  0.7936177850, -0.0040720468)),
              dot(lms, vec3(1.9779984951, -2.4285922050,  0.4505937099)),
              dot(lms, vec3(0.0259040371,  0.7827717662, -0.8086757660)));
}
// Oklab -> linear sRGB: the exact inverse (inverse M2, cube, inverse M1).
// The result can fall outside 0..1 when the Lab colour isn't displayable;
// compress() in RENDER relies on that to test the gamut.
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
// Hue is in DEGREES (0..360) in all three functions; S, V and L are 0..1.
//
// RGB -> HSV (used by the v1 model). The hue is the position around the
// colour hexagon: which channel is the maximum picks the 120-degree sector,
// and the difference of the other two picks the offset inside it. Grey pixels
// (d ~ 0) get hue 0. S = chroma / value, V = the largest channel.
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
// HSV -> RGB without branches. For each channel, k is its distance around the
// hue wheel in 60-degree units (offsets 5, 3, 1 put R, G and B 120 degrees
// apart). min(k, 4 - k) clamped to 0..1 is the trapezoid "how much of this
// channel is missing" at this hue; scale it by the chroma V*S and take it from V.
vec3 hsv2rgb(vec3 c) {
  vec3 k = mod(vec3(5.0, 3.0, 1.0) + mod(c.x, 360.0) / 60.0, 6.0);
  return c.z - c.z * c.y * clamp(min(k, 4.0 - k), 0.0, 1.0);
}
// HSL -> RGB without branches (the CSS Color 4 formulation). k is in
// 30-degree units, with offsets 0, 8 and 4 for R, G and B; a is half the
// chroma. The clamp gives each channel's +1/-1 trapezoid around L. Used for
// the paint colour, which JS sends as HSL (see hexToHsl()).
vec3 hsl2rgb(vec3 hsl) {
  vec3 k = mod(vec3(0.0, 8.0, 4.0) + mod(hsl.x, 360.0) / 30.0, 12.0);
  float a = hsl.y * min(hsl.z, 1.0 - hsl.z);
  return hsl.z - a * clamp(min(k - 3.0, 9.0 - k), -1.0, 1.0);
}

// ---- blackbody (Planckian) light colour, Kim et al. 2002 -----------------
// Real light sources (the sun, sky, tungsten, most LEDs) sit on or near the
// Planckian locus: the colour of a glowing blackbody at temperature T (kelvin).
// Kim et al. fitted CIE 1931 xy along the locus with cubic polynomials: x as a
// cubic in 1/T (two ranges, split at 4000 K) and y as a cubic in x (three
// ranges). The fit is valid from 1667 K to 25000 K, so T is clamped to that.
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
// CIE 1931 xy <-> CIE 1960 uv. The uv diagram is the one where Duv (distance
// from the Planckian locus) is defined, and it is closer to perceptually
// uniform than xy.
vec2 xy2uv(vec2 c) { return vec2(4.0 * c.x, 6.0 * c.y) / (-2.0 * c.x + 12.0 * c.y + 3.0); }
vec2 uv2xy(vec2 c) { return vec2(3.0 * c.x, 2.0 * c.y) / (2.0 * c.x - 8.0 * c.y + 4.0); }
// Light of colour temperature T with a Duv tint (CIE 1960 uv distance from the
// blackbody curve; + = toward green/yellow, - = toward magenta). Linear sRGB, Y = 1.
// How: take the locus point uv(T); estimate the locus tangent with a finite
// difference to uv(1.01 T); rotate it 90 degrees to get the normal, flipped
// so +duv always points to +v (above the locus, toward green). Step duv
// along the normal, then go back to xy and on to XYZ with Y = 1:
// X = x / y, Z = (1 - x - y) / y. Finally convert XYZ to linear sRGB.
vec3 planckRGB(float T, float duv) {
  vec2 uv = xy2uv(planckXY(T));
  vec2 t  = normalize(xy2uv(planckXY(T * 1.01)) - uv);
  vec2 n  = vec2(-t.y, t.x); if (n.y < 0.0) n = -n;
  vec2 xy = uv2xy(uv + duv * n);
  return XYZ2RGB * vec3(xy.x / xy.y, 1.0, (1.0 - xy.x - xy.y) / xy.y);
}
// light colour relative to the neutral (6500 K) light, luminance 1
// Dividing by the 6500 K blackbody makes "neutral" light exactly (1,1,1) (the
// photos are white-balanced near daylight), so a light only tints the wall by
// how much it differs from neutral. Dividing by lum() then removes any
// brightness change, so colour and exposure stay independent.
vec3 lightRGB(float T, float duv) { vec3 c = planckRGB(T, duv) / planckRGB(6500.0, 0.0); return c / lum(c); }


//@@DECODE
// P0: decode sRGB ImageA -> linear light
// Input:  src = texA (RGBA8, encoded sRGB). Output: the "lin" target (RGBA16F,
// linear light). All light arithmetic (blurring, mixing, multiplying) must
// happen in linear light, where values are proportional to physical
// intensity. texelFetch reads the exact integer pixel with no filtering. This
// works only because texA and the target are both N x N, so gl_FragCoord.xy
// maps 1:1 to texels.
uniform sampler2D src;
void main() { fragOut = vec4(toLinear(texelFetch(src, ivec2(gl_FragCoord.xy), 0).rgb), 1.0); }

//@@BLUR
// P0b: separable Gaussian blur of linear light (soft penumbra)
// Runs twice: horizontally (lin -> tmp, dir = (1,0)), then vertically
// (tmp -> blurred, dir = (0,1)). A 2-D Gaussian is the product of two 1-D
// ones, so two passes of n taps replace one n^2 kernel. Blurring linear light
// (not sRGB) gives physically correct soft shadow edges, and it averages away
// JPEG noise and surface texture that would otherwise print onto the paint.
uniform sampler2D src;
uniform vec2 dir;        // (1,0) or (0,1)
uniform float sigma;     // pixels
void main() {
  vec2 size = vec2(textureSize(src, 0));
  // The kernel spans +-3 sigma (99.7 % of the Gaussian's weight). To cap the
  // loop at about 2 * 48 + 1 = 97 taps for wide blurs, the tap spacing
  // (stepPx) grows once 3 sigma exceeds 48 px. The source is sampled with
  // LINEAR filtering, so spaced taps still average their neighbours.
  float stepPx = max(1.0, ceil(3.0 * sigma / 48.0));
  int n = int(ceil(3.0 * sigma / stepPx));
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int i = -n; i <= n; i++) {
    float o = float(i) * stepPx;
    // Gaussian weight exp(-o^2 / 2 sigma^2). The weights are summed and divided
    // out at the end, so the kernel always integrates to 1 (no brightening or
    // darkening, even when truncated).
    float w = exp(-0.5 * o * o / (sigma * sigma));
    // gl_FragCoord.xy is the pixel CENTRE (e.g. 0.5, 0.5), so dividing by
    // the size gives exact texel-centre UVs. CLAMP_TO_EDGE repeats the border
    // pixels beyond the image edge.
    acc += w * texture(src, (gl_FragCoord.xy + dir * o) / size).rgb;
    wsum += w;
  }
  fragOut = vec4(acc / wsum, 1.0);
}

//@@ANALYSE
// P1 / STEP 1: theArray = light at each pixel minus white light
// Output (RGBA16F, signed values), per pixel:
//   v2: .x = exposure - 1  (0 = as bright as white, -1 = black)
//       .y = warm/cool     (-1 cool sky ... 0 neutral ... +1 warm sun/tungsten)
//       .z = saturation    (0 = white/grey light ... 1 = fully coloured light)
//   v1: .xyz = HSV(pixel) - HSV(white) = (hue in degrees, S, V - 1)
// White light therefore encodes as (0,0,0): "no change to the paint".
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
  // Saturation is measured on the ENCODED value, HSV-style: (max - min) / max.
  // In encoded sRGB, near-white pixels give small, stable values instead of
  // JPEG noise being amplified as it is near black in linear light.
  vec3  enc = toSRGB(lin);
  float mx = max(enc.r, max(enc.g, enc.b)), mn = min(enc.r, min(enc.g, enc.b));
  float sat = mx > 1e-4 ? (mx - mn) / mx : 0.0;            // stable near white
  // Warm/cool direction from the Oklab hue. Real lights sit on the blackbody
  // curve: warm lights have Oklab hue ~70 deg, cool skylight ~ -100 deg.
  // Green/magenta deviations are discarded (no real light source has them).
  // cos(hue - 70 deg) projects the hue onto that warm-cool axis: +1 at 70 deg,
  // -1 at -110 deg, and 0 for pure green or magenta. Doubling and clamping makes
  // every hue within +-60 deg of either end count as fully warm or cool. Scaling
  // by sat means a nearly white light is nearly neutral, whatever its hue.
  vec3  lab  = oklab(lin);
  float hue  = atan(lab.z, lab.y);
  float warm = clamp(2.0 * cos(hue - radians(70.0)), -1.0, 1.0) * sat;
  fragOut = vec4(exposure - 1.0, warm, sat, 1.0);
}

//@@RENDER
// P2 / STEPS 2-4: light the wall
// Draws into the default framebuffer (the WebGL canvas's drawing buffer).
// For each output pixel, read that pixel's light from theArray and apply it
// to the paint colour. Output is encoded sRGB, dithered to 8 bits.
// theArray    P1 output for this photo (NEAREST filtering; read with texelFetch)
// W, H        working size in pixels (N x N)
// model       1 = v1 (HSV), 2 = v2 (perceptual)
// dither      1 = add triangular dither before 8-bit quantisation
// wallHSL     the paint: hue in degrees, S and L 0..1 (from hexToHsl in JS)
// warmCCT, skyCCT        kelvin; warmTint is a Duv offset (see SHADER_DEFAULTS)
// adaptation  CAT16 degree of adaptation D, 0..1
// fill, bounce, glow, shadowCurve   see SHADER_DEFAULTS
uniform sampler2D theArray;
uniform int   W, H, model, dither;
uniform vec3  wallHSL;
uniform float warmCCT, warmTint, skyCCT, adaptation, fill, bounce, glow, shadowCurve;
uniform vec4  v1p;            // ambient, shadowCurve, warmth, glow

// ---- previous version, kept for side-by-side comparison --------------------
// v1 (HSV) model. d = (light hue in degrees, light saturation, V - 1); albedo =
// the paint in linear light. Steps:
//   1. exposure: V raised to 2.2 * shadowCurve. This is a rough gamma decode,
//      because V was measured on encoded sRGB.
//   2. tint: the light's hue at full saturation, mixed in by S * warmth.
//   3. boost: coloured light (high S) at high exposure is brightened by glow.
//   4. ambient: a constant floor so shadows keep some paint colour.
//   5. soft clip: anything above 1 is normalised by its largest channel and
//      then pushed toward white by the amount it overshot.
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
// True when c is displayable linear sRGB (every channel in 0..1). The 1e-4
// slack absorbs float rounding, so colours that are exactly on the edge pass.
bool inGamut(vec3 c) { return all(greaterThanEqual(c, vec3(-1e-4))) && all(lessThanEqual(c, vec3(1.0 + 1e-4))); }
// Maps any linear colour into the sRGB gamut without shifting its hue.
// Naive per-channel clamping changes hue: an over-bright orange clamps toward
// yellow. Instead, everything is done in Oklab at constant hue.
//   Stage 1 (too bright, max channel m > 1): divide by m to fit the exposure,
//     which keeps hue AND saturation. Then bleach toward white by
//     t = 1 - exp(-0.7 (m - 1)): 0 at m = 1, rising smoothly toward 1. t lifts
//     lightness halfway to 1 and scales chroma down by (1 - t), the way film or
//     the eye loses colour in blown-out light.
//   Stage 2 (still out of gamut, e.g. too saturated or negative channels):
//     binary-search a chroma scale in 0..1 at fixed L and hue. 16 halvings
//     give 1/65536 precision, well below one 8-bit step.
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

// v2 (perceptual) model. d = theArray texel (exposure - 1, warm, sat);
// albedo = the paint in linear sRGB (its reflectance per channel).
// Returns the lit wall colour in linear sRGB, inside the gamut.
vec3 renderV2(vec3 d, vec3 albedo) {
  // exposure 0..1 (1 = as bright as the photo's white). shadowCurve > 1
  // deepens the shadows.
  float exposure = pow(max(1.0 + d.x, 0.0), shadowCurve);
  float warm = d.y, sat = d.z;

  // 1. colour temperature of the light (blackbody), interpolated in mireds
  // Mired = 1e6 / T. Equal steps in mireds look like equal colour changes,
  // whereas kelvin is very uneven (2700 -> 3000 K is a much bigger visual
  // shift than 9700 -> 10000 K). warm in 0..1 slides from neutral (6500 K)
  // to warmCCT; warm in -1..0 slides toward skyCCT. The Duv tint is applied
  // only to the warm side, in proportion to warmth. The glow term brightens
  // strongly coloured direct light, more so where it is already bright
  // (sunbeams).
  float mN = 1e6 / 6500.0;
  float mired = warm >= 0.0 ? mix(mN, 1e6 / warmCCT, warm) : mix(mN, 1e6 / skyCCT, -warm);
  vec3  direct = lightRGB(1e6 / mired, max(warm, 0.0) * warmTint) * exposure * (1.0 + glow * abs(warm) * exposure);

  // 2. fill light: cool sky mixed with pink light bounced off the wall itself
  // fillCol mixes skylight and the paint's own colour (light that has bounced
  // between walls picks up their colour), normalised to luminance 1. The fill
  // share of the light is the same everywhere; the rest is the direct light.
  // Dividing by "neutral" (the same mix for a white photo pixel: exposure 1,
  // warm 0, so direct = (1,1,1)) normalises the result. A pure white photo
  // pixel therefore gives light = (1,1,1) EXACTLY, and the wall shows the
  // paint swatch exactly where the photo's wall was lit white.
  vec3 fillCol = mix(lightRGB(skyCCT, 0.0), albedo / lum(albedo), bounce);
  fillCol /= lum(fillCol);
  vec3 total   = fill * fillCol + (1.0 - fill) * direct;
  vec3 neutral = fill * fillCol + (1.0 - fill) * vec3(1.0);
  vec3 light   = total / neutral;          // white in ImageA -> exactly (1,1,1)

  // 3. light x wall, per channel in linear sRGB
  // Reflected light = incident light x reflectance, per channel. This is a
  // 3-sample approximation of the spectral product. For this kind of matte
  // paint, linear sRGB primaries were measured as the most accurate
  // 3-channel basis (see the header of js/tinted-wall-v2.js).
  vec3 c = albedo * light;

  // 4. partial colour constancy (CAT16 von Kries, degree D) toward neutral
  // The eye partly discounts the colour of the light; a camera doesn't. Von
  // Kries adaptation: go to CAT16 space, multiply each channel by
  // (destination white / source white), and come back. The source white is
  // the light's colour at luminance 1; the destination is neutral (1,1,1).
  // Degree D (= adaptation) blends the gain with 1:
  // gain = D * dst / src + (1 - D), so D = 0 leaves the camera's colour cast
  // and D = 1 removes it entirely.
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

// Cheap, stateless hash: a pixel position -> pseudo-random 0..1. Its only
// job is to decorrelate neighbouring pixels for the dither, so it doesn't
// need to be of cryptographic or statistical quality. The constants are
// arbitrary.
float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }

void main() {
  // gl_FragCoord has its origin at the BOTTOM-left, but theArray was built
  // from an image uploaded with row 0 at the top (UNPACK_FLIP_Y false, and
  // DECODE/ANALYSE copy rows 1:1). Flip the row to read the matching texel,
  // walking theArray in the image's own reading order (index = row * W + col)
  // and converting back to a 2-D texel address.
  int col = int(gl_FragCoord.x);
  int row = H - 1 - int(gl_FragCoord.y);               // canvas y=0 is the bottom
  int index = row * W + col;                            // walk theArray in order
  vec3 d = texelFetch(theArray, ivec2(index % W, index / W), 0).xyz;
  // The paint's reflectance: HSL -> encoded sRGB -> linear.
  vec3 albedo = toLinear(hsl2rgb(wallHSL));
  vec3 c = model == 1 ? renderV1(d, albedo) : renderV2(d, albedo);
  vec3 enc = toSRGB(c);
  // Triangular-PDF dither: the sum of two independent uniform 0..1 values,
  // minus 1, is triangular on -1..1. Adding it in units of one 8-bit step
  // (1/255) before quantisation turns smooth gradients' banding into fine,
  // signal-independent noise. The second hash is offset so the two values
  // are independent.
  if (dither == 1) {                                    // triangular-PDF dither, +-1 LSB
    float n = hash(gl_FragCoord.xy) + hash(gl_FragCoord.xy + 17.3) - 1.0;
    enc += n / 255.0;
  }
  fragOut = vec4(clamp(enc, 0.0, 1.0), 1.0);
}

//@@ADJUST
// P0a (video page only): adjust the video's light before it is analysed.
// Input: src = lin (linear light). Output: the "adj" target (RGBA16F), which
// then replaces lin as the input of BLUR and ANALYSE. JS skips this pass when
// both settings are neutral, so the default output is exactly unchanged.
// contrastK    exponent on luminance around pivotY (1 = unchanged, > 1 = more contrast)
// pivotY       median luminance of the video (linear), the contrast's fixed point
// satAmount    -1..1 (0 = unchanged): per-pixel saturation, see below
// satMeasure   how "difference from pure white" is measured:
//                0 = Oklab distance from white (lightness and colour both count)
//                1 = Oklab chroma only (the colour cast; lightness is ignored)
// medianDiff   the video's median of that same measure, over all its pixels
uniform sampler2D src;
uniform int   satMeasure;
uniform float contrastK, pivotY, satAmount, medianDiff;
void main() {
  vec3 c = texelFetch(src, ivec2(gl_FragCoord.xy), 0).rgb;
  // 1. Saturation. diff = how far this pixel is from pure white, measured per
  // satMeasure: the full Oklab distance (so a dark grey counts as far from
  // white), or only the chroma (so only a colour cast counts). Its ratio to the
  // video's median diff sets the strength: chroma is scaled by
  // 2^(satAmount * ratio), so pixels far from white change most, near-white
  // pixels hardly at all, and greys (no chroma) not at all. The ratio is
  // capped at 3 (gain <= 8x).
  vec3  lab   = oklab(c);
  float diff  = satMeasure == 1 ? length(lab.yz) : distance(lab, vec3(1.0, 0.0, 0.0));
  float ratio = clamp(diff / max(medianDiff, 1e-4), 0.0, 3.0);
  lab.yz *= exp2(satAmount * ratio);
  // Boosted chroma can leave the gamut (negative channels); clamp to real light.
  c = max(oklabToRGB(lab), 0.0);
  // 2. Contrast, on luminance only (the chromaticity is kept): in log space
  // around the median, Y' = pivotY * (Y / pivotY)^contrastK. Multiplying the
  // colour by Y' / Y = (Y / pivotY)^(contrastK - 1) applies that.
  float Y = lum(c);
  if (Y > 1e-6) c *= pow(Y / max(pivotY, 1e-4), contrastK - 1.0);
  fragOut = vec4(c, 1.0);
}
