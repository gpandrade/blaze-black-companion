#!/usr/bin/env python3
"""
make_patterns.py -- generate the wagara pattern tiles in app/css/theme.css.

    python3 tools/make_patterns.py          # rewrite the token block in place
    python3 tools/make_patterns.py --list   # names and tile sizes, no writing

WHY THIS IS GENERATED
The patterns are data-URI SVGs several kilobytes long, made of coordinates
nobody can read, let alone edit by hand. They are emitted from the geometry
that defines them -- asanoha really is a hexagonal star lattice, sayagata
really is two interlocking key frets -- so changing the scale or the stroke
weight is a number here rather than a find-and-replace through base64.

The SVGs carry GEOMETRY ONLY, no colour: theme.css uses them as `mask-image`
and paints through them with a themed background, so one definition serves
both light and dark. That is what makes the pattern identical across a theme
switch while the ink changes, which is the whole point.

Everything between the BEGIN/END markers in theme.css is owned by this script.
Edit anything outside them freely.

=============================================================================
TWO FAMILIES
=============================================================================
The first four are the traditional wagara from the 2026-08-24 aesthetics pass.
The six after them are the same craft applied to this game: a Poke Ball
shippo, a lightning lattice, dragon scales, a vine scroll, arrow fletching and
a trail of footprints. They are drawn to the SAME rules -- stroke only, no
fill, geometry the tile can repeat -- so they sit in the existing language
rather than beside it, and each is the motif of one tab. See notes/design-
system.md, "One motif per tab".

=============================================================================
SEGMENTS, NOT PATH STRINGS
=============================================================================
Every generator returns a list of SEGMENTS -- ('L', p, q) or
('A', cx, cy, r, a0, a1) -- rather than SVG path text. That matters because
tools/verify_patterns.py rasterises the same segments to check the tile
actually repeats without a seam, and a check that re-parsed the SVG would be
testing a second implementation of the geometry rather than this one.

Angles are degrees in SVG's own coordinate system: x right, y DOWN, so a
positive angle sweeps clockwise on screen. A point at angle a on a circle is
(cx + r*cos a, cy + r*sin a) in both the emitter and the rasteriser.
"""
import math
import urllib.parse

R3 = math.sqrt(3)
TAU = math.tau


def f(x):
    """Trim a float to something a data URI does not have to carry in full."""
    return f"{x:.2f}".rstrip('0').rstrip('.')


# --------------------------------------------------------------- segments
def L(p, q):
    """A straight segment between two points."""
    return ('L', p, q)


def A(cx, cy, r, a0, a1):
    """An arc of the circle at (cx, cy), sweeping from angle a0 to a1."""
    return ('A', cx, cy, r, a0, a1)


def circle(cx, cy, r):
    """A full circle, as ONE path. SVG needs two arcs to close one."""
    return [('C', cx, cy, r)]


def poly(pts, close=False):
    """
    A polyline through pts, as ONE path.

    This is an encoding decision with a real cost behind it. Emitting each
    span as its own `M..L..` segment doubles every coordinate -- theme.css
    came out at 183KB that way, most of it repeated endpoints -- so a
    polyline stays a polyline all the way to the `d` attribute.
    """
    pts = list(pts) + ([pts[0]] if close and len(pts) > 2 else [])
    return [('P', pts)]


def shift(segs, dx, dy):
    """Translate a segment list. Used to tile a motif across the cell."""
    out = []
    for s in segs:
        if s[0] == 'L':
            (x1, y1), (x2, y2) = s[1], s[2]
            out.append(L((x1 + dx, y1 + dy), (x2 + dx, y2 + dy)))
        elif s[0] == 'P':
            out.append(('P', [(x + dx, y + dy) for x, y in s[1]]))
        elif s[0] == 'C':
            out.append(('C', s[1] + dx, s[2] + dy, s[3]))
        else:
            _, cx, cy, r, a0, a1 = s
            out.append(A(cx + dx, cy + dy, r, a0, a1))
    return out


def lattice(motif, cells):
    """The motif repeated at every (dx, dy) in cells."""
    out = []
    for dx, dy in cells:
        out.extend(shift(motif, dx, dy))
    return out


def grid(w, h, nx=1, ny=1):
    """Lattice translations, (2nx+1) x (2ny+1) cells centred on the tile."""
    return [(i * w, j * h) for i in range(-nx, nx + 1) for j in range(-ny, ny + 1)]


def repeat(cell, w, h, rings=1):
    """
    One cell's motif, laid on the lattice.

    A GENERATOR DESCRIBES ONE CELL AND NOTHING ELSE. It used to do its own
    tiling, and that quietly made the seam check worthless: the check compared
    the emitted geometry against the emitted geometry, so a generator that
    forgot its neighbours produced a tile that was wrong and self-consistent,
    and every assertion passed. Both mutants of that check passed too, which
    is how it was found.

    With the repetition here, the checker can build its own reference from
    `cell()` over a wider lattice and have something independent to compare
    the shipped tile against.
    """
    return lattice(cell, grid(w, h, rings, rings))


def bbox(s):
    """Conservative bounds for one segment. Arcs use the whole circle."""
    if s[0] == 'L':
        (x1, y1), (x2, y2) = s[1], s[2]
        return min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)
    if s[0] == 'P':
        xs = [x for x, _ in s[1]]
        ys = [y for _, y in s[1]]
        return min(xs), min(ys), max(xs), max(ys)
    cx, cy, r = (s[1], s[2], s[3])
    return cx - r, cy - r, cx + r, cy + r


def clip(segs, w, h, margin=3.0):
    """
    Drop segments that cannot draw into the tile.

    Generators emit a 3x3 neighbourhood so that motifs straddling an edge are
    complete -- but most motifs straddle nothing, and paying for eight extra
    copies of them is what made this file 183KB. Culling by bounding box is
    safe in the direction that matters: keeping a segment that turns out to be
    invisible costs bytes, dropping one that was needed shows up immediately
    as a seam, and verify_patterns.py is looking for exactly that.
    """
    keep = []
    for s in segs:
        x0, y0, x1, y1 = bbox(s)
        if x1 >= -margin and x0 <= w + margin and y1 >= -margin and y0 <= h + margin:
            keep.append(s)
    return keep


# ------------------------------------------------------------------- svg
def seg_to_path(s):
    if s[0] == 'L':
        (x1, y1), (x2, y2) = s[1], s[2]
        return f'M{f(x1)} {f(y1)}L{f(x2)} {f(y2)}'
    if s[0] == 'P':
        pts = s[1]
        return f'M{f(pts[0][0])} {f(pts[0][1])}' + ''.join(
            f'L{f(x)} {f(y)}' for x, y in pts[1:])
    if s[0] == 'C':
        _, cx, cy, r = s
        return (f'M{f(cx + r)} {f(cy)}'
                f'A{f(r)} {f(r)} 0 1 1 {f(cx - r)} {f(cy)}'
                f'A{f(r)} {f(r)} 0 1 1 {f(cx + r)} {f(cy)}')
    _, cx, cy, r, a0, a1 = s
    x1, y1 = cx + r * math.cos(math.radians(a0)), cy + r * math.sin(math.radians(a0))
    x2, y2 = cx + r * math.cos(math.radians(a1)), cy + r * math.sin(math.radians(a1))
    large = 1 if abs(a1 - a0) > 180 else 0
    sweep = 1 if a1 > a0 else 0
    return (f'M{f(x1)} {f(y1)}A{f(r)} {f(r)} 0 {large} {sweep} {f(x2)} {f(y2)}')


def svg(w, h, segs, sw=1.0):
    body = ''.join(f'<path d="{seg_to_path(s)}"/>' for s in segs)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{f(w)}" height="{f(h)}" '
            f'viewBox="0 0 {f(w)} {f(h)}">'
            f'<g fill="none" stroke="#000" stroke-width="{sw}" stroke-linecap="round">'
            f'{body}</g></svg>')


def flatten(s, step=0.35):
    """
    A segment as a dense list of points, for the rasteriser.

    Same parametrisation as seg_to_path, deliberately: the seam check has to
    measure the geometry the CSS actually gets, not a second opinion about it.
    """
    if s[0] == 'L':
        (x1, y1), (x2, y2) = s[1], s[2]
        n = max(2, int(math.dist((x1, y1), (x2, y2)) / step) + 1)
        return [(x1 + (x2 - x1) * i / (n - 1), y1 + (y2 - y1) * i / (n - 1))
                for i in range(n)]
    if s[0] == 'P':
        out = []
        for i in range(len(s[1]) - 1):
            out += flatten(L(s[1][i], s[1][i + 1]), step)
        return out
    if s[0] == 'C':
        _, cx, cy, r = s
        return flatten(A(cx, cy, r, 0, 360), step)
    _, cx, cy, r, a0, a1 = s
    n = max(2, int(abs(math.radians(a1 - a0)) * r / step) + 1)
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / (n - 1))),
             cy + r * math.sin(math.radians(a0 + (a1 - a0) * i / (n - 1))))
            for i in range(n)]


# =========================================================================
# THE TRADITIONAL FOUR
# =========================================================================
def asanoha(s=18.0):
    """Hemp leaf. Triangular lattice + spokes in every hexagon."""
    w, h = 3 * s, s * R3
    out = []
    for cx, cy in [(0, 0), (1.5 * s, h / 2)]:
        pts = [(cx + s * math.cos(math.radians(a)), cy + s * math.sin(math.radians(a)))
               for a in range(0, 360, 60)]
        for i, (px, py) in enumerate(pts):
            qx, qy = pts[(i + 1) % 6]
            out.append(L((cx, cy), (px, py)))                 # spoke
            out.append(L((px, py), (qx, qy)))                 # hexagon edge
            out.append(L(((px + qx) / 2, (py + qy) / 2), (cx, cy)))   # the leaf
    return out, (w, h)


def seigaiha(r=22.0, rings=4):
    """Blue ocean waves: overlapping concentric fans."""
    w, h = 2 * r, r
    out = []
    for cx in (0, r):
        for k in range(1, rings + 1):
            out.append(A(cx, h, r * k / rings, 180, 360))
    for cx in (r / 2, 1.5 * r):
        for k in range(1, rings + 1):
            out.append(A(cx, h / 2, r * k / rings, 180, 360))
    return out, (w, h)


def sayagata(u=8.0):
    """Interlocking key fret -- the one that reads as circuit traces."""
    w = h = u * 4
    out = []
    for ox, oy in ((0, 0), (u * 2, u * 2)):
        out += poly([(ox - u * 2, oy + u), (ox, oy + u), (ox, oy - u),
                     (ox + u * 2, oy - u), (ox + u * 2, oy + u), (ox + u * 4, oy + u)])
        out += poly([(ox + u, oy - u * 2), (ox + u, oy), (ox - u, oy),
                     (ox - u, oy + u * 2), (ox + u, oy + u * 2), (ox + u, oy + u * 4)])
    return out, (w, h)


def kikko(s=14.0):
    """Tortoise shell: plain hexagon lattice."""
    w, h = 3 * s, s * R3
    out = []
    for cx, cy in [(0, 0), (1.5 * s, h / 2)]:
        pts = [(cx + s * math.cos(math.radians(a)), cy + s * math.sin(math.radians(a)))
               for a in range(0, 360, 60)]
        out += poly(pts, close=True)
    return out, (w, h)


# =========================================================================
# THE SIX THIS GAME EARNED
# =========================================================================
def monsphere(s=34.0):
    """
    Poke Ball shippo. A hexagonal packing of balls -- rim, equator, button --
    with a dot in the gap where three of them meet.

    Shippo, the traditional interlocking-circle pattern, is already about
    circles on a lattice, so a Poke Ball is a startlingly small edit to it: add
    the equator and the release button and the wagara is suddenly this game's.

    The gap started as a three-spoke asanoha flourish, on the theory that the
    two patterns should read as relatives. It rendered as a blot: at ground
    scale three strokes meeting at a point are not a star, they are a thicker
    dot with fringe. So it IS a dot, which is what it was always going to look
    like.
    """
    r = s * 0.44                   # not quite tangent; the gap is the pattern
    w, h = s, s * R3
    ball = (circle(0, 0, r)
            + circle(0, 0, r * 0.24)                                    # the button
            + [L((-r, 0), (-r * 0.30, 0)), L((r * 0.30, 0), (r, 0))])   # the equator
    centres = [(0, 0), (w / 2, h / 2)]
    out = lattice(ball, centres)
    for cx, cy in centres:
        for gx, gy in ((cx + w / 2, cy + h / 6), (cx, cy + h / 3)):
            out += circle(gx, gy, s * 0.055)
    return out, (w, h)


def inazuma(u=15.0):
    """
    Lightning (inazuma). Parallel chains of Z-bolts running on the diagonal.

    It was two chains crossing, which made diamonds -- at ground scale that
    read as chain-link fencing and the bolt disappeared into the lattice. One
    direction only, so the kink is the loudest thing in the tile.

    A bolt has to keep its silhouette -- down-right, hard back left, down-right
    again -- or it is just a zigzag. The chain arrives exactly one cell across
    and one cell down, which is what lets the tile repeat: end it anywhere else
    and the diagonal breaks at every seam.
    """
    w = h = u * 3
    bolt = [(0.0, 0.0), (0.72, 0.32), (0.34, 0.48), (1.0, 1.0)]
    out = []
    for ox in (0.0, w / 3, 2 * w / 3):
        out += poly([(ox + x * w, y * h) for x, y in bolt])
    return out, (w, h)


def uroko(s=22.0, rise=1.15):
    """
    Dragon scales. Pointed (ogee) scales in a brick lay -- two arcs meeting at
    a peak, not a semicircle.

    Semicircular scales would be seigaiha again at a different scale, which is
    the trap this pattern exists to avoid: at ground opacity the two would be
    indistinguishable and the tab motif would stop meaning anything. The point
    is what separates them, and it is also what reads as reptile rather than
    water.

    The geometry, because it is not guessable: each side is an arc of a circle
    centred on the base line, OUTSIDE the opposite corner, so both arcs bulge
    away from the centre and cross cleanly at the peak. Given half-width `a`
    and peak height `b`, the centre offset that puts the arc through both the
    corner and the peak is c = (b^2 - a^2) / 2a, and the radius is a + c.
    """
    a, b = s / 2, s * rise / 2
    c = (b * b - a * a) / (2 * a)
    R = a + c
    row = b * 0.62                          # rows overlap by a third
    w, h = s, row * 2                       # two rows, because the lay is brick

    def scale(x, y):
        peak_l = math.degrees(math.atan2(-b, -c)) % 360     # from the left centre
        peak_r = math.degrees(math.atan2(-b, c))            # from the right centre
        return [A(x + c, y, R, 180, peak_l), A(x - c, y, R, 0, peak_r)]

    return scale(0, 0) + scale(w / 2, row), (w, h)


def karakusa(u=24.0):
    """
    Vine scroll (karakusa). A wave of half-circle arcs, with a spiral tendril
    curling off every crest.

    The traditional pattern is the one Japanese wrapping cloth everyone can
    picture, and it is the only motif here that curls -- which is why it went
    to Adventure. Routes are the part of this game you walk rather than
    calculate, and a lattice would have made them look like a spreadsheet.

    THE TENDRIL HAS TO START ON THE VINE. The first version placed spirals and
    leaves NEAR the crests, and they rendered as loose circles floating beside
    a pipe: the eye reads a curl as growth only when it is attached to
    something. Each spiral now begins exactly at its crest, tangent to it, and
    winds inward from there.
    """
    w, h = 4 * u, 1.5 * u
    out = []
    if True:
        dx, y = 0.0, h / 2
        for k in range(4):
            cx = dx + u * (k + 0.5)
            sgn = -1 if k % 2 == 0 else 1          # this arc bows up, or down
            out.append(A(cx, y, u / 2, 180, 360) if sgn < 0 else A(cx, y, u / 2, 0, 180))
            # The tendril: an inward spiral starting at the crest of that arc.
            sx, sy = cx, y + sgn * u / 2
            R0 = u * 0.30
            ccx, ccy = sx, sy - sgn * R0
            a0 = 90 if sgn > 0 else 270
            pts = []
            for i in range(17):
                t = i / 16
                ang = math.radians(a0 + sgn * 470 * t)
                rad = R0 * (1 - 0.86 * t)
                pts.append((ccx + rad * math.cos(ang), ccy + rad * math.sin(ang)))
            out += poly(pts)
    return out, (w, h)


def yagasuri(u=11.0):
    """
    Arrow fletching (yagasuri). Columns of chevrons, alternate columns
    inverted, each with the shaft drawn through it.

    An arrow is a decision that has been made and pointed somewhere, which is
    what the Team Builder is for.
    """
    w, h = 2 * u, 2 * u
    out = []
    if True:
        dx, dy = 0.0, 0.0
        for col, sgn in ((0, 1), (1, -1)):
            cx = dx + u * (col + 0.5)
            for k in range(2):
                cy = dy + u * k
                out += poly([(cx - u * 0.42, cy + sgn * u * 0.42),
                             (cx, cy - sgn * u * 0.34),
                             (cx + u * 0.42, cy + sgn * u * 0.42)])
            out.append(L((cx, dy), (cx, dy + h)))     # the shaft
    return out, (w, h)


def ashiato(u=27.0):
    """
    Footprints (ashiato) -- a pad and four toes, tracking diagonally.

    Black and White print a species' FOOTPRINT on its Pokedex page, which is
    the one piece of Pokedex furniture nobody has ever had a use for. It has
    one here.
    """
    w, h = u * 2, u * 2

    def paw(cx, cy, rot):
        segs = []
        c, s = math.cos(math.radians(rot)), math.sin(math.radians(rot))

        def put(x, y):
            return (cx + x * c - y * s, cy + x * s + y * c)
        # The pad: a wide, shallow ellipse, as a closed polyline.
        pad = [put(u * 0.20 * math.cos(t / 11 * TAU),
                   u * 0.145 * math.sin(t / 11 * TAU) + u * 0.11) for t in range(11)]
        segs += poly(pad, close=True)
        # Four toes on an arc above it. They have to be big relative to the pad
        # or the print reads as a ring with crumbs around it.
        for ang in (-48, -16, 16, 48):
            tx, ty = put(u * 0.255 * math.sin(math.radians(ang)),
                         -u * 0.255 * math.cos(math.radians(ang)))
            segs += circle(tx, ty, u * 0.083)
        return segs

    out = []
    # Six prints per cell in two trails, each leaning the way it walks.
    for fx, fy, rot in ((0.28, 0.24, -20), (0.72, 0.70, -20),
                        (1.24, 1.22, -20), (1.70, 1.68, -20),
                        (1.62, 0.30, 24), (0.34, 1.62, 24)):
        out += paw(u * fx, u * fy, rot)
    return out, (w, h)


# ---------------------------------------------------------------- emit
def datauri(s):
    return 'url("data:image/svg+xml,' + urllib.parse.quote(s, safe='') + '")'


# The scales and stroke weights the app actually uses. Tile size comes back
# from the generator rather than being restated here, so mask-size and the SVG
# agree by construction instead of by memory.
TUNED = {
    'asanoha':   (lambda: asanoha(s=26), 1.1),
    'seigaiha':  (lambda: seigaiha(r=34, rings=3), 1.2),
    'sayagata':  (lambda: sayagata(u=9), 1.3),
    'kikko':     (lambda: kikko(s=17), 1.1),
    'monsphere': (lambda: monsphere(s=36), 1.15),
    'inazuma':   (lambda: inazuma(u=16), 1.3),
    'uroko':     (lambda: uroko(s=24), 1.15),
    'karakusa':  (lambda: karakusa(u=26), 1.15),
    'yagasuri':  (lambda: yagasuri(u=13), 1.2),
    'ashiato':   (lambda: ashiato(u=26), 1.15),
}

BEGIN = '/* BEGIN generated by tools/make_patterns.py -- do not edit by hand */'
END = '/* END generated */'


def cell(name):
    """(one cell's segments, (w, h), stroke_width) -- NOT tiled, NOT clipped."""
    make, sw = TUNED[name]
    segs, (w, h) = make()
    return segs, (w, h), sw


def build(name):
    """(segments, (w, h), stroke_width) for the tile as it ships."""
    segs, (w, h), sw = cell(name)
    return clip(repeat(segs, w, h), w, h, margin=sw * 2), (w, h), sw


def block():
    out = [BEGIN]
    sizes = {}
    for name in TUNED:
        segs, (w, h), sw = build(name)
        sizes[name] = (w, h)
        out.append(f'  --pat-{name}: {datauri(svg(w, h, segs, sw))};')
    for name, (w, h) in sizes.items():
        out.append(f'  --pat-{name}-size: {f(w)}px {f(h)}px;')
    out.append('  ' + END)
    return chr(10).join(out)


if __name__ == '__main__':
    import os
    import sys
    if '--list' in sys.argv:
        for name in TUNED:
            segs, (w, h), sw = build(name)
            print(f'{name:11} {f(w):>8} x {f(h):<8} {len(segs):4} segments  sw={sw}')
        raise SystemExit(0)
    css = os.path.join(os.path.dirname(__file__), '..', 'app', 'css', 'theme.css')
    text = open(css).read()
    if BEGIN in text and END in text:
        i, j = text.index(BEGIN), text.index(END) + len(END)
        text = text[:i] + block().strip() + text[j:]
        open(css, 'w').write(text)
        print(f'theme.css: regenerated {len(TUNED)} patterns')
    else:
        print(block())
