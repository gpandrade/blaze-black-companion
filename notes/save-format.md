# Save-format archaeology

What was recovered from the `.sav` beyond what `parse_save.py` documents.

This is the archaeology — why the code is shaped the way it is, and which
mistakes shaped it. Read it before changing anything it describes; most of
what looks arbitrary here is load-bearing, and the note says which bug made
it so.

---

## THE GAME ONLY EXPOSES 8 BOXES BY DEFAULT

The u8 at slot **`0x3DD`** is the number of boxes the game shows, and it ships
as **8**. All 24 box name strings and all 24 box data regions exist in the
save, so a write to box 9+ succeeds, passes every checksum, and is then
completely invisible in game. That is exactly what happened once already.

It has been raised to 24. If boxes 9+ ever stop appearing, check that byte
first. The block is the box-name block (`0x00000`, len `0x3E0`, checksum entry
**0**), whose real layout is:

```
+0x000  u32  currently-selected box, 0-indexed
+0x004  24 names, stride 0x28, UTF-16LE, 0xFFFF-terminated
+0x3C4  24 wallpaper bytes
+0x3DD  u8   NUMBER OF BOXES EXPOSED
```

Note the names start at **+0x004**, not +0x000 — `parse_save.box_names` had
that wrong and returned garbage.

**Before writing to any box, confirm it is reachable in game.**

## Reading the player's gender

**Not from the trainer card block.** There is a byte there that says it, and
it was not decoded, because locating it needs two saves of opposite gender to
contrast against — and every save available is the same trainer: his, the
vanilla Black one beside it, and the fixture derived from his. Six bytes in
that block read zero and any of them would "fit". This project has already
been burned twice by exactly that reasoning while hunting money (`0x1AA04`,
`0x1DA00`), and the rule it left behind stands: **a fingerprint that fits is
not a confirmation.**

**What IS verifiable**: every Pokémon carries the gender of its ORIGINAL
TRAINER in bit 7 of the met byte (record `0x7E`, body `0x76`; met level is
bits 0-6). For a Pokémon you caught yourself, that trainer is you. So
`Save.playerGender()` reads the first record whose OT name and both ids match
the card and whose met data is real.

**It returns null rather than guessing, and null is a real answer.** A save
whose records were all written by a tool — including this one — has its met
data zeroed, so "never recorded" and "male" have to stay distinguishable.
Gab's save is entirely in that state, which is why his card still falls back
to a remembered choice and marks the portrait dashed to say so.

Record `0x7D` (body `0x75`) beside it is the **ball**, and that one IS
confirmed: it reads 4 on every record and item 4 is Poké Ball in the ROM's own
item table.

## Badges — 0x21204, CONFIRMED 2026-08-29

**One bit per badge, low bits first.** Badge 1 is bit 0, badge 8 is bit 7, so
three badges reads `0b0000_0111`.

**How it was settled, and why nothing weaker would have done.** Gab saved
immediately before the fourth gym leader, installed that save (which took a
backup), beat the leader, and saved again. Diffing the pair, exactly 47 bytes
in the file gained one bit without clearing any. `0x21204` went
`0b0111 → 0b1111`, and it is the only one of the 47 whose value is a run of
low bits.

**The shape across all 42 backups is what makes it a fact rather than another
fingerprint:** the value is *always* exactly the low N bits — `0b1`, `0b11`,
`0b111`, `0b1111` — never with a gap, and N never decreases. A byte that
merely correlates with progress does not stay gap-free over 42 samples.

**THREE EARLIER CANDIDATES WERE WRONG, and the last one is the lesson.**
`0x1DBDD` decreased. `0x1D91C` ended at four bits with three badges. `0x20393`
bits 5/6/7 survived the longest and looked strongest — sparse event-flag
array, three bits turning on in order, exactly three set at three badges — and
it **did not move at all when the fourth badge was earned.** It had been
tracking something else that happened to correlate over eight play sessions.
Only the controlled before/after diff could separate them, and it took two
minutes of his time to produce.

## The block holding money and badges — 0x21200, entry 52

Found the same day by walking every `0x100`-aligned start in the region and
accepting a block only where the **computed CRC, the block's own inline
checksum two bytes past its end, and the central table entry all agree**:

```
start 0x21200   len 0x00EC   inline checksum 0x212EE   table entry 52
```

It verifies on **both slots of all 42 saves — 84 of 84**. Money is the block's
first `u32` at `0x21200`; badges are the byte at `0x21204`.

`js/save.js` now carries a `money` block descriptor. **Nothing writes it**, and
having the descriptor does not change that — it exists so a future writer has a
proven target rather than a guess. The note it replaced said a wrong descriptor
would reseal the wrong bytes, and that hazard is exactly what the 84-of-84
check retires.

## The badge ARTWORK — solved, see `notes/rom-graphics.md`

Extracted by `python3 tools/ncgr.py badges` from `a/0/4/0`, whose cell bank
says each badge is a single 32×64 OAM object with its own palette bank. The
arrangement came from the ROM's own cell data rather than from a stride that
looked right — two guesses by eye each produced plausible fragments.
