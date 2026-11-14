//@@VERT
#version 300 es
// Full-screen triangle.
out vec2 vUv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}

//@@FRAG
#version 300 es
// ==========================================================================
// roomMovie.glsl - rebuilds one frame of the room movie from its light layers
// (docs/room-movie-plan.md section 4; assets from tools/roomMovie/).
//
// Every pixel is one of three classes:
//   0 paint (every wall)   spectral: the paint's reflectance in NB bands times
//                          each light's spectrum; the bounced light depends on
//                          the paint through q(rho) = A + B rho / (1 - F rho)
//   1 other surfaces       RGB: their radiance from the layers, with the bounce
//                          term evaluated at the paint's RGB reflectance
//   2 the window view      the exterior renders (sun and sky parts): what is
//                          behind the tree and the foliage, mixed by the tree's
//                          coverage (a video from the same wind loop as the shadows),
//                          plus the lamp-lit room reflected in the glass (layer 8)
// Direct sun and moonlight are computed here: the window opening (room face,
// outer face, frame and mullions), the leaf pattern (a looping video in the
// light's own frame, averaged over the sun's disc as seen from the leaves), and
// the lamp and cabinet as simple shadow casters.
//
// Resolution: the frame is drawn at the size of the high-resolution geometry
// (uGeoHi: normals and distance from the camera; uGeoHi8: albedo and class),
// so the sun, the leaves and every edge are computed at full size. The light
// layers are half that size; they are upsampled edge-aware (only from texels of
// the same surface: same class, same facing, same plane), so light never
// bleeds across an outline.
//
// Units: layers are "radiance per unit albedo" for unit-strength lights in
// Blender (a white light of 1 W/m2 = 683 lux); levels are lux / 683.
// ==========================================================================
precision highp float;
precision highp sampler2DArray;

in vec2 vUv;
out vec4 outColor;

#define NB 18                     // spectral bands: 380..720 nm, 20 nm (js/paintPipeline.js LAMBDAS)
#define INV_PI 0.3183098862

uniform sampler2DArray uA;        // per layer: A.rgb, F            (layer size)
uniform sampler2DArray uC;        // per layer: B.rgb (light bounced off the paint)  (half the layer size)
uniform sampler2DArray uGeo;      // layer size: 0: P.xyz, class   1: N.xyz (the upsampling guide)
uniform sampler2DArray uExt;      // 4 k + 0..3, key k: behind the tree (sun, sky), the foliage's colour (sun, sky)
uniform sampler2D uWinCov;        // the tree's coverage of the window view (video frame, same crop)
uniform sampler2DArray uLeaves;   // 0 morning, 1 sunset, 2 moon (transmission, video frames)
uniform sampler2D uGeoHi;         // full size: N.xyz, distance from the camera
uniform sampler2D uGeoHi8;        // full size: albedo.rgb (sRGB-encoded), class x 100 / 255
uniform vec3 uCamPos, uCamFwd, uCamRight;
uniform vec3 uCamK;               // focal length, horizon row, image width / 2 (full-size pixels)

uniform float uPaintA[NB], uPaintB[NB];   // paint reflectance per band: the previous paint and the new one
uniform vec3 uSweep;              // the new paint spreading along the walls: edge position, edge half-width (m), unused
uniform vec3 uPaintRGB;           // paint, linear sRGB, as a whole (for the bounce light on other surfaces)
uniform vec3 uWLamp[NB], uWSky[NB], uWSun[NB], uWMoon[NB];   // spectrum x CMF, Y-normalised
uniform vec3 uLampRGB, uSunRGB, uMoonRGB;                    // the same lights as linear sRGB (Y = 1)

uniform float uLamp;              // lamp level
uniform ivec2 uSkySlice;  uniform vec2 uSkyW;    // two sky layers and their scales
uniform ivec2 uSunbSlice; uniform vec2 uSunbW;   // two sun-bounce layers and their scales
uniform float uMoonbW;                           // moon-bounce scale (layer 7)
uniform vec3 uSunDir; uniform float uSunE;       // light direction (travel), direct irradiance level
uniform vec3 uMoonDir; uniform float uMoonE;
uniform vec2 uLeafW;              // weights of leaf patterns 0 and 1 for the sun
uniform vec4 uLeafO[3], uLeafE1[3], uLeafE2[3], uLeafS[3];  // per pattern: origin+size, e1, e2, dir+leafDepth
uniform float uGlass;             // window glass transmittance

// window (scene.json)
uniform float uY1, uY2, uSill, uHead, uWallT, uFrameX, uFrameW;
uniform vec4 uMull;               // two mullions: [y0, y1, y0', y1']
// shadow casters inside the room
uniform vec4 uLampGeo;            // x, y, cabinet top z, shade z
uniform vec3 uCab;                // depth, length, height

uniform ivec2 uExtSlice;          // keys A, B: their first slice (4 k)
uniform vec4 uExtW;               // sunA, skyA, sunB, skyB
uniform vec4 uExtRect;            // crop x, y, w, h in layer pixels (rows top to bottom)
uniform vec2 uSize;               // layer size in pixels

uniform mat3 uAdapt;              // chromatic adaptation (linear sRGB)
uniform mat3 uOut;                // linear sRGB -> output primaries
uniform float uExposure;
uniform mat3 uXYZ2RGB;
uniform int uDebug;               // 1: show the sun's leaf transmission x window (tests)

const float SUN_TAN = 0.0046;     // tan(sun angular radius 0.265 deg)

// ---------------------------------------------------------------- shadows
float softInside(float v, float lo, float hi, float w) {
  return smoothstep(lo - w, lo + w, v) * (1.0 - smoothstep(hi - w, hi + w, v));
}

// The window, seen from P along -s: open where the ray passes the opening at the
// room face and the outer face, and misses the frame bars and mullions.
float aperture(vec3 P, vec3 s) {
  if (s.x <= 1e-4) return 0.0;
  float tIn = P.x / s.x;
  vec3 H0 = P - s * tIn;
  float w0 = SUN_TAN * tIn + 0.002;
  float a = softInside(H0.y, uY1, uY2, w0) * softInside(H0.z, uSill, uHead, w0);
  float tOut = (P.x + uWallT) / s.x;
  vec3 H1 = P - s * tOut;
  float w1 = SUN_TAN * tOut + 0.002;
  a *= softInside(H1.y, uY1, uY2, w1) * softInside(H1.z, uSill, uHead, w1);
  float tF = (P.x - uFrameX) / s.x;
  vec3 H2 = P - s * tF;
  float w2 = SUN_TAN * tF + 0.002;
  a *= softInside(H2.y, uY1 + uFrameW, uY2 - uFrameW, w2) * softInside(H2.z, uSill + uFrameW, uHead - uFrameW, w2);
  a *= 1.0 - softInside(H2.y, uMull.x, uMull.y, w2);
  a *= 1.0 - softInside(H2.y, uMull.z, uMull.w, w2);
  return a;
}

// Ray P + t d (t > 0) against an axis-aligned box: 1 if it hits.
float hitBox(vec3 P, vec3 d, vec3 lo, vec3 hi) {
  vec3 inv = 1.0 / d;
  vec3 t0 = (lo - P) * inv, t1 = (hi - P) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  float tn = max(max(tmin.x, tmin.y), tmin.z), tf = min(min(tmax.x, tmax.y), tmax.z);
  return (tf > max(tn, 1e-3)) ? 1.0 : 0.0;
}
// Vertical cylinder (axis at c.xy, z from z0 to z1, radius r).
float hitCyl(vec3 P, vec3 d, vec2 c, float r, float z0, float z1) {
  vec2 o = P.xy - c;
  float a = dot(d.xy, d.xy), b = dot(o, d.xy), cc = dot(o, o) - r * r;
  float disc = b * b - a * cc;
  if (disc < 0.0 || a < 1e-8) return 0.0;
  float sq = sqrt(disc);
  for (int i = 0; i < 2; i++) {
    float t = (-b + (i == 0 ? -sq : sq)) / a;
    float z = P.z + t * d.z;
    if (t > 1e-3 && z > z0 && z < z1) return 1.0;
  }
  return 0.0;
}
// The lamp's shade: the upper half of an ellipsoid.
float hitShade(vec3 P, vec3 d, vec3 c, vec3 rad) {
  vec3 o = (P - c) / rad, dd = d / rad;
  float a = dot(dd, dd), b = dot(o, dd), cc = dot(o, o) - 1.0;
  float disc = b * b - a * cc;
  if (disc < 0.0) return 0.0;
  float sq = sqrt(disc);
  for (int i = 0; i < 2; i++) {
    float t = (-b + (i == 0 ? -sq : sq)) / a;
    if (t > 1e-3 && P.z + t * d.z > c.z) return 1.0;
  }
  return 0.0;
}
float occluded(vec3 P, vec3 s) {
  vec3 d = -s;
  float h = hitBox(P, d, vec3(0.0, 0.0, 0.0), vec3(uCab.x, uCab.y, uCab.z));
  vec2 lc = uLampGeo.xy;
  h = max(h, hitCyl(P, d, lc, 0.052, uLampGeo.z, uLampGeo.w));
  h = max(h, hitShade(P, d, vec3(lc, uLampGeo.w), vec3(0.17, 0.17, 0.10)));
  return h;
}

// Leaf transmission at P for pattern k: the pattern seen through the sun's
// disc, i.e. averaged over a disc whose radius is the sun's angular radius x the
// distance from the leaves (12 taps on a Vogel spiral, each from a finer mip
// level than the disc, so the blur is round, not boxy, however oblique the wall).
const vec2 DISK[12] = vec2[12](
  vec2(0.204, 0.000), vec2(-0.258, 0.236), vec2(0.035, -0.453), vec2(0.364, 0.393),
  vec2(-0.615, -0.083), vec2(0.534, -0.402), vec2(-0.151, 0.741), vec2(-0.448, -0.664),
  vec2(0.832, 0.240), vec2(-0.866, 0.384), vec2(0.330, -0.888), vec2(0.398, 0.909));
float leaves(vec3 P, int k) {
  vec3 O = uLeafO[k].xyz; float size = uLeafO[k].w;
  vec3 rel = P - O;
  vec2 uv = vec2(0.5 + dot(rel, uLeafE1[k].xyz) / size, 0.5 - dot(rel, uLeafE2[k].xyz) / size);
  float dist = max(dot(rel, uLeafS[k].xyz) - uLeafS[k].w, 0.5);
  float n = float(textureSize(uLeaves, 0).x);
  float rTex = SUN_TAN * dist / size * n;                 // the sun disc's radius, in texels
  float lod = log2(max(rTex * 0.45, 1.0));
  vec2 du = vec2(rTex / n);
  float t = 0.0;
  for (int i = 0; i < 12; i++) t += textureLod(uLeaves, vec3(uv + DISK[i] * du, float(k)), lod).r;
  return t / 12.0;
}

// Direct irradiance (W/m2-equivalent, before /pi) from one "sun".
float direct(vec3 P, vec3 N, vec3 s, float E, int leafA, int leafB, vec2 lw) {
  if (E <= 0.0) return 0.0;
  P += N * 0.006;                 // step off the surface before the shadow tests
  float c = dot(N, -s);
  if (c <= 0.0) return 0.0;
  float a = aperture(P, s);
  if (a <= 0.0) return 0.0;
  a *= 1.0 - occluded(P, s);
  if (a <= 0.0) return 0.0;
  float T = lw.x * leaves(P, leafA) + (leafB >= 0 ? lw.y * leaves(P, leafB) : 0.0);
  return E * c * a * T * uGlass;
}

// ---------------------------------------------------------------- layers
struct L { vec3 A; float F; vec3 C; };
// Edge-aware upsampling: the four layer texels around this pixel and their
// weights (bilinear x same surface), set once per pixel by upsampleWeights().
ivec2 TAP[4];
vec4 TAPW;
void upsampleWeights(vec2 uv, vec3 P, vec3 N, int cls, float dist) {
  vec2 lp = uv * uSize - 0.5;
  ivec2 i0 = ivec2(floor(lp));
  vec2 f = lp - floor(lp);
  ivec2 hi = ivec2(uSize) - 1;
  vec4 bil = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
  float sigma = 0.015 + 0.01 * dist;
  for (int t = 0; t < 4; t++) {
    ivec2 ij = clamp(i0 + ivec2(t & 1, t >> 1), ivec2(0), hi);
    TAP[t] = ij;
    vec4 g = texelFetch(uGeo, ivec3(ij, 0), 0);
    vec3 n = texelFetch(uGeo, ivec3(ij, 1), 0).xyz;
    float same = (int(g.w + 0.5) == cls) ? 1.0 : 0.0;
    float facing = smoothstep(0.7, 0.95, dot(normalize(n), N));
    float dp = abs(dot(g.xyz - P, N)) / sigma;
    TAPW[t] = bil[t] * same * facing * exp(-dp * dp);
  }
  float s = TAPW.x + TAPW.y + TAPW.z + TAPW.w;
  TAPW = s > 1e-4 ? TAPW / s : bil;               // nothing alike nearby (thin features): plain bilinear
}
L layer(int slice, vec2 uv) {
  vec4 a = TAPW.x * texelFetch(uA, ivec3(TAP[0], slice), 0) + TAPW.y * texelFetch(uA, ivec3(TAP[1], slice), 0)
         + TAPW.z * texelFetch(uA, ivec3(TAP[2], slice), 0) + TAPW.w * texelFetch(uA, ivec3(TAP[3], slice), 0);
  vec4 c = texture(uC, vec3(uv, float(slice)));   // bounce off the paint: smooth, half the layer size
  return L(a.rgb, a.a, c.rgb);
}
float lumq(L l, float r) {          // luminance q at reflectance r
  const vec3 Y = vec3(0.2126, 0.7152, 0.0722);
  return dot(l.A, Y) + dot(l.C, Y) * r / (1.0 - l.F * r);
}
vec3 rgbq(L l, vec3 r) { return l.A + l.C * r / (1.0 - l.F * r); }

// ---------------------------------------------------------------- tone
vec3 tone(vec3 c) {
  c = max(c, 0.0);
  float Y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // 1:1 up to the knee, then a shoulder toward 1 with slope 1 at the knee, so
  // a sun patch up to ~3.4x brighter than the paint still grades (0.95 there).
  // Paints in the ambient light (exposure 0.8 x reflectance) stay within ~4 %.
  const float K = 0.6;
  float x = max(Y - K, 0.0);
  float Yt = Y <= K ? Y : K + x / (1.0 + x / (1.0 - K));
  vec3 o = Y > 0.0 ? c * (Yt / Y) : c;
  float m = max(max(o.r, o.g), o.b);
  if (m > 1.0) o = mix(vec3(Yt), o, (1.0 - Yt) / max(m - Yt, 1e-5));   // desaturate toward white to fit
  return clamp(o, 0.0, 1.0);
}
vec3 encode(vec3 c) { return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);            // rows top to bottom
  vec4 h8 = texture(uGeoHi8, uv);
  int cls = int(h8.a * 255.0 / 100.0 + 0.5);
  vec3 rgb;
  if (cls == 2) {
    // the window view: crop rectangle in layer pixels
    vec2 px = uv * uSize;
    vec2 e = (px - uExtRect.xy) / uExtRect.zw;
    // the moving tree: background and foliage mixed by this frame's coverage
    // (5 taps: the coverage is out of focus anyway, and this hides the video's
    // compression blocks, which the window magnifies ~3x)
    vec2 dc = 1.2 / vec2(textureSize(uWinCov, 0));
    float cv = 0.4 * texture(uWinCov, e).r + 0.15 * (texture(uWinCov, e + vec2(dc.x, dc.y)).r + texture(uWinCov, e + vec2(-dc.x, dc.y)).r
             + texture(uWinCov, e + vec2(dc.x, -dc.y)).r + texture(uWinCov, e - dc).r);
    vec3 sa = mix(texture(uExt, vec3(e, float(uExtSlice.x))).rgb, texture(uExt, vec3(e, float(uExtSlice.x + 2))).rgb, cv);
    vec3 ka = mix(texture(uExt, vec3(e, float(uExtSlice.x + 1))).rgb, texture(uExt, vec3(e, float(uExtSlice.x + 3))).rgb, cv);
    vec3 sb = mix(texture(uExt, vec3(e, float(uExtSlice.y))).rgb, texture(uExt, vec3(e, float(uExtSlice.y + 2))).rgb, cv);
    vec3 kb = mix(texture(uExt, vec3(e, float(uExtSlice.y + 1))).rgb, texture(uExt, vec3(e, float(uExtSlice.y + 3))).rgb, cv);
    rgb = uGlass * (uSunRGB * (uExtW.x * sa + uExtW.z * sb) + uExtW.y * ka + uExtW.w * kb);
    // the lamp-lit room reflected in the glass (layer 8): what turns a window
    // into a dark mirror at night; it changes with the paint, like the room
    vec4 ra = texture(uA, vec3(uv, 8.0));
    vec3 rb = texture(uC, vec3(uv, 8.0)).rgb;
    rgb += uLampRGB * uLamp * (ra.rgb + rb * uPaintRGB / (1.0 - ra.a * uPaintRGB));
  } else {
    // position from the camera ray and the stored distance
    vec4 gh = texture(uGeoHi, uv);
    vec2 px = uv * vec2(2.0 * uCamK.z, float(textureSize(uGeoHi, 0).y));
    vec3 ray = normalize(uCamFwd + uCamRight * (px.x - uCamK.z) / uCamK.x + vec3(0.0, 0.0, 1.0) * (uCamK.y - px.y) / uCamK.x);
    vec3 P = uCamPos + ray * gh.w, N = normalize(gh.xyz);
    if (uDebug == 1) {
      vec3 Pd = P + N * 0.006;
      float T = uLeafW.x * leaves(Pd, 0) + uLeafW.y * leaves(Pd, 1);
      outColor = vec4(vec3(T * aperture(Pd, uSunDir)), 1.0); return;
    }
    upsampleWeights(uv, P, N, cls, gh.w);
    float Es = direct(P, N, uSunDir, uSunE, 0, 1, uLeafW);
    float Em = direct(P, N, uMoonDir, uMoonE, 2, -1, vec2(1.0, 0.0));
    L lamp = layer(0, uv);
    L skyA = layer(uSkySlice.x, uv), skyB = layer(uSkySlice.y, uv);
    L sbA = layer(uSunbSlice.x, uv), sbB = layer(uSunbSlice.y, uv);
    L mb = layer(7, uv);
    if (cls == 0) {
      // paint: spectral, per band
      // The paint sweep: along the walls (u = y - x runs from the far left of
      // the main wall, round the corner, to the window), new paint behind the edge.
      float u = P.y - P.x;
      float m = smoothstep(uSweep.x + uSweep.y, uSweep.x - uSweep.y, u);
      vec3 xyz = vec3(0.0);
      for (int k = 0; k < NB; k++) {
        float r = mix(uPaintA[k], uPaintB[k], m);
        float eLamp = uLamp * lumq(lamp, r);
        float eSky = uSkyW.x * lumq(skyA, r) + uSkyW.y * lumq(skyB, r);
        float eSun = uSunbW.x * lumq(sbA, r) + uSunbW.y * lumq(sbB, r) + Es * INV_PI;
        float eMoon = uMoonbW * lumq(mb, r) + Em * INV_PI;
        xyz += r * (uWLamp[k] * eLamp + uWSky[k] * eSky + uWSun[k] * eSun + uWMoon[k] * eMoon);
      }
      rgb = uXYZ2RGB * xyz;
    } else {
      vec3 a8 = h8.rgb, r = uPaintRGB;
      vec3 alb = mix(a8 / 12.92, pow((a8 + 0.055) / 1.055, vec3(2.4)), step(0.04045, a8));
      rgb = uLampRGB * uLamp * rgbq(lamp, r)
          + uSkyW.x * rgbq(skyA, r) + uSkyW.y * rgbq(skyB, r)
          + uSunRGB * (uSunbW.x * rgbq(sbA, r) + uSunbW.y * rgbq(sbB, r) + alb * Es * INV_PI)
          + uMoonRGB * (uMoonbW * rgbq(mb, r) + alb * Em * INV_PI);
    }
  }
  vec3 c = uAdapt * rgb * uExposure;
  outColor = vec4(encode(uOut * tone(c)), 1.0);
}
