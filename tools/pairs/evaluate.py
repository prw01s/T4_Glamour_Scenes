"""Predicts each after photo's wall colour from its before photo and scores candidate models (CIEDE2000)."""
import glob, sys
import numpy as np
from PIL import Image
sys.path.insert(0, "tools/pairs")
from patches import PATCHES, PAINT, REFERENCE
from colour import lin, lab, hexlin, de2000, CAT16, M

def region(name, rects):
    im = np.asarray(Image.open(glob.glob(f"images/source/pairs/{name}.*")[0]).convert("RGB"), float)/255
    H, W, _ = im.shape
    px = lin(np.concatenate([im[round(b*H):round(d*H), round(a*W):round(c*W)].reshape(-1,3) for a,b,c,d in rects]))
    Y = px @ M[1]; keep = (Y > np.percentile(Y, 10)) & (Y < np.percentile(Y, 90))
    return np.median(px[keep], axis=0)

PAIRS = [("before1","after1"),("before3","after3"),("before4","after4"),("before5","after5"),("before6","after6"),
         ("before7a","after7a"),("before9","after9"),("before10","after10a"),("before10","after10b"),("before11","after11")]
F = 0.35   # share of a wall's light that has bounced off other walls (interreflection), a guess for now
def interref(rho): return 1/(1 - F*rho)
MODELS = {
 "A white-wall assumption (current v2/v3)": lambda w, o, n: w * n,
 "B ratio, linear sRGB (known old paint)":  lambda w, o, n: w * n/o,
 "C ratio in CAT16 cone space":             lambda w, o, n: np.linalg.solve(CAT16, (CAT16@w) * (CAT16@n)/(CAT16@o)),
 "D Lab offset (keep photo-paint dLab)":    None,
 "E ratio + interreflection (F=0.35)":      lambda w, o, n: w * n/o * interref(n)/interref(o),
}
def lab_offset(w, o, n):
    from scipy.optimize import brentq
    target = lab(w) - lab(o) + lab(n)
    # invert Lab -> linear sRGB
    from colour import WHITE, M as MM
    L, a, b = target; fy = (L+16)/116; fx, fz = fy + a/500, fy - b/200
    inv = lambda t: t**3 if t > 6/29 else 3*(6/29)**2*(t-4/29)
    xyz = np.array([inv(fx), inv(fy), inv(fz)]) * WHITE
    return np.linalg.solve(MM, xyz)
MODELS["D Lab offset (keep photo-paint dLab)"] = lab_offset

if __name__ == "__main__":
    print(f"{'pair':22}" + "".join(f"{k[:1]:>7}" for k in MODELS) + "   camera gain R G B")
    scores = {k: [] for k in MODELS}
    for bef, aft in PAIRS:
        wb, wa = region(bef, PATCHES[bef]), region(aft, PATCHES[aft])
        g = region(aft, REFERENCE[aft]) / region(bef, REFERENCE[bef])        # after camera / before camera, per channel
        o, n = hexlin(PAINT[bef]), hexlin(PAINT[aft])
        row = []
        for k, f in MODELS.items():
            d = de2000(lab(f(wb, o, n) * g), lab(wa)); scores[k].append(d); row.append(d)
        print(f"{bef+'->'+aft:22}" + "".join(f"{d:7.1f}" for d in row) + "   " + " ".join(f"{x:.2f}" for x in g))
    print("\nmedian dE2000:")
    for k, v in scores.items(): print(f"  {k:42} median {np.median(v):5.1f}  mean {np.mean(v):5.1f}")
