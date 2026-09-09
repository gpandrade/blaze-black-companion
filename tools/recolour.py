#!/usr/bin/env python3
"""
recolour.py -- turn the neutral ramp a different hue WITHOUT moving contrast.

    python3 tools/recolour.py --report        # what the current palette measures
    python3 tools/recolour.py --preview       # what the proposed hues would be
    python3 tools/recolour.py --apply         # rewrite the palettes in place

=============================================================================
WHY THIS IS A SCRIPT AND NOT A FIND-AND-REPLACE
=============================================================================
The palette is not a list of colours, it is a list of MEASURED RELATIONSHIPS:
--ink on --card is 16.1:1, the dark card separates from the dark ground by
1.34:1, --on-ember on --ember is 5.52:1. Every one of those numbers was
arrived at once, deliberately, and several exist because a plausible-looking
colour choice shipped an unreadable control (notes/design-system.md).

Retinting by hand means re-deriving all of them and hoping. So it is done as a
transform with a guarantee instead:

    CIE L* IS HELD EXACTLY. ONLY a* AND b* MOVE.

Relative luminance Y is a function of L* alone, and WCAG contrast is a
function of Y alone -- so holding L* holds **every contrast ratio in the file,
exactly, by construction.** Not approximately, and not "checked afterwards":
the ratios cannot move, because the quantity they are computed from did not.

What DOES need checking is gamut. Pushing chroma at a fixed lightness can walk
a colour out of sRGB, and clamping the result back in is the one operation
here that would change L* -- so the transform refuses any colour it cannot
represent, rather than clipping it quietly. That check is the whole risk
surface, and it is asserted per colour.

=============================================================================
WHICH COLOURS THIS TOUCHES
=============================================================================
NEUTRALS ONLY -- grounds, cards, rules, inks, grids, axes and the two
neutral-role tokens (--x1, --bartrack). The semantic hues are left alone:
ember is the cartridge accent, x0/x2/x4 are the effectiveness ladder,
setter/sweeper/wall/pivot are the role colours, and s1/s2 were stepped against
a CVD check that this transform knows nothing about. Retinting those would be
changing what the app MEANS, not what it looks like.
"""
import math
import re
import sys
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

# --------------------------------------------------------------- colour maths
def _srgb_to_lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _lin_to_srgb(c):
    return 12.92 * c if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055


# D65, the sRGB reference white.
WP = (0.95047, 1.00000, 1.08883)


def hex_to_lab(h):
    r, g, b = [_srgb_to_lin(int(h.lstrip('#')[i:i + 2], 16) / 255) for i in (0, 2, 4)]
    x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b
    y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b
    z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b

    def f(t):
        return t ** (1 / 3) if t > (6 / 29) ** 3 else t / (3 * (6 / 29) ** 2) + 4 / 29
    fx, fy, fz = f(x / WP[0]), f(y / WP[1]), f(z / WP[2])
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def lab_to_hex(L, a, b):
    """Back to sRGB. Returns None if the colour falls outside the gamut."""
    fy = (L + 16) / 116
    fx, fz = fy + a / 500, fy - b / 200

    def g(t):
        return t ** 3 if t > 6 / 29 else 3 * (6 / 29) ** 2 * (t - 4 / 29)
    x, y, z = g(fx) * WP[0], g(fy) * WP[1], g(fz) * WP[2]
    r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z
    gg = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z
    bb = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z
    out = []
    for c in (r, gg, bb):
        v = _lin_to_srgb(c)
        # Half a bit of slack: the round trip is not exact and a value that
        # lands at -0.0001 is in gamut, not out of it.
        if v < -0.002 or v > 1.002:
            return None
        out.append(min(255, max(0, round(v * 255))))
    return '#{:02X}{:02X}{:02X}'.format(*out)


def luminance(h):
    r, g, b = [_srgb_to_lin(int(h.lstrip('#')[i:i + 2], 16) / 255) for i in (0, 2, 4)]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    x, y = sorted((luminance(a), luminance(b)), reverse=True)
    return (x + 0.05) / (y + 0.05)


# =============================================================================
# FOUR PALETTES, ONE LADDER
# =============================================================================
# There are two independent axes and they are easy to confuse, because the
# themes are NAMED after the cartridges:
#
#   data-theme    light / dark / (absent = follow the OS)   -- the palette
#   data-version  black / white                            -- which cartridge
#
# That is 2x2 = four surface palettes, and each is one HUE and one CHROMA over
# the same fixed ladder of L* values. The ladder is what carries every measured
# contrast relationship in the project, so it is read out of the palette as it
# stands rather than restated here -- there is no second copy of it to drift.
#
#   BLAZE BLACK / dark    h300 deep violet-black. The blaze in the black: the
#                         surfaces go as far into purple as sRGB allows at
#                         those lightnesses, and the ember reads as heat on it.
#   BLAZE BLACK / light   h335 warm ash. NOT the dark palette bleached -- that
#                         was the report. Ash is what a blaze leaves: a warm
#                         mauve-grey paper, same family as the dark, one step
#                         round toward the ember rather than away from it.
#                         Chosen by rendering the app at 312 / 335 / 350 / 25
#                         and looking: 312 is still lavender and reads as the
#                         unfinished version, 350 goes blush, 25 goes peach.
#                         335 is the one that reads as warm STONE.
#   VOLT WHITE  / dark    h250 cold steel. Volt yellow sits almost opposite
#                         this on the wheel, which is what makes it read as
#                         electric rather than as gold.
#   VOLT WHITE  / light   h250 the same steel, bleached to a cool near-white.
#                         "White" is a claim the palette should actually make.
#
# The two versions therefore differ in surface HUE as well as accent. That
# extends the old rule -- "only the accent tokens are redefined" -- and the
# reason the old rule existed is untouched: L* is held, so no measured pair
# moves in either version.
PALETTES = {
    ('black', 'light'): dict(hue=335.0, chroma=9.0),
    ('black', 'dark'): dict(hue=300.0, chroma=30.0),
    ('white', 'light'): dict(hue=250.0, chroma=9.0),
    ('white', 'dark'): dict(hue=250.0, chroma=20.0),
}

# CHROMA TAPERS TOWARD BOTH ENDS OF THE LADDER. Nothing near white or black can
# carry much chroma without leaving sRGB, and forcing it just makes the walk-in
# loop do the tapering anyway, unevenly. Doing it on purpose keeps the ramp
# smooth: the mid surfaces are the ones that carry the hue.
def chroma_at(L, cmax):
    return cmax * (0.35 + 0.65 * min(L, 100 - L) / 50.0)

# THE ONE L* THIS FILE MOVES ON PURPOSE.
#
# Light --card was #FFF: pure white, chroma 0, unable to hold any hue at all.
# It is the largest surface in the app, so with every other neutral tinted it
# sat there as a dead white slab and the whole light theme read as unfinished.
# That was the "light mode stopped working" report, and it was not a bug in
# the transform -- it was L*=100 having nowhere to go.
#
# 99.2 is the smallest step that lets a card carry its palette's cast. It is a
# deliberate, measured exception to holding L*, and --report prints what it
# costs: --ink on --card goes 16.13:1 -> 15.94:1.
L_SET = {('--card', 'light'): 99.2}

# Tokens that keep their own chroma and only rotate. --pat-ink is the wagara
# ink, drawn at 5% opacity: it is deliberately saturated (C=26.5) because
# almost all of it is thrown away by the opacity. Clamping it to a surface's
# chroma would leave the patterns grey.
KEEP_CHROMA = {'--pat-ink'}


def retint(hexcode, hue, cmax, keep_chroma=False, force_L=None):
    """Same L* (unless force_L), new hue, chroma from the taper."""
    L, a, b = hex_to_lab(hexcode)
    c = math.hypot(a, b)
    if force_L is not None:
        L = force_L
    c2 = c if keep_chroma else chroma_at(L, cmax)
    rad = math.radians(hue)
    for _ in range(30):
        out = lab_to_hex(L, c2 * math.cos(rad), c2 * math.sin(rad))
        if out is not None:
            return out, c, c2
        c2 *= 0.90                      # walk chroma in until it fits sRGB
    # Nothing at this lightness can carry a hue -- a pure white or black.
    return hexcode, c, 0.0


# ------------------------------------------------------------------ the tokens
# Neutrals only. Everything absent from this list keeps its hue on purpose:
# ember is the cartridge accent, x0/x2/x4 are the effectiveness ladder,
# setter/sweeper/wall/pivot are the role colours, and s1/s2 were stepped
# against a CVD check this transform knows nothing about. Retinting those
# would change what the app MEANS, not what it looks like.
NEUTRALS = [
    '--ground', '--card', '--card-2', '--card-3', '--zone',
    '--ink', '--ink-soft', '--ink-faint',
    '--rule', '--rule-soft', '--grid', '--axis',
    '--bartrack', '--x1', '--x1b',
    '--fx-off-bg', '--fx-off-ink', '--fx-off-rule',
    '--pat-ink',
]

# The pairs the design leans on. Held by the transform; reported so that
# "held" is a number on screen rather than a claim in a comment.
PAIRS = [
    ('--ink', '--card'), ('--ink', '--ground'), ('--ink', '--card-2'),
    ('--ink', '--card-3'), ('--ink', '--zone'),
    ('--ink-soft', '--card'), ('--ink-soft', '--ground'), ('--ink-soft', '--card-3'),
    ('--ink-faint', '--card'), ('--ink-faint', '--ground'),
    ('--ember', '--card'), ('--ember', '--ground'), ('--on-ember', '--ember'),
    ('--x0', '--x0b'), ('--x2', '--x2b'), ('--x4', '--x4b'), ('--x1', '--x1b'),
    ('--setter', '--setter-bg'), ('--wall', '--wall-bg'), ('--pivot', '--pivot-bg'),
    ('--s1', '--card'), ('--s2', '--card'),
    ('--rule', '--card'), ('--rule', '--ground'), ('--card', '--ground'),
    ('--axis', '--card'), ('--fx-off-ink', '--fx-off-bg'),
]

# The three files that carry palette tokens. sheet_template.html holds the base
# palette (and is the published artifact's ONLY palette, which is why Blaze
# Black lives there); factory.css holds the measured button pair; theme.css
# holds the pattern ink and the version overrides.
FILES = ['sheet_template.html', 'app/css/factory.css', 'app/css/theme.css']

BEGIN = '/* BEGIN generated by tools/recolour.py -- do not edit by hand */'
END = '/* END generated by tools/recolour.py */'


def norm(h):
    """#FFF -> #FFFFFF. The three-digit form is why --card was never retinted."""
    h = h.lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    return '#' + h.upper()


DECL = re.compile(r'(--[a-z0-9-]+)(\s*:\s*)(#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3})?)\b')


COMMENT = re.compile(r'/\*[\s\S]*?\*/')


def is_dark_block(text, start):
    """
    Which theme a declaration block belongs to, from its SELECTOR.

    This used to grep the 260 characters before the brace for the word "dark",
    which is wrong in the one way that matters: factory.css's LIGHT `:root` is
    preceded by a comment that records a measurement in dark mode. The light
    --fx-off-* trio was therefore classified dark and retinted at the dark
    palette's hue -- invisible in the contrast report, because L* is held
    either way, and caught only by verify_app.mjs noticing that Volt White's
    light block was three tokens short of its dark one.

    Comments are stripped first, and only the selector -- the text since the
    last `}` or `{` -- is considered.
    """
    head = text[max(0, start - 400):start]
    sel = re.split(r'[{}]', head)[-1]
    # An @media wrapper is part of the selector for this purpose, so keep the
    # innermost at-rule if there is one still open.
    at = head.rfind('@media')
    if at >= 0 and head.count('{', at) > head.count('}', at):
        sel = head[at:] + ' ' + sel
    return 'dark' in sel


def blank_comments(text):
    """Same length, comments replaced by spaces -- so every offset still holds."""
    return COMMENT.sub(lambda m: ' ' * len(m.group(0)), text)


def scan(path):
    """[(theme, token, value, span)] for every palette declaration in a file."""
    text = open(path).read()
    out = []
    # BRACES AND SELECTORS ARE READ OFF A COMMENT-BLANKED COPY. A `{` inside a
    # comment would break the walk-back, and the word "dark" inside one is
    # exactly what misclassified factory.css's light block.
    depth_src = blank_comments(text)
    for m in DECL.finditer(text):
        # Which block is this in? Walk back to the nearest unclosed '{'.
        i = m.start()
        depth = 0
        j = i
        while j > 0:
            j -= 1
            if depth_src[j] == '}':
                depth += 1
            elif depth_src[j] == '{':
                if depth == 0:
                    break
                depth -= 1
        out.append(('dark' if is_dark_block(depth_src, j) else 'light',
                    m.group(1), norm(m.group(3)), m.span()))
    return text, out


# =============================================================================
# THE LADDER IS DATA, NOT SOMETHING READ BACK OUT OF THE OUTPUT
# =============================================================================
# It used to be measured off the files this script writes. That is a generator
# whose source of truth is its own output, and it cannot recover from a bad
# run: one misclassified block wrote a LIGHT lightness into the dark palette,
# the next run read that back as the truth, and the error became permanent.
# The symptom was two near-WHITE buttons glowing in the dark-mode masthead --
# "Install to save" and "Download .sav" in their disabled state, which is the
# one state that should recede.
#
# So the ladder is pinned here, taken once from the palette as it was before
# any retint. Every L* below is the lightness that carried a measured contrast
# relationship at the time it was measured; changing one is changing a measured
# pair on purpose, and --report prints what it costs.
LADDER = {
    ('light', '--ground'): 94.56, ('light', '--card'): 100.0,
    ('light', '--card-2'): 93.14, ('light', '--card-3'): 97.78,
    ('light', '--zone'): 92.44, ('light', '--ink'): 7.47,
    ('light', '--ink-soft'): 35.13, ('light', '--ink-faint'): 47.08,
    ('light', '--rule'): 87.05, ('light', '--rule-soft'): 92.13,
    ('light', '--grid'): 92.13, ('light', '--axis'): 53.74,
    ('light', '--bartrack'): 90.28, ('light', '--x1'): 53.74,
    ('light', '--x1b'): 93.86, ('light', '--fx-off-bg'): 95.33,
    ('light', '--fx-off-ink'): 44.67, ('light', '--fx-off-rule'): 87.05,
    ('light', '--pat-ink'): 7.47,

    ('dark', '--ground'): 2.71, ('dark', '--card'): 15.35,
    ('dark', '--card-2'): 21.87, ('dark', '--card-3'): 9.08,
    ('dark', '--zone'): 5.29, ('dark', '--ink'): 93.88,
    ('dark', '--ink-soft'): 75.0, ('dark', '--ink-faint'): 61.49,
    ('dark', '--rule'): 26.18, ('dark', '--rule-soft'): 18.14,
    ('dark', '--grid'): 20.54, ('dark', '--axis'): 61.49,
    ('dark', '--bartrack'): 24.04, ('dark', '--x1'): 61.49,
    ('dark', '--x1b'): 19.07, ('dark', '--fx-off-bg'): 18.61,
    ('dark', '--fx-off-ink'): 65.66, ('dark', '--fx-off-rule'): 26.18,
    ('dark', '--pat-ink'): 83.54,
}


def ladder():
    """{(theme, token): L*}. Constants, plus the deliberate overrides."""
    L = dict(LADDER)
    for (name, theme), v in L_SET.items():
        L[(theme, name)] = v
    return L


def palette(version, theme, L):
    """The full neutral set for one (version, theme), at its own hue."""
    cfg = PALETTES[(version, theme)]
    out = {}
    for (th, name), Lv in L.items():
        if th != theme:
            continue
        # KEEP_CHROMA tokens need a source chroma, so they are rebuilt from the
        # current value rather than from L* alone.
        cur = CURRENT.get((th, name))
        keep = name in KEEP_CHROMA and cur
        hexv, _c0, _c1 = retint(cur or lab_to_hex(Lv, 0, 0) or '#808080',
                                cfg['hue'], cfg['chroma'], keep_chroma=keep, force_L=Lv)
        out[name] = hexv
    return out


CURRENT = {}


def load_current():
    """Populate CURRENT from disk, so KEEP_CHROMA tokens have a source."""
    CURRENT.clear()
    for f in FILES:
        _text, decls = scan(os.path.join(ROOT, f))
        for theme, name, val, _span in decls:
            CURRENT.setdefault((theme, name), val)


# ------------------------------------------------------------------- writing
def rewrite(version, dry):
    """Retint the neutral declarations in place, for one version's palette."""
    L = ladder()
    pal = {th: palette(version, th, L) for th in ('light', 'dark')}
    changed = 0
    for f in FILES:
        path = os.path.join(ROOT, f)
        text, decls = scan(path)
        # Right to left, so earlier spans stay valid.
        for theme, name, val, (s, e) in sorted(decls, key=lambda d: -d[3][0]):
            if name not in NEUTRALS:
                continue
            new = pal[theme].get(name)
            if not new or new == val:
                continue
            m = DECL.match(text, s)
            text = text[:s] + m.group(1) + m.group(2) + new + text[e:]
            changed += 1
            if dry:
                print(f'    {theme:5} {name:<14} {val} -> {new}')
        if not dry:
            open(path, 'w').write(text)
    return changed, pal


def version_block(pal):
    """The Volt White override block for theme.css."""
    def decls(th):
        return '\n'.join(f'  {k}: {v};' for k, v in sorted(pal[th].items()))
    return f'''{BEGIN}
/* VOLT WHITE'S SURFACES, not just its accent.

   The accent block above gives Volt White its electric yellow. This gives it
   its own GROUND: a cold steel where Blaze Black runs violet. Same L* ladder
   in both, so every measured contrast pair holds in either cartridge -- which
   is the reason the old "accent only" rule existed, kept while the rule
   itself is widened.

   Generated by tools/recolour.py from PALETTES. The two dark blocks must stay
   byte-identical; tools/verify_app.mjs asserts it, the same way
   verify_sheet.js does for the base palette. */
:root[data-version="white"] {{
{decls('light')}
}}
@media (prefers-color-scheme: dark) {{
  :root[data-version="white"]:not([data-theme="light"]) {{
{decls('dark')}
  }}
}}
:root[data-version="white"][data-theme="dark"] {{
{decls('dark')}
}}
{END}'''


def write_version_block(pal, dry):
    path = os.path.join(ROOT, 'app/css/theme.css')
    text = open(path).read()
    block = version_block(pal)
    if BEGIN in text and END in text:
        i, j = text.index(BEGIN), text.index(END) + len(END)
        text = text[:i] + block + text[j:]
    else:
        text = text.rstrip() + '\n\n' + block + '\n'
    if dry:
        print(f'    theme.css: Volt White block, {len(block)} bytes')
    else:
        open(path, 'w').write(text)


# ------------------------------------------------------------------ reporting
def report(before=None):
    """Contrast for every pair, in all four palettes."""
    load_current()
    L = ladder()
    for version in ('black', 'white'):
        for theme in ('light', 'dark'):
            pal = palette(version, theme, L)
            tk = {k: v for k, v in CURRENT.items() if k[0] == theme}
            tk = {k[1]: v for k, v in tk.items()}
            tk.update(pal)                      # neutrals at this version's hue
            cfg = PALETTES[(version, theme)]
            print(f"\n  ── {version} / {theme}   hue {cfg['hue']:.0f}  chroma {cfg['chroma']:.0f}")
            for a, b in PAIRS:
                if a in tk and b in tk:
                    r = contrast(tk[a], tk[b])
                    note = ''
                    if before:
                        r0 = before.get((version, theme, a, b))
                        if r0 is not None:
                            note = '  same' if abs(r0 - r) < 0.02 else f'  WAS {r0:.2f}'
                    flag = '  <-- under 4.5' if r < 4.5 else ''
                    print(f'    {a:>13} on {b:<13} {r:6.2f}:1{note}{flag}')


def snapshot():
    load_current()
    L = ladder()
    out = {}
    for version in ('black', 'white'):
        for theme in ('light', 'dark'):
            pal = palette(version, theme, L)
            tk = {k[1]: v for k, v in CURRENT.items() if k[0] == theme}
            tk.update(pal)
            for a, b in PAIRS:
                if a in tk and b in tk:
                    out[(version, theme, a, b)] = contrast(tk[a], tk[b])
    return out


if __name__ == '__main__':
    if '--report' in sys.argv:
        report()
    elif '--preview' in sys.argv:
        load_current()
        n, pal = rewrite('black', dry=True)
        write_version_block({th: palette('white', th, ladder()) for th in ('light', 'dark')},
                            dry=True)
        print(f'\n  {n} declaration(s) would be retinted')
    elif '--apply' in sys.argv:
        load_current()
        before = snapshot()
        n, _pal = rewrite('black', dry=False)
        load_current()
        write_version_block({th: palette('white', th, ladder()) for th in ('light', 'dark')},
                            dry=False)
        print(f'  {n} declaration(s) retinted, Volt White block regenerated')
        report(before)
    else:
        print(__doc__)
