#!/usr/bin/env python3
"""
extract_trainers.py -- read-only extractor for trainer classes, trainer
rosters and trainer PORTRAIT sprites from the Pokemon Blaze Black v3.1 ROM.

=============================================================================
READ-ONLY CONTRACT
=============================================================================
Both ROMs are opened 'rb' and never written.  The only things this program
writes are state/trainers.json and the PNGs under app/img/trainers/.

=============================================================================
THE PROBLEM THIS SOLVES: 105 CLASSES, 95 SPRITES
=============================================================================
tools/ncgr.py decodes 95 trainer portraits out of a/0/7/2, numbered 0..94,
and nothing in them says which number is Cheren, Cilan or a Youngster.  Three
separate ROM structures are needed to answer that, and the last one is the
only reason this file exists:

  1. TEXT FILE 191 in a/0/0/2 -- the trainer CLASS names, 105 of them:
     'Youngster', 'Lass', 'School Kid', ..., 'Leader', 'Elite Four'.
     (Text file 283 is the same list with articles: 'a Youngster'.)

  2. a/0/9/2 -- 616 trainer records of 20 bytes, index-aligned with TEXT
     FILE 190, which is 616 trainer NAMES.  Byte 0x01 is the class.  So
     'Cheren' -> class 37, 'Clay' -> class 22, 'Emmet' -> class 102.

  3. THE CLASS -> SPRITE TABLE IN arm9, AT 0x9C23C.  This is the piece that
     cannot be guessed.  Sprite order follows class id only as far as class
     46; after that it slips, and eleven classes at the end are scattered.
     The class byte reaches 102 while there are only 95 sprites, so identity
     cannot possibly hold end to end -- and an off-by-one here is invisible,
     because every neighbouring sprite is also a plausible trainer.

         class   0..46  ->  sprite = class
         class     47   ->  40
         class  48..91  ->  sprite = class - 1
         class     92   ->  71     93 -> 4     94 -> 70    95 -> 74
         class     96   ->  75     97 -> 69    98 -> 42    99 -> 41
         class    100   ->  91    101 -> 40   102 -> 92
         class    103   ->  93   104 -> 94

WHY THE TABLE IS BELIEVABLE, AND NOT JUST A WINDOW THAT FIT
Three independent things agree, and the validations below assert all of them:

  * The table is exactly 105 entries long -- the class count -- and its
    values cover 0..94 EXACTLY: all 95 sprites used, none out of range.
  * The ten classes that collapse onto a shared sprite are each semantically
    right.  The Undella rich family ('The Riches') reuses the Rich Boy, Lady,
    School Kid, Socialite, Gentleman and Veteran portraits; N's two Team
    Plasma classes reuse N's own portrait; Motorcyclist reuses Biker.  Nine
    sprites shared by two classes plus one shared by three is exactly the ten
    that take 105 down to 95.
  * It is byte-identical in the unmodified pokemon_black.nds, and the 48-byte
    signature that finds it occurs exactly once in arm9.

The remapped tail is where identity would have failed silently, and it is
where the visual check is strongest: sprite 77 is Shauntal with her book, 78
Marshal, 79 Grimsley, 80 Caitlin, 81 Ghetsis, 87 Ingo in black, 88 Alder,
91 Cynthia and 92 Emmet in white.  Ingo and Emmet are the clincher -- one
pose, two uniforms, at 87 and 92, which only this table puts there.

=============================================================================
THE ROSTERS, AND WHY THEY OUTRANK THE DOC
=============================================================================
a/0/9/3 holds each trainer's team, index-aligned with a/0/9/2.  The record
size is decided by byte 0x00 of the trainer record: 8 bytes per Pokemon, plus
2 if bit 1 (held item) is set, plus 8 if bit 0 (moves) is set.

    u8  ivs      u8 ability/gender/form     u16 level
    u16 species  u16 form                   [u16 item]  [u16 move x4]

This matters for one specific thing.  docs/Important Trainer Rosters.txt
writes the rivals' per-starter variants stacked inside single table cells,
which survives the RTF conversion as bare newlines that are indistinguishable
from ordinary cell breaks -- so five late-game rival blocks parsed as eight or
nine Pokemon.  The ROM has each variant as its OWN trainer entry, so it says
outright that a Serperior-carrying Cheren brings Houndoom and Simipour.  That
is not derivable from the doc, and the obvious guess is wrong: the rival's
monkey is NOT from the same elemental line as the rival's starter.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATE_DIR = ROOT / "state"
sys.path.insert(0, str(ROOT))

from extract_personal import NDSRom, parse_narc, RomError            # noqa: E402
from extract_items import (DEFAULT_ROM, VANILLA_ROM, TEXT_NARC,      # noqa: E402
                           decode_text_file, clean, read_arm9)

TRAINER_DATA_NARC = "a/0/9/2"
TRAINER_MONS_NARC = "a/0/9/3"
TEXT_FILE_TRAINER_NAMES = 190
TEXT_FILE_CLASS_NAMES = 191

TRAINER_RECORD = 20

# The class -> sprite table.  Located by signature rather than by offset, so a
# differently built arm9 still finds it; the offset is only a sanity note.
CLASS_TABLE_OFFSET = 0x9C23C
CLASS_TABLE_SIGNATURE = bytes(range(47)) + b"\x28"   # 0..46 identity, then 40
SPRITE_COUNT = 95


def find_class_sprite_table(arm9: bytes, class_count: int) -> tuple[list[int], int]:
    """The class -> sprite array, found by its own contents.

    The signature is the table's first 48 bytes: the identity run 0..46
    followed by the first remap (class 47 -> sprite 40).  A plain identity run
    is NOT distinctive -- bytes(range(48)) alone matches twice in arm9 -- but
    the identity run WITH the remap byte after it matches exactly once, and
    that uniqueness is asserted rather than assumed.
    """
    hits = []
    start = 0
    while True:
        i = arm9.find(CLASS_TABLE_SIGNATURE, start)
        if i < 0:
            break
        hits.append(i)
        start = i + 1
    if len(hits) != 1:
        raise RomError(f"class->sprite table signature matched {len(hits)} times, expected 1")
    off = hits[0]
    table = list(arm9[off:off + class_count])
    if len(table) != class_count:
        raise RomError("class->sprite table runs off the end of arm9")
    return table, off


def validate_class_table(table: list[int], class_count: int) -> None:
    """Everything that must be true if this really is the table.

    The coverage check is the strong one.  A window of bytes that merely
    happens to sit in range would not use every sprite exactly once between
    the duplicates; requiring set(table) == {0..94} means the table and the
    graphics NARC agree on how many portraits exist, which is the fact the
    whole join rests on.
    """
    if len(table) != class_count:
        raise RomError(f"class table is {len(table)} long, class names are {class_count}")
    if max(table) >= SPRITE_COUNT:
        raise RomError(f"class table points at sprite {max(table)}, only {SPRITE_COUNT} exist")
    if set(table) != set(range(SPRITE_COUNT)):
        missing = sorted(set(range(SPRITE_COUNT)) - set(table))
        raise RomError(f"class table never uses sprites {missing}")
    if table[:47] != list(range(47)):
        raise RomError("class table does not open with the 0..46 identity run")


def read_classes(rom: NDSRom) -> list[str]:
    files = parse_narc(rom.file_data(TEXT_NARC))
    names = [clean(x) for x in decode_text_file(files[TEXT_FILE_CLASS_NAMES])]
    if not names or "Youngster" not in names:
        raise RomError("text file 191 does not look like the trainer class table")
    return names


def read_trainer_names(rom: NDSRom) -> list[str]:
    files = parse_narc(rom.file_data(TEXT_NARC))
    return [clean(x) for x in decode_text_file(files[TEXT_FILE_TRAINER_NAMES])]


def read_trainers(rom: NDSRom, species: dict[int, str],
                  moves: dict[int, str] | None = None,
                  items: dict[int, str] | None = None,
                  species_abilities: dict[int, list[str]] | None = None) -> list[dict]:
    """One entry per trainer: name, class, and the team with moves and items.

    `moves` and `items` are name tables and are optional -- without them the
    ids are still emitted, so this never depends on extraction order.
    """
    moves = moves or {}
    items = items or {}
    species_abilities = species_abilities or {}
    names = read_trainer_names(rom)
    data = parse_narc(rom.file_data(TRAINER_DATA_NARC))
    mons = parse_narc(rom.file_data(TRAINER_MONS_NARC))
    if len(data) != len(names):
        raise RomError(f"{len(data)} trainer records but {len(names)} trainer names")
    if len(mons) != len(data):
        raise RomError(f"{len(mons)} roster files but {len(data)} trainer records")

    out = []
    for i, rec in enumerate(data):
        if len(rec) < 4:
            continue
        flags, cls, _btype, count = rec[0], rec[1], rec[2], rec[3]
        # Byte 0 decides the stride: +2 for a held item, +8 for four moves.
        size = 8 + (2 if flags & 2 else 0) + (8 if flags & 1 else 0)
        blob = mons[i]
        team = []
        for k in range(count):
            o = k * size
            if o + 8 > len(blob):
                break
            level = struct.unpack_from("<H", blob, o + 2)[0]
            # The high bits of the species word carry the alternate form.
            sp = struct.unpack_from("<H", blob, o + 4)[0] & 0x7FF
            mon = {"species_id": sp, "species": species.get(sp, f"#{sp}"),
                   "level": level}
            # THE MOVES AND THE ITEM WERE IN THE STRIDE ALL ALONG.
            # `size` above has always accounted for both -- the record grows by
            # 2 for a held item and 8 for four moves -- and then the loop read
            # neither, so all 616 rosters came out as species and level. The
            # cost showed up as an empty battle board: PKMN Trainer N 4 is six
            # Rotom, Drayano's doc lists only their species and level, and with
            # nothing on either side the matrix game has no columns to solve.
            # The ROM has all four moves for each of the six.
            #
            # Layout after the 8-byte head, confirmed against Skyla's two teams
            # move for move and item for item (18-byte stride, flags 0x03):
            #     +6 u16 form   +8 u16 item   +10 u16 move x4
            # Moves therefore sit at the END of the record, which is why they
            # are read from `size - 8` rather than a fixed offset: without a
            # held item the whole tail shifts down by two.
            # THE FORME IS AT +6, not in the species word's high bits as the
            # comment above assumed. N's six Rotom read species 479 forme 0..5,
            # and their movesets prove the reading: Lava Plume on 1 (Heat),
            # Scald on 2 (Wash), Glaciate on 3 (Frost), Hurricane on 4 (Fan),
            # Leaf Storm on 5 (Mow).
            #
            # Emitted but NOT YET RESOLVED TO A TYPING. personal.json stops at
            # 649 while the NARC holds 669 -- indices 657..661 are exactly
            # those five Rotom formes, at Electric/Fire, /Water, /Ice, /Flying
            # and /Grass. Until (species, forme) -> personal index is extracted
            # properly, a consumer that renders a forme'd opponent would be
            # computing damage against BASE Rotom's Electric/Ghost, which is
            # wrong for five of the six. The id is recorded so that work has
            # something to build on; nothing reads it yet.
            forme = struct.unpack_from("<H", blob, o + 6)[0]
            if forme:
                mon["forme"] = forme
            # THE ABILITY SLOT IS THE HIGH NIBBLE OF BYTE 1, AND IT IS 1-BASED.
            # Not 0-based, which is the reading that looks right and is wrong:
            # nibble 1 means the species' FIRST ability, 2 means the second, and
            # 0 means the record does not specify one at all (1,498 of them --
            # the game derives it from the generated PID, so nothing here can
            # know it).
            #
            # Proven against every ability Drayano documents rather than assumed:
            # 88 of 98 agree, and all ten disagreements are the DOC's own
            # parsing, not this -- five have an item in the ability column
            # ("Flying Gem", "Sitrus Berry", "Air Balloon"), one is a spelling
            # variant ("Compoundeyes"), and the rest sit on rows where the
            # Full/Clean ability pair wrapped. Skyla's two teams match 12 of 12.
            slot = (blob[o + 1] >> 4) & 0x0F
            opts = species_abilities.get(sp) or []
            if 1 <= slot <= len(opts):
                mon["ability"] = opts[slot - 1]
                mon["ability_slot"] = slot
            elif len({a for a in opts if a}) == 1:
                # One distinct ability means the slot cannot change the answer.
                # Rotom is the case that matters: both slots are Levitate, so a
                # blank here was costing the battle board a GROUND IMMUNITY.
                mon["ability"] = next(a for a in opts if a)
                mon["ability_src"] = "only-one"
            if flags & 2:
                item = struct.unpack_from("<H", blob, o + 8)[0]
                if item:
                    mon["item_id"] = item
                    if items.get(item):
                        mon["item"] = items[item]
            if flags & 1:
                ids = [m for m in struct.unpack_from("<4H", blob, o + size - 8) if m]
                if ids:
                    mon["move_ids"] = ids
                    if moves:
                        mon["moves"] = [moves.get(m, f"#{m}") for m in ids]
            team.append(mon)
        out.append({"id": i, "name": names[i], "class": cls, "team": team})
    return out


def build(rom_path: Path) -> dict:
    rom = NDSRom(rom_path)
    arm9 = read_arm9(rom_path)

    personal = json.loads((STATE_DIR / "personal.json").read_text())["species"]
    species = {int(k): v["name"] for k, v in personal.items()}

    class_names = read_classes(rom)
    table, off = find_class_sprite_table(arm9, len(class_names))
    validate_class_table(table, len(class_names))

    # Name tables for the moves and items the rosters carry. Both are written
    # by earlier extractors and both are OPTIONAL here: ids are emitted either
    # way, so this never becomes an ordering dependency -- the trap that once
    # shipped empty wild_held_items on every clean setup.
    def _names(fname, key):
        path = STATE_DIR / fname
        if not path.is_file():
            return {}
        return {int(k): v["name"] for k, v in
                json.loads(path.read_text())[key].items()}

    trainers = read_trainers(rom, species,
                             _names("moves.json", "moves"),
                             _names("items.json", "items"),
                             {int(k): list(v.get("abilities") or [])
                              for k, v in personal.items()})
    for t in trainers:
        t["sprite"] = table[t["class"]] if t["class"] < len(table) else None
        t["class_name"] = class_names[t["class"]] if t["class"] < len(class_names) else ""

    shared = {}
    for c, s in enumerate(table):
        shared.setdefault(s, []).append(c)

    return {
        "classes": [{"id": i, "name": n, "sprite": table[i]}
                    for i, n in enumerate(class_names)],
        "class_sprite": table,
        "sprite_count": SPRITE_COUNT,
        "shared_sprites": {str(s): cs for s, cs in shared.items() if len(cs) > 1},
        "trainers": trainers,
        "meta": {
            "rom": str(rom_path),
            "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "class_table_offset": f"{off:#x}",
            "class_table_offset_expected": f"{CLASS_TABLE_OFFSET:#x}",
            "trainer_narc": TRAINER_DATA_NARC,
            "roster_narc": TRAINER_MONS_NARC,
        },
    }


def cross_check_vanilla(table: list[int], vanilla: Path) -> str:
    """The portraits are not something a ROM hack touches, so the table must
    match vanilla byte for byte.  A difference means the signature latched
    onto something else in one of the two binaries."""
    if not vanilla.is_file():
        return "vanilla ROM absent -- class table not cross-checked"
    varm9 = read_arm9(vanilla)
    vtable, _ = find_class_sprite_table(varm9, len(table))
    if vtable != table:
        raise RomError("class->sprite table differs from vanilla; the signature is unsafe")
    return "class table identical in pokemon_black.nds"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--rom", type=Path, default=DEFAULT_ROM)
    ap.add_argument("--vanilla", type=Path, default=VANILLA_ROM)
    ap.add_argument("--out", type=Path, default=STATE_DIR / "trainers.json")
    ap.add_argument("--sprites", type=Path, default=ROOT / "app" / "img" / "trainers",
                    help="where to write the 95 portrait PNGs")
    ap.add_argument("--no-sprites", action="store_true")
    args = ap.parse_args(argv)

    try:
        blob = build(args.rom)
        note = cross_check_vanilla(blob["class_sprite"], args.vanilla)
    except RomError as exc:
        print(f"extract_trainers: {exc}", file=sys.stderr)
        return 1

    blob["meta"]["vanilla_check"] = note

    if not args.no_sprites:
        from tools.ncgr import write_trainer_sprites
        try:
            n = write_trainer_sprites(args.rom, args.sprites)
        except Exception as exc:                        # noqa: BLE001
            print(f"extract_trainers: sprites failed: {exc}", file=sys.stderr)
            return 1
        if n != SPRITE_COUNT:
            print(f"extract_trainers: wrote {n} sprites, expected {SPRITE_COUNT}",
                  file=sys.stderr)
            return 1
        blob["meta"]["sprite_dir"] = str(args.sprites.relative_to(ROOT))
        print(f"  {n} portraits -> {args.sprites.relative_to(ROOT)}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(blob, indent=1))
    named = sum(1 for t in blob["trainers"] if t["name"])
    print(f"  {len(blob['classes'])} classes, {len(blob['trainers'])} trainers "
          f"({named} named) -> {args.out.relative_to(ROOT)}")
    print(f"  {note}")
    print(f"  {len(blob['shared_sprites'])} portraits shared by more than one class")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
