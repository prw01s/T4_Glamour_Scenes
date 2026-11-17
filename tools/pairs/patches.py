"""Hand-marked clean wall patches in the ground-truth pairs (images/source/pairs).
Rectangles as fractions of width/height: (x0, y0, x1, y1). Approximate, for statistics only."""
PAINT = {  # hex, LRV as given (calculated LRV used where they disagree)
 "before1": "#BCB6B6", "before2": "#BCB6B6", "before4": "#BCB6B6", "before3": "#E3E0DA", "before5": "#767665",
 "before6": "#CEC8BD", "before7a": "#CEC8BD", "before7b": "#CEC8BD", "before9": "#9DBDB3", "before10": "#CEC8BD",
 "before8": "#CFBA9C", "before11": "#9FA195",
 "after1": "#4A5D5F", "after2": "#4A5D5F", "after4": "#4A5D5F", "after3": "#736660", "after5": "#C9CDB9",
 "after6": "#9FA195", "after7a": "#9FA195", "after7b": "#9FA195", "after7c": "#9FA195", "after7d": "#AF9F8B",
 "after10a": "#9FA195", "after10b": "#9FA195", "after8": "#DAD1C4", "after9": "#A8A295", "after11": "#AF9F8B",
}
PATCHES = {
 "before1": [(0.25, 0.35, 0.70, 0.60), (0.80, 0.15, 0.97, 0.60), (0.01, 0.35, 0.12, 0.75)],
 "after1": [(0.02, 0.32, 0.26, 0.58), (0.66, 0.15, 0.98, 0.60)],
 "before2": [(0.24, 0.08, 0.60, 0.33)],
 "after2":  [(0.02, 0.08, 0.28, 0.45)],
 "before4": [(0.15, 0.15, 0.62, 0.40)],
 "after4":  [(0.05, 0.08, 0.60, 0.45)],
 "before3": [(0.55, 0.25, 0.82, 0.45), (0.37, 0.25, 0.52, 0.48)],
 "after3": [(0.70, 0.35, 0.95, 0.50)],
 "before5": [(0.42, 0.25, 0.68, 0.45)],
 "after5": [(0.60, 0.15, 0.68, 0.38)],
 "before6": [(0.08, 0.32, 0.20, 0.48)],
 "after6": [(0.08, 0.32, 0.20, 0.48)],
 "before7a": [(0.90, 0.36, 0.98, 0.42)],
 "before7b": [(0.28, 0.15, 0.36, 0.18), (0.64, 0.14, 0.72, 0.18)],
 "after7a": [(0.12, 0.17, 0.30, 0.22), (0.75, 0.12, 0.88, 0.17)],
 "after7b": [],
 "after7c": [(0.20, 0.20, 0.35, 0.25), (0.62, 0.20, 0.80, 0.25)],
 "after7d": [],
 "before8": [(0.03, 0.10, 0.15, 0.45), (0.70, 0.10, 0.85, 0.40)],
 "after8":  [(0.03, 0.10, 0.15, 0.45), (0.70, 0.10, 0.85, 0.40)],
 "before9": [(0.70, 0.10, 0.95, 0.22)],
 "after9": [(0.70, 0.10, 0.95, 0.22)],
 "before10": [(0.57, 0.32, 0.68, 0.55)],
 "after10a": [(0.60, 0.20, 0.80, 0.45)],
 "after10b": [(0.55, 0.15, 0.80, 0.45)],
 "before11": [(0.45, 0.06, 0.62, 0.16)],
 "after11": [(0.38, 0.12, 0.55, 0.22)],
}

# Surfaces that did NOT change between a pair's photos (brick, floor, ceiling,
# furniture): they measure each photo's exposure and white balance, so the
# after photo can be compared with a prediction made from the before photo.
REFERENCE = {
 "before1": [(0.02, 0.80, 0.15, 0.90)], "after1": [(0.02, 0.88, 0.12, 0.97)],
 "before3": [(0.30, 0.68, 0.60, 0.72)], "after3": [(0.25, 0.75, 0.55, 0.80)],
 "before4": [(0.05, 0.62, 0.12, 0.70)], "after4": [(0.02, 0.62, 0.08, 0.70)],
 "before5": [(0.10, 0.01, 0.60, 0.08)], "after5": [(0.10, 0.01, 0.60, 0.08)],
 "before6": [(0.10, 0.86, 0.90, 0.98)], "after6": [(0.10, 0.86, 0.90, 0.98)],
 "before9": [(0.20, 0.60, 0.50, 0.70)], "after9": [(0.20, 0.60, 0.50, 0.70)],
 "before10": [(0.25, 0.517, 0.37, 0.545)], "after10a": [(0.215, 0.53, 0.355, 0.56)], "after10b": [(0.225, 0.51, 0.365, 0.545)],
 "before7a": [(0.44, 0.576, 0.62, 0.592)], "after7a": [(0.41, 0.520, 0.68, 0.54)],
 "before11": [(0.36, 0.55, 0.45, 0.575)], "after11": [(0.18, 0.587, 0.42, 0.608)],
}

# Mask growing (grow_masks.py): areas that are never wall (ceilings painted
# like the walls, furniture of a similar colour), and per-image tolerances.
EXCLUDE = {
 "before1": [(0.20, 0.00, 0.80, 0.21)], "after1": [(0.00, 0.00, 1.00, 0.12)],
 "before3": [(0.00, 0.00, 1.00, 0.20)], "before6": [(0.00, 0.00, 1.00, 0.06)],
 "after7a": [(0.00, 0.00, 1.00, 0.06)], "after7c": [(0.00, 0.00, 0.28, 0.32), (0.72, 0.00, 1.00, 0.32)],
 "before9": [(0.00, 0.00, 1.00, 0.08), (0.15, 0.38, 0.72, 1.00), (0.00, 0.66, 1.00, 1.00), (0.66, 0.42, 0.92, 0.75)],
 "after9":  [(0.00, 0.00, 1.00, 0.08), (0.15, 0.38, 0.72, 1.00), (0.00, 0.66, 1.00, 1.00), (0.66, 0.42, 0.92, 0.75)],
}
CHROMA_TOL = {"before9": 3.0, "after9": 3.0}
