#!/usr/bin/env python3
"""
verify_assets.py -- every image the app asks for is one the server will send.

WHY THIS EXISTS
`serve` answers static requests from an allow list, and `build_static.py` emits
image PATHS rather than payloads.  Those are two independent statements about
the same set of URLs, kept in two files, and nothing compared them -- so
narrowing the server's scope silently 404'd 1,109 of the app's 1,854 images:
every Pokemon sprite, every item icon, every type icon.  All three live in the
wiki clone; only trainer portraits and party icons are under app/.

The symptom was precise and easy to misdiagnose. Opponent portraits rendered
and Pokemon did not, because those two happen to sit on opposite sides of the
line -- which reads as "the sprite pipeline is broken", not as "the server
stopped serving one directory".

Nothing else could have caught it. verify_app.mjs runs the tabs against a
stubbed DOM, where an <img src> is a string that is never fetched; the browser
is the only thing that had ever tested this, and only by being looked at.

BOTH DIRECTIONS, because the interesting failure is the permissive one.  A
check that only asserts "the app's images are servable" is satisfied by a
server that serves the entire disk -- which is exactly the bug the allow list
was added to fix.  So this also asserts that the things the allow list exists
to withhold stay withheld.
"""
from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BLOB = ROOT / "app" / "data" / "static.json"
IMAGE = re.compile(r"\.(png|jpe?g|gif|svg|webp)$", re.I)

PASSES = 0
FAILURES: list[str] = []


def ok(label: str, cond: bool, detail: str = "") -> None:
    global PASSES
    if cond:
        PASSES += 1
        print(f"  [PASS] {label}" + (f"  {detail}" if detail else ""))
    else:
        FAILURES.append(f"{label}: {detail}")
        print(f"  [FAIL] {label}  {detail}")


def load_serve():
    """Import `serve` for its Handler -- it has no .py suffix, hence the loader."""
    spec = importlib.util.spec_from_loader(
        "serve_mod", importlib.machinery.SourceFileLoader("serve_mod", str(ROOT / "serve")))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)                 # main() is behind __main__
    return mod


def asset_urls(obj, out: set[str]) -> set[str]:
    if isinstance(obj, str):
        if obj.startswith("/") and IMAGE.search(obj):
            out.add(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            asset_urls(v, out)
    elif isinstance(obj, list):
        for v in obj:
            asset_urls(v, out)
    return out


def main() -> int:
    if not BLOB.is_file():
        print(f"verify_assets: no {BLOB.relative_to(ROOT)} -- run ./setup first")
        return 0                                  # a skip, not a failure

    srv = load_serve()
    urls = sorted(asset_urls(json.loads(BLOB.read_text()), set()))
    ok("the blob references images at all", len(urls) > 500, f"{len(urls)} URLs")

    # `serve` decides scope on the resolved filesystem path, so ask it exactly
    # the way the handler does: URL -> path under ROOT -> in scope?
    #
    # TAKES A REPO-RELATIVE PATH, and that is load-bearing. This first read
    # `ROOT / url.lstrip("/")` with the NEGATIVE cases handing it an absolute
    # path, so "<root>/CLAUDE.md" became "<root>/<root>/CLAUDE.md" -- under
    # ROOT, under nothing allowed, therefore refused by every possible policy.
    # All nine "...but X is not served" assertions passed unconditionally.
    # Caught by mutating the scope to all of wiki/ and watching it not notice.
    def permitted(rel: str) -> bool:
        assert not rel.startswith(str(ROOT)), f"pass a repo-relative path, got {rel}"
        return srv.Handler._in_scope(str(ROOT / rel.lstrip("/")))

    blocked = [u for u in urls if not permitted(u)]
    ok("every image the app asks for is inside the server's scope",
       not blocked,
       f"{len(blocked)} blocked, e.g. {blocked[:3]}" if blocked else f"all {len(urls)}")

    missing = [u for u in urls if not (ROOT / u.lstrip("/")).is_file()]
    # Absent art is a setup problem, not a policy one: say so without failing.
    if missing:
        print(f"  [SKIP] {len(missing)} referenced file(s) not on disk "
              f"(run ./setup) e.g. {missing[0]}")
    else:
        ok("every referenced image is on disk", True, f"all {len(urls)}")

    # Each directory the app draws from, named, so widening the scope by
    # accident to cover a missing one still fails the specific assertion.
    for prefix, what in (("/app/img/icons/", "party icons"),
                         ("/app/img/trainers/", "trainer portraits"),
                         ("/wiki/docs/img/pokemon/", "Pokemon sprites"),
                         ("/wiki/docs/img/items/", "item icons"),
                         ("/wiki/docs/img/types/", "type icons")):
        group = [u for u in urls if u.startswith(prefix)]
        ok(f"...{what} are served", bool(group) and all(permitted(u) for u in group),
           f"{len(group)} under {prefix}")

    # THE OTHER DIRECTION. Without this, a server that served everything would
    # pass every assertion above -- which is the bug the allow list prevents.
    for path, what in (("save_backups/x.sav", "a save backup"),
                       ("companion.config.json", "the local config"),
                       ("CLAUDE.md", "the agent brief"),
                       ("notes/save-format.md", "the design notes"),
                       ("state/party.json", "the decoded party"),
                       ("state/teams.json", "saved teams"),
                       (".git/config", "the git config"),
                       ("wiki/docs/pokemon/001.md", "wiki prose outside img/"),
                       ("app/../CLAUDE.md", "a traversal out of app/")):
        ok(f"...but {what} is not", not permitted(path), path)

    print(f"\n  {PASSES} passed, {len(FAILURES)} failed"
          if FAILURES else "\n  all checks passed")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(main())
