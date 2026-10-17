// ============================================================================
// shaderSceneRender.glsl  -  GLSL ES 3.00 (WebGL2) shaders for both paint
// visualizer pages (shaderSceneRenderer.html and videoShaderRenderer.html).
// js/paintPipeline.js loads, compiles and runs them (see LightPipeline).
//
// v1 and v2 were ported from js/tinted-wall-v2.js (v1 also lives in
// glsl/wall_lighting.glsl); v3 and the passes around it are new here.
//
// FILE FORMAT
//   The file is split into sections by marker lines of the form "//@@NAME".
//   loadShaders() in js/paintPipeline.js fetches this file and cuts it at the
//   markers. Everything above the first marker (this header) is ignored.
//
//     VERT     the vertex shader shared by every pass (complete program)
//     COMMON   the fragment prelude: #version, precision, output, helpers
//     RESAMPLE      resizes a photo in linear light (on upload, once)
//     DECODE   P0   source image -> linear light + wall coverage
//     ADJUST   P0a  the Contrast / Saturation sliders (skipped when centred)
//     BLUR     P0b  separable Gaussian, weighted by wall coverage (v2, v3)
//     ANALYSE  P1   light -> light map, in the active model's encoding
//     RENDER   P2   the wall paint lit by the light map
//
//   Each fragment program is built in JS as COMMON + "\n" + section, so only
//   VERT and COMMON start with "#version 300 es". That line must remain the
//   very first line of those two sections; put nothing between the marker
//   and it.
//
// RULES FOR EDITING
//   - Keep this file pure ASCII, including comments. Some WebGL
//     implementations reject shader source containing other characters.
//   - Section names are fixed: js/paintPipeline.js looks them up by name.
//   - Uniform types are read from the compiled program, so JS needs no list
//     of which uniforms are ints; only the names must match.
//
// PIPELINE (per image; A = analysis size, R = render size, R >= A)
//   photo --RESAMPLE--> source (SRGB8_ALPHA8, R, mipmapped; the GPU decodes it
//   to linear light when sampled, so every resize and mip level averages
//   LIGHT, not encoded values) --DECODE--> lin (A, rgb = linear light,
//   a = wall coverage) [--ADJUST--> adj] --BLUR x2--> blurred --ANALYSE-->
//   light map (RGBA16F, A) --RENDER--> canvas drawing buffer (R, 8-bit)
//   The light is analysed at A, where noise and compression artefacts are
//   averaged away, and painted at R, where the light map is interpolated.
//   v3 also reads the full-resolution source in RENDER for brightness detail.
//
// COORDINATES
//   Every stored image (source, mask, targets, light map) has row 0 at the
//   TOP: uploads use UNPACK_FLIP_Y = false and offscreen passes copy rows
//   1:1. Only RENDER draws to the canvas, whose row 0 is the BOTTOM, so only
//   RENDER flips y.
//
// MODELS (the "Tinting algo" switch)
//   v1  HSV model, the first version. Kept for comparison.
//   v2  Perception-aware: a warm/cool estimate picks a blackbody light,
//       fill/bounce light, light x paint in linear sRGB, per-pixel CAT16
//       adaptation, Oklab highlight roll-off and gamut mapping.
//   v3  Physically based: the light's MEASURED chromaticity gives its colour
//       temperature; paint x light is computed spectrally (blackbody SPD x
//       paint reflectance x CIE observer); bounce light depends on the
//       paint's reflectance; brightness is calibrated to the room's
//       reference white; adaptation is scene-wide (CAT16, CIECAM16 degree
//       of adaptation); fine brightness detail comes from the full-res image.
//       See renderV3 below and README.md.
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
// output, the model ids and the colour-science helpers. JS prepends it to
// every other section except VERT.
// highp everywhere: the light map holds signed, > 1 values and the colour maths
// (cube roots, matrix chains) loses visible precision at mediump.
precision highp float;
precision highp int;
precision highp sampler2D;
// Every pass writes one RGBA value per pixel.
out vec4 fragOut;

// The "Tinting algo" models (the `model` uniform; MODELS in js/paintPipeline.js).
#define MODEL_V1 1
#define MODEL_V2 2
#define MODEL_V3 3

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

// ---- HSV (v1 only) ---------------------------------------------------------
// Hue is in DEGREES (0..360) in both functions; S and V are 0..1.
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
// D65, the sRGB white point, as CIE 1931 xy. Everything here treats the
// camera's neutral (encoded white, (1,1,1)) as D65 light.
const vec2 D65_XY = vec2(0.3127, 0.3290);
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
// v2: light colour relative to the neutral (6500 K) light, luminance 1
// Dividing by the 6500 K blackbody makes "neutral" light exactly (1,1,1) (the
// photos are white-balanced near daylight), so a light only tints the wall by
// how much it differs from neutral. Dividing by lum() then removes any
// brightness change, so colour and exposure stay independent.
vec3 lightRGB(float T, float duv) { vec3 c = planckRGB(T, duv) / planckRGB(6500.0, 0.0); return c / lum(c); }


//@@RESAMPLE
// Resizes a photo to the render size, in linear light. src is an SRGB8_ALPHA8
// texture of the full-size photo (mipmapped), so texture() returns LINEAR
// light, averaged over the pixel footprint; the target is SRGB8_ALPHA8 too, so
// the GPU encodes the result back to sRGB on write. Resizing encoded values
// instead (as a 2D canvas does) darkens every high-contrast edge: measured on
// these photos, 1 % of 8x8 blocks come out 38-60 % too dark, and those blocks
// are exactly the shadow and sunbeam edges.
uniform sampler2D src;
uniform vec2 size;
void main() { fragOut = vec4(texture(src, gl_FragCoord.xy / size).rgb, 1.0); }

//@@DECODE
// P0: source image -> linear light, at the analysis size.
// src       the photo (SRGB8_ALPHA8: already linear when sampled, srcLinear = 1)
//           or video frame (RGBA8, encoded: srcLinear = 0). It may be larger
//           than this pass's target (R > A); it is then mipmapped, and
//           texture() picks the right level from the pixel footprint, so the
//           downscale is a proper average rather than a sparse sample.
// wallMask  the page's wall mask, any size: black (or transparent) = wall,
//           white = not wall. Like CSS `mask-mode: luminance`, the mask's
//           value is its (encoded) brightness x alpha.
// size      this pass's target size in pixels (A).
// Output: rgb = linear light (all light arithmetic happens in linear light,
// where values are proportional to physical intensity), a = wall coverage
// 0..1, which BLUR uses to keep non-wall pixels out of the wall's light.
uniform sampler2D src;
uniform sampler2D wallMask;
uniform vec2 size;
uniform int srcLinear;
void main() {
  vec2 uv = gl_FragCoord.xy / size;
  vec3 t = texture(src, uv).rgb;
  vec3 c = srcLinear == 1 ? t : toLinear(t);
  vec4 m = texture(wallMask, uv);
  float wall = 1.0 - m.r * m.a;
  fragOut = vec4(c, wall);
}

//@@ADJUST
// P0a: the Contrast and Saturation sliders adjust the light before it is
// analysed. Input: src = lin. Output: the "adj" target (RGBA16F), which then
// replaces lin as the input of BLUR and ANALYSE. JS skips this pass when both
// sliders are centred, so the default output is exactly unchanged. The wall
// coverage in alpha passes through.
// contrastK    exponent on luminance around pivotY (1 = unchanged, > 1 = more contrast)
// pivotY       median luminance (linear) of the room's photos / the whole video
// satAmount    -1..1 (0 = unchanged): per-pixel saturation, see below
// satMeasure   how "difference from pure white" is measured:
//                0 = Oklab distance from white (lightness and colour both count)
//                1 = Oklab chroma only (the colour cast; lightness is ignored)
// medianDiff   the median of that same measure over all the pixels
uniform sampler2D src;
uniform int   satMeasure;
uniform float contrastK, pivotY, satAmount, medianDiff;
void main() {
  vec4 t = texelFetch(src, ivec2(gl_FragCoord.xy), 0);
  vec3 c = t.rgb;
  // 1. Saturation. diff = how far this pixel is from pure white, measured per
  // satMeasure. Its ratio to the median diff sets the strength: chroma is
  // scaled by 2^(satAmount * ratio), so pixels far from white change most,
  // near-white pixels hardly at all, and greys (no chroma) not at all. The
  // ratio is capped at 3 (gain <= 8x).
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
  fragOut = vec4(c, t.a);
}

//@@BLUR
// P0b: separable Gaussian blur of linear light, weighted by wall coverage.
// Runs twice: horizontally (blurStep 1, dir = (1,0)), then vertically
// (blurStep 2, dir = (0,1)). A 2-D Gaussian is the product of two 1-D ones,
// so two passes of n taps replace one n^2 kernel. Blurring linear light (not
// sRGB) gives physically correct soft shadow edges, and it averages away
// JPEG noise and surface texture that would otherwise print onto the paint.
//
// Wall coverage (alpha) weights every tap ("normalised convolution"): the
// result is sum(w * light * wall) / sum(w * wall), so furniture next to a wall
// leaks almost none of its colour or darkness into the wall's light. Pass 1
// outputs premultiplied sums (rgb * wall, wall); pass 2 sums those and
// divides. Non-wall pixels keep a small weight (WALL_FLOOR) rather than zero:
// next to a wall they still count 1/100 as much as wall pixels, and far from
// any wall (where the masked photo covers the canvas anyway) the result falls
// back to the ordinary blur instead of black, so a soft or late-loading mask
// edge never reveals a hole.
uniform sampler2D src;
uniform vec2 dir;        // (1,0) or (0,1)
uniform float sigma;     // pixels
uniform int blurStep;    // 1 = first pass (premultiply), 2 = second pass (divide)
const float WALL_FLOOR = 0.01;
void main() {
  vec2 size = vec2(textureSize(src, 0));
  // The kernel spans +-3 sigma (99.7 % of the Gaussian's weight). To cap the
  // loop at about 2 * 48 + 1 = 97 taps for wide blurs, the tap spacing
  // (stepPx) grows once 3 sigma exceeds 48 px. The source is sampled with
  // LINEAR filtering, so spaced taps still average their neighbours.
  float stepPx = max(1.0, ceil(3.0 * sigma / 48.0));
  int n = int(ceil(3.0 * sigma / stepPx));
  vec4 acc = vec4(0.0); float wsum = 0.0;
  for (int i = -n; i <= n; i++) {
    float o = float(i) * stepPx;
    float w = exp(-0.5 * o * o / (sigma * sigma));
    // gl_FragCoord.xy is the pixel centre, so this lands on texel centres.
    // CLAMP_TO_EDGE repeats the border pixels beyond the image edge.
    vec4 t = texture(src, (gl_FragCoord.xy + dir * o) / size);
    if (blurStep == 1) { t.a = max(t.a, WALL_FLOOR); t.rgb *= t.a; }
    acc += w * t;
    wsum += w;
  }
  acc /= wsum;
  if (blurStep == 2) acc.rgb /= max(acc.a, 1e-4);
  fragOut = acc;
}

//@@ANALYSE
// P1: light -> light map, at the analysis size. Encoding per model:
//   v1: .xyz = HSV(pixel) - HSV(white) = (hue in degrees, S, V - 1)
//   v2: .x = exposure - 1  (0 = as bright as white, -1 = black)
//       .y = warm/cool     (-1 cool sky ... 0 neutral ... +1 warm sun/tungsten)
//       .z = saturation    (0 = white/grey light ... 1 = fully coloured light)
//   v3: .x  = luminance / refY  (1 = the room's reference white)
//       .yz = the light's chromaticity, CIE 1960 (u, v)
//       .w  = luminance of the blurred UNADJUSTED light, for RENDER's detail
//             layer (absolute, so RENDER can compare it with the source)
// White light encodes as "no change to the paint" in v1 and v2.
uniform sampler2D lightLin;   // blurred, wall-weighted linear light (v2, v3), adjusted by the sliders
uniform sampler2D sharpLin;   // unblurred linear light (v1)
uniform sampler2D rawLin;     // v3: blurred light WITHOUT the sliders' adjustment
uniform int   model;
uniform float refY;           // v3: luminance of the reference white (see LightStats.refY)
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (model == MODEL_V1) {                                 // v1: HSV(pixel) - HSV(white)
    fragOut = vec4(rgb2hsv(toSRGB(texelFetch(sharpLin, p, 0).rgb)) - vec3(0.0, 0.0, 1.0), 1.0);
    return;
  }
  vec3 lin = texelFetch(lightLin, p, 0).rgb;
  if (model == MODEL_V3) {
    // How much light: plain relative luminance, calibrated so the room's
    // reference white is 1. (v2's max-channel exposure and glow stand in for
    // the eye's brightness effects; v3 leaves those to the viewer's own eye.)
    float Y = lum(lin);
    // Which light: its chromaticity in the CIE 1960 UCS diagram, where colour
    // temperature and Duv are defined. Near-black pixels have no reliable
    // colour, so they read as D65 (neutral).
    vec3 XYZ = RGB2XYZ * max(lin, 0.0);
    float s = XYZ.x + 15.0 * XYZ.y + 3.0 * XYZ.z;
    vec2 uv = s > 1e-6 ? vec2(4.0 * XYZ.x, 6.0 * XYZ.y) / s : xy2uv(D65_XY);
    fragOut = vec4(Y / max(refY, 1e-4), uv, lum(texelFetch(rawLin, p, 0).rgb));
    return;
  }
  // v2. Exposure: how close the pixel is to the brightest displayable version
  // of its own colour. (Plain luminance would make the yellow beams darker
  // than the plain wall, because sRGB yellow can't be as luminous as white.)
  float exposure = max(lin.r, max(lin.g, lin.b));
  // Saturation is measured on the ENCODED value, HSV-style: (max - min) / max.
  // In encoded sRGB, near-white pixels give small, stable values instead of
  // JPEG noise being amplified as it is near black in linear light.
  vec3  enc = toSRGB(lin);
  float mx = max(enc.r, max(enc.g, enc.b)), mn = min(enc.r, min(enc.g, enc.b));
  float sat = mx > 1e-4 ? (mx - mn) / mx : 0.0;            // stable near white
  // Warm/cool direction from the Oklab hue. Real lights sit on the blackbody
  // curve: relative to 6500 K, blackbody light has an Oklab hue of 67 deg at
  // 2700 K and 73 deg at 3500 K (warm), and about -97 deg from 8000 to
  // 15000 K (cool). Green/magenta deviations are discarded (no real light
  // source has them). cos(hue - 70 deg) projects the hue onto that warm-cool
  // axis: +1 at 70 deg, -1 at -110 deg, and 0 for pure green or magenta.
  // Doubling and clamping makes every hue within +-60 deg of either end count
  // as fully warm or cool (so the 13 deg offset of skylight doesn't matter).
  // Scaling by sat means a nearly white light is nearly neutral.
  vec3  lab  = oklab(lin);
  float hue  = atan(lab.z, lab.y);
  float warm = clamp(2.0 * cos(hue - radians(70.0)), -1.0, 1.0) * sat;
  fragOut = vec4(exposure - 1.0, warm, sat, 1.0);
}

//@@RENDER
// P2: paint the wall, at the render size, into the canvas's drawing buffer.
// For each output pixel, sample the light map (interpolated; it is at the
// analysis size) and apply it to the paint. Output is encoded sRGB or
// Display P3, dithered to 8 bits.
//
// Shared uniforms
//   lightMap     ANALYSE's output (LINEAR filtering)
//   src          the source image at full resolution (v3's detail layer);
//   srcLinear    1 when src is an sRGB texture (sampled as linear light)
//   size         render size in pixels
//   model        MODEL_V1 / V2 / V3
//   dither       1 = add triangular dither before 8-bit quantisation
//   albedo       the paint's reflectance: its colour in linear sRGB
//   toOutput     linear sRGB -> linear output primaries (identity for sRGB,
//                or the sRGB -> Display P3 matrix); gamut tests use it
// v1 / v2 uniforms: see SHADER_DEFAULTS in js/paintPipeline.js.
// v3 uniforms: see renderV3.
uniform sampler2D lightMap;
uniform sampler2D src;
uniform vec2  size;
uniform int   model, dither, srcLinear;
uniform vec3  albedo;
uniform mat3  toOutput;
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
// True when c (linear sRGB) is displayable in the OUTPUT gamut (every channel
// of toOutput * c in 0..1). The 1e-4 slack absorbs float rounding, so colours
// that are exactly on the edge pass.
bool inGamut(vec3 c) {
  vec3 o = toOutput * c;
  return all(greaterThanEqual(o, vec3(-1e-4))) && all(lessThanEqual(o, vec3(1.0 + 1e-4)));
}
// Maps any linear colour into the output gamut without shifting its hue.
// Naive per-channel clamping changes hue: an over-bright orange clamps toward
// yellow. Instead, everything is done in Oklab at constant hue.
//   Stage 1 (too bright, max output channel m > 1): divide by m to fit the
//     exposure, which keeps hue AND saturation. Then bleach toward white by
//     t = 1 - exp(-0.7 (m - 1)): 0 at m = 1, rising smoothly toward 1. t lifts
//     lightness halfway to 1 and scales chroma down by (1 - t), the way film
//     or the eye loses colour in blown-out light.
//   Stage 2 (still out of gamut, e.g. too saturated or negative channels):
//     binary-search a chroma scale in 0..1 at fixed L and hue. 16 halvings
//     give 1/65536 precision, well below one 8-bit step.
// With a Display P3 output the gamut is larger, so fewer colours need it.
vec3 compress(vec3 c) {
  if (inGamut(c)) return c;                        // untouched when displayable
  vec3 o = toOutput * c;
  float m = max(o.r, max(o.g, o.b));
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
  return oklabToRGB(vec3(lab.x, lab.yz * lo));
}

// v2 (perceptual) model. d = light-map texel (exposure - 1, warm, sat);
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

// ---- v3: physically based ---------------------------------------------------
// Spectral sampling: SPECTRAL_N wavelengths from 380 nm in 20 nm steps (to
// 720 nm). js/paintPipeline.js uses exactly the same wavelengths, so the
// paint's spectral fit and this integral agree.
#define SPECTRAL_N 18
uniform vec3  cmf[SPECTRAL_N];     // CIE 1931 2-degree observer (x, y, z) at each wavelength
uniform vec3  paintW[SPECTRAL_N];  // the paint's reflectance at each wavelength x cmf
uniform vec3  whiteNorm;           // per-channel scale: the reference blackbody (T at D65) -> exactly (1,1,1)
uniform vec3  paintFix;            // per-channel correction: the paint under that reference -> exactly albedo
uniform mat3  adaptMat;            // scene-wide CAT16 adaptation, linear sRGB -> linear sRGB (built in JS)
uniform float oldBounce;           // light (in reference-white units) that the ORIGINAL white walls bounced
uniform vec3  bounceRGB;           // the new paint's multi-bounce interreflection, relative to white walls (JS, spectral)
uniform float detailGamma;         // strength of the detail layer (x the contrast exponent)

// Planck's law: spectral radiance of a blackbody at temperature T (kelvin),
// at wavelength lambda in micrometres. Only ratios matter here, so the
// constant 2hc^2 is dropped; c2 = hc/k = 14387.77 um*K.
float planck(float lambdaUm, float T) {
  return 1.0 / (pow(lambdaUm, 5.0) * (exp(14387.77 / (lambdaUm * T)) - 1.0));
}
// Correlated colour temperature from CIE 1931 xy (McCamy 1992). Within a few
// percent from 2000 to 12500 K; residual errors don't matter, because renderV3
// corrects the blackbody to the exact measured chromaticity afterwards.
float mccamyCCT(vec2 xy) {
  float n = (xy.x - 0.3320) / (0.1858 - xy.y);
  return ((449.0 * n + 3525.0) * n + 6823.3) * n + 5520.33;
}

// L = light-map texel (luminance / refY, CIE 1960 u, v, blurred raw luminance);
// sharp = the source pixel at full resolution, linear.
// Returns the lit wall colour in linear sRGB, inside the output gamut.
vec3 renderV3(vec4 L, vec3 sharp) {
  // 1. How much light. The light map is smooth (blurred at the analysis
  // size); the eye resolves brightness far more finely than colour, so fine
  // brightness detail (plaster texture, crisp shadow edges) comes back from
  // the full-resolution source: its luminance over the blurred luminance at
  // the same place. With the Contrast slider, detailGamma includes its
  // exponent, so the detail is contrasted like the light.
  float ratio = L.w > 1e-6 ? clamp(lum(sharp) / L.w, 0.125, 8.0) : 1.0;
  float E = max(L.x, 0.0) * pow(ratio, detailGamma);

  // 2. Which light. Measured chromaticity -> colour temperature -> the
  // blackbody spectrum at that temperature, integrated against the CIE
  // observer, both alone (the light) and times the paint's reflectance (the
  // light reflected by the paint). This is the spectral product a 3-channel
  // RGB multiply only approximates: against a 1 nm CIE reference, an RGB
  // multiply errs by up to dE_OK 0.044 at 2000 K (saturated paints, warm
  // light) and this integral by at most 0.009 (tests/reference_check.py).
  vec2  xy = uv2xy(L.yz);
  float T  = clamp(mccamyCCT(xy), 1667.0, 25000.0);
  vec3 lightXYZ = vec3(0.0), paintXYZ = vec3(0.0);
  for (int i = 0; i < SPECTRAL_N; i++) {
    float p = planck(0.38 + 0.02 * float(i), T);
    lightXYZ += p * cmf[i];
    paintXYZ += p * paintW[i];
  }
  // Both normalised to a light of luminance 1, in the reference-white units
  // (whiteNorm), and the paint made exact under the reference (paintFix).
  vec3 planckRGB1 = whiteNorm * (XYZ2RGB * lightXYZ) / lightXYZ.y;
  vec3 paintLit   = paintFix * whiteNorm * (XYZ2RGB * paintXYZ) / lightXYZ.y;

  // 3. The measured light is rarely exactly on the blackbody curve (Duv), and
  // McCamy's estimate is approximate: correct the result per channel by the
  // measured light's colour over the blackbody's (both at luminance 1).
  vec3 measRGB = max(XYZ2RGB * vec3(xy.x / xy.y, 1.0, (1.0 - xy.x - xy.y) / xy.y), 1e-4);
  vec3 bbRGB   = max(planckRGB1, 1e-4);
  vec3 tint    = (measRGB / lum(measRGB)) / (bbRGB / lum(bbRGB));

  // 4. Interreflection. The photo's light already includes light bounced off
  // its own (white) walls, oldBounce. Remove that and add what the NEW paint
  // bounces instead (bounceRGB, computed spectrally in JS): light that has
  // bounced between painted walls is filtered by the paint at every bounce,
  // rho(l) * rho(l) / (1 - f rho(l)) per wavelength, so it is both dimmer for
  // dark paints (deeper shadows) and more saturated than the paint itself, as
  // in a real room painted one colour.
  vec3 c = paintLit * tint * max(E - oldBounce, 0.0) + bounceRGB * oldBounce;

  // 5. Colour constancy for the whole scene (not per pixel), then highlight
  // roll-off and gamut mapping.
  return compress(adaptMat * c);
}

// Cheap, stateless hash: a pixel position -> pseudo-random 0..1. Its only
// job is to decorrelate neighbouring pixels for the dither, so it doesn't
// need to be of cryptographic or statistical quality. The constants are
// arbitrary.
float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }

void main() {
  // Image coordinates: (0,0) is the TOP-left (see COORDINATES in the header),
  // while gl_FragCoord's origin is the bottom-left of the canvas.
  vec2 uv = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y) / size;
  vec3 c;
  if (model == MODEL_V1) {
    // v1's light map holds HSV hue in degrees, which must not be interpolated
    // (359 and 1 would average to 180), so it is read without filtering.
    vec3 d = texelFetch(lightMap, ivec2(uv * vec2(textureSize(lightMap, 0))), 0).xyz;
    c = renderV1(d, albedo);
  } else if (model == MODEL_V2) {
    c = renderV2(texture(lightMap, uv).xyz, albedo);
  } else {
    vec3 s = texture(src, uv).rgb;
    c = renderV3(texture(lightMap, uv), srcLinear == 1 ? s : toLinear(s));
  }
  // To the output primaries (Display P3 or sRGB; both use the sRGB curve).
  vec3 enc = toSRGB(clamp(toOutput * c, 0.0, 1.0));
  // Triangular-PDF dither: the sum of two independent uniform 0..1 values,
  // minus 1, is triangular on -1..1. Adding it in units of one 8-bit step
  // (1/255) before quantisation turns smooth gradients' banding into fine,
  // signal-independent noise. The second hash is offset so the two values
  // are independent.
  if (dither == 1) {
    float n = hash(gl_FragCoord.xy) + hash(gl_FragCoord.xy + 17.3) - 1.0;
    enc += n / 255.0;
  }
  fragOut = vec4(clamp(enc, 0.0, 1.0), 1.0);
}
