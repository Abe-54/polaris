"""Generate Polaris's pixel textures: night/dawn scenes, watercolour washes, dither halos.

Deterministic. Requires numpy and pillow:
    uv run --with numpy --with pillow design/scripts/gen_textures.py
Writes into design/assets/{scenes,washes,halos}. Each scene also gets a map (scene-*.json) of
what its ambient motion animates: stars, the sky line, the cabin's lamp, door gap and smoke.
"""
import numpy as np, random, math, json
from PIL import Image
import os
ASSETS=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','assets')
def OUTP(sub,name):
    d=os.path.join(ASSETS,sub); os.makedirs(d,exist_ok=True); return os.path.join(d,name)
def bayer(n):
    m=np.array([[0,2],[3,1]])
    while m.shape[0]<n:
        m=np.block([[4*m,4*m+2],[4*m+3,4*m+1]])
    return (m+0.5)/m.size
B8=bayer(8)
def hexc(h): h=h.lstrip('#'); return np.array([int(h[i:i+2],16) for i in (0,2,4)],float)
def quant(val,palette,xs,ys):
    # val in [0,1] maps across palette with ordered dither
    n=len(palette)-1
    v=np.clip(val,0,1)*n
    lo=np.floor(v).astype(int); fr=v-lo
    t=B8[ys%8,xs%8]
    idx=np.where(fr>t,np.minimum(lo+1,n),lo)
    P=np.array([hexc(c) for c in palette])
    return P[idx]
def up(img,s): return img.resize((img.width*s,img.height*s),Image.NEAREST)

rng=np.random.default_rng(7)
def noise2(w,h,scale,seed):
    r=np.random.default_rng(seed)
    gw,gh=w//scale+2,h//scale+2
    g=r.random((gh,gw))
    ys,xs=np.mgrid[0:h,0:w]
    fx=xs/scale; fy=ys/scale
    x0=fx.astype(int); y0=fy.astype(int); tx=fx-x0; ty=fy-y0
    tx=tx*tx*(3-2*tx); ty=ty*ty*(3-2*ty)
    a=g[y0,x0]; b=g[y0,x0+1]; c=g[y0+1,x0]; d=g[y0+1,x0+1]
    return (a*(1-tx)+b*tx)*(1-ty)+(c*(1-tx)+d*tx)*ty
def fbm(w,h,seed,scales=(24,12,6,3)):
    v=sum(noise2(w,h,s,seed+i)*(0.5**i) for i,s in enumerate(scales))
    return (v-v.min())/(v.max()-v.min())

def tohex(c): return '#%02X%02X%02X'%tuple(int(round(v)) for v in c)

def scene(w,h,sky,hills,star,night=True,seed=1,name='scene'):
    """Returns (image, ground, motion) where ground[x] is the top row of the nearest hill layer
    and motion maps what may animate: the stars (with the sky under each) and the sky line."""
    ys,xs=np.mgrid[0:h,0:w]
    grad=ys/(h*0.78)
    img=quant(grad+ (fbm(w,h,seed)-0.5)*0.12,sky,xs,ys)
    r=random.Random(seed)
    stars=[]
    # stars
    if night:
        for _ in range(int(w*h*0.004)):
            x=r.randrange(w); y=r.randrange(int(h*0.62))
            b=r.random()
            c=hexc('#E8EEFF') if b>0.85 else hexc('#8A96B8') if b>0.4 else hexc('#4A5578')
            stars.append((x,y,tohex(c),tohex(img[y,x])))
            img[y,x]=c
    # Polaris
    px,py=int(w*0.72),int(h*0.18)
    halo=np.exp(-(((xs-px)**2+(ys-py)**2)/(2*(h*0.07)**2)))
    hc=hexc(star)
    mask=halo*0.55>B8[ys%8,xs%8]
    img[mask]=img[mask]*0.55+hc*0.45
    for d in range(-4,5):
        a=1-abs(d)/5
        for (x,y) in ((px+d,py),(px,py+d)):
            img[y,x]=img[y,x]*(1-a)+np.array([245,248,255])*a
    for (x,y) in ((px-1,py-1),(px+1,py-1),(px-1,py+1),(px+1,py+1)): img[y,x]=img[y,x]*0.5+hc*0.5
    # hills
    skyline=np.full(w,h)
    for i,(col,base,amp,sd) in enumerate(hills):
        prof=base*h + amp*h*(noise2(w,1,40,sd+i)[0]-0.5) + amp*0.35*h*(noise2(w,1,9,sd+10+i)[0]-0.5)
        for x in range(w):
            top=int(prof[x])
            img[top:,x]=hexc(col)
            skyline[x]=min(skyline[x],top)
        # pines on the nearest two layers
        if i>=len(hills)-2:
            rr=random.Random(sd)
            for _ in range(w//14):
                x=rr.randrange(2,w-2); top=int(prof[x]); th=rr.randrange(5,11)
                for k in range(th):
                    half=max(0,(k*3)//th)
                    y=top-th+k
                    img[y,max(0,x-half):x+half+1]=hexc(col)
                    for xx in range(max(0,x-half),min(w,x+half+1)): skyline[xx]=min(skyline[xx],y)
    # a star survives where nothing (Polaris's halo, a hill) was drawn over it
    seen={}
    for x,y,c,under in stars:
        if tohex(img[y,x])==c: seen[(x,y)]=(x,y,c,under)
    motion={'width':w,'height':h,'polaris':[px,py],'stars':[list(v) for v in seen.values()],'skyline':[int(v) for v in skyline]}
    return img, prof.astype(int), motion

def save(img,name,s,sub):
    im=Image.fromarray(np.clip(img,0,255).astype('uint8'))
    up(im,s).save(OUTP(sub,name))

# The cabin: the one warm human touch. Drawn as a sprite and seated on the ground line.
CABIN = [
    "............S.....",
    ".............S....",
    "............S.....",
    "...........CC.....",
    ".......HH..CC.....",
    "......RRRH.CC.....",
    ".....RRRRRHCC.....",
    "....RRRRRRRHC.....",
    "...RRRRRRRRRH.....",
    "..RRRRRRRRRRRH....",
    ".RRRRRRRRRRRRRH...",
    "RRRRRRRRRRRRRRRH..",
    "..WWWWWWWWWWWWW...",
    "..WPPPPPPPPPPPW...",
    "..WMMMMMWWWDDDW...",
    "..WLLMLLPPPDDDW...",
    "..WLLMLLWWWDDdW...",
    "..WMMMMMPPPDDDW...",
    "..WLLMLLWWWDDDW...",
    "..WLLMLLPPPDDDW...",
    "..WMMMMMWWWDDDW...",
    ".FFFFFFFFFFFFFFF..",
]
CABIN_NIGHT = {
    "R": "#0A0E1A",  # roof
    "H": "#2C3860",  # roof edge lit by Polaris (light from the upper right)
    "C": "#1D2540",  # chimney
    "S": "#39425E",  # smoke
    "W": "#161C30",  # wall
    "P": "#11172A",  # plank shadow
    "M": "#2A2016",  # window frame
    "L": "#F2C27A",  # lamplight
    "D": "#0D1120",  # door
    "d": "#9C7A48",  # light through the door gap
    "F": "#1C2238",  # stone foundation
}
# The same cabin at dawn: warm timber, a paler roof, and the lamp still on.
CABIN_DAWN = {
    "R": "#7E5646",  # roof
    "H": "#B98468",  # roof edge catching the low sun
    "C": "#8A7A72",  # chimney
    "S": "#F4F1F6",  # smoke
    "W": "#A9825F",  # wall
    "P": "#93704F",  # plank shadow
    "M": "#5E4434",  # window frame
    "L": "#F2C27A",  # lamplight
    "D": "#5E4434",  # door
    "d": "#E0A860",  # light through the door gap
    "F": "#8C8781",  # stone foundation
}

def place_cabin(img, ground, x0, x1, colours):
    cw, ch = len(CABIN[0]), len(CABIN)
    # seat on the flattest stretch of ground in [x0, x1)
    best = min(range(x0, x1 - cw), key=lambda x: np.ptp(ground[x:x + cw]))
    base = int(ground[best:best + cw].max())  # lowest ground point, so no corner floats
    top = base - ch + 1
    cells = {"L": [], "d": [], "S": [], "C": []}
    for j, row in enumerate(CABIN):
        for i, ch_ in enumerate(row):
            if ch_ != ".":
                img[top + j, best + i] = hexc(colours[ch_])
                if ch_ in cells: cells[ch_].append([best + i, top + j])
    # fill any gap between the foundation and higher ground
    img[base + 1:base + 2, best + 1:best + cw - 2] = hexc(colours["F"])
    return {
        "lamp": cells["L"], "lampColor": colours["L"],
        "door": cells["d"], "doorColor": colours["d"],
        "smoke": cells["S"], "smokeColor": colours["S"],
        "chimney": min(cells["C"], key=lambda c: c[1]),
    }

def save_motion(motion, cabin, name, extra):
    with open(OUTP('scenes', name), 'w') as f:
        json.dump({**motion, 'cabin': cabin, **extra}, f, separators=(',', ':'))
        f.write('\n')

# pixel watercolour washes (tile textures)
def wash(hue,ground,name,w=40,h=40,seed=3,strength=(0.10,0.42)):
    ys,xs=np.mgrid[0:h,0:w]
    v=fbm(w,h,seed,(12,6,3))
    v=0.35*v+0.65*(1-np.sqrt(((xs/w)**2+(ys/h)**2)/2))  # heavier top-left, like the refs
    g=hexc(ground); c=hexc(hue)
    lo,hi=strength
    steps=[g*(1-a)+c*a for a in np.linspace(lo,hi,5)]
    pal=['#%02x%02x%02x'%tuple(int(t) for t in s) for s in steps]
    img=quant(v,pal,xs,ys)
    save(img,name,4,'washes')
# dithered halo (alpha) behind composer
def halo(hue,name,w=200,h=90,cell=1,peak=0.5):
    ys,xs=np.mgrid[0:h,0:w]
    d=np.sqrt(((xs-w/2)/(w/2))**2+((ys-h/2)/(h/2))**2)
    v=np.clip(1-d,0,1)**1.6*peak
    on=v>B8[ys%8,xs%8]
    rgba=np.zeros((h,w,4),np.uint8)
    rgba[...,:3]=hexc(hue); rgba[...,3]=np.where(on,90,0)
    up(Image.fromarray(rgba,'RGBA'),4).save(OUTP('halos',name))

def main():
    W,H=360,225
    night=scene(W,H,['#070912','#0A0D1A','#0E1325','#141B33','#1C2542','#27304F'],
        [('#141A2C',0.70,0.18,3),('#10152A',0.78,0.14,5),('#0B0F1E',0.86,0.10,9)],'#BCD3FF',True,11)

    night, night_ground, night_motion = night
    night_cabin = place_cabin(night, night_ground, int(W * 0.14), int(W * 0.34), CABIN_NIGHT)
    save(night,'scene-night.png',4,'scenes')
    # A meteor is the star palette: a white head and a tail that cools into the sky.
    save_motion(night_motion, night_cabin, 'scene-night.json', {'kind': 'night', 'meteor': ['#E8EEFF', '#BCD3FF', '#8A96B8', '#4A5578']})
    dawn,dawn_ground,dawn_motion=scene(W,H,['#C9D8F2','#D8E1F4','#E9E6F0','#F6E4DA','#FBE3CC','#FCE9D2'],
        [('#B7C9A8',0.70,0.18,3),('#9DB78F',0.78,0.14,5),('#7FA074',0.86,0.10,9)],'#FFFFFF',False,12)
    # meadow flowers
    r=random.Random(4)
    for _ in range(260):
        x=r.randrange(W); y=r.randrange(int(H*0.88),H)
        dawn[y,x]=hexc(r.choice(['#F4D35E','#FFFFFF','#F2B5C4']))
    dawn_cabin = place_cabin(dawn, dawn_ground, int(W * 0.14), int(W * 0.34), CABIN_DAWN)
    save(dawn,'scene-dawn.png',4,'scenes')
    # Birds at dawn are distant silhouettes in the cabin's roof brown.
    save_motion(dawn_motion, dawn_cabin, 'scene-dawn.json', {'kind': 'dawn', 'bird': CABIN_DAWN['R']})

    for seed,(hue,n) in enumerate([('#D97757','claude'),('#6FCBA0','codex'),('#9DBAF5','starlight'),('#F2C84B','needs'),('#E59AC1','opencode')]):
        wash(hue,'#222327',f'wash-{n}-dark.png',seed=20+seed,strength=(0.16,0.62))
        wash(hue,'#FFFFFF',f'wash-{n}-light.png',seed=20+seed,strength=(0.08,0.40))
    # wide wash for toast/banner
    wash('#6FCBA0','#222327','wash-codex-dark-wide.png',w=90,h=24,seed=5,strength=(0.05,0.30))
    wash('#D97757','#FFFFFF','wash-claude-light-wide.png',w=90,h=24,seed=6,strength=(0.06,0.34))

    # one per identity hue and theme; light halos use the -light hue on bg-light
    for n,dark,light in (('claude','#D97757','#C4562F'),('codex','#6FCBA0','#1E8A5C'),('opencode','#E59AC1','#B8466A')):
        halo(dark,f'halo-{n}.png')
        halo(light,f'halo-{n}-light.png')
    halo('#BCD3FF','halo-starlight.png',peak=0.6)
    halo('#4F82E8','halo-starlight-light.png',peak=0.6)
    print('done')


if __name__ == "__main__":
    main()
