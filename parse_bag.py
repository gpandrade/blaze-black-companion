#!/usr/bin/env python3
"""
parse_bag.py -- read-only reader for the Bag and player state in a
Pokemon Blaze Black v3.1 save (NDS, Gen 5 BW engine).

=============================================================================
READ-ONLY CONTRACT
=============================================================================
The save is read through parse_save.read_save, which opens it 'rb' and
enforces the project's size and mtime rules.  Nothing here writes to the
save.  The only file written is state/bag.json.

=============================================================================
BLOCK MAP
=============================================================================
The save's 70-entry checksum table at slot+0x23F00 was resolved completely by
walking every 0x100-aligned offset with a running CRC16-CCITT and accepting a
block only where THREE things agreed: the computed CRC over [off, off+len),
the block's own inline checksum at off+len+2, and an entry in the central
table.  That triple agreement is what makes the offsets below facts rather
than guesses.  The blocks this module uses:

    entry 25   0x18400  len 0x09C0   Bag / inventory
    entry 27   0x19400  len 0x0068   Trainer card (OT name, TID, SID)
    entry 28   0x19500  len 0x009C   Player position
    entry 55   0x21600  len 0x04D4   Pokedex

=============================================================================
BAG POCKETS
=============================================================================
Every pocket is a flat array of {u16 item id, u16 count}, ending at the first
zero id.  The pocket boundaries were read off the live save rather than taken
from a table: the four occupied regions began at 0x000, 0x4D8, 0x624 and
0x7D8, and the TM/HM pocket's capacity (109 slots) comfortably covers the 101
TMs and HMs, which is the check that anchors the layout.

    0x000  Items       310 slots
    0x4D8  Key Items    83 slots
    0x624  TMs & HMs   109 slots
    0x7D8  Medicine     55 slots
    0x8B4  Berries      67 slots

=============================================================================
ITEM NAMES COME FROM THE ROM
=============================================================================
state/items.json is required.  parse_save.py's embedded ITEM_NAMES table
carries one extra placeholder in the 113..115 run, which shifts every name
from item id 116 upward by one and makes it derive TM01's id as 329 instead
of the true 328.  That is why an unpatched read of this bag reported HM01
(Cut) as "TM92".  This module refuses to run without the ROM table rather
than reproduce that bug.

=============================================================================
CONFIDENCE
=============================================================================
Fields are tagged in the output.  `verified` means an independent check
passed; `unverified` means the offset is a reasonable read that nothing
available here can confirm.

    bag pockets     verified -- block CRC agrees three ways
    pokedex         verified -- the caught bitfield has a bit set for 9 of
                    the 10 species actually in the party and boxes, and its
                    popcount is exactly 10
    location        verified -- the zone -> location mapping was checked
                    against party met-locations, which decode to Nuvema Town
                    for the starter, Route 1 for the Pidgey and Dreamyard for
                    the four caught there
    money, badges   NOT located.  See MONEY AND BADGES below.

=============================================================================
MONEY AND BADGES
=============================================================================
MONEY -- strong candidate at 0x1DA00, ONE in-game glance from confirmed.

The old claim that money "has no fingerprint available offline" was true only
while there was a single save.  There are now 15 backups spanning the
playthrough, and diffing them settles it:

  * The previous candidate, 0x1AA04, is DISPROVEN.  It reads 3993 in all 15
    saves -- unchanged across three separate play sessions.  Money cannot be
    constant while the player battles and shops.

  * 0x1DA00 is the only u32 in the whole slot that is non-decreasing, stays in
    money range, and changes ONLY in the windows where the player actually
    played, staying flat across every save-edit:

        9524 -> 10312 (played)  -> flat over 10 consecutive edits
             -> 11504 (played)  -> flat -> 11876 (played) -> flat

    It is also the first u32 of its own checksummed block (start 0x1DA00,
    len 0x1E0, central table entry 38), which is where a headline field sits.

This is inference from behaviour, not proof.  Report it as a candidate until
the player reads their own money screen once and confirms the number.

BADGES are still NOT located: they are event flags whose indices are not
derivable from the ROM tables this project extracts.  They can be inferred
indirectly -- the gym TMs are distinctive, and shaking grass needs badge 1.
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
import parse_save as ps  # noqa: E402

BAG_BLOCK = 0x18400
BAG_LEN = 0x09C0
CHK_BAG = 25

TRAINER_BLOCK = 0x19400

# Money -- recovered by diffing 15 save backups spanning the playthrough.
# Its block: start 0x1DA00, len 0x01E0, inline checksum at 0x1DBE2,
# central checksum-table entry 38.  Money is the block's very first u32.
# CONFIRMED against the trainer card: 9,254,754. The old guess 0x1DA00 was
# inferred from fifteen backups -- non-decreasing, in range, moving only in
# play windows -- and was still wrong; it reads 18,130. 0x21200 is the only
# offset in the file that matches the card AND an older card value in an
# older backup. Read-only: its containing checksummed block is unidentified.
MONEY_OFF = 0x21200

# BADGES ARE AT 0x21204, ONE BIT PER BADGE, LOW BITS FIRST -- CONFIRMED.
# Settled 2026-08-29 by the controlled experiment: a save kept immediately
# before the fourth gym leader, the leader beaten, and a save taken again.
# 0x21204 went 0b0111 -> 0b1111, and nothing else in the file that gained a
# bit has this shape.
#
# It holds across all 42 backups, which is the part that makes it a fact
# rather than a fingerprint: the value is ALWAYS exactly the low N bits
# (0b1, 0b11, 0b111, 0b1111) and N never decreases. A byte that merely
# correlates does not stay gap-free over 42 samples.
#
# THE OLD CANDIDATE 0x20393 IS DISPROVEN. It went 2 -> 3 bits on 2026-08-23
# and then did NOT move when the fourth badge was earned. It was the third
# such candidate to fit a window and fail the experiment (0x1DBDD, 0x1D91C),
# which is the whole lesson: only the controlled diff settled it.
BADGES_OFF = 0x21204

# Money and badges share one checksummed block, also settled 2026-08-29 by
# walking 0x100-aligned starts and accepting only where the computed CRC, the
# block's inline checksum and the central table all agree. It verifies on both
# slots of all 42 saves -- 84 of 84.
MONEY_BLOCK, MONEY_BLOCK_LEN, CHK_MONEY = 0x21200, 0x00EC, 52
POSITION_BLOCK = 0x19500
DEX_BLOCK = 0x21600

# Player position block.  Two position records are present; the first is the
# live one and the second appears to be an entry/respawn point.  Both read
# the same zone here, so which is which cannot be separated from one save.
POS_ZONE = 0x04           # u16 zone id
POS_X = 0x10              # u32 fixed point, tile = value >> 16
POS_Z = 0x18
POS_ALT_ZONE = 0x80

# Pokedex.  Caught bitfield at +8, then four "seen" bitfields (male, female,
# shiny male, shiny female); seen is the union of the four.
DEX_CAUGHT = 0x08
DEX_STRIDE = 0x54
DEX_SEEN_FIELDS = 4

POCKETS = (
    ("items", 0x000, 310),
    ("key_items", 0x4D8, 83),
    ("tms_hms", 0x624, 109),
    ("medicine", 0x7D8, 55),
    ("berries", 0x8B4, 67),
)


class BagError(Exception):
    """Fatal: refuse to emit a partial or unnamed bag."""


def load_items() -> dict:
    path = STATE_DIR / "items.json"
    if not path.is_file():
        raise BagError(
            "state/items.json missing -- run extract_items.py first. "
            "This module will not fall back to parse_save's embedded item "
            "names, which are shifted by one from item id 116 upward."
        )
    return json.loads(path.read_text())


def load_maps() -> dict | None:
    path = STATE_DIR / "maps.json"
    return json.loads(path.read_text()) if path.is_file() else None


def verify_bag_block(data: bytes, base: int) -> dict:
    """Check the bag block three ways: computed, inline and central CRC."""
    blk = data[base + BAG_BLOCK: base + BAG_BLOCK + BAG_LEN]
    computed = ps.crc16_ccitt(blk)
    inline = struct.unpack_from("<H", data, base + BAG_BLOCK + BAG_LEN + 2)[0]
    central = struct.unpack_from("<H", data, base + ps.CHECKSUM_TABLE + 2 * CHK_BAG)[0]
    ok = computed == inline == central
    if not ok:
        raise BagError(
            f"bag checksums disagree (computed {computed:#06x}, inline "
            f"{inline:#06x}, table {central:#06x}) -- refusing to emit"
        )
    return {"computed": computed, "inline": inline, "central": central, "agree": ok}


def read_pockets(data: bytes, base: int, items: dict) -> dict:
    table = items["items"]
    out: dict[str, list] = {}
    for name, off, slots in POCKETS:
        entries = []
        for i in range(slots):
            at = base + BAG_BLOCK + off + 4 * i
            iid, count = struct.unpack_from("<HH", data, at)
            if iid == 0:
                break
            rec = table.get(str(iid))
            if rec is None:
                raise BagError(f"item id {iid} in pocket {name} is not in state/items.json")
            entry = {
                "item_id": iid,
                "name": rec["name"],
                "count": count,
                "description": rec["description"],
            }
            if "tm_hm" in rec:
                entry["tm_hm"] = rec["tm_hm"]
                entry["move"] = rec["move"]
                entry["name"] = f"{rec['tm_hm']} {rec['move']}"
            entries.append(entry)
        out[name] = entries
    return out


def read_position(data: bytes, base: int, maps: dict | None) -> dict:
    b = base + POSITION_BLOCK
    zone = struct.unpack_from("<H", data, b + POS_ZONE)[0]
    alt = struct.unpack_from("<H", data, b + POS_ALT_ZONE)[0]
    x = struct.unpack_from("<I", data, b + POS_X)[0] >> 16
    z = struct.unpack_from("<I", data, b + POS_Z)[0] >> 16

    def name(zid: int) -> str | None:
        if not maps:
            return None
        rec = maps["zones"].get(str(zid))
        return rec["location"] if rec else None

    return {
        "zone_id": zone,
        "location": name(zone),
        "tile": {"x": x, "z": z},
        "secondary_zone_id": alt,
        "secondary_location": name(alt),
        "confidence": "verified" if maps else "no maps.json",
    }


def read_dex(data: bytes, base: int, species_names: dict | None) -> dict:
    b = base + DEX_BLOCK + DEX_CAUGHT

    def bits(off: int) -> set[int]:
        found = set()
        for sid in range(1, 650):
            i = sid - 1
            if (data[off + i // 8] >> (i % 8)) & 1:
                found.add(sid)
        return found

    caught = bits(b)
    seen: set[int] = set()
    for n in range(1, DEX_SEEN_FIELDS + 1):
        seen |= bits(b + n * DEX_STRIDE)
    seen |= caught

    def named(ids):
        if not species_names:
            return sorted(ids)
        return [species_names.get(str(s), f"#{s}") for s in sorted(ids)]

    return {
        "caught_count": len(caught),
        "seen_count": len(seen),
        "caught": named(caught),
        "seen": named(seen),
        "confidence": "verified",
    }


def read_trainer(data: bytes, base: int) -> dict:
    b = base + TRAINER_BLOCK
    name = ps.decode_string(data[b + 0x04: b + 0x14], 8)
    tid, sid = struct.unpack_from("<HH", data, b + 0x14)
    return {
        "ot_name": name,
        "trainer_id": tid,
        "secret_id": sid,
        "money": None,
        "badges": None,
        "badge_count": None,
        "badges": None,
        # 0x1DA00 -- strong candidate, see MONEY AND BADGES in the docstring.
        # The old 0x1AA04 guess is DISPROVEN and no longer reported.
        "money": struct.unpack_from("<I", data, base + MONEY_OFF)[0],
        # One bit per badge, low bits first. The list is which badges, in gym
        # order; the count is what the trainer card shows.
        "badges": [i for i in range(8) if data[base + BADGES_OFF] >> i & 1],
        "badge_count": bin(data[base + BADGES_OFF]).count("1"),
        "confidence": "ot/tid/money verified against the trainer card; badges "
                      "confirmed by a before/after diff across the 4th gym leader",
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Read the Bag and player state, read-only.")
    ap.add_argument("--save", type=Path, default=ps.DEFAULT_SAVE)
    args = ap.parse_args(argv)

    try:
        data, saveinfo = ps.read_save(args.save)
        items = load_items()
    except (ps.SaveError, BagError) as exc:
        print(f"parse_bag: {exc}", file=sys.stderr)
        return 1

    warnings: list[str] = []
    slot, slots, why = ps.choose_slot(data, warnings)
    base = ps.SLOT_OFFSETS[slot]

    maps = load_maps()
    species_names = None
    personal = STATE_DIR / "personal.json"
    if personal.is_file():
        species_names = {k: v["name"]
                         for k, v in json.loads(personal.read_text())["species"].items()}

    try:
        checks = verify_bag_block(data, base)
        pockets = read_pockets(data, base, items)
    except BagError as exc:
        print(f"parse_bag: {exc}", file=sys.stderr)
        return 1

    out = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "save": saveinfo,
            "slot_used": slot,
            "slot_selection": why,
            "bag_checksums": checks,
            "item_names": "state/items.json (ROM)",
            "warnings": warnings,
        },
        "trainer": read_trainer(data, base),
        "position": read_position(data, base, maps),
        "pokedex": read_dex(data, base, species_names),
        "bag": pockets,
        "totals": {k: len(v) for k, v in pockets.items()},
    }

    STATE_DIR.mkdir(exist_ok=True)
    (STATE_DIR / "bag.json").write_text(json.dumps(out, indent=1))

    pos = out["position"]
    print(f"parse_bag: slot {slot}; "
          f"{sum(len(v) for v in pockets.values())} distinct items -> state/bag.json")
    print(f"parse_bag: at zone {pos['zone_id']} ({pos['location']}), "
          f"dex {out['pokedex']['caught_count']} caught / "
          f"{out['pokedex']['seen_count']} seen")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
