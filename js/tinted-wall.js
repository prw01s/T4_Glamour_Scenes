/* ==========================================================================
 * tinted-wall.js — WebGL2 version of wall_lighting.glsl
 *
 * When the page and all its assets have loaded, takes <img id="tintedScene">
 * (= "ImageA") as a light map and renders the dusty-pink wall
 * hsl(0.5, 43%, 76%) lit by it ("ImageB") into a <canvas> that replaces the
 * image on screen (same size, same CSS classes).
 *
 *   PASS 1 (STEP 1)   : theArray[row*W+col] = HSV(ImageA pixel) - HSV(white)
 *   PASS 2 (STEPS 2-4): ImageB pixel k = pink wall * light from theArray[k]
 *
 * Settings: edit TINTED_WALL_SETTINGS below, or set window.TINTED_WALL_SETTINGS
 * before this script runs.
 * ======================================================================== */
(function () {
  "use strict";

  const SETTINGS = Object.assign({
    wallHSL:     [0.5, 0.43, 0.76],  // wall colour: hue in degrees, S, L in 0..1
    ambient:     0.12,  // light left in the deepest shadow
    shadowCurve: 1.0,   // >1 = deeper shadows
    warmth:      0.8,   // how strongly the light colour tints the wall
    glow:        1.2,   // extra brightness where warm light falls
    replaceImage: true  // true: canvas takes the image's place; false: canvas is added after it
  }, window.TINTED_WALL_SETTINGS || {});

  // ---------------------------------------------------------------- shaders
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

  // HSV(ImageA pixel) - HSV(white light)
  vec3 lightDiff(vec3 rgb) { return rgb2hsv(rgb) - vec3(0.0, 0.0, 1.0); }

  uniform vec3  wallHSL;
  uniform float ambient, shadowCurve, warmth, glow;

  // Pink wall lit by one theArray entry (dH, dS, dV)
  vec3 litWall(vec3 d) {
    float H = d.x, S = d.y, V = 1.0 + d.z;
    vec3  albedo   = toLinear(hsl2rgb(wallHSL));
    float exposure = pow(max(V, 0.0), 2.2 * shadowCurve);
    vec3  lightCol = toLinear(hsv2rgb(vec3(H, 1.0, 1.0)));
    vec3  tint     = mix(vec3(1.0), lightCol, S * warmth);
    float boost    = 1.0 + glow * S * exposure;
    vec3  light    = ambient + (1.0 - ambient) * exposure * boost * tint;
    vec3 c = albedo * light;
    float m = max(c.r, max(c.g, c.b));               // soft highlight roll-off
    if (m > 1.0) c = mix(c / m, vec3(1.0), clamp((m - 1.0) * 0.5, 0.0, 1.0));
    return toSRGB(clamp(c, 0.0, 1.0));
  }
  `;

  // STEP 1: ImageA -> theArray (float texture; texel row 0 = TOP row of ImageA)
  const PASS1 = COMMON + `
  uniform sampler2D imageA;
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    fragOut = vec4(lightDiff(texelFetch(imageA, p, 0).rgb), 1.0);
  }`;

  // STEPS 2-4: walk ImageB top-left first, applying theArray[index]
  const PASS2 = COMMON + `
  uniform sampler2D theArray;
  uniform int W, H;
  void main() {
    int col = int(gl_FragCoord.x);
    int row = H - 1 - int(gl_FragCoord.y);           // canvas y=0 is the bottom
    int index = row * W + col;
    vec3 d = texelFetch(theArray, ivec2(index % W, index / W), 0).xyz;
    fragOut = vec4(litWall(d), 1.0);
  }`;

  // Fallback when float render targets are unavailable: same maths, one pass
  const SINGLE = COMMON + `
  uniform sampler2D imageA;
  uniform int H;
  void main() {
    ivec2 p = ivec2(int(gl_FragCoord.x), H - 1 - int(gl_FragCoord.y));
    fragOut = vec4(litWall(lightDiff(texelFetch(imageA, p, 0).rgb)), 1.0);
  }`;

  // ---------------------------------------------------------------- helpers
  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error("Shader compile error:\n" + gl.getShaderInfoLog(s));
    return s;
  }
  function program(gl, fragSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error("Program link error:\n" + gl.getProgramInfoLog(p));
    return p;
  }
  function texture(gl) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function setSettings(gl, p) {
    gl.uniform3f(gl.getUniformLocation(p, "wallHSL"), ...SETTINGS.wallHSL);
    gl.uniform1f(gl.getUniformLocation(p, "ambient"), SETTINGS.ambient);
    gl.uniform1f(gl.getUniformLocation(p, "shadowCurve"), SETTINGS.shadowCurve);
    gl.uniform1f(gl.getUniformLocation(p, "warmth"), SETTINGS.warmth);
    gl.uniform1f(gl.getUniformLocation(p, "glow"), SETTINGS.glow);
  }

  // ---------------------------------------------------------------- main
  function renderTintedScene(overrides) {
    if (overrides && !(overrides instanceof Event)) Object.assign(SETTINGS, overrides);
    const img = document.getElementById("tintedScene");
    if (!img) { console.error("tinted-wall: no element with id 'tintedScene'"); return; }
    if (!img.complete || !img.naturalWidth) { console.error("tinted-wall: #tintedScene failed to load"); return; }

    const W = img.naturalWidth, H = img.naturalHeight;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    canvas.id = "tintedSceneResult";
    canvas.className = img.className;
    canvas.style.cssText = img.style.cssText;
    canvas.style.display = "";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", img.alt || "Tinted scene");
    // keep the on-screen size the image had
    if (img.getAttribute("width"))  canvas.style.width  = img.width + "px";
    if (img.getAttribute("height")) canvas.style.height = img.height + "px";

    const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false, premultipliedAlpha: false });
    if (!gl) { console.error("tinted-wall: WebGL2 not supported"); return; }
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (W > max || H > max) { console.error(`tinted-wall: image larger than GPU limit (${max}px)`); return; }

    // Upload ImageA exactly as stored: no flip, no colour management, row 0 = top
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    const texA = texture(gl);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, img);
    } catch (e) {
      console.error("tinted-wall: browser blocked reading #tintedScene. Serve the page and image " +
                    "from the same origin (not file://), or add crossorigin=\"anonymous\" with CORS headers.", e);
      return;
    }

    gl.bindVertexArray(gl.createVertexArray());
    gl.viewport(0, 0, W, H);
    gl.activeTexture(gl.TEXTURE0);

    if (gl.getExtension("EXT_color_buffer_float")) {
      // PASS 1: theArray (RGBA32F, W x H)
      const texArray = texture(gl);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, W, H, 0, gl.RGBA, gl.FLOAT, null);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texArray, 0);
      const p1 = program(gl, PASS1);
      gl.useProgram(p1);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.uniform1i(gl.getUniformLocation(p1, "imageA"), 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // PASS 2: ImageB onto the canvas
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const p2 = program(gl, PASS2);
      gl.useProgram(p2);
      gl.bindTexture(gl.TEXTURE_2D, texArray);
      gl.uniform1i(gl.getUniformLocation(p2, "theArray"), 0);
      gl.uniform1i(gl.getUniformLocation(p2, "W"), W);
      gl.uniform1i(gl.getUniformLocation(p2, "H"), H);
      setSettings(gl, p2);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      const p = program(gl, SINGLE);
      gl.useProgram(p);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.uniform1i(gl.getUniformLocation(p, "imageA"), 0);
      gl.uniform1i(gl.getUniformLocation(p, "H"), H);
      setSettings(gl, p);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    const old = document.getElementById("tintedSceneResult");
    if (old) old.remove();                               // re-runs replace the old result
    img.insertAdjacentElement("afterend", canvas);
    if (SETTINGS.replaceImage) img.style.display = "none";  // image stays in the DOM, hidden
    document.dispatchEvent(new CustomEvent("tintedscene:rendered", { detail: { canvas } }));
  }

  // Run once the page and ALL assets (images included) have loaded
  if (document.readyState === "complete") renderTintedScene();
  else window.addEventListener("load", renderTintedScene, { once: true });

  window.renderTintedScene = renderTintedScene;   // re-run, e.g. renderTintedScene({ glow: 1.5 })
})();
