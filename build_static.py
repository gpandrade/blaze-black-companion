#!/usr/bin/env python3
"""
build_static.py -- emit the save-free half of the companion's data.

The battle companion used to be GENERATED: build_sheet.py read the author's
own save, base64-embedded 649 sprites, and baked the whole thing into a 1.1 MB
HTML file.  That shape cannot serve anyone else -- they have no such save, and
regenerating needs Python plus this repo's exact layout.

So the data blob is split in two:

    STATIC  (this file)  ROM tables, the type chart, move and ability text,
                         opponent rosters, wild encounters, sprite PATHS, and
                         the hand-authored TEAM_LAYOUT / NOTES / STATUS prose.
                         Regenerable from a ROM; identical for every player.

    LIVE    (app/js/roster.js)  everything that comes from a save: which
                         Pokemon exist, their levels and stats, where they
                         live, the bag, the player's position.  Computed in
                         the browser from the .sav the user loads.

This file writes the first half to app/data/static.json.  It imports
build_sheet.py rather than duplicating anything, so TEAM_LAYOUT, NOTES,
STATUS, the trainer parser and the ROM readers all stay single-sourced.

SPRITES ARE PATHS NOW, NOT BASE64.  The embedding only ever existed because a
Claude artifact cannot fetch external assets.  Served over HTTP that
constraint is gone: 666 base64 blobs become 666 files, the payload drops from
1.1 MB to ~250 KB, and the Pokemon Factory's 24x30 sprite grid becomes cheap
instead of impossible.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import build_sheet as bs
import gen5

OUT = ROOT / "app" / "data" / "static.json"
SPRITE_DIR = "wiki/docs/img/pokemon"
TYPE_ICON_DIR = "wiki/docs/img/types"


def sprite_paths(personal: dict) -> tuple[dict, dict]:
    """species name -> sprite URL, and type -> icon URL.  Paths, not payloads."""
    sp, missing = {}, 0
    for dex, v in personal.items():
        p = ROOT / SPRITE_DIR / f"{int(dex):03d}.png"
        if p.exists():
            sp[v["name"]] = f"/{SPRITE_DIR}/{int(dex):03d}.png"
        else:
            missing += 1
    ti = {}
    for t in gen5.TYPES:
        if (ROOT / TYPE_ICON_DIR / f"{t}.png").exists():
            ti[t] = f"/{TYPE_ICON_DIR}/{t}.png"
    return sp, ti, missing


def trainer_sprite_paths(rosters) -> dict:
    """portrait number -> URL, for every portrait extracted.

    Paths, not payloads -- the app is served over HTTP, so the base64 the
    published sheet needs would only be 380 KB of wasted transfer here. Every
    portrait is listed rather than only the ones the encounter cards use,
    because Adventure resolves route trainers by class at RUNTIME and cannot
    know in advance which of the 95 it will ask for.

    Also attaches `face` and `cls` to each documented fight, the same join
    build_sheet.trainer_faces() does for the artifact. It takes SEVERAL
    rosters, one per starter: the Striaton leader differs between them, so
    joining only one would leave Chili and Cress without a portrait for
    anyone who did not pick Oshawott.
    """
    out = {}
    d = ROOT / TRAINER_SPRITE_DIR
    if not d.is_dir():
        return out
    for png in sorted(d.glob("*.png")):
        out[str(int(png.stem))] = f"/{TRAINER_SPRITE_DIR}/{png.name}"
    for roster in rosters:
        bs.trainer_faces(roster)
    return out


ICON_DIR = "app/img/icons"


def held_names(sp: dict, items: dict) -> dict:
    """Wild held items as NAMES, resolved here rather than trusted.

    extract_personal.py names them too, but only when state/items.json already
    exists -- and on a first run it does not, because extract_items.py REQUIRES
    state/moves.json and so has to run second. The result was that a clean
    `./setup` produced `wild_held_items: {}` for all 649 species and the
    "worth farming here" panel came out empty, while a machine that had run
    setup before looked fine. That is the worst shape of bug: invisible to
    everyone who already has the files.

    The ids are always present, so resolving from the item table at build time
    removes the ordering dependency instead of papering over it.
    """
    ids = sp.get("wild_held_item_ids") or {}
    if not ids:
        return sp.get("wild_held_items") or {}
    return {slot: (items.get(str(iid), {}).get("name") if iid else None)
            for slot, iid in ids.items()}


def icon_paths(personal: dict) -> dict:
    """species name -> 32x32 party icon URL.

    The game's own party-screen icon. A 96x96 sprite is the right size when
    you are RECOGNISING something -- a picker, a box grid -- and the wrong one
    in a dense list where the picture is an identifier beside text. These are
    that size, and they are the same art the party screen uses.
    """
    out = {}
    for dex, v in personal.items():
        if (ROOT / ICON_DIR / f"{int(dex):03d}.png").exists():
            out[v["name"]] = f"/{ICON_DIR}/{int(dex):03d}.png"
    return out


# The three starters, in the game's own order. Each produces its own roster:
# a different Striaton leader and a different six on every rival fight.
STARTERS = ('Snivy', 'Tepig', 'Oshawott')

ITEM_ICON_DIR = "wiki/docs/img/items"

# The wiki's own filenames, which do not always follow from the ROM's name.
ICON_ALIASES = {
    "Poke Ball": "poke-ball", "Parlyz Heal": "paralyze-heal",
    "EnergyPowder": "energy-powder", "Energy Root": "energy-root",
    "X Defend": "x-defense", "X Special": "x-sp-atk", "X Accuracy": "x-accuracy",
    "Never-Melt Ice": "never-melt-ice", "Up-Grade": "up-grade",
    "Bright Powder": "bright-powder", "Exp. Share": "exp-share",
    "Deep Sea Tooth": "deep-sea-tooth", "Deep Sea Scale": "deep-sea-scale",
    "Guard Spec.": "guard-spec", "Silver Powder": "silver-powder",
    "Soft Sand": "soft-sand", "Black Glasses": "black-glasses",
    "Twisted Spoon": "twisted-spoon", "Thick Club": "thick-club",
    "Poke Doll": "poke-doll", "Fluffy Tail": "fluffy-tail",
}


def item_slug(name: str) -> str:
    """The wiki's filename for an item, best effort."""
    if name in ICON_ALIASES:
        return ICON_ALIASES[name]
    s = (name.replace("\u00e9", "e").replace("\u00c9", "E")
             .replace("\u2019", "").replace("'", ""))
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def item_icons(items: dict) -> dict:
    """id -> icon URL, for the items that actually have one.

    Every TM and HM shares one icon per type in this wiki, so a TM falls back
    to its move's type icon rather than showing nothing -- which also makes the
    TM pocket readable at a glance.
    """
    have = set()
    d = ROOT / ITEM_ICON_DIR
    if d.is_dir():
        have = {f.stem for f in d.iterdir() if f.suffix == ".png"}
    out = {}
    for k, v in items.items():
        slug = item_slug(v["name"])
        if slug in have:
            out[str(k)] = f"/{ITEM_ICON_DIR}/{slug}.png"
    return out


ITEM_DOC = ROOT / "docs" / "Item & Trade Changes.txt"


def rom_diff() -> dict:
    """state/rom_diff.json, reshaped for the browser.

    Optional by design: `extract_personal.py` refuses to emit a diff at all
    without an unmodified ROM to compare against, and someone who ran it that
    way should get a Pokedex that simply does not show change badges, rather
    than one that claims nothing changed.
    """
    path = bs.STATE / "rom_diff.json"
    if not path.is_file():
        return {}
    try:
        d = json.loads(path.read_text())["diff"]
    except (OSError, ValueError, KeyError):
        return {}
    if not d.get("by_species"):
        return {}
    return {
        "species": d["by_species"],
        "counts": d.get("counts", {}),
        "moves": {m["move"]: m["changes"] for m in d.get("move_changes", [])},
    }


def field_items() -> dict:
    """Field items per area, out of Drayano's own documentation.

    This is the ONLY source for what item is lying on which route -- the ROM
    keeps them in event scripts we do not decode -- and it lists only items he
    CHANGED, so an area's unlisted items are still whatever vanilla had. The
    tab says that rather than implying the list is exhaustive.

    Lines read "Old Item -> New Item", sometimes with a count ("* 10") and
    sometimes with a doubled arrow. The old name matters: placement never
    moved, so a vanilla map still marks the exact spot under the OLD name.
    """
    if not ITEM_DOC.is_file():
        return {}
    lines = ITEM_DOC.read_text(encoding="latin-1").splitlines()
    out, area = {}, None
    for i, raw in enumerate(lines):
        line = raw.strip()
        if line == "---" and i > 0:
            head = lines[i - 1].strip()
            if head and not head.startswith(("The following", "+ + +")):
                area = head
                out.setdefault(area, [])
            continue
        if not area or not line or line == "---":
            continue
        m = re.match(r"^(.*?)\s*-+>\s*(.*?)\s*$", line)
        if not m:
            continue
        old, new = m.group(1).strip(), m.group(2).strip()
        count = 1
        cm = re.search(r"\*\s*(\d+)\s*$", new)
        if cm:
            count = int(cm.group(1))
            new = new[:cm.start()].strip()
        if old and new:
            out[area].append({"was": old, "now": new, "count": count})
    return {k: v for k, v in out.items() if v}


# ---------------------------------------------------------------------------
# THE REGION MAP
# ---------------------------------------------------------------------------
# app/img/unova.jpg is the official Black/White region artwork, fetched by
# ./setup rather than committed -- someone else's art, same reasoning that
# keeps the ROM tables and the wiki clone out of git.
#
# Positions are FRACTIONS of the image (0..1), not pixels, so they survive the
# image being replaced with a different scan or crop of the same artwork.
#
# They are placed BY EYE and are estimates. The tab has a calibration mode:
# shift-click a marker to move it, and export the result to replace this
# table. Do not treat these as measured the way the ROM tables are.
# PLACES are nodes; ROUTES ARE THE LINES BETWEEN THEM. That is how the
# in-game map reads and it is what makes a region legible: you do not look up
# "Route 4", you notice that it is the thing between Castelia and Nimbasa.
#
# kind drives the visual weight, because a scatter of forty identical dots is
# unreadable no matter how pretty each dot is:
#   city      gym towns and the League. Labelled always.
#   town      smaller settlements. Labelled on hover.
#   landmark  caves, forests, towers. Muted, labelled on hover.
#
# Positions are FRACTIONS of the image and were placed BY EYE. The tab's
# calibration mode exists to fix them; treat them as estimates.
MAP_PLACES = {
    # --- the opening arm, SOUTH-EAST. Skyarrow crosses west into Castelia,
    #     which is why this runs down the right-hand side.
    "Nuvema Town":          (0.935, 0.858, "town"),
    "Accumula Town":        (0.912, 0.735, "town"),
    "Striaton City":        (0.878, 0.612, "city"),
    "Dreamyard":            (0.845, 0.556, "landmark"),
    "Nacrene City":         (0.812, 0.640, "city"),
    "Wellspring Cave":      (0.848, 0.672, "landmark"),
    "Pinwheel Forest":      (0.728, 0.680, "landmark"),

    # --- the centre
    "Castelia City":        (0.505, 0.806, "city"),
    "Desert Resort":        (0.452, 0.645, "landmark"),
    "Relic Castle":         (0.418, 0.694, "landmark"),
    "Nimbasa City":         (0.505, 0.520, "city"),

    # --- the west
    "Driftveil City":       (0.288, 0.567, "city"),
    "Cold Storage":         (0.235, 0.640, "landmark"),
    "Chargestone Cave":     (0.230, 0.435, "landmark"),
    "Mistralton City":      (0.098, 0.352, "city"),
    "Mistralton Cave":      (0.152, 0.428, "landmark"),
    "Twist Mountain":       (0.212, 0.286, "landmark"),
    "Anville Town":         (0.066, 0.126, "town"),
    "Celestial Tower":      (0.150, 0.196, "landmark"),

    # --- the north
    "Icirrus City":         (0.300, 0.165, "city"),
    "Dragonspiral Tower":   (0.222, 0.106, "landmark"),
    "Moor of Icirrus":      (0.268, 0.126, "landmark"),
    "Victory Road":         (0.556, 0.108, "landmark"),
    "Pokémon League":       (0.598, 0.046, "city"),
    "N's Castle":           (0.640, 0.038, "landmark"),
    "Challenger's Cave":    (0.648, 0.286, "landmark"),
    "Opelucid City":        (0.795, 0.222, "city"),

    # --- the eastern loop, mostly post-game
    "Giant Chasm":          (0.806, 0.386, "landmark"),
    "Lacunosa Town":        (0.700, 0.452, "town"),
    "Undella Town":         (0.870, 0.590, "town"),
    "Undella Bay":          (0.912, 0.648, "landmark"),
    "Abyssal Ruins":        (0.944, 0.700, "landmark"),
    "Black City":           (0.905, 0.470, "town"),
    "Abundant Shrine":      (0.760, 0.604, "landmark"),
    "Lostlorn Forest":      (0.618, 0.606, "landmark"),
    "P2 Laboratory":        (0.272, 0.872, "landmark"),
}

# (from, to, [areas the line passes through], optional bend points)
#
# A leg can be MORE THAN ONE area: you walk Route 5 and then cross the
# Driftveil Drawbridge to reach Driftveil, and both are real places with their
# own encounters. Listing them means every bridge in the game gets a badge
# instead of Skyarrow being the only named one on the map -- which is what it
# looked like when the others simply were not drawn.
#
# An empty list is plain adjacency you cannot walk through as a place. Bends
# keep a line from cutting across half the region to reach its other end.
MAP_LINKS = [
    ("Nuvema Town", "Accumula Town", ["Route 1"], []),
    ("Accumula Town", "Striaton City", ["Route 2"], []),
    ("Striaton City", "Dreamyard", [], []),
    ("Striaton City", "Nacrene City", ["Route 3"], []),
    ("Nacrene City", "Wellspring Cave", [], []),
    ("Nacrene City", "Pinwheel Forest", [], []),
    ("Pinwheel Forest", "Castelia City", ["Skyarrow Bridge"], [(0.640, 0.724)]),
    ("Castelia City", "Desert Resort", ["Route 4"], []),
    ("Desert Resort", "Relic Castle", [], []),
    ("Desert Resort", "Nimbasa City", [], []),
    ("Nimbasa City", "Anville Town", [], [(0.360, 0.470), (0.140, 0.300)]),
    ("Nimbasa City", "Driftveil City", ["Route 5", "Driftveil Drawbridge"], [(0.400, 0.516)]),
    ("Driftveil City", "Cold Storage", [], []),
    ("Driftveil City", "Chargestone Cave", ["Route 6"], []),
    ("Chargestone Cave", "Mistralton Cave", [], []),
    ("Chargestone Cave", "Mistralton City", [], []),
    ("Mistralton City", "Celestial Tower", ["Route 7"], [(0.110, 0.262)]),
    ("Celestial Tower", "Twist Mountain", [], []),
    ("Twist Mountain", "Icirrus City", [], []),
    ("Icirrus City", "Dragonspiral Tower", [], []),
    ("Icirrus City", "Moor of Icirrus", [], []),
    ("Icirrus City", "Challenger's Cave", ["Route 8", "Tubeline Bridge"], [(0.470, 0.196), (0.580, 0.250)]),
    ("Challenger's Cave", "Opelucid City", ["Route 9"], []),
    ("Opelucid City", "Victory Road", ["Route 10"], [(0.700, 0.140)]),
    ("Victory Road", "Pokémon League", [], []),
    ("Pokémon League", "N's Castle", [], []),

    # the eastern loop
    ("Opelucid City", "Lacunosa Town", ["Route 11", "Village Bridge", "Route 12"], [(0.770, 0.330)]),
    ("Lacunosa Town", "Giant Chasm", [], []),
    ("Lacunosa Town", "Undella Town", ["Route 13"], [(0.800, 0.520)]),
    ("Undella Town", "Undella Bay", [], []),
    ("Undella Bay", "Abyssal Ruins", [], []),
    ("Undella Town", "Black City", [], []),
    ("Undella Town", "Abundant Shrine", ["Route 14"], []),
    ("Abundant Shrine", "Lostlorn Forest", ["Route 15", "Marvelous Bridge", "Route 16"], [(0.690, 0.640)]),
    ("Lostlorn Forest", "Nimbasa City", [], [(0.560, 0.570)]),
    ("Castelia City", "P2 Laboratory", ["Route 17", "Route 18"], [(0.380, 0.878)]),
]


MAP_OVERRIDE = ROOT / "state" / "map_positions.json"


def region_map(canon: dict) -> dict:
    """Places, and the routes between them, validated against real areas.

    MAP_PLACES below is a starting point placed by eye. Corrections made in
    the app's calibration mode are POSTed to state/map_positions.json and
    merged over it here, so a fix travels: commit that file and everyone who
    pulls gets the better positions instead of re-doing the same nudging.
    """
    places = {k: {"x": v[0], "y": v[1], "kind": v[2]}
              for k, v in MAP_PLACES.items() if k in canon}
    corrected = added = removed = 0
    saved_links = None
    try:
        blob = json.loads(MAP_OVERRIDE.read_text())
        override = blob["positions"]
        saved_links = blob.get("links")
        for name, v in override.items():
            if v.get("hidden"):
                # Taken off the map on purpose. Dropping it here is what makes
                # that stick for everyone who pulls.
                if places.pop(name, None) is not None:
                    removed += 1
                continue
            if name in places:
                places[name] = {**places[name], "x": float(v["x"]), "y": float(v["y"]),
                                "kind": v.get("kind", places[name]["kind"])}
                corrected += 1
            elif name in canon:
                # The editor can put an area on the map that never shipped on it.
                places[name] = {"x": float(v["x"]), "y": float(v["y"]),
                                "kind": v.get("kind", "landmark")}
                added += 1
    except (OSError, ValueError, KeyError, TypeError):
        override = {}
    unknown = sorted(set(n for n in MAP_PLACES if n not in canon))

    # Roads drawn in the editor replace the shipped set wholesale. Absent means
    # untouched, which is not the same as "the user deleted every road".
    # A link may end at a POINT rather than a second place -- a spur, for a
    # landmark that opens off a road rather than sitting between two towns.
    # Wellspring Cave onto Route 3 is the shape; routes are edges here, so
    # there is no node to connect one to.
    source = ([(l["a"], l.get("b"), l.get("areas", []),
                [tuple(b) for b in l.get("bends", [])], l.get("at"))
               for l in saved_links] if isinstance(saved_links, list)
              else [(a, b, ar, bd, None) for a, b, ar, bd in MAP_LINKS])

    links = []
    for a, b, areas, bend, at in source:
        if a not in places or (at is None and b not in places):
            unknown.append(f"link {a}->{b}")
            continue
        good = []
        for name in areas:
            if name in canon:
                good.append(name)
            else:
                unknown.append(f"route {name}")
        end = [float(at[0]), float(at[1])] if at else [places[b]["x"], places[b]["y"]]
        links.append({
            "a": a, "b": b, "areas": good, **({"at": end} if at else {}),
            "pts": [[places[a]["x"], places[a]["y"]]]
                   + [[x, y] for x, y in bend]
                   + [end],
        })

    # Anything reachable only by a link nobody drew is a place you cannot get
    # to on the map, which reads as a bug rather than as geography.
    linked = {n for l in links for n in (l["a"], l["b"])}
    orphans = sorted(set(places) - linked)

    return {
        "image": "/app/img/unova.jpg",
        "places": places,
        "corrected": corrected,
        "added": added,
        "removed": removed,
        "links_from_editor": isinstance(saved_links, list),
        "links": links,
        "unknown": sorted(set(unknown)),
        "orphans": orphans,
        "routes": sorted({n for l in links for n in l["areas"]}),
        "placed": len(places),
        "total_areas": len(canon),
    }


# --------------------------------------------------------- trainer portraits
TRAINER_SPRITE_DIR = "app/img/trainers"

# The wiki writes class names its own way, and not consistently: some are
# abbreviations ("Pkmn Ranger" for the ROM's "Ranger"), some are ordinary
# typos ("Morotcyclist", "Waitres", "Plmn Ranger"), and a few are a different
# word entirely. Matching is otherwise exact against the ROM's own 105 class
# names, so this table is only the ones that genuinely differ -- keeping it
# short is what makes an unmatched name mean "we do not know" rather than
# "the fuzzy matcher shrugged".
WIKI_CLASS_ALIASES = {
    "pkmn ranger": "ranger", "plmn ranger": "ranger",
    "pkmn breeder": "breeder", "pkmn trainer": "trainer",
    "pokefan": "pokéfan", "cycling": "cyclist", "morotcyclist": "motorcyclist",
    "waitres": "waitress", "black girl": "battle girl",
    "plasma grunt": "team plasma", "team plasma grunt": "team plasma",
    "ace trainers": "ace trainer", "veterans": "veteran",
}

_CLASS_INDEX: dict | None = None
_NAME_INDEX: dict | None = None


def _indexes() -> tuple[dict, dict]:
    """(class name -> portrait, trainer name -> [(class name, portrait)]).

    Built once from state/trainers.json. Both are lower-cased; the class index
    keeps the FIRST class of each name, which is why it must never be the only
    thing consulted -- five classes are called "Leader" and the first of them
    is Chili.
    """
    global _CLASS_INDEX, _NAME_INDEX
    if _CLASS_INDEX is None:
        _CLASS_INDEX, _NAME_INDEX = {}, {}
        path = ROOT / "state" / "trainers.json"
        if path.is_file():
            data = json.loads(path.read_text())
            for c in data.get("classes", []):
                nm = bs.clean_class(c["name"]).lower()
                if nm:
                    _CLASS_INDEX.setdefault(nm, c["sprite"])
            for t in data.get("trainers", []):
                if t.get("name"):
                    _NAME_INDEX.setdefault(t["name"].lower(), []).append(
                        (bs.clean_class(t.get("class_name") or "").lower(), t["sprite"]))
    return _CLASS_INDEX, _NAME_INDEX


def trainer_face(label: str):
    """"Ace Trainer Junko" -> the portrait number, or None.

    THE NAME HAS TO WIN, NOT THE CLASS. Resolving on the class prefix alone
    looks right on route trainers and is badly wrong on the ones that matter:
    five classes are called "Leader", so Lenora, Cilan, Cress and Skyla all
    came out as Chili, and all four of the Elite Four came out as Shauntal.

    So the trailing name is looked up in the ROM's own 616 trainers first, and
    the class prefix is used to disambiguate a name that several trainers
    share. The class prefix alone is the fallback, which is the right answer
    for an ordinary route trainer whose name the ROM does not carry.

    Returns None rather than a stand-in. A wrong trainer is worse than none.
    """
    cls, names = _indexes()
    toks = label.split()

    def prefix(k):
        pre = " ".join(toks[:k]).lower()
        return WIKI_CLASS_ALIASES.get(pre, pre)

    # 1. the name, disambiguated by the class the wiki printed beside it
    for k in range(min(3, len(toks) - 1), -1, -1):
        hits = names.get(" ".join(toks[k:]).lower())
        if not hits:
            continue
        want = prefix(k)
        exact = [sp for cn, sp in hits if cn == want]
        if exact:
            return exact[0]
        # A name every one of whose trainers shares a portrait is unambiguous
        # even when the wiki's class wording does not match ours.
        if len({sp for _cn, sp in hits}) == 1:
            return hits[0][1]

    # 2. the class on its own -- correct for a generic route trainer
    for k in range(min(3, len(toks)), 0, -1):
        if prefix(k) in cls:
            return cls[prefix(k)]
    return None


def route_trainers() -> dict:
    """Per-area trainer summary from the wiki's own tables.

    A COUNT and a level band, not a roster. The spoiler policy is verdicts by
    default, and "eleven trainers, levels 25-28, biggest team of six" is the
    shape of the answer that helps you decide whether to heal first -- without
    telling you what is on any of them.

    The detail sections (`## Leader X`) are left alone here; those are the
    important trainers, and they come from Drayano's own roster file.
    """
    root = ROOT / "wiki" / "docs" / "routes"
    if not root.is_dir():
        return {}
    out = {}
    for d in sorted(root.iterdir()):
        f = d / "trainers.md"
        if not d.is_dir() or not f.is_file():
            continue
        rows = []
        for line in f.read_text(encoding="utf-8").splitlines():
            if not line.startswith("|") or "pokemon/" not in line:
                continue
            cells = [c.strip() for c in line.split("|")[1:-1]]
            if not cells:
                continue
            name = re.sub(r"\s+", " ", cells[0]).strip()
            # A GYM FILE HOLDS TWO TABLES, and only the first is a trainer list.
            # The second is the important trainer TRANSPOSED -- one row per
            # Pokémon, first cell a sprite -- so counting rows made Nacrene Gym
            # report ten trainers when it has four and the Pokémon League
            # forty-two when it has six. A row whose first cell is an image is
            # a Pokémon, not a person.
            if name.startswith("!["):
                continue
            # An important trainer's name cell carries their portrait after a
            # <br/>: "Leader Lenora<br/> ![Leader Lenora](...showdown...)".
            name = re.sub(r"<br\s*/?>.*$", "", name).strip()
            levels = [int(x) for x in re.findall(r"Lv\.\s*(\d+)", line)]
            mons = len(re.findall(r"\]\(/blaze-black-wiki/pokemon/\d+\)", line))
            if name and mons:
                rows.append({"name": name, "n": mons, "face": trainer_face(name),
                             "lo": min(levels) if levels else None,
                             "hi": max(levels) if levels else None})
        if rows:
            lo = [r["lo"] for r in rows if r["lo"] is not None]
            hi = [r["hi"] for r in rows if r["hi"] is not None]
            out[d.name] = {
                "count": len(rows),
                "mons": sum(r["n"] for r in rows),
                "lo": min(lo) if lo else None,
                "hi": max(hi) if hi else None,
                "biggest": max(r["n"] for r in rows),
                "trainers": rows,
            }
    return out


# Gym names in Drayano's roster file do not match any zone: "Nacrene Gym" is
# in Nacrene City, and "Striation Gym" carries his own typo for Striaton.
OPPONENT_LOC_FIX = {
    "Striation Gym": "Striaton City",
    "Castelia City-Route 4 Gatehouse": "Castelia City",
}


def attach_opponents(canon: dict, opponents: list) -> list:
    """Hang each documented trainer on an area. Returns the ones that would not."""
    def norm(x):
        return re.sub(r"[^a-z0-9]", "", (x or "").lower())

    unplaced = []
    for i, opp in enumerate(opponents):
        loc = (opp.get("loc") or "").strip()
        loc = re.sub(r",\s*(Black|White)$", "", loc)
        if not loc or loc == "Blaze Black":
            unplaced.append(opp.get("leader") or f"#{i}")
            continue
        target = OPPONENT_LOC_FIX.get(loc)
        if target is None and loc in canon:
            target = loc
        if target is None:
            n = norm(loc)
            target = next((c for c in canon if norm(c) == n), None)
        if target is None and re.search(r"\bgyms?$", loc, re.I):
            # A GYM IS IN ITS CITY. Drayano writes "Driftveil Gym"; the zone
            # table has "Driftveil City". That is a rule rather than a
            # heuristic, so it is applied as one, before any fuzzy fallback.
            stem = norm(re.sub(r"\s*\bgyms?$", "", loc, flags=re.I))
            target = next((c for c in canon
                           if norm(c) in (f"{stem}city", f"{stem}town", stem)), None)
        if target is None:
            # Last resort: the area whose name starts with the same first word.
            #
            # SHORTEST WINS, NOT LONGEST. It used to take the longest match,
            # which sent Clay from "Driftveil Gym" to "Driftveil DRAWBRIDGE"
            # rather than to Driftveil City -- the longer name is always the
            # compound (a bridge, a gate, a sub-area), and the place itself is
            # always the short one. It went unnoticed because every other gym
            # had exactly one candidate.
            first = norm(loc.split()[0]) if loc.split() else ""
            cands = [c for c in canon if first and norm(c).startswith(first)]
            target = min(cands, key=lambda c: len(norm(c))) if cands else None
        if target:
            canon[target].setdefault("opponents", []).append(i)
        else:
            unplaced.append(f"{opp.get('leader')} ({loc})")
    return unplaced


def area_index(maps: dict, areas: dict, fields: dict, encounters: dict) -> dict:
    """One canonical area record, joining three sources that disagree on names.

    The save gives a ZONE ID, maps.json turns it into a location name, the
    wiki uses its own directory names ("Route 10 - Main Route", "Striaton
    city"), and Drayano's item doc uses a third set. Nothing lines them up for
    us, so this does -- and REPORTS what it could not join instead of quietly
    dropping it, because a silently missing area looks exactly like an area
    with nothing in it.
    """
    canon = {}
    for zid, z in maps["zones"].items():
        loc = z.get("location")
        if not loc:
            continue
        rec = canon.setdefault(loc, {"name": loc, "zones": [], "wiki": [], "items": [],
                                     "order": None, "opponents": [], "trainers": None})
        rec["zones"].append(int(zid))

    def norm(x):
        return re.sub(r"[^a-z0-9]", "", x.lower())

    # Wiki dirs: exact, then normalised, then "the wiki name starts with the
    # location" (which catches "Route 10 - Main Route" and the gym sub-areas).
    for wname in areas:
        target = None
        if wname in canon:
            target = wname
        else:
            n = norm(wname)
            target = next((c for c in canon if norm(c) == n), None)
            if target is None:
                cands = [c for c in canon if n.startswith(norm(c)) and len(norm(c)) >= 6]
                if cands:
                    target = max(cands, key=lambda c: len(norm(c)))
        if target:
            canon[target]["wiki"].append(wname)

    unmatched_items = []
    for iname, entries in fields.items():
        target = iname if iname in canon else next(
            (c for c in canon if norm(c) == norm(iname)), None)
        if target is None:
            cands = [c for c in canon if norm(iname).startswith(norm(c)) and len(norm(c)) >= 6]
            target = max(cands, key=lambda c: len(norm(c))) if cands else None
        if target:
            canon[target]["items"].extend(entries)
        else:
            unmatched_items.append(iname)

    # The item doc is in game order, which is a progression spine we would
    # otherwise have to invent.
    for i, iname in enumerate(fields):
        target = iname if iname in canon else next(
            (c for c in canon if norm(c) == norm(iname)), None)
        if target:
            canon[target]["order"] = i

    # Route trainers: a count and a level band per area, summed across the
    # wiki pages an area owns (Pinwheel has two, and both have trainers).
    rt = route_trainers()
    for name, rec in canon.items():
        parts = [rt[w] for w in rec["wiki"] if w in rt]
        if not parts:
            continue
        los = [p["lo"] for p in parts if p["lo"] is not None]
        his = [p["hi"] for p in parts if p["hi"] is not None]
        rec["trainers"] = {
            "count": sum(p["count"] for p in parts),
            "mons": sum(p["mons"] for p in parts),
            "lo": min(los) if los else None,
            "hi": max(his) if his else None,
            "biggest": max(p["biggest"] for p in parts),
            "list": [t for p in parts for t in p["trainers"]],
        }

    unplaced = attach_opponents(canon, encounters)

    return {
        "areas": canon,
        "unmatched_item_areas": unmatched_items,
        "areas_without_wiki": sorted(c for c, v in canon.items() if not v["wiki"]),
        "unplaced_opponents": unplaced,
    }


def encounters_by_area() -> dict:
    """Every area's wild encounter table, pre-parsed out of the wiki.

    here_panel() used to scrape this markdown at runtime, on the Python side.
    Doing it once here means the browser can answer "what's in this area" for
    ANY area the player walks into, not just the one they were standing in
    when the sheet was last built.

    Rows that sum past ~105% carry a legendary or special encounter whose
    LEVEL the wiki rendered as a PERCENTAGE -- eight areas are affected.  They
    are flagged rather than dropped, because the entry is real; only the
    number is a lie.
    """
    root = ROOT / "wiki" / "docs" / "routes"
    if not root.is_dir():
        return {}
    out = {}
    for d in sorted(root.iterdir()):
        f = d / "wild_encounters.md"
        if not d.is_dir() or not f.is_file():
            continue
        # A logical table row WRAPS across several markdown lines, so lines
        # must be merged by method before totalling.  Summing per line hides
        # the defect completely: Dreamyard's "musharna 70%" sits alone on its
        # own continuation line and reads as a harmless 70% row, when the
        # grass-special row it belongs to actually totals 171%.
        rows = []
        for line in f.read_text(encoding="utf-8").splitlines():
            if "pokemon/" not in line:
                continue
            m = re.match(r"\|\s*!\[([a-z-]+)\]", line.strip())
            method = m.group(1) if m else (rows[-1]["method"] if rows else "?")
            mons = [dict(id=int(sid), pct=int(pct)) for sid, pct in
                    re.findall(r"\]\(/blaze-black-wiki/pokemon/(\d+)\)[^|]*?(\d+)%", line)]
            if not mons:
                continue
            if rows and rows[-1]["method"] == method:
                rows[-1]["mons"].extend(mons)
            else:
                rows.append(dict(method=method, mons=mons))
        for r in rows:
            r["total"] = sum(x["pct"] for x in r["mons"])
            # Over ~105% means a legendary or special encounter got flattened
            # into the rate table and its LEVEL is being shown as a PERCENTAGE.
            r["suspect"] = r["total"] > 105
        if rows:
            out[d.name] = rows
    return out


def main() -> int:
    personal_raw = json.loads((bs.STATE / "personal.json").read_text())
    personal = personal_raw["species"]
    items = json.loads((bs.STATE / "items.json").read_text())["items"]
    maps = json.loads((bs.STATE / "maps.json").read_text())

    moves, abil, abil_by_id = bs.rom_tables()
    sp, ti, missing_sprites = sprite_paths(personal)
    # BOTH FORKS ARE EXPORTED, and neither is baked in.
    #
    # The VERSION fork is a tag on each fight: only the Opelucid leader
    # differs, so one list carries both and the app filters at render time.
    #
    # The STARTER fork cannot be a tag, because it changes the CONTENT of a
    # fight rather than its presence -- Cheren brings a different six
    # depending on what you picked. So the whole roster is built three times,
    # once per starter, and the app picks a list.
    #
    # The three are INDEX-ALIGNED by construction: each keeps exactly one of
    # the three Striaton leaders, and each rival entry keeps its slot and
    # changes only its team. That is what lets AREAINDEX[].opponents and the
    # sheet's `bb_enc` keep storing a position. It is asserted below rather
    # than assumed, because if it ever stopped being true every area would
    # silently point at the wrong trainer.
    opponents = {s.lower(): bs.parse_trainers(None, s) for s in STARTERS}
    lengths = {k: len(v) for k, v in opponents.items()}
    if len(set(lengths.values())) != 1:
        raise SystemExit(f"build_static: the per-starter rosters are not index-aligned "
                         f"({lengths}); AREAINDEX stores positions and would mis-point")
    # The joins below (areas, portraits, the map) are the same for all three,
    # so they run against one representative.
    encounters = opponents[bs.STARTER.lower()]
    trface = trainer_sprite_paths(opponents.values())
    areas = encounters_by_area()
    fields = field_items()
    index = area_index(maps, areas, fields, encounters)

    blob = dict(
        # ---- generic game data, straight from the ROM -----------------
        TYPES=gen5.TYPES,
        CHART={a: {d: gen5.effectiveness(a, [d]) for d in gen5.TYPES} for a in gen5.TYPES},
        MOVES=moves,
        ABIL=abil,
        ABILBYID={str(k): v for k, v in abil_by_id.items()},
        ITEMDESC={v["name"]: v["description"] for v in items.values()
                  if v["name"] in bs.HELD_ITEMS_OF_INTEREST and v["description"]},
        # ALTERNATE FORMES, keyed "<species name>.<forme id>" so the battle
        # board can look one up straight from a trainer record's `forme`. Same
        # shape as a DEX entry -- types and base stats in the same order -- so
        # the consumer substitutes one for the other and nothing else changes.
        # Without this, all six of N 4's Rotom typed as base Electric/Ghost:
        # right for Ground via Levitate, wrong for Water against the Wash
        # forme, and wrong in the direction that reads as a working tool.
        FORME={f"{f['of_name']}.{f['forme']}": dict(
            t=f["types"],
            b=[f["base_stats"][k] for k in ("hp", "atk", "def", "spa", "spd", "spe")],
            bst=f["bst"], of=f["of_name"], n=f["forme"])
            for f in (personal_raw.get("formes") or {}).values()},
        DEX={v["name"]: dict(
            t=v["types"],
            b=[v["base_stats"][k] for k in ("hp", "atk", "def", "spa", "spd", "spe")],
            # THE ABILITIES THIS SPECIES CAN ACTUALLY HAVE. Both slots plus the
            # hidden one, de-duplicated and in slot order -- Gen 5 species often
            # list the same ability twice when they only have one.
            a=[x for i, x in enumerate(list(v.get("abilities") or [])
                                       + ([v["hidden_ability"]] if v.get("hidden_ability") else []))
               if x and x != "--"
               and x not in (list(v.get("abilities") or [])
                             + ([v["hidden_ability"]] if v.get("hidden_ability") else []))[:i]])
            for v in personal.values()},
        SPNAME={v.get("id", i + 1): v["name"] for i, v in enumerate(personal.values())},
        SPRITE=sp, TICON=ti, TRFACE=trface, ICON=icon_paths(personal),

        # ---- things the LIVE half needs to interpret a save ------------
        # Kept here so app/js/roster.js can stay a pure function of
        # (save bytes, static data) with no extra fetches.
        # The Factory's editor needs more than the sheet did: which abilities
        # a species can LEGALLY have (so an illegal one can be flagged rather
        # than silently accepted -- Gen 5 reads the ability byte directly, so
        # writing an illegal one works, and that is a feature here), and which
        # moves it can legally learn, level-up plus TM/HM.
        SPECIES={str(k): dict(name=v["name"], types=v["types"],
                              base=v["base_stats"], curve=v["growth_curve_id"],
                              tmhm=v.get("tmhm", []), ratio=v["gender_ratio"],
                              abilities=v["abilities"], ability_ids=v["ability_ids"],
                              hidden=v.get("hidden_ability"),
                              learn=sorted({e["move_id"] for e in v.get("learnset", [])}),
                              evo=[e["into"] for e in v.get("evolutions", [])],
                              # ---- the Pokedex half ----------------------
                              # `learn` above is a legality SET, which is what
                              # the Factory needs and is useless for reading:
                              # it cannot say when anything is learned. `lvl`
                              # is the level-up list in order, which is the
                              # thing you actually look up.
                              lvl=[[e["level"], e["move_id"]]
                                   for e in v.get("learnset", [])],
                              bst=v.get("bst"), ev=v.get("ev_yield"),
                              catch=v.get("catch_rate"), exp=v.get("base_exp"),
                              eggs=v.get("egg_groups", []),
                              hatch=v.get("hatch_cycles"),
                              friend=v.get("base_friendship"),
                              curveName=v.get("growth_curve"),
                              # Method and parameter, not just the name it
                              # becomes -- "level 39" versus "trade" is the
                              # single most-asked question about this hack,
                              # which removed 21 trade evolutions.
                              evoFull=[dict(into=e["into"], method=e["method"],
                                            param=e["parameter"])
                                       for e in v.get("evolutions", [])],
                              # The cheapest source of good held items early:
                              # a wild Pikachu carries a Light Ball. Hold rates
                              # are 50% common / 5% rare / 1% dark grass.
                              wild_held_items=held_names(v, items))
                 for k, v in personal.items()},
        # TM/HM label -> the move id it teaches, so TM compatibility can be
        # turned into a legal-move set in the browser.
        TMMOVE={r["tm_hm"]: r["move_id"] for r in items.values() if r.get("tm_hm")},
        ITEMS={str(k): (f"{v['tm_hm']} {v['move']}" if v.get("tm_hm") else v["name"])
               for k, v in items.items()},
        # Item detail the Items tab needs: the ROM's own description is the
        # thing that actually documents a hack-changed effect, and the price is
        # the real one (the ROM stores a tenth of it).
        ITEMINFO={str(k): dict(name=v["name"], desc=v.get("description") or "",
                               price=v.get("price"), cat=v.get("category"),
                               tm=v.get("tm_hm"), move=v.get("move"),
                               move_id=v.get("move_id"))
                  for k, v in items.items()},
        ITEMICON=item_icons(items),
        # Egg groups are stored as ids and there is no name table in the ROM's
        # text archive for them, so the names are here. 1-based, and verified
        # against species whose groups are not in doubt: Bulbasaur 1/7
        # (Monster, Grass), Pikachu 5/6 (Field, Fairy), Charizard 1/14
        # (Monster, Dragon), Ditto 13, Articuno 15 (Undiscovered).
        EGGGROUP={1: 'Monster', 2: 'Water 1', 3: 'Bug', 4: 'Flying', 5: 'Field',
                  6: 'Fairy', 7: 'Grass', 8: 'Human-Like', 9: 'Water 3',
                  10: 'Mineral', 11: 'Amorphous', 12: 'Water 2', 13: 'Ditto',
                  14: 'Dragon', 15: 'Undiscovered'},
        # WHAT DRAYANO CHANGED, per species and per move, vanilla beside hack.
        # The whole reason this app can be trusted over a wiki is that it reads
        # the hack's own tables; this is that claim made legible, and it is the
        # first thing a Drayano player wants to know about any Pokemon.
        # Absent when the tables were extracted without a vanilla ROM to
        # compare against, so every reader treats it as optional.
        DIFF=rom_diff(),
        MOVEBYID={str(k): v["name"] for k, v in
                  json.loads((bs.STATE / "moves.json").read_text())["moves"].items()},
        ZONES={k: v["location"] for k, v in maps["zones"].items() if v.get("location")},

        # ---- opponents and areas ---------------------------------------
        # Keyed by starter, the way GATES is keyed by version. `roster.js`
        # and the Adventure tab both go through opponentsFor().
        OPPONENTS={k: v for k, v in opponents.items()},
        # The static half; roster.js fills in which of YOUR Pokémon can set
        # each, because that needs the loaded save.
        FIELD=bs.field_effects(None, moves, abil),
        # What this playthrough is gated on -- the starter fork and the
        # version fork -- so the Reference zone can say why some documented
        # fights are not on the page.
        # Both readings, because the version is a runtime choice here. Written
        # once in Python so the two surfaces cannot word it differently.
        GATES={v: {s.lower(): bs.gates(v, s) for s in STARTERS}
               for v in ('black', 'white')},
        AREAS=areas,
        AREAINDEX=index["areas"],
        MAP=region_map(index["areas"]),

        # ---- the hand-authored half ------------------------------------
        # SEED DATA, NOT TABS. The app adopts these into the team store as
        # ordinary cores the first time it sees a trainer (seedBuiltins() in
        # app/js/teams.js); nothing renders them directly. They ship because
        # state/teams.json is gitignored, so a fresh checkout would otherwise
        # have no rosters at all.
        LAYOUT=[dict(t, slots=[dict(s, options=[list(o) for o in s["options"]])
                               for s in t["slots"]],
                     pilot=[list(p) for p in t["pilot"]])
                for t in bs.TEAM_LAYOUT],
        TEAM_TAG=bs.TEAM_TAG,
        NOTES=bs.NOTES,
        STATUS=bs.STATUS,
        HELD_INTEREST=sorted(bs.HELD_ITEMS_OF_INTEREST),
        STARTER=bs.STARTER.lower(),
        STARTERS=[dict(id=s.lower(), label=s, type=bs.STARTER_TYPE[s]) for s in STARTERS],
    )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(blob, separators=(",", ":")), encoding="utf-8")

    print(f"build_static: {len(blob['MOVES'])} moves, {len(blob['ABIL'])} abilities, "
          f"{len(blob['SPECIES'])} species, {len(encounters)} encounters "
          f"x {len(opponents)} starters, "
          f"{len(blob['AREAS'])} areas, {len(sp)} sprites")
    if missing_sprites >= len(blob["SPECIES"]):
        # Not a warning among others: the app comes up looking finished with
        # every Pokemon a broken image, which reads as a bug in the app rather
        # than as a dependency that was never fetched.
        print("\nbuild_static: ***** NO POKEMON SPRITES AT ALL *****")
        print(f"build_static: nothing under {SPRITE_DIR}. Every Pokemon on every tab "
              "will render as a broken image, and no route will report an encounter.")
        print("build_static: that directory comes from the reference wiki clone. Run "
              "./setup without --no-wiki, then re-run this.\n")
    elif missing_sprites:
        print(f"build_static: {missing_sprites} species have no sprite in {SPRITE_DIR}")
    idx = blob["AREAINDEX"]
    print(f"build_static: {len(idx)} canonical areas · "
          f"{sum(1 for v in idx.values() if v['wiki'])} with encounters · "
          f"{sum(1 for v in idx.values() if v['items'])} with documented field items")
    if index["unmatched_item_areas"]:
        print("build_static: field-item areas with no zone to attach to: "
              + ", ".join(index["unmatched_item_areas"]))
    m = blob["MAP"]
    print(f"build_static: region map has {m['placed']} places, {len(m['links'])} links, "
          f"{len(m['routes'])} of them named routes")
    if m.get("corrected") or m.get("added") or m.get("removed"):
        bits = []
        if m.get("corrected"):
            bits.append(f"{m['corrected']} moved")
        if m.get("added"):
            bits.append(f"{m['added']} newly placed")
        if m.get("removed"):
            bits.append(f"{m['removed']} taken off")
        print(f"build_static: {', '.join(bits)} from state/map_positions.json "
              f"(edited in the app's map editor)")
    if m.get("links_from_editor"):
        print(f"build_static: the {len(m['links'])} roads came from the map editor, "
              f"not from MAP_LINKS")
    if m["orphans"]:
        print(f"build_static: places nothing connects to: {', '.join(m['orphans'])}")
    if m["unknown"]:
        print("build_static: MAP_POS names that are NOT canonical areas (they will never "
              f"light up): {', '.join(m['unknown'])}")
    if not (ROOT / "app" / "img" / "unova.jpg").is_file():
        print("build_static: app/img/unova.jpg is missing — run ./setup to fetch it")

    withtr = sum(1 for v in idx.values() if v.get("trainers"))
    withopp = sum(1 for v in idx.values() if v.get("opponents"))
    print(f"build_static: {withtr} areas have route trainers · "
          f"{withopp} have a documented important trainer")
    if index["unplaced_opponents"]:
        print(f"build_static: {len(index['unplaced_opponents'])} important trainers have no "
              f"area (E4 and champions have no location): "
              f"{', '.join(index['unplaced_opponents'][:3])}...")
    nowiki = index["areas_without_wiki"]
    if nowiki:
        print(f"build_static: {len(nowiki)} areas have no wiki encounter page "
              f"(e.g. {', '.join(nowiki[:3])})")

    suspect = [a for a, rows in areas.items() if any(r["suspect"] for r in rows)]
    if suspect:
        print(f"build_static: {len(suspect)} areas have a level-as-percentage row "
              f"flagged: {', '.join(sorted(suspect)[:4])}...")
    print(f"build_static: wrote {OUT.relative_to(ROOT)} "
          f"({OUT.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
