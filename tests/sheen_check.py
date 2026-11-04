"""
sheen_check.py - checks the sheen model in js/sheenModel.js (SHEENS) and
glsl/sheen.glsl against the gloss standards and the colour research quoted in
docs/sheen-science.md. The numbers it prints are quoted there and in the code
comments.

  A. A virtual gloss meter (ASTM D523 / ISO 2813 geometry). Each sheen's
     surface reflection - a coherent (mirror) share S = exp(-(k cos)^2) of the
     whole surface, and of the rest (1 - v) GGX lobe, v diffused - is
     integrated over the meter's receptor aperture and divided by what
     the black-glass standard (n = 1.567, 100 GU by definition) sends into the
     same aperture. The predicted 20/60/85 degree readings must fall inside
     the MPI gloss level of each sheen.
  B. Off-highlight colour shift (CIELAB) of sample paints for each sheen,
     against the swatch (= Flat), when the mirror direction sees surroundings
     as bright as the wall's own light ("uniform") or a dark room ("dark",
     the SCE measurement condition). Compared with Micom Labs' SCI/SCE data.
  C. The lobe's specular albedo (the shader's table, js/sheenModel.js
     specularAlbedo): exact Fresnel (n = 1.5) and height-correlated Smith,
     against Karis' EnvBRDFApprox (Schlick), which the first version used and
     which is 12-27 % low at the back wall's viewing angles.

Run:  python3 -I tests/sheen_check.py
Pure Python 3, no packages. Exits with status 1 if a check fails.
"""
import math, sys

# ---- the model (keep in sync with SHEENS in js/sheenModel.js) ---------------
F0, FLOOR = 0.04, 0.35
SHEENS = {            # alpha (GGX), v (diffused share), k (grazing, 4 pi sigma / lambda)
    "flat":      dict(alpha=0.30,  v=0.95, k=21.0),
    "eggshell":  dict(alpha=0.075, v=0.45, k=16.0),
    "satin":     dict(alpha=0.045, v=0.30, k=12.0),
    "semigloss": dict(alpha=0.025, v=0.10, k=6.5),
}
# MPI Architectural Painting Manual, gloss levels (60 deg, 85 deg) in GU.
MPI = {
    "flat":      dict(level="G1", g60=(0, 5),   g85=(0, 10)),
    "eggshell":  dict(level="G3", g60=(10, 25), g85=(10, 35)),
    "satin":     dict(level="G4", g60=(20, 35), g85=(35, 100)),
    "semigloss": dict(level="G5", g60=(35, 70), g85=None),
}

def fresnel(cos_i, n):
    """Unpolarised Fresnel reflectance of a smooth dielectric (exact)."""
    s = math.sqrt(max(0.0, 1 - cos_i * cos_i)) / n
    if s >= 1: return 1.0
    cos_t = math.sqrt(1 - s * s)
    rs = (cos_i - n * cos_t) / (cos_i + n * cos_t)
    rp = (n * cos_i - cos_t) / (n * cos_i + cos_t)
    return 0.5 * (rs * rs + rp * rp)

N_BINDER, N_GLASS = 1.5, 1.567

def ggx_D(cos_h, a):
    a2 = a * a; d = cos_h * cos_h * (a2 - 1) + 1
    return a2 / (math.pi * d * d)

def smith_G(cos_i, cos_o, a):
    """Height-correlated Smith G2 for GGX."""
    def lam(c):
        t2 = (1 - c * c) / (c * c)
        return 0.5 * (-1 + math.sqrt(1 + a * a * t2))
    return 1 / (1 + lam(cos_i) + lam(cos_o))

def norm(v): l = math.sqrt(sum(x * x for x in v)); return [x / l for x in v]

def surface_brdf_cos(sheen, wi, wo):
    """
    Surface (interface) reflection BRDF x cos(theta_o), excluding the coherent
    part. The coherent share S (Rayleigh: the surface looks smoother at
    grazing) applies to the WHOLE surface, including the diffused share, whose
    scattering is caused by the same roughness.
    """
    p = SHEENS[sheen]
    ci, co = wi[2], wo[2]
    if ci <= 0 or co <= 0: return 0.0
    h = norm([wi[0] + wo[0], wi[1] + wo[1], wi[2] + wo[2]])
    F = fresnel(sum(a * b for a, b in zip(wi, h)), N_BINDER)
    spec = ggx_D(h[2], p["alpha"]) * smith_G(ci, co, p["alpha"]) * F / (4 * ci * co)
    S = math.exp(-(p["k"] * ci) ** 2)                        # coherent (mirror) fraction
    diffused = F0 / math.pi                                  # the veil: surface reflection spread evenly
    return (1 - S) * ((1 - p["v"]) * spec + p["v"] * diffused) * co

def gloss_units(sheen, theta_deg, recep, body=0.0, n=24):
    """
    Predicted gloss reading. recep = (in-plane, perpendicular) receptor
    aperture, full angles in degrees (ASTM D523; Westlund & Meyer 2001).
    The source is collimated (its 0.75 x 2.5 deg aperture is small next to the
    receptor's). body = diffuse body reflectance that leaks into the reading.
    """
    p = SHEENS[sheen]
    th = math.radians(theta_deg)
    wi = [-math.sin(th), 0.0, math.cos(th)]                  # toward the source
    da, db = math.radians(recep[0]), math.radians(recep[1])
    flux = 0.0
    for i in range(n):
        a = th + (i + 0.5) / n * da - da / 2                  # in-plane angle of the view direction
        for j in range(n):
            b = (j + 0.5) / n * db - db / 2                   # out-of-plane angle
            wo = [math.sin(a) * math.cos(b), math.sin(b), math.cos(a) * math.cos(b)]
            dw = (da / n) * (db / n) * math.cos(b)
            f = surface_brdf_cos(sheen, wi, wo) + body * (1 - F0) / math.pi * wo[2]
            flux += f * dw
    # Coherent part: a mirror reflection, entirely inside the aperture.
    flux += math.exp(-(p["k"] * math.cos(th)) ** 2) * fresnel(math.cos(th), N_BINDER)
    return 100 * flux / fresnel(math.cos(th), N_GLASS)

APERTURES = {20: (1.8, 3.6), 60: (4.4, 11.7), 85: (4.0, 6.0)}

# ---- specular albedo ----------------------------------------------------------
def albedo(a, nov, N=64, M=16):
    """
    Directional albedo of the GGX lobe: exact Fresnel (n = 1.5), height-
    correlated Smith. Stratified half-vector sampling, N x M - the same
    quadrature as specularAlbedo() in js/sheenModel.js.
    """
    V = (math.sqrt(max(0.0, 1 - nov * nov)), 0.0, nov); s = 0.0
    for i in range(N):
        u1 = (i + 0.5) / N
        ct = math.sqrt((1 - u1) / (1 + (a * a - 1) * u1)); st = math.sqrt(1 - ct * ct)
        for j in range(M):
            ph = 2 * math.pi * (j + 0.5) / M
            h = (st * math.cos(ph), st * math.sin(ph), ct)
            voh = sum(x * y for x, y in zip(V, h))
            if voh <= 0: continue
            lz = 2 * voh * ct - nov
            if lz <= 0: continue
            s += fresnel(voh, N_BINDER) * smith_G(nov, lz, a) * voh / (ct * nov)
    return s / (N * M)

# Karis' EnvBRDFApprox (Schlick), as used by the first version of the shader.
def env_brdf(f0, rough, nov):
    c0 = (-1.0, -0.0275, -0.572, 0.022); c1 = (1.0, 0.0425, 1.04, -0.04)
    r = [rough * c0[i] + c1[i] for i in range(4)]
    a004 = min(r[0] * r[0], 2 ** (-9.28 * nov)) * r[0] + r[1]
    A = -1.04 * a004 + r[2]; B = 1.04 * a004 + r[3]
    return f0 * A + B

# ---- colour ---------------------------------------------------------------
dec = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
hexlin = lambda h: [dec(int(h[i:i + 2], 16) / 255) for i in (1, 3, 5)]
RGB2XYZ = [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]]
WHITE = [0.95047, 1.0, 1.08883]
def lab(rgb):
    X = [sum(RGB2XYZ[i][k] * rgb[k] for k in range(3)) / WHITE[i] for i in range(3)]
    f = [t ** (1 / 3) if t > 216 / 24389 else (24389 / 27 * t + 16) / 116 for t in X]
    return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])]

def shade(rgb, sheen, env, nov=math.cos(math.radians(40))):
    """applySheen with W = white light (1,1,1); env = Llobe = Lmirror (RGB)."""
    p = SHEENS[sheen]
    A = albedo(p["alpha"], nov)
    S = math.exp(-(p["k"] * nov) ** 2)
    Fm = fresnel(nov, N_BINDER)
    # Net change: the lobe's reflection in, the swatch's own veil (the same
    # surface reflection, spread evenly) out. Zero under uniform surroundings.
    d = [((1 - S) * (1 - p["v"]) * A + S * Fm) * (e - 1) for e in env]
    return [c + limit(rgb, d) * x for c, x in zip(rgb, d)]

def limit(rgb, d):
    """
    Soft darkening limiter. A swatch too dark to contain the veil (e.g.
    #2f3d4c, red 0.028 linear < 0.04) would go negative. The channel that
    loses the largest share x of itself is compressed smoothly toward a floor:
    x' = (1 - FLOOR)(1 - exp(-x / (1 - FLOOR))), and the whole change vector is
    scaled by x'/x, so its hue (the light's colour) is kept.
    """
    x = max([0.0] + [-v / max(c, 1e-6) for c, v in zip(rgb, d)])
    if x <= 1e-9: return 1.0
    return (1 - FLOOR) * (1 - math.exp(-x / (1 - FLOOR))) / x

fails = []
def check(ok, what):
    if not ok: fails.append(what)
    return "ok" if ok else "FAIL"

print("== A. Virtual gloss meter (ASTM D523 apertures, black-glass n = 1.567 = 100 GU)")
print("   sheen       alpha   v     k     20deg   60deg   85deg   60deg (white body)   MPI 60 / 85")
for name, p in SHEENS.items():
    g = {t: gloss_units(name, t, APERTURES[t]) for t in (20, 60, 85)}
    gw = gloss_units(name, 60, APERTURES[60], body=0.9)
    m = MPI[name]
    ok60 = m["g60"][0] <= g[60] <= m["g60"][1] and gw <= m["g60"][1] + 2
    ok85 = m["g85"] is None or m["g85"][0] <= g[85] <= m["g85"][1]
    print(f"   {name:<11} {p['alpha']:<7} {p['v']:<5} {p['k']:<5} {g[20]:6.1f}  {g[60]:6.1f}  {g[85]:6.1f}   {gw:6.1f}"
          f"              {m['level']} {m['g60']} / {m['g85'] or '-'}  {check(ok60, name + ' 60deg')} {check(ok85, name + ' 85deg')}")

print("== B. Off-highlight colour vs the swatch (= Flat), NoV = cos 40 deg")
print("   'uniform': the mirror direction sees surroundings as bright as the wall's light (Llobe = W)")
print("   'room':    it sees walls painted the same colour (Llobe = paint), the usual off-highlight case")
print("   'dark':    it sees nothing (Llobe = 0), as an SCE measurement")
PAINTS = [("navy", "#2f3d4c"), ("teal grey", "#607d84"), ("bronze", "#7f6743"), ("sage", "#a4aca6"), ("off-white", "#e8decd")]
for case in ("uniform", "room", "dark"):
    print(f"   -- {case}")
    for label, hx in PAINTS:
        rgb = hexlin(hx); L0 = lab(rgb); C0 = math.hypot(L0[1], L0[2]); row = []
        for name in SHEENS:
            env = [1, 1, 1] if case == "uniform" else rgb if case == "room" else [0, 0, 0]
            L = lab([max(c, 0) for c in shade(rgb, name, env)]); C = math.hypot(L[1], L[2])
            row.append(f"{name} dL* {L[0] - L0[0]:+5.1f} C* x{C / C0 if C0 > 0.5 else 1:4.2f}")
        print(f"   {label:<10} {hx} L* {L0[0]:4.1f}: " + " | ".join(row))
        if case == "uniform":
            worst = max(abs(lab([max(c, 0) for c in shade(rgb, n, [1, 1, 1])])[0] - L0[0]) for n in SHEENS)
            check(worst < 0.6, f"uniform surroundings change {hx} by dL* {worst:.2f}")
# Micom Labs: a dark bronze moulding, SCI L* ~30.9 for every finish; in SCE the
# 81 GU finish reads L* 19.6 and the 3 GU finish 30.5 (dY = 0.0375 ~ the 4 % Fresnel term).
Y0 = ((30.9 + 16) / 116) ** 3
for name in SHEENS:
    p = SHEENS[name]
    Y = shade([Y0] * 3, name, [0, 0, 0], nov=math.cos(math.radians(8)))[0]   # d/8 geometry
    print(f"   Micom bronze (SCI L* 30.9) in SCE, {name:<9}: L* {116 * Y ** (1 / 3) - 16:4.1f}"
          f"   (measured: 3 GU 30.5, 7 GU 29.1, 81 GU 19.6)")

print("== C. Specular albedo of the lobe (exact Fresnel n = 1.5, height-correlated Smith) vs Karis' approximation")
print("   NoV    " + "   ".join(f"{n:>9} exact / Karis" for n in SHEENS))
for nov in (1.0, 0.8, 0.66, 0.5, 0.4):
    cells = []
    for n, p in SHEENS.items():
        e = albedo(p["alpha"], nov); k = env_brdf(F0, math.sqrt(p["alpha"]), nov)
        cells.append(f"{e:.4f} / {k:.4f} ({100 * (k / e - 1):+4.0f} %)")
    print(f"   {nov:4.2f}   " + "   ".join(cells))
a = albedo(0.025, 1.0); b = albedo(0.025, 0.5)
check(abs(a - 0.04) < 0.002, f"albedo at normal incidence {a:.4f}")
check(abs(b / fresnel(0.5, N_BINDER) - 1) < 0.03, f"semi-gloss albedo at 60 deg {b:.4f} vs Fresnel {fresnel(0.5, N_BINDER):.4f}")
print("   table rows for js tests (alpha 0.025 / 0.075 at NoV 1, 0.6, 0.4):",
      [round(albedo(a_, n_), 5) for a_ in (0.025, 0.075) for n_ in (1.0, 0.6, 0.4)])

print("== RESULT:", "all checks pass" if not fails else "FAILED: " + "; ".join(fails))
sys.exit(1 if fails else 0)
