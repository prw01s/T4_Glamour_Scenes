import glob, sys
from PIL import Image, ImageDraw
sys.path.insert(0, "tools/pairs")
from patches import PATCHES
tiles = []
for name, rects in PATCHES.items():
    im = Image.open(glob.glob(f"images/source/pairs/{name}.*")[0]).convert("RGB")
    W, H = im.size
    for i, (a, b, c, d) in enumerate(rects):
        crop = im.crop((round(a*W), round(b*H), round(c*W), round(d*H)))
        crop.thumbnail((150, 150))
        t = Image.new("RGB", (154, 168), "white"); t.paste(crop, (2, 16))
        ImageDraw.Draw(t).text((2, 2), f"{name}#{i}", fill="black"); tiles.append(t)
cols = 12; rows = (len(tiles)+cols-1)//cols
sheet = Image.new("RGB", (cols*154, rows*168), "white")
for k, t in enumerate(tiles): sheet.paste(t, ((k % cols)*154, (k//cols)*168))
sheet.save("/tmp/pairs_grid/patches.jpg", quality=88); print(sheet.size, len(tiles))
