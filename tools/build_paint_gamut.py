"""Builds the realistic paint gamut table used by js/wallPaint.js from the
Sherwin-Williams ColorSnap palette spreadsheet (sherwin-williams.com,
"downloadable color palettes", SW-XCL-SHERWIN-WILLIAMS-COLORC.zip).

Usage: .venv/bin/python -I tools/build_paint_gamut.py <palette.xlsx>
Prints a JSON table: for each hue bin (10 deg) and lightness bin (L* 5),
the largest chroma C* (CIELAB, D65) of any SW colour within +-10 deg / +-5 L*,
smoothed. Only this table is kept in the project, not the palette.
"""
import json, sys, zipfile, xml.etree.ElementTree as ET
import numpy as np
sys.path.insert(0, "tools/pairs")
from colour import lin, lab

def read_hexes(path):
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    z = zipfile.ZipFile(path)
    ss = ["".join(t.text or "" for t in si.iter("{%s}t" % ns["m"]))
          for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", ns)]
    out = []
    for r in ET.fromstring(z.read("xl/worksheets/sheet1.xml")).iter("{%s}row" % ns["m"]):
        cells = {c.get("r").rstrip("0123456789"): c for c in r.findall("m:c", ns)}
        c = cells.get("G")
        if c is None or c.find("m:v", ns) is None: continue
        v = c.find("m:v", ns).text
        h = ss[int(v)] if c.get("t") == "s" else v
        if len(h) == 6 and all(ch in "0123456789abcdefABCDEF" for ch in h): out.append(h.upper())
    return out

hexes = read_hexes(sys.argv[1])
rgb = np.array([[int(h[i:i+2], 16)/255 for i in (0, 2, 4)] for h in hexes])
L = lab(lin(rgb)); C = np.hypot(L[:, 1], L[:, 2]); H = np.degrees(np.arctan2(L[:, 2], L[:, 1])) % 360
HUES = np.arange(0, 360, 10); LS = np.arange(10, 101, 5)
table = np.zeros((len(HUES), len(LS)))
for i, h in enumerate(HUES):
    dh = np.abs((H - h + 180) % 360 - 180)
    for j, l in enumerate(LS):
        sel = (dh <= 10) & (np.abs(L[:, 0] - l) <= 5)
        table[i, j] = C[sel].max() if sel.any() else 0
# smooth over hue (circular) and lightness, never above the raw envelope's neighbours
sm = (np.roll(table, 1, 0) + 2*table + np.roll(table, -1, 0)) / 4
sm = np.maximum(sm, 0)
lrv = 100 * (lin(rgb) @ np.array([0.2126729, 0.7151522, 0.0721750]))
print(json.dumps({
  "source": "Sherwin-Williams ColorSnap palette (%d colours), CIELAB D65" % len(hexes),
  "hueStep": 10, "lStart": 10, "lStep": 5,
  "lrvRange": [round(float(lrv.min()), 1), round(float(lrv.max()), 1)],
  "lRange": [round(float(L[:, 0].min()), 1), round(float(L[:, 0].max()), 1)],
  "cMax": [[round(float(v), 1) for v in row] for row in sm]}))
print("colours", len(hexes), "max C*", round(float(C.max()), 1), file=sys.stderr)
