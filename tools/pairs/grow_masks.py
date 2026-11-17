"""Approximate wall masks for the pair photos, grown from the hand-marked
wall patches (tools/pairs/patches.py) through smooth, similarly coloured
pixels. For testing only. Writes tools/pairs/masks/<name>.png (white = wall)
and an overlay sheet /tmp/pairs_grid/masks_<k>.jpg for checking by eye."""
import glob, os, sys
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
sys.path.insert(0, "tools/pairs")
from patches import PATCHES, PAINT, EXCLUDE, CHROMA_TOL
from colour import lin, lab

N = 640                     # working size (long side)
os.makedirs("tools/pairs/masks", exist_ok=True)

def grow(name):
    im = Image.open(glob.glob(f"images/source/pairs/{name}.*")[0]).convert("RGB")
    W0, H0 = im.size; s = N / max(W0, H0)
    sm = np.asarray(im.resize((round(W0*s), round(H0*s)), Image.LANCZOS), float) / 255
    H, W, _ = sm.shape
    L = lab(lin(ndi.gaussian_filter(sm, (1.2, 1.2, 0))))
    # edges: Lab gradient magnitude
    g = np.sqrt(sum(ndi.sobel(L[..., k], a)**2 for k in range(3) for a in (0, 1)))
    seeds = np.zeros((H, W), bool)
    for a, b, c, d in PATCHES[name]:
        seeds[round(b*H):round(d*H), round(a*W):round(c*W)] = True
    ref = np.median(L[seeds], 0)
    # wall-like: smooth, chromaticity near the seeds' (lightness may vary with light)
    chroma_d = np.hypot(L[..., 1] - ref[1], L[..., 2] - ref[2])
    gl = np.percentile(g[seeds], 90)
    ok = (g < max(gl * 1.6, 6)) & (chroma_d < CHROMA_TOL.get(name, 7)) & (L[..., 0] > 3)
    for a, b, c, d in EXCLUDE.get(name, []):
        ok[round(b*H):round(d*H), round(a*W):round(c*W)] = False
    lab_, n = ndi.label(ok | seeds)
    keep = np.unique(lab_[seeds]); keep = keep[keep > 0]
    m = np.isin(lab_, keep)
    m = ndi.binary_closing(m, iterations=3); m = ndi.binary_fill_holes(m); m = ndi.binary_opening(m, iterations=2)
    for a, b, c, d in EXCLUDE.get(name, []):
        m[round(b*H):round(d*H), round(a*W):round(c*W)] = False
    Image.fromarray((m*255).astype(np.uint8)).resize((W0, H0), Image.NEAREST).save(f"tools/pairs/masks/{name}.png")
    ov = (sm*255).astype(np.uint8).copy(); ov[m] = (0.5*ov[m] + [0, 0, 127]).astype(np.uint8)
    t = Image.fromarray(ov); t.thumbnail((300, 300)); ImageDraw.Draw(t).text((3, 3), name, fill=(255, 0, 0))
    return t, m.mean()

names = [n for n, r in PATCHES.items() if r]
tiles = []
for n in names:
    t, f = grow(n); tiles.append(t); print(f"{n:9} wall {f*100:5.1f}%")
for k in range(0, len(tiles), 12):
    part = tiles[k:k+12]; sheet = Image.new("RGB", (6*302, 2*302), "white")
    for i, t in enumerate(part): sheet.paste(t, ((i % 6)*302, (i//6)*302))
    sheet.save(f"/tmp/pairs_grid/masks_{k//12}.jpg", quality=85)
