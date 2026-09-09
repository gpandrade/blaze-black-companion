# The Pokémon Factory and the Bag

Pinned by `tools/verify_factory.mjs` and `tools/verify_items.mjs`.

This is the archaeology — why the code is shaped the way it is, and which
mistakes shaped it. Read it before changing anything it describes; most of
what looks arbitrary here is load-bearing, and the note says which bug made
it so.

---

## The Pokémon Factory — `app/js/factory.js` + `tabs/factory.js`

Party and every box as a sprite grid, with move / delete / edit / duplicate /
create, an editor modal, undo, and a **verified download**. The model
(`factory.js`) has no DOM in it; `tabs/factory.js` draws it.

**Nothing touches the loaded save.** The Factory clones on construction, every
edit lands in that clone, and `output()` refuses to hand back bytes unless all
three integrity tiers verify *and* every record still re-encodes. The user
places the download themselves. That is deliberately more friction than a
write endpoint — the file is expensive to lose.

**The party is not just another box.** A party slot is 220 bytes: a 136-byte
record plus an 84-byte extra holding level, current HP and the six computed
stats. That extra is **cloned from a real party member and patched, never
built from scratch** — bytes 0x18..0x53 are populated in every record and are
plainly uninitialised junk (one save carries the ASCII `"ata.c"` in there, a
fragment of a filename left in emulator memory). There is no way to prove
offline that the game ignores them, so it starts from bytes the cartridge has
already accepted. `Save.patchPartyExtra()` is the only writer.

The party must also stay **contiguous and non-empty**: `writeParty()` compacts
and sets the count header, and removing the last member is refused. **A swap
never changes party size, so it does not exercise the count header** — that
gap let a mutant through once, and `verify_factory.mjs` now shrinks and grows
the party explicitly.

**Layout: Party and Battle Box are always on screen**, above the PC box, not
entries in a sidebar. They hold six each against a box's thirty, so a shared
menu wasted its width on them and buried the party — which is the thing you
move Pokémon *into*. The Battle Box can be hidden (remembered in
`localStorage`), and one PC box is always shown, chosen by a chip row.

**Multi-select and sorting.** Ctrl/Cmd-click picks out several, Shift-click
takes a run **within one area**. The selection itself is keyed by
`loc:index`, so it can span the party and a box — which is the point of the
layout: pick two out of a box and drop them in the party in one gesture.
Multi-move
**inserts**: the selection is lifted out and dropped at the target slot with
the destination closing up around it. Fill-the-gaps was tried and rejected —
inside a full box it is a silent no-op, because the slot a Pokémon is lifted
out of is the first free one again. A **single** move still swaps; Shift
forces insert. Sorting compacts to the front and breaks ties on dex then
level, so sorting twice is idempotent — which is the cheap way to prove a
comparator is a total order, and is asserted.

**Bulk box organization** is two operations, deliberately separate.
`sortAllBoxes` sorts each box **independently** — nothing moves between boxes,
which is what makes it safe here: teams live in their own boxes, the living
dex spans 11–15, Box 1 is Pokémon actually caught. Order *inside* a box is not
load-bearing for any of that; box **membership** is. `regroupBoxes` does move
Pokémon between boxes (the "put all the Grass types together" one), so it
reports how many would change box and warns that box-based organisation gets
scattered. Both are a **single undo step** — undoing a bulk operation halfway
is worse than not offering it.

**`--ember` plus white fails in dark mode — and so does an opacity over the
fix.** See **The aesthetics pass** for the second half of this: `--fx-go-*` is
correct and was then wrapped in `opacity: .42`, which undid it. `--ember` is `#B8410F` light and
`#FF8552` dark; white on that light orange measures **2.41:1**, and a
`filter: brightness()` hover took it to **2.06:1** — which is why a button
label vanished under the cursor. `factory.css` defines `--fx-go-bg` /
`--fx-go-ink` per theme (7.08:1 light, 7.35:1 dark) and hover moves contrast
*up*. Use those for any filled accent button; never `--ember` + `#fff`.

**No shiny sprite art exists.** The wiki clone ships one sprite per species
and no shiny variants, so shininess is shown with a gold ring and a badge. Do
not "fix" this with a hue-rotate filter — that invents colours the game does
not use.

**Illegal on purpose.** The editor writes abilities and moves the species
cannot legally have, because Gen 5 reads those bytes directly and this is a
feature here. They are flagged, never blocked. **Typing is the exception** —
it lives in the ROM's species table, not the save, so the editor says so
rather than leaving it a mysterious gap.

`tools/verify_factory.mjs` covers both halves: the model (every op, asserting
the save still verifies and re-encodes after each) and the UI (mount against a
stubbed DOM, click a slot, arm a move, complete it, open the editor, save,
download). It **adapts to the save it is given** — an early save with empty
boxes skips the box tests instead of failing, and nothing asserts a literal
nickname or box number.

## Changing a Pokémon's ball — Factory

`Factory.setBall()` writes body `0x75`. Cosmetic in Gen 5 — the summary screen
and the send-out flash, nothing else — which is exactly why it is worth having:
it is the one part of a record you would change purely because you want to.

**Every ball is offered, not the ones in your bag.** The field costs nothing to
change, so pretending there is stock to spend would be inventing a rule. The
ids come from the ROM's item table filtered to the ball category, never
hardcoded, so a hack that renamed one still shows the right name.

It goes through `patchAt()`, not `buildRecord()` — the latter rebuilds from a
whole spec and would reset anything the spec omits. The test asserts species,
nature, ability, item, exp, nickname, OT, ids, moves, EVs and IVs are all
identical afterwards.

## Healing is a party-only operation

`Factory.healParty()` is a Pokémon Centre without the walk: full HP, full PP,
status cleared. It touches **only the party**, because a boxed Pokémon has no
stored HP or status at all — those live in the party extra block — so
"healing" one would mean its PP alone, and it leaves the box at full anyway.
Max HP comes from the game's own `stored_stats`, not a recomputation. A heal
with nothing to restore takes no undo step and sets no dirty flag.

## PC box wallpapers — the save already knew

**`Save.boxWallpapers()` reads the wallpaper the game gave each box, 0..15.**
They sit immediately after the names in the box-name block: 4 bytes of
selected-box index, then 24 names at stride `0x28` (`0x3C0` bytes), so the
wallpapers start at **`0x3C4`**.

`parse_save.py`'s docstring says `0x3C0`, which forgets the leading u32.
The tell that `0x3C4` is right: it reads `0,1,2,…,15,0,1,2,…` — the game
cycling sixteen wallpapers over twenty-four boxes — while `0x3C0` reads four
zeros first and then the same run, shifted.

Every box in the Factory was the same grey rectangle, which is the part of
that tab that least resembled a PC. The index now picks one of the four wagara
patterns and a hue, plus a colour tab on the box's name. **Sixteen background
images would be someone else's art and sixteen more files to ship**; this comes
out of the system already in the repo. It sits UNDER the cells, which carry
their own opaque background, so no sprite or label is ever on top of it and
the Factory still measures zero below-threshold text.

**The party fills its card now.** `.fx-grid.fx-strip6` capped six-slot areas at
`repeat(6, minmax(0, 96px))` to stop the party rendering as "six huge tiles" —
but the party card and the box card are the SAME width and both grids are six
columns, so plain `1fr` makes a party cell exactly a box cell. The cap only
ever made the party hug the left of its card with a third of the width empty.

**The sprite plinth is everywhere now**, not just the Team Builder: Factory
cells, the pickers, the species grid. The same sprite sitting on a tile in one
tab and on nothing in another is most of why the Factory read flatter than the
rest of the app.

## Nature marks on stat lists

The game colours the raised and lowered stat on the summary screen; the
Factory's detail panel and the Team Builder's spread do the same, with no
legend — anyone using this knows what the two colours mean.

**`natureEffect(id)` in `js/tables.js` derives it from the id**, because Gen 5
packs it there: `id / 5` is the stat raised, `id % 5` the stat lowered, over
**`[atk, def, spe, spa, spd]`**. Note **speed sits THIRD** — that is the save's
stat order, not the order stats are printed in, and getting it wrong
highlights the wrong pair and nothing else. The five ids where both land on
the same stat (0, 6, 12, 18, 24) are the neutral natures.

`verify_factory.mjs` pins three natures whose pairs span the ordering
(Adamant, Timid, Careful), that exactly five are neutral, and that a rendered
stat list actually carries the marks.

The Builder's spread is computed **before** the nature, so the mark is the
only thing there saying which two numbers will move — it earns its place more
there than on the Factory's real figures.

## The Bag — `app/js/tabs/items.js`

The game's own five pockets in the game's own order, plus the two things the
in-game bag cannot do:

- **A TM is only interesting if somebody can learn it.** `state/personal.json`
  carries each species' real `tmhm` list, so a TM row reads *"45 of yours can
  learn it · party: Mewtwo"* instead of leaving you to check 274 Pokémon by
  hand. Sort by it, or filter to learnable-only.
- **A held item in the bag is doing nothing.** Comparing the bag against what
  the party is actually holding surfaces the 32 unequipped held items sitting
  in there.

Search, sort (bag order / name / quantity / value / who-can-learn-it) and a
per-pocket filter. Descriptions are the ROM's own text, which is what
documents a hack-changed effect.

**`setBagItem()` is the only new save-writing code.** A pocket is a flat array
terminated by a zero id, so removing an entry means shifting everything after
it down — **leave a hole and the pocket truncates there**, silently losing
everything past it. `verify_items.mjs` mutation-tests exactly that: writing a
zero in place instead of shifting turns a 39-item pocket into 0.

**Equip and teach, from either direction.** `app/js/pick.js` is one shared
chooser: the Bag says "give this to…" / "teach this to…", the Factory says
"give it something" / "teach it a TM". Same gesture, different filter, one
implementation so the two tabs cannot drift apart.

Both go through `Factory.patchAt()`, which decodes a record, changes **only**
the bytes asked for, and re-encodes. `buildRecord()` is wrong for this: it
rebuilds from a whole spec, so anything the spec omits would come back as a
default. A test gives an item and asserts species, level, nature, ability, IVs,
EVs *and* moves are all byte-identical afterwards — mutation-tested by
clobbering an unrelated move, which it catches.

**Gen 5 TMs are reusable**, so teaching does not consume one. Teaching resets
that slot's PP Ups, because PP Ups belong to the move that was there, not to
the slot.

Mart inventories and hidden items are still not extracted, so the tab says
nothing about where to buy anything.
