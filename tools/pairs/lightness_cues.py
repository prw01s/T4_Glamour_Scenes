"""Which cue predicts the original paint's lightness best? Leave-one-room-out."""
import glob, sys
import numpy as np
from PIL import Image
sys.path.insert(0, "tools"); sys.path.insert(0, "tools/pairs")
from v4ref import estimate, hexlin, LUM
from colour import lab
from patches import PATCHES, PAINT
ROOM = {"1":"A","2":"A","4":"A","3":"B","5":"C","6":"D","7a":"E","7b":"E","7c":"E","10a":"E","10b":"E","10":"E","11":"E","8":"F","9":"G"}
rows = []
for name, rects in PATCHES.items():
    if not rects: continue
    im = Image.open(glob.glob(f"images/source/pairs/{name}.*")[0]).convert("RGB")
    s = 640 / max(im.size); im = im.resize((round(im.width*s), round(im.height*s)), Image.LANCZOS)
    m = np.asarray(Image.open(f"tools/pairs/masks/{name}.png").resize(im.size, Image.NEAREST)) > 127
    rho, info = estimate(np.asarray(im, float)/255, m)
    Lt = lab(hexlin(PAINT[name]))[0]
    Lp = lab(info["wall_ref"])[0]                       # the wall as photographed
    La = lab(rho)[0] if info["mode"] == "anchor" else np.nan
    key = name.replace("before", "").replace("after", "")
    rows.append((name, ROOM[key], Lt, Lp, La))
names, rooms, Lt, Lp, La = zip(*rows); Lt, Lp, La = map(np.array, (Lt, Lp, La)); rooms = np.array(rooms)
def loro(pred_fn):
    err = []
    for r in set(rooms):
        tr, te = rooms != r, rooms == r
        err += list(pred_fn(tr, te) - Lt[te])
    e = np.abs(err); return f"median |dL| {np.median(e):5.1f}  mean {e.mean():5.1f}  p90 {np.percentile(e,90):5.1f}"
print("prior (mean L of training paints) ", loro(lambda tr, te: np.full(te.sum(), Lt[tr].mean())))
print("photo wall L as is                ", loro(lambda tr, te: Lp[te]))
def lin_fit(X, tr, te):
    A = np.c_[np.ones(len(X)), X]; c, *_ = np.linalg.lstsq(A[tr], Lt[tr], rcond=None); return A[te] @ c
print("regression on photo wall L        ", loro(lambda tr, te: lin_fit(Lp[:, None], tr, te)))
Lafill = np.where(np.isnan(La), Lp, La)
print("anchor estimate (fallback=photo)  ", loro(lambda tr, te: Lafill[te]))
print("regression on photo L + anchor L  ", loro(lambda tr, te: lin_fit(np.c_[Lp, Lafill], tr, te)))
print("spread of true paint L: ", np.round(np.percentile(Lt, [0, 50, 100]), 1))
