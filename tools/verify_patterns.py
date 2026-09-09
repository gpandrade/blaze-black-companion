#!/usr/bin/env python3
"""
verify_patterns.py -- the wagara tiles actually tile, and every one is used.

    python3 tools/verify_patterns.py
    python3 tools/verify_patterns.py --png out.png    # also write a contact sheet

=============================================================================
WHY THIS EXISTS
=============================================================================
A pattern tile is a data-URI SVG several kilobytes long. Every failure it can
have is invisible in the source and invisible in a single tile -- you only see
it once the browser repeats it, and then only if you are looking at a big
enough patch of it. Two failures matter:

  A SEAM. A motif whose centre sits outside the tile still draws into it, and
  an SVG cannot wrap. Miss one of those neighbouring copies and every tile
  edge in the page grows a hairline of missing strokes. At 5% opacity that
  reads as "the texture looks a bit stripey", which nobody would file as a
  bug and nobody could find.

  A DEAD TOKEN. The generator emits --pat-<name>; theme.css has to name it.
  A pattern that is generated and never referenced is 4KB of CSS doing
  nothing, and a .wg-<name> class naming a pattern that no longer exists is a
  dropped declaration and an unstyled element.

The seam check rasterises the SAME segment list the SVG is built from -- not
a re-parse of the SVG -- because a checker that re-implemented the geometry
would be testing its own opinion of it. Drawn twice:

  WRAPPED    one tile, every point taken modulo the tile size
  EXTENDED   a 2x2 area, every motif drawn at its true position

If the geometry is periodic those are the same picture. If a neighbour copy is
missing, the extended render has ink where the wrapped one is blank.

The rasteriser is a dozen lines because it only has to answer "is there ink
here": points along each segment, nearest pixel, no anti-aliasing, no width.
"""
import math
import os
import sys
import zlib
import struct

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_patterns as MP                                  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
failed = 0


def ok(label, cond, detail=''):
    global failed
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"  -- {detail}" if detail else ''))
    if not cond:
        failed += 1


# ------------------------------------------------------------- rasteriser
def draw(segs, w, h, scale=2, wrap=True, ox=0.0, oy=0.0):
    """Ink mask of the segments over a w x h box, `scale` samples per CSS px."""
    W, H = int(round(w * scale)), int(round(h * scale))
    buf = bytearray(W * H)
    for s in segs:
        for x, y in MP.flatten(s, step=0.30 / scale):
            px, py = int((x - ox) * scale), int((y - oy) * scale)
            if wrap:
                px, py = px % W, py % H
            elif not (0 <= px < W and 0 <= py < H):
                continue
            buf[py * W + px] = 1
    return buf, W, H


def tile_2x2(buf, W, H):
    out = bytearray(W * 2 * H * 2)
    for y in range(H * 2):
        row = (y % H) * W
        for x in range(W * 2):
            out[y * W * 2 + x] = buf[row + (x % W)]
    return out


def dilate(buf, W, H):
    """Grow the ink by one sample, so the comparison tolerates rounding."""
    out = bytearray(buf)
    for y in range(H):
        for x in range(W):
            if not buf[y * W + x]:
                continue
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < W and 0 <= ny < H:
                        out[ny * W + nx] = 1
    return out


# ------------------------------------------------------------------- png
def write_png(path, rows_rgb, W, H):
    raw = bytearray()
    for y in range(H):
        raw.append(0)
        raw.extend(rows_rgb[y * W * 3:(y + 1) * W * 3])

    def chunk(tag, body):
        return (struct.pack('>I', len(body)) + tag + body
                + struct.pack('>I', zlib.crc32(tag + body) & 0xFFFFFFFF))
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
           + chunk(b'IEND', b''))
    open(path, 'wb').write(png)


def contact_sheet(path, scale=2, cols=2, patch=250):
    """
    Every pattern tiled into a patch, laid out in a grid, ink on paper.

    Not a test -- a way to LOOK at them, since the one thing a seam check
    cannot tell you is whether the thing is any good.
    """
    names = list(MP.TUNED)
    rows = (len(names) + cols - 1) // cols
    pad, label = 10, 16
    cw, ch = patch + pad, patch + pad + label
    W, H = cols * cw + pad, rows * ch + pad
    img = bytearray([0xF2] * (W * H * 3))

    for i, name in enumerate(names):
        segs, (w, h), _ = MP.build(name)
        buf, TW, TH = draw(segs, w, h, scale=scale, wrap=True)
        buf = dilate(buf, TW, TH)
        gx, gy = (i % cols) * cw + pad, (i // cols) * ch + pad + label
        for y in range(patch):
            for x in range(patch):
                if buf[(y % TH) * TW + (x % TW)]:
                    p = ((gy + y) * W + gx + x) * 3
                    img[p] = 0x18
                    img[p + 1] = 0x24
                    img[p + 2] = 0x32
        # A 3px rule under the label, so the eye can find the tile boundary.
        for x in range(patch):
            p = ((gy - 5) * W + gx + x) * 3
            img[p] = img[p + 1] = img[p + 2] = 0xB0
        # Mark one tile's extent with corner ticks -- the seam is what matters.
        for t in range(min(10, TW)):
            for yy in (0, TH - 1) if TH < patch else (0,):
                p = ((gy + yy) * W + gx + t) * 3
                img[p], img[p + 1], img[p + 2] = 0xC8, 0x40, 0x10
        for t in range(min(10, TH)):
            p = ((gy + t) * W + gx) * 3
            img[p], img[p + 1], img[p + 2] = 0xC8, 0x40, 0x10
    write_png(path, img, W, H)
    return path, W, H


# ============================================================== the checks
print('── wagara: every tile repeats without a seam')
for name in MP.TUNED:
    shipped, (w, h), _ = MP.build(name)
    # THE REFERENCE IS BUILT HERE, NOT ASKED FOR.
    #
    # An earlier version of this check rendered MP.build(name) both ways and
    # compared them. That is not a test: any segment list is self-consistently
    # periodic once you tile it, so a tile missing half its motifs passed
    # cleanly. Two mutants -- culling with a negative margin, and tiling a
    # single cell instead of nine -- both went green, which is how it was
    # caught.
    #
    # So the reference is the generator's ONE CELL, laid out over a lattice
    # wide enough to cover the 2x2 area, with no culling. That is what the
    # pattern is supposed to be, and it is computed independently of whatever
    # build() decided to emit.
    motif, _, _ = MP.cell(name)
    ideal = MP.lattice(motif, [(i * w, j * h) for i in range(-2, 4) for j in range(-2, 4)])
    reference, EW, EH = draw(ideal, w * 2, h * 2, wrap=False)
    wrapped, TW, TH = draw(shipped, w, h, wrap=True)
    tiled = dilate(tile_2x2(wrapped, TW, TH), EW, EH)
    missing = sum(1 for i in range(EW * EH) if reference[i] and not tiled[i])
    total = sum(reference)
    ok(f'{name}: tiles seamlessly', missing == 0 and total > 0,
       f'{missing}/{total} ink samples of the pattern are missing from the tile'
       if missing else f'{total} ink samples')

print()
print('── wagara: every generated pattern is used, and every use exists')
css = open(os.path.join(ROOT, 'app/css/theme.css')).read()
generated = set(MP.TUNED)
# --pat-<name>: at the start of a declaration is the generator's own output;
# what matters is whether anything READS it with var().
used = set()
for name in generated:
    body = css.replace(f'--pat-{name}:', '').replace(f'--pat-{name}-size:', '')
    if f'var(--pat-{name})' in body:
        used.add(name)
ok('every pattern the generator emits is referenced in theme.css',
   generated == used, f'unused: {sorted(generated - used)}' if generated - used else
   f'{len(used)} patterns')

import re                                                    # noqa: E402
# --pat-ink is the pattern INK COLOUR, not a pattern; it is the one
# var(--pat-*) in the file that names no tile.
referenced = set(re.findall(r'var\(--pat-([a-z0-9]+)\)', css)) - {'ink'}
ok('...and every pattern theme.css names is generated',
   referenced <= generated, f'undefined: {sorted(referenced - generated)}')

# The tab motifs: one per tab, and no two tabs the same, or the ground stops
# telling you where you are.
print()
print('── wagara: one motif per tab')
motifs = dict(re.findall(r'\[data-tab="(\w+)"\][^{]*\{[^}]*--ground-pat:\s*var\(--pat-([a-z0-9]+)\)',
                         css))
TABS = ['adventure', 'battle', 'builder', 'factory', 'items', 'dex', 'run']
ok('every tab declares a ground motif', all(t in motifs for t in TABS),
   f'missing: {[t for t in TABS if t not in motifs]}')
ok('...and no two tabs share one', len(set(motifs.values())) == len(motifs),
   ' '.join(f'{k}={v}' for k, v in motifs.items()))
ok('...naming only patterns that exist', set(motifs.values()) <= generated,
   f'undefined: {sorted(set(motifs.values()) - generated)}')

# Each motif needs its size token too. A pattern set without its matching
# --pat-*-size renders at the previous tab's scale, which looks like a bug in
# the pattern rather than a missing line.
sized = dict(re.findall(r'\[data-tab="(\w+)"\][^{]*\{[^}]*--ground-size:\s*var\(--pat-([a-z0-9]+)-size\)',
                        css))
ok('...and each sets the matching --ground-size', sized == motifs,
   f'{sorted(set(motifs) ^ set(sized))}' if sized != motifs else f'{len(sized)} tabs')

if '--png' in sys.argv:
    out = sys.argv[sys.argv.index('--png') + 1]
    p, W, H = contact_sheet(out)
    print(f'\n  wrote {p} ({W}x{H})')

print(f"\n  {failed} check(s) FAILED" if failed else '\n  all checks passed')
sys.exit(1 if failed else 0)
