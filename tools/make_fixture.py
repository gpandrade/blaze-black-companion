#!/usr/bin/env python3
"""
make_fixture.py -- build the anonymised test fixture.

tests/fixture.sav is a REAL save, and a real save carries a trainer's OT name,
trainer id and secret id.  The repo is meant to go public, so the committed
fixture is derived from it with those scrubbed -- while staying a byte-exact,
checksum-valid Gen 5 save that the parser must handle identically.

    python3 tools/make_fixture.py --from tests/fixture.sav --out tests/fixture.sav

WHAT IS CHANGED, AND WHAT IS NOT
    trainer id / secret id   replaced with fixed, obviously-fake values
    OT name                  kept as "Bobo" by choice -- a calling card, and
                             nobody's real name
    everything else          untouched: species, levels, stats, IVs, EVs,
                             moves, box layout, position, the bag

SHININESS IS DERIVED FROM THE IDs, so changing them changes which Pokemon are
shiny.  Every record's PID is therefore adjusted to preserve its ORIGINAL
shiny state under the new ids -- otherwise the fixture would quietly stop
testing what it used to.

All three integrity tiers are refreshed afterwards, and the result is
re-validated before it is written.
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import parse_save as ps

# Deliberately memorable and obviously not a real trainer's.
FAKE_TID, FAKE_SID = 12345, 54321
BATTLE_BOX, BATTLE_BOX_SLOTS = 0x20A00, 6

B_TID, B_SID = 0x04, 0x06


def is_shiny(tid: int, sid: int, pid: int) -> bool:
    return (tid ^ sid ^ (pid >> 16) ^ (pid & 0xFFFF)) < 8


def rewrite_record(data: bytearray, off: int, size: int) -> str | None:
    """Re-ID one PK5 record in place.  Returns a description, or None if empty."""
    pid, sanity, chk = struct.unpack_from("<IHH", data, off)
    if pid == 0 and chk == 0:
        return None
    body = bytearray(ps.unshuffle(ps.lcrng_crypt(bytes(data[off + 8:off + 136]), chk), pid))
    if ps.pk5_checksum(bytes(body)) != chk:
        return None
    if struct.unpack_from("<H", body, 0x00)[0] == 0:
        return None

    old_tid, old_sid = struct.unpack_from("<HH", body, B_TID)
    was_shiny = is_shiny(old_tid, old_sid, pid)

    struct.pack_into("<HH", body, B_TID, FAKE_TID, FAKE_SID)

    # Shininess is TID ^ SID ^ pid_hi ^ pid_lo < 8, so new ids change it.
    # Rebuild the PID's high half to restore whatever it was.
    low = pid & 0xFFFF
    high = (FAKE_TID ^ FAKE_SID ^ low) & 0xFFFF          # forces the xor to 0
    if not was_shiny:
        high ^= 0x8000                                    # push it well past 8
    new_pid = ((high << 16) | low) & 0xFFFFFFFF
    assert is_shiny(FAKE_TID, FAKE_SID, new_pid) == was_shiny

    new_chk = ps.pk5_checksum(bytes(body))
    enc = ps.lcrng_crypt(ps.shuffle(bytes(body), new_pid), new_chk)
    struct.pack_into("<IHH", data, off, new_pid, sanity, new_chk)
    data[off + 8:off + 136] = enc

    # A party slot's extra block is encrypted under the PID, so it has to be
    # decrypted with the old one and re-encrypted with the new.
    if size == ps.PK5_PARTY_SIZE:
        extra = ps.lcrng_crypt(bytes(data[off + 0x88:off + 0x88 + 84]), pid)
        data[off + 0x88:off + 0x88 + 84] = ps.lcrng_crypt(extra, new_pid)

    return f"{struct.unpack_from('<H', body, 0)[0]}{'*' if was_shiny else ''}"


# ---------------------------------------------------------------------------
# The TABLE fixtures
# ---------------------------------------------------------------------------
# tests/personal.fixture.json shipped as the COMPLETE ROM extract: all 649
# species with base stats, both abilities, the hidden ability, learnsets, TM/HM
# compatibility and evolutions, at 2.0 MB -- plus the absolute path of the
# author's ROM in its metadata. .gitignore says of exactly this data: "these
# are the game's own data, and shipping them is the part that attracts
# takedowns, not the code that reads them", and the repo was about to publish
# it anyway.
#
# The tests never needed it. Everything that reads the JSON fixture looks up
# the five species in tests/fixture.sav; the sweeps over the whole table read
# the real ROM, and skip when it is absent. So the committed fixture is cut to
# the species the fixture save actually contains, plus what they evolve into,
# and the moves those five can learn or know.
def species_in_save(save: Path) -> set[int]:
    """Every species id present in the fixture save, party and boxes."""
    out: set[int] = set()
    data = save.read_bytes()
    for base in ps.SLOT_OFFSETS:
        for i in range(ps.PARTY_SLOTS):
            off = base + ps.PARTY_BLOCK + ps.PARTY_FIRST + i * ps.PK5_PARTY_SIZE
            rec = ps.decode_pk5(data[off:off + ps.PK5_PARTY_SIZE], True)
            dex = (rec or {}).get("species_id") or (rec or {}).get("species")
            if dex:
                out.add(int(dex))
    return out


def trim_tables(personal: Path, moves: Path, save: Path) -> tuple[int, int]:
    """Cut both JSON fixtures down to what the tests actually read."""
    pdoc = json.loads(personal.read_text(encoding="utf-8"))
    mdoc = json.loads(moves.read_text(encoding="utf-8"))

    keep = species_in_save(save)
    # Evolution targets too: cheap, and a test that follows one should not have
    # to care whether the fixture happens to stop at the pre-evolution.
    for dex in list(keep):
        for evo in pdoc["species"].get(str(dex), {}).get("evolutions", []):
            if evo.get("into_id"):
                keep.add(evo["into_id"])

    species = {k: v for k, v in pdoc["species"].items() if int(k) in keep}
    mkeep: set[int] = set()
    for entry in species.values():
        for lv in entry.get("learnset", []):
            mkeep.add(lv["move_id"])
    # The four the move test spot-checks by name, in case a trimmed learnset
    # no longer happens to reach them.
    mkeep |= {33, 45, 55, 71}
    movetab = {k: v for k, v in mdoc["moves"].items() if int(k) in mkeep}

    # Every absolute path in the metadata is the author's home directory.
    # Strip them WHEREVER they sit rather than at the two keys you happen to
    # think of -- `meta.rom.path` was stripped by name and `meta.vanilla_rom.
    # .path` sailed straight through into the export, where the publication
    # scan caught it.
    def depath(node: object) -> None:
        if isinstance(node, dict):
            node.pop("path", None)
            for v in node.values():
                depath(v)
        elif isinstance(node, list):
            for v in node:
                depath(v)

    for doc in (pdoc, mdoc):
        depath(doc.get("meta"))
        doc["meta"]["trimmed_for_publication"] = (
            "Cut to the species in tests/fixture.sav; see tools/make_fixture.py")

    pdoc["species"] = species
    pdoc["meta"]["species_count"] = len(species)
    mdoc["moves"] = movetab
    # Both fixtures are mode 444 so nothing regenerates them by accident. Put
    # that back afterwards rather than leaving them writable.
    for path, doc in ((personal, pdoc), (moves, mdoc)):
        mode = path.stat().st_mode & 0o777
        path.chmod(mode | 0o200)
        path.write_text(json.dumps(doc, indent=1, ensure_ascii=False), encoding="utf-8")
        path.chmod(mode)
    return len(species), len(movetab)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--tables", action="store_true",
                    help="trim the JSON table fixtures instead of the save")
    ap.add_argument("--from", dest="src", type=Path, default=ROOT / "tests" / "fixture.sav")
    ap.add_argument("--out", type=Path, default=ROOT / "tests" / "fixture.sav")
    ap.add_argument("--ot", default="Bobo", help='OT name to write (default "Bobo")')
    args = ap.parse_args()

    if args.tables:
        n, m = trim_tables(ROOT / "tests" / "personal.fixture.json",
                           ROOT / "tests" / "moves.fixture.json", args.src)
        print(f"make_fixture: table fixtures trimmed to {n} species and {m} moves")
        return 0

    data = bytearray(args.src.read_bytes())
    if len(data) != ps.SAVE_SIZE:
        print(f"make_fixture: {args.src} is {len(data)} bytes, expected {ps.SAVE_SIZE}",
              file=sys.stderr)
        return 2

    touched = 0
    for base in ps.SLOT_OFFSETS:
        for i in range(ps.PARTY_SLOTS):
            off = base + ps.PARTY_BLOCK + ps.PARTY_FIRST + i * ps.PK5_PARTY_SIZE
            if rewrite_record(data, off, ps.PK5_PARTY_SIZE):
                touched += 1
        for i in range(BATTLE_BOX_SLOTS):
            if rewrite_record(data, base + BATTLE_BOX + i * ps.PK5_BOX_SIZE, ps.PK5_BOX_SIZE):
                touched += 1
        for b in range(ps.BOX_COUNT):
            for sl in range(ps.BOX_SLOTS):
                off = base + ps.BOX_BASE + b * ps.BOX_STRIDE + sl * ps.PK5_BOX_SIZE
                if rewrite_record(data, off, ps.PK5_BOX_SIZE):
                    touched += 1

        # Trainer card: OT name at +0x04 (8 chars, UTF-16LE), ids at +0x14.
        tc = base + 0x19400
        name = args.ot[:7].encode("utf-16-le") + b"\xff\xff"
        data[tc + 0x04:tc + 0x14] = name.ljust(0x10, b"\x00")[:0x10]
        struct.pack_into("<HH", data, tc + 0x14, FAKE_TID, FAKE_SID)

    # Reseal: every block's inline checksum, the central table, the footer CRC.
    blocks = [(0x00000, 0x3E0, 0), (0x18400, 0x09C0, 25), (0x18E00, 0x534, 26),
              (0x19400, 0x0068, 27), (BATTLE_BOX, 0x35C, 49)]
    blocks += [(ps.BOX_BASE + n * ps.BOX_STRIDE, ps.BOX_DATA_LEN, 1 + n)
               for n in range(ps.BOX_COUNT)]
    for base in ps.SLOT_OFFSETS:
        table = base + ps.CHECKSUM_TABLE
        for start, length, entry in blocks:
            off = base + start
            crc = ps.crc16_ccitt(bytes(data[off:off + length]))
            struct.pack_into("<H", data, off + length + 2, crc)
            struct.pack_into("<H", data, table + 2 * entry, crc)
        footer = ps.crc16_ccitt(bytes(data[table:base + 0x23F8C]))
        struct.pack_into("<H", data, base + ps.FOOTER + 0x0E, footer)

    # Validate before writing: a fixture that does not parse is worse than none.
    warnings: list[str] = []
    slot, _reports, _why = ps.choose_slot(bytes(data), warnings)
    base = ps.SLOT_OFFSETS[slot]
    n = 0
    for b in range(ps.BOX_COUNT):
        for sl in range(ps.BOX_SLOTS):
            off = base + ps.BOX_BASE + b * ps.BOX_STRIDE + sl * ps.PK5_BOX_SIZE
            if ps.decode_pk5(bytes(data[off:off + ps.PK5_BOX_SIZE]), False):
                n += 1
    party = [ps.decode_pk5(bytes(data[base + ps.PARTY_BLOCK + ps.PARTY_FIRST
                                      + i * ps.PK5_PARTY_SIZE:][:ps.PK5_PARTY_SIZE]), True)
             for i in range(ps.PARTY_SLOTS)]
    party = [p for p in party if p]
    if not party:
        print("make_fixture: the result has no readable party -- refusing to write", file=sys.stderr)
        return 1

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(bytes(data))
    print(f"make_fixture: re-IDed {touched} records across both slots")
    print(f"make_fixture: OT {args.ot!r}, TID {FAKE_TID}, SID {FAKE_SID}")
    print(f"make_fixture: {len(party)} party, {n} box; slot {slot} validates")
    print(f"make_fixture: wrote {args.out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
