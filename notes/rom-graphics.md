# Decoding the ROM’s graphics

Pinned by `python3 tools/ncgr.py selftest`, which `./test-all` runs.

This is the archaeology — why the code is shaped the way it is, and which
mistakes shaped it. Read it before changing anything it describes; most of
what looks arbitrary here is load-bearing, and the note says which bug made
it so.

---

## The graphics decoder — `tools/ncgr.py`

    python3 tools/ncgr.py probe a/0/0/4      # what is in a NARC
    python3 tools/ncgr.py selftest           # prove it against known answers

**A KNOWN-ANSWER TARGET FIRST, AND IT EARNED ITS KEEP.** Four things go wrong
in an NCGR decoder — nibble order, tile arrangement, palette format, LZ11 —
and every one produces the same symptom, a garbled rectangle. Debugging that
against a trainer portrait means guessing which of the four is wrong from a
picture you have never seen.

So it is proved against `wiki/docs/img/pokemon/NNN.png`: those are 96×96 4bpp
palettised PNGs, which is the BW sprite format exactly, and they turn out to
be genuine ROM rips.

**The selftest runs two checks that fail differently, which is the whole
point:**

| Check | Isolates |
|---|---|
| tile **multiset** — the 144 8×8 tiles as a bag | LZ11, nibble order, the tile cut. Independent of placement. |
| **pixel-exact silhouette** | all of the above *plus* arrangement |

Currently **20/20 on the multiset and 1/20 pixel-exact**. That is not a
mystery, it is a precisely located gap: the tiles are right and where they go
is not. Judging the output by eye could never have told those apart — a
correct-tiles/wrong-places image looks exactly like a wrong nibble order.

### What is proven

- **LZ11**, including that the 3- and 4-nibble backreference forms carry
  different length biases (+17 and +273). Getting that wrong walks off the
  window and yields plausible noise.
- **NCLR**: BGR555, five bits per channel, scaled by `(v << 3) | (v >> 2)` so
  white lands on 255 rather than 248.
- **NCGR header offsets.** `0x00` height, `0x02` width (both in TILES),
  `0x04` depth, `0x0C` tiled flag, `0x10` data size, `0x14` data offset,
  data at `0x18`. Being one field out here parses cleanly, reports plausible
  sizes and decodes to noise.
- **4bpp nibble order**: low nibble is the first pixel.
- **`a/0/0/4` is one group of 20 files per species**, and the first NCGR of a
  group is the 96×96 front sprite — so `dex * 20` is that species' sprite, and
  the two palettes just before it are normal and shiny. Confirmed for the
  first twenty by multiset match, which a wrong arrangement cannot fake.

### The arrangement: 64×64 BLOCKS, not rows

This was the last piece and it is the OAM object grid showing through. A DS
sprite is assembled from hardware objects, the largest of which is 64×64 —
**eight tiles square** — so the file is a sequence of 8×8-TILE BLOCKS in
reading order, and only *within* a block are the tiles row-major. A 96×96
sprite is four blocks:

    tiles   0.. 63  ->  block (0,0), 8x8 tiles
    tiles  64.. 95  ->  block (0,1), clipped to 4 wide
    tiles  96..127  ->  block (1,0), clipped to 4 tall
    tiles 128..143  ->  block (1,1), 4x4

**It was recovered, not guessed.** Solving tile→position against 60 reference
sprites produced 99 of 144 positions with **zero disagreement**, and the block
structure was read off that table. Three earlier guesses (row-major,
column-major, vertical bands) each scored 73–99% — close enough to look
right in a picture, which is exactly why the test compares silhouettes.

**Reading the NCER was a dead end, and usefully so.** The NCER in each group
indexes the 256×128 *animation sheet*, not the 96×96 still — its cells are
16×16 and 32×16 objects at offsets like (−23,−27). The still needs no cell
data at all.

### Palettes come AFTER the graphics in a group

`dex*20 + 18` and `+19` — normal, then shiny. The tell is group 0: files 18
and 19 are flat greyscale, which makes sense as the tail of a placeholder
group and no sense as Bulbasaur's colours.

**This one is ranked, not proven.** The reference PNGs were recoloured
somewhere between the ROM and the wiki, so no offset reaches 100% — matching
rendered pixels scores 25.8% exact RGB with `+18` against 7.9% with `−2`. Good
enough to choose, and the selftest asserts the ranking so it cannot silently
flip.

`./test-all` runs the selftest and skips silently without the ROM or the wiki
clone. A multiset failure means LZ11 / nibble order / the tile cut broke; a
pixel failure with the multiset intact means the arrangement broke; a palette
failure means the offset flipped. Three failure modes, three distinct
messages.

## Trainer portraits — `extract_trainers.py`

    python3 extract_trainers.py     # state/trainers.json + app/img/trainers/*.png

95 portraits at 80×80 out of `a/0/7/2`, joined to the game's 105 trainer
classes and its 616 named trainers. `./setup` runs it.

### THE JOIN NEEDED THREE ROM STRUCTURES, NOT ONE

Sprite order follows class id **only as far as class 46**, and the class byte
reaches 102 while there are 95 sprites — so identity cannot hold end to end,
and an off-by-one here is invisible because every neighbouring sprite is also
a plausible trainer.

| Piece | Where | Gives |
|---|---|---|
| class NAMES, 105 | text file **191** in `a/0/0/2` | Youngster, Lass, Leader, Elite Four… (283 is the same list with articles) |
| trainer NAMES, 616 | text file **190** | Cheren, Lenora, Ghetsis, Cynthia, Morimoto |
| trainer → class | **`a/0/9/2`**, 616 records of 20 bytes, index-aligned with text 190 | byte `0x01` is the class |
| trainer → team | **`a/0/9/3`**, index-aligned | see the rival rosters below |
| **class → sprite** | **arm9 at `0x9C23C`**, 105 bytes | the piece that cannot be guessed |

```
class   0..46  ->  sprite = class
class     47   ->  40          48..91 -> class - 1
class     92   ->  71    93 -> 4    94 -> 70    95 -> 74
class     96   ->  75    97 -> 69   98 -> 42    99 -> 41
class    100   ->  91   101 -> 40  102 -> 92   103 -> 93   104 -> 94
```

**Why it is believable, and not just a window that fit.** The table is exactly
105 long — the class count — and its values cover **0..94 exactly**: all 95
used, none out of range. It is **byte-identical in vanilla**. The signature
that finds it (`bytes(range(47)) + 0x28`) occurs **once** in arm9; a plain
`bytes(range(48))` matches twice, which is why the remap byte is part of it.
And the ten collapsed classes are each semantically right: the Undella rich
family reuses the Rich Boy, Lady, School Kid, Socialite, Gentleman and Veteran
portraits, N's two Team Plasma classes reuse his own, and Motorcyclist reuses
Biker. Nine sprites shared by two classes plus one shared by three is exactly
the ten that take 105 down to 95.

The remapped tail is where identity would have failed silently and where the
visual check is strongest: 77 Shauntal with her book, 78 Marshal, 79 Grimsley,
80 Caitlin, 81 Ghetsis, 87 Ingo in black, 88 Alder, 91 Cynthia, 92 Emmet in
white. **Ingo and Emmet are the clincher** — one pose, two uniforms, at 87 and
92, which only the arm9 table puts there.

### THE NAME HAS TO WIN, NOT THE CLASS

Resolving a trainer on their class name alone looks right on route trainers
and is badly wrong on the ones that matter: **five classes are called
"Leader"** and four "Elite Four", so class-first gave Lenora, Cilan, Cress and
Skyla all **Chili's** face and all four of the Elite Four **Shauntal's**.

So `build_static.trainer_face()` looks the trailing NAME up in the ROM's own
616 trainers first, disambiguates with the class the wiki printed beside it,
and only falls back to the class prefix — which is the right answer for an
ordinary route trainer the ROM does not name. This also gets the gender
variants right for free: School Kid Carter is sprite 4, Lydia 5.

`build_sheet.trainer_faces()` does the same join for documented fights, off
the TEAM block header ("Cherens Team"). That regex eats an optional
possessive `s`, which is indistinguishable from a name that ends in one —
`Ghetsis Team` comes back as `Ghetsi` — so the lookup tries the recovered `s`
too rather than special-casing one trainer.

The wiki spells classes its own way and not consistently: `Pkmn Ranger`,
`Pokefan`, `Cycling`, and outright typos (`Morotcyclist`, `Waitres`,
`Plmn Ranger`). `WIKI_CLASS_ALIASES` holds **only** the ones that genuinely
differ; keeping it short is what makes an unmatched name mean "we do not
know" rather than "the fuzzy matcher shrugged". One row is unmatched by
design — `Kumi & Amy D`, where the wiki merged a Twins pair.

### BASE64 IN THE SHEET, PATHS IN THE APP — AND THE ALLOW-LIST

`build_sheet.py` embeds **only the ~20 portraits the encounter cards can
show**, as data URIs, because a published artifact cannot fetch anything (all
95 would be ~380 KB of base64 for twenty pictures). `build_static.py` emits
**all 95 as paths**, because Adventure resolves route trainers by class at
runtime and cannot know in advance which it will ask for. The template reads
whichever it is handed, so the only thing that must match is the key.

**`app/js/roster.js` hands the template an explicit ALLOW-LIST of blob keys,
and leaving one off fails silently.** `TRFACE` was missed the first time: the
template defaults it to `{}`, `face()` renders nothing, and there is no error
anywhere — the cards just came out with no faces. `verify_app.mjs` now asserts
the battle blob carries it and that one renders per fight.

### THE STILL IS SIX OAM OBJECTS, NOT A TILE GRID

Trainers first shipped with litter around their feet, then — after "fixing"
it — with **no feet at all**. Both were the same bug seen from different
sides.

The generic 8×8-tile blocking that is correct for the 96×96 Pokémon sprites
lays the last two tile rows down as one 64×16 strip. The trainer still
actually splits that region into **two 32×16 objects side by side**, so feet
landed in the wrong half of the bottom band, detached from their legs. They
were then mistaken for spare animation tiles and deleted.

**The NCER in each group has the answer, and the earlier "dead end" was a
parse bug**: the bank headers sit at `cellDataOffset`, not `8 +
cellDataOffset`, because `_sections()` has already stripped the section
header. Read correctly, every one of the 95 groups carries the SAME six cells:

```
(0,0) 64×64   tiles  0..63      (0,64) 32×16  tiles 80..87
(64,0) 16×32  tiles 64..71      (32,64) 32×16 tiles 88..95
(64,32) 16×32 tiles 72..79      (64,64) 16×16 tiles 96..99
```

92 of the 95 confirm the tile order independently — their OAM tile indices, at
the mapping mode's 2-tile unit, come out as exactly 0/64/72/80/88/96 and tile
all 100 with no overlap and none out of bounds. The three that do not are
Cheren, Bianca and N, whose NCER describes the 512-tile ANIMATION sheet; they
share the geometry, so `TRAINER_OBJECTS` applies to them too.

**Connectedness is the measure that shows it.** A figure whose feet are in the
wrong place comes apart: the tile grid leaves **355** connected components
across the 95 portraits, the real layout **106**. The selftest asserts that
ratio. Judging by eye at icon size could not tell them apart — which is
exactly how a build with everyone's feet deleted shipped.

Cropping was never the answer either: 71 of 95 have real figure below y=64.

## The gym badges — `python3 tools/ncgr.py badges`

**The NCER said so, and nothing else was going to.** The eight badges are ONE
graphic — `a/0/4/0` file **27**, whose own header gives width and height as
`0xFFFF` — and the shape that makes sense of it is in the cell bank beside it,
file **45**, whose first eight cells are each a single 32×64 OAM object:

```
cell 0: (-16,-32) 32x64  tile   0  palette bank 0
cell 1: (-16,-32) 32x64  tile  32  palette bank 1
...
cell 7: (-16,-32) 32x64  tile 224  palette bank 7
```

**Two guesses at the stride each produced plausible fragments.** 552 rows
divides evenly by 24 (23 tiles) and by 32 wholly enough to look deliberate, and
both slicings rendered recognisable *pieces* of badges — a pointed top here, a
vertical bar there. Neither is right. That is the trap this project keeps
re-learning: at icon size a wrong arrangement looks like a slightly odd sprite,
not like an error.

**The per-badge palette bank is why every early attempt was monochrome.**
Rendering the whole sheet with one bank makes all eight the same colour, which
reads as "wrong palette" rather than "wrong model".

**Parsing the NCER has the same gotcha the trainer stills hit**: the bank
headers sit AT `cellDataOffset`, not at `8 + cellDataOffset`, because
`_sections()` has already stripped the section header.

**Which palette FILE was decided by measurement, not by eye.** The NARC holds
25 NCLRs of 16 banks. Each candidate was scored by the dominant hue of the four
badges whose colour is not in doubt — Insect green, Bolt yellow, Quake orange,
Jet blue. File **3** wins at 36° of mean hue error; the next two agree with it
and everything else is 90°+ out. That gap is what makes it a decision.

**The selftest checks the CUT, not the count.** The first version asserted that
the eight slices were distinct and inked — which a 32-row stride also satisfies,
because the fragments are still distinct and still inked. The check with teeth
is that **every slice opens and closes on an empty row**: a badge sits inside
its OAM cell with clear space above and below, so a stride that cuts through
one is caught immediately. Mutation-tested against exactly the stride that
fooled the eye.

**They are cropped to their own ink** on the way out. The 32×64 source is the
OAM object size the hardware needed, not the badge's extent; shipping the
padding would make eight badges of wildly different apparent size in a row.

## Party icons — `python3 tools/ncgr.py icons`

`a/0/0/7`: file 0 is an NCLR with **three** 16-colour palettes, then icons at
**odd** indices with the even ones empty padding — species `dex` is file
`7 + 2*dex`. Each is 32 tiles = 32×64, which is **two 32×32 frames** (the
party screen bobs between them); the first is the still.

**The per-species palette selector is not findable** — not a byte array in
arm9, not 2-bit packed, not in the personal table, not in the NARC. It is
presumably in an overlay. So it is **chosen by matching the icon's mean colour
against the species' own sprite**, and is RANKED, NOT PROVEN, exactly like the
shiny-palette offset.

Exact RGB matching fails outright: the icons use a coarser palette than the
sprites and the wiki's PNGs were recoloured. Mean colour works, because the
recolouring kept hue. Bulbasaur lands on the green palette, Charmander on the
orange, Pikachu on the yellow — the selftest pins those three. Median margin
between best and second-best is 29%; ~70 of 649 come in under 5%, and those
are the greys and purples where two palettes really are close.

**The top eight rows are cropped, provably losslessly.** Every icon's highest
ink is row 8 — that band is headroom for the bob the party screen animates —
so the emitted PNG is 32×24. Without it the sprite sits low in its own box and
reads as off-centre beside text; the shared baseline survives because every
species is cropped by the same amount.

**Use them where a picture is an IDENTIFIER, not the subject.** A 96×96 sprite
is right in a picker or a box grid, where you are recognising something, and
wrong in a dense list beside text. The Bag's "in your party" row for a TM is
the first place they landed.
