# The design system — contrast, surfaces, patterns, themes

Pinned by `tools/verify_app.mjs` (token resolution, duplicate selectors,
stretched pseudo-elements) and `verify_sheet.js` (the surface ladder).

This is the archaeology — why the code is shaped the way it is, and which
mistakes shaped it. Read it before changing anything it describes; most of
what looks arbitrary here is load-bearing, and the note says which bug made
it so.

---

## The aesthetics pass — done 2026-08-24, and the rules it left behind

Dark is the committed look. The whole pass was driven by measurement rather
than taste: a headless browser renders each tab and reports the computed
contrast of every text node, so "this looks a bit dim" became a number. Four
tabs went from **90 / 22 / 9 / 7 below-threshold text nodes to zero** (the 27
Adventure still reports are hover-only labels at `opacity: 0`, hidden by
design).

**DISABLED IS A COLOUR, NEVER AN OPACITY.** This is the one to remember.
`--fx-go-*` was correctly chosen and measured at 7.08:1 / 7.35:1 — and then
`opacity: .42` was layered on top of it, which composites the whole button
toward the page and took the label to **2.27:1**, in three tabs at once. A
faded orange button also still reads as an *orange button*, so disabled and
enabled looked nearly identical. `--fx-off-bg` / `--fx-off-ink` / `--fx-off-rule`
in `factory.css` are the disabled state: it changes hue, goes grey, and keeps
its own measured contrast. Never put an opacity over a filled accent.

The same rule generalises: **dim the sprite, never the text.** Adventure's
`.ad-mon.caught` used `opacity: .45` on the whole card, which put encounter
names at 3.97:1 and percentages at 2.01:1 — and since his Pokédex is 649/649,
*every* row is "caught", so the entire tab was permanently dimmed and nothing
ever stood out. The sprite carries the recession now.

**`--x4` and `--x0` INVERT between themes**, so a hardcoded `#fff` on them is
right in one theme and wrong in the other: white on the dark-mode `--x4`
measures 2.78:1. Use `--fx-on-x4` / `--fx-on-x0`.

**The surface ladder.** Dark shipped with `--card` at **1.10:1** against
`--ground` — a card separated from the page only by a border that was itself
low contrast, which is why dark mode read as flat while light did not.
Now `--ground:#070A10`, `--card:#1E2734`, `--card-2:#2A3546` (raised),
`--card-3:#131A25` (recessed), `--rule:#333F4E`. Card/ground is **1.32**,
rule/card **1.41**. `verify_sheet.js` computes both from the sheet's own
tokens and fails below 1.25 / 1.30, so the ladder cannot quietly flatten again.

**The dark palette is written twice** — once under `@media
(prefers-color-scheme: dark)` and once under `[data-theme="dark"]`, because a
media query and a plain selector cannot share a rule. `verify_sheet.js` now
asserts the two blocks are byte-identical; drift there means the toggle and
the OS preference render as two different themes, which nobody notices until
someone flips the switch.

### The bug that looked like a colour choice

The route-number shields on the map measured 2.98:1 and the obvious fix would
have been to darken the text. The actual cause: the tab put a bare **`num`**
class on them, and `sheet_template.html` — whose stylesheet is injected
app-wide at boot — owns `.num{color:var(--ink-faint)}`. Every route number was
being repainted faint grey on a near-white pill by a rule in a different file.

**`tools/verify_app.mjs` now fails on any app class that collides with a
global sheet rule needing no ancestor of its own.** `.encrow.gated` is safe
(it needs `.encrow`); a bare `.num` is not. This is the third time the
injected global stylesheet has silently claimed something — prefix everything.

It also now fails on **the same simple class selector being defined twice in
one stylesheet with conflicting values.** `builder.css` carried two unrelated
`.tb-note` rules, a plain one for slot cards and a boxed grid-spanning one for
the editor modal; the second won everywhere, so every card's location line
rendered inside what looked like a disabled input. Layering *extra* properties
is fine and is not flagged; setting the same property twice from two places is
the failure.

### Install / Download live in the SHELL, once

They act on the one working copy every tab shares, and they were drawn three
times — Factory, Team Builder and Bag each in their own header — which said,
wrongly, that each tab had its own pile of pending changes. `app/js/install.js`
holds the logic; `app.js` renders the pair beside "Reload save". Tabs call
`ctx.refreshActions()` after mutating the copy so the buttons keep up, and
`verify_factory.mjs` / `verify_builder.mjs` assert the tabs draw **no** pair of
their own.

### `app/js/rich.js` — our prose carries `<b>`

`build_sheet.py` writes `<b>…</b>` into swap notes and trainer notes. The
battle sheet renders them with `innerHTML`; the Team Builder and Adventure
appended the same strings as **text nodes**, so five of the nine Kaiju swap
notes literally read `<b>completely unchanged</b>` on screen. `rich()` parses
the string and keeps only `<b> <strong> <i> <em>`, escaping everything else —
not `innerHTML`, because a Builder team carries user-typed notes down the same
path. It returns a DocumentFragment, so every stub DOM in `tools/` needs
`createDocumentFragment` and flattens it on append.

### The Team Builder: a slot card has TWO ZONES

This is what "Create vs Edit vs Adjust reads as unintuitive" turned out to be.
The verbs were never the problem — the row was. `Edit`, `Adjust it`,
`Create it`, `+ Swap` and `Remove` sat together in one undifferentiated strip,
and **two of the five wrote into the working copy that Install later puts on
disk while the other three only changed the plan.** Nothing said which was
which, so the names read as arbitrary synonyms.

They now act on different things in different places:

| Zone | Acts on | Buttons |
|---|---|---|
| the card body | the **plan** — nothing touches your save | `Edit slot` · `Add a swap` · `Remove` |
| `.tb-save` footer, own surface, labelled **In your save** | the **working copy** | `Make yours match` (close) · `Build it` (missing) |

`verify_builder.mjs` pins the separation, not the words: a save-writing button
appearing back among the plan actions is the regression.

**Swap-card fidelity** was five concrete gaps against the sheet, now closed:
`<b>` renders bold; the `rigged` disclaimer renders as its own labelled block
(`layoutToTeam()` was destructuring `[name, badge, note]` from a **four**-element
tuple and dropping it, though `build_static.py` exports it); types and moves
use the sheet's own `TICON` images instead of a `tb-t-<type>` class that had no
CSS rule anywhere; and a swap says `Box 4 · Levitate` rather than `Box 4 12`.

### Smaller, but load-bearing

- **A `clip-path` shaves a border on its own edge.** The shell's active tab
  notches its corners with `clip-path`, whose polygon runs exactly along the
  border-box edge — and the rasteriser rounds that inward, so the right column
  of the 1px border vanished and the tab looked like it ran under the next one.
  The ring is an `inset 0 0 0 1px` box-shadow now, painted inside the border
  edge where the clip cannot reach it.
- **A toggle's label names the thing; `aria-pressed` carries the state.**
  "City names off" could be read as the current state or as what clicking
  would do — opposite meanings. The map toggles are now `City names`,
  `Route labels`, `Misc. names`, `Notes`.
- The reserved detail rails in Factory and Bag are **sticky and never empty**:
  with nothing selected they show a summary of the save / the bag, because a
  300px column reserved on every screen should earn its width.
- The Bag's item list no longer scrolls inside the page, and descriptions are
  clipped by CSS at the real width rather than sliced at 72 characters.
- `Delete team` is quiet until you reach for it; `Save as core` is the loud
  one. Green is for success, not for stating a fact — "Appears on the Battle
  tab as…" is neutral.
- `⤵` has no coverage in the font stack and rendered as tofu. The seed control
  says `Start from a core…`.
- Slot cards use `align-items: start`. Stretching every card in a row to the
  tallest, with the actions pinned to the bottom, put 100–250px of dead space
  inside the short ones.
- **Towns label with the cities, not with the landmarks.** A town is a
  settlement; "Misc." is now "Landmark names" and covers caves, towers and
  gates — the bulk of the 41 markers, and still off by default.
- **The type icons are 96×32 WORD badges**, so they are sized `height:Npx;
  width:auto`, the way the sheet does it. Forcing one into a 13×13 box
  squashed the word into a smear, and printing the name beside it said the
  same thing twice.
- **Moves are a fixed 2×2 grid.** Four free-flowing chips wrapped at a
  different point on every card, so no two cards in a row ever lined up. Four
  is the cap the game imposes, so the shape is just the shape.
- **The swap tree sits AFTER the description**, under its own "Swap this slot"
  heading. It used to sit between the Pokémon's name and its moves, so a card
  stopped describing one Pokémon halfway down and started offering others.
- **Starting blank is one option inside "+ New team", not a second chip.**
  Empty, from your party, from a core — they are all
  answers to "how do you want to start", so they are one list.
- **The species picker is a search box and a sprite grid**, not a 649-row
  `<select>` — with a second 276-row `<select>` beside it for "start from one
  of yours". You recognise a Pokémon by its picture long before you can spell
  it.
- **All three choices about a Pokémon you already own are on ONE screen.** The
  "you have N of these" panel offers **Copy** (fill the form, plan a new one,
  leave yours alone), **Edit this one** (fill the form and write the changes
  back to *that* record when you save), and **Ignore** (collapse it and design
  from scratch). Splitting "which build" from "which Pokémon" across the
  editor and the card was the confusing part, and no amount of renaming would
  have fixed it. `editView.editAt` carries the target; saving applies the spec
  to that record once. **A slot is still a SPECIFICATION** — this writes now,
  it does not bind the slot to a pointer.
- **"In your save" sits under the card header, not at its foot.** "Do I have
  this one?" is the first question you ask of a slot, and the answer was as
  far from the question as the card allowed. It keeps its own surface and
  label, because the plan and the save file are still different things.
- **Starting from nothing gets the same weight as starting from something.**
  "Empty team" carries six numbered slots so it matches the height of the rows
  offering six Pokémon; as a one-line strip beside them it read as an
  afterthought.
- **The shell bar is TWO ROWS, always.** Row one is the masthead and the save
  controls; row two is the tabs, on their own full-width line.
  This went through three versions and the middle one was wrong in an
  instructive way. A separate "unsaved edits" pill made the bar wider exactly
  when it changed state, pushing Install and Download onto a second line — so
  the row was made `nowrap` and the tabs given `overflow-x: auto`. That fixed
  the reflow and **hid the Bag tab off the end of a scroller nobody would
  think to scroll**. Navigation you cannot see is navigation you do not have.
  Two fixed rows solve both: everything is visible, and nothing moves when
  state changes. The tabs WRAP rather than scroll if the window is genuinely
  tiny, because a wrapped tab is still findable.
  The staged indicator is a pill carrying a neon dot and a count — ~50px
  against the ~110px the spelled-out version cost — and the Install/Download
  pair takes a neon rim when something is staged.
- **The toolbar band is a full field, not a top strip.** A 34px seigaiha band
  `repeat-x` across the top of a ~44px toolbar landed its bottom edge right at
  the text baseline and read as a stray underline; on the taller battle
  masthead the same rule read as a top stripe, so no two headers matched.
  `mask-repeat: repeat` on all of them.
- **A label inline with a sentence must share its type family.** The save
  strip had a 9px mono "In your save" centred against an 11.5px sans
  sentence, which read as two unrelated fragments sharing a row. Same family,
  baseline-aligned, with case and tracking doing the label work. `.tb-savelab`
  is deliberately excluded from theme.css's mono kicker list for this reason.
- **A dismiss control must be quieter than what it dismisses.** "Ignore" sat
  hard against "You have 4 Gengars" at the same weight; it is now small,
  underlined, ink-faint and pushed to the far end of the row.

### Never pin a COLOUR STRING in a test — pin the property

`verify_adventure.mjs` asserted a route badge "does not look like a place
label" by matching the literal `background: rgba(233,238,244` in the
stylesheet. That test fails when the same colour is rewritten as a hex, and
**passes when someone swaps in a different pale colour that reads as a town**
— so it was pinning a spelling, not a rule. It compares relative luminance
between `.ad-routetag` and `.ad-pinlab` now (badge > 0.6, label < 0.3), which
is the property the rule is about. Mutation-tested: making the badge dark
fails it.

### How to re-measure

The three scratch harnesses used for this pass are **not** committed — they
were `app/_shot.html` (drives a tab in a same-origin iframe so headless Edge
can screenshot it), `app/_audit.html` (computes real contrast from
`getComputedStyle`, walking opacity ancestors) and `app/_probe.html` (surface
deltas, overflow, nested scroll regions). Headless Edge lives at
`/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe` and
`--headless=new --screenshot --window-size=W,H --virtual-time-budget=30000`
against `http://127.0.0.1:8080/` works from WSL. Rebuild them if you need
them; the durable checks are in `verify_app.mjs` and `verify_sheet.js`.

## The surface language — `app/css/theme.css`

Measured legibility is not the same as having a voice: after the contrast pass
the app was correct and inert — "boring and stiff". This layer gives it one,
and **changes no information on screen**, only the surface it sits on.

**The brief, as agreed:** Kamigawa Neon Dynasty by way of a ROM hack, with Ink
& Switch's discipline about what is allowed to shout. Wagara (Japanese
repeating patterns) carry the texture; the ember we already had is the neon.

| Pattern | Where | Why that one |
|---|---|---|
| **asanoha** (麻の葉, hemp leaf) | the page ground, fixed to the viewport | a hexagonal star lattice — it tessellates the way an Escher print does |
| **sayagata** (紗綾形, key fret) | the shell bar | interlocking frets read as circuit traces; this is the cyber half |
| **seigaiha** (青海波, ocean waves) | the one toolbar at the top of each tab | a band, not a field — it caps a surface without filling it |
| **kikkō** (亀甲, tortoise shell) | the "In your save" footer of a slot card | the half of the card that talks to the save file, quietly marked as a data surface |

### THE PATTERNS ARE MASKS, NOT IMAGES — this is the whole trick

Each is a data-URI SVG carrying **geometry and nothing else**, used as
`mask-image`, with the colour coming from the element's own background. One
definition therefore serves both themes: flip light/dark and the geometry is
**identical** while only the ink changes, which is exactly what was asked for.
Baking colour into the SVG would have meant two copies of every pattern,
drifting apart. Light reads as washi paper; dark reads as neon on indigo.

**`tools/make_patterns.py` owns everything between the BEGIN/END markers in
`theme.css`.** The tiles are kilobytes of coordinates nobody can hand-edit, so
they are emitted from the geometry that defines them — changing a scale or a
stroke weight is a number in `TUNED`, not a find-and-replace through base64.
It is idempotent; run it and diff.

### EVERY DECORATIVE LAYER IS pointer-events: none

Each pattern is a `::before` stretched over its parent with `inset: 0`, which
is **the same shape as the bug that has already broken this app twice** — the
map editor once shipped with nothing on the map clickable because
`.ad-markers` took pointer events. `verify_app.mjs` now fails on any stretched
`::before`/`::after` that omits `pointer-events: none`; it is scoped to
pseudo-elements because those are always decoration, while a stretched real
element can legitimately be interactive (`.ad-links` carries the clickable
route lines, modal overlays close on a click outside). The four named map
layers stay pinned in `verify_adventure.mjs`.

### Restraint is what keeps it usable

Pattern appears on the page ground, the shell bar, the tab toolbars and one
card footer — **and nowhere else**. Cards carry the data, so cards stay clean.
That is the Ink & Switch half of the brief and it is why 276 Pokémon are still
readable. All four tabs still measure **zero** below-threshold text nodes.

Other pieces of the same language: cut corners (`--notch`) on the three things
that actually commit something (active tab, primary action, toolbars); a neon
hairline (`--neon-line`) closing the shell bar and each toolbar; `v3.1 · FULL
PATCH` in the masthead, because the app is built entirely around the fact that
this is a hack; and the `.kick` mono-caps idiom, which four files had grown
independently.

**Adding a new neon:** `--neon-1/2/3` are ember, teal and violet, taken from
the existing role tokens so nothing new has to be kept in sync.

### Blaze Black / Volt White — the theme control

Three states, cycled by one compact button:

| State | `data-theme` | Means |
|---|---|---|
| System | **absent** | follow the OS |
| Blaze Black | `dark` | |
| Volt White | `light` | |

**"System" is the ABSENCE of the attribute, never a value.** Every dark block
in the project is guarded as `:root:not([data-theme="light"])` and relies on
the media query still applying when nothing is set; writing
`data-theme="system"` would break all of them at once.

**The choice is applied by an inline script in `<head>`, before the first
`<link>`.** Doing it from `app.js` after boot paints the page in the OS theme
and then flips it — the flash everyone recognises. It is wrapped in
`try/catch` so private mode falls back to the system preference rather than
throwing. `verify_app.mjs` pins all of this, because tidying that script into
a module later would break nothing visible in a test but would reintroduce
the flash.

**THE MASTHEAD IS THE CONTROL.** It began as a static wordmark with a separate
theme button at the far right that also read "Blaze Black" — the same two
words twice in one bar, and the control dangling off the end with nothing near
it. They are one thing now: the wordmark carries a sun/moon/auto glyph and
cycling the theme is what clicking it does. `renderBrand()` in `app.js`.

It reads **"Blaze Black companion"**. A bare wordmark reads like a claim on
someone else's game; this is a companion *to* the hack. The name does not
change with the theme — it names the ROM that is loaded, not the palette, and
flipping it to "Volt White" in light mode would be a lie about which game this
is. The themes borrow the pair's names, nothing else.

### Depth — why the cards read as "flat things floating on an elegant canvas"

Three separate causes, and all three had to go:

1. **One diffuse shadow and no contact shadow.** A single big blur is what
   floating looks like. `--shadow` is now a near-opaque 1–2px contact shadow
   under a wider ambient one. Changed in `sheet_template.html`, so the
   published sheet gets it too.
2. **No rim.** A card was a rectangle of flat paint. `--rim` puts a hairline
   catch-light along the top edge and a darker line along the bottom, so a
   card reads as a plate with thickness.
3. **A hole punched in the pattern.** The canvas was textured and the cards
   were not. They now carry the same asanoha at half the ground's strength —
   present only as a grain, and only on panels, never on the grid cells and
   list rows inside them.

The sprite also sits on a **plinth** now (a recessed gradient tile with the
rim), which is the single biggest thing that stopped a slot card reading as a
flat rectangle: it gives the card a focal point and a second surface.
**Not a wagara mask** — `--pat-*` are mask images whose strokes are `#000`, so
using one as a `background-image` paints literal black lines instead of themed
ink, and an `<img>` has no room for a masked layer behind it.

A corner-tick treatment was tried on the toolbars and removed: they already
have a cut corner, and two corner devices at one corner fight.

### The battle tab's header is restyled from OUTSIDE

`sheet_template.html` opens with a 42px `<h1>` masthead over a row of large
tab buttons — right for the standalone published artifact, wrong beside four
tabs whose header is a compact toolbar. It was the oldest surface in the
project and looked it. `battle.js` adds a `.bt-host` class to the panel and
`theme.css` restyles the masthead and `nav.tabs` into the same bar the other
tabs use. **The template's markup is untouched**, so `build_sheet.py` still
renders the artifact exactly as before.

The `<h1>` is also **retitled in the app only**, to "Battle companion".
The template's own heading names the teams the sheet shipped with ("Kaiju,
Rain, Trick Room") — the page's identity when it stands alone, but stale
(there are eight teams now) and the odd one out beside "Pokémon Factory",
"Team Builder" and "Bag". `battle.js` sets `textContent` after injecting the
markup.

**The battle tab's panels are listed by the TEMPLATE's class names** in
theme.css's depth block — `.panel`, `.card`, `details.tcard`, `.matwrap`,
`details.big`, `.tcard2`, all scoped to `.bt-host`. Without them the battle
tab was the one surface in the app that never gained the rim or the grain,
and it showed immediately.

### `--on-ember` / `--on-x4` / `--on-series` — the ink that goes ON a fill

`--ember`, `--x4`, `--s1` and `--s2` all **invert between themes**, so a
hardcoded `#fff` on them is right in one theme and wrong in the other. White
on the dark-mode `--ember` measures **2.41:1** — the trap this project has
documented for months, and it was still live in the sheet's own tab bar, its
zone numbers, its mini-buttons and its speed ladder. The selected team tab's
one-letter tag was the worst case at **1.00:1**: white text on a
`rgba(255,255,255,.18)` wash over a light orange.

The sheet now defines the three on-accent inks in both palettes and uses them.
This is a fix to the **published artifact**, not just to the app.

## Blaze Black / Volt White is a SETTING, not a build

The two versions are one hack with a handful of forks, and the only one this
tool can see is Opelucid: Drayden in Black, Iris in White.

- **`build_static.py` exports EVERY documented fight, tagged with `ver`**, and
  the app filters at render time — so switching cartridge is a click rather
  than a rebuild. `build_sheet.py` still bakes `VERSION` in, because the
  published artifact is static.
- **The indices never shift.** `AREAINDEX[].opponents` and `bb_enc` key on
  position in the complete list, so filtering has to keep the original index —
  `progressPanel()` works on `{o, i}` pairs for exactly this reason.
- **Progress is keyed on a stable slug, not a position.** `e.key` is a slug of
  the fight's own name. Keying on index meant that dropping one fight silently
  re-attributed every mark after it to the wrong trainer; numeric keys from
  before this are migrated once, in the template.
- **The wordmark's NAME *is* the control.** A separate chip beside it said the
  same thing twice — "BLAZE BLACK … BLACK" — and sat on its own with nothing
  near it. The two words that change when you switch are the two words you
  click; `.sh-name` stops the click reaching the brand button, so switching
  version never also flips the theme. Two nested controls work only because
  they mean different things: the name is the cartridge, everything around it
  is the palette.
- **The wordmark follows the version, never the theme.** It names the
  cartridge, so "Volt White companion" is the truth for a White player and the
  theme flipping it would be a lie.
- **The two versions look different**, via `data-version` on the root. It
  cannot be another light/dark axis — the theme owns that — so it is the
  ACCENT: Blaze Black keeps the ember, Volt White takes the electric yellow its
  name points at. Only accent tokens are redefined, so no surface or measured
  contrast pair is touched; the on-accent inks and `--fx-go-*` are restated
  alongside and measure 7.06:1 light / 11.64:1 dark. **The ABSENCE of
  `data-version` means Blaze Black**, the default, so nothing needs a black
  block.
- **Switching rebuilds the blob**, by re-running `adopt()`. Redrawing the tab
  alone would leave the battle sheet holding the other cartridge's fights.

---

## Four palettes — Blaze Black and Volt White, light and dark (2026-09-02)

Generated by `tools/recolour.py`; the shape is pinned by `verify_app.mjs` and
the base palette's contrast ladder by `verify_sheet.js`.

Two axes, easy to confuse because **the themes are named after the
cartridges**: `data-theme` is light/dark/system, `data-version` is
black/white. That is 2×2 = four surface palettes.

| | hue | reads as |
|---|---|---|
| **Blaze Black / dark** | 300° violet, chroma 30 | the blaze in the black — as far into purple as sRGB allows at those lightnesses, ember as heat on it |
| **Blaze Black / light** | 335° warm ash, chroma 9 | what a blaze leaves: warm mauve-grey stone, one step round *toward* the ember |
| **Volt White / dark** | 250° cold steel, chroma 20 | electric night; volt yellow sits nearly opposite it on the wheel |
| **Volt White / light** | 250° steel, chroma 9 | cool near-white — "white" as a claim the palette actually makes |

**The version now changes surfaces, not only the accent.** That widens the old
rule (*"only the accent tokens are redefined"*), and the reason the old rule
existed is untouched — see below.

### L* is held, so contrast cannot move

The palette is not a list of colours, it is **a list of measured
relationships**. Retinting by hand means re-deriving all of them and hoping.
So the transform holds **CIE L\* exactly and moves only a\*/b\***. Relative
luminance is a function of L\* alone and WCAG contrast is a function of
luminance alone, so **every ratio in the file is held by construction** — not
checked afterwards, unable to move. `--report` prints all four palettes so
"held" is a number on screen rather than a claim in a comment.

The one real risk is **gamut**: pushing chroma at fixed lightness can walk a
colour out of sRGB, and clipping it back is the one operation that *would*
change L\*. The transform refuses rather than clips, walking chroma in until it
fits.

### Why light mode "stopped working"

It didn't — that is what made the report worth chasing. Measured against the
previous build, the light ground had moved **6/255** and `--card` had not moved
at all. Two causes, both invisible in a contrast report:

- **`--card` was `#FFF`** — and the retint's regex only matched six-digit hex,
  so the largest surface in the app kept its dead neutral white while every
  other neutral picked up a cast. Beside a dark mode with real character, that
  reads as unfinished.
- **L\*=100 has nowhere to go.** Pure white cannot carry a hue at any chroma.
  So light `--card` is now **99.2**, the smallest step that lets a card hold its
  palette's cast. It is the one deliberate exception to holding L\*, and it
  costs `--ink` on `--card` 17.9:1 → 17.7:1.

**Every pair under 4.5:1 in the new palettes was already under 4.5:1 in the
pristine one** — checked against the untouched backup rather than assumed.

### Install is the way out; Download is the other one

They shipped as a matched pair — same size, same two-line shape, one filled and
one outlined — which read as two equal choices and made you decide between them
every time. Install writes the save in place, backing it up first, and is how
this is actually used.

So Download joins the quiet row: the same `.sh-btn` chip as *Reload save* and
*Choose file…*. **But the rule is about what else is on offer, not about the
button** — with no save path configured (drag-and-drop, or `./serve
--no-write`) Download is the only way out, and demoting it there would leave
the bar with no primary action at all. Both halves are pinned; the second is
the one a later tidy-up would quietly drop.

### The generator read its own output, and could not recover from a bad run

`recolour.py` measured its L* ladder off the files it writes. One misclassified
block wrote a **light** lightness into the **dark** palette; the next run read
that back as the truth, and the error became permanent and self-perpetuating.
What shipped was two near-white buttons glowing in the dark-mode masthead —
*Install to save* and *Download .sav* in their **disabled** state, which is the
one state that should recede.

**Contrast could not have caught it.** Ink and background moved together, so
the pair still measured 5:1. It was the wrong end of the ramp, not a bad pair.

Two fixes, and the second is the general one:

- **The ladder is data now**, pinned in `recolour.py` from the palette as it
  was before any retint. A generator whose source of truth is its own output
  cannot recover from a bad run; one whose constants are in the file is
  idempotent.
- **`verify_app.mjs` asserts the ramp direction**: every surface is dark in the
  dark theme and light in the light one, every ink the reverse. The *first*
  version of that check compared dark against light and **passed the mutant**,
  because the corrupted value had the same L* as its light counterpart — a
  relative test is knife-edge exactly where the bug puts you. The thresholds
  are absolute now, with margins wide enough that no legitimate retune trips
  them (the tightest real values are `--rule` at L*26 dark and `--axis` at
  L*54 light).

Scope detection needed three attempts. "Everything after the last brace"
returns the *declarations* above a declaration, not its selector; a fixed
lookback window is shorter than `sheet_template.html`'s 1300-character palette
blocks. It is a **single pass with a brace stack** now, which has neither
problem and is shorter than either.

Disabled now measures: button-to-bar **1.09:1** (it blends), border-to-bar
**1.39:1** (it is still a control), label **5.21:1** dark / **4.83:1** light.

### Two bugs the work surfaced

- **The block classifier read comments.** It decided light-vs-dark by grepping
  the text before a `{` for the word "dark" — and `factory.css`'s *light*
  `:root` is preceded by a comment recording a measurement taken in dark mode.
  The light `--fx-off-*` trio was therefore retinted at the dark palette's hue.
  Invisible in the contrast report, because L\* is held either way. Caught only
  by `verify_app.mjs` noticing Volt White's light block was **three tokens
  shorter than its dark one** — on the check's first run. Braces and selectors
  are read off a comment-blanked copy now.
- **The light Volt accent reads brown.** `--ember` has to be `#A36A00` in light
  mode or nothing can be written on it, and that dark gold is a poor thing for
  a version called VOLT to look like. `--neon-1` only ever paints the 1px
  hairline closing the shell bar and each toolbar — a hairline carries no text,
  so it takes the real volt yellow. **The electricity lives where the contrast
  rules do not reach.**

### The light hue was chosen by looking

312° / 335° / 350° / 25° were each applied, built and screenshotted. 312 is
still lavender and reads as the unfinished version; 350 goes blush; 25 goes
peach. **335 is the one that reads as warm stone.** No amount of reasoning
about hue angles would have settled that.

---

## The tab rail and the dial — added 2026-09-02

Pinned by `tools/verify_nav.mjs` (62 assertions). Code: `app/js/nav.js`,
`app/css/nav.css`.

The tabs were seven pill buttons on a row of their own, and they read as seven
pill buttons: correct, findable, and saying nothing about a project whose whole
surface language is cut corners, neon hairlines and wagara. Gab's brief was
Persona and *Metaphor: ReFantazio* — **"a collapsable wheel or something"**.

**There are two navigations and they share one model**, because the two halves
of that brief want opposite things:

| | what it is | what it costs |
|---|---|---|
| **the rail** | skewed plates, an index numeral, a glyph, the active one filled and lifted | nothing — still **one click** |
| **the dial** | seven spokes on a ring around a hub that names what you are pointing at | a summon, so it is allowed to be theatrical |

Navigation is the one control every session touches. That makes it the
cheapest place in the app to spend character and **the most expensive place to
spend a click**, which is the whole reason the wheel is not the only nav: a
dial that replaced the rail would tax every tab change for the rest of the
project to buy a flourish you stop noticing in a week.

### The shape was already in the building

`--notch` cuts one corner off everything that commits something. A plate is
that idea taken all the way: **cut both corners on the same diagonal and you
have a parallelogram**, which is what Persona builds its menus out of. So the
rail needed no new vocabulary, only more of the one already here.

**The skew is on the plate and undone on its contents** (`.sh-plate > *`).
Skewed 12px type is illegible and reads as a rendering fault, which is the one
thing a navigation control cannot afford to look like.

### The dial's actual claim is that pointing is not choosing

Turning the ring moves a pointer and updates the hub. **It does not navigate.**
That two-step is the only thing separating a dial from a menu with round edges:
if turning committed, the second press would buy nothing and this would be a
tab bar with a longer path. It is the assertion in `verify_nav.mjs` that a
mutation broke six checks at once.

Consequences that follow from it, each pinned:

- **Escape and the backdrop close without navigating.** A picker that commits
  on cancel is the worst kind, because the mistake looks like a click you never
  made.
- **A tab you cannot open is still a tab you can turn onto**, and the hub says
  *why* rather than going quiet. Skipping locked spokes would hide the app from
  someone who has not loaded a save — precisely the person turning the dial.
- **Digits 1–7 go straight there.** Persona menus answer to numbers.

### It earns its place on a phone, not on a desktop

Under 760px the rail is hidden and **the dial IS the navigation**. That is the
honest reason it ships rather than being a toy: seven plates cannot sit on a
phone, the old answer was to let them WRAP into two ragged rows of chrome above
every screen, and a horizontal scroller hides half of them behind a gesture
nobody performs. A ring is the same seven targets, bigger, in a space that is
round instead of long. The hub grows a label naming where you already are.

### The theme click killed the two controls inside the wordmark

Reported as *"once I change dark → light mode it seems to no longer let me
click on Blaze Black vs Volt White until I refresh."*

`renderBrand()` rebuilds the wordmark, and `.sh-name` — the cartridge control,
and the starter control beside it — is created there. Their click handlers are
attached in `renderVersion()`. **Every caller paired the two by hand, and the
one that did not was the theme click**, which called `renderBrand()` alone. So
flipping the palette replaced both names with fresh, handler-less elements that
looked *identical*. Nothing errored; clicking simply did nothing.

Exactly the shape of the standing redraw trap — *a full rebuild destroys the
element the handler was on*, which is why this project updates cheaply on
`input` and redraws only on `change` — so the fix is the same one: **the function that
builds a control owns its wiring.** `renderBrand()` ends by calling
`renderVersion()`, and no call site has to remember any more.

`verify_nav.mjs` pins it against the SOURCE rather than a stub, because the bug
is about which function calls which and a stub that re-ran both would prove
nothing. Three properties, each of which alone caused it: the name is built in
`renderBrand`, wired in `renderVersion`, and `renderBrand` calls it. Deleting
that one call fails the check.

### Traps hit while building it

- **The shell's inline `<style>` loads AFTER every `<link>`.** Moving the tab
  rules into `nav.css` meant *deleting* them from `index.html`, not overriding
  them: anything left behind wins on a tie and the rail would have rendered as
  pills wearing a plate's markup. Same failure shape as the duplicated
  selector, one file further out.
- **The active plate is a filled accent**, so it is `--fx-go-bg` /
  `--fx-go-ink` — never `--ember` with a hardcoded white, which measures
  2.41:1 on the dark-mode ember. Pinned as a CSS assertion because no stub can
  measure contrast.
- **The dial's backdrop is a real element, not a `::before`.** Clicking it is
  how the dial closes, so it is the deliberate exception to the rule
  `verify_app.mjs` enforces on every stretched pseudo-element — and it is
  asserted as an exception rather than left to look like an oversight.
- **The hotkey is a backquote, not a letter.** Every tab in this app has a
  search box; a letter would be swallowed by one, which is a worse bug than
  having no shortcut. `isTyping()` guards the rest, and a modified backquote is
  left alone because ctrl+` is a terminal in several apps.
- **A shortcut nobody can see is not a shortcut.** The hub is a 13px ring at
  the far left of the bar and nothing about it says a key opens it, so it
  carries a keycap. This is the same lesson as **A search mode nobody can
  find** in `notes/pokedex.md`, and it cost one character to apply here rather
  than a tutorial section later.
- **Opening the dial twice would stack two of them**, both holding the
  keyboard, with no path that closes the second. Guarded, and pinned.

---

## One motif per tab — the Pokémon wagara, 2026-09-02

Pinned by `tools/verify_patterns.py` (16 assertions). Geometry:
`tools/make_patterns.py`.

The aesthetics pass shipped four traditional wagara. Gab's follow-up, after
seeing the Poké Ball easter egg, was to give the surface **real character**
with Pokémon-themed tessellations "where it'd look nice". Six more, drawn to
the same rules — stroke only, no fill, geometry a tile can repeat — so they sit
*inside* the language rather than beside it:

| Pattern | Geometry | Tab, and why |
|---|---|---|
| **monsphere** | hex-packed Poké Balls — rim, equator, button — with a dot in each gap | **Factory**, the tab where Pokémon are made |
| **inazuma** | parallel chains of Z-bolts on the diagonal | **Battle**, the only tab where something is about to happen |
| **uroko** | pointed (ogee) dragon scales in a brick lay | **Run**, where you choose how hard this is |
| **karakusa** | a vine of half-circles with a spiral tendril off every crest | **Adventure** — routes are walked, not calculated |
| **yagasuri** | arrow fletching, alternate columns inverted | **Team Builder** — an arrow is a decision already pointed somewhere |
| **ashiato** | pad-and-four-toes footprints, tracking diagonally | **Pokédex** — BW print a species' footprint on its dex page, the one piece of dex furniture nobody has ever had a use for |

**The ground carries the active tab's motif and nothing else changes.** It is
the largest surface in the app and the only one you see without looking at it,
so a change there registers peripherally — you know you have arrived somewhere
before you have read a word. Anything more local would be a decoration you have
to notice on purpose, which is not what this is for. `data-tab` on `<body>` is
the entire mechanism; with no attribute the ground is asanoha, as before.

### Four of the six were wrong the first time, and the render is what said so

They were built, seam-checked green, and **five of the six still needed work**
once rasterised and looked at:

- **uroko** rendered as scattered leaf-shapes. The arc maths was simply wrong.
  It is stated in the docstring now, because it is not guessable: given
  half-width `a` and peak height `b`, the arc centre that passes through both
  the base corner and the peak sits at `c = (b² − a²) / 2a` with radius `a + c`.
- **monsphere**'s interstitial three-spoke flourish rendered as a blot — at
  ground scale three strokes meeting at a point are not a star, they are a
  thicker dot with fringe. It **is** a dot now.
- **inazuma** crossed two chains, which made diamonds; at ground scale that
  read as chain-link fencing and the bolt vanished into the lattice.
- **karakusa** placed its spirals *near* the crests, and they rendered as loose
  circles floating beside a pipe. **A curl reads as growth only when it is
  attached to something** — each one now starts exactly on its crest.
- **ashiato** put all its prints in the top half of the cell, so the pattern
  banded.

Only **yagasuri** was right first time. The lesson is the one in
`rom-graphics.md` about judging graphics by eye at icon size, pointed the
other way:
this work could not be judged **without** looking, and the rasteriser existed
before any of these were tuned.

### The seam check was worthless until it had an oracle

`verify_patterns.py` renders each tile wrapped, tiles it 2×2, and compares
against the pattern as it is *supposed* to be. The first version compared
`build()` against `build()` — and **both mutants passed**: culling with a
negative margin, and tiling one cell instead of nine, each produced a tile that
was wrong and self-consistent. Any segment list is trivially periodic once you
repeat it.

So **a generator describes ONE CELL and the framework tiles it**
(`repeat()`), which gives the checker something independent to build a
reference from: the cell laid over a wider lattice, unculled. Both mutants now
fail, on six and four patterns respectively.

Note what it deliberately does *not* catch: removing a motif from a cell is a
**design change**, not a seam, and the reference moves with it. That is
correct — this check is about tiles repeating, not about taste.

### Encoding, because the first cut was 183KB of CSS

Three fixes, in order of what they bought:

1. **Cull segments that cannot draw into the tile** (bounding box). Generators
   emit a 3×3 neighbourhood so edge-straddling motifs are complete; most
   motifs straddle nothing. 77KB → 23KB.
2. **A polyline stays a polyline** all the way to the `d` attribute. One
   `M..L..` per span doubles every coordinate.
3. **Two decimals**, which is a tenth of a pixel at these tile sizes.

`theme.css` is 62KB with ten patterns in it, against 30KB with four.

---

## Professor Hazel — the first run, and the help that stays (2026-09-03)

Pinned by `tools/verify_tutor.mjs`. Code: `app/js/tutor.js`, `app/css/tutor.css`.

Every Pokémon game opens with a professor telling you what the world is. This
app has the opposite problem to most software: **it is not hard to use, it is
hard to know about.** The Pokédex's best feature is reachable only by typing a
move name into a box captioned for species; the tab dial answers a key nobody
would guess; "Suggest one" sits on a card you have to have made first. Every
one of those is a thing somebody has to be *told*, once, by something already
on screen.

So: a tour that runs once, and then the same character in the corner with one
sentence about wherever you are.

**Clippy's sin was interrupting**, and the rule that follows is absolute:
Hazel never speaks unless the tour is running or you clicked them, nothing
about them loops, and *Hide me* removes them from the page — not hides them —
and is remembered. All four are asserted.

### Drawn, not extracted

The obvious move was the ROM's own professor, the way trainer portraits and
party icons come out of the cartridge. **Professors are not battle trainers**,
so they are not in the trainer NARC `extract_trainers.py` reads — there is no
portrait to take. Drawing one turned out better anyway: it is ours, so nothing
is redistributed, and a vector character can blink, point and lean, which a
sprite cannot.

Named for a tree like every professor in the series, and for one the series has
not used. They/them.

### What the render taught, three times

- **The first Hazel was invisible.** The lab coat took `--card`, so on the dark
  palette a professor drawn onto the page was a dark figure on a dark ground
  with no silhouette. They stand on a **badge** now — the same card-on-ground
  separation everything else gets — and the coat is `--card-2`, the lightest
  card surface, which is as close to a lab coat as a dark theme honestly gets.
- **Realistic proportions read as a hooded figure in goggles.** At 74px the
  face has to be nearly half the height. Chibi proportions, hair that leaves
  the forehead clear rather than capping the skull, and the eyes *inside* the
  lenses rather than behind them.
- **`think` was another arm angle and looked exactly like `idle`.** Any bigger
  angle read as the cheer. It is a lean plus a squint now — a different
  channel, unmistakable at 74px.

Every colour is a token, so Hazel wears **ember in Blaze Black and volt yellow
in Volt White** on the glasses and the Poké Ball, from one drawing.

### Traps hit

- **The spotlight covers the viewport**, so `pointer-events: none` is not
  optional — here it would swallow the very button the tour is telling you to
  press. It is a real element rather than a `::before`, so `verify_app.mjs`'s
  pseudo-element rule does not cover it and `verify_tutor.mjs` asserts it
  instead.
- **Hazel is bottom-LEFT because the Poké Balls are bottom-right.** A mascot
  standing on the easter egg would have been the first bug reported. Asserted
  against `.pb-stack`'s own rule so neither can drift onto the other.
- **`column-reverse` put Hazel above the bubble** at the mobile breakpoint,
  because the children are `[spot, bubble, me]` and reversing them floats the
  figure to the top of the screen.
- **A step that changes tab renders 220 ms later** — it navigates first and
  speaks once the tab is up. The test walked it synchronously, clicked Next
  twenty times into a bubble that never changed, and the failure looked like
  the tour not terminating.
- **A stub `text` getter that ignores `innerHTML`** reads every bubble as
  empty. Four assertions failed on the stub rather than on the code.
