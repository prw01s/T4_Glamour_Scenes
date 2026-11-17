"""Fits kappa (bounce light) and gamma (tone compression) of the transfer on the pairs,
leaving one pair out; prints per-pair errors for the plain physical swap and the fitted model."""
import glob, sys
import numpy as np
sys.path.insert(0, "tools"); sys.path.insert(0, "tools/pairs")
from v4ref import recolour, hexlin
from colour import lab, de2000
from patches import PATCHES, PAINT, REFERENCE
from evaluate import region
TRUSTED = [("before1","after1"),("before3","after3"),("before5","after5"),("before7a","after7a"),
           ("before10","after10a"),("before10","after10b"),("before11","after11")]
D = []
for b, a in TRUSTED:
    wb, wa = region(b, PATCHES[b]), region(a, PATCHES[a])
    g = region(a, REFERENCE[a]) / region(b, REFERENCE[b])
    D.append((b+"->"+a, wb, wa, g, hexlin(PAINT[b]), hexlin(PAINT[a])))
def err(d, k, gm): n, wb, wa, g, o, nn = d; return de2000(lab(recolour(wb, o, nn, k, gm) * g), lab(wa))
K = np.linspace(0, 0.9, 19); G = np.linspace(1, 3, 21)
def best(sub):
    s = [[np.median([err(d, k, gm) for d in sub]) for gm in G] for k in K]; i, j = np.unravel_index(np.argmin(s), (len(K), len(G))); return K[i], G[j]
loo = []
for i, d in enumerate(D):
    k, gm = best(D[:i] + D[i+1:]); loo.append((d[0], err(d, 0, 1), err(d, k, gm), k, gm))
for n, e0, e1, k, gm in loo: print(f"{n:20} plain {e0:5.1f}   fitted {e1:5.1f}   (kappa {k:.2f}, gamma {gm:.1f})")
print(f"median: plain {np.median([l[1] for l in loo]):.1f}   fitted (held out) {np.median([l[2] for l in loo]):.1f}")
print("fit on all: kappa %.2f gamma %.1f" % best(D))
