#!/usr/bin/env python3
"""
verify_maproute.py -- prove a map correction actually travels to other people.

Why this file asserts what it does: notes/adventure-and-map.md

THE PIPELINE THIS PINS, END TO END
----------------------------------
The pins on the region map were placed by eye and a good many are wrong. The
fix is meant to be collaborative: you drag a marker in the app, and everyone
who pulls gets the better position. That is FOUR hops across two languages,
and every one of them is silent when it breaks --

    1  MapEdit.toPayload()          browser   the shape that leaves the tab
    2  POST /api/map                serve     writes state/map_positions.json
    3  build_static.region_map()    python    merges it over MAP_PLACES
    4  git                          --        the file is NOT gitignored

-- because a correction that does not travel looks exactly like a correction
you have not made yet. The app says "Saved", the JSON is on disk, and the
other person's map is simply unchanged.

Hop 3 is the one with real drift risk: `toPayload` is written in JS and
`region_map` reads it in Python, so the contract between them is a shape
nothing checks. This runs the REAL JS to produce the payload and the REAL
Python to consume it, and asserts that all four operations survive the trip:

    move a marker      the merged position is the one the browser sent
    place a new one    an area that never shipped on the map appears
    take one off       `hidden` removes it for everyone, not just locally
    draw a road        an edited link set replaces the shipped one wholesale

and that NOTES never leave the browser: "Audino here" is a fact about your
run, not about Unova.

READ-ONLY. It writes only into a temp directory.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

PASS, FAIL = 0, 0


def ok(label: str, cond: bool, note: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {label}" + (f"  {note}" if note else ""))
    else:
        FAIL += 1
        print(f"  [FAIL] {label}" + (f"  {note}" if note else ""))


def browser_payload(place: str, newcomer: str, drop: str, road: tuple[str, str]) -> dict:
    """Drive the real MapEdit in node and return exactly what it would POST."""
    script = f"""
import {{ MapEdit }} from '{ROOT}/app/js/mapedit.js';
import fs from 'node:fs';
const S = JSON.parse(fs.readFileSync('{ROOT}/app/data/static.json', 'utf8'));
const areas = Object.keys(S.AREAINDEX ?? {{}});
const E = new MapEdit(S.MAP, areas);
E.move({json.dumps(place)}, 0.4242, 0.3737);
E.place({json.dumps(newcomer)}, 0.1111, 0.2222, 'landmark');
E.unplace({json.dumps(drop)});
E.connect({json.dumps(road[0])}, {json.dumps(road[1])});
E.addNote(0.5, 0.5, 'Audino here — mine, and nobody else should ever see it');
process.stdout.write(JSON.stringify({{
  payload: E.toPayload(),
  noteCount: E.notes.length,
}}));
"""
    with tempfile.TemporaryDirectory(prefix="verify_maproute.") as td:
        f = Path(td) / "run.mjs"
        f.write_text(script)
        out = subprocess.run(["node", str(f)], capture_output=True, check=True)
    return json.loads(out.stdout)


def main() -> int:
    static = ROOT / "app" / "data" / "static.json"
    if not static.is_file():
        print("  skipped: app/data/static.json is not built — run python3 build_static.py")
        return 0

    import build_static as bstat

    S = json.loads(static.read_text())
    placed = S["MAP"]["places"]
    canon = S["AREAINDEX"]
    # Pick real subjects out of the live data rather than naming any one place,
    # so this keeps working when the map is re-pinned.
    place = sorted(placed)[0]
    drop = sorted(placed)[1]
    road = (sorted(placed)[2], sorted(placed)[3])
    newcomer = next(a for a in sorted(canon) if a not in placed)

    got = browser_payload(place, newcomer, drop, road)
    payload = got["payload"]

    ok("the browser produces a payload with positions", isinstance(payload.get("positions"), dict),
       f"{len(payload.get('positions', {}))} entries")
    ok("...and NOTES are not in it", "notes" not in json.dumps(payload),
       f"{got['noteCount']} note(s) held back in the browser")

    # ---- hop 2/3: write it where serve writes it, and merge it as Python does
    with tempfile.TemporaryDirectory(prefix="verify_maproute.") as td:
        override = Path(td) / "map_positions.json"
        override.write_text(json.dumps(payload))
        real = bstat.MAP_OVERRIDE
        try:
            bstat.MAP_OVERRIDE = override
            merged = bstat.region_map(canon)
        finally:
            bstat.MAP_OVERRIDE = real

    pl = merged["places"]
    moved = pl.get(place)
    ok("a moved marker arrives at the position the browser sent",
       moved is not None and abs(moved["x"] - 0.4242) < 1e-9 and abs(moved["y"] - 0.3737) < 1e-9,
       f"{place} -> {moved}")
    ok("an area that never shipped on the map can be added",
       newcomer in pl and merged["added"] >= 1, newcomer)
    ok("taking a marker off removes it for everyone, not just locally",
       drop not in pl and merged["removed"] >= 1, drop)
    # The editor's link set replaces the shipped one WHOLESALE -- absent means
    # untouched, which is not the same as "the user deleted every road". So the
    # count is the shipped set plus the new road, less any link that referenced
    # the marker taken off the map; what matters is that the flag flipped and
    # the drawn road survived the trip.
    ok("a road drawn in the editor replaces the shipped set",
       merged.get("links_from_editor") is True,
       f"{len(merged['links'])} link(s) came from the editor")
    ok("...and the road that was drawn is among them",
       any(l["a"] == road[0] and l["b"] == road[1] for l in merged["links"]),
       " – ".join(road))

    # ---- hop 4: the file has to be COMMITTABLE. A negated .gitignore rule is
    # exactly the kind of thing that silently stops working when the ignore
    # list above it is edited, and then corrections stop travelling with no
    # symptom at all.
    r = subprocess.run(["git", "-C", str(ROOT), "check-ignore", "-q",
                        "state/map_positions.json"], capture_output=True)
    # check-ignore returns 1 for "not ignored", 0 for "ignored" and 128 when
    # this is not a git working tree at all -- which is exactly what a
    # published export is before `git init`. Treat that as unanswerable rather
    # than as ignored: the claim is about THIS repo's .gitignore, and a tree
    # with no .gitignore to get wrong cannot get it wrong.
    if r.returncode not in (0, 1):
        print(f"  [SKIP] map_positions.json ignore rule — not a git working tree")
    else:
        ok("state/map_positions.json is not gitignored, so a fix can be committed",
           r.returncode == 1,
           "git check-ignore says it is IGNORED" if r.returncode == 0 else "")

    print(f"\n  {PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
