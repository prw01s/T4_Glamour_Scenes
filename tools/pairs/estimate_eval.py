"""Scores the automatic original-paint estimator on all pair photos (known paint)."""
import glob, sys
import numpy as np
from PIL import Image
sys.path.insert(0, "tools"); sys.path.insert(0, "tools/pairs")
from v4ref import estimate, hexlin
from colour import lab, de2000
from patches import PATCHES, PAINT
K = float(sys.argv[1]) if len(sys.argv) > 1 else 1.0
res = []
for name, rects in PATCHES.items():
    if not rects: continue
    im = Image.open(glob.glob(f"images/source/pairs/{name}.*")[0]).convert("RGB")
    s = 640 / max(im.size); im = im.resize((round(im.width*s), round(im.height*s)), Image.LANCZOS)
    m = np.asarray(Image.open(f"tools/pairs/masks/{name}.png").resize(im.size, Image.NEAREST)) > 127
    rho, info = estimate(np.asarray(im, float)/255, m, K)
    t = hexlin(PAINT[name]); le, lt = lab(rho), lab(t)
    d = de2000(le, lt); res.append((name, d, le[0]-lt[0], np.hypot(*(le[1:]-lt[1:])), info.get("mode"), np.log(rho@[0.2126,0.7152,0.0722]/(t@[0.2126,0.7152,0.0722]))))
    print(f"{name:9} {info.get('mode'):8} dE00 {d:5.1f}  dL {le[0]-lt[0]:6.1f}  dab {np.hypot(*(le[1:]-lt[1:])):5.1f}   est L{le[0]:5.1f} a{le[1]:5.1f} b{le[2]:5.1f}  true L{lt[0]:5.1f} a{lt[1]:5.1f} b{lt[2]:5.1f}")
d = np.array([r[1] for r in res]); ab = np.array([r[3] for r in res]); lr = np.array([r[5] for r in res])
print(f"\nK={K}: dE00 median {np.median(d):.1f} mean {d.mean():.1f} p90 {np.percentile(d,90):.1f};  colour-only dab median {np.median(ab):.1f};  best K = {K*np.exp(-np.median(lr)):.2f}")
