#!/usr/bin/env python3
"""
write_team.py -- write a designed team into the Blaze Black save.

This is the counterpart to parse_save.py's READ-ONLY contract: the one module
that is allowed to modify the .sav.  It exists because the write procedure was
documented prose and nothing in the repo implemented it, so the three integrity
tiers had to be re-derived by hand every time.

=============================================================================
WHAT IT DOES
=============================================================================
Builds PK5 records by CLONING a known-good, already-in-game record and patching
fields on it.  Cloning rather than constructing from scratch means every byte
this script does not understand -- origin game, language, ball, met location,
met date, encounter type, ribbons -- is carried over from a record the cartridge
has already accepted, instead of being guessed.

=============================================================================
THE THREE INTEGRITY TIERS (all three or the game wipes the save)
=============================================================================
    1. each block's inline checksum, 2 bytes past the block end
       box N -> 0x400 + N*0x1000 + 0xFF2      (verified empirically)
    2. the matching entry in the central table at 0x23F00
       box N -> entry 1 + N
    3. the footer CRC at 0x23F8C+0x0E, CRC16-CCITT over [0x23F00, 0x23F8C)

Both save slots (0x00000 and 0x24000) are written identically, because this
save carries the same counter in both and the game may pick either.

=============================================================================
ID GOTCHAS -- both verified against the live save, not assumed
=============================================================================
  * SAVE MOVE ID = state/moves.json id + 1.  moves.json is 0-indexed; the save
    is 1-indexed.  Confirmed on 11 known records (Earthquake save 89 ==
    moves.json 88, Scald save 503 == moves.json 502, ...).
  * ABILITY ID = line number in wiki/docs/includes/abilities.md, 1-indexed.
    Confirmed: 2 -> Drizzle, 46 -> Pressure, 89 -> Iron Fist.
  * PP is stored already boosted: maxpp = base + base*3//5 with 3 PP-ups.
  * The gender byte at body 0x38 encodes gender = (byte >> 1) & 3:
    0x00 male, 0x02 female, 0x04 genderless.  Verified against every record in
    the save.
"""

from __future__ import annotations

import json
import re
import shutil
import struct
import sys
import subprocess
from datetime import datetime
from pathlib import Path

import paths

sys.path.insert(0, str(Path(__file__).parent))
import parse_save as ps

ROOT = Path(__file__).parent
SAVE = paths.SAVE
BACKUPS = ROOT / "save_backups"

# ---------------------------------------------------------------- PK5 offsets
B_SPECIES, B_ITEM, B_TID, B_EXP = 0x00, 0x02, 0x04, 0x08
B_FRIENDSHIP, B_ABILITY = 0x0C, 0x0D
B_EVS, B_MOVES, B_PP, B_PPUP = 0x10, 0x20, 0x28, 0x2C
B_IVS, B_GENDER, B_NATURE, B_DWFLAG = 0x30, 0x38, 0x39, 0x3A
B_NICKNAME = 0x40

SAVE_STAT_ORDER = ("hp", "atk", "def", "spe", "spa", "spd")   # note: Spe is 4th

# ------------------------------------------------------------------- the Bag
# Block 0x18400 len 0x09C0, checksum-table entry 25, inline checksum at +0x09C2.
# Each pocket is a flat array of {u16 item id, u16 count} ending at a zero id.
# Offsets and capacities are parse_bag.py's, which verified them three ways.
BAG_BLOCK, BAG_LEN, CHK_BAG = 0x18400, 0x09C0, 25
POCKETS = {
    "items": (0x000, 310), "key_items": (0x4D8, 83), "tms_hms": (0x624, 109),
    "medicine": (0x7D8, 55), "berries": (0x8B4, 67),
}
MAX_STACK = 999          # Gen 5 per-slot cap


# ------------------------------------------------------------------ ROM tables
def load_tables():
    P = json.load(open(ROOT / "state/personal.json"))
    if isinstance(P, dict) and "species" in P:
        P = P["species"]
    plist = list(P.values()) if isinstance(P, dict) else list(P)
    species = {}
    for i, v in enumerate(plist):
        species[str(v["name"]).lower()] = (v.get("id", i + 1), v)

    M = json.load(open(ROOT / "state/moves.json"))
    if isinstance(M, dict) and "moves" in M:
        M = M["moves"]
    mlist = list(M.values()) if isinstance(M, dict) else list(M)
    moves = {}
    for i, v in enumerate(mlist):
        moves[str(v["name"]).lower()] = (v.get("id", i) + 1, v)   # +1: see docstring

    abil = {}
    for i, line in enumerate(
        (l.strip() for l in open(ROOT / "wiki/docs/includes/abilities.md", encoding="utf-8")
         if l.strip()), 1):
        m = re.match(r"\*\[([^\]]+)\]:", line)
        if m:
            abil[m.group(1)] = i
    return species, moves, abil


NATURES = {n: i for i, n in enumerate(ps.NATURES)}


# --------------------------------------------------------------- record codec
def decode_body(rec: bytes):
    pid, sanity, chk = struct.unpack_from("<IHH", rec, 0)
    if pid == 0 and chk == 0:
        return None
    body = ps.unshuffle(ps.lcrng_crypt(rec[8:136], chk), pid)
    if ps.pk5_checksum(body) != chk:
        return None
    # An emptied slot is not always all-zero: the game rewrites cleared slots
    # with a non-zero stored checksum and species 0, and those decode cleanly.
    # parse_save.decode_pk5 guards on this; without the same guard here a blank
    # slot reads as a phantom record and miscounts every box.
    if struct.unpack_from("<H", body, B_SPECIES)[0] == 0:
        return None
    return pid, sanity, body


def encode_record(pid: int, sanity: int, body: bytes) -> bytes:
    """Inverse of decode_body.  Checksum is order-independent (a sum of u16s)."""
    assert len(body) == 128
    chk = ps.pk5_checksum(body)
    enc = ps.lcrng_crypt(ps.shuffle(body, pid), chk)
    return struct.pack("<IHH", pid, sanity, chk) + enc


def selftest_roundtrip(data: bytes) -> None:
    """Prove encode(decode(x)) == x on every populated record before writing."""
    n = 0
    for b in range(ps.BOX_COUNT):
        for s in range(ps.BOX_SLOTS):
            off = ps.BOX_BASE + b * ps.BOX_STRIDE + s * 136
            rec = data[off:off + 136]
            got = decode_body(rec)
            if got is None:
                continue
            pid, sanity, body = got
            if encode_record(pid, sanity, body) != rec:
                raise SystemExit(f"ROUND-TRIP FAILED at box {b+1} slot {s+1} -- refusing to write")
            n += 1
    print(f"  self-test: {n} existing records re-encode byte-identically")


# ------------------------------------------------------------------ patching
def build_record(template: bytes, spec: dict, species, moves, abil) -> bytes:
    """Clone `template` (a 136-byte record) and patch it into `spec`."""
    pid, sanity, body = decode_body(template)
    body = bytearray(body)

    sid, sdata = species[spec["species"].lower()]
    struct.pack_into("<H", body, B_SPECIES, sid)
    struct.pack_into("<H", body, B_ITEM, spec["item_id"])

    curve = sdata["growth_curve_id"]
    struct.pack_into("<I", body, B_EXP, ps.exp_for_level(curve, spec["level"]))

    body[B_FRIENDSHIP] = 255
    body[B_ABILITY] = abil[spec["ability"]]
    # Gen 5 stores the ability explicitly in the byte above, so the Dream World
    # flag is left at 0 -- matching the template and every other edited record
    # in this save (the party Slowking runs Drizzle, its slot-2 ability, with
    # the flag clear).  Setting it can make the game re-derive the ability.
    body[B_DWFLAG] = 0

    for i, key in enumerate(SAVE_STAT_ORDER):
        body[B_EVS + i] = spec.get("evs", {}).get(key, 252)

    mids = []
    for name in spec["moves"]:
        mid, mdata = moves[name.lower()]
        mids.append((mid, mdata["pp"]))
    while len(mids) < 4:
        mids.append((0, 0))
    for i, (mid, basepp) in enumerate(mids):
        struct.pack_into("<H", body, B_MOVES + 2 * i, mid)
        body[B_PP + i] = basepp + basepp * 3 // 5 if mid else 0
        body[B_PPUP + i] = 3 if mid else 0

    iv = 0
    for i, key in enumerate(SAVE_STAT_ORDER):
        iv |= (spec.get("ivs", {}).get(key, 31) & 0x1F) << (5 * i)
    if spec.get("nick"):
        iv |= (1 << 31)                                 # nicknamed
    struct.pack_into("<I", body, B_IVS, iv)             # egg=0

    # Gender byte 0x38: gender = (byte >> 1) & 3, i.e. 0x00 male, 0x02 female,
    # 0x04 genderless.  Confirmed across all 269 records in this save -- every
    # ratio-254 species carries 0x02 and every ratio-255 species carries 0x04.
    # (This used to write 0x02 for genderless, which is "female"; the game
    # normalised it on load because the species table forces genderless, so no
    # damage was done, but it was wrong.)
    ratio = sdata["gender_ratio"]
    body[B_GENDER] = 0x04 if ratio == 255 else (0x02 if ratio == 254 else 0x00)
    body[B_NATURE] = NATURES[spec["nature"]]

    # Shininess is derived, not stored: a Pokemon is shiny when
    #     TID ^ SID ^ (PID >> 16) ^ (PID & 0xFFFF)  <  8
    # so a PID is constructed to force that XOR to 0.  Safe to change: PID also
    # seeds the block shuffle, but encode_record re-shuffles with the same PID,
    # and Gen 5 reads gender from byte 0x38 and nature from 0x39 rather than
    # from the PID, both of which are written explicitly above.
    # NOTE: the template record this clones from is ITSELF shiny (its PID
    # gives XOR 5), so anything cloned from it inherits shininess unless told
    # otherwise.  `shiny` is therefore three-valued: True forces shiny, False
    # forces NOT shiny, and omitting it keeps whatever the template had.
    if spec.get("shiny") is not None:
        tid, sid = struct.unpack_from("<HH", body, B_TID)
        low = pid & 0xFFFF
        high = (tid ^ sid ^ low) & 0xFFFF          # XOR 0 -> shiny
        if not spec["shiny"]:
            high ^= 0x8000                          # push the XOR well past 8
        pid = (high << 16) | low

    # nickname string: species name uppercased, UTF-16LE, 0xFFFF-terminated.
    # The nicknamed flag stays 0, so the game shows its own species name; this
    # only keeps the stored string consistent with the rest of the save.
    # An explicit `nick` sets a real nickname and flips the nicknamed bit so
    # the game shows it; otherwise the species name is stored with the flag
    # clear, which displays as the species name.
    nick = spec.get("nick") or re.sub(r"-.*$", "", spec["species"]).upper()[:10]
    raw = nick[:10].encode("utf-16-le") + b"\xff\xff"
    raw = raw.ljust(22, b"\x00")[:22]
    body[B_NICKNAME:B_NICKNAME + 22] = raw

    return encode_record(pid, sanity, bytes(body))


# ------------------------------------------------------------- integrity tiers
def add_bag_items(data: bytearray, additions: list[tuple[int, int, str]]) -> None:
    """Add (item_id, count, pocket) to the Bag, in both slots.

    Existing entries are topped up rather than duplicated, and the pocket's
    terminating zero id is preserved, so nothing already in the bag is lost.
    """
    for slot in ps.SLOT_OFFSETS:
        for item_id, count, pocket in additions:
            off0, cap = POCKETS[pocket]
            base = slot + BAG_BLOCK + off0
            slot_idx, found = None, False
            for i in range(cap):
                iid = struct.unpack_from("<H", data, base + 4 * i)[0]
                if iid == item_id:
                    slot_idx, found = i, True
                    break
                if iid == 0:
                    slot_idx = i
                    break
            if slot_idx is None:
                raise SystemExit(f"pocket {pocket} full -- cannot add item {item_id}")
            cur = struct.unpack_from("<H", data, base + 4 * slot_idx + 2)[0] if found else 0
            struct.pack_into("<H", data, base + 4 * slot_idx, item_id)
            struct.pack_into("<H", data, base + 4 * slot_idx + 2, min(cur + count, MAX_STACK))
            if not found and slot_idx + 1 < cap:      # keep the terminator
                struct.pack_into("<H", data, base + 4 * (slot_idx + 1), 0)


def reseal(data: bytearray, blocks: list[tuple[int, int, int]]) -> None:
    """Refresh all three integrity tiers, in both save slots.

    blocks: (slot-relative start, length, checksum-table entry).
    """
    for slot in ps.SLOT_OFFSETS:
        table = slot + ps.CHECKSUM_TABLE
        for start, length, entry in blocks:
            off = slot + start
            crc = ps.crc16_ccitt(bytes(data[off:off + length]))
            struct.pack_into("<H", data, off + length + 2, crc)            # tier 1
            struct.pack_into("<H", data, table + 2 * entry, crc)           # tier 2
        footer_crc = ps.crc16_ccitt(bytes(data[table:slot + 0x23F8C]))
        struct.pack_into("<H", data, slot + ps.FOOTER + 0x0E, footer_crc)  # tier 3


def box_block(b: int) -> tuple[int, int, int]:
    return (ps.BOX_BASE + b * ps.BOX_STRIDE, ps.BOX_DATA_LEN, 1 + b)


# ------------------------------------------------------------------- placement
def place(data: bytearray, box: int, records: list[bytes]) -> None:
    for i, rec in enumerate(records):
        for slot in ps.SLOT_OFFSETS:
            off = slot + ps.BOX_BASE + box * ps.BOX_STRIDE + i * 136
            data[off:off + 136] = rec


def main(teams: dict[int, list[dict]], template_box=1, template_slot=2, label="edit",
         bag_items: list[tuple[int, int, str]] | None = None) -> int:
    if subprocess.run("tasklist.exe 2>/dev/null | grep -i melon",
                      shell=True, capture_output=True).stdout.strip():
        raise SystemExit("melonDS is RUNNING -- close it first, it will clobber the write")
    print("melonDS: not running")

    raw, meta = ps.read_save(SAVE)
    print(f"read {len(raw)} bytes, mtime age ok")
    selftest_roundtrip(raw)

    BACKUPS.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = BACKUPS / f"pokemon_blaze_black.{stamp}.pre-{label}.sav"
    shutil.copy2(SAVE, backup)
    print(f"backup -> {backup.name}")

    species, moves, abil = load_tables()
    tmpl_off = ps.BOX_BASE + template_box * ps.BOX_STRIDE + template_slot * 136
    template = raw[tmpl_off:tmpl_off + 136]
    if decode_body(template) is None:
        raise SystemExit("template record did not decode -- aborting")

    data = bytearray(raw)
    for box, specs in teams.items():
        recs = [build_record(template, s, species, moves, abil) for s in specs]
        # blank the rest of the box so no stale record survives
        recs_full = recs + [b"\x00" * 136] * (ps.BOX_SLOTS - len(recs))
        place(data, box, recs_full)
        print(f"box {box+1}: wrote {len(recs)} ({', '.join(s['species'] for s in specs)})")

    blocks = [box_block(b) for b in teams]
    if bag_items:
        add_bag_items(data, bag_items)
        blocks.append((BAG_BLOCK, BAG_LEN, CHK_BAG))
        print(f"bag: added {len(bag_items)} item stacks")
    reseal(data, blocks)

    tmp = ROOT / "state/_candidate.sav"
    tmp.write_bytes(data)
    print(f"wrote candidate -> {tmp}")
    return 0


if __name__ == "__main__":
    raise SystemExit("import this module and call main() with a team spec")
