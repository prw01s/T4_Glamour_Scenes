import glob, sys
from PIL import Image, ImageDraw
sys.path.insert(0, "tools/pairs")
from patches import REFERENCE
tiles = []
for name, rects in REFERENCE.items():
    im = Image.open(glob.glob(f"images/source/pairs/{name}.*")[0]).convert("RGB"); W, H = im.size
    for a, b, c, d in rects:
        crop = im.crop((round(a*W), round(b*H), round(c*W), round(d*H))); crop.thumbnail((180, 120))
        t = Image.new("RGB", (184, 136), "white"); t.paste(crop, (2, 16)); ImageDraw.Draw(t).text((2, 2), name, fill="black"); tiles.append(t)
cols = 10; rows = (len(tiles)+cols-1)//cols
sheet = Image.new("RGB", (cols*184, rows*136), "white")
for k, t in enumerate(tiles): sheet.paste(t, ((k % cols)*184, (k//cols)*136))
sheet.save("/tmp/pairs_grid/refs.jpg", quality=88)
