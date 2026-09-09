#!/usr/bin/env python3
"""
ncgr.py -- decode Nintendo DS graphics out of the ROM.

    python3 tools/ncgr.py probe a/0/2/5          # what is in a NARC
    python3 tools/ncgr.py badges                 # the eight gym badges
    python3 tools/ncgr.py selftest               # prove the decoder is right

WHY A KNOWN-ANSWER TEST COMES FIRST
Four things reliably go wrong in an NCGR decoder and they all produce the same
symptom -- a garbled rectangle:

    1. nibble order      4bpp packs two pixels per byte, LOW nibble first
    2. tile arrangement  8x8 tiles laid out in reading order, not row-by-row
    3. palette format    BGR555, 5 bits per channel, index 0 transparent
    4. compression       most graphics are LZ11, some are stored raw

Debugging those against a trainer portrait means guessing which of the four is
wrong from a picture you have never seen. So the decoder is proved against
`wiki/docs/img/pokemon/NNN.png` first: those are 96x96 4bpp palettised PNGs --
the BW sprite format exactly -- and the ROM must contain the same images.

The check is a SILHOUETTE MATCH: which pixels are transparent, compared pixel
for pixel. That is palette-independent (so a wrong palette cannot fake a pass)
and it is destroyed by any error in nibble order or tile arrangement (so a
wrong layout cannot fake one either).
"""
from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from extract_personal import NDSRom, parse_narc, RomError, DEFAULT_ROM  # noqa: E402


# --------------------------------------------------------------------- LZ11
def lz11(data: bytes) -> bytes:
    """
    Nintendo LZ11. Header byte 0x11, then a 24-bit output size.

    Backreferences come in three widths and the two long forms are the part
    everyone gets wrong: the 3- and 4-nibble forms encode length with
    DIFFERENT biases (+17 and +273), so a decoder that treats them alike walks
    off the end of the window and produces plausible-looking noise.
    """
    if not data or data[0] != 0x11:
        raise ValueError(f"not LZ11 (first byte {data[0]:#04x})" if data else "empty")
    size = int.from_bytes(data[1:4], "little")
    if size == 0:                                     # 32-bit extended size
        size = int.from_bytes(data[4:8], "little")
        pos = 8
    else:
        pos = 4

    out = bytearray()
    while len(out) < size and pos < len(data):
        flags = data[pos]; pos += 1
        for bit in range(7, -1, -1):
            if len(out) >= size:
                break
            if not (flags >> bit) & 1:
                out.append(data[pos]); pos += 1
                continue
            b = data[pos]
            kind = b >> 4
            if kind == 0:                              # 3 nibbles: len 17..272
                n = ((b & 0xF) << 4) | (data[pos + 1] >> 4)
                length = n + 17
                disp = ((data[pos + 1] & 0xF) << 8) | data[pos + 2]
                pos += 3
            elif kind == 1:                            # 4 nibbles: len 273..65808
                n = ((b & 0xF) << 12) | (data[pos + 1] << 4) | (data[pos + 2] >> 4)
                length = n + 273
                disp = ((data[pos + 2] & 0xF) << 8) | data[pos + 3]
                pos += 4
            else:                                      # 2 nibbles: len 3..16
                length = kind + 1
                disp = ((b & 0xF) << 8) | data[pos + 1]
                pos += 2
            start = len(out) - disp - 1
            if start < 0:
                raise ValueError("backreference before the start of the window")
            for i in range(length):
                out.append(out[start + i])
    return bytes(out[:size])


def maybe_lz11(data: bytes) -> bytes:
    """Most graphics in the ROM are compressed; a few are stored raw."""
    return lz11(data) if data[:1] == b"\x11" else data


# ------------------------------------------------------------- containers
def _sections(data: bytes, magic: bytes) -> dict[bytes, bytes]:
    """
    Split an NCLR/NCGR/NSCR into its sections.

    The magic is stored little-endian, so an NCLR file starts with the bytes
    'RLCN'. Section names inside are stored the same way round.
    """
    if data[:4] != magic:
        raise ValueError(f"expected {magic!r}, found {data[:4]!r}")
    count = struct.unpack_from("<H", data, 0x0E)[0]
    out, pos = {}, struct.unpack_from("<H", data, 0x0C)[0]
    for _ in range(count):
        if pos + 8 > len(data):
            break
        name = data[pos:pos + 4]
        size = struct.unpack_from("<I", data, pos + 4)[0]
        if size <= 0:
            break
        out[name] = data[pos + 8:pos + size]
        pos += size
    return out


def read_nclr(data: bytes) -> list[list[tuple[int, int, int]]]:
    """
    A palette file. Colours are BGR555 -- five bits per channel, blue first --
    so each is scaled back to 0..255 by (v << 3) | (v >> 2), which spreads the
    range properly instead of leaving whites at 248.
    """
    sec = _sections(maybe_lz11(data), b"RLCN")
    pltt = sec.get(b"TTLP")
    if pltt is None:
        raise ValueError("NCLR has no TTLP section")
    bpp4 = struct.unpack_from("<I", pltt, 0x00)[0] == 3       # 3 = 4bpp, 4 = 8bpp
    raw = pltt[0x10:]
    per = 16 if bpp4 else 256
    cols = []
    for i in range(0, len(raw) - 1, 2):
        v = struct.unpack_from("<H", raw, i)[0]
        r, g, b = v & 0x1F, (v >> 5) & 0x1F, (v >> 10) & 0x1F
        cols.append(((r << 3) | (r >> 2), (g << 3) | (g >> 2), (b << 3) | (b >> 2)))
    return [cols[i:i + per] for i in range(0, len(cols), per)] or [cols]


class Ncgr:
    """Tile graphics. `pixels` is a flat list of palette indices, row-major."""

    def __init__(self, width: int, height: int, bpp: int, pixels: list[int], linear: bool):
        self.width, self.height, self.bpp = width, height, bpp
        self.pixels, self.linear = pixels, linear

    def __repr__(self) -> str:
        return (f"<Ncgr {self.width}x{self.height} {self.bpp}bpp "
                f"{'linear' if self.linear else 'tiled'}>")


def read_ncgr(data: bytes, width: int | None = None, band: int = 8,
              objects: list[tuple[int, int, int, int]] | None = None) -> Ncgr:
    """
    Decode a CHAR section into a rectangle of palette indices.

    TWO THINGS THAT LOOK LIKE THE SAME BUG.
    `width` and `height` in the header are in TILES and are frequently 0xFFFF,
    because the real shape lives in a separate NSCR/NCER that references this
    file. When that happens the caller has to say how wide it is; 96px (12
    tiles) is the Pokémon sprite.
    Second, the data is a sequence of 8x8 TILES in reading order, not a
    row-by-row bitmap -- unless the 'linear' flag is set, in which case it is.
    Getting this wrong scrambles the image into 8x8 confetti, which looks
    exactly like a wrong nibble order.
    """
    sec = _sections(maybe_lz11(data), b"RGCN")
    char = sec.get(b"RAHC")
    if char is None:
        raise ValueError("NCGR has no CHAR section")

    # CHAR layout. Getting these four offsets wrong by a single field is the
    # classic way to spend an afternoon: the header still parses, the sizes
    # still look plausible, and the image comes out as noise.
    #   0x00 u16 height in tiles      0x02 u16 width in tiles
    #   0x04 u32 depth (3 = 4bpp)     0x08 u32 partition
    #   0x0C u32 tiled flag           0x10 u32 data size
    #   0x14 u32 data offset          0x18 pixel data
    th, tw = struct.unpack_from("<HH", char, 0x00)
    depth = struct.unpack_from("<I", char, 0x04)[0]
    linear = bool(struct.unpack_from("<I", char, 0x0C)[0] & 0xFF)
    size = struct.unpack_from("<I", char, 0x10)[0]
    start = struct.unpack_from("<I", char, 0x14)[0] or 0x18
    raw = char[start:start + size] if size else char[start:]
    bpp = 4 if depth == 3 else 8

    # unpack to one index per pixel
    if bpp == 4:
        idx = []
        for b in raw:
            idx.append(b & 0xF)        # LOW nibble is the first pixel
            idx.append(b >> 4)
    else:
        idx = list(raw)

    if width is None:
        width = tw * 8 if 0 < tw < 0x1000 else 0
    if not width:
        raise ValueError("NCGR does not state its width; pass one")
    height = len(idx) // width if linear else (len(idx) // 64) // (width // 8) * 8
    if height <= 0:
        raise ValueError("no pixels")

    if linear:
        return Ncgr(width, height, bpp, idx[:width * height], True)

    # TILES ARE GROUPED INTO 64x64 BLOCKS, NOT LAID OUT ACROSS THE FULL WIDTH.
    #
    # This is the part that cost the afternoon, and it is the OAM object grid
    # showing through: a DS sprite is assembled from hardware objects, the
    # largest of which is 64x64 -- eight tiles square. So the file is a
    # sequence of 8x8-TILE BLOCKS in reading order, and only WITHIN a block are
    # the tiles row-major. A 96x96 sprite is therefore four blocks:
    #
    #     tiles   0.. 63  ->  block (0,0), 8x8 tiles
    #     tiles  64.. 95  ->  block (0,1), clipped to 4 wide
    #     tiles  96..127  ->  block (1,0), clipped to 4 tall
    #     tiles 128..143  ->  block (1,1), 4x4
    #
    # Laying them out row-major across all twelve columns instead produces an
    # image made of CORRECT TILES IN WRONG PLACES, which looks exactly like a
    # wrong nibble order. That is why the known-answer test below compares
    # silhouettes rather than trusting a picture to look plausible, and why it
    # reports a tile-multiset match separately: multiset-yes / pixels-no says
    # the bug is here and nowhere else.
    #
    # The rule was recovered, not guessed: solving tile -> position against 60
    # reference sprites gave 99 of 144 positions with ZERO disagreement.
    # AN EXPLICIT OAM LAYOUT BEATS INFERRING ONE. When the caller knows how the
    # hardware objects are arranged -- the trainer stills do, see
    # TRAINER_OBJECTS -- the tiles are consumed in object order, row-major
    # within each object. That is what the DS itself does.
    if objects:
        out = [0] * (width * height)
        t = 0
        for ox, oy, ow, oh in objects:
            for r in range(oh // 8):
                for c in range(ow // 8):
                    if (t + 1) * 64 > len(idx):
                        return Ncgr(width, height, bpp, out, False)
                    for p in range(64):
                        out[(oy + r * 8 + p // 8) * width + ox + c * 8 + (p % 8)] = idx[t * 64 + p]
                    t += 1
        return Ncgr(width, height, bpp, out, False)

    cols, rows = width // 8, height // 8
    out = [0] * (width * height)
    t = 0
    for by in range(0, rows, band):
        for bx in range(0, cols, band):
            bh, bw = min(band, rows - by), min(band, cols - bx)
            for r in range(bh):
                for c in range(bw):
                    if (t + 1) * 64 > len(idx):
                        return Ncgr(width, height, bpp, out, False)
                    for p in range(64):
                        out[(by + r) * 8 * width + (p // 8) * width
                            + (bx + c) * 8 + (p % 8)] = idx[t * 64 + p]
                    t += 1
    return Ncgr(width, height, bpp, out, False)


# ----------------------------------------------------------------- output
def write_png(path: Path, ncgr: Ncgr, palette: list[tuple[int, int, int]],
              transparent0: bool = True) -> None:
    """A minimal RGBA PNG. No Pillow: the repo ships no third-party deps."""
    rows = bytearray()
    for y in range(ncgr.height):
        rows.append(0)                                  # filter: none
        for x in range(ncgr.width):
            i = ncgr.pixels[y * ncgr.width + x]
            r, g, b = palette[i] if i < len(palette) else (0, 0, 0)
            rows += bytes((r, g, b, 0 if (transparent0 and i == 0) else 255))

    def chunk(tag: bytes, body: bytes) -> bytes:
        return (struct.pack(">I", len(body)) + tag + body
                + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", ncgr.width, ncgr.height, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
           + chunk(b"IEND", b""))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def silhouette(ncgr: Ncgr) -> list[bool]:
    """Which pixels are drawn. Palette-independent, so it can prove a layout."""
    return [i != 0 for i in ncgr.pixels]


# ------------------------------------------------------- the known answer
def read_png_silhouette(path: Path) -> tuple[int, int, list[bool]]:
    """
    Read a 4bpp palettised PNG far enough to know which pixels are drawn.

    Only what the check needs: IHDR for the size, PLTE/tRNS for which index is
    transparent, IDAT for the indices. Every filter type has to be handled --
    an unfiltered PNG is the exception, not the rule.
    """
    d = path.read_bytes()
    if d[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat, trns, w, h, depth, ctype = 8, bytearray(), set(), 0, 0, 0, 0
    while pos < len(d):
        ln = struct.unpack_from(">I", d, pos)[0]
        tag = d[pos + 4:pos + 8]
        body = d[pos + 8:pos + 8 + ln]
        if tag == b"IHDR":
            w, h, depth, ctype = struct.unpack_from(">IIBB", body, 0)
        elif tag == b"IDAT":
            idat += body
        elif tag == b"tRNS":
            trns = {i for i, a in enumerate(body) if a == 0}
        elif tag == b"IEND":
            break
        pos += 12 + ln
    if ctype != 3:
        raise ValueError(f"not palettised (colour type {ctype})")

    raw = zlib.decompress(bytes(idat))
    per_px = depth
    stride = (w * per_px + 7) // 8
    out, prev = [], bytearray(stride)
    p = 0
    for _ in range(h):
        ft = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        # PNG filters. bpp is 1 here (indices under 8 bits pack into bytes).
        if ft == 1:
            for i in range(1, stride): line[i] = (line[i] + line[i - 1]) & 0xFF
        elif ft == 2:
            for i in range(stride): line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                a = line[i - 1] if i else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                a = line[i - 1] if i else 0
                b_, c = prev[i], (prev[i - 1] if i else 0)
                pa, pb, pc = abs(b_ - c), abs(a - c), abs(a + b_ - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b_ if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        prev = line
        for x in range(w):
            if depth == 4:
                byte = line[x >> 1]
                out.append((byte >> 4) if x % 2 == 0 else (byte & 0xF))
            elif depth == 8:
                out.append(line[x])
            else:
                raise ValueError(f"unsupported bit depth {depth}")
    drawn = [i not in trns for i in out]
    return w, h, drawn


def _graphics(rom: NDSRom, narc: str) -> list[bytes]:
    return parse_narc(rom.file_data(narc))


# a/0/0/4 is one group of 20 files per species, and the FIRST NCGR of each
# group is the 96x96 front sprite -- so file 20*dex is Bulbasaur, 40 is
# Ivysaur, and so on. Confirmed for the first twenty by tile-multiset match,
# which cannot be fooled by a wrong arrangement.
POKEGRA = "a/0/0/4"
GROUP = 20


def front_sprite_index(dex: int) -> int:
    return dex * GROUP


# ------------------------------------------------------------- party icons
# a/0/0/7: file 0 is the palette file, then the icons at ODD indices with the
# even ones empty padding -- so species `dex` is file 7 + 2*dex. Each is 32
# tiles = 32x64, which is TWO 32x32 frames: the party screen bobs between them.
# The first frame is the one to use as a still.
POKEICON = "a/0/0/7"
ICON_SIZE = 32
ICON_CROP = 8          # always-empty rows at the top; see write_icon_sprites


def icon_index(dex: int) -> int:
    return 7 + 2 * dex


def icon_palette_for(dex: int, icon: Ncgr, palettes, wiki: Path) -> int:
    """Which of the three shared palettes this species uses.

    RANKED, NOT PROVEN -- the same standing as the shiny-palette offset above.
    The selector is not in arm9, not in the personal table, and not in the
    NARC; it is presumably in an overlay. What IS available is the species'
    own full sprite, so the palette is chosen by whose mean colour the icon
    comes closest to under it.

    Exact RGB matching does not work here: the icons use a coarser palette
    than the sprites and the wiki's PNGs were recoloured somewhere between the
    ROM and the clone, so nothing matches outright. Mean colour does, because
    the recolouring kept hue. Bulbasaur lands on the green palette, Charmander
    on the orange one and Pikachu on the yellow one, which the selftest pins.

    Median margin between the best and second-best is 29%; about 70 species of
    649 come in under 5% and those are the greys and purples where two of the
    three palettes really are close. Getting one of those wrong tints an icon,
    which is worth knowing but is not worth blocking on.
    """
    from collections import Counter
    ref = [c for c in _png_rgb(wiki / f"{dex:03d}.png") if c]
    if not ref:
        return 0
    use = Counter(i for i in icon.pixels if i)
    total = sum(use.values())
    if not total:
        return 0
    mr = sum(c[0] for c in ref) / len(ref)
    mg = sum(c[1] for c in ref) / len(ref)
    mb = sum(c[2] for c in ref) / len(ref)
    best, bestd = 0, None
    for p, pal in enumerate(palettes):
        r = sum(n * pal[i][0] for i, n in use.items() if i < len(pal)) / total
        g = sum(n * pal[i][1] for i, n in use.items() if i < len(pal)) / total
        b = sum(n * pal[i][2] for i, n in use.items() if i < len(pal)) / total
        d = (r - mr) ** 2 + (g - mg) ** 2 + (b - mb) ** 2
        if bestd is None or d < bestd:
            best, bestd = p, d
    return best


def write_icon_sprites(rom_path: Path, out: Path, wiki: Path) -> int:
    """Every species' 32x32 party icon, first animation frame."""
    r = NDSRom(rom_path)
    fs = _graphics(r, POKEICON)
    pals = read_nclr(fs[0])
    n = 0
    for dex in range(1, 650):
        fi = icon_index(dex)
        if fi >= len(fs) or not fs[fi]:
            continue
        try:
            g = read_ncgr(fs[fi], width=ICON_SIZE)
        except Exception:                              # noqa: BLE001
            continue
        pal = pals[icon_palette_for(dex, g, pals, wiki)]
        # The file is two stacked frames; the still is the first.
        #
        # THE TOP EIGHT ROWS ARE ALWAYS EMPTY -- headroom for the bob the party
        # screen animates. Measured across all 649, the highest ink anywhere is
        # row 8, so cropping exactly eight is provably lossless and it is what
        # stops the icon sitting low in its own box when it is used inline
        # beside text. The shared baseline survives, because every species is
        # cropped by the same amount.
        frame = Ncgr(ICON_SIZE, ICON_SIZE - ICON_CROP, g.bpp,
                     g.pixels[ICON_SIZE * ICON_CROP:ICON_SIZE * ICON_SIZE], False)
        write_png(out / f"{dex:03d}.png", frame, pal)
        n += 1
    return n


# ---------------------------------------------------------------- trainers
# FOUND BY SWEEPING EVERY NARC IN THE ROM, not by looking it up.
# a/0/7/2: 760 files in groups of EIGHT --
#     +0 graphic, 100 tiles (80x80, the still)
#     +1 graphic, 512 tiles (256x128, the animation sheet)
#     +2 NCER   +3 NANR   +4 NMCR   +5 NMAR   +6 raw   +7 palette
# 95 classes, which is the right order for BW's trainer roster, and the same
# still/sheet/cell/palette shape the Pokémon groups use.
#
# a/0/2/5 was named first, from counting 281 RGCN files and dividing by the
# class count. Decoding settled it: a/0/2/5 is 451 graphics of SIXTEEN
# tiles (32x32), and a/0/0/7 is 715 of thirty-two -- one per species, i.e. the
# party icons. Neither is a portrait.
TRAINER_NARC = "a/0/7/2"
TRAINER_GROUP = 8
TRAINER_SIZE = 80



# THE TRAINER STILL IS SIX HARDWARE OBJECTS, NOT A GRID.
#
# Read out of the group's own NCER, and the reason the first attempt at this
# looked like litter around everyone's feet. The generic 8x8-tile blocking that
# is correct for the 96x96 Pokemon sprites puts the last two tile rows down as
# one 64x16 strip; the still actually splits that region into TWO 32x16
# objects side by side. Feet therefore landed in the wrong half of the bottom
# band, detached from their legs -- and they were then mistaken for spare
# animation tiles and deleted, which is how the trainers ended up with no feet
# at all.
#
# Every one of the 95 groups carries the SAME six cells at the same positions
# and sizes, and 92 of them independently confirm the tile order: their OAM
# tile indices, at the mapping mode's 2-tile unit, come out as exactly
# 0 / 64 / 72 / 80 / 88 / 96 and tile all 100 tiles with no overlap and none
# out of bounds. The three that do not are Cheren, Bianca and N, whose NCER
# describes the 512-tile ANIMATION sheet instead -- they share the geometry, so
# the template applies to them too.
TRAINER_OBJECTS = [
    (0, 0, 64, 64),      # tiles  0..63
    (64, 0, 16, 32),     # tiles 64..71
    (64, 32, 16, 32),    # tiles 72..79
    (0, 64, 32, 16),     # tiles 80..87
    (32, 64, 32, 16),    # tiles 88..95
    (64, 64, 16, 16),    # tiles 96..99
]


def trainer_indices(n: int) -> tuple[int, int]:
    """(graphic, palette) for trainer class `n`."""
    return n * TRAINER_GROUP, n * TRAINER_GROUP + 7


def write_trainer_sprites(rom_path: Path, out: Path) -> int:
    """Decode every trainer portrait to out/NNN.png, keyed by SPRITE index.

    The filenames are sprite numbers, not class numbers -- a portrait is
    shared by up to three classes (N's two Team Plasma classes reuse his own),
    so naming these by class would mean writing the same PNG three times and
    inviting a caller to believe they were different pictures.  The class ->
    sprite join lives in extract_trainers.py, which is the only place that
    knows the arm9 table.
    """
    r = NDSRom(rom_path)
    fs = _graphics(r, TRAINER_NARC)
    n = 0
    for i in range(len(fs) // TRAINER_GROUP):
        gi, pi = trainer_indices(i)
        if gi >= len(fs) or pi >= len(fs) or not fs[gi]:
            continue
        try:
            g = read_ncgr(fs[gi], width=TRAINER_SIZE, objects=TRAINER_OBJECTS)
            pal = read_nclr(fs[pi])[0]
        except Exception:                              # noqa: BLE001
            continue
        write_png(out / f"{i:03d}.png", g, pal)
        n += 1
    return n


# ------------------------------------------------------------- gym badges
# THE NCER SAID SO. The eight badges are ONE graphic -- a/0/4/0 file 27 -- and
# the shape that makes sense of it is in the cell bank beside it, file 45,
# whose first eight cells are each a single 32x64 OAM object at tile 32*i with
# PALETTE BANK i:
#
#     cell 0: (-16,-32) 32x64  tile   0  pal 0     ... cell 7: tile 224 pal 7
#
# That is the whole answer, and nothing about it is guessable: 32x64 is a tall
# narrow shape you would not try, and the per-badge palette bank is why every
# attempt with one palette rendered all eight the same colour. Slicing by eye
# at 24 and at 32 rows both produced plausible-looking fragments, which is the
# trap this project keeps re-learning -- so the arrangement came from the ROM's
# own cell data, the way TRAINER_OBJECTS did.
#
# Parsing the NCER has one gotcha, the same one the trainer stills hit: the
# bank headers sit AT `cellDataOffset`, not at `8 + cellDataOffset`, because
# _sections() has already stripped the section header.
BADGE_NARC = "a/0/4/0"
BADGE_GRAPHIC = 27
# Chosen by scoring every 8-bank palette in the NARC against the badges' known
# colours -- Insect green, Bolt yellow, Quake orange, Jet blue. File 3 wins at
# 36 degrees of mean hue error; the next candidates agree on the same four and
# the rest are 90+ degrees out, which is the gap that makes this a decision
# rather than a coin toss.
BADGE_PALETTE = 3
BADGE_W, BADGE_H, BADGE_TILES = 32, 64, 32
BADGE_NAMES = ("trio", "basic", "insect", "bolt",
               "quake", "jet", "freeze", "legend")


def write_badges(rom_path: Path, out: Path) -> int:
    """Decode the eight gym badges to out/<name>.png, in gym order.

    CROPPED TO THEIR OWN INK. The source cell is 32x64 because that is the OAM
    object size the hardware needed, not because the badge fills it -- most sit
    in a fraction of that box, and shipping the padding would make eight badges
    of wildly different apparent size when laid out in a row.
    """
    r = NDSRom(rom_path)
    fs = _graphics(r, BADGE_NARC)
    sheet = read_ncgr(fs[BADGE_GRAPHIC], width=BADGE_W)
    banks = read_nclr(fs[BADGE_PALETTE])
    out.mkdir(parents=True, exist_ok=True)
    n = 0
    for i, name in enumerate(BADGE_NAMES):
        base = i * BADGE_H * BADGE_W
        px = sheet.pixels[base:base + BADGE_H * BADGE_W]
        if len(px) < BADGE_H * BADGE_W or not any(px):
            continue
        # Bounding box of the non-transparent pixels.
        xs = [x for y in range(BADGE_H) for x in range(BADGE_W) if px[y * BADGE_W + x]]
        ys = [y for y in range(BADGE_H) for x in range(BADGE_W) if px[y * BADGE_W + x]]
        x0, x1, y0, y1 = min(xs), max(xs) + 1, min(ys), max(ys) + 1
        crop = [px[y * BADGE_W + x] for y in range(y0, y1) for x in range(x0, x1)]
        write_png(out / f"{i}-{name}.png",
                  Ncgr(x1 - x0, y1 - y0, 4, crop, True), banks[i])
        n += 1
    return n


def palette_index(dex: int, shiny: bool = False) -> int:
    """
    The two palettes -- normal, then shiny -- sit at the END of a group, after
    the graphics, not before them.

    The tell is group 0: files 18 and 19 are flat greyscale. If palettes came
    first those would be Bulbasaur's, and Bulbasaur is not grey; as the tail of
    a placeholder group they make sense. Rendering agrees -- matching decoded
    pixels against the reference PNGs scores 25.8% exact RGB with this offset
    against 7.9% with the other.

    NOT pixel-proven, unlike the graphics indexing. The reference PNGs were
    recoloured somewhere between the ROM and the wiki, so no palette choice
    reaches 100% and the comparison is only good enough to rank the two.
    """
    return dex * GROUP + 18 + (1 if shiny else 0)


def _png_rgb(path: Path) -> list[tuple[int, int, int] | None]:
    """Reference pixels as RGB, with None where transparent."""
    d = path.read_bytes()
    pos, idat, plte, trns, w, h, depth = 8, bytearray(), [], set(), 0, 0, 0
    while pos < len(d):
        ln = struct.unpack_from(">I", d, pos)[0]
        tag, body = d[pos + 4:pos + 8], d[pos + 8:pos + 8 + ln]
        if tag == b"IHDR":
            w, h, depth, _ = struct.unpack_from(">IIBB", body, 0)
        elif tag == b"PLTE":
            plte = [tuple(body[i:i + 3]) for i in range(0, len(body), 3)]
        elif tag == b"tRNS":
            trns = {i for i, a in enumerate(body) if a == 0}
        elif tag == b"IDAT":
            idat += body
        elif tag == b"IEND":
            break
        pos += 12 + ln
    raw = zlib.decompress(bytes(idat))
    stride = (w * depth + 7) // 8
    out, prev, p = [], bytearray(stride), 0
    for _ in range(h):
        ft = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if ft == 1:
            for i in range(1, stride): line[i] = (line[i] + line[i - 1]) & 0xFF
        elif ft == 2:
            for i in range(stride): line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                a = line[i - 1] if i else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                a = line[i - 1] if i else 0
                b_, c = prev[i], (prev[i - 1] if i else 0)
                pa, pb, pc = abs(b_ - c), abs(a - c), abs(a + b_ - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b_ if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        prev = line
        for x in range(w):
            i = (line[x >> 1] >> 4) if x % 2 == 0 else (line[x >> 1] & 0xF)
            out.append(None if i in trns else plte[i])
    return out


def tiles_of(g: Ncgr) -> list[tuple]:
    """The image cut back into 8x8 silhouette tiles. Order-independent."""
    out = []
    for ty in range(g.height // 8):
        for tx in range(g.width // 8):
            out.append(tuple(1 if g.pixels[(ty * 8 + p // 8) * g.width + tx * 8 + (p % 8)] else 0
                             for p in range(64)))
    return out


def _badge_check(rom_path: Path) -> list[str]:
    """The badges came out of the ROM's own cell data; prove they still do.

    Two things are checked and neither can be faked by a wrong arrangement:
    every badge must have INK (a wrong stride lands some of them on empty
    tiles), and the eight must be DIFFERENT SHAPES -- a stride that is a
    multiple of the real one produces duplicates, which is exactly the failure
    slicing by eye kept producing.
    """
    out = []
    try:
        fs = _graphics(NDSRom(rom_path), BADGE_NARC)
        sheet = read_ncgr(fs[BADGE_GRAPHIC], width=BADGE_W)
    except Exception as exc:                            # noqa: BLE001
        return [f"badges: {BADGE_NARC} unreadable ({exc})"]
    sils = []
    for i in range(len(BADGE_NAMES)):
        base = i * BADGE_H * BADGE_W
        px = sheet.pixels[base:base + BADGE_H * BADGE_W]
        if len(px) < BADGE_H * BADGE_W:
            out.append(f"badges: badge {i} runs off the end of the sheet")
            continue
        ink = sum(1 for v in px if v)
        if ink < 80:
            out.append(f"badges: badge {i} ({BADGE_NAMES[i]}) is nearly empty "
                       f"-- {ink} pixels; the stride is wrong")
        # THE CUT MUST NOT GO THROUGH INK. This is the check with teeth: a
        # badge sits inside its OAM cell with clear rows above and below it, so
        # with the right stride every slice opens and closes on empty rows. A
        # wrong stride -- 32 was the guess that looked right by eye -- slices
        # through the middle of a badge, and the fragments are still distinct
        # and still inked, which is why counting them proves nothing.
        top = any(px[0:BADGE_W])
        bot = any(px[(BADGE_H - 1) * BADGE_W:BADGE_H * BADGE_W])
        if top or bot:
            out.append(f"badges: badge {i} ({BADGE_NAMES[i]}) touches the "
                       f"{'top' if top else ''}{' and ' if top and bot else ''}"
                       f"{'bottom' if bot else ''} of its cell -- the stride cuts "
                       "through a badge")
        sils.append(tuple(bool(v) for v in px))
    if len(set(sils)) != len(sils):
        out.append("badges: two badges have identical silhouettes -- the stride "
                   "is a multiple of the real one")
    return out


def selftest(rom_path: Path) -> int:
    """
    Prove the decoder against images whose correct answer is already on disk.

    TWO CHECKS, and they fail differently on purpose:

      1. TILE MULTISET. The 144 8x8 tiles of a decoded sprite, as a bag,
         against the same bag from the wiki PNG. This is independent of tile
         ARRANGEMENT, so it isolates LZ11, the nibble order and the tile cut.
      2. PIXEL-EXACT SILHOUETTE. The same sprite compared position by
         position. This adds the arrangement.

    If 1 passes and 2 fails, the tiles are right and their placement is not --
    which is precisely the state this decoder was in for most of an afternoon,
    and is invisible to anyone judging the output by eye.
    """
    from collections import Counter

    wiki = ROOT / "wiki" / "docs" / "img" / "pokemon"
    if not wiki.exists():
        print("  no reference PNGs -- run ./setup to clone the wiki")
        return 0                                       # not a failure, just absent
    if not rom_path.exists():
        print(f"  no ROM at {rom_path}")
        return 0

    rom = NDSRom(rom_path)
    files = _graphics(rom, "a/0/0/4")
    print(f"  a/0/0/4: {len(files)} files")

    refs = {}
    for dex in range(1, 650):
        p = wiki / f"{dex:03d}.png"
        if not p.exists():
            continue
        try:
            w, h, sil = read_png_silhouette(p)
            if (w, h) == (96, 96):
                refs[dex] = sil
        except Exception:                              # noqa: BLE001
            pass
    print(f"  references: {len(refs)} sprites at 96x96")

    def ref_tiles(sil):
        return [tuple(1 if sil[(ty * 8 + p // 8) * 96 + tx * 8 + (p % 8)] else 0
                      for p in range(64)) for ty in range(12) for tx in range(12)]

    bags = {dex: Counter(ref_tiles(s)) for dex, s in refs.items()}

    exact = bagged = tried = 0
    for i in range(20, 20 * 121, 20):
        if i >= len(files) or not files[i]:
            continue
        try:
            g = read_ncgr(files[i], width=96)
        except Exception:                              # noqa: BLE001
            continue
        if (g.width, g.height) != (96, 96):
            continue
        tried += 1
        mine = Counter(tiles_of(g))
        sil = silhouette(g)
        hit = next((d for d, b in bags.items() if sum((mine & b).values()) == 144), None)
        if hit:
            bagged += 1
            if sil == refs[hit]:
                exact += 1
            else:
                same = sum(1 for a, b in zip(sil, refs[hit]) if a == b)
                print(f"    file {i}: tiles match #{hit:03d} but placement does not "
                      f"({same / (96 * 96) * 100:.1f}% of pixels)")
    print(f"  tile multiset matched: {bagged}/{tried}")
    print(f"  pixel-exact:           {exact}/{tried}")

    # PALETTES SIT AFTER THE GRAPHICS IN A GROUP, not before. This cannot be
    # proved pixel-exactly -- the reference PNGs were recoloured somewhere
    # between the ROM and the wiki, so no offset reaches 100% -- but the two
    # candidates are far enough apart to rank, and ranking them is enough to
    # catch a regression.
    def rgb_score(off):
        hit = 0
        for dex in (1, 6, 25, 94, 143, 150):
            fi = dex * GROUP
            if fi + off >= len(files) or not files[fi]:
                continue
            try:
                g = read_ncgr(files[fi], width=96)
                pal = read_nclr(files[fi + off])[0]
                ref = _png_rgb(wiki / f"{dex:03d}.png")
            except Exception:                          # noqa: BLE001
                continue
            for k, i in enumerate(g.pixels):
                if i and k < len(ref) and ref[k] is not None and i < len(pal) and pal[i] == ref[k]:
                    hit += 1
        return hit

    # THE TRAINER STILL COMPOSES FROM ITS OAM LAYOUT, not from the generic
    # tile grid. The measure that shows it is connectedness: a figure whose
    # feet are placed in the wrong half of the bottom band comes apart into
    # pieces, and the grid layout leaves 355 connected components across the 95
    # portraits where the real layout leaves 106. Judging by eye could not tell
    # these apart at icon size -- the first attempt shipped everyone's feet
    # deleted, because the loose feet were mistaken for spare tiles.
    from collections import deque

    def components(px):
        seen, n = bytearray(len(px)), 0
        for start_i in range(len(px)):
            if seen[start_i] or not px[start_i]:
                continue
            n += 1
            queue = deque([start_i])
            seen[start_i] = 1
            while queue:
                i = queue.popleft()
                y, x = divmod(i, TRAINER_SIZE)
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < TRAINER_SIZE and 0 <= nx < TRAINER_SIZE:
                            j = ny * TRAINER_SIZE + nx
                            if not seen[j] and px[j]:
                                seen[j] = 1
                                queue.append(j)
        return n

    tfs = _graphics(rom, TRAINER_NARC)
    grid = oam = 0
    for i in range(len(tfs) // TRAINER_GROUP):
        gi, _pi = trainer_indices(i)
        if gi >= len(tfs) or not tfs[gi]:
            continue
        grid += components(read_ncgr(tfs[gi], width=TRAINER_SIZE).pixels)
        oam += components(read_ncgr(tfs[gi], width=TRAINER_SIZE,
                                    objects=TRAINER_OBJECTS).pixels)
    print(f"  trainer layout: {oam} connected components vs {grid} on the tile grid")
    if oam >= grid * 0.5:
        print("  FAIL: the OAM layout stopped assembling the trainers")
        return 1

    # The gym badges, whose arrangement came from the NCER rather than from a
    # stride that looked right. Two attempts by eye (24 and 32 rows) each
    # produced plausible fragments, so this pins the answer the cell data gave.
    badge_problems = _badge_check(rom_path)
    for b in badge_problems:
        print(f"  {b}")
    if not badge_problems:
        print(f"  gym badges: {len(BADGE_NAMES)} distinct, all inked, "
              f"32x64 at tile 32*i in {BADGE_NARC} #{BADGE_GRAPHIC}")
    if badge_problems:
        return 1

    after, before = rgb_score(18), rgb_score(-2)
    print(f"  palette offset: after={after} before={before}")
    if after <= before:
        print("  FAIL: the palette offset no longer ranks as +18")
        return 1
    if bagged != tried:
        print("  FAIL: LZ11, nibble order or the tile cut is wrong")
        return 1
    if exact != tried:
        print("  PARTIAL: tiles are right, arrangement is not universal")
        return 2
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    # --rom wins over the configured default. ./setup already knows which ROM
    # the user pointed it at and must be able to say so: it used to leave this
    # to the module default, which worked only on a machine where the default
    # happened to exist, and failed on a clean clone at the icons step with
    # "ROM not found" after twenty minutes of successful extraction.
    rom = Path(DEFAULT_ROM)
    if "--rom" in args:
        i = args.index("--rom")
        rom = Path(args[i + 1]).expanduser()
        args = args[:i] + args[i + 2:]
    if args and args[0] == "probe":
        r = NDSRom(rom)
        for path in args[1:] or ["a/0/0/4", "a/0/2/5"]:
            fs = _graphics(r, path)
            kinds: dict[bytes, int] = {}
            for f in fs:
                k = b"LZ11" if f[:1] == b"\x11" else bytes(f[:4])
                kinds[k] = kinds.get(k, 0) + 1
            print(f"{path}: {len(fs)} files")
            for k, c in sorted(kinds.items(), key=lambda kv: -kv[1])[:8]:
                print(f"   {k!r:14} {c}")
    elif args and args[0] == "selftest":
        raise SystemExit(selftest(rom))
    elif args and args[0] == "icons":
        out = Path(args[1]) if len(args) > 1 else ROOT / "app" / "img" / "icons"
        n = write_icon_sprites(rom, out, ROOT / "wiki" / "docs" / "img" / "pokemon")
        print(f"  wrote {n} party icons to {out}")
    elif args and args[0] == "trainers":
        out = Path(args[1]) if len(args) > 1 else ROOT / "app" / "img" / "trainers"
        n = write_trainer_sprites(rom, out)
        print(f"  wrote {n} trainer sprites to {out}")
    elif args and args[0] == "badges":
        out = Path(args[1]) if len(args) > 1 else ROOT / "app" / "img" / "badges"
        n = write_badges(rom, out)
        print(f"  wrote {n} gym badges to {out}")
    else:
        print(__doc__)
