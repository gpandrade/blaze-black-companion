#!/usr/bin/env python3
"""
Regression and synthetic tests for parse_save.py.

Run:  python3 tests/test_parse_save.py

SAFETY: this suite never opens the real save. It reads tests/fixture.sav (a
frozen copy) and writes only into a temporary directory. Synthetic saves are
built by mutating an in-memory copy of the fixture and are never written back
over any real file.

The fixture pins real-world behaviour. The synthetic cases cover what the
fixture cannot, because the live save has never contained them: empty slots
interleaved with occupied ones, eggs, nicknamed Pokemon, held items, and a
completely full box.
"""

from __future__ import annotations

import json
import shutil
import struct
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import parse_save as ps  # noqa: E402
import extract_personal as ep  # noqa: E402
import gen5  # noqa: E402

FIXTURE = ROOT / "tests" / "fixture.sav"
EXPECTED = ROOT / "tests" / "fixture.expected.json"
FIXTURE_PERSONAL = ROOT / "tests" / "personal.fixture.json"
FIXTURE_MOVES = ROOT / "tests" / "moves.fixture.json"

FAILURES: list[str] = []
SKIPS: list[str] = []
PASSES = 0

# Setup-derived data this suite can use but must not REQUIRE. A fresh clone has
# neither until ./setup has run, and ./test-all is the second command the README
# hands a new user -- so the assertions that need them announce themselves as
# skipped rather than crashing. A skip that says why beats both a traceback and
# a silent pass; see the same idiom in verify_run.mjs and verify_dex.mjs.
HAVE_WIKI = (ROOT / "wiki" / "docs").is_dir()
HAVE_ITEMS = (ROOT / "state" / "items.json").is_file()


def check(label: str, ok: bool, detail: str = "") -> None:
    global PASSES
    if ok:
        PASSES += 1
    else:
        FAILURES.append(f"{label}: {detail}" if detail else label)


def skip(label: str, why: str) -> None:
    SKIPS.append(f"{label} ({why})")


def check_eq(label: str, got, want) -> None:
    check(label, got == want, f"got {got!r}, want {want!r}")


# --------------------------------------------------------------------------
# Synthetic PK5 construction (the inverse of the parser's decode path)
# --------------------------------------------------------------------------
def build_pk5(pid: int, species: int, *, exp: int = 1000, item: int = 0,
              ability: int = 1, nature: int = 0, moves=(33, 0, 0, 0),
              ivs=(31, 30, 29, 28, 27, 26), evs=(1, 2, 3, 4, 5, 6),
              nickname: str = "TEST", ot: str = "Bobo",
              is_egg: bool = False, is_nicknamed: bool = False,
              level: int | None = None) -> bytes:
    """Build one PK5 record. `ivs`/`evs` are in SAVE order (hp atk def spe spa spd)."""
    body = bytearray(128)
    struct.pack_into("<H", body, ps.B_SPECIES, species)
    struct.pack_into("<H", body, ps.B_ITEM, item)
    struct.pack_into("<H", body, ps.B_TID, 50818)
    struct.pack_into("<H", body, ps.B_SID, 17625)
    struct.pack_into("<I", body, ps.B_EXP, exp)
    body[ps.B_FRIENDSHIP] = 70
    body[ps.B_ABILITY] = ability
    body[ps.B_NATURE] = nature
    body[ps.B_EVS:ps.B_EVS + 6] = bytes(evs)
    struct.pack_into("<4H", body, ps.B_MOVES, *moves)

    iv_field = 0
    for i, v in enumerate(ivs):
        iv_field |= (v & 0x1F) << (5 * i)
    if is_egg:
        iv_field |= 1 << 30
    if is_nicknamed:
        iv_field |= 1 << 31
    struct.pack_into("<I", body, ps.B_IVS, iv_field)

    for i, ch in enumerate(nickname[:ps.B_NICKNAME_LEN]):
        struct.pack_into("<H", body, ps.B_NICKNAME + 2 * i, ord(ch))
    if len(nickname) < ps.B_NICKNAME_LEN:
        struct.pack_into("<H", body, ps.B_NICKNAME + 2 * len(nickname), 0xFFFF)
    for i, ch in enumerate(ot[:ps.B_OT_NAME_LEN]):
        struct.pack_into("<H", body, ps.B_OT_NAME + 2 * i, ord(ch))
    if len(ot) < ps.B_OT_NAME_LEN:
        struct.pack_into("<H", body, ps.B_OT_NAME + 2 * len(ot), 0xFFFF)

    checksum = ps.pk5_checksum(bytes(body))
    stored = ps.lcrng_crypt(ps.shuffle(bytes(body), pid), checksum)

    record = bytearray(ps.PK5_BOX_SIZE)
    struct.pack_into("<IHH", record, 0, pid, 0, checksum)
    record[8:136] = stored

    if level is not None:
        extra = bytearray(ps.PARTY_EXTRA_LEN)
        extra[ps.PARTY_LEVEL_OFF] = level
        record = record + bytearray(ps.PK5_PARTY_SIZE - ps.PK5_BOX_SIZE)
        record[ps.PARTY_EXTRA_OFF:ps.PARTY_EXTRA_OFF + ps.PARTY_EXTRA_LEN] = \
            ps.lcrng_crypt(bytes(extra), pid)
    return bytes(record)


def reseal(data: bytearray, slot: int = 0) -> bytes:
    """Recompute the block checksums the parser validates, for both slots."""
    for base in ps.SLOT_OFFSETS:
        table = base + ps.CHECKSUM_TABLE
        names = ps.crc16_ccitt(
            bytes(data[base + ps.BOXNAME_BLOCK: base + ps.BOXNAME_BLOCK + ps.BOXNAME_LEN]))
        struct.pack_into("<H", data, table + 2 * ps.CHK_BOXNAMES, names)
        for n in range(ps.BOX_COUNT):
            off = base + ps.BOX_BASE + n * ps.BOX_STRIDE
            struct.pack_into("<H", data, table + 2 * (ps.CHK_BOX_FIRST + n),
                             ps.crc16_ccitt(bytes(data[off:off + ps.BOX_DATA_LEN])))
        struct.pack_into(
            "<H", data, table + 2 * ps.CHK_PARTY,
            ps.crc16_ccitt(bytes(data[base + ps.PARTY_BLOCK:
                                      base + ps.PARTY_BLOCK + ps.PARTY_LEN])))
    return bytes(data)


def blank_slot_data() -> bytearray:
    """Fixture bytes with party and every box emptied, in both slots."""
    data = bytearray(FIXTURE.read_bytes())
    for base in ps.SLOT_OFFSETS:
        struct.pack_into("<I", data, base + ps.PARTY_BLOCK + ps.PARTY_COUNT_OFF, 0)
        for i in range(ps.PARTY_SLOTS):
            off = base + ps.PARTY_BLOCK + ps.PARTY_FIRST + i * ps.PK5_PARTY_SIZE
            data[off:off + ps.PK5_PARTY_SIZE] = bytes(ps.PK5_PARTY_SIZE)
        for n in range(ps.BOX_COUNT):
            off = base + ps.BOX_BASE + n * ps.BOX_STRIDE
            data[off:off + ps.BOX_DATA_LEN] = bytes(ps.BOX_DATA_LEN)
    return data


def run_parser(data: bytes, tmp: Path, name: str, *, observations: dict | None = None,
               personal: "ps.PersonalData | None" = None):
    """Parse in-memory bytes through the real code path.

    `personal=None` exercises the wiki-fallback path. Pass a PersonalData to
    exercise the normal ROM-primary path.
    """
    warnings: list[str] = []
    wiki = ps.Wiki(ROOT / "wiki" / "docs")
    obs = observations if observations is not None else {"version": 1, "species": {}}
    resolver = ps.CurveResolver(obs, wiki, warnings, personal)
    result = ps.parse(data, wiki, resolver, warnings, personal)
    return result, warnings, obs


def fixture_personal() -> "ps.PersonalData":
    return ps.PersonalData(FIXTURE_PERSONAL)


# --------------------------------------------------------------------------
# Tests
# --------------------------------------------------------------------------
def test_validation(tmp: Path) -> None:
    bad = tmp / "wrongsize.sav"
    bad.write_bytes(b"\0" * 1024)
    try:
        ps.read_save(bad)
        check("rejects wrong size", False, "no SaveError raised")
    except ps.SaveError as exc:
        check("rejects wrong size", "524288" in str(exc), str(exc))

    fresh = tmp / "fresh.sav"
    fresh.write_bytes(FIXTURE.read_bytes())
    try:
        ps.read_save(fresh)
        check("rejects fresh mtime", False, "no SaveError raised")
    except ps.SaveError as exc:
        check("rejects fresh mtime", "modified" in str(exc), str(exc))

    # Same file, but old enough.
    import os
    old = tmp / "old.sav"
    old.write_bytes(FIXTURE.read_bytes())
    os.utime(old, (0, 0))
    data, meta = ps.read_save(old)
    check_eq("accepts valid save", (len(data), meta["bytes"]), (ps.SAVE_SIZE, ps.SAVE_SIZE))

    try:
        ps.read_save(tmp / "nope.sav")
        check("rejects missing file", False, "no SaveError raised")
    except ps.SaveError:
        check("rejects missing file", True)


def test_fixture_regression(tmp: Path) -> None:
    # The frozen snapshot in fixture.expected.json was generated on a tree that
    # HAS the wiki clone, so it carries resolved species names and abilities.
    # Comparing against it without one reports five slots "differing" in
    # exactly those two keys -- true, and about the tree rather than about the
    # parser. Rather than teach the comparison to ignore them (a second notion
    # of correct, which is how a real regression eventually hides), it skips
    # and names the missing input.
    if not HAVE_WIKI:
        return skip("fixture snapshot regression",
                    "no wiki/docs -- run ./setup")
    data = FIXTURE.read_bytes()
    result, warnings, _ = run_parser(data, tmp, "fixture", personal=fixture_personal())
    snapshot = {"party": result["party"], "boxes": result["boxes"],
                "box_total": result["box_total"],
                "party_count_declared": result["party_count_declared"],
                "slot_used": result["slot_used"]}

    if not EXPECTED.is_file():
        EXPECTED.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n",
                            encoding="utf-8")
        check("fixture snapshot created", True)
        return

    want = json.loads(EXPECTED.read_text(encoding="utf-8"))
    check_eq("fixture party size", len(snapshot["party"]), len(want["party"]))
    if snapshot != want:
        for i, (g, w) in enumerate(zip(snapshot["party"], want["party"])):
            diffs = [k for k in set(g) | set(w) if g.get(k) != w.get(k)]
            if diffs:
                FAILURES.append(f"fixture party slot {i+1} differs in {diffs}")
        check("fixture matches snapshot", snapshot == want, "see diffs above")
    else:
        check("fixture matches snapshot", True)


def test_empty_slots(tmp: Path) -> None:
    """Occupied slots interleaved with empty ones must all be found."""
    data = blank_slot_data()
    for base in ps.SLOT_OFFSETS:
        # Fill party slots 1, 3 and 6; leave 2, 4, 5 zeroed.
        for idx, species in ((0, 501), (2, 396), (5, 16)):
            off = base + ps.PARTY_BLOCK + ps.PARTY_FIRST + idx * ps.PK5_PARTY_SIZE
            rec = build_pk5(0x11110000 + idx, species, exp=1000, level=12)
            data[off:off + ps.PK5_PARTY_SIZE] = rec
        struct.pack_into("<I", data, base + ps.PARTY_BLOCK + ps.PARTY_COUNT_OFF, 3)
        # Box 1 slots 5 and 29 only.
        for slot, species in ((4, 161), (28, 401)):
            off = base + ps.BOX_BASE + slot * ps.PK5_BOX_SIZE
            data[off:off + ps.PK5_BOX_SIZE] = build_pk5(0x22220000 + slot, species)
    result, warnings, _ = run_parser(reseal(data), tmp, "empty")

    check_eq("empty: party count", len(result["party"]), 3)
    check_eq("empty: party slot numbers", [p["slot"] for p in result["party"]], [1, 3, 6])
    check_eq("empty: box1 count", result["boxes"][0]["count"], 2)
    check_eq("empty: box1 slot numbers",
             [p["slot"] for p in result["boxes"][0]["pokemon"]], [5, 29])
    check_eq("empty: other boxes empty", sum(b["count"] for b in result["boxes"][1:]), 0)
    check("empty: no count mismatch warning",
          not any("Party header claims" in w for w in warnings), str(warnings))


def test_full_box(tmp: Path) -> None:
    data = blank_slot_data()
    for base in ps.SLOT_OFFSETS:
        for slot in range(ps.BOX_SLOTS):
            off = base + ps.BOX_BASE + slot * ps.PK5_BOX_SIZE
            data[off:off + ps.PK5_BOX_SIZE] = build_pk5(
                0x33330000 + slot, 1 + slot, exp=8000)
    result, _, _ = run_parser(reseal(data), tmp, "full")
    box1 = result["boxes"][0]
    check_eq("full box: count", box1["count"], 30)
    check_eq("full box: slots", [p["slot"] for p in box1["pokemon"]],
             list(range(1, 31)))
    check_eq("full box: species ids", [p["species_id"] for p in box1["pokemon"]],
             list(range(1, 31)))
    # Naming needs the wiki; the ids above do not, and they are what proves
    # thirty records decoded in the right order.
    if HAVE_WIKI:
        check("full box: all species named",
              all(p["species"] and not p.get("_species_unresolved") for p in box1["pokemon"]),
              str([p["species"] for p in box1["pokemon"]][:5]))
    else:
        skip("full box: all species named", "no wiki/docs -- run ./setup")
    check("full box: levels derived",
          all(p["level_source"] == "derived" for p in box1["pokemon"]))
    check_eq("full box: total", result["box_total"], 30)


def test_eggs_nicknames_items(tmp: Path) -> None:
    data = blank_slot_data()
    for base in ps.SLOT_OFFSETS:
        recs = [
            build_pk5(0x44440001, 501, is_egg=True, nickname="Egg", exp=1000),
            build_pk5(0x44440002, 396, is_nicknamed=True, nickname="Birb", exp=1000),
            build_pk5(0x44440003, 161, item=234, nickname="Sentret", exp=1000),
            build_pk5(0x44440004, 16, item=1, nickname="Pidgey", exp=1000),
        ]
        for i, rec in enumerate(recs):
            off = base + ps.BOX_BASE + i * ps.PK5_BOX_SIZE
            data[off:off + ps.PK5_BOX_SIZE] = rec
    result, _, _ = run_parser(reseal(data), tmp, "flags")
    mons = result["boxes"][0]["pokemon"]
    check_eq("flags: count", len(mons), 4)

    egg = mons[0]
    check_eq("egg: is_egg", egg["is_egg"], True)
    check_eq("egg: not nicknamed", egg["is_nicknamed"], False)
    check_eq("egg: ivs intact", egg["ivs"]["hp"], 31)

    nick = mons[1]
    check_eq("nickname: flag", nick["is_nicknamed"], True)
    check_eq("nickname: text", nick["nickname"], "Birb")
    check_eq("nickname: not egg", nick["is_egg"], False)

    # Item 234 is Leftovers, not Metal Coat.  This assertion used to expect
    # Metal Coat, which was the embedded ITEM_NAMES table reading one slot
    # low: that table carries an extra placeholder in the unused 120..134
    # run, so every name from id 134 upward was shifted by one.  The ROM's
    # own item table (state/items.json) puts Metal Coat at 233 and Leftovers
    # at 234, which matches the stock Gen 5 item list.  The fixture byte is
    # unchanged; only the expected name was wrong.
    #
    # The NAME half needs state/items.json, which ./setup extracts from the
    # ROM. Without it item_name() correctly falls back to the shifted embedded
    # table and marks itself unverified -- which is the documented behaviour,
    # not a regression, so demanding "Leftovers" of a fresh clone would fail
    # the suite for doing exactly the right thing. The ID half needs nothing
    # and is checked either way.
    check_eq("item: leftovers id", mons[2]["held_item"]["id"], 234)
    if HAVE_ITEMS:
        check_eq("item: leftovers name", mons[2]["held_item"]["name"], "Leftovers")
        check_eq("item: wiki confirms", mons[2]["held_item"]["wiki_known_item"], True)
        check_eq("item: master ball", mons[3]["held_item"]["name"], "Master Ball")
    else:
        skip("item names come from the ROM table",
             "no state/items.json -- run ./setup")
    check_eq("no item is null", result["boxes"][0]["pokemon"][0]["held_item"], None)


def test_stat_ordering(tmp: Path) -> None:
    """Speed sits at index 3 in the save but must land on the 'spe' key."""
    data = blank_slot_data()
    # save order = hp, atk, def, spe, spa, spd
    ivs = (1, 2, 3, 4, 5, 6)
    evs = (10, 20, 30, 40, 50, 60)
    for base in ps.SLOT_OFFSETS:
        off = base + ps.BOX_BASE
        data[off:off + ps.PK5_BOX_SIZE] = build_pk5(
            0x55550001, 501, ivs=ivs, evs=evs, exp=1000)
    result, _, _ = run_parser(reseal(data), tmp, "stats")
    mon = result["boxes"][0]["pokemon"][0]
    check_eq("stat order: ivs", mon["ivs"],
             {"hp": 1, "atk": 2, "def": 3, "spa": 5, "spd": 6, "spe": 4})
    check_eq("stat order: evs", mon["evs"],
             {"hp": 10, "atk": 20, "def": 30, "spa": 50, "spd": 60, "spe": 40})
    check_eq("stat order: key sequence", list(mon["ivs"]),
             list(ps.OUTPUT_STAT_ORDER))


def test_corruption_rejected(tmp: Path) -> None:
    data = bytearray(FIXTURE.read_bytes())
    for base in ps.SLOT_OFFSETS:
        struct.pack_into("<H", data, base + ps.CHECKSUM_TABLE + 2 * ps.CHK_PARTY, 0xDEAD)
    try:
        run_parser(bytes(data), tmp, "corrupt")
        check("rejects bad party checksum in both slots", False, "no SaveError")
    except ps.SaveError as exc:
        check("rejects bad party checksum in both slots", "checksum" in str(exc).lower(),
              str(exc))

    # A single bad slot must fall through to the good one, with a warning.
    data = bytearray(FIXTURE.read_bytes())
    struct.pack_into("<H", data, ps.SLOT_OFFSETS[0] + ps.CHECKSUM_TABLE
                     + 2 * ps.CHK_PARTY, 0xDEAD)
    result, warnings, _ = run_parser(bytes(data), tmp, "onebad")
    check_eq("falls back to healthy slot", result["slot_used"], 1)
    check("warns about bad slot", any("failed block checksum" in w for w in warnings),
          str(warnings))


def test_slot_selection(tmp: Path) -> None:
    # Higher counter wins.
    data = bytearray(FIXTURE.read_bytes())
    struct.pack_into("<I", data, ps.SLOT_OFFSETS[1] + ps.FOOTER, 99)
    result, warnings, _ = run_parser(bytes(data), tmp, "counter")
    check_eq("higher counter wins", result["slot_used"], 1)
    check("higher counter reason", "higher save counter" in result["slot_selection"],
          result["slot_selection"])

    # Tie + identical contents: quiet.
    result, warnings, _ = run_parser(FIXTURE.read_bytes(), tmp, "tie-same")
    check("tie+identical is not ambiguous",
          "AMBIGUOUS" not in result["slot_selection"], result["slot_selection"])
    check("tie+identical does not warn",
          not any("cannot tell which is newer" in w for w in warnings), str(warnings))

    # Tie + differing contents: must warn loudly, never silently pick slot 0.
    data = bytearray(FIXTURE.read_bytes())
    base = ps.SLOT_OFFSETS[1]
    off = base + ps.BOX_BASE
    data[off:off + ps.PK5_BOX_SIZE] = build_pk5(0x66660001, 25, exp=5000)
    reseal(data)
    result, warnings, _ = run_parser(bytes(data), tmp, "tie-diff")
    check("tie+differing is flagged ambiguous",
          "AMBIGUOUS" in result["slot_selection"], result["slot_selection"])
    check("tie+differing warns", any("cannot tell which is newer" in w for w in warnings),
          str(warnings))


def test_curve_pinning(tmp: Path) -> None:
    """A party observation must correct a wrong vanilla curve and pin box levels."""
    data = blank_slot_data()
    # Kricketot (#401): vanilla says medium-fast. Give it EXP 314 at level 8,
    # which medium-fast cannot produce (it would be level 6).
    for base in ps.SLOT_OFFSETS:
        off = base + ps.PARTY_BLOCK + ps.PARTY_FIRST
        data[off:off + ps.PK5_PARTY_SIZE] = build_pk5(
            0x77770001, 401, exp=314, level=8, nickname="Kricketot")
        struct.pack_into("<I", data, base + ps.PARTY_BLOCK + ps.PARTY_COUNT_OFF, 1)
        box = base + ps.BOX_BASE
        data[box:box + ps.PK5_BOX_SIZE] = build_pk5(0x77770002, 401, exp=314)
    obs = {"version": 1, "species": {}}
    result, warnings, obs = run_parser(reseal(data), tmp, "curve", observations=obs)

    check_eq("curve: vanilla ruled out", ps.CURVE_NAMES[ps.VANILLA_CURVE[401]],
             "medium-fast")
    check("curve: correction warned",
          any("EXP CURVE CORRECTION" in w for w in warnings), str(warnings))
    rec = obs["species"]["401"]
    check_eq("curve: recorded as not vanilla", rec["matches_vanilla"], False)
    check("curve: medium-fast excluded", ps.MEDIUM_FAST not in rec["candidates"],
          str(rec["candidates"]))
    check_eq("curve: sample stored", rec["samples"], [[314, 8]])

    boxmon = result["boxes"][0]["pokemon"][0]
    check_eq("curve: box level derived from correction", boxmon["level"], 8)
    check_eq("curve: box confidence", boxmon["level_confidence"], "pinned")
    check_eq("curve: party level is stored", result["party"][0]["level_source"], "stored")
    check_eq("curve: party confidence", result["party"][0]["level_confidence"], "exact")

    # An unobserved species falls back to the vanilla table, labelled honestly.
    data2 = blank_slot_data()
    for base in ps.SLOT_OFFSETS:
        box = base + ps.BOX_BASE
        data2[box:box + ps.PK5_BOX_SIZE] = build_pk5(0x88880001, 129, exp=5000)
    result2, _, _ = run_parser(reseal(data2), tmp, "assumed")
    mon = result2["boxes"][0]["pokemon"][0]
    check_eq("unobserved species confidence", mon["level_confidence"], "assumed")
    check_eq("unobserved species curve source", mon["exp_curve_source"], "vanilla-table")


def test_real_stats_rom_primary(tmp: Path) -> None:
    """The only test whose ground truth is external to this codebase.

    The synthetic tests invert this module's own encoder, so a decode bug would
    be mirrored in the encoder and pass silently. Here both inputs are external:
    the six stats each party record stores are what the ROM computed, and the
    base stats come from the ROM's own personal table. Recomputing one from the
    other and demanding equality checks the save decoder AND the ROM extractor
    against each other. Six equalities per party member.
    """
    personal = fixture_personal()
    check("personal fixture loaded", personal.loaded)
    result, warnings, _ = run_parser(FIXTURE.read_bytes(), tmp, "stats-rom",
                                     personal=personal)
    party = result["party"]
    check_eq("rom stats: party size", len(party), 5)

    verified = 0
    for mon in party:
        check_eq(f"rom stats_check {mon['species']}", mon["stats_check"], "ok")
        check_eq(f"rom base_stats_source {mon['species']}",
                 mon["base_stats_source"], "rom")
        base = personal.base_stats(mon["species_id"])
        got = ps.compute_stats(base, mon["ivs"], mon["evs"], mon["level"],
                               mon["nature_id"], mon["species_id"])
        for key in ps.OUTPUT_STAT_ORDER:
            check_eq(f"{mon['species']} {key}", got[key], mon["stats"][key])
            verified += 1
    check_eq("independent stat equalities checked", verified, 30)
    check("rom stats: no warnings", not warnings, str(warnings))

    # Typing now comes from the ROM, and cannot be Fairy.
    for mon in party:
        check(f"{mon['species']} has types", bool(mon["types"]), str(mon["types"]))
        check(f"{mon['species']} not Fairy", "fairy" not in mon["types"])
        check_eq(f"{mon['species']} data_source", mon["data_source"], "rom")
        # Ability NAMES resolve through the wiki; the id does not. Without a
        # wiki clone every ability reads None, which is the tree talking and
        # not the decoder.
        if HAVE_WIKI:
            check(f"{mon['species']} ability is one of its species abilities",
                  mon["ability"] in mon["species_abilities"],
                  f"{mon['ability']} not in {mon['species_abilities']}")
    if not HAVE_WIKI:
        skip("party abilities resolve to a species ability",
             "no wiki/docs -- run ./setup")

    # Pidgey specifically: the ROM says unbuffed, contradicting the wiki.
    #
    # BY SPECIES ID, NOT BY NAME. Names are resolved through the wiki clone, so
    # on a tree where ./setup has not run every party member reads as "#16" and
    # a name lookup here died with a bare StopIteration -- the whole suite gone,
    # on the one machine nobody tests on. The id is what this assertion is
    # about; the name was only ever how it found the row.
    pidgey = next(m for m in party if m["species_id"] == 16)
    check_eq("rom pidgey base stats", personal.base_stats(16),
             {"hp": 40, "atk": 45, "def": 40, "spa": 35, "spd": 35, "spe": 56})
    check_eq("rom pidgey types", pidgey["types"], ["normal", "flying"])

    # Curves come from the ROM, so box levels are exact rather than inferred.
    check_eq("kricketot rom curve", ps.CURVE_NAMES[personal.curve(401)], "medium-slow")
    check_eq("oshawott rom curve", ps.CURVE_NAMES[personal.curve(501)], "medium-slow")


def test_wiki_fallback_exposes_the_defect(tmp: Path) -> None:
    """Without the ROM table the parser degrades to the wiki -- and says so.

    Frozen deliberately: this is the failure the ROM extraction exists to fix.
    If the wiki is ever corrected upstream, this test trips and should be
    retired rather than patched around.

    Needs the wiki clone by definition -- it reads wiki rows directly and keys
    its expectations by species NAME, which is itself resolved through the
    wiki. On a tree where ./setup has not run there is nothing here to test,
    so it says so instead of dying on a KeyError for '#501'.
    """
    if not HAVE_WIKI:
        return skip("wiki-fallback degradation",
                    "no wiki/docs -- run ./setup")
    result, warnings, _ = run_parser(FIXTURE.read_bytes(), tmp, "stats-wiki",
                                     personal=None)
    party = result["party"]
    expect = {"Oshawott": "ok", "Starly": "ok", "Sentret": "ok",
              "Kricketot": "ok", "Pidgey": "MISMATCH"}
    for mon in party:
        check_eq(f"wiki-fallback stats_check {mon['species']}",
                 mon["stats_check"], expect[mon["species"]])
        check_eq(f"wiki-fallback source {mon['species']}",
                 mon["base_stats_source"], "wiki")
        check_eq(f"wiki-fallback types {mon['species']}", mon["types"], None)
    check("wiki-fallback warns about pidgey",
          any("STAT MISMATCH" in w for w in warnings), str(warnings))

    # The wiki row the ROM contradicts, and its telltale duplicate.
    wiki = ps.Wiki(ROOT / "wiki" / "docs")
    check_eq("wiki pidgey row", wiki.base_stats(16),
             {"hp": 60, "atk": 45, "def": 50, "spa": 95, "spd": 80, "spe": 90})
    check_eq("wiki pidgeotto row is identical", wiki.base_stats(17),
             wiki.base_stats(16))


def test_gen5_type_chart() -> None:
    """The chart exists because the wiki uses the Gen 6 one."""
    check_eq("17 types, no Fairy", len(gen5.TYPES), 17)
    check("fairy absent", "fairy" not in gen5.TYPES)
    # The two Gen 5 -> Gen 6 changes, which is the whole reason for this module.
    check_eq("Gen5: steel resists ghost", gen5.effectiveness("ghost", ("steel",)), 0.5)
    check_eq("Gen5: steel resists dark", gen5.effectiveness("dark", ("steel",)), 0.5)
    # Skarmory, the example the wiki gets wrong.
    check_eq("skarmory vs ghost", gen5.effectiveness("ghost", ("steel", "flying")), 0.5)
    check_eq("skarmory vs dark", gen5.effectiveness("dark", ("steel", "flying")), 0.5)
    check_eq("skarmory vs electric",
             gen5.effectiveness("electric", ("steel", "flying")), 2.0)
    check_eq("skarmory vs ground", gen5.effectiveness("ground", ("steel", "flying")), 0.0)
    check_eq("skarmory vs grass", gen5.effectiveness("grass", ("steel", "flying")), 0.25)
    # Mono-types stored as (t, t) must not square the multiplier.
    check_eq("mono not squared", gen5.effectiveness("water", ("fire", "fire")), 2.0)
    check_eq("dual x4", gen5.effectiveness("rock", ("fire", "flying")), 4.0)
    check_eq("immunity wins", gen5.effectiveness("normal", ("ghost", "flying")), 0.0)
    for t in gen5.TYPES:
        check(f"chart row {t}", t in gen5.TYPE_CHART)


def test_rom_extraction() -> None:
    """Validate the extractor against the real ROMs, if they are reachable."""
    if not ep.DEFAULT_ROM.is_file():
        check("rom present (skipped)", True)
        return
    tables, info = ep.load_all(ep.DEFAULT_ROM)
    check_eq("rom game code", info["game_code"], "IRBO")
    check("rom has enough personal entries", len(tables["personal"]) >= 650,
          str(len(tables["personal"])))
    check("rom has move entries", len(tables["moves"]) > ep.MOVE_COUNT,
          str(len(tables["moves"])))

    # THE WHOLE-TABLE SWEEP LIVES HERE, not on the fixture: the fixture is a
    # ten-species subset now and cannot answer "is every move in the game
    # well formed".  Reading the ROM can, and this test skips without one.
    parsed = [ep.parse_move(m) for m in tables["moves"][1:ep.MOVE_COUNT + 1]]
    check_eq("rom move count", len(parsed), ep.MOVE_COUNT)
    check("every rom move has a Gen 5 type",
          all(m["type"] in gen5.TYPES for m in parsed))
    check("every rom move category is known",
          all(m["category"] in ep.MOVE_CATEGORIES for m in parsed))
    check("rom move priority in sane range",
          all(-7 <= m["priority"] <= 7 for m in parsed))

    # Field layouts, proved against the unmodified ROM where values are certain.
    if ep.VANILLA_ROM.is_file():
        vanilla, _ = ep.load_all(ep.VANILLA_ROM)
        check("type-id order proved against vanilla",
              not ep.verify_type_order(vanilla["personal"], "vanilla"))
        check("personal layout proved against vanilla",
              not ep.verify_personal_layout(vanilla["personal"], "vanilla"))
        # Base EXP yield: the field Gen5Constants does not name.
        check_eq("vanilla bulbasaur base exp",
                 ep.entry_at(vanilla["personal"], 1)["base_exp"], 64)
        check_eq("vanilla mewtwo base exp",
                 ep.entry_at(vanilla["personal"], 150)["base_exp"], 306)
        # Move buffs Drayano documented.
        van_moves = {mid: ep.parse_move(vanilla["moves"][mid])
                     for mid in (71, 72, 42)}
        check_eq("vanilla absorb power", van_moves[71]["power"], 20)
        check_eq("vanilla mega drain power", van_moves[72]["power"], 40)
        check_eq("vanilla pin missile power", van_moves[42]["power"], 14)

    # No species may be Fairy: the type does not exist in Gen 5.
    fairy = [dex for dex in range(1, ep.POKEMON_COUNT + 1)
             if (e := ep.entry_at(tables["personal"], dex)) and "fairy" in e["types"]]
    check_eq("no Fairy types in the ROM", fairy, [])

    check_eq("rom pidgey unbuffed", ep.entry_at(tables["personal"], 16)["base_stats"],
             {"hp": 40, "atk": 45, "def": 40, "spa": 35, "spd": 35, "spe": 56})
    check_eq("rom kricketot curve",
             ep.entry_at(tables["personal"], 401)["growth_curve"], "medium-slow")

    # Hack move buffs.
    check_eq("hack absorb power", ep.parse_move(tables["moves"][71])["power"], 30)
    check_eq("hack mega drain power", ep.parse_move(tables["moves"][72])["power"], 50)
    check_eq("hack pin missile power", ep.parse_move(tables["moves"][42])["power"], 25)
    check_eq("hack absorb type", ep.parse_move(tables["moves"][71])["type"], "grass")
    check_eq("hack absorb category",
             ep.parse_move(tables["moves"][71])["category"], "special")

    # Trade evolutions removed -- the hack-specific fact worth having.
    for dex, into in ((67, 68), (93, 94), (64, 65), (75, 76)):
        evos = ep.parse_evolutions(tables["evolutions"][dex])
        check_eq(f"#{dex} evolves into #{into}", [e["into_id"] for e in evos], [into])
        check(f"#{dex} no longer trade-evolves",
              not any(e["method"].startswith("trade") for e in evos),
              str([e["method"] for e in evos]))

    # Learnsets: Oshawott's early moves at the levels the save showed.
    ls = {e["move_id"]: e["level"]
          for e in ep.parse_learnset(tables["learnsets"][501])}
    check_eq("oshawott tackle at 1", ls.get(33), 1)
    check_eq("oshawott tail whip at 5", ls.get(39), 5)
    check_eq("oshawott water gun at 7", ls.get(55), 7)

    # TM/HM compatibility is a list of slot labels, bounded by the real counts.
    tm = ep.entry_at(tables["personal"], 501)["tmhm"]
    check("oshawott has TMs", len(tm) > 0)
    check("tmhm labels well formed",
          all(t.startswith(("TM", "HM")) and t[2:].isdigit() for t in tm), str(tm[:5]))
    check("tmhm within Gen 5 counts",
          all(int(t[2:]) <= (ep.TM_COUNT if t.startswith("TM") else ep.HM_COUNT)
              for t in tm))


def test_party_moves_in_learnsets(tmp: Path) -> None:
    """Every party move must be learnable at or below that Pokemon's level.

    A move could legitimately come from a TM, an egg move or a pre-evolution,
    so a miss is not automatically a bug -- but for this early-game party all
    18 moves are level-up moves, which cross-checks the save decoder, the
    learnset extractor and the embedded move-name table simultaneously.
    """
    personal = fixture_personal()
    result, _, _ = run_parser(FIXTURE.read_bytes(), tmp, "learnsets",
                              personal=personal)
    doc = json.loads(FIXTURE_PERSONAL.read_text(encoding="utf-8"))["species"]
    total = 0
    for mon in result["party"]:
        learnset = {e["move_id"]: e["level"]
                    for e in doc[str(mon["species_id"])]["learnset"]}
        for mv in mon["moves"]:
            level = learnset.get(mv["id"])
            check(f"{mon['species']} knows {mv['name']} by Lv{mon['level']}",
                  level is not None and level <= mon["level"],
                  f"learnset level {level}")
            # The ROM learnset and the embedded name table must agree on the id.
            if level is not None:
                names = [e["move"] for e in doc[str(mon["species_id"])]["learnset"]
                         if e["move_id"] == mv["id"]]
                check_eq(f"{mon['species']} {mv['name']} name agrees",
                         names[0], mv["name"])
            total += 1
    check_eq("party moves checked", total, 18)


def test_move_table() -> None:
    """The committed move fixture is a SUBSET, and that is deliberate.

    It used to be all 559, next to a personal fixture carrying all 649 species
    with their learnsets -- i.e. the hack's own data tables, committed, in a
    repo whose .gitignore says of exactly that data: "shipping them is the part
    that attracts takedowns, not the code that reads them".  Both are cut to
    the species in tests/fixture.sav now; see tools/make_fixture.py.

    The sweep over the whole table moved to test_rom_extraction, which reads
    the real ROM and skips without one.  What has to hold here instead is that
    the subset COVERS the fixture -- a trim that cut too deep would otherwise
    surface as a baffling failure somewhere downstream.
    """
    moves = json.loads(FIXTURE_MOVES.read_text(encoding="utf-8"))["moves"]
    species = json.loads(FIXTURE_PERSONAL.read_text(encoding="utf-8"))["species"]
    needed = {str(e["move_id"]) for s in species.values() for e in s["learnset"]}
    missing = sorted(needed - set(moves), key=int)
    check("fixture covers every learnset move of every fixture species",
          not missing, f"{len(missing)} missing, e.g. {missing[:6]}")
    for mid, name, typ, cat in ((33, "Tackle", "normal", "physical"),
                                (55, "Water Gun", "water", "special"),
                                (71, "Absorb", "grass", "special"),
                                (45, "Growl", "normal", "status")):
        m = moves[str(mid)]
        check_eq(f"move {mid} name", m["name"], name)
        check_eq(f"move {mid} type", m["type"], typ)
        check_eq(f"move {mid} category", m["category"], cat)
    check_eq("status moves have 0 power", moves["45"]["power"], 0)
    check("all moves have a Gen 5 type",
          all(m["type"] in gen5.TYPES for m in moves.values()))
    check("all categories known",
          all(m["category"] in ep.MOVE_CATEGORIES for m in moves.values()))
    check("priority in sane range",
          all(-7 <= m["priority"] <= 7 for m in moves.values()))


def test_threshold_pinning(tmp: Path) -> None:
    """EXP exactly on a curve threshold identifies the curve outright."""
    check_eq("medium-slow L8 threshold", ps.exp_for_level(ps.MEDIUM_SLOW, 8), 314)
    check_eq("fluctuating L8 threshold", ps.exp_for_level(ps.FLUCTUATING, 8), 276)

    data = blank_slot_data()
    for base in ps.SLOT_OFFSETS:
        off = base + ps.PARTY_BLOCK + ps.PARTY_FIRST
        data[off:off + ps.PK5_PARTY_SIZE] = build_pk5(
            0x99990001, 401, exp=314, level=8, nickname="Kricketot")
        struct.pack_into("<I", data, base + ps.PARTY_BLOCK + ps.PARTY_COUNT_OFF, 1)
        box = base + ps.BOX_BASE
        data[box:box + ps.PK5_BOX_SIZE] = build_pk5(0x99990002, 401, exp=400)
    obs = {"version": 1, "species": {}}
    result, warnings, obs = run_parser(reseal(data), tmp, "threshold", observations=obs)

    rec = obs["species"]["401"]
    check_eq("threshold: pinned", rec["pinned"], True)
    check_eq("threshold: pinned_by", rec["pinned_by"], "threshold")
    check_eq("threshold: resolved", rec["resolved_curve"], "medium-slow")
    check("threshold: range alone was ambiguous", len(rec["candidate_curves"]) > 1,
          str(rec["candidate_curves"]))
    check("threshold: warning names the curve",
          any("exactly medium-slow's level-8 threshold" in w for w in warnings),
          str(warnings))

    # A box mon of that species now gets a single certain level, not a range.
    boxmon = result["boxes"][0]["pokemon"][0]
    check_eq("threshold: box confidence", boxmon["level_confidence"], "pinned")
    check_eq("threshold: box curve source", boxmon["exp_curve_source"],
             "observed-threshold")
    check("threshold: no level range", "level_range" not in boxmon)
    check_eq("threshold: box level", boxmon["level"],
             ps.level_for_exp(ps.MEDIUM_SLOW, 400))

    # Mid-band EXP must NOT pin: 350 is inside medium-slow's level-8 band.
    data2 = blank_slot_data()
    for base in ps.SLOT_OFFSETS:
        off = base + ps.PARTY_BLOCK + ps.PARTY_FIRST
        data2[off:off + ps.PK5_PARTY_SIZE] = build_pk5(
            0xAAAA0001, 401, exp=350, level=8)
        struct.pack_into("<I", data2, base + ps.PARTY_BLOCK + ps.PARTY_COUNT_OFF, 1)
    obs2 = {"version": 1, "species": {}}
    _, _, obs2 = run_parser(reseal(data2), tmp, "midband", observations=obs2)
    check_eq("mid-band does not pin", obs2["species"]["401"]["pinned"], False)


def test_curve_math() -> None:
    """Anchor the six curves against known thresholds."""
    check_eq("medium-fast L100", ps.exp_for_level(ps.MEDIUM_FAST, 100), 1000000)
    check_eq("fast L100", ps.exp_for_level(ps.FAST, 100), 800000)
    check_eq("slow L100", ps.exp_for_level(ps.SLOW, 100), 1250000)
    check_eq("medium-slow L100", ps.exp_for_level(ps.MEDIUM_SLOW, 100), 1059860)
    check_eq("erratic L100", ps.exp_for_level(ps.ERRATIC, 100), 600000)
    check_eq("fluctuating L100", ps.exp_for_level(ps.FLUCTUATING, 100), 1640000)
    for c in range(6):
        check_eq(f"curve {ps.CURVE_NAMES[c]} L1 is 0", ps.exp_for_level(c, 1), 0)
        monotonic = all(ps.exp_for_level(c, n) < ps.exp_for_level(c, n + 1)
                        for n in range(1, 100))
        check(f"curve {ps.CURVE_NAMES[c]} is monotonic", monotonic)
    # The live Oshawott: EXP 659 at level 10 on medium-slow.
    check_eq("oshawott level from exp", ps.level_for_exp(ps.MEDIUM_SLOW, 659), 10)


def test_crypto_roundtrip() -> None:
    for pid in (0x5B9D3756, 0x00000001, 0xFFFFFFFF, 0x0003E000):
        body = bytes((i * 7 + 3) & 0xFF for i in range(128))
        check(f"shuffle roundtrip {pid:#x}",
              ps.unshuffle(ps.shuffle(body, pid), pid) == body)
        seed = 0x1234
        check(f"lcrng involution {pid:#x}",
              ps.lcrng_crypt(ps.lcrng_crypt(body, seed), seed) == body)


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        test_crypto_roundtrip()
        test_curve_math()
        test_validation(tmp)
        test_fixture_regression(tmp)
        test_real_stats_rom_primary(tmp)
        test_wiki_fallback_exposes_the_defect(tmp)
        test_gen5_type_chart()
        test_rom_extraction()
        test_party_moves_in_learnsets(tmp)
        test_move_table()
        test_threshold_pinning(tmp)
        test_empty_slots(tmp)
        test_full_box(tmp)
        test_eggs_nicknames_items(tmp)
        test_stat_ordering(tmp)
        test_corruption_rejected(tmp)
        test_slot_selection(tmp)
        test_curve_pinning(tmp)

    tail = f", {len(SKIPS)} skipped" if SKIPS else ""
    print(f"{PASSES} passed, {len(FAILURES)} failed{tail}")
    for sk in SKIPS:
        print(f"  SKIP {sk}")
    for f in FAILURES:
        print(f"  FAIL {f}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
