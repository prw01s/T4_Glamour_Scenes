"""Measures the wall patches: photo colour vs the paint's own colour."""
import glob, sys
import numpy as np
from PIL import Image
sys.path.insert(0, "tools/pairs")
from patches import PATCHES, PAINT

def lin(c): c = np.asarray(c, float); return np.where(c <= 0.04045, c/12.92, ((c+0.055)/1.055)**2.4)
M = np.array([[0.4124564,0.3575761,0.1804375],[0.2126729,0.7151522,0.0721750],[0.0193339,0.1191920,0.9503041]])
WHITE = M @ np.ones(3)
def lab(rgbl):
    xyz = (M @ rgbl) / WHITE
    f = np.where(xyz > (6/29)**3, np.cbrt(xyz), xyz/(3*(6/29)**2) + 4/29)
    return np.array([116*f[1]-16, 500*(f[0]-f[1]), 200*(f[1]-f[2])])
def hexlin(h): h = h.lstrip('#'); return lin([int(h[i:i+2],16)/255 for i in (0,2,4)])

rows = []
for name, rects in PATCHES.items():
    if not rects: continue
    im = np.asarray(Image.open(glob.glob(f"images/source/pairs/{name}.*")[0]).convert("RGB"), float)/255
    H, W, _ = im.shape
    px = np.concatenate([im[round(b*H):round(d*H), round(a*W):round(c*W)].reshape(-1,3) for a,b,c,d in rects])
    L = lin(px); Y = L @ M[1]
    keep = (Y > np.percentile(Y, 10)) & (Y < np.percentile(Y, 90))        # drop grooves, fixtures
    med = np.median(L[keep], axis=0); p10, p90 = np.percentile(Y[keep], [10, 90])
    paint = hexlin(PAINT[name]); ratio = med/paint
    rows.append((name, PAINT[name], lab(paint), lab(med), ratio/ratio[1], ratio[1], p90/p10))
print(f"{'image':9} {'paint':8} {'paint L a b':>18} {'photo L a b':>18}  {'R/G  B/G (light colour)':>24} {'exposure x':>10} {'spread':>6}")
for n,h,lp,lw,rr,e,sp in rows:
    print(f"{n:9} {h:8} {lp[0]:6.1f}{lp[1]:6.1f}{lp[2]:6.1f} {lw[0]:6.1f}{lw[1]:6.1f}{lw[2]:6.1f}  {rr[0]:10.3f} {rr[2]:10.3f}   {e:10.2f} {sp:6.2f}")
