#!/usr/bin/env python3
"""
extract_items.py -- read-only extractor for item and map data from the
Pokemon Blaze Black v3.1 ROM (NDS, Gen 5 BW engine).

=============================================================================
READ-ONLY CONTRACT
=============================================================================
Both ROMs are opened 'rb' and never written.  The only files this program
writes are state/items.json and state/maps.json.

=============================================================================
WHAT THIS PROVES BEFORE IT EMITS ANYTHING
=============================================================================
Every table below is validated against the unmodified pokemon_black.nds, or
against an internal invariant, before it is written.  Nothing is emitted on
faith.  The validations are:

  item names     627 entries, decoded from the ROM's own text archive; the
                 first line must be "None" and item 1 must be "Master Ball".
  item data      627 entries of 36 bytes in a/0/2/4 -- the count must equal
                 the number of names.
  TM/HM map      exactly 101 items must carry category byte 0x06, and their
                 display indices must cover 0..100 with no gaps.
  zone table     a/0/1/2 must divide evenly into 48-byte entries and the
                 location-name index must never exceed the location count.

=============================================================================
ITEM ID SPACE -- THE OFF-BY-ONE THAT parse_save.py HAD
=============================================================================
parse_save.py derived TM01's item id from the length of its embedded name
table and got 329.  The ROM says 328.  The embedded table carries one extra
placeholder in the 113..115 run, which shifts every name from id 116 upward
by one.  That is why the bag's HM01 (Cut) read as "TM92".

The real layout, read from the item data table's own category byte:

    328..419   TM01..TM92
    420..425   HM01..HM06
    618..620   TM93..TM95

TM93-95 were added late in Gen 5 development, so their item ids sit after the
key items rather than after TM92.  The arm9 move array is ordered differently
again -- TM01..TM92, HM01..HM06, TM93..TM95 -- while the item's own display
index byte uses TM01..TM95 then HM01..HM06.  All three orderings are handled
explicitly below; do not "simplify" them into one.

=============================================================================
TEXT ARCHIVE FORMAT (a/0/0/2)
=============================================================================
    u16 sectionCount (always 1 here)
    u16 lineCount
    u32 totalLength      == filesize - 16
    u32 initialKey       (0)
    u32 sectionOffset    (16)
  at sectionOffset:
    u32 sectionLength
    lineCount x { u32 offset (from sectionOffset), u16 charCount, u16 flags }
    UTF-16LE character data, 0xFFFF terminated

Each line is XOR encrypted with a rolling key:

    key_0 for line i = (0x7C89 + i * 0x2983) & 0xFFFF
    after each character, key = rotate_left_3(key)

That key schedule was not taken from documentation -- it was recovered by
brute forcing line 0 of the item-name file over all 65536 starting keys and
keeping the one that produced printable text ("None"), then reading the
progression off lines 1..5, which advance by a constant 0x2983.

Files used:  53 item descriptions, 54 item names, 89 location names.

=============================================================================
WHAT IS DELIBERATELY NOT HERE
=============================================================================
Field items, hidden items and mart inventories are NOT extracted.  In Gen 5
they live in the event scripts (a/0/1/4) rather than in a flat table, and an
arm9 scan for 0xFFFF-terminated item-id runs produced exactly one candidate
whose leading entries were plainly misaligned.  Emitting a guess would put
unvalidated data at the top of the source hierarchy, which is the one thing
this project's rules forbid.  The hook is left in place: see `find_marts`.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path

import paths

ROOT = Path(__file__).resolve().parent
STATE_DIR = ROOT / "state"
DEFAULT_ROM = paths.ROM
VANILLA_ROM = paths.VANILLA_ROM

TEXT_NARC = "a/0/0/2"
ITEMDATA_NARC = "a/0/2/4"
ZONE_NARC = "a/0/1/2"

TEXT_FILE_ITEM_DESCRIPTIONS = 53
TEXT_FILE_ITEM_NAMES = 54
TEXT_FILE_LOCATION_NAMES = 89

ITEM_ENTRY_SIZE = 36
ZONE_ENTRY_SIZE = 48

# Item data entry fields that this extractor is confident about.  Offsets not
# listed here are preserved verbatim in `raw` rather than guessed at.
IT_PRICE = 0x00          # u16, stored in tenths -- see PRICE_SCALE
IT_CATEGORY = 0x0A       # u8, 0x06 == TM or HM

# The price field holds a tenth of the shop price.  Confirmed against ten
# items whose in-game price is known: Poke Ball reads 20 and sells for 200,
# Ultra Ball 120 -> 1200, Potion 30 -> 300, Revive 150 -> 1500.  Both the
# scaled `price` and the raw field are emitted.
PRICE_SCALE = 10
IT_TMHM_INDEX = 0x0F     # u8, 0 -> TM01 .. 94 -> TM95, 95 -> HM01 .. 100 -> HM06

ZONE_LOCATION_NAME = 0x1A   # u8 index into the location-name text file

TEXT_KEY_BASE = 0x7C89
TEXT_KEY_STEP = 0x2983

TM_COUNT = 95
HM_COUNT = 6


class RomError(Exception):
    """Fatal: the ROM could not be trusted.  Never emit a partial table."""


# --------------------------------------------------------------------------
# NDS / NARC access -- reuse the proven reader from extract_personal
# --------------------------------------------------------------------------
sys.path.insert(0, str(ROOT))
from extract_personal import NDSRom, parse_narc  # noqa: E402


# --------------------------------------------------------------------------
# arm9 (BLZ) -- needed for the TM/HM move array
# --------------------------------------------------------------------------
def read_arm9(rom_path: Path) -> bytes:
    """Return the decompressed arm9 binary.

    Gen 5 ships arm9 BLZ-compressed (backwards LZ).  The footer's last 12
    bytes carry inc_len, hdr_len and enc_len; the compressed region is
    processed in reverse and the decoded tail is then reversed back.
    """
    data = rom_path.read_bytes()
    off, _entry, _ram, size = struct.unpack_from("<4I", data, 0x20)
    a9 = bytearray(data[off:off + size])

    pak_len = len(a9)
    inc_len = struct.unpack_from("<I", a9, pak_len - 4)[0]
    if inc_len == 0:
        return bytes(a9)                      # already uncompressed
    hdr_len = a9[pak_len - 5]
    enc_len = struct.unpack_from("<I", a9, pak_len - 8)[0] & 0xFFFFFF
    if not 8 <= hdr_len <= 0x0B:
        raise RomError(f"arm9 BLZ header length {hdr_len} out of range")

    head_len = pak_len - enc_len
    comp_len = enc_len - hdr_len
    raw_len = head_len + enc_len + inc_len

    comp = bytes(reversed(a9[head_len:head_len + comp_len]))
    raw = bytearray(a9[:head_len]) + bytearray(raw_len - head_len)

    pak, out, mask, flags = 0, head_len, 0, 0
    while out < raw_len:
        mask >>= 1
        if mask == 0:
            if pak == comp_len:
                break
            flags = comp[pak]
            pak += 1
            mask = 0x80
        if not flags & mask:
            if pak == comp_len:
                break
            raw[out] = comp[pak]
            pak += 1
            out += 1
        else:
            if pak + 1 >= comp_len:
                break
            pos = (comp[pak] << 8) | comp[pak + 1]
            pak += 2
            length = (pos >> 12) + 3
            if out + length > raw_len:
                length = raw_len - out
            pos = (pos & 0xFFF) + 3
            for _ in range(length):
                raw[out] = raw[out - pos]
                out += 1

    return bytes(raw[:head_len]) + bytes(reversed(raw[head_len:raw_len]))


# --------------------------------------------------------------------------
# Gen 5 text archives
# --------------------------------------------------------------------------
def _rotl3(key: int) -> int:
    return ((key << 3) | (key >> 13)) & 0xFFFF


def decode_text_file(blob: bytes) -> list[str]:
    """Decode one Gen 5 text archive into its list of lines."""
    if len(blob) < 16:
        raise RomError("text archive too short")
    sections, lines, total = struct.unpack_from("<HHI", blob, 0)
    if sections != 1 or total != len(blob) - 16:
        raise RomError("not a Gen 5 text archive (header mismatch)")
    sec = struct.unpack_from("<I", blob, 0x0C)[0]

    out: list[str] = []
    for i in range(lines):
        off, count, _flags = struct.unpack_from("<IHH", blob, sec + 4 + 8 * i)
        chars = struct.unpack_from("<%dH" % count, blob, sec + off)
        key = (TEXT_KEY_BASE + i * TEXT_KEY_STEP) & 0xFFFF
        buf: list[str] = []
        for enc in chars:
            val = enc ^ key
            key = _rotl3(key)
            if val == 0xFFFF:
                break
            buf.append(chr(val))
        out.append("".join(buf))
    return out


def clean(text: str) -> str:
    """Strip the control glyphs Gen 5 uses for line breaks and variables."""
    return (
        text.replace("￾", " ")
        .replace("\n", " ")
        .replace("￾", " ")
        .strip()
    )


# --------------------------------------------------------------------------
# Tables
# --------------------------------------------------------------------------
def load_text(rom: NDSRom, index: int) -> list[str]:
    files = parse_narc(rom.file_data(TEXT_NARC))
    if index >= len(files):
        raise RomError(f"text archive {index} missing from {TEXT_NARC}")
    return decode_text_file(files[index])


def tmhm_move_array(arm9: bytes, move_count: int) -> list[int]:
    """Locate and return the 101-entry TM/HM move array.

    Anchored on the vanilla BW HM move-id run (Cut, Fly, Surf, Strength,
    Waterfall, Dive).  The array start is 92 entries before that run, which
    is itself checked: entry 0 must be a valid move id, and the run must be
    the only match in the binary.
    """
    tail = struct.pack("<6H", 15, 19, 57, 70, 127, 291)
    hits = []
    pos = arm9.find(tail)
    while pos != -1:
        hits.append(pos)
        pos = arm9.find(tail, pos + 1)
    if len(hits) != 1:
        raise RomError(f"expected exactly one HM move run in arm9, found {len(hits)}")

    start = hits[0] - 92 * 2
    if start < 0:
        raise RomError("HM run too close to the start of arm9")
    arr = list(struct.unpack_from("<101H", arm9, start))
    if not all(1 <= m <= move_count for m in arr):
        raise RomError("TM/HM move array contains out-of-range move ids")
    return arr


def tmhm_labels() -> list[str]:
    """Labels in *arm9 array order*: TM01..TM92, HM01..HM06, TM93..TM95."""
    return (
        [f"TM{i:02d}" for i in range(1, 93)]
        + [f"HM{i:02d}" for i in range(1, 7)]
        + [f"TM{i:02d}" for i in (93, 94, 95)]
    )


def display_label(index: int) -> str:
    """Item display index -> label.  0..94 are TM01..TM95, 95..100 are HMs."""
    if index < TM_COUNT:
        return f"TM{index + 1:02d}"
    return f"HM{index - TM_COUNT + 1:02d}"


def build_items(rom: NDSRom, arm9: bytes, move_names: dict[str, str]) -> dict:
    names = [clean(n) for n in load_text(rom, TEXT_FILE_ITEM_NAMES)]
    descs = [clean(d) for d in load_text(rom, TEXT_FILE_ITEM_DESCRIPTIONS)]
    entries = parse_narc(rom.file_data(ITEMDATA_NARC))

    if names[0] != "None" or names[1] != "Master Ball":
        raise RomError(f"item-name table failed its anchor check: {names[:2]}")
    if len(entries) != len(names):
        raise RomError(
            f"{len(entries)} item data entries but {len(names)} names -- refusing to emit"
        )
    if any(len(e) != ITEM_ENTRY_SIZE for e in entries):
        raise RomError("item data entries are not all 36 bytes")

    arr = tmhm_move_array(arm9, max(int(k) for k in move_names))
    by_label = dict(zip(tmhm_labels(), arr))

    tm_items = [i for i, e in enumerate(entries) if e[IT_CATEGORY] == 0x06]
    if len(tm_items) != TM_COUNT + HM_COUNT:
        raise RomError(f"found {len(tm_items)} TM/HM items, expected 101")
    seen = sorted(entries[i][IT_TMHM_INDEX] for i in tm_items)
    if seen != list(range(101)):
        raise RomError("TM/HM display indices do not cover 0..100 exactly")

    items: dict[str, dict] = {}
    tmhm: dict[str, dict] = {}
    for iid, entry in enumerate(entries):
        stored = struct.unpack_from("<H", entry, IT_PRICE)[0]
        price = stored * PRICE_SCALE
        rec = {
            "name": names[iid],
            "description": descs[iid] if iid < len(descs) else "",
            "price": price,
            "price_raw": stored,
            "category": entry[IT_CATEGORY],
            "raw": entry.hex(),
        }
        if entry[IT_CATEGORY] == 0x06:
            label = display_label(entry[IT_TMHM_INDEX])
            move_id = by_label[label]
            rec["tm_hm"] = label
            rec["move_id"] = move_id
            rec["move"] = move_names[str(move_id)]
            tmhm[label] = {
                "item_id": iid,
                "move_id": move_id,
                "move": move_names[str(move_id)],
                "price": price,
            }
        items[str(iid)] = rec

    return {"items": items, "tm_hm": tmhm, "item_count": len(entries)}


def build_maps(rom: NDSRom) -> dict:
    locations = [clean(n) for n in load_text(rom, TEXT_FILE_LOCATION_NAMES)]
    blob = parse_narc(rom.file_data(ZONE_NARC))[0]
    if len(blob) % ZONE_ENTRY_SIZE:
        raise RomError(
            f"zone table {len(blob)} bytes is not a multiple of {ZONE_ENTRY_SIZE}"
        )
    count = len(blob) // ZONE_ENTRY_SIZE

    zones = {}
    for z in range(count):
        idx = blob[z * ZONE_ENTRY_SIZE + ZONE_LOCATION_NAME]
        if idx >= len(locations):
            raise RomError(
                f"zone {z} points at location name {idx} but only "
                f"{len(locations)} names exist"
            )
        zones[str(z)] = {"location_id": idx, "location": locations[idx]}

    return {
        "locations": {str(i): n for i, n in enumerate(locations)},
        "zones": zones,
        "zone_count": count,
        "location_count": len(locations),
    }


def find_marts(arm9: bytes, item_count: int) -> list[dict]:
    """Best-effort scan for mart inventories.  Returns [] when unconvincing.

    Kept so the next attempt starts from a known-negative result rather than
    from scratch.  See the module docstring for why nothing is emitted.
    """
    words = struct.unpack("<%dH" % (len(arm9) // 2), arm9[: len(arm9) // 2 * 2])
    runs, i = [], 0
    while i < len(words):
        if 1 <= words[i] < item_count:
            j = i
            while j < len(words) and 1 <= words[j] < item_count:
                j += 1
            if j - i >= 5 and j < len(words) and words[j] == 0xFFFF:
                runs.append({"offset": i * 2, "items": list(words[i:j])})
            i = j
        else:
            i += 1
    return runs if len(runs) >= 8 else []


# --------------------------------------------------------------------------
# Diff against vanilla
# --------------------------------------------------------------------------
def diff_items(hack: dict, vanilla: dict) -> dict:
    changed_price, changed_name, changed_tm = [], [], []
    for iid, h in hack["items"].items():
        v = vanilla["items"].get(iid)
        if not v:
            continue
        if h["price"] != v["price"]:
            changed_price.append({"id": int(iid), "name": h["name"],
                                  "vanilla": v["price"], "hack": h["price"]})
        if h["name"] != v["name"]:
            changed_name.append({"id": int(iid),
                                 "vanilla": v["name"], "hack": h["name"]})
    for label, h in hack["tm_hm"].items():
        v = vanilla["tm_hm"].get(label)
        if v and v["move_id"] != h["move_id"]:
            changed_tm.append({"tm": label, "vanilla": v["move"], "hack": h["move"]})
    return {
        "counts": {
            "price": len(changed_price),
            "name": len(changed_name),
            "tm_move": len(changed_tm),
        },
        "price": changed_price,
        "name": changed_name,
        "tm_move": changed_tm,
    }


# --------------------------------------------------------------------------
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--rom", type=Path, default=DEFAULT_ROM)
    ap.add_argument("--vanilla", type=Path, default=VANILLA_ROM)
    args = ap.parse_args(argv)

    moves_path = STATE_DIR / "moves.json"
    if not moves_path.is_file():
        print("extract_items: state/moves.json missing -- run extract_personal.py first",
              file=sys.stderr)
        return 2
    move_names = {k: v["name"] for k, v in json.loads(moves_path.read_text())["moves"].items()}

    try:
        rom = NDSRom(args.rom)
        arm9 = read_arm9(args.rom)
        hack = build_items(rom, arm9, move_names)
        maps = build_maps(rom)
    except RomError as exc:
        print(f"extract_items: {exc}", file=sys.stderr)
        return 1

    diff = None
    if args.vanilla.is_file():
        try:
            vrom = NDSRom(args.vanilla)
            varm9 = read_arm9(args.vanilla)
            vanilla = build_items(vrom, varm9, move_names)
            diff = diff_items(hack, vanilla)
        except RomError as exc:
            print(f"extract_items: vanilla diff skipped ({exc})", file=sys.stderr)

    marts = find_marts(arm9, hack["item_count"])

    STATE_DIR.mkdir(exist_ok=True)
    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "rom": str(args.rom),
        "text_narc": TEXT_NARC,
        "item_data_narc": ITEMDATA_NARC,
        "tm_first_item_id": min(v["item_id"] for v in hack["tm_hm"].values()),
        "field_items": "not extracted -- see module docstring",
        "hidden_items": "not extracted -- see module docstring",
        "marts": "not extracted" if not marts else f"{len(marts)} candidate runs",
    }
    (STATE_DIR / "items.json").write_text(json.dumps(
        {"meta": meta, "items": hack["items"], "tm_hm": hack["tm_hm"], "diff": diff},
        indent=1))
    (STATE_DIR / "maps.json").write_text(json.dumps({"meta": meta, **maps}, indent=1))

    print(f"extract_items: {hack['item_count']} items, "
          f"{len(hack['tm_hm'])} TM/HM -> state/items.json")
    print(f"extract_items: {maps['zone_count']} zones, "
          f"{maps['location_count']} locations -> state/maps.json")
    if diff:
        print(f"extract_items: vs vanilla -- {diff['counts']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
