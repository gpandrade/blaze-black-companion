# The JS save layer

A zero-dependency ES-module port of the PK5 read/write path out of
`parse_save.py` and `write_team.py`. With it a `.sav` can be dropped into a
page and read, edited and downloaded entirely client-side — no server, no
upload, the file never leaves the machine.

This is the keystone the roadmap named: it unlocks the save upload,
the team builder saving named teams back into the companion, and the
"hacked Pokémon factory" (upload sav → build a Pokémon → download sav).

```
js/
  pk5.js      crypto + record codec + stat/experience math   (pure, table-free)
  save.js     slots, blocks, checksums, readers, writers, the three-tier reseal
  tables.js   natures + Gen 5 ability names (embedded); ROM tables (loaded)
  mon.js      presentMon() and buildRecord() — the two directions of the join
  index.js    the barrel; import from here
  demo.html   a working drop-a-save page
```

## Quick use

```js
import { Save, Tables, presentAll, buildRecord } from './js/index.js';

const save   = Save.load(await file.arrayBuffer(), { lastModified: file.lastModified });
const tables = await Tables.fetch('./state/');          // personal/moves/items JSON
const team   = presentAll(save.readAll(), tables);      // party, 24 boxes, Battle Box

const rec = buildRecord(save.recordBytes(1, 2), {       // clone box 2 slot 3
  species: 'Metagross', level: 50, ability: 'Iron Fist', nature: 'Adamant',
  moves: ['Meteor Mash', 'Earthquake', 'Bullet Punch', 'Zen Headbutt'],
  item: 'Leftovers', shiny: false,
}, tables);

const edited = save.clone().writeBox(8, [rec]);         // reseals all three tiers
if (edited.verify().ok) download(edited.toBytes());
```

`Save` methods that change bytes write **both** save slots and reseal by
default. `clone()` is a real deep copy, so the loaded save is never mutated
behind your back.

## Testing

```bash
./test-js          # regenerates Python ground truth, then checks the port
```

`tests/dump_pk5_truth.py` runs the Python readers and writers over a corpus
and dumps every value the port must reproduce; `tests/test_pk5.mjs` asserts
equality field by field. The point is not that the JS agrees with itself — it
is that it agrees with the code that has actually been trusted with the real
save.

The corpus is `tests/fixture.sav` (small, frozen) **plus the newest file in
`save_backups/`** (dense: 24 exposed boxes, ~265 records, a Battle Box,
engineered Pokémon, shinies). The fixture alone would never touch a box
record. The dense corpus is pinned by CRC16, so if the file changes the test
says the truth is stale instead of comparing against it.

What it checks, end to end:

- all six experience curves across levels 1–100
- every record's every field, including the raw 128-byte decrypted body
- `encode(decode(x)) === x` byte-for-byte on every populated record
- every block CRC, every inline checksum, every central-table entry
- `buildRecord` matching `write_team.build_record` **byte for byte**
- the whole 524288-byte file after write + reseal hashing identically to what
  `write_team.py` produced
- the demo page's render path against a stubbed DOM

Everything is read-only with respect to the live save; the write-path checks
run in memory.

## The demo page

ES modules will not load over `file://`, so serve the repo:

```bash
python3 -m http.server 8080
# then open http://localhost:8080/js/demo.html
```

Drop a `.sav` on it. It reports slot selection, verifies all three integrity
tiers, re-encodes every record to prove the codec round-trips, lists the
party / boxes / Battle Box, and offers the file back as a download — including
a "raise box capacity to 24" edit that exercises the write path.

Downloads work here because it is a local page. Inside a Claude artifact the
viewer sandbox blocks them, which is one reason this is not published as one.

## Things that will bite you

**`Math.imul` is load-bearing.** The LCRNG step is
`seed * 0x41C64E6D + 0x6073 mod 2^32`. Plain `*` overflows float64's exact
integer range, silently loses low bits, and every decode downstream turns to
noise. The test suite pins one LCRNG step for exactly this reason.

**Two stat orderings.** The save stores HP/Atk/Def/**Spe**/SpA/SpD; everything
this layer emits is keyed `hp/atk/def/spa/spd/spe`. Speed is 4th in the save
and 6th in the output. Conversion happens at the decode boundary and stat
tuples never travel as bare arrays. Never index stats positionally.

**Three integrity tiers, or the game wipes the save.** Each block's inline
checksum two bytes past its end, the central table entry at `0x23F00`, and the
footer CRC over `[0x23F00, 0x23F8C)`. The third is the one people forget:
refreshing only the first two passes every check a reader knows about, and the
game still declares the save corrupt and offers to delete it. `reseal()` does
all three in both slots; `verify()` recomputes all three and names what
disagrees — call it before offering a download.

**The game only exposes 8 boxes by default.** The u8 at `0x3DD` is how many
boxes it shows. A write to box 9+ succeeds, passes every checksum, and is
invisible in game. `writeBox` warns when the target is past `boxCapacity`;
`setBoxCapacity(24)` fixes it.

**`buildRecord` clones, and the clone inherits.** It patches a known-good
record so every byte the codec does not model — origin game, language, ball,
met location and date, encounter type, ribbons — is carried over instead of
guessed. Which means if the template is shiny, so is the clone. `shiny` is
three-valued: `true` forces shiny, `false` forces normal, **omitting it keeps
the template's**.

**A cleared slot is not an all-zero slot.** The game rewrites cleared slots
with a valid non-zero checksum and species 0. Reading one as a real record
miscounts every box, so `decodeRecord` returns null for it.

**Typing is not in the record.** Species, ability, moves, nature, IVs, EVs and
gender are all stored, so an ability the species cannot legally have can be
written in and Gen 5 honours it. Type lives in the ROM's personal table —
changing it means patching the `.nds`, which this layer cannot do.

**ID conventions**, all verified against the live save:

- Save move ids index `state/moves.json` **directly** — key `"89"` is
  Earthquake. (`write_team.py`'s docstring says "moves.json id + 1"; that
  refers to its positional enumeration of the dict, not to the keys.)
- Ability ids are 1-indexed into `ABILITIES`, which stops at 164 — Gen 5's
  last. Everything above that in `wiki/docs/includes/abilities.md` is
  post-Gen-5 and cannot appear in this ROM. The table was cross-checked
  against every `ability_id` in `state/personal.json`: zero mismatches.
- TMs and HMs are **not** contiguous:
  `328..419 TM01..TM92`, `420..425 HM01..HM06`, `618..620 TM93..TM95`.
- PP is stored already boosted: `base + base*3/5` at 3 PP Ups.

## Ported, not ported, cannot be

**Ported.** PK5 decode/encode, the LCRNG cipher, the block shuffle, CRC16,
size and staleness validation, slot validation and selection, party, all 24
boxes, the Battle Box, box names, the box-capacity byte, bag pockets, the
three-tier reseal, and clone-and-patch record construction.

**Not ported.** Writing the *party* — the reader handles party slots, but
nothing writes them, exactly as in `write_team.py`, which only ever writes
boxes. A party slot is 220 bytes (a box record plus an 84-byte extra block
encrypted under the PID) and its stats and current HP would have to be
recomputed, not just re-encoded. Also not ported: `parse_bag.py`'s position /
Pokédex / trainer-card blocks, and `parse_save.py`'s experience-curve
inference. The curve inference is
deliberately dropped, not missing: it exists to survive *without* the ROM
tables, and this layer reads the curve straight out of `state/personal.json`,
which is exact. Money at `0x1DA00` is still a candidate, not a fact.

**Cannot be.** Anything that lives in the ROM rather than the save.

## Splitting for publication

The generic half ships as-is: ROM tables, encounters, trainer rosters, the
type chart, the damage calc, the `rom_diff` browser. The personal half — teams,
boxes, bag, position — needed a source, and this layer is it. Before
publishing, the thing that attracts takedowns is the 649 embedded sprites and
the ROM-extracted tables, not the code.
