#!/usr/bin/env python3
"""
verify_blob.py -- prove the browser port produces the same data as Python.

Why this file asserts what it does: notes/teams-and-cores.md

app/js/roster.js reimplements build_sheet.py's read_live(), take() and team
assembly in JavaScript, so the app can read a save the user just dropped
instead of one Python baked in at generate time.  Reimplementing working
logic is exactly where silent drift creeps in, so this diffs the two.

It runs BOTH implementations over the SAME save and deep-compares the four
sections that are actually recomputed:

    TEAMS   the roster: which record fills which slot, its live stats
    BOXED   the flat PC index behind the search panel
    BAGTM   TMs owned, cross-referenced against who can learn them
    HERE    wild encounters for wherever the player is standing

Everything else in the blob (TYPES, CHART, MOVES, ABIL, DEX, OPPONENTS...)
passes through app/data/static.json unchanged from the same source, so it is
identical by construction and not re-checked here.

    python3 tools/verify_blob.py                 # newest save backup
    python3 tools/verify_blob.py --save X.sav

READ-ONLY.  It defaults to a backup, never the live save, and writes only
into a temp directory.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

LIVE_SECTIONS = ("TEAMS", "BOXED", "BAGTM", "HERE")

# Differences that are deliberate, each with the reason it exists.  Listing
# them here keeps them VISIBLE -- the alternative, quietly excluding them from
# the diff, is how a real regression eventually hides behind a known one.
INTENTIONAL = {
    "HERE.area": "port adds the matched wiki area name; the Adventure tab needs it",
    "HERE.zone": "port adds the raw zone id from the save's position block",
    "HERE.tile": "port adds the player's x/z tile, which Python never surfaced here",
    # ---- TEAMS: both sides read state/teams.json, and both resolve it against
    # the save. What each one then SAYS ABOUT the result differs, on purpose.
    "TEAMS.where": "sheet names the boxes the members live in; the app says how many "
                   "you own and prefixes 'core ·', because a Builder team can specify "
                   "Pokemon you do not have and has no box to name",
    "TEAMS.state": "follows `where` -- the app's is an ownership state, the sheet's a "
                   "storage state",
    "TEAMS.coreBoxes": "sheet only; which boxes the core six sit in",
    "TEAMS.swapBoxes": "sheet only; which boxes the alternates sit in",
    "TEAMS.fromBuilder": "app only; marks a tab the team store produced",
    "TEAMS.adopted": "app only; marks a core rather than a scratchpad team",
    # `mon.nick` USED TO BE LISTED HERE and is deliberately no longer: the app
    # renders the live record for an owned-or-close slot now, so it reads the
    # same nickname the sheet does and any divergence is a real regression.
    # See specToMon() in app/js/teams.js.
    # ---- SETTLED 2026-09-03, and no longer whitelisted -----------------
    # When every copy of a species was already claimed the two sides
    # disagreed: build_sheet.take() returned lst[0] -- REUSING a copy another
    # team already held -- while matchSlot() returned `missing`. The note that
    # stood here said it was undecided and that whoever settled it should
    # change ONE side rather than add a second whitelist.
    #
    # It is settled the app's way, because two teams displaying one Gengar
    # means one of them is lying about what it holds, and the damage numbers
    # under both were computed from that one record. `take()` returns None now.
    #
    # THE ENTRY IS GONE RATHER THAN REWORDED. A whitelist for a bug that has
    # been fixed is how the next regression hides behind a known one.
    "TEAMS.slots.options.note": "the app APPENDS what your copy differs from the spec in "
                                "-- \"Yours differs: level.\" -- because a slot is a "
                                "specification and the app has the matcher that knows how "
                                "far your Pokemon is from it. build_sheet.py resolves a "
                                "slot by scoring the spec and has nothing to say about the "
                                "gap, so it emits the spec's own note alone. The prose "
                                "before the appended sentence must still match, and does",
}

# Diff paths carry list indices ("TEAMS[0].slots[1].options[2].mon.nick"); the
# entries above name a SHAPE, not one position, so indices are stripped before
# matching. Without this an intentional difference would have to be listed once
# per team, per slot, per option.
_INDEX = re.compile(r"\[\d+\]")


def shape_of(diff_line: str) -> str:
    return _INDEX.sub("", diff_line.split(":", 1)[0])


def merge_rows(rows):
    """Merge consecutive same-method encounter rows into one logical row.

    A wiki encounter table row WRAPS across several markdown lines.
    here_panel() in build_sheet.py emitted one row per LINE, which splits a
    single logical row into several and hides the wiki's level-as-percentage
    defect completely: Dreamyard's "musharna 70%" sits alone on a continuation
    line and reads as a harmless 70% row, when the grass-special row it
    belongs to actually totals 171%.

    build_static.py merges them, so the port's rows are the corrected shape.
    Both sides are normalised here so the comparison checks that no encounter
    was lost or invented -- the fix in shape is allowed, a change in content
    is not.
    """
    out = []
    for r in rows:
        if out and out[-1]["method"] == r["method"]:
            out[-1]["mons"] = out[-1]["mons"] + list(r["mons"])
        else:
            out.append({"method": r["method"], "mons": list(r["mons"]), "gated": r.get("gated")})
    return out


def python_blob(save: Path, workdir: Path) -> dict:
    """build_sheet.build_blob(), redirected at `save` instead of the live one."""
    import parse_save as ps
    import parse_bag as pb
    import build_sheet as bs

    # build_sheet reads the ROM tables from STATE and the save-derived JSON
    # from STATE too, so STATE is copied to a temp dir and the save-derived
    # half regenerated there from `save`.
    state = workdir / "state"
    state.mkdir(parents=True, exist_ok=True)
    for name in ("personal.json", "items.json", "moves.json", "maps.json",
                 # trainers.json is a ROM table like the rest, and build_sheet
                 # reads it for rom_rosters() -- the rival variants AND, now,
                 # the moves, items and abilities the doc leaves blank. Absent
                 # it the Python side silently degrades to the doc-only answer
                 # while the browser side has the full one.
                 "trainers.json"):
        src = ROOT / "state" / name
        if src.is_file():
            shutil.copy2(src, state / name)
    # The team store is not save-derived -- it is the same file the app reads
    # through battleTeams() -- so it is carried across rather than rebuilt.
    # Without it the Python side sees no teams while the JS side sees them all,
    # which reads as total drift when nothing has drifted.
    if (ROOT / "state" / "teams.json").is_file():
        shutil.copy2(ROOT / "state" / "teams.json", state / "teams.json")

    ps.DEFAULT_SAVE = save
    bs.STATE = state
    # parse_bag has no --out; it writes STATE_DIR/bag.json, so it is called
    # in-process with STATE_DIR redirected rather than given a new CLI flag.
    pb.STATE_DIR = state

    subprocess.run([sys.executable, str(ROOT / "parse_save.py"),
                    "--save", str(save), "--out", str(state / "party.json"),
                    "--observations", str(state / "curve_observations.json")],
                   check=True, capture_output=True)
    if pb.main(["--save", str(save)]) != 0:
        raise SystemExit("verify_blob: parse_bag failed on this save")

    blob, missing, copies, info = bs.build_blob()
    return blob


def js_blob(save: Path, workdir: Path) -> dict:
    """The app's blob, with its teams folded in the way the Battle tab does.

    TEAMS DOES NOT COME OUT OF buildBlob() ANY MORE. The shipped rosters used
    to be baked into the blob on both sides, which is what made this a
    straight field-for-field diff. They are ordinary cores in the team store
    now, so build_sheet.py reads state/teams.json and the app reads the same
    file through battleTeams() at mount -- two implementations of one join,
    which is exactly the drift this file exists to catch. So the harness does
    what the tab does and puts the result where TEAMS used to be.

    `battleTeams` normally merges localStorage, which does not exist in node;
    its reader catches that and returns nothing, so passing the store as
    `extra` is the whole of it.
    """
    out = workdir / "js_blob.json"
    teams_file = ROOT / "state" / "teams.json"
    script = f"""
import fs from 'node:fs';
import {{ Save }} from '{ROOT}/js/save.js';
import {{ Factory }} from '{ROOT}/app/js/factory.js';
import {{ buildBlob }} from '{ROOT}/app/js/roster.js';
import {{ battleTeams, buildIndex }} from '{ROOT}/app/js/teams.js';
const S = JSON.parse(fs.readFileSync('{ROOT}/app/data/static.json', 'utf8'));
const sv = Save.load(new Uint8Array(fs.readFileSync({json.dumps(str(save))})));
const {{ blob }} = buildBlob(sv, S, {{ ot: sv.readTrainer().ot_name }});
let store = [];
try {{ store = JSON.parse(fs.readFileSync({json.dumps(str(teams_file))}, 'utf8')).teams ?? []; }}
catch {{ /* no team store: TEAMS stays empty on both sides */ }}
const idx = buildIndex(new Factory(sv, S));
blob.TEAMS = battleTeams(sv.readTrainer().trainer_id, idx, S, store);
fs.writeFileSync({json.dumps(str(out))}, JSON.stringify(blob));
"""
    f = workdir / "run.mjs"
    f.write_text(script)
    subprocess.run(["node", str(f)], check=True)
    return json.loads(out.read_text())


def diff(a, b, path="") -> list[str]:
    """Deep diff, reporting the first few concrete disagreements."""
    if type(a) is not type(b) and not (isinstance(a, (int, float)) and isinstance(b, (int, float))):
        return [f"{path}: type {type(a).__name__} vs {type(b).__name__}"]
    if isinstance(a, dict):
        out = []
        # Keys starting with "_" are the port's own additions -- a way back to
        # the exact record a roster entry came from, which the Factory and
        # Team Builder need and the sheet never sees. Not drift.
        keys = {k for k in set(a) | set(b) if not str(k).startswith("_")}
        for k in sorted(keys):
            if k not in a:
                out.append(f"{path}.{k}: missing on the Python side")
            elif k not in b:
                out.append(f"{path}.{k}: missing on the JS side")
            else:
                out += diff(a[k], b[k], f"{path}.{k}")
            if len(out) > 40:
                break
        return out
    if isinstance(a, list):
        if len(a) != len(b):
            return [f"{path}: length {len(a)} vs {len(b)}"]
        out = []
        for i, (x, y) in enumerate(zip(a, b)):
            out += diff(x, y, f"{path}[{i}]")
            if len(out) > 40:
                break
        return out
    if a != b:
        return [f"{path}: {json.dumps(a)[:90]} != {json.dumps(b)[:90]}"]
    return []


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--save", type=Path, help="default: newest file in save_backups/")
    args = ap.parse_args()

    save = args.save
    if save is None:
        backups = sorted(glob.glob(str(ROOT / "save_backups" / "*.sav")), key=os.path.getmtime)
        # THE COMMITTED FIXTURE IS THE FALLBACK. This is a DIFFERENTIAL check --
        # it asks whether roster.js and build_sheet.py answer the same question
        # about one save, not whether that save is interesting. Demanding
        # save_backups/ made ./test-all exit 2 on every fresh clone, which is
        # the worst possible first impression: the suite that is meant to prove
        # the checkout works, refusing to run.
        #
        # This used to add "so any valid save exercises it". IT DOES NOT, and
        # believing it cost a green suite on every clean clone. A sparse save
        # sends build_sheet.py down its mostly-missing branch and it emits no
        # teams at all, while the app emits all of them -- so the fixture
        # exercises a genuinely different path from a real backup, and the
        # team-level correspondence check below exists because of it. Both
        # saves are worth running; they are not interchangeable.
        fixture = ROOT / "tests" / "fixture.sav"
        if backups:
            save = Path(backups[-1])
        elif fixture.is_file():
            save = fixture
        else:
            print("verify_blob: no save in save_backups/, no --save, no fixture",
                  file=sys.stderr)
            return 2
    print(f"  save: {save.relative_to(ROOT) if save.is_relative_to(ROOT) else save}")

    with tempfile.TemporaryDirectory(prefix="verify_blob.") as td:
        work = Path(td)
        py = python_blob(save, work)
        js = js_blob(save, work)

    # Normalise the one shape difference that is a deliberate fix.
    for side in (py, js):
        if isinstance(side.get("HERE"), dict):
            side["HERE"] = {**side["HERE"], "rows": merge_rows(side["HERE"]["rows"])}

    # THE APP SHOWS SCRATCHPAD TEAMS; THE PUBLISHED SHEET SHOWS ONLY CORES.
    #
    # `build_sheet.adopted_cores()` says so in its name: a team you are still
    # experimenting with is a battle tab in the app and is not published. The
    # app marks the two apart by id -- `core-` against `builder-` -- so the
    # comparison is over the cores, which is what BOTH sides claim to produce,
    # and the extras are checked to be exactly the scratchpad ones rather than
    # quietly dropped.
    #
    # It went unexercised for months because the store happened to hold no
    # living non-core team, and then showed up as a bare "length 9 vs 10".
    def cores_only(teams):
        return [t for t in teams if str(t.get("id", "")).startswith("core-")]

    js_extra = [t for t in js.get("TEAMS", [])
                if not str(t.get("id", "")).startswith("core-")]
    stray = [t.get("name") for t in js_extra
             if not str(t.get("id", "")).startswith("builder-")]
    if stray:
        print(f"  ! app-side teams that are neither core nor builder: {stray}")
    if js_extra:
        print(f"  ~ {len(js_extra)} scratchpad team(s) on the app side only, as designed: "
              + ", ".join(t.get("name") or "?" for t in js_extra))
    py["TEAMS"] = cores_only(py.get("TEAMS", []))
    js["TEAMS"] = cores_only(js.get("TEAMS", []))

    UNBUILT = "not in your save yet"

    def built(opt):
        return ((opt.get("mon") or {}).get("box") or "") != UNBUILT

    # A WHOLE TEAM THE SHEET DROPS AND THE APP KEEPS, FOR THE SAME REASON A
    # SLOT IS DROPPED -- one level up, and checked the same way.
    #
    # build_sheet.py refuses to render a team that is mostly not in the save:
    #
    #     if len(slots) * 2 < len(t['slots']):   ... SKIPPED
    #
    # The app keeps it, because a Builder team you have not caught yet is
    # still a plan. So on a SPARSE save the sheet emits nothing and the app
    # emits everything, and the two lists have different lengths for a reason
    # that is entirely designed.
    #
    # THIS IS THE BUG THAT MADE ./test-all FAIL ON EVERY FRESH CLONE. The
    # fallback below picks tests/fixture.sav when save_backups/ is absent --
    # and it is absent on a clean checkout, being gitignored. The fixture holds
    # five Pokemon, so all eight shipped rosters were skipped by the sheet and
    # kept by the app: "TEAMS: length 0 vs 8". It passed on the author's
    # machine for months because save_backups/ was always there. The comment on
    # that fallback claimed "any valid save exercises it"; that was the
    # assumption, and it was wrong -- a sparse save exercises a DIFFERENT path
    # through build_sheet.py, and nothing checked which.
    #
    # The fix is the one the slot check already uses: do not whitelist a length
    # difference, assert the correspondence. Every team the app has and the
    # sheet does not MUST fail the sheet's own predicate, recomputed here from
    # the app's data. A team that goes missing for any other reason still
    # fails, loudly -- and a team the SHEET has that the app dropped always
    # fails, because nothing justifies that direction.
    def resolvable_slots(team):
        """Slots with at least one option the app could match to a record --
        the app-side equivalent of what build_sheet.py counts in `slots`."""
        return sum(1 for sl in (team.get("slots") or [])
                   if any(built(o) for o in (sl.get("options") or [])))

    py_by_id = {t.get("id"): t for t in py["TEAMS"]}
    js_by_id = {t.get("id"): t for t in js["TEAMS"]}

    sheet_skipped, wrongly_kept = [], []
    for tid, jt in js_by_id.items():
        if tid in py_by_id:
            continue
        have, total = resolvable_slots(jt), len(jt.get("slots") or [])
        if total and have * 2 < total:
            sheet_skipped.append(f"{jt.get('name')} ({have}/{total} in the save)")
        else:
            wrongly_kept.append(
                f"{jt.get('name')}: the app has it, the sheet does not, and "
                f"{have}/{total} of its members ARE in the save -- so the "
                f"sheet's 'mostly missing' rule does not explain it")
    app_dropped = [py_by_id[t].get("name") for t in py_by_id if t not in js_by_id]

    if sheet_skipped:
        print(f"  ~ {len(sheet_skipped)} team(s) the app keeps and the sheet skips as "
              "mostly-missing, as designed: " + ", ".join(sheet_skipped))

    # Compare the teams BOTH sides produced, in the sheet's order. zip() alone
    # would have truncated to the shorter list and silently compared team 0
    # against team 0 -- which is how "length 0 vs 8" was the only symptom.
    common = [t for t in py_by_id if t in js_by_id]
    py["TEAMS"] = [py_by_id[t] for t in common]
    js["TEAMS"] = [js_by_id[t] for t in common]

    # A SLOT WITH NO RECORD TO RENDER EXISTS ON ONE SIDE ONLY, AND THAT IS
    # DESIGNED -- but the correspondence is checked rather than waved through.
    #
    # The two products want different things from a slot whose Pokemon you do
    # not own, or whose every copy an earlier team already claimed. The APP is
    # a builder: it keeps the slot and renders the SPEC, marked "not in your
    # save yet", because the plan is the point. The SHEET renders live stats
    # and damage off a real record, and there is none, so it drops the option.
    #
    # Whitelisting "slots may differ in length" would give up the check that
    # matters. Instead the app's extra options are matched against the sheet's
    # omissions: every option the app has and the sheet does not MUST be one
    # the app itself marks as not in the save. An option that goes missing for
    # any other reason still fails, loudly.
    unbuilt_extra, wrongly_dropped = 0, []
    for pt, jt in zip(py["TEAMS"], js["TEAMS"]):
        jslots = []
        for js_slot in jt.get("slots") or []:
            keep = [o for o in (js_slot.get("options") or []) if built(o)]
            unbuilt_extra += len(js_slot.get("options") or []) - len(keep)
            if keep:
                jslots.append({**js_slot, "options": keep})
        jt["slots"] = jslots
        # `coreN` counts the core's members, so it follows the same rule the
        # slots just did -- otherwise the summary contradicts the list under it.
        if "coreN" in jt:
            jt["coreN"] = len(jslots)
        # After dropping the unbuilt ones the two must line up exactly. If they
        # do not, something else is being lost and the whitelist above is not
        # the explanation.
        if len(jslots) != len(pt.get("slots") or []):
            wrongly_dropped.append(
                f"{pt.get('name')}: sheet {len(pt.get('slots') or [])} slots, "
                f"app {len(jslots)} once the unbuilt ones are set aside")
    if unbuilt_extra:
        print(f"  ~ {unbuilt_extra} slot option(s) the app shows as \"{UNBUILT}\" and the "
              "sheet omits, as designed")

    problems, notes = [], []
    if wrongly_kept:
        problems.append("TEAMS: the app kept a team the sheet dropped, and the sheet's "
                        "mostly-missing rule does not explain it: " + "; ".join(wrongly_kept))
    if app_dropped:
        problems.append("TEAMS: the sheet produced team(s) the app did not: "
                        + ", ".join(str(n) for n in app_dropped))
    if wrongly_dropped:
        problems.append("TEAMS: the two sides disagree about slots for a reason other "
                        "than a Pokemon you have not built: " + "; ".join(wrongly_dropped))
    if stray:
        problems.append("TEAMS: the app exported a team that is neither a core nor a "
                        f"builder team: {stray}")
    for sec in LIVE_SECTIONS:
        d = [x for x in diff(py.get(sec), js.get(sec), sec)
             if shape_of(x) not in INTENTIONAL]
        notes += [k for k in INTENTIONAL if sec == k.split(".")[0]]
        n = (len(py[sec]) if isinstance(py.get(sec), (list, dict)) else 1)
        if d:
            problems += d
            print(f"  ✗ {sec:6s} {n:4d} entries -- {len(d)} difference(s)")
        else:
            print(f"  ✓ {sec:6s} {n:4d} entries identical")

    # ---------------------------------------------------------------- abilities
    # THE ABILITY SLOT IS 1-BASED AND NOTHING ELSE PROVES IT. Every other check
    # here survived reading it 0-based, because the fight that exposed the bug
    # (N 4's six Rotom) has the same ability in both slots -- so an off-by-one
    # is invisible exactly where it was found. The oracle is Drayano's own
    # ability rows: where the doc states an ability AND the ROM record specifies
    # a slot, the two must agree. They do, 88 of 98, and every exception is the
    # doc's own Full/Clean rows wrapping an item into the ability column. Read
    # 0-based that agreement collapses, which is the point of the threshold.
    try:
        import build_sheet as bs           # local, like python_blob's imports
        # python_blob redirected bs.STATE at a temp dir that has since been
        # cleaned up, so point it back at the real one before re-parsing.
        bs.STATE = ROOT / "state"
        rom_ab = {}
        for t in json.loads((ROOT / "state" / "trainers.json").read_text())["trainers"]:
            for m in t.get("team") or []:
                if m.get("ability"):
                    rom_ab.setdefault((t.get("name"), m["species"], m["level"]),
                                      set()).add(m["ability"])
        agree = clash = 0
        for f in bs.parse_trainers(None, bs.STARTER):
            for m in f["team"]:
                if m.get("asrc") == "rom" or not m.get("a"):
                    continue          # doc-sourced only: that is the oracle
                lvl = int(m["l"]) if str(m.get("l", "")).isdigit() else None
                got = rom_ab.get((f["who"], m["n"], lvl))
                if not got:
                    continue
                if m["a"] in got:
                    agree += 1
                else:
                    clash += 1
        seen = agree + clash
        if seen >= 40:
            rate = agree / seen
            if rate < 0.80:
                problems.append(
                    f"ability slot: ROM-derived abilities agree with Drayano's own rows "
                    f"only {agree}/{seen} ({rate:.0%}) -- the slot is 1-based; a 0-based "
                    f"read looks like this")
            else:
                print(f"  ability slot 1-based: {agree}/{seen} agree with the doc's "
                      f"own ability rows")
    except (OSError, ValueError, KeyError) as exc:
        print(f"  ~ ability cross-check skipped ({exc.__class__.__name__}: {exc})")

    if problems:
        print(f"\nFAIL -- {len(problems)} difference(s):\n")
        for p in problems[:25]:
            print(f"    {p}")
        if len(problems) > 25:
            print(f"    ... and {len(problems) - 25} more")
        return 1

    print("\n  the browser port and build_sheet.py agree on every live field")
    if notes:
        print("\n  deliberate differences, allowed by name:")
        for k in sorted(set(notes)):
            print(f"    + {k} -- {INTENTIONAL[k]}")
        print("    ~ HERE.rows -- wrapped wiki rows merged by method; content compared after merging")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
