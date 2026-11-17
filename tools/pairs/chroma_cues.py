"""Which cue predicts the original paint's colour (a*, b*) best? Leave-one-room-out."""
import glob, sys
import numpy as np
from PIL import Image
sys.path.insert(0, "tools"); sys.path.insert(0, "tools/pairs")
from v4ref import estimate, hexlin, lin, LUM
from colour import lab
from patches import PATCHES, PAINT
from scipy import ndimage as ndi
ROOM = {"1":"A","2":"A","4":"A","3":"B","5":"C","6":"D","7a":"E","7b":"E","7c":"E","10a":"E","10b":"E","10":"E","11":"E","8":"F","9":"G"}
rows = []
for name, rects in PATCHES.items():
    if not rects: continue
    im = Image.open(glob.glob(f"images/source/pairs/{name}.*")[0]).convert("RGB")
    s = 640 / max(im.size); im = im.resize((round(im.width*s), round(im.height*s)), Image.LANCZOS)
    a = np.asarray(im, float)/255
    m = np.asarray(Image.open(f"tools/pairs/masks/{name}.png").resize(im.size, Image.NEAREST)) > 127
    rho, info = estimate(a, m)
    I = lin(a); off = ~ndi.binary_dilation(m, iterations=4) & ~(a > 0.985).any(-1)
    w = info["wall_ref"]
    def ab(rgbl):  # a*, b* at the paint's own lightness: chromaticity only
        rgbl = rgbl / (rgbl @ LUM) * (hexlin(PAINT[name]) @ LUM); return lab(rgbl)[1:]
    sog = (I[off] ** 6).mean(0) ** (1/6)
    gw = I[off].mean(0)
    cues = {"photo as is": ab(w), "anchor ratio": ab(rho) if info["mode"] == "anchor" else ab(w),
            "shades-of-grey (p=6)": ab(w / sog), "grey-world": ab(w / gw)}
    key = name.replace("before", "").replace("after", "")
    rows.append((ROOM[key], lab(hexlin(PAINT[name]))[1:], cues))
rooms = np.array([r[0] for r in rows]); T = np.array([r[1] for r in rows])
for cue in rows[0][2]:
    X = np.array([r[2][cue] for r in rows])
    e0 = np.hypot(*(X - T).T)
    # also: scaled by a fitted gain (photos neutralise walls), leave-one-room-out
    e1 = []
    for rm in set(rooms):
        tr, te = rooms != rm, rooms == rm
        g = (X[tr] * T[tr]).sum() / (X[tr] ** 2).sum()
        e1 += list(np.hypot(*(g * X[te] - T[te]).T))
    print(f"{cue:22} dab median {np.median(e0):4.1f} p90 {np.percentile(e0,90):4.1f}   x gain: median {np.median(e1):4.1f} p90 {np.percentile(e1,90):4.1f}   (gain on all {(X*T).sum()/(X**2).sum():.2f})")
