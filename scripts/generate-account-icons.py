from pathlib import Path
import math,struct,zlib
Path('icons/fund-account.svg').write_text('''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="8" y="8" width="112" height="112" rx="24" fill="#a31f34"/><path d="M37 29H87V94H37Z" fill="white"/><path d="M37 29H46V94H37Z" fill="#f1c6cf"/><path d="M54 44H77M54 58H77M54 72H68" stroke="#a31f34" stroke-width="6" stroke-linecap="round"/><circle cx="93" cy="93" r="24" fill="#087e8b"/><path d="M80 93L89 102L107 83" fill="none" stroke="white" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>''',encoding='utf-8')
def segment(x,y,x1,y1,x2,y2,r):
    t=max(0,min(1,((x-x1)*(x2-x1)+(y-y1)*(y2-y1))/((x2-x1)**2+(y2-y1)**2)))
    return (x-x1-t*(x2-x1))**2+(y-y1-t*(y2-y1))**2<=r*r
def pixel(x,y):
    c=(0,0,0,0)
    if 8<=x<=120 and 8<=y<=120 and (x-min(96,max(32,x)))**2+(y-min(96,max(32,y)))**2<=24**2:c=(163,31,52,255)
    if 37<=x<=87 and 29<=y<=94:c=(255,255,255,255)
    if 37<=x<=46 and 29<=y<=94:c=(241,198,207,255)
    if any(segment(x,y,54,a,b,a,3) for a,b in [(44,77),(58,77),(72,68)]):c=(163,31,52,255)
    if (x-93)**2+(y-93)**2<=24**2:c=(8,126,139,255)
    if segment(x,y,80,93,89,102,3.5) or segment(x,y,89,102,107,83,3.5):c=(255,255,255,255)
    return c
def chunk(t,b):return struct.pack('>I',len(b))+t+b+struct.pack('>I',zlib.crc32(t+b)&0xffffffff)
for n in [16,32,80,128]:
    raw=bytearray()
    for j in range(n):
        raw.append(0)
        for i in range(n):
            points=[pixel((i+(sx+.5)/4)*128/n,(j+(sy+.5)/4)*128/n) for sy in range(4) for sx in range(4)]
            alpha=sum(p[3] for p in points)
            rgb=[round(sum(p[k]*p[3] for p in points)/alpha) if alpha else 0 for k in range(3)]
            raw.extend(rgb+[round(alpha/16)])
    data=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',n,n,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(bytes(raw)))+chunk(b'IEND',b'')
    Path(f'icons/fund-account-{n}.png').write_bytes(data)
print('Created custom ledger/checkmark icons at 16, 32, 80 and 128 pixels.')
