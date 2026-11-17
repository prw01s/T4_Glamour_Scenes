"""Shared colour maths for the pair measurements (sRGB D65, CIELAB, CIEDE2000, CAT16)."""
import numpy as np
def lin(c): c = np.asarray(c, float); return np.where(c <= 0.04045, c/12.92, ((c+0.055)/1.055)**2.4)
def enc(c): c = np.clip(np.asarray(c, float), 0, None); return np.where(c <= 0.0031308, 12.92*c, 1.055*c**(1/2.4)-0.055)
M = np.array([[0.4124564,0.3575761,0.1804375],[0.2126729,0.7151522,0.0721750],[0.0193339,0.1191920,0.9503041]])
WHITE = M @ np.ones(3)
CAT16 = np.array([[0.401288,0.650173,-0.051461],[-0.250268,1.204414,0.045854],[-0.002079,0.048952,0.953127]])
def lab(rgbl):
    xyz = (np.asarray(rgbl) @ M.T) / WHITE
    f = np.where(xyz > (6/29)**3, np.cbrt(np.maximum(xyz, 0)), xyz/(3*(6/29)**2) + 4/29)
    return np.stack([116*f[...,1]-16, 500*(f[...,0]-f[...,1]), 200*(f[...,1]-f[...,2])], -1)
def hexlin(h): h = h.lstrip('#'); return lin([int(h[i:i+2],16)/255 for i in (0,2,4)])
def de2000(l1, l2):
    L1,a1,b1 = l1; L2,a2,b2 = l2
    C1, C2 = np.hypot(a1,b1), np.hypot(a2,b2); Cb = (C1+C2)/2
    G = 0.5*(1-np.sqrt(Cb**7/(Cb**7+25**7))); a1p, a2p = (1+G)*a1, (1+G)*a2
    C1p, C2p = np.hypot(a1p,b1), np.hypot(a2p,b2)
    h1p, h2p = np.degrees(np.arctan2(b1,a1p))%360, np.degrees(np.arctan2(b2,a2p))%360
    dL, dC = L2-L1, C2p-C1p
    dh = h2p-h1p; dh = dh-360 if dh>180 else dh+360 if dh<-180 else dh
    if C1p*C2p == 0: dh = 0
    dH = 2*np.sqrt(C1p*C2p)*np.sin(np.radians(dh/2))
    Lb, Cbp = (L1+L2)/2, (C1p+C2p)/2
    hb = (h1p+h2p)/2 if abs(h1p-h2p) <= 180 else (h1p+h2p+360)/2 if h1p+h2p < 360 else (h1p+h2p-360)/2
    if C1p*C2p == 0: hb = h1p+h2p
    T = 1-0.17*np.cos(np.radians(hb-30))+0.24*np.cos(np.radians(2*hb))+0.32*np.cos(np.radians(3*hb+6))-0.20*np.cos(np.radians(4*hb-63))
    SL = 1+0.015*(Lb-50)**2/np.sqrt(20+(Lb-50)**2); SC = 1+0.045*Cbp; SH = 1+0.015*Cbp*T
    RT = -2*np.sqrt(Cbp**7/(Cbp**7+25**7))*np.sin(np.radians(60*np.exp(-((hb-275)/25)**2)))
    return float(np.sqrt((dL/SL)**2+(dC/SC)**2+(dH/SH)**2+RT*(dC/SC)*(dH/SH)))
