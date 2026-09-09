#!/usr/bin/env python3
"""
dump_pk5_truth.py -- emit ground truth for the JavaScript PK5 port (js/).

Runs the Python readers (parse_save.py) and writers (write_team.py) over a
corpus of saves and dumps every value the JS layer must reproduce.  The JS
suite (tests/test_pk5.mjs) then asserts equality field by field, so the port
is checked against the implementation that has actually been trusted with the
real save -- not against a fresh reading of the same documentation.

CORPUS
    tests/fixture.sav          small, frozen, 5 party members, empty boxes
    save_backups/<newest>.sav  dense: 24 exposed boxes, ~265 records, a
                               battle box, engineered Pokemon, shinies

The dense corpus is what actually exercises the port; the fixture alone would
never touch a box record or the Battle Box.  It is pinned by CRC16, so if the
file changes the JS test says so instead of silently comparing to stale truth.

READ-ONLY.  It never opens the live save, and every write-path check runs on
an in-memory copy.
"""
from __future__ import annotations

import glob
import json
import os
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import parse_save as ps
import write_team as wt

OUT = ROOT / "tests" / "pk5_truth.json"

BATTLE_BOX, BATTLE_BOX_LEN, BATTLE_BOX_SLOTS = 0x20A00, 0x35C, 6
BAG_POCKETS = {"items": (0x000, 310), "key_items": (0x4D8, 83),
               "tms_hms": (0x624, 109), "medicine": (0x7D8, 55),
               "berries": (0x8B4, 67)}


def record_fields(rec: bytes, is_party: bool) -> dict | None:
    """Every field the JS decodeRecord() produces, in its key order."""
    f = ps.decode_pk5(rec, is_party)
    if f is None:
        return None
    pid, sanity, chk = struct.unpack_from("<IHH", rec, 0)
    body = ps.unshuffle(ps.lcrng_crypt(rec[8:136], chk), pid)
    out = {
        "pid": f["pid"], "sanity": sanity, "checksum": chk,
        "species_id": f["species_id"], "item_id": f["item_id"],
        "tid": f["tid"], "sid": f["sid"], "exp": f["exp"],
        "friendship": f["friendship"], "ability_id": f["ability_id"],
        "nature_id": f["nature_id"],
        "gender": (body[0x38] >> 1) & 3, "gender_byte": body[0x38],
        "evs": f["evs"], "ivs": f["ivs"],
        "is_egg": f["is_egg"], "is_nicknamed": f["is_nicknamed"],
        "is_shiny": (f["tid"] ^ f["sid"] ^ (f["pid"] >> 16) ^ (f["pid"] & 0xFFFF)) < 8,
        "move_ids": f["move_ids"],
        "pp": list(body[0x28:0x2C]), "pp_ups": list(body[0x2C:0x30]),
        "nickname": f["nickname"], "ot_name": f["ot_name"],
        "stored_level": f["stored_level"],
        "body_hex": body.hex(),
    }
    if is_party and "stored_stats" in f:
        out["current_hp"] = f["current_hp"]
        out["stored_stats"] = f["stored_stats"]
    return out


def read_corpus(path: Path) -> dict:
    data = path.read_bytes()
    assert len(data) == ps.SAVE_SIZE, f"{path}: {len(data)} bytes"

    warnings: list[str] = []
    slot_index, reports, reason = ps.choose_slot(data, warnings)
    base = ps.SLOT_OFFSETS[slot_index]

    groups: dict[str, list] = {}
    for i in range(ps.PARTY_SLOTS):
        off = base + ps.PARTY_BLOCK + ps.PARTY_FIRST + i * ps.PK5_PARTY_SIZE
        f = record_fields(data[off:off + ps.PK5_PARTY_SIZE], True)
        if f:
            groups.setdefault("party", []).append({"slot": i + 1, **f})
    for i in range(BATTLE_BOX_SLOTS):
        off = base + BATTLE_BOX + i * ps.PK5_BOX_SIZE
        f = record_fields(data[off:off + ps.PK5_BOX_SIZE], False)
        if f:
            groups.setdefault("battleBox", []).append({"slot": i + 1, **f})
    for b in range(ps.BOX_COUNT):
        for s in range(ps.BOX_SLOTS):
            off = base + ps.BOX_BASE + b * ps.BOX_STRIDE + s * ps.PK5_BOX_SIZE
            f = record_fields(data[off:off + ps.PK5_BOX_SIZE], False)
            if f:
                groups.setdefault(str(b), []).append({"slot": s + 1, **f})

    checksums = []
    for si, sbase in enumerate(ps.SLOT_OFFSETS):
        blocks = [("box names", 0x00000, 0x3E0, 0), ("bag", 0x18400, 0x09C0, 25),
                  ("party", 0x18E00, 0x534, 26),
                  ("battle box", BATTLE_BOX, BATTLE_BOX_LEN, 49)]
        blocks += [(f"box {n+1}", ps.BOX_BASE + n * ps.BOX_STRIDE, ps.BOX_DATA_LEN, 1 + n)
                   for n in range(ps.BOX_COUNT)]
        for name, start, length, entry in blocks:
            off = sbase + start
            checksums.append({
                "slot": si, "block": name, "entry": entry,
                "crc": ps.crc16_ccitt(data[off:off + length]),
                "inline": struct.unpack_from("<H", data, off + length + 2)[0],
                "table": struct.unpack_from("<H", data, sbase + ps.CHECKSUM_TABLE + 2 * entry)[0],
            })
        checksums.append({
            "slot": si, "block": "footer", "entry": None,
            "crc": ps.crc16_ccitt(data[sbase + ps.CHECKSUM_TABLE:sbase + 0x23F8C]),
            "inline": struct.unpack_from("<H", data, sbase + ps.FOOTER + 0x0E),
            "table": None,
        })
        checksums[-1]["inline"] = struct.unpack_from("<H", data, sbase + ps.FOOTER + 0x0E)[0]

    bag = {}
    for pocket, (off0, cap) in BAG_POCKETS.items():
        entries = []
        for i in range(cap):
            iid, cnt = struct.unpack_from("<HH", data, base + 0x18400 + off0 + 4 * i)
            if iid == 0:
                break
            entries.append({"item_id": iid, "count": cnt})
        bag[pocket] = entries

    return {
        "file": str(path.relative_to(ROOT)),
        "bytes": len(data),
        "crc16": ps.crc16_ccitt(data),
        "slot": {"index": slot_index, "reason": reason, "reports": reports},
        "box_capacity": data[base + 0x3DD],
        "selected_box": struct.unpack_from("<I", data, base + 0x000)[0],
        "box_names": ps.box_names(data, base),
        "party_count_declared": struct.unpack_from(
            "<I", data, base + ps.PARTY_BLOCK + ps.PARTY_COUNT_OFF)[0],
        "records": groups,
        "record_count": sum(len(v) for v in groups.values()),
        "checksums": checksums,
        "bag": bag,
    }


# Specs chosen to exercise every branch of build_record: an explicit nickname
# (sets the nicknamed flag), forced-shiny and forced-normal PIDs, a partial
# move list (PP zeroing), partial EV/IV objects (defaults fill the rest), a
# genderless species, a female-only species, and an illegal ability.
BUILD_SPECS = [
    dict(species="Metagross", level=50, ability="Iron Fist", nature="Adamant",
         moves=["Meteor Mash", "Earthquake", "Bullet Punch", "Zen Headbutt"],
         item_id=234, shiny=True, nick="M Meta"),
    dict(species="Slowking", level=42, ability="Drizzle", nature="Quiet",
         moves=["Scald", "Trick Room"], item_id=0, shiny=False,
         evs={"hp": 252, "spa": 252, "spe": 0, "atk": 0, "def": 4, "spd": 0},
         ivs={"hp": 31, "atk": 0, "def": 31, "spa": 31, "spd": 31, "spe": 0}),
    dict(species="Magnezone", level=60, ability="Levitate", nature="Timid",
         moves=["Thunderbolt", "Flash Cannon", "Volt Switch", "Hidden Power"],
         item_id=270),
    dict(species="Chansey", level=1, ability="Wonder Guard", nature="Bold",
         moves=["Soft-Boiled"], item_id=0, shiny=False),
    dict(species="Shedinja", level=100, ability="Wonder Guard", nature="Jolly",
         moves=["Shadow Sneak", "X-Scissor", "Swords Dance", "Will-O-Wisp"],
         item_id=273),
]


def write_path(data: bytes, base: int, template_where: tuple[int, int] | None) -> dict:
    """Build records and reseal an in-memory copy; hand the JS side the bytes."""
    if template_where is None:
        tmpl_off = base + ps.PARTY_BLOCK + ps.PARTY_FIRST   # a party slot's first 136 bytes
    else:                                                    # box, slot (0-indexed)
        b, s = template_where
        tmpl_off = base + ps.BOX_BASE + b * ps.BOX_STRIDE + s * ps.PK5_BOX_SIZE
    template = data[tmpl_off:tmpl_off + ps.PK5_BOX_SIZE]
    assert wt.decode_body(template) is not None, "template did not decode"

    species, moves, abil = wt.load_tables()
    built = [wt.build_record(template, s, species, moves, abil).hex() for s in BUILD_SPECS]

    edited = bytearray(data)
    recs = [bytes.fromhex(h) for h in built]
    wt.place(edited, 8, recs + [b"\x00" * 136] * (ps.BOX_SLOTS - len(recs)))
    wt.add_bag_items(edited, [(234, 3, "items"), (328, 1, "tms_hms")])
    wt.reseal(edited, [wt.box_block(8), (wt.BAG_BLOCK, wt.BAG_LEN, wt.CHK_BAG)])

    return {
        "template_hex": template.hex(),
        "specs": BUILD_SPECS,
        "built_hex": built,
        "edited_crc16": ps.crc16_ccitt(bytes(edited)),
        "edit_plan": {"box": 8, "bag_items": [[234, 3, "items"], [328, 1, "tms_hms"]]},
    }


def main() -> int:
    corpora = {}
    fixture = ROOT / "tests" / "fixture.sav"
    corpora["fixture"] = read_corpus(fixture)
    corpora["fixture"]["write"] = write_path(
        fixture.read_bytes(), ps.SLOT_OFFSETS[corpora["fixture"]["slot"]["index"]], None)

    backups = sorted(glob.glob(str(ROOT / "save_backups" / "*.sav")), key=os.path.getmtime)
    if backups:
        dense = Path(backups[-1])
        corpora["dense"] = read_corpus(dense)
        # Box 2 slot 3 is the record write_team.py itself clones from.
        corpora["dense"]["write"] = write_path(
            dense.read_bytes(), ps.SLOT_OFFSETS[corpora["dense"]["slot"]["index"]], (1, 2))

    curves = {ps.CURVE_NAMES[c]: [ps.exp_for_level(c, n) for n in range(1, 101)]
              for c in range(6)}

    OUT.write_text(json.dumps({
        "generated_by": "tests/dump_pk5_truth.py",
        "curves": curves,
        "natures": list(ps.NATURES),
        "corpora": corpora,
    }, indent=1))

    for name, c in corpora.items():
        print(f"  {name:8s} {c['file']:52s} {c['record_count']:4d} records, "
              f"{len(c['checksums'])} checksums")
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
