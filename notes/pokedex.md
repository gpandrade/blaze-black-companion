# The Pokédex, and what Drayano changed

Pinned by `tools/verify_dex.mjs`.

This is the archaeology — why the code is shaped the way it is, and which
mistakes shaped it. Read it before changing anything it describes; most of
what looks arbitrary here is load-bearing, and the note says which bug made
it so.

---

## Why its own tab, and not part of the Factory

It was a real question and the answer decided the shape of the whole thing.

**The Factory's mental model is "this is my save."** Every operation in it
mutates a record. Dropping a read-only reference to 649 species you mostly do
not own makes that model false, and the Factory is already the densest surface
in the app — party, Battle Box, a 30-slot grid and an editor modal.

**And the change data has no home there at all.** "What did this hack do to
Farfetch'd" is a fact about the *game*, not about your box. It is also the
single most-asked question about any Drayano hack, and the thing this project
can answer better than anything else in existence, because it reads both ROMs.

So: its own tab, wired to the Factory in the one direction that means
something — **"Build one in the Factory"** on a species card. Discovery matters
too: nobody looking up a species thinks to click "Factory".

## It is the only save-free tab

`needsSave: false`. Looking up what the hack did to a Pokémon should not
require loading a save first, and this is the tab someone opens before they
have any of the rest set up.

That has one consequence in the shell: `selectTab` passes `state.ctx`, which is
**null until a save loads**. A save-free tab handed `null` throws on its first
`ctx.S` and presents as "the tab is broken" rather than "there is no save yet",
so `app.js` falls back to `{ S, config }`. Everything save-derived — how many
you own, where they are, the Factory handoff — is *additive* and simply absent.

## The blob had to grow, and `learn` was not enough

`SPECIES[].learn` is a flat **set of move ids** — exactly right for the
Factory, which asks "may this species legally hold this move", and useless for
reading, because it cannot say *when* anything is learned.

`lvl` is the level-up list as `[level, moveId]` pairs, in order. Both ship.
Conflating them is the obvious mistake and it silently loses every level.

Also added: `bst`, `ev`, `catch`, `exp`, `eggs`, `hatch`, `friend`,
`curveName`, and **`evoFull`** — method *and* parameter, not just the name it
becomes. "Level 39" versus "trade" is the whole point in a hack that removed
21 trade evolutions.

**Egg group names are in `build_static.py`, not the ROM.** The ROM stores ids
and its text archive has no name table for them. The 1-based mapping is
verified against species whose groups are not in doubt: Bulbasaur 1/7
(Monster, Grass), Pikachu 5/6 (Field, Fairy), Charizard 1/14 (Monster,
Dragon), Ditto 13, Articuno and Dialga 15 (Undiscovered).

## The diff had to be extracted, not just counted

`state/rom_diff.json` carried **totals plus three hand-picked detail lists** —
enough for a changelog, useless for the question people actually ask.
`diff_report()` now also emits **`by_species`**: vanilla and hack side by side,
for the fields that moved, keyed by species id as a string.

**610 of 649 species changed.** 487 abilities, 516 level-up sets, 138 stat
lines, 79 TM lists, 33 evolutions, 18 typings, 38 EXP yields, 8 hidden
abilities, 1 growth curve. The file went 15 KB → 218 KB and the blob
937 KB → 1266 KB, which is the right trade for the tab that justifies the
project's central claim.

Two things worth keeping:

- **Only the fields that moved.** A six-key stat dict where five entries are
  unchanged makes the reader do the diffing the file exists to do.
- **The hidden ability is tracked separately.** The abilities count compares
  `ability_ids[:2]`, so a hack that only changed hidden abilities would have
  reported zero. Eight species did exactly that.

**`DIFF` IS OPTIONAL AND THE TAB MUST DEGRADE, NOT LIE.**
`extract_personal.py` refuses to emit a diff without an unmodified ROM to
compare against. Someone who extracted that way gets a Pokédex with **no
change badges and no "what changed" mode** — never one quietly implying
nothing changed, which would be a false claim about the hack rather than a
missing feature. `verify_dex.mjs` mounts the tab against a blob with `DIFF`
deleted and asserts exactly that.

## Three shapes that fail silently

None of these throw. All three render dashes all the way down and look like a
species with no data, which is the worst failure mode this tab has — so all
three are asserted directly against the blob:

| Table | Shape |
|---|---|
| `S.MOVES` | keyed by **name**, short fields: `t` `c` `p` `acc` `pp` `pri` |
| `S.AREAS[area]` | a **list** of rows; `mons` carry `id` and `pct`, not names |
| `S.SPECIES[].lvl` | `[level, moveId]` pairs, not move objects |

The encounter join matches on **species id**, not name: a name in an encounter
table is the one thing not guaranteed to be spelled the way the species table
spells it.

**The level-as-percentage defect is respected here too.** A row flagged
`suspect` has a legendary or static encounter merged into it by the wiki's
generator, and the inflated number is a *level*. The tab shows the method and
withholds the percentage rather than repeating the defect.

## Move-first search

*"Which of mine can learn Trick Room"* is a question the game cannot answer and
the wiki answers 649 pages at a time. Everything needed was already in the
blob — the level-up list per species, the TM/HM list, and `TMMOVE` — so this is
a join, not new data.

**IT MUST COUNT TMs.** The level-up list alone answers a much less useful
question: most of what you actually teach comes from a Machine, and a search
saying "nothing learns Ice Beam" while TM13 sits in your bag is worse than no
search at all. Ice Beam is 219 species, and the great majority reach it by TM.
Mutation-tested by removing the TM branch.

**Exact match only.** A substring would make "ice" mean Ice Beam, Ice Punch,
Icicle Crash and Ice Fang at once, and the answer to "who learns ice" is not a
useful list. A partial name falls back to an ordinary species search.

**The row says HOW** — `L37` or `TM13`, in the column where the stat total
normally sits — and a level is coloured differently from a Machine, because one
you get by playing and the other costs a TM you may not own. That column
needed a **banner** explaining itself, or a move search looks like a name
search that matched a surprising set.

Every other filter still applies on top, which is the combination that answers
the real question: *which Water type of mine learns this*.

## Redraw the LIST, not the toolbar

Typing in the search box calls `redrawList()`, which replaces only
`#dx-list`. Rebuilding the toolbar would recreate the `<input>` and **drop
focus on every keystroke** — the search box would accept exactly one
character at a time. `verify_dex.mjs` asserts the input node is the *same
object* after a search.

The list also **caps at 400 rows** with a "narrow the search" line. 649 rows of
sprite-bearing markup is a real cost on every filter change.

**A count assertion must read the count line, not the rows.** The first version
asserted "fewer rows than 649 species" after clicking a filter tile — which the
400-row cap satisfies whether the filter ran or not. It reads the rendered
"N species" line now, and reads it *before* switching modes, because the count
line only exists in the browse list.

## Two things it shipped wrong, and they were the same thing twice

**The toolbar had no surface, and its buttons were clipped to an 8px strip.**
Both faults came from the same omission and they compounded, which is why the
symptom read as "there are buttons at the top being covered".

1. `.dx-bar` was a bare flex container — no padding, no background, no border —
   so its controls sat directly on the page ground with the wagara texture
   showing through between them. Every other tab's toolbar (`.fx-bar`,
   `.it-bar`, `.tb-bar`, `.ad-bar`) is a card *and* is registered by name in
   `theme.css`'s toolbar family, which paints the seigaiha band, the neon
   hairline and the cut corner. The Pokédex was in neither list.
2. **The stat bar was ALSO called `.dx-bar`.** So the toolbar inherited
   `height: 8px; overflow: hidden` from the stat-bar rule and clipped its own
   controls to a strip.

The second is the third time this project has shipped the same trap: *never
define one simple selector twice in a stylesheet with conflicting values*. It
hid because until the toolbar gained a background the two rules set **disjoint
properties** — invisible to the eye and invisible to the duplicate check, which
only reports selectors that actually conflict. Adding the background is what
made it conflict, and only then did it get caught. The stat bar is `.dx-sbar`
now.

**Two guards, both mutation-tested.** `verify_app.mjs` asserts every `xx-bar`
class the JS emits carries **both** marks in `theme.css` — a `::before` band
and a `> *` lift for its children. A bar with the band and no lift is worse
than one with neither, because the pattern then paints over its own controls.

**Depth belongs to `theme.css`, not to `dex.css`.** `dex.css` loads last, so a
`box-shadow: var(--shadow)` here wins on equal specificity and silently drops
`var(--rim)`. Seven such declarations were removed; the one that survives
(`.dx-changed`) restates `var(--rim)` explicitly alongside its accent inset.

## Sprites are the thing you scan by

They shipped at 32px in the list and 80px on the card — smaller than the text
beside them, which meant reading *names* to find a Pokémon in a list of 649,
the exact job the sprite is there to save you from. 48px in rows, 120px on the
card. The wiki's art is 96px native, so both are clean downscales.

## The Factory handoff is a one-shot message

`localStorage.bb_dexcreate` carries `{speciesId}`; the Factory reads it on
mount and **clears it immediately**. Without the clear, the tab reopens the
same create modal every time you visit it for the rest of the session.

`openEditor(mon, at, { speciesId })` takes the species as a third argument
rather than as a fake `mon`. Passing a synthetic record instead would make
`creating` false and turn a create into an *edit of a slot that holds nothing*.

It lands in the first free box slot, scanning all 24; if the PC is genuinely
full it says so rather than opening an editor that cannot save.

## The four disputed evolutions are stated, not resolved

A species whose evolution reads `level-up-know-move` with a parameter that is
an **item id and not a move id** gets a standing disclaimer on its card. The
ROM says "knows move 221"; 221 is King's Rock; the intent is plainly "level up
at night holding it" and Drayano's docs say so. Whether the game honours the
intent or the bytes is untested, and the card says that rather than picking
one. All four are catchable in the wild regardless, so nothing is blocked
either way; one night and a King's Rock settles it.

## "Nothing learns it" is not "nobody can get it"

Exactly two moves in the ROM have neither a level-up learner nor a TM:
**Struggle**, which is a mechanic, and **Draco Meteor**, which is the Opelucid
**move tutor**'s move — and tutors are not extracted from the ROM.

So a bare `0 learn Draco Meteor` is a *wrong answer*, not an empty result: it
tells someone building a dragon team that the strongest special Dragon move in
the game is unobtainable. The zero case says what we do not know instead,
naming the tutor as the likely source and admitting the app has no tutor data.

`verify_dex.mjs` pins both halves — the note appears for Draco Meteor and is
**absent** for a move with learners, because a note that always shows is
decoration rather than an answer. Mutation-tested in both directions.

## A search mode nobody can find is a feature nobody has

The move-first search shipped reachable only one way: type a move name into a
box whose placeholder was captioned for species, with "or a move" as the last
clause of a list. That is a feature you can only use **if you already know it
is there**, and it was reported as exactly that the day after it shipped.

Two changes, and only the second one matters.

The placeholder now names the move case as its own clause — *"A species or dex
number — or a move, to see who learns it"*. That is worth doing and would not
have been enough on its own: a placeholder is gone the moment you type, and
people do not read the caption of a box they already know how to use.

**The fix is that it advertises itself with buttons.** A hint row above the
list offers three example moves as chips; pressing one runs the search. You
discover the mode by *using* it, which is how the rest of this app teaches —
and the answer that comes back, a list of 86 species with `TM92` and `L40`
against them, explains the feature better than a sentence could.

The examples are deliberately chosen and deliberately mixed. **Trick Room** is
85 species by TM and one by level-up; **Dragon Dance** is 30 by level-up and no
TM at all. Between them the column shows both answers it can give, so the
demonstration is complete rather than lucky. All three are *strategy* moves,
because "which of mine can learn Trick Room" is the question the feature exists
for — the game cannot answer it and the wiki answers it 649 pages at a time.

**The hint stands down once a move search is running.** It has done its job,
and the banner above the list is already naming the move. A hint that persists
is decoration.

Three things `verify_dex.mjs` pins, each mutation-tested:

1. The hint is present while browsing.
2. **Pressing a chip actually narrows the list** — 649 species to 86 learners —
   not merely captions it. A chip that only filled the search box would satisfy
   a text assertion and teach nothing, and the box lives in the toolbar, which
   the list redraw deliberately does not rebuild. That is exactly the wiring
   that can go missing silently.
3. It is absent during a move search.

The assertions are also **guarded against the element's absence**, because the
first mutation test threw at `chips[0].onclick()` and a throw skips every
assertion after it in the file — a missing feature would have masked unrelated
regressions instead of reporting itself.

## Exact-match-only was too stiff, and it failed silently

The move search shipped requiring the **whole name, exactly**. The stated
reason was sound as far as it went — a substring makes `ice` mean Ice Beam,
Ice Punch, Ice Ball, Ice Shard, Ice Fang and Ice Burn at once, and *"who learns
ice"* is not a useful list. What did not follow is that the answer is to match
**nothing** until the final letter.

Reported as *"too stiff — I had to type the full move name."* The real damage
is worse than inconvenience: while the query matched nothing, the tab looked
**exactly like a tab with no move search in it**. A feature that is invisible
until you get it perfectly right is a feature most people never see work.

It resolves **progressively** now. Both sides are normalised with punctuation
and spaces stripped, and a query fires the moment a prefix is unambiguous:

| typed | result |
|---|---|
| `Tri` | ten candidates, offered as chips |
| `Trick` | **Trick** — exact wins — with Trick Room a click away |
| `Trick R` | Trick Room |
| `vcreate`, `v-create` | V-create |
| `uturn`, `willowisp` | U-turn, Will-O-Wisp |

Three rules hold it together:

1. **An exact match beats a longer name that merely starts the same way.**
   Without this, `Trick` can only ever mean Trick Room and the shorter,
   exactly-named move is permanently unreachable. The alternatives stay on
   screen as chips either way, so resolving is never a dead end.
2. **Ambiguous offers rather than swallows.** While several moves match, none
   is chosen, the species list underneath is untouched, and the candidates are
   chips you can press. That is the state the old rule rendered as silence.
3. **Under three characters, nothing is offered** — `ic` is a keystroke, not a
   question — and the chip list caps at eight, because past a handful a
   suggestion list has become a second problem.

**It is safe because there are zero species/move name collisions in this ROM**,
checked across all 649 species and all 559 moves. A forgiving move match
therefore cannot hijack somebody looking for a Pokémon, and `verify_dex.mjs`
asserts a species search still works after all of the above.

All five behaviours are mutation-tested. One mutation is worth recording: the
first attempt at breaking rule 1 — preferring a single prefix hit over the
exact one — **changed nothing**, because with two candidates it fell through to
exact anyway. `cands.others[0] ?? cands.exact` was the mutation that actually
inverted the rule, and it failed four assertions. A mutation that does not
change behaviour proves nothing about the test.

One bug the new assertions caught immediately: `moveChips` renders what it is
handed, and the alternatives arrive as `[id, name]` **pairs** rather than
names — every chip rendered as an empty button. The assertion that names the
chips' text found it; one that counted them would not have.
