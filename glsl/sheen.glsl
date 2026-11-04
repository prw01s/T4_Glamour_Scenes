// ============================================================================
// sheen.glsl  -  GLSL ES 3.00 (WebGL2): paint sheen (Flat, Eggshell, Satin,
// Semi-gloss) for sheenSceneRenderer.html. js/paintPipeline.js loads this
// file next to glsl/shaderSceneRender.glsl (loadShaders(url, { sheenUrl })).
//
// SECTIONS (same "//@@NAME" format as glsl/shaderSceneRender.glsl; pure ASCII)
//   ENVDOWN  one level of the reflection environment's blur pyramid (its own
//            program: COMMON + ENVDOWN)
//   SHEEN    appended to RENDER, built as COMMON + "#define SHEEN" + RENDER +
//            SHEEN. Defines sheenEnvTexel() (the ENV pass) and applySheen()
//            (the sheen of one wall pixel), which RENDER calls under SHEEN.
//
// The research behind every statement below, with sources, is in
// docs/sheen-science.md. The per-sheen numbers are SHEENS in js/sheenModel.js;
// tests/sheen_check.py checks them against the gloss standards.
//
// ---------------------------------------------------------------------------
// THE PHYSICS
//
// 1. Two reflections (the dichromatic model, Shafer 1985). Paint reflects
//    light from its BODY (light scattered back out by the pigment: the
//    paint's colour) and from its SURFACE (the Fresnel reflection at the
//    air/binder interface: the LIGHT's colour, never tinted by the paint).
//    Binder n = 1.49-1.5 gives F0 = 0.04 at normal incidence, rising toward
//    grazing (0.089 at 60 deg, 0.61 at 85 deg).
//
// 2. Sheen is roughness, not reflectivity. Every finish has the same ~4 %
//    surface reflection and the same total reflectance (an SCI measurement,
//    specular included, doesn't change with sheen: Konica Minolta, X-Rite,
//    HunterLab). Flats are formulated above the critical pigment volume
//    concentration: pigment and extender particles break through the binder
//    and scatter the surface reflection into every direction. Glossy paints
//    (low PVC) have a smooth binder surface that concentrates it around the
//    mirror direction. Gloss meters (ASTM D523 / ISO 2813: 20, 60, 85 deg,
//    100 GU = black glass n = 1.567) measure that concentration. MPI levels
//    at 60 deg: Flat G1 0-5 GU, Eggshell G3 10-25, Satin G4 20-35,
//    Semi-gloss G5 35-70.
//
// 3. The model. A sheen is (js/sheenModel.js, SHEENS):
//      v      the diffused share of the surface reflection (a uniform veil)
//      alpha  GGX roughness of the remaining (1 - v), the gloss lobe
//      k      grazing smoothness 4 pi sigma / lambda: a share
//             S = exp(-(k cos theta)^2) of the WHOLE surface reflection turns
//             into a mirror reflection near grazing (Rayleigh criterion; why
//             "sheen", the 85 deg reading, exceeds the 60 deg reading of
//             eggshell and satin, and why flats show a little sheen there)
//    A virtual gloss meter (tests/sheen_check.py) puts each sheen inside its
//    MPI band: 60 deg GU 0.2 / 10.9 / 23.7 / 48.5, 85 deg 3.5 / 22.1 / 47.8 /
//    84.9 for Flat / Eggshell / Satin / Semi-gloss.
//
// 4. The swatch is the Flat look. Paint colours are formulated and measured
//    specular-included (d/8 SCI), which is what a matte surface shows: body
//    + the whole surface veil. So the existing v3 render of the paint, c, is
//    kept exactly for Flat, and the other sheens CHANGE it:
//
//      c' = c + (1 - S)(1 - v) A(NoV) (Ll - W) + S F(NoV) (Lm - W)
//
//    W   the light on an ideal white matte wall at this pixel (v3Lit), i.e.
//        the irradiance in the light's colour. The swatch's veil is
//        A x W: the same surface reflection, spread evenly.
//    Ll  the radiance the gloss lobe actually reflects: the room traced
//        along directions drawn from the lobe (below).
//    A   the lobe's directional albedo at this viewing angle: exact Fresnel
//        (n = 1.5) and height-correlated Smith, tabulated per sheen in JS.
//        (The first version used Karis' EnvBRDFApprox, Schlick Fresnel,
//        which is 12-27 % low at the back wall's 50-66 deg.)
//    S, F, Lm  the grazing mirror share, exact Fresnel, the mirror radiance.
//    The diffused share v reflects the veil itself, so it cancels.
//    Under uniform surroundings Ll = Lm = W and every sheen equals the swatch,
//    as SCI says. Where the mirror direction sees something darker than the
//    wall's own light (the opposite wall, painted; the dark room behind the
//    camera) the veil is gone and the colour is DARKER and MORE SATURATED;
//    where it sees a window or a lamp, a sheen band or highlight appears,
//    in the light's colour.
//
// 5. What that does to colour (tests/sheen_check.py, CIELAB, off-highlight,
//    the mirror direction seeing walls of the same colour):
//      navy #2f3d4c  dL* -4.6 / -5.2 / -5.7, chroma x1.22 / 1.25 / 1.28
//      sage #a4aca6  dL* -1.1 / -1.3 / -1.7
//      off-white     dL* -0.3 / -0.4 / -0.5     (Eggshell / Satin / Semi-gloss)
//    Dark colours deepen most, whites barely change (the effect scales with
//    veil / paint luminance): what Micom Labs' SCI/SCE measurements (a 81 GU
//    and a 3 GU finish of one material: SCE L* 19.6 vs 30.5, C* 8.2 vs 4.0)
//    and every manufacturer's guidance (Behr, Dulux, Farrow & Ball:
//    "darker in a higher sheen, especially colours that are already dark")
//    describe. "Higher sheen looks lighter" (Sherwin-Williams) is the same
//    physics seen near the highlights.
//
// 6. Perception. Viewers largely discount highlights when judging a
//    surface's colour (Xiao & Brainard 2008: 16-21 % of the physical shift)
//    and judge it from the brightest NON-highlight region (Giesel &
//    Gegenfurtner 2010), while off-highlight darkening is seen in full. So
//    nothing is added beyond the physics: no extra wash-out near highlights,
//    no colour boost; the viewer's own eye does the rest (as v3 does for
//    brightness). Positively skewed luminance, i.e. glints, is a strong
//    gloss cue (Motoyoshi et al. 2007); the glints here come from the wall's
//    own texture (micro-normals, below), so they sit where real glints would
//    (Kim, Marlow & Anderson 2011: highlights must agree with the shading).
//
// 7. Darkening floor. A swatch darker than a 4 % veil in some channel can't
//    be an SCI measurement (#2f3d4c's red is 0.028 linear). The darkening is
//    compressed smoothly so no channel loses more than (1 - sheenFloor) of
//    itself; the whole change vector is scaled, so its hue (the light's
//    colour) is kept.
//
// ---------------------------------------------------------------------------
// THE GEOMETRY (reflections)
//
// js/sheenModel.js solveCamera() recovers the camera (focal length, roll,
// principal point) and the room's planes - side (window) wall, back wall,
// floor - from straight lines in the photo (single-view metrology). Here,
// for each wall pixel: the camera ray hits its wall at X; the mirror ray R
// is traced to the other wall or the floor (Y); Y is projected back into the
// photo and looked up in the ENVIRONMENT, a blurred, HDR copy of the photo in
// which the walls carry the new paint (a navy wall reflects navy, not the
// original white). The lobe is integrated by filtered importance sampling
// (Krivanek & Colbert 2008): 16 half vectors drawn from the GGX distribution
// for THIS viewing direction, each reflected ray traced to the room and read
// from the blur pyramid at the level matching the solid angle it stands for.
// That gets the reflection's blur right in size (it grows with the distance
// to what is reflected) and in shape: at the back wall's 50-60 deg the lobe
// is 1.75-2x narrower out of the plane of incidence than in it, so
// reflections stretch along the wall, as on real glossy walls. (The first
// version used three isotropic blurs, which smeared reflections vertically
// by up to 2x.) Rays that leave the photo (toward the camera,
// the ceiling) see the unseen room: its walls painted the same colour, lit
// like this one (the wall's own flat colour), for the walls' 53 % share of a
// room's surface, and the photo's mean for the rest (floor, ceiling,
// furniture, windows). The last 5 % before the photo's edge fades to it
// (standard screen-space reflection practice). Using the photo's mean alone
// would make the unseen room as bright as the window-lit average and hide
// the deepening a room painted one colour shows.
//
// Micro-normals (glints). The wall's texture shows in the photo as small
// brightness variations under raking light. For a matte surface lit from
// direction l, a normal tilted by delta toward l changes brightness by
// delta x tan(theta_i) (linear shape from shading, Pentland 1988), so
// delta = (ratio - 1) / tan(theta_i), with ratio = v3's detail ratio
// (sharp / blurred luminance) and theta_i from the key light (the window by
// day, the bulbs by night). Measured texture: 3.5-8 % -> delta about 0.6-1.4
// deg, inside the 1-5 deg of roller stipple and orange peel. Glints then
// appear by themselves where the lobe is narrower than the tilts (Satin,
// Semi-gloss) and smear out where it is wider (Eggshell, Flat): no per-sheen
// gain. Large ratios (shadow edges, frames) are not texture and are ignored.
// Limit: a photo's shading shows only the tilt TOWARD its light; the tilt
// across it is invisible, so it isn't recovered (both day and night light
// come from the left here, so the two photos can't be combined into
// photometric stereo either). Glints follow the texture's tilts along the
// light only.
//
// EMITTERS. 8-bit photos compress light sources: a window or a bulb is
// barely brighter than a white wall in the photo, many times brighter in
// the room. The ENV pass multiplies configured regions (window panes, bulbs,
// a lamp; sheenSceneRenderer.html) by a gain, so that a glossy wall reflects
// a light source as a light source. The gains come from energy balance
// (docs/sheen-science.md 5.3): how bright the window and the bulbs must be to
// light the walls next to them as brightly as the photo shows, through the
// calibrated room geometry.
// ============================================================================

//@@ENVDOWN
// One level of the environment pyramid: the 13-tap downsample of Jimenez,
// "Next Generation Post Processing in Call of Duty: Advanced Warfare"
// (SIGGRAPH 2014), which approximates a Gaussian and avoids the blocky look
// of box-filtered mipmaps under wide blurs. src is the pyramid itself, with
// TEXTURE_BASE_LEVEL = MAX_LEVEL = the level being read (so it is not also
// the level being written: no feedback loop); LOD 0 is then that level.
// size: this pass's target size (the next level).
uniform sampler2D src;
uniform vec2 size;
void main() {
  vec2 ts = 1.0 / vec2(textureSize(src, 0));
  vec2 uv = gl_FragCoord.xy / size;
#define T(x, y) textureLod(src, uv + vec2(x, y) * ts, 0.0).rgb
  vec3 a = T(-2.0,  2.0), b = T(0.0,  2.0), c = T(2.0,  2.0);
  vec3 d = T(-2.0,  0.0), e = T(0.0,  0.0), f = T(2.0,  0.0);
  vec3 g = T(-2.0, -2.0), h = T(0.0, -2.0), i = T(2.0, -2.0);
  vec3 j = T(-1.0,  1.0), k = T(1.0,  1.0), l = T(-1.0, -1.0), m = T(1.0, -1.0);
#undef T
  // Weights: the centre box 0.5, four corner boxes 0.125 each, shared taps added up.
  fragOut = vec4(e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125, 1.0);
}

//@@SHEEN
// Appended to RENDER (see the file header): uses its uniforms (lightMap, src,
// srcLinear, refY, size, ...), v3Lit() and hash().
//
// envTex      the reflection environment: RGBA16F, mipmapped by ENVDOWN.
//             Linear light in reference-white units (v3's: photo / refY).
// envMaxLod   its last level (1 x 1: the mean)
// envSize     its level-0 width, texels
// wallMask    the room's mask (black = wall), for the ENV pass
// sheenP      the sheen: GGX alpha, diffused share v, grazing k (SHEENS)
// sheenAlb    the lobe's specular albedo at cos(theta) = (i + 0.5) / 32,
//             packed 4 per vec4 (js/sheenModel.js specularAlbedo: exact
//             Fresnel, height-correlated Smith)
// sheenIor    the binder's refractive index (1.5), for the mirror term
// sheenFloor  darkening floor (see 7. in the header)
// camC, camF, camRot   the camera: principal point (image units, v down),
//             focal length (image widths), cos/sin of the roll
// planeSide, planeBack  the walls: xyz = normal (into the room), w = h,
//             points X on the wall satisfy dot(n, X) = h. Camera space:
//             x right, y up, z forward, camera at the origin.
// floorY      the floor plane y = floorY
// cornerX, sideSign  the corner, in roll-corrected image offsets; pixels
//             with (x - cornerX) * sideSign > 0 are on the side wall
// keyLight    camera-space position of the light raking the walls
// emitRect[i] emitter regions [u0, v0, u1, v1]; emitGain[i] = (threshold, gain)
uniform sampler2D envTex;
uniform sampler2D wallMask;
uniform float envMaxLod, envSize;
uniform vec3  sheenP;
uniform vec4  sheenAlb[8];
uniform float sheenIor, sheenFloor;
uniform vec2  camC, camRot;
uniform float camF;
uniform vec4  planeSide, planeBack;
uniform float floorY, cornerX, sideSign;
uniform vec3  keyLight;
uniform vec4  emitRect[4];
uniform vec2  emitGain[4];

const float PI = 3.14159265;

// ---- camera (mirrors cameraRay / project in js/sheenModel.js) --------------
// Image offset from the principal point, rotated by -roll, so that the
// horizon is horizontal and room verticals are image verticals.
vec2 unroll(vec2 uv) {
  vec2 q = uv - camC;
  return vec2(camRot.x * q.x + camRot.y * q.y, -camRot.y * q.x + camRot.x * q.y);
}
// Camera-space direction through image point uv (image v points down, camera y up).
vec3 camRay(vec2 uv) { vec2 q = unroll(uv); return normalize(vec3(q.x / camF, -q.y / camF, 1.0)); }
// Image point of camera-space point X (z > 0).
vec2 project(vec3 X) {
  vec2 q = vec2(X.x, -X.y) * (camF / X.z);
  return camC + vec2(camRot.x * q.x - camRot.y * q.y, camRot.y * q.x + camRot.x * q.y);
}

// ---- ENV pass -----------------------------------------------------------------
// Emitter gain of a photo pixel: the largest gain among the regions that
// contain it, applied to pixels whose linear luminance is above the region's
// threshold (with a soft +-0.05 ramp, so edges don't alias). Luminance, not
// the brightest channel: a warm-lit window reveal can have a clipped red
// channel, but only the bulbs' cores are bright in all three.
float emitterGainAt(vec2 uv, vec3 lin) {
  float g = 1.0, mx = lum(lin);
  for (int i = 0; i < 4; i++) {
    vec4 r = emitRect[i];
    if (uv.x >= r.x && uv.x <= r.z && uv.y >= r.y && uv.y <= r.w)
      g = max(g, mix(1.0, emitGain[i].y, smoothstep(emitGain[i].x - 0.05, emitGain[i].x + 0.05, mx)));
  }
  return g;
}
// How much a pixel is a light source (0..1): 1 where emitterGainAt applies
// its full gain. RENDER shows such pixels as the photo, unpainted: a mask may
// leave light sources partly see-through (the glass bulbs are grey in this
// room's mask), and paint there would tint the bulbs.
float sheenEmitter(vec2 uv, vec3 lin) {
  float w = 0.0, mx = lum(lin);
  for (int i = 0; i < 4; i++) {
    vec4 r = emitRect[i];
    if (emitGain[i].y > 1.0 && emitGain[i].x > 0.0 && uv.x >= r.x && uv.x <= r.z && uv.y >= r.y && uv.y <= r.w)
      w = max(w, smoothstep(emitGain[i].x - 0.05, emitGain[i].x + 0.05, mx));
  }
  return w;
}
// One texel of the environment, at the analysis size (row 0 = top): the
// photo in reference-white units with its light sources restored, and the
// walls as they look in the NEW paint (Flat, i.e. v3; one bounce of gloss
// between the walls is left out). Coverage from the mask blends the two.
// The emitter gain is applied to 4 full-resolution samples BEFORE they are
// averaged: thresholding the averaged texel would drop the soft edges of a
// bulb's core below the threshold and lose part of its light.
vec3 sheenEnvTexel(vec2 uv, float sceneY) {
  vec3 photo = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 o = (vec2(float(i & 1), float(i >> 1)) - 0.5) * 0.5 / size;
    vec3 t = textureLod(src, uv + o, 0.0).rgb;
    vec3 l = srcLinear == 1 ? t : toLinear(t);
    photo += 0.25 * l * emitterGainAt(uv + o, l);
  }
  photo /= max(refY, 1e-4);
  vec3 s = texture(src, uv).rgb;
  vec3 lin = srcLinear == 1 ? s : toLinear(s);
  vec4 m = texture(wallMask, uv);
  float wall = 1.0 - m.r * m.a;
  vec3 c, W;
  v3Lit(texture(lightMap, uv), lin, sceneY, c, W);
  return mix(photo, c, wall);
}

// ---- specular -----------------------------------------------------------------
// The lobe's directional albedo at cos(theta) = NoV, from the table
// (linear interpolation; entries at (i + 0.5) / 32).
float albedoAt(float NoV) {
  float f = clamp(NoV * 32.0 - 0.5, 0.0, 31.0);
  int i = int(floor(f));
  int j = min(i + 1, 31);
  float a = sheenAlb[i / 4][i - 4 * (i / 4)], b = sheenAlb[j / 4][j - 4 * (j / 4)];
  return mix(a, b, f - float(i));
}
// Exact unpolarised Fresnel reflectance of a smooth dielectric (index n).
float fresnelExact(float c, float n) {
  float s2 = (1.0 - c * c) / (n * n);
  if (s2 >= 1.0) return 1.0;
  float ct = sqrt(1.0 - s2);
  float rs = (c - n * ct) / (c + n * ct), rp = (n * c - ct) / (n * c + ct);
  return 0.5 * (rs * rs + rp * rp);
}

// Distance along R from X (on one wall) to the other wall or the floor,
// whichever comes first; -1 if neither. Normals point into the room, so a
// ray heading into a plane has dot(n, R) < 0. nY = the normal of the plane hit.
float traceRoom(vec3 X, vec3 R, vec4 other, out vec3 nY) {
  float t = 1e9;
  nY = other.xyz;
  float dn = dot(other.xyz, R);
  if (dn < -1e-5) { float to = (other.w - dot(other.xyz, X)) / dn; if (to > 1e-4) t = to; }
  if (R.y < -1e-5) { float tf = (floorY - X.y) / R.y; if (tf > 1e-4 && tf < t) { t = tf; nY = vec3(0.0, 1.0, 0.0); } }
  return t < 1e8 ? t : -1.0;
}

vec3 envMean() { return textureLod(envTex, vec2(0.5), envMaxLod).rgb; }

// The share of a room's interior surface that is walls: 4 x 5 x 2.5 m gives
// 45 m2 of walls against 40 m2 of floor and ceiling.
const float WALL_SHARE = 0.53;

// Radiance arriving at X from direction L, blurred over solid angle omegaS
// (the share of the lobe one sample stands for). `room` is what a ray that
// leaves the photo sees (behind the camera, the ceiling): the unseen room.
vec3 radianceFrom(vec3 X, vec3 L, vec4 other, float omegaS, vec3 room) {
  vec3 nY;
  float t = traceRoom(X, L, other, nY);
  if (t < 0.0) return room;
  vec3 Y = X + t * L;
  if (Y.z < 1e-3) return room;                       // behind the camera
  vec2 uvY = project(Y);
  float edge = smoothstep(0.0, 0.05, min(min(uvY.x, uvY.y), min(1.0 - uvY.x, 1.0 - uvY.y)));
  if (edge <= 0.0) return room;                      // outside the photo
  // Filtered importance sampling (Krivanek & Colbert 2008, GPU Gems 3 ch. 20):
  // read the pyramid at the level whose texel covers the sample's solid
  // angle. An environment texel at Y is Y.z / (camF envSize) wide across the
  // camera's view; on the surface hit it covers that / cos(camera angle), and
  // seen from X it subtends that x cos(reflected angle) / t^2.
  float texel = Y.z / (camF * envSize);
  float cosCam = max(abs(dot(nY, normalize(Y))), 0.05), cosRef = max(abs(dot(nY, L)), 0.05);
  // Colbert & Krivanek add +1 level to hide the blockiness of box-filtered
  // mipmaps; this pyramid is Gaussian-like (ENVDOWN), its level-k kernel
  // (sigma about 0.65 x 2^k texels) already spans ~2.6x the sample's solid
  // angle, so no bias is added - with it, reflections came out ~2x too blurry.
  float omegaP = texel * texel * cosRef / (cosCam * t * t);
  float lod = clamp(0.5 * log2(omegaS / omegaP), 0.0, envMaxLod);
  return mix(room, textureLod(envTex, uvY, lod).rgb, edge);
}

// The radiance the gloss lobe reflects toward V at X (normal n): the
// environment averaged over the GGX lobe for THIS viewing direction, so the
// reflection's blur is anisotropic where it should be - at the back wall's
// 50-60 deg the lobe is 1.75-2x narrower out of the plane of incidence than
// in it, which an isotropic blur gets wrong (tests/sheen_check.py; Karis
// 2013 on the "stretched" reflections lost by n = v = r). LOBE_SAMPLES half
// vectors from the GGX distribution, stratified (a Fibonacci lattice rotated
// per pixel); each reflected direction is traced to the room and read with
// filtered importance sampling, weighted by NoL (Karis 2013 prefiltering).
#define LOBE_SAMPLES 16
vec3 lobeRadiance(vec3 X, vec3 n, vec3 V, float alpha, vec4 other, vec3 room, float rot) {
  vec3 up = abs(n.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(cross(up, n)), B = cross(n, T);
  float a2 = alpha * alpha;
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < LOBE_SAMPLES; i++) {
    float u = (float(i) + 0.5) / float(LOBE_SAMPLES);
    float phi = 2.0 * PI * fract(float(i) * 0.6180339887 + rot);
    float cosT = sqrt((1.0 - u) / (1.0 + (a2 - 1.0) * u));      // GGX: tan^2 = a^2 u / (1 - u)
    float sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
    vec3 h = T * (sinT * cos(phi)) + B * (sinT * sin(phi)) + n * cosT;
    float VoH = dot(V, h);
    if (VoH <= 0.0) continue;
    vec3 L = 2.0 * VoH * h - V;
    float NoL = dot(n, L);
    if (NoL <= 0.0) continue;
    float dd = cosT * cosT * (a2 - 1.0) + 1.0;
    float pdf = a2 / (PI * dd * dd) * cosT / (4.0 * VoH);       // of L
    sum += NoL * radianceFrom(X, L, other, 1.0 / (float(LOBE_SAMPLES) * pdf), room);
    wsum += NoL;
  }
  return wsum > 0.0 ? sum / wsum : room;
}

// The sheen of one wall pixel. c and W from v3Lit (before adaptation), L the
// light-map texel, uv the image point (row 0 = top). Returns linear sRGB,
// before adaptation and gamut mapping (RENDER does both).
vec3 applySheen(vec3 c, vec3 W, vec4 L, vec2 uv) {
  vec3 d = camRay(uv);
  bool onSide = (unroll(uv).x - cornerX) * sideSign > 0.0;
  vec4 P = onSide ? planeSide : planeBack;
  vec4 O = onSide ? planeBack : planeSide;
  vec3 n = P.xyz;
  vec3 X = d * (P.w / dot(n, d));                    // where the camera ray meets the wall

  // Micro-normal from the wall's texture (see the header). The detail ratio
  // is read from a smoothed source (lod 1.5: about 3 px) so JPEG noise and
  // single pixels don't sparkle; the light map's .w is the blurred luminance
  // at the same place. Tilts are capped at 0.025 rad (1.4 deg), the top of
  // what this photo's texture measures (0.6-1.4 deg) and the low end of
  // roller stipple (1-5 deg). Only the tilt toward the light is visible in a
  // photo's shading, so only that component is recovered.
  vec3 s = textureLod(src, uv, 1.5).rgb;
  float dev = (L.w > 1e-6 ? lum(srcLinear == 1 ? s : toLinear(s)) / L.w : 1.0) - 1.0;
  vec3 toL = keyLight - X;
  float nl = dot(n, toL);
  vec3 tg = toL - n * nl;                            // toward the light, along the wall
  float tl = length(tg);
  float delta = 0.0;
  if (nl > 1e-4 && tl > 1e-5)
    delta = clamp(dev * nl / tl, -0.025, 0.025) * (1.0 - smoothstep(0.1, 0.25, abs(dev)));
  vec3 n2 = normalize(n + delta * tg / max(tl, 1e-5));

  vec3 V = -d;
  float NoV = clamp(dot(n2, V), 1e-3, 1.0);
  vec3 room = mix(envMean(), c, WALL_SHARE);
  vec3 Ll = lobeRadiance(X, n2, V, sheenP.x, O, room, hash(gl_FragCoord.xy));
  // Near grazing, a share S of the whole surface reflection is a mirror
  // reflection (Rayleigh); it reflects the mirror direction, with exact Fresnel.
  float kc = sheenP.z * NoV, S = exp(-kc * kc);
  vec3 Lm = S > 1e-4 ? radianceFrom(X, reflect(d, n2), O, 1e-7, room) : W;
  // Each part reflects what it sees instead of the veil the swatch holds for
  // it (the same albedo spread evenly): zero under even surroundings.
  vec3 dl = (1.0 - S) * (1.0 - sheenP.y) * albedoAt(NoV) * (Ll - W)
          + S * fresnelExact(NoV, sheenIor) * (Lm - W);

  // Darkening floor (see 7. in the header): x = the largest share of itself
  // any channel would lose; compressed to (1 - floor)(1 - exp(-x / (1 - floor))).
  vec3 rel = -dl / max(c, vec3(1e-6));
  float x = max(max(rel.r, rel.g), rel.b);
  float kf = 1.0 - sheenFloor;
  float lim = x > 1e-6 ? kf * (1.0 - exp(-x / kf)) / x : 1.0;
  return c + lim * dl;
}
