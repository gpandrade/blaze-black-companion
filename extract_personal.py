#!/usr/bin/env python3
"""
extract_personal.py -- pull the personal (species) table out of the NDS ROM.

READ-ONLY CONTRACT
------------------
ROMs are opened 'rb' and only ever seek/read. Nothing here writes, truncates,
renames or deletes a ROM. The only file written is state/personal.json.

WHY
---
The wiki was generated from a modern Pokemon dataset and is contaminated
wherever the games changed after Gen 5 -- the Gen 6 type chart in its Defenses
tables, Fairy typings, and move power and accuracy on 63 moves.
The ROM is the hack itself, so it is ground truth for base stats, both types,
all three abilities, and the experience curve.

FORMAT REFERENCES
-----------------
NARC path and personal-entry field offsets follow the Universal Pokemon
Randomizer ZX mapping for BW1, not guesswork:

    PokemonStats NARC        a/0/1/6          (gen5_offsets.ini, Type=BW1)
    bsHPOffset      = 0      bsAttackOffset  = 1     bsDefenseOffset = 2
    bsSpeedOffset   = 3      bsSpAtkOffset   = 4     bsSpDefOffset   = 5
    bsPrimaryTypeOffset = 6  bsSecondaryTypeOffset = 7
    bsCatchRateOffset   = 8  bsGrowthCurveOffset   = 21
    bsAbility1Offset= 24     bsAbility2Offset= 25    bsAbility3Offset= 26
    pokemonCount = 649       (Gen5Constants.java)

Note the stat order -- HP, Atk, Def, **Speed**, SpAtk, SpDef -- matches the
save's ordering, not the wiki's. Converted to named keys on the way out.

In Gen 5 each species is its own file inside the NARC, so there is no fixed
personal-entry stride to get wrong.

NDS CONTAINER FORMAT
--------------------
ROM header: FNT offset u32 @0x40, FNT size @0x44, FAT offset @0x48, size @0x4C.
FAT is an array of 8-byte {u32 start, u32 end} keyed by file id.
FNT main table is 8-byte {u32 subtable_offset, u16 first_file_id, u16 parent}
per directory; directory ids are 0xF000-based. Each subtable is a run of
entries: a length byte (0 = end, 1..0x7F = file, 0x81..0xFF = subdirectory),
the name, and for subdirectories a trailing u16 directory id.

NARC: "NARC" magic, then BTAF (file allocation), BTNF (names, usually empty)
and GMIF (the raw bytes) chunks.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path

import paths

import gen5
from parse_save import (CURVE_NAMES, OUTPUT_STAT_ORDER, SAVE_STAT_ORDER,
                        Wiki, WIKI_DOCS, move_name, named_stats)

ROOT = Path(__file__).resolve().parent
STATE_DIR = ROOT / "state"
DEFAULT_ROM = paths.ROM
VANILLA_ROM = paths.VANILLA_ROM

PERSONAL_NARC = "a/0/1/6"      # File<PokemonStats>
LEARNSET_NARC = "a/0/1/8"      # File<PokemonMovesets>
EVOLUTION_NARC = "a/0/1/9"     # File<PokemonEvolutions>
MOVE_NARC = "a/0/2/1"          # File<MoveData>
POKEMON_COUNT = 649
MOVE_COUNT = 559               # Gen5Constants.moveCount
TM_COUNT, HM_COUNT = 95, 6     # Gen5Constants.tmCount / hmCount

BS_HP, BS_ATK, BS_DEF, BS_SPE, BS_SPA, BS_SPD = 0, 1, 2, 3, 4, 5
BS_TYPE1, BS_TYPE2 = 6, 7
BS_CATCH_RATE = 8
BS_GROWTH_CURVE = 21
BS_ABILITY1, BS_ABILITY2, BS_ABILITY3 = 24, 25, 26
BS_TMHM_COMPAT = 40            # bsTMHMCompatOffset

# Wild held items.  Gen 5 stores three u16 item ids per species: the common
# hold (50%), the rare hold (5%), and the Dark Grass hold (1%).  Confirmed by
# spot-checking species whose vanilla holds are unmistakable -- Pikachu reads
# Light Ball, Chansey Lucky Punch, Ditto Quick Powder and Metal Powder,
# Shuckle Berry Juice -- and by every value across all 649 species landing
# inside the ROM's 627-entry item id space.
BS_ITEM_COMMON, BS_ITEM_RARE, BS_ITEM_DARKGRASS = 0x0C, 0x0E, 0x10
# Fields below are not named in Gen5Constants but sit in the documented Gen 5
# personal layout, and every one of them is confirmed against known vanilla
# values before use -- see verify_personal_layout().
BS_EV_YIELD = 0x0A             # u16 bitfield, 2 bits per stat, save order
BS_GENDER_RATIO = 0x12
BS_HATCH_CYCLES = 0x13
BS_BASE_FRIENDSHIP = 0x14
BS_EGG_GROUP1, BS_EGG_GROUP2 = 0x16, 0x17
BS_BASE_EXP = 0x22             # u16 -- the readme's "experience rate"
PERSONAL_MIN_SIZE = 60

# Move entry offsets, from Gen5RomHandler.loadMoves()
MV_TYPE, MV_CATEGORY, MV_POWER = 0, 2, 3
MV_ACCURACY, MV_PP, MV_PRIORITY = 4, 5, 6
MOVE_CATEGORIES = ("status", "physical", "special")

# Evolution entries: 7 per species, 6 bytes each {u16 method, u16 param, u16 target}
EVO_ENTRY_SIZE, EVO_MAX_ENTRIES = 6, 7
EVO_METHODS = (
    "none", "happiness", "happiness-day", "happiness-night", "level-up",
    "trade", "trade-with-item", "trade-for-shelmet-karrablast", "use-item",
    "level-up-atk-gt-def", "level-up-atk-eq-def", "level-up-atk-lt-def",
    "level-up-low-pid", "level-up-high-pid", "level-up-spawn-shedinja",
    "level-up-high-beauty", "use-item-male", "use-item-female",
    "level-up-item-day", "level-up-item-night", "level-up-know-move",
    "level-up-with-party-pokemon", "level-up-male", "level-up-female",
    "level-up-magnetic-field", "level-up-moss-rock", "level-up-ice-rock",
)

# Reference typings used only to prove the type-id order, checked against the
# UNMODIFIED vanilla ROM where these are certain. Never used for the hack.
TYPE_ORDER_PROBES = {
    16: ("normal", "flying"),    # Pidgey
    6: ("fire", "flying"),       # Charizard
    95: ("rock", "ground"),      # Onix
    130: ("water", "flying"),    # Gyarados
    94: ("ghost", "poison"),     # Gengar
    208: ("steel", "ground"),    # Steelix
    197: ("dark", "dark"),       # Umbreon (mono)
    143: ("normal", "normal"),   # Snorlax (mono)
    65: ("psychic", "psychic"),  # Alakazam (mono)
    149: ("dragon", "flying"),   # Dragonite
    131: ("water", "ice"),       # Lapras
    214: ("bug", "fighting"),    # Heracross
    68: ("fighting", "fighting"),# Machamp
    103: ("grass", "psychic"),   # Exeggutor
    26: ("electric", "electric"),# Raichu
}


class RomError(Exception):
    """Fatal: the ROM could not be trusted."""


class NDSRom:
    """Minimal read-only NDS filesystem reader."""

    def __init__(self, path: Path):
        if not path.is_file():
            raise RomError(f"ROM not found: {path}")
        self.path = path
        self.size = path.stat().st_size
        self._fh = open(path, "rb")          # read-only, never reopened for write
        header = self._read(0, 0x200)
        self.title = header[0x00:0x0C].decode("ascii", "replace").rstrip("\0")
        self.game_code = header[0x0C:0x10].decode("ascii", "replace")
        self.fnt_off, self.fnt_size, self.fat_off, self.fat_size = \
            struct.unpack_from("<IIII", header, 0x40)
        if not (0 < self.fat_off < self.size and 0 < self.fnt_off < self.size):
            raise RomError(f"{path.name}: implausible FNT/FAT offsets; not an NDS ROM?")

    def close(self) -> None:
        self._fh.close()

    def __enter__(self): return self

    def __exit__(self, *exc): self.close()

    def _read(self, offset: int, size: int) -> bytes:
        self._fh.seek(offset)
        data = self._fh.read(size)
        if len(data) != size:
            raise RomError(f"short read at {offset:#x}: {len(data)}/{size}")
        return data

    def fat(self, file_id: int) -> tuple[int, int]:
        if not 0 <= file_id < self.fat_size // 8:
            raise RomError(f"file id {file_id} out of range")
        start, end = struct.unpack("<II", self._read(self.fat_off + 8 * file_id, 8))
        return start, end

    def _subtable(self, dir_id: int) -> tuple[int, int]:
        idx = dir_id & 0x0FFF
        sub_off, first_file, _parent = struct.unpack(
            "<IHH", self._read(self.fnt_off + 8 * idx, 8))
        return self.fnt_off + sub_off, first_file

    def list_dir(self, dir_id: int = 0xF000) -> dict[str, int | tuple]:
        """Map name -> file id (int) or ('dir', dir_id)."""
        pos, file_id = self._subtable(dir_id)
        out: dict[str, int | tuple] = {}
        while True:
            (control,) = struct.unpack("<B", self._read(pos, 1))
            pos += 1
            if control == 0x00:
                break
            if control == 0x80:
                raise RomError("reserved FNT control byte 0x80")
            length = control & 0x7F
            name = self._read(pos, length).decode("ascii", "replace")
            pos += length
            if control & 0x80:
                (sub_id,) = struct.unpack("<H", self._read(pos, 2))
                pos += 2
                out[name] = ("dir", sub_id)
            else:
                out[name] = file_id
                file_id += 1
        return out

    def resolve(self, path: str) -> int:
        """Resolve a slash-separated ROM path such as 'a/0/1/6' to a file id."""
        node: int | tuple = ("dir", 0xF000)
        parts = [p for p in path.split("/") if p]
        for i, part in enumerate(parts):
            if not (isinstance(node, tuple) and node[0] == "dir"):
                raise RomError(f"{'/'.join(parts[:i])} is a file, not a directory")
            entries = self.list_dir(node[1])
            if part not in entries:
                raise RomError(
                    f"ROM path {path!r} not found: {part!r} missing in "
                    f"{'/'.join(parts[:i]) or '<root>'}")
            node = entries[part]
        if isinstance(node, tuple):
            raise RomError(f"ROM path {path!r} is a directory, not a file")
        return node

    def file_data(self, path: str) -> bytes:
        start, end = self.fat(self.resolve(path))
        return self._read(start, end - start)


def parse_narc(data: bytes) -> list[bytes]:
    """Split a NARC container into its member files."""
    if data[:4] != b"NARC":
        raise RomError(f"not a NARC (magic {data[:4]!r})")
    pos = struct.unpack_from("<H", data, 12)[0]   # header size
    files: list[tuple[int, int]] | None = None
    images_at = None
    while pos < len(data) - 8:
        magic = data[pos:pos + 4]
        (chunk_size,) = struct.unpack_from("<I", data, pos + 4)
        if chunk_size <= 0:
            break
        if magic == b"BTAF":
            (count,) = struct.unpack_from("<H", data, pos + 8)
            files = [struct.unpack_from("<II", data, pos + 12 + 8 * i)
                     for i in range(count)]
        elif magic == b"GMIF":
            images_at = pos + 8
        pos += chunk_size
    if files is None or images_at is None:
        raise RomError("NARC missing BTAF or GMIF chunk")
    return [data[images_at + s: images_at + e] for s, e in files]


def type_name(type_id: int) -> str:
    if not 0 <= type_id < len(gen5.TYPES):
        raise RomError(
            f"type id {type_id} is outside the Gen 5 range 0..{len(gen5.TYPES) - 1}. "
            "The type-id order assumption is wrong; do not trust this extraction.")
    return gen5.TYPES[type_id]


def tmhm_compat(raw: bytes) -> list[str]:
    """TM/HM slots this species can learn, as TM01..TM95 / HM01..HM06 labels."""
    out = []
    for i in range(TM_COUNT + HM_COUNT):
        byte = BS_TMHM_COMPAT + i // 8
        if byte < len(raw) and (raw[byte] >> (i % 8)) & 1:
            out.append(f"TM{i + 1:02d}" if i < TM_COUNT
                       else f"HM{i - TM_COUNT + 1:02d}")
    return out


def ev_yield(raw: bytes) -> dict:
    """2 bits per stat, in save order (hp, atk, def, spe, spa, spd)."""
    field = struct.unpack_from("<H", raw, BS_EV_YIELD)[0]
    return named_stats([(field >> (2 * i)) & 3 for i in range(6)], SAVE_STAT_ORDER)


def parse_entry(raw: bytes) -> dict:
    if len(raw) < PERSONAL_MIN_SIZE:
        raise RomError(f"personal entry too short: {len(raw)} bytes")
    stats = named_stats(
        [raw[BS_HP], raw[BS_ATK], raw[BS_DEF], raw[BS_SPE], raw[BS_SPA], raw[BS_SPD]],
        SAVE_STAT_ORDER)
    t1, t2 = type_name(raw[BS_TYPE1]), type_name(raw[BS_TYPE2])
    curve = raw[BS_GROWTH_CURVE]
    return {
        "base_stats": stats,
        "bst": sum(stats.values()),
        "types": [t1] if t1 == t2 else [t1, t2],
        "type_ids": [raw[BS_TYPE1], raw[BS_TYPE2]],
        "ability_ids": [raw[BS_ABILITY1], raw[BS_ABILITY2], raw[BS_ABILITY3]],
        "catch_rate": raw[BS_CATCH_RATE],
        "base_exp": struct.unpack_from("<H", raw, BS_BASE_EXP)[0],
        "ev_yield": ev_yield(raw),
        "gender_ratio": raw[BS_GENDER_RATIO],
        "hatch_cycles": raw[BS_HATCH_CYCLES],
        "base_friendship": raw[BS_BASE_FRIENDSHIP],
        "egg_groups": [raw[BS_EGG_GROUP1], raw[BS_EGG_GROUP2]],
        "growth_curve_id": curve,
        "growth_curve": CURVE_NAMES[curve] if curve < len(CURVE_NAMES) else None,
        "tmhm": tmhm_compat(raw),
        "wild_held_item_ids": {
            "common": struct.unpack_from("<H", raw, BS_ITEM_COMMON)[0],
            "rare": struct.unpack_from("<H", raw, BS_ITEM_RARE)[0],
            "dark_grass": struct.unpack_from("<H", raw, BS_ITEM_DARKGRASS)[0],
        },
        "entry_bytes": len(raw),
    }


def parse_learnset(raw: bytes) -> list[dict]:
    """4 bytes per entry: u16 move id, u16 level. 0xFFFF/0xFFFF terminates."""
    out = []
    for pos in range(0, len(raw) - 3, 4):
        move, level = struct.unpack_from("<HH", raw, pos)
        if move == 0xFFFF or level == 0xFFFF:
            break
        if move == 0:
            continue
        out.append({"level": level, "move_id": move})
    return out


def parse_evolutions(raw: bytes) -> list[dict]:
    """7 slots of {u16 method, u16 parameter, u16 target species}."""
    out = []
    for i in range(EVO_MAX_ENTRIES):
        pos = i * EVO_ENTRY_SIZE
        if pos + EVO_ENTRY_SIZE > len(raw):
            break
        method, param, target = struct.unpack_from("<HHH", raw, pos)
        if method == 0 or target == 0 or target > POKEMON_COUNT:
            continue
        out.append({
            "method_id": method,
            "method": EVO_METHODS[method] if method < len(EVO_METHODS) else None,
            "parameter": param,
            "into_id": target,
        })
    return out


def parse_move(raw: bytes) -> dict:
    if len(raw) <= MV_PRIORITY:
        raise RomError(f"move entry too short: {len(raw)} bytes")
    category = raw[MV_CATEGORY]
    priority = raw[MV_PRIORITY]
    return {
        "type": type_name(raw[MV_TYPE]),
        "category": (MOVE_CATEGORIES[category] if category < len(MOVE_CATEGORIES)
                     else f"unknown({category})"),
        "power": raw[MV_POWER],
        "accuracy": raw[MV_ACCURACY],
        "pp": raw[MV_PP],
        "priority": priority - 256 if priority > 127 else priority,
    }


# Known-correct VANILLA values, used to prove the personal-entry fields that
# Gen5Constants does not name. If any of these fail, the layout assumption is
# wrong and the extraction must not be trusted.
PERSONAL_LAYOUT_PROBES = {
    #  dex: (base_exp, catch_rate, gender_ratio, hatch_cycles, friendship)
    1:   (64, 45, 31, 20, 70),      # Bulbasaur
    16:  (50, 255, 127, 15, 70),    # Pidgey
    129: (40, 255, 127, 5, 70),     # Magikarp
    143: (189, 25, 31, 40, 70),     # Snorlax (87.5% male, so ratio 31)
    150: (306, 3, 255, 120, 0),     # Mewtwo
    501: (28, 45, 31, 20, 70),      # Oshawott
}


def verify_personal_layout(narc: list[bytes], label: str) -> list[str]:
    problems = []
    for dex, expected in PERSONAL_LAYOUT_PROBES.items():
        entry = entry_at(narc, dex)
        if entry is None:
            problems.append(f"{label}: #{dex} missing")
            continue
        got = (entry["base_exp"], entry["catch_rate"], entry["gender_ratio"],
               entry["hatch_cycles"], entry["base_friendship"])
        if got != expected:
            problems.append(f"{label}: #{dex} layout probe {got} != {expected}")
    return problems


def load_narc(rom_path: Path, narc_path: str) -> list[bytes]:
    with NDSRom(rom_path) as rom:
        return parse_narc(rom.file_data(narc_path))


def load_all(rom_path: Path) -> tuple[dict, dict]:
    """Every NARC this extractor reads, in one pass over the ROM."""
    with NDSRom(rom_path) as rom:
        info = {"path": str(rom_path), "bytes": rom.size,
                "title": rom.title, "game_code": rom.game_code}
        tables = {
            "personal": parse_narc(rom.file_data(PERSONAL_NARC)),
            "learnsets": parse_narc(rom.file_data(LEARNSET_NARC)),
            "evolutions": parse_narc(rom.file_data(EVOLUTION_NARC)),
            "moves": parse_narc(rom.file_data(MOVE_NARC)),
        }
    info["narc_files"] = {k: len(v) for k, v in tables.items()}
    info["entry_sizes"] = sorted({len(f) for f in tables["personal"]})
    return tables, info


def load_personal(rom_path: Path) -> tuple[list[bytes], dict]:
    """Return the raw NARC members. Entries are NOT parsed here.

    The NARC holds more than the 649 species: index 0 is a dummy, alternate
    formes follow the main run, and the container ends with an unrelated
    oversized record. Parsing every member eagerly would apply the personal
    layout to bytes that are not personal entries, so callers parse only the
    indices they actually mean to read.
    """
    with NDSRom(rom_path) as rom:
        info = {"path": str(rom_path), "bytes": rom.size,
                "title": rom.title, "game_code": rom.game_code}
        narc = parse_narc(rom.file_data(PERSONAL_NARC))
    info["narc_files"] = len(narc)
    info["entry_sizes"] = sorted({len(f) for f in narc})
    return narc, info


def entry_at(narc: list[bytes], dex: int) -> dict | None:
    if dex >= len(narc) or len(narc[dex]) < PERSONAL_MIN_SIZE:
        return None
    return parse_entry(narc[dex])


def verify_type_order(narc: list[bytes], label: str) -> list[str]:
    """Prove the type-id -> name mapping against known-unmodified typings."""
    problems = []
    for dex, expected in TYPE_ORDER_PROBES.items():
        try:
            entry = entry_at(narc, dex)
        except RomError as exc:
            problems.append(f"{label}: #{dex} unparseable: {exc}")
            continue
        if entry is None:
            problems.append(f"{label}: #{dex} missing")
            continue
        got = tuple(type_name(t) for t in entry["type_ids"])
        if got != expected:
            problems.append(f"{label}: #{dex} types {got} != expected {expected}")
    return problems


def build_species(tables: dict, wiki: Wiki, warnings: list[str]) -> dict:
    species = {}
    for dex in range(1, POKEMON_COUNT + 1):
        try:
            entry = entry_at(tables["personal"], dex)
        except RomError as exc:
            warnings.append(f"personal entry for #{dex} unparseable: {exc}")
            continue
        if entry is None:
            warnings.append(f"personal entry missing for #{dex}")
            continue
        e = dict(entry)
        e["name"] = wiki.species_name(dex) or f"#{dex}"
        abilities = [wiki.ability_name(a) if a else None for a in e["ability_ids"]]
        e["hidden_ability"] = abilities[2]
        e["abilities"] = [a for a in abilities[:2] if a]

        learn = tables["learnsets"]
        e["learnset"] = ([{**m, "move": move_name(m["move_id"])}
                          for m in parse_learnset(learn[dex])]
                         if dex < len(learn) else [])
        evos = tables["evolutions"]
        e["evolutions"] = parse_evolutions(evos[dex]) if dex < len(evos) else []
        for evo in e["evolutions"]:
            evo["into"] = wiki.species_name(evo["into_id"]) or f"#{evo['into_id']}"

        # Name the wild held items when the ROM item table has been built.
        # Left as bare ids otherwise -- never guessed from a local table.
        item_names = _rom_item_names()
        if item_names:
            e["wild_held_items"] = {
                slot: (item_names.get(iid) if iid else None)
                for slot, iid in e["wild_held_item_ids"].items()
            }

        species[str(dex)] = e
    return species


_ITEM_NAME_CACHE: dict[int, str] | None = None


def _rom_item_names() -> dict[int, str]:
    """Item id -> name from state/items.json, or {} when not yet extracted."""
    global _ITEM_NAME_CACHE
    if _ITEM_NAME_CACHE is None:
        try:
            blob = json.loads((STATE_DIR / "items.json").read_text())
            _ITEM_NAME_CACHE = {int(k): v["name"] for k, v in blob["items"].items()}
        except (OSError, ValueError, KeyError):
            _ITEM_NAME_CACHE = {}
    return _ITEM_NAME_CACHE


def build_moves(tables: dict, warnings: list[str]) -> dict:
    moves = {}
    for mid in range(1, MOVE_COUNT + 1):
        raw = tables["moves"][mid] if mid < len(tables["moves"]) else b""
        try:
            m = parse_move(raw)
        except RomError as exc:
            warnings.append(f"move #{mid} unparseable: {exc}")
            continue
        m["name"] = move_name(mid)
        moves[str(mid)] = m
    return moves


def diff_report(hack: dict, vanilla: dict, hack_moves: dict, van_moves: dict) -> dict:
    """What Blaze Black changed, relative to the unmodified ROM.

    THE PER-SPECIES BREAKDOWN IS THE POINT, not the counts.
    This used to emit totals plus three hand-picked detail lists, which is
    enough for a changelog and useless for the question people actually ask
    about a Drayano hack: *what did he do to THIS Pokemon?* `by_species` answers
    it -- vanilla and hack side by side, only for the fields that moved -- and
    the Pokedex tab renders it straight.

    Keyed by species id as a STRING, because that is how the JSON tables are
    keyed everywhere else and a numeric key would come back as a string anyway.
    """
    counts = {k: 0 for k in ("base_stats", "types", "abilities", "growth_curve",
                             "base_exp", "learnset", "evolutions", "tmhm")}
    details = {"base_exp": [], "evolutions_detrade": [], "types": []}
    by_species: dict[str, dict] = {}

    def note(key, field, value):
        by_species.setdefault(str(key), {})[field] = value

    for key, h in hack.items():
        v = vanilla.get(key)
        if v is None:
            continue
        if h["base_stats"] != v["base_stats"]:
            counts["base_stats"] += 1
            # Only the stats that MOVED. A six-key dict where five entries are
            # unchanged makes the reader do the diffing the file exists to do.
            note(key, "stats", {k: [v["base_stats"][k], h["base_stats"][k]]
                                for k in h["base_stats"]
                                if v["base_stats"][k] != h["base_stats"][k]})
            note(key, "bst", [v["bst"], h["bst"]])
        if h["types"] != v["types"]:
            counts["types"] += 1
            details["types"].append(
                f"{h['name']}: {'/'.join(v['types'])} -> {'/'.join(h['types'])}")
            note(key, "types", [v["types"], h["types"]])
        if h["ability_ids"][:2] != v["ability_ids"][:2]:
            counts["abilities"] += 1
            note(key, "abilities", [v["abilities"], h["abilities"]])
        # The hidden ability is the third slot and is tracked separately: it is
        # not part of the pair the count above compares, so a hack that only
        # changed hidden abilities would have reported zero.
        if h.get("hidden_ability") != v.get("hidden_ability"):
            note(key, "hidden", [v.get("hidden_ability"), h.get("hidden_ability")])
        if h["growth_curve"] != v["growth_curve"]:
            counts["growth_curve"] += 1
            note(key, "curve", [v["growth_curve"], h["growth_curve"]])
        if h["base_exp"] != v["base_exp"]:
            counts["base_exp"] += 1
            details["base_exp"].append(
                {"species": h["name"], "vanilla": v["base_exp"], "hack": h["base_exp"]})
            note(key, "base_exp", [v["base_exp"], h["base_exp"]])
        if h["learnset"] != v["learnset"]:
            counts["learnset"] += 1
            # Which moves were GAINED is the interesting half -- that is the
            # buff. Losses matter too but are rarer. Ids, not names: the caller
            # already has a move table and names would double the file.
            hm = {e["move_id"] for e in h["learnset"]}
            vm = {e["move_id"] for e in v["learnset"]}
            gained, lost = sorted(hm - vm), sorted(vm - hm)
            if gained or lost:
                note(key, "learn", [lost, gained])
        if h["evolutions"] != v["evolutions"]:
            counts["evolutions"] += 1
            evo = []
            for ve, he in zip(v["evolutions"], h["evolutions"]):
                if ve["method"] != he["method"] and ve["method"].startswith("trade"):
                    details["evolutions_detrade"].append(
                        f"{h['name']} -> {he['into']}: {ve['method']} -> "
                        f"{he['method']} {he['parameter']}")
                if (ve["method"], ve["parameter"], ve["into"]) != \
                        (he["method"], he["parameter"], he["into"]):
                    evo.append({"into": he["into"],
                                "was": f"{ve['method']} {ve['parameter']}".strip(),
                                "now": f"{he['method']} {he['parameter']}".strip()})
            if evo:
                note(key, "evo", evo)
        if h["tmhm"] != v["tmhm"]:
            counts["tmhm"] += 1
            ht, vt = set(h["tmhm"]), set(v["tmhm"])
            note(key, "tmhm", [sorted(vt - ht), sorted(ht - vt)])

    move_changes = []
    for mid, h in hack_moves.items():
        v = van_moves.get(mid)
        if v is None:
            continue
        changed = {k: (v[k], h[k]) for k in ("power", "accuracy", "pp", "type",
                                             "category", "priority")
                   if v[k] != h[k]}
        if changed:
            move_changes.append({"move": h["name"], "changes": changed})
    counts["moves"] = len(move_changes)
    return {"counts": counts, "details": details, "move_changes": move_changes,
            "by_species": by_species}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--rom", type=Path, default=DEFAULT_ROM)
    ap.add_argument("--vanilla", type=Path, default=VANILLA_ROM,
                    help="unmodified ROM: proves field layouts and powers the diff")
    ap.add_argument("--out", type=Path, default=STATE_DIR / "personal.json")
    ap.add_argument("--moves-out", type=Path, default=STATE_DIR / "moves.json")
    ap.add_argument("--diff-out", type=Path, default=STATE_DIR / "rom_diff.json")
    ap.add_argument("--wiki", type=Path, default=WIKI_DOCS)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    warnings: list[str] = []
    try:
        tables, rom_info = load_all(args.rom)
    except RomError as exc:
        print(f"extract_personal: {exc}", file=sys.stderr)
        return 1

    # --- prove every field layout against the unmodified ROM first -----------
    vanilla_tables = vanilla_info = None
    if args.vanilla.is_file():
        try:
            vanilla_tables, vanilla_info = load_all(args.vanilla)
        except RomError as exc:
            print(f"extract_personal: vanilla ROM unreadable: {exc}", file=sys.stderr)
            return 1
        problems = (verify_type_order(vanilla_tables["personal"], "vanilla")
                    + verify_personal_layout(vanilla_tables["personal"], "vanilla"))
        proof = "vanilla-rom"
    else:
        problems = (verify_type_order(tables["personal"], "hack")
                    + verify_personal_layout(tables["personal"], "hack"))
        proof = "hack-rom (no vanilla ROM available)"
        warnings.append("No vanilla ROM found; layout probes ran against the hack, "
                        "which is weaker, and no diff was produced.")
    if problems:
        for p_ in problems:
            print(f"extract_personal: {p_}", file=sys.stderr)
        print("extract_personal: field layout could not be proven; refusing to emit "
              "tables that may be systematically mislabelled.", file=sys.stderr)
        return 1

    wiki = Wiki(args.wiki)
    species = build_species(tables, wiki, warnings)
    moves = build_moves(tables, warnings)

    fairy = [k for k, v in species.items() if "fairy" in v["types"]]
    if fairy:
        print(f"extract_personal: {len(fairy)} species typed Fairy; impossible in "
              "Gen 5. Aborting.", file=sys.stderr)
        return 1

    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "rom": rom_info,
        "vanilla_rom": vanilla_info,
        "narcs": {"personal": PERSONAL_NARC, "learnsets": LEARNSET_NARC,
                  "evolutions": EVOLUTION_NARC, "moves": MOVE_NARC},
        "field_offsets_reference": "Universal Pokemon Randomizer ZX, BW1",
        "layout_proved_against": proof,
        "type_id_order": list(gen5.TYPES),
        "stat_key_order": list(OUTPUT_STAT_ORDER),
        "species_count": len(species),
        "move_count": len(moves),
        "warnings": warnings,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps({"meta": meta, "species": species}, indent=2, ensure_ascii=False)
        + "\n", encoding="utf-8")
    args.moves_out.write_text(
        json.dumps({"meta": meta, "moves": moves}, indent=2, ensure_ascii=False)
        + "\n", encoding="utf-8")

    report = None
    if vanilla_tables is not None:
        van_species = build_species(vanilla_tables, wiki, [])
        van_moves = build_moves(vanilla_tables, [])
        report = diff_report(species, van_species, moves, van_moves)
        args.diff_out.write_text(
            json.dumps({"meta": meta, "diff": report}, indent=2, ensure_ascii=False)
            + "\n", encoding="utf-8")

    if not args.quiet:
        print(f"extract_personal: {rom_info['title']} [{rom_info['game_code']}] -> "
              f"{len(species)} species, {len(moves)} moves", file=sys.stderr)
        print(f"extract_personal: layouts proved against {proof}", file=sys.stderr)
        print(f"extract_personal: wrote {args.out}, {args.moves_out}", file=sys.stderr)
        if report:
            c = report["counts"]
            print("extract_personal: changed vs vanilla -> " + ", ".join(
                f"{k} {v}" for k, v in c.items()), file=sys.stderr)
        for w in warnings:
            print(f"extract_personal: WARNING: {w}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
