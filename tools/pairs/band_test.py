"""Which luminance band of the wall gives the paint's colour best (vs the light's colour from Shades-of-Grey)?"""
import glob, sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi
sys.path.insert(0, "tools"); sys.path.insert(0, "tools/pairs")
from v4ref import lin, hexlin, LUM
from colour import lab
from patches import PATCHES, PAINT
sq = np.ones((3, 3), bool)
data = []
for name, rects in PATCHES.items():
    if not rects: continue
    im = Image.open(glob.glob(f"images/source/pairs/{name}.*")[0]).convert("RGB")
    s = 640 / max(im.size); im = im.resize((round(im.width*s), round(im.height*s)), Image.LANCZOS)
    a = np.asarray(im, float)/255; I = lin(a); Y = I @ LUM
    m = np.asarray(Image.open(f"tools/pairs/masks/{name}.png").resize(im.size, Image.NEAREST)) > 127
    core = ndi.binary_erosion(m, sq, iterations=3)
    clipped = ndi.binary_dilation((a > 0.985).any(-1), sq, iterations=3)
    off = ~ndi.binary_dilation(m, sq, iterations=4) & ~clipped
    data.append((name, I, Y, core, off, hexlin(PAINT[name])))
def ab_err(lo, hi, p):
    e = []
    for name, I, Y, core, off, t in data:
        q0, q1 = np.percentile(Y[core], [lo, hi]); sel = core & (Y >= q0) & (Y <= q1)
        w = np.median(I[sel], 0)
        light = (I[off] ** p).mean(0) ** (1/p) if p else np.median(I[off], 0)
        c = w / light; c = c / (c @ LUM) * (t @ LUM)
        e.append(np.hypot(*(lab(c)[1:] - lab(t)[1:])))
    return np.median(e), np.percentile(e, 90)
for lo, hi in [(60, 90), (40, 80), (25, 60), (10, 50), (30, 70), (50, 95)]:
    for p in (6, 4, 2):
        m, p90 = ab_err(lo, hi, p); print(f"band {lo:2}-{hi:2}  p={p}: a*b* median {m:4.1f}  p90 {p90:4.1f}")
