"""Reference implementation (Python) of the sceneVisualizer tinting model
("v4"). The GLSL in glsl/sceneVisualizer.glsl must match it; the pair
measurements in tools/pairs/ use it to fit and check its parameters.

Model, per wall pixel, in CAT16 (sharpened cone) space, linear light:
    delta   = photo / rho_old                  the Wall Colour Delta (the light)
    ratio   = (rho_new / rho_old) ** (1/gamma)  tone: edited photos compress ratios
    bounce  = G(rho_new) / G(rho_old),  G(r) = 1 / (1 - kappa r)
    out     = photo * ratio * bounce
gamma = 1, kappa = 0 is the plain physical swap (photo / rho_old * rho_new).
"""
import numpy as np
from scipy import ndimage as ndi

def lin(c): c = np.asarray(c, float); return np.where(c <= 0.04045, c/12.92, ((c+0.055)/1.055)**2.4)
def enc(c): c = np.clip(np.asarray(c, float), 0, None); return np.where(c <= 0.0031308, 12.92*c, 1.055*c**(1/2.4)-0.055)
SRGB_XYZ = np.array([[0.4124564,0.3575761,0.1804375],[0.2126729,0.7151522,0.0721750],[0.0193339,0.1191920,0.9503041]])
CAT16 = np.array([[0.401288,0.650173,-0.051461],[-0.250268,1.204414,0.045854],[-0.002079,0.048952,0.953127]])
_M = CAT16 @ SRGB_XYZ
TO16 = _M / (_M @ np.ones(3))[:, None]           # linear sRGB -> CAT16, white (1,1,1) -> (1,1,1)
FROM16 = np.linalg.inv(TO16)
LUM = SRGB_XYZ[1]

def hexlin(h): h = h.lstrip('#'); return lin([int(h[i:i+2], 16)/255 for i in (0, 2, 4)])

KAPPA = 0.40               # fitted on the pairs (tools/pairs/fit_transfer.py); gamma fitted to 1.0

def recolour(photo_lin, rho_old, rho_new, kappa=KAPPA, gamma=1.0):
    """photo_lin: (..., 3) linear sRGB; rho_*: linear sRGB reflectances. Returns linear sRGB."""
    p = photo_lin @ TO16.T
    o, n = TO16 @ rho_old, TO16 @ rho_new
    o, n = np.maximum(o, 1e-4), np.maximum(n, 1e-4)
    G = lambda r: 1.0 / (1.0 - kappa * np.clip(r, 0, 1))
    out = p * (n / o) ** (1.0 / gamma) * G(n) / G(o)
    return out @ FROM16.T

# ---------------------------------------------------------------- estimation
# The original paint from the image alone (tools/pairs/*_cues.py chose these,
# scored leaving each room out):
#   colour     the wall's light-weighted colour over the light's colour, the
#              light being Shades-of-Grey (p = 6) of the non-wall pixels
#              (median 3.6 a*b* on the pairs; white-trim anchoring 4.0)
#   lightness  L*_paint = L0 + L1 * L*_wall-as-photographed: photographers
#              expose walls toward a typical brightness, so the photo's wall
#              lightness predicts the paint only through this compressed fit
#              (median 5.5 L*; anchoring 10.5)
SOG_P = 6.0
L_FIT = (None, None)       # set by fit_lightness() / the constants below

def wall_stats(img_srgb, wall):
    """The two image statistics the estimate needs (also computed on the GPU):
    wall_ref  median linear colour of the wall's 60-90th luminance percentile
    light     Shades-of-Grey of the non-wall, unclipped pixels."""
    I = lin(img_srgb); Y = I @ LUM
    sq = np.ones((3, 3), bool)                       # square neighbourhoods, as js/wallPaint.js
    core = ndi.binary_erosion(wall, sq, iterations=3)
    if core.sum() < 50: core = wall
    clipped = ndi.binary_dilation((img_srgb > 0.985).any(-1), sq, iterations=3)
    off = ~ndi.binary_dilation(wall, sq, iterations=4) & ~clipped
    lo, hi = np.percentile(Y[core], [60, 90])
    sel = core & (Y >= lo) & (Y <= hi)
    wall_ref = np.median(I[sel], 0)
    m0, m1 = np.percentile(Y[core], [30, 70])                # the ambient-lit middle: colour
    wall_mid = np.median(I[core & (Y >= m0) & (Y <= m1)], 0)
    light = (I[off] ** SOG_P).mean(0) ** (1 / SOG_P) if off.sum() > 100 else np.ones(3)
    return (wall_ref, wall_mid), light

def lab_L(Y): return 116 * np.cbrt(Y) - 16 if Y > (6/29)**3 else Y * (29/3)**3
def Y_of_L(L): return ((L + 16) / 116) ** 3 if L > 8 else L / (29/3)**3

def estimate_from_stats(wall, light, l_fit):
    # colour from the wall's middle luminance band (direct sun patches sit in
    # the upper band and carry the sun's colour, not the paint's); lightness
    # from the 60-90 % band the fit was made with
    wall_ref, wall_mid = wall
    chroma = wall_mid / np.maximum(light, 1e-6)
    chroma = chroma / max(chroma @ LUM, 1e-6)                    # unit luminance
    Lp = lab_L(float(wall_ref @ LUM))
    L = np.clip(l_fit[0] + l_fit[1] * Lp, 20, 97)
    return np.clip(chroma * Y_of_L(L), 0.003, 0.95)

def estimate(img_srgb, wall, l_fit=None):
    w, light = wall_stats(img_srgb, wall)
    return estimate_from_stats(w, light, l_fit or L_FIT), {"wall_ref": w[0], "wall_mid": w[1], "light": light}
