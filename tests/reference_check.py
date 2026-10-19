"""
reference_check.py - checks the colour science in js/paintPipeline.js and
glsl/shaderSceneRender.glsl against official CIE data. The numbers it prints
are quoted in README.md ("Verification") and in the code comments.

Data (fetch once into a folder of your choice, e.g. /tmp/cie):
  curl -o /tmp/cie/ciexyz31_1.csv http://www.cvrl.org/database/data/cmfs/ciexyz31_1.csv
  curl -o /tmp/cie/d_series.py https://raw.githubusercontent.com/colour-science/colour/develop/colour/colorimetry/datasets/illuminants/sds_d_illuminant_series.py
  curl -o /tmp/cie/illum_sds.py https://raw.githubusercontent.com/colour-science/colour/develop/colour/colorimetry/datasets/illuminants/sds.py
(the two .py files are only read as text for their CIE tables; nothing is executed)

Run:  python3 -I tests/reference_check.py /tmp/cie
Pure Python 3, no packages.
"""
import csv, json, math, re, sys

DATA = sys.argv[1] if len(sys.argv) > 1 else "/tmp/cie"

# ---- CIE data ----------------------------------------------------------------
CMF = {int(r[0]): [float(v) for v in r[1:4]] for r in csv.reader(open(f"{DATA}/ciexyz31_1.csv"))}
def _block(text, key):
    i = text.index(key); j = text.index("}", i)
    return {float(a): float(b) for a, b in re.findall(r"([\d.]+)\s*:\s*([-\d.eE]+)", text[i:j])}
_ds = open(f"{DATA}/d_series.py").read()
S = {k: _block(_ds, f'"{k}": {{') for k in ("S0", "S1", "S2")}
D65 = _block(open(f"{DATA}/illum_sds.py").read(), '"D65": {')
def interp(tab, l):
    if l in tab: return tab[l]
    ks = sorted(tab); lo = max(k for k in ks if k <= l); hi = min(k for k in ks if k >= l)
    return tab[lo] + (tab[hi]-tab[lo]) * (l-lo)/(hi-lo) if hi != lo else tab[lo]

# ---- the JS code, ported --------------------------------------------------
def wyman(l):
    g = lambda mu, s1, s2: math.exp(-0.5*((l-mu)/(s1 if l < mu else s2))**2)
    return [1.056*g(599.8,37.9,31.0)+0.362*g(442.0,16.0,26.7)-0.065*g(501.1,20.4,26.2),
            0.821*g(568.8,46.9,40.5)+0.286*g(530.9,16.3,31.1),
            1.217*g(437.0,11.8,36.0)+0.681*g(459.0,26.0,13.8)]
def planck(l, T): lu = l/1000; return 1/(lu**5*(math.exp(14387.77/(lu*T))-1))
def mccamy(x, y): n = (x-0.3320)/(0.1858-y); return ((449*n+3525)*n+6823.3)*n+5520.33
XYZ2RGB = [[3.2404542,-1.5371385,-0.4985314],[-0.9692660,1.8760108,0.0415560],[0.0556434,-0.2040259,1.0572252]]
RGB2XYZ = [[0.4124564,0.3575761,0.1804375],[0.2126729,0.7151522,0.0721750],[0.0193339,0.1191920,0.9503041]]
mv = lambda M, v: [sum(M[i][k]*v[k] for k in range(3)) for i in range(3)]
def oklab(r,g,b):
    l=(0.4122214708*r+0.5363325363*g+0.0514459929*b)**(1/3); m=(0.2119034982*r+0.6806995451*g+0.1073969566*b)**(1/3); s=(0.0883024619*r+0.2817188376*g+0.6299787005*b)**(1/3)
    return [0.2104542553*l+0.7936177850*m-0.0040720468*s, 1.9779984951*l-2.4285922050*m+0.4505937099*s, 0.0259040371*l+0.7827717662*m-0.8086757660*s]
dec = lambda c: c/12.92 if c <= 0.04045 else ((c+0.055)/1.055)**2.4
hexlin = lambda h: [dec(int(h[i:i+2],16)/255) for i in (1,3,5)]

def integrate(spd, refl, lams, cmf):
    X=Y=Z=Yw=0
    for l in lams:
        p = spd(l); r = refl(l) if refl else 1; c = cmf(l)
        X += p*r*c[0]; Y += p*r*c[1]; Z += p*r*c[2]; Yw += p*c[1]
    return [X/Yw, Y/Yw, Z/Yw]
L20 = list(range(380, 721, 20)); L1 = list(range(360, 781))
cie = lambda l: CMF[int(l)]
def xy(XYZ): s = sum(XYZ); return XYZ[0]/s, XYZ[1]/s
def daylight(T):  # CIE D-series SPD at CCT T (CIE 15:2018)
    if T <= 7000: x = -4.6070e9/T**3+2.9678e6/T**2+0.09911e3/T+0.244063
    else:         x = -2.0064e9/T**3+1.9018e6/T**2+0.24748e3/T+0.237040
    y = -3.000*x*x+2.870*x-0.275
    M = 0.0241+0.2562*x-0.7341*y
    M1 = (-1.3515-1.7703*x+5.9114*y)/M; M2 = (0.0300-31.4424*x+30.0717*y)/M
    return lambda l: interp(S["S0"],l)+M1*interp(S["S1"],l)+M2*interp(S["S2"],l)

print("== A. Wyman et al. CMF fit vs the CIE 1931 table")
worst = [0,0,0]
for l in range(380, 781):
    w, c = wyman(l), CMF[l]
    for i in range(3): worst[i] = max(worst[i], abs(w[i]-c[i]))
print("   max |error| (x,y,z):", [round(v,4) for v in worst], " peaks ~(1.06, 1.0, 1.78)")
for name, spd in [("D65", lambda l: interp(D65,l)), ("Planck 2700K", lambda l: planck(l,2700))]:
    a = xy(integrate(spd, None, L1, cie)); b = xy(integrate(spd, None, L20, wyman)); c = xy(integrate(spd, None, L20, cie))
    print(f"   {name} xy: CIE 1nm {a[0]:.4f},{a[1]:.4f} | Wyman 20nm {b[0]:.4f},{b[1]:.4f} | CIE 20nm {c[0]:.4f},{c[1]:.4f}")

print("== B. McCamy CCT vs exact blackbody temperature (CIE 1nm)")
for T in [1500, 1800, 2000, 2400, 2700, 3500, 5000, 6500, 10000, 15000, 25000]:
    x, y = xy(integrate(lambda l: planck(l,T), None, L1, cie))
    print(f"   {T:>6} K -> McCamy {mccamy(x,y):8.0f} K ({(mccamy(x,y)/T-1)*100:+.1f} %)")

print("== C. Daylight (CIE D series) vs blackbody at the same CCT: chromaticity gap (Duv-ish, uv distance)")
uv = lambda x,y: (4*x/(-2*x+12*y+3), 6*y/(-2*x+12*y+3))
for T in [4000, 5000, 6504, 8000, 10000, 15000]:
    a = uv(*xy(integrate(daylight(T), None, L1, cie))); b = uv(*xy(integrate(lambda l: planck(l,T), None, L1, cie)))
    print(f"   {T:>6} K: |uv(daylight) - uv(blackbody)| = {math.dist(a,b):.4f}  (JND ~0.001-0.002)")
x, y = xy(integrate(lambda l: interp(D65,l), None, L1, cie)); print(f"   D65 table xy = {x:.4f}, {y:.4f} (standard 0.3127, 0.3290)")
x, y = xy(integrate(daylight(6504), None, L1, cie)); print(f"   D-series formula at 6504 K xy = {x:.4f}, {y:.4f}")

print("== D. Oklab reference value: sRGB red -> (0.62796, 0.22486, 0.12585)")
print("  ", [round(v,5) for v in oklab(1,0,0)])
print("== E. Paint under light: v3 maths vs gold standard (CIE 1nm, fit under D65, true SPD)")
def solve3(J, r):
    a,b,c,d,e,f,g,h,i = J[0][0],J[0][1],J[0][2],J[1][0],J[1][1],J[1][2],J[2][0],J[2][1],J[2][2]
    A=e*i-f*h; B=-(d*i-f*g); Cc=d*h-e*g; det=a*A+b*B+c*Cc
    inv=[[A,-(b*i-c*h),b*f-c*e],[B,a*i-c*g,-(a*f-c*d)],[Cc,-(a*h-b*g),a*e-b*d]]
    return [sum(inv[k][m]*r[m] for m in range(3))/det for k in range(3)]
def sig(c, l): t=(l-550)/170; x=(c[0]*t+c[1])*t+c[2]; return 0.5+x/(2*math.sqrt(1+x*x))
def fit(target, rgb_of):
    t=[min(.999,max(.001,v)) for v in target]; y=0.2126729*t[0]+0.7151522*t[1]+0.072175*t[2]
    c=[0,0,(2*y-1)/(2*math.sqrt(y*(1-y)))]
    res=lambda cc:[a-b for a,b in zip(rgb_of(lambda l: sig(cc,l)), t)]
    for _ in range(80):
        r=res(c)
        if math.hypot(*r)<1e-9: break
        cols=[]
        for k in range(3):
            d=c[:]; d[k]+=1e-6; cols.append([(a-b)/1e-6 for a,b in zip(res(d),r)])
        J=[[cols[k][i] for k in range(3)] for i in range(3)]
        s=[-v for v in solve3(J,r)]; n=math.hypot(*s)
        if n>5: s=[v*5/n for v in s]
        c=[a+b for a,b in zip(c,s)]
    return c
lum=lambda v:0.2126729*v[0]+0.7151522*v[1]+0.072175*v[2]
# --- gold
d65=lambda l: interp(D65,l)
def rgb_gold(spd, refl): return mv(XYZ2RGB, integrate(spd, refl, L1, cie))
gold_white = mv(XYZ2RGB, integrate(d65, None, L1, cie))          # ~ (1,1,1)
def gold_paint_rgb(target):   # fit so that under D65 the paint is `target` (relative to D65 white = 1)
    return fit(target, lambda R: [a/b for a,b in zip(rgb_gold(d65, R), gold_white)])
# --- ours (as js/paintPipeline.js + RENDER v3)
TREF = mccamy(0.3127, 0.3290)
ref_white = mv(XYZ2RGB, integrate(lambda l: planck(l,TREF), None, L20, wyman)); WN=[1/v for v in ref_white]
ours_rgb_ref = lambda R: [w*v for w,v in zip(WN, mv(XYZ2RGB, integrate(lambda l: planck(l,TREF), R, L20, wyman)))]
def ours(target, light_XYZ):
    c = fit(target, ours_rgb_ref); R = lambda l: sig(c,l)
    fitted = ours_rgb_ref(R); fix=[a/b for a,b in zip([min(.999,max(.001,v)) for v in target] if False else target, fitted)]
    x,y = light_XYZ[0]/sum(light_XYZ), light_XYZ[1]/sum(light_XYZ); T=min(25000,max(1667,mccamy(x,y)))
    planckN=[w*v for w,v in zip(WN, mv(XYZ2RGB, integrate(lambda l: planck(l,T), None, L20, wyman)))]
    paintN=[f*w*v for f,w,v in zip(fix, WN, mv(XYZ2RGB, integrate(lambda l: planck(l,T), R, L20, wyman)))]
    meas=[max(v,1e-4) for v in mv(XYZ2RGB,[x/y,1,(1-x-y)/y])]; bb=[max(v,1e-4) for v in planckN]
    tint=[(m/lum(meas))/(b/lum(bb)) for m,b in zip(meas,bb)]
    return [p*t for p,t in zip(paintN,tint)]
def dE(a,b): A=oklab(*[max(v,0) for v in a]); B=oklab(*[max(v,0) for v in b]); return 100*math.dist(A,B)
PAINTS=["#a4aca6","#cfdbde","#d0ba94","#dee0de","#2f3d4c","#58679d","#7a1f2b","#1f5f3a","#dda27a"]
LIGHTS=[("blackbody 2000K",lambda l:planck(l,2000)),("blackbody 2700K",lambda l:planck(l,2700)),("blackbody 3500K",lambda l:planck(l,3500)),
        ("daylight 5000K",daylight(5000)),("D65",d65),("daylight 10000K",daylight(10000))]
print(f"   {'light':18s} {'v3 vs gold':>12s} {'RGB multiply vs gold':>22s}   (Oklab dE x100; ~2 = just noticeable)")
gold_fits = {h: gold_paint_rgb(hexlin(h)) for h in PAINTS}
for name, spd in LIGHTS:
    lightXYZ = integrate(spd, None, L1, cie)
    meas = mv(XYZ2RGB, lightXYZ)
    e_ours=[]; e_mul=[]
    for h in PAINTS:
        g = rgb_gold(spd, lambda l, c=gold_fits[h]: sig(c,l))
        o = ours(hexlin(h), lightXYZ)
        m = [a*b for a,b in zip(hexlin(h), meas)]
        e_ours.append(dE(o,g)); e_mul.append(dE(m,g))
    print(f"   {name:18s} mean {sum(e_ours)/len(e_ours):4.2f} max {max(e_ours):4.2f}   mean {sum(e_mul)/len(e_mul):4.2f} max {max(e_mul):4.2f}")

print("== F. Navy at night: what actually turns it grey")
night = [0.377, 0.231, 0.148]   # mean wall light of the living-room night photo (LightStats)
XYZ = mv(RGB2XYZ, night); x, y = XYZ[0]/sum(XYZ), XYZ[1]/sum(XYZ)
print(f"   night light xy {x:.4f},{y:.4f} -> CCT {mccamy(x,y):.0f} K (v2 caps warm light at warmCCT = 2700 K)")
navy = hexlin("#2f3d4c"); L = [v/lum(night) for v in night]
mul = [a*b for a,b in zip(navy, L)]
enc = lambda v: [round(255*(12.92*c if c<=0.0031308 else 1.055*c**(1/2.4)-0.055)) for c in [min(1,max(0,u)) for u in v]]
print("   navy x night light, plain RGB multiply :", enc(mul), "(neutral grey: B/R =", round(mul[2]/mul[0],2), ")")
gold = rgb_gold(lambda l: planck(l, mccamy(x,y)), lambda l, c=gold_fits['#2f3d4c']: sig(c,l))
o = ours(navy, mv(RGB2XYZ, L))
print("   navy, v3 spectral (before adaptation)  :", enc(o), "  gold:", enc(gold))
v2light = [a/b for a,b in zip(mv(XYZ2RGB, integrate(lambda l: planck(l,2700), None, L1, cie)), mv(XYZ2RGB, integrate(lambda l: planck(l,6500), None, L1, cie)))]
v2light = [v/lum(v2light) for v in v2light]
print("   navy x v2's capped 2700 K light        :", enc([a*b for a,b in zip(navy, v2light)]))

print("== G. v3 vs gold for very blue skylight (where McCamy is off by 7-22 %)")
for T in [15000, 20000, 25000]:
    spd = daylight(T) if T <= 25000 else None
    lightXYZ = integrate(spd, None, L1, cie); x,y = xy(lightXYZ)
    e=[dE(ours(hexlin(h), lightXYZ), rgb_gold(spd, lambda l, c=gold_fits[h]: sig(c,l))) for h in PAINTS]
    print(f"   daylight {T} K (McCamy says {mccamy(x,y):.0f} K): mean {sum(e)/len(e):.2f} max {max(e):.2f}")

print("== H. Multiple bounces between painted walls: single-bounce RGB estimate (first v3) vs spectral multi-bounce (now used)")
f = 0.5
ref = lambda l: planck(l, TREF)
for h in PAINTS:
    c = gold_fits[h]; R = lambda l: sig(c,l)
    # light leaving a wall after the indirect light has bounced n times: rho * rho/(1 - f rho), per wavelength
    multi = [a/b for a,b in zip(mv(XYZ2RGB, integrate(ref, lambda l: R(l)*R(l)/(1-f*R(l)), L20, wyman)), mv(XYZ2RGB, integrate(ref, None, L20, wyman)))]
    multi = [v*(1-f) for v in multi]               # relative to white walls (rho = 1)
    a = hexlin(h); rho = lum(a); single = [v*(v/rho)*(rho/(1-f*rho))*(1-f) for v in a]
    print(f"   {h}: single-bounce {[round(v,4) for v in single]}  spectral multi-bounce {[round(v,4) for v in multi]}  dE x100 {dE(single,multi):.2f}")
