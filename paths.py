#!/usr/bin/env python3
"""
paths.py -- where the ROM and the save live. One answer, not five.

Five modules each hardcoded an absolute path into the author's own home
directory as their module-level default: parse_save, write_team, build_sheet,
extract_personal and extract_items. In a repo meant to go public that is both
a small privacy leak and a bad first impression -- it makes a tool that runs
anywhere look like it only runs on one machine.

Resolution order, first hit wins:

    1. the environment -- BLAZE_SAVE, BLAZE_ROM, BLAZE_VANILLA_ROM
    2. companion.config.json (keys `save`, `rom`, `vanilla_rom`), which is
       gitignored precisely because a save path is personal
    3. ./game/<conventional name>, beside the repo

NOTHING HERE TOUCHES THE FILESYSTEM beyond reading that one config: an absent
ROM resolves to the conventional path and the caller reports it missing, which
is what every one of them already does. Import the constants, do not re-derive
them -- a sixth copy of a path is how the first five happened.
"""
from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "companion.config.json"
GAME = ROOT / "game"


@lru_cache(maxsize=1)
def config() -> dict:
    """The local config, or an empty dict. A broken config is not fatal here."""
    try:
        raw = json.loads(CONFIG.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except Exception:                                          # noqa: BLE001
        return {}


def resolve(key: str, env: str, conventional: str) -> Path:
    """Env, then config, then ./game/<name>. Always returns a Path."""
    for value in (os.environ.get(env), config().get(key)):
        if value:
            return Path(str(value)).expanduser()
    return GAME / conventional


SAVE = resolve("save", "BLAZE_SAVE", "pokemon_blaze_black.sav")
ROM = resolve("rom", "BLAZE_ROM", "pokemon_blaze_black.nds")
VANILLA_ROM = resolve("vanilla_rom", "BLAZE_VANILLA_ROM", "pokemon_black.nds")

if __name__ == "__main__":
    for name, p in (("save", SAVE), ("rom", ROM), ("vanilla rom", VANILLA_ROM)):
        print(f"{name:12} {p}  {'[found]' if p.is_file() else '[missing]'}")
