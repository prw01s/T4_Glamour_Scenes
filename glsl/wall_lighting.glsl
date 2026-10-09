// ============================================================================
// wall_lighting.glsl  —  ImageA used as a LIGHT MAP on a dusty-pink wall
//
// Idea: the wall's own colour (albedo) is hsl(0.5, 43%, 76%). ImageA describes
// the light that falls on it, measured against neutral white light:
//     white in ImageA  -> neutral light   -> the wall shows its natural pink
//     dark in ImageA   -> less light      -> pink gets darker (shadow), same hue
//     yellow in ImageA -> warm light      -> pink is tinted warm and brightened
//
// Same pipeline as before (PASS1 fills theArray in top-left-first order, PASS2
// walks ImageB in the same order), but:
//   * theArray holds the HSV difference from white (dH, dS, dV), not HSL.
//     HSV "Value" = light intensity, so bright yellow counts as fully lit, not
//     as "darker than white". HSV saturation also stays stable for near-white
//     pixels, so the streaks in the upper right go away.
//   * PASS2 MULTIPLIES the wall colour by the light in linear RGB instead of
//     adding HSL numbers. Shadows keep the wall's hue and lights tint it, the
//     way real light behaves.
// ============================================================================

//@@VERTEX
#version 330 core
const vec2 P[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
void main() { gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }

//@@COMMON
#version 330 core
out vec4 fragOut;

vec3 rgb2hsv(vec3 c) {                       // H in degrees, S/V in [0,1]
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
vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSRGB(vec3 c)   { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

//@@PASS1
// ---- STEP 1: theArray = HSV(pixel) - HSV(white light) -------------------------
uniform sampler2D imageA;
const vec3 WHITE_HSV = vec3(0.0, 0.0, 1.0);
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    fragOut = vec4(rgb2hsv(texelFetch(imageA, p, 0).rgb) - WHITE_HSV, 1.0);
}

//@@PASS2
// ---- STEPS 2-4: light the pink wall with theArray ------------------------------
uniform sampler2D theArray;
uniform int   W;
uniform float ambient;      // light left in the deepest shadow        (0 = black)
uniform float shadowCurve;  // >1 = deeper, more contrasty shadows
uniform float warmth;       // how strongly the light colour tints the wall
uniform float glow;         // extra brightness where warm light falls
const vec3 BASE_HSL = vec3(0.5, 0.43, 0.76);    // the wall: hsl(0.5, 43%, 76%)

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    int index = p.y * W + p.x;
    vec3 d  = texelFetch(theArray, ivec2(index % W, index / W), 0).xyz;
    float H = d.x, S = d.y, V = 1.0 + d.z;              // undo "minus white"

    vec3  albedo   = toLinear(hsl2rgb(BASE_HSL));       // wall colour, linear
    float exposure = pow(V, 2.2 * shadowCurve);          // light intensity, linear
    vec3  lightCol = toLinear(hsv2rgb(vec3(H, 1.0, 1.0)));
    vec3  tint     = mix(vec3(1.0), lightCol, S * warmth);
    float boost    = 1.0 + glow * S * exposure;          // warm light = brighter
    vec3  light    = ambient + (1.0 - ambient) * exposure * boost * tint;

    vec3 c = albedo * light;
    float m = max(c.r, max(c.g, c.b));                   // soft highlight roll-off:
    if (m > 1.0) c = mix(c / m, vec3(1.0), clamp((m - 1.0) * 0.5, 0.0, 1.0));
    fragOut = vec4(toSRGB(clamp(c, 0.0, 1.0)), 1.0);
}
