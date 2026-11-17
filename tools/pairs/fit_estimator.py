"""Fits the lightness line of the estimator and scores the whole estimator, leaving each room out."""
import glob, sys, json
import numpy as np
from PIL import Image
sys.path.insert(0, "tools"); sys.path.insert(0, "tools/pairs")
from v4ref import wall_stats, estimate_from_stats, hexlin, lab_L, LUM
from colour import lab, de2000
from patches import PATCHES, PAINT
ROOM = {"1":"A","2":"A","4":"A","3":"B","5":"C","6":"D","7a":"E","7b":"E","7c":"E","10a":"E","10b":"E","10":"E","11":"E","8":"F","9":"G"}
data = []
for name, rects in PATCHES.items():
    if not rects: continue
    im = Image.open(glob.glob(f"images/source/pairs/{name}.*")[0]).convert("RGB")
    s = 640 / max(im.size); im = im.resize((round(im.width*s), round(im.height*s)), Image.LANCZOS)
    m = np.asarray(Image.open(f"tools/pairs/masks/{name}.png").resize(im.size, Image.NEAREST)) > 127
    w, l = wall_stats(np.asarray(im, float)/255, m)
    data.append((name, ROOM[name.replace("before","").replace("after","")], w, l, hexlin(PAINT[name])))
rooms = np.array([d[1] for d in data])
Lp = np.array([lab_L(d[2][0] @ LUM) for d in data]); Lt = np.array([lab(d[4])[0] for d in data])
def fit(sel): A = np.c_[np.ones(sel.sum()), Lp[sel]]; return tuple(np.linalg.lstsq(A, Lt[sel], rcond=None)[0])
errs = []
for r in sorted(set(rooms)):
    f = fit(rooms != r)
    for d in [d for d in data if d[1] == r]:
        e = estimate_from_stats(d[2], d[3], f); errs.append((d[0], de2000(lab(e), lab(d[4]))))
e = np.array([x[1] for x in errs])
full = fit(np.ones(len(data), bool))
print("per photo:", " ".join(f"{n}:{v:.1f}" for n, v in errs))
print(f"estimator dE00 (leave-one-room-out): median {np.median(e):.1f}  mean {e.mean():.1f}  p90 {np.percentile(e,90):.1f}")
print("lightness fit on all photos: L0 %.2f  L1 %.3f" % full)
json.dump({"L0": round(full[0], 2), "L1": round(full[1], 4)}, open("tools/pairs/estimator_fit.json", "w"))
