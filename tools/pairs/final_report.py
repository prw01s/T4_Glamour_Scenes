"""End-to-end accuracy of the shipped model on the before/after pairs (dE2000 of the
after photo's wall, predicted from the before photo), with the original paint
(a) given, (b) estimated from the before photo (lightness fit leaving the room out),
(c) assumed white (what the older pages do)."""
import glob, sys
import numpy as np
from PIL import Image
sys.path.insert(0, "tools"); sys.path.insert(0, "tools/pairs")
from v4ref import recolour, hexlin, wall_stats, estimate_from_stats, lab_L, LUM
from colour import lab, de2000
from patches import PATCHES, PAINT, REFERENCE
from evaluate import region
ROOM = {"1":"A","2":"A","4":"A","3":"B","5":"C","6":"D","7a":"E","7b":"E","7c":"E","10a":"E","10b":"E","10":"E","11":"E","8":"F","9":"G"}
PAIRS = [("before1","after1"),("before3","after3"),("before5","after5"),("before7a","after7a"),("before10","after10a"),("before10","after10b"),("before11","after11")]
stats = {}
for name, rects in PATCHES.items():
    if not rects: continue
    im = Image.open(glob.glob(f"images/source/pairs/{name}.*")[0]).convert("RGB")
    s = 640 / max(im.size); im = im.resize((round(im.width*s), round(im.height*s)), Image.LANCZOS)
    m = np.asarray(Image.open(f"tools/pairs/masks/{name}.png").resize(im.size, Image.NEAREST)) > 127
    stats[name] = wall_stats(np.asarray(im, float)/255, m)
room = lambda n: ROOM[n.replace("before","").replace("after","")]
def lfit(excl):
    names = [n for n in stats if room(n) != excl]
    Lp = np.array([lab_L(stats[n][0][0] @ LUM) for n in names]); Lt = np.array([lab(hexlin(PAINT[n]))[0] for n in names])
    return tuple(np.linalg.lstsq(np.c_[np.ones(len(names)), Lp], Lt, rcond=None)[0])
rows = []
for b, a in PAIRS:
    wb, wa = region(b, PATCHES[b]), region(a, PATCHES[a]); g = region(a, REFERENCE[a]) / region(b, REFERENCE[b])
    o, n = hexlin(PAINT[b]), hexlin(PAINT[a]); est = estimate_from_stats(*stats[b], lfit(room(b)))
    e = [de2000(lab(recolour(wb, oo, n) * g), lab(wa)) for oo in (o, est, np.ones(3))]
    rows.append(e); print(f"{b+'->'+a:20} given {e[0]:5.1f}   estimated {e[1]:5.1f}   assumed white {e[2]:5.1f}")
r = np.array(rows); print("median            given %5.1f   estimated %5.1f   assumed white %5.1f" % tuple(np.median(r, 0)))
print("median w/o 7a     given %5.1f   estimated %5.1f   assumed white %5.1f" % tuple(np.median(np.delete(r, 3, 0), 0)))
