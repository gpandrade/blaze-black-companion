#!/usr/bin/env python3
"""Integer box-downscale an 8-bit RGB/RGBA PNG using nothing but the stdlib.

There is no Pillow and no pip on this machine, and adding a system package to
shrink two screenshots is a worse trade than 80 lines. A PNG is zlib-compressed
filtered scanlines; zlib is in the stdlib, so the only real work is undoing the
five filter types and averaging NxN blocks.
"""
import struct, sys, zlib
from pathlib import Path

def chunks(d):
    i = 8
    while i < len(d):
        ln = struct.unpack('>I', d[i:i+4])[0]
        typ = d[i+4:i+8]
        yield typ, d[i+8:i+8+ln]
        i += 8 + ln + 4

def unfilter(raw, w, h, bpp):
    stride = w * bpp
    out = bytearray(stride * h)
    prev = bytearray(stride)
    pos = 0
    for y in range(h):
        ft = raw[pos]; pos += 1
        line = bytearray(raw[pos:pos+stride]); pos += stride
        if ft == 1:
            for x in range(bpp, stride): line[x] = (line[x] + line[x-bpp]) & 255
        elif ft == 2:
            for x in range(stride): line[x] = (line[x] + prev[x]) & 255
        elif ft == 3:
            for x in range(stride):
                a = line[x-bpp] if x >= bpp else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif ft == 4:
            for x in range(stride):
                a = line[x-bpp] if x >= bpp else 0
                b = prev[x]
                c = prev[x-bpp] if x >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p-a), abs(p-b), abs(p-c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        elif ft != 0:
            raise SystemExit(f"unsupported filter {ft}")
        out[y*stride:(y+1)*stride] = line
        prev = line
    return out, stride

def shrink(src, dst, factor=2):
    d = Path(src).read_bytes()
    assert d[:8] == b'\x89PNG\r\n\x1a\n'
    idat = b''
    for typ, body in chunks(d):
        if typ == b'IHDR':
            w, h, bd, ct, comp, filt, il = struct.unpack('>IIBBBBB', body)
        elif typ == b'IDAT':
            idat += body
    if bd != 8 or ct not in (2, 6) or il:
        raise SystemExit(f"{src}: need 8-bit RGB/RGBA non-interlaced, got bd={bd} ct={ct} il={il}")
    bpp = 4 if ct == 6 else 3
    px, stride = unfilter(zlib.decompress(idat), w, h, bpp)

    nw, nh = w // factor, h // factor
    f2 = factor * factor
    out = bytearray()
    for y in range(nh):
        out.append(0)                       # filter type None
        rows = [y*factor + k for k in range(factor)]
        base = [r*stride for r in rows]
        row = bytearray(nw * bpp)
        for x in range(nw):
            xo = x * factor * bpp
            for c in range(bpp):
                t = 0
                for b0 in base:
                    o = b0 + xo + c
                    for k in range(factor):
                        t += px[o + k*bpp]
                row[x*bpp + c] = t // f2
        out += row

    def chunk(typ, body):
        return (struct.pack('>I', len(body)) + typ + body
                + struct.pack('>I', zlib.crc32(typ + body) & 0xFFFFFFFF))
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', nw, nh, 8, ct, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(bytes(out), 9))
           + chunk(b'IEND', b''))
    Path(dst).write_bytes(png)
    return w, h, nw, nh, len(d), len(png)

if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    fac = int(sys.argv[3]) if len(sys.argv) > 3 else 2
    w, h, nw, nh, a, b = shrink(src, dst, fac)
    print(f"  {Path(src).name:<26} {w}x{h} -> {nw}x{nh}   {a//1024} KB -> {b//1024} KB")
