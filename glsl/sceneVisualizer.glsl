// sceneVisualizer.glsl - the shaders of sceneVisualizer.html ("v4" tinting).
//
// Sections are cut at the "//@@NAME" lines by js/sceneVisualizer.js:
//   VERT     fullscreen triangle
//   COMMON   prelude: precision, output, colour helpers (prepended to RENDER)
//   RENDER   the wall paint, lit by the light measured on the original paint
//
// THE MODEL (docs/scene-visualizer.md; js/wallPaint.js transfer(); the
// Python reference tools/v4ref.py). Per pixel, in CAT16 sharpened cone space
// (linear light, white = (1,1,1)):
//   delta = photo / old             the Wall Colour Delta: the light at this
//                                   pixel (brightness, colour, shading, bounce)
//   out   = delta * new * G(new) / G(old),   G(r) = 1 / (1 - kappa r)
// JS folds new * G(new) / (old * G(old)) into one vec3, `gain`, so with the
// sliders centred a pixel costs two 3x3 matrices and a multiply, and the
// original paint gives back the photo exactly (gain = 1).
// Only wall pixels are seen: the page lays the original image over the
// canvas with the wall mask as a CSS mask, so nothing else changes.
//
// Keep this file pure ASCII; the section markers are looked up by name.

//@@VERT
#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}

//@@COMMON
#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 fragOut;

// sRGB transfer functions (IEC 61966-2-1).
vec3 toSRGB(vec3 c) {
  c = max(c, 0.0);
  return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float lum(vec3 c) { return dot(c, vec3(0.2126729, 0.7151522, 0.0721750)); }

// Oklab (Ottosson 2020), with a signed cube root so it inverts everywhere.
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

//@@RENDER
// src       the photo / video frame, an sRGB texture (sampled as linear light)
// to16      linear sRGB -> CAT16 (white -> white); from16 its inverse
// old16     the original paint, CAT16
// gain      new * G(new) / (old * G(old)), CAT16 (js/wallPaint.js transfer())
// sliders   0 = both centred (skipped: exact); 1 = apply contrastK / satAmount
// contrastK exponent on the light's luminance around pivotY (1 = unchanged)
// satAmount -1..1: the light's colour, scaled 2^(satAmount * chroma/medianChroma)
// toOutput  linear sRGB -> the canvas's primaries (sRGB or Display P3)
uniform sampler2D src;
uniform mat3  to16, from16, toOutput;
uniform vec3  old16, gain;
uniform int   sliders, dither;
uniform float contrastK, pivotY, satAmount, medianChroma;

// True when c (linear sRGB) is displayable in the output gamut.
bool inGamut(vec3 c) {
  vec3 o = toOutput * c;
  return all(greaterThanEqual(o, vec3(-1e-4))) && all(lessThanEqual(o, vec3(1.0 + 1e-4)));
}
// Highlight roll-off and gamut mapping at constant Oklab hue (the same
// compress() as glsl/shaderSceneRender.glsl): over-bright colours are scaled
// into range and bleached toward white like over-exposed light; colours still
// outside lose chroma at fixed lightness and hue. Displayable colours are
// returned unchanged.
vec3 compress(vec3 c) {
  if (inGamut(c)) return c;
  vec3 o = toOutput * c;
  float m = max(o.r, max(o.g, o.b));
  vec3 lab = oklab(m > 1.0 ? c / m : c);
  float t = m > 1.0 ? 1.0 - exp(-0.7 * (m - 1.0)) : 0.0;
  lab.x  = mix(lab.x, 1.0, 0.5 * t);
  lab.yz *= 1.0 - t;
  lab.x = clamp(lab.x, 0.0, 1.0);
  if (inGamut(oklabToRGB(lab))) return oklabToRGB(lab);
  float lo = 0.0, hi = 1.0;
  for (int i = 0; i < 16; i++) {
    float mid = 0.5 * (lo + hi);
    if (inGamut(oklabToRGB(vec3(lab.x, lab.yz * mid)))) lo = mid; else hi = mid;
  }
  return oklabToRGB(vec3(lab.x, lab.yz * lo));
}

// The Contrast and Saturation sliders change the LIGHT (the Wall Colour
// Delta), not the paint, as on the other pages: saturation scales the
// light's Oklab chroma by 2^(satAmount * min(chroma / medianChroma, 3)), so
// coloured light changes most and neutral light not at all; contrast is an
// exponent on the light's luminance around its median.
vec3 adjustLight(vec3 d) {
  vec3 l = oklab(max(d, 0.0));
  float r = clamp(length(l.yz) / max(medianChroma, 1e-4), 0.0, 3.0);
  l.yz *= exp2(satAmount * r);
  d = max(oklabToRGB(l), 0.0);
  float Y = lum(d);
  if (Y > 1e-6) d *= pow(Y / max(pivotY, 1e-4), contrastK - 1.0);
  return d;
}

float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }

void main() {
  ivec2 size = textureSize(src, 0);
  ivec2 p = ivec2(gl_FragCoord.x, float(size.y) - gl_FragCoord.y);   // rows top-down as uploaded
  vec3 photo16 = to16 * texelFetch(src, p, 0).rgb;
  vec3 c16;
  if (sliders == 0) {
    c16 = photo16 * gain;
  } else {
    vec3 light = adjustLight(from16 * (photo16 / old16));
    c16 = (to16 * light) * old16 * gain;
  }
  vec3 c = compress(from16 * c16);
  vec3 enc = toSRGB(clamp(toOutput * c, 0.0, 1.0));
  // Dither (+-0.5 of an 8-bit step) so smooth wall gradients don't band.
  if (dither == 1) enc += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  fragOut = vec4(enc, 1.0);
}
