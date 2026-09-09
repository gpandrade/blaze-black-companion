# Adventure, the region map and the map editor

Pinned by `tools/verify_adventure.mjs` and `tools/verify_mapedit.mjs`.

This is the archaeology — why the code is shaped the way it is, and which
mistakes shaped it. Read it before changing anything it describes; most of
what looks arbitrary here is load-bearing, and the note says which bug made
it so.

---

## Adventure — `app/js/tabs/adventure.js`

**The join is the hard part, and it is done in `build_static.py`.** Three
sources name areas differently and nothing lines them up:

| Source | Names |
|---|---|
| the save → `state/maps.json` | `"Pinwheel Forest"` |
| `wiki/docs/routes/` | `"Pinwheel Forest - Inside"`, `"Striaton city"` |
| `docs/Item & Trade Changes.txt` | a third set, 38 sections |

`area_index()` produces **83 canonical areas** — 44 with encounters, 37 with
documented field items — and **reports what it could not join**, because a
silently unmatched area looks exactly like an area with nothing in it. The
item doc's section order is game order, which gives a progression spine for
free.

What the tab shows, all filtered through what you can reach and what you have:

- **Surf and fishing rows are marked, not hidden.** Without HM03 or the rod
  they are real encounters you cannot get at yet, and saying so beats
  pretending the water is empty.
- **Species already in your Pokédex are dimmed**, so what is *new* stands out
  — that is the actual question walking onto a route. (Gab's dex is 649/649,
  so nothing will ever read as new for him.)
- **The level-as-percentage flag** is surfaced on the eight affected rows
  rather than passed on silently.
- **Field items keep both names.** Placement never moved, so a vanilla Black
  map still marks the spot — under the *old* item's name.
- **Wild held items worth farming**, sorted by encounter rate × hold rate.

Hidden items and mart stock are still unextracted, and the tab says so rather
than guessing. Drayano's doc lists only items he *changed*, so an area with no
entry still has whatever vanilla had — also said out loud.

**The map is the game's own region artwork**, at `app/img/unova.jpg`.
`./setup` fetches it and `.gitignore` keeps it out of git — someone else's
art, same reasoning that keeps the ROM tables and the wiki clone out.

An earlier version drew a hand-made schematic of route order instead. Gab's
verdict was that it was *"strictly worse than using the in-game one"*, and he
was right: overlapping labels, no geography, nothing you could not get better
from the game. He weighed the takedown risk himself and chose the real map.

**Marker positions are FRACTIONS of the image (0–1), not pixels**, so swapping
in a different scan or crop of the same artwork does not break them. 41 of the
83 areas are pinned.

**The starting arm is in the SOUTH-EAST**, not the south-west: Skyarrow
Bridge crosses *west* into Castelia, so Nuvema → Accumula → Striaton →
Nacrene → Pinwheel run down the right-hand side. An earlier pass had them
mirrored to the bottom-left. `verify_adventure.mjs` now pins the
*relationships* rather than the numbers — Nuvema east of Castelia, Driftveil
and Mistralton west of it, the League at the top — so a mirrored table fails
three checks instead of looking plausible.

**A leg can carry SEVERAL areas.** You walk Route 5 and then cross the
Driftveil Drawbridge, and both are real places. `MAP_LINKS` takes a list, and
badges are spaced along the leg by arc length. Without it, Skyarrow was the
only named route on the map and the other four bridges were simply not drawn —
which read as Skyarrow being special rather than as the rest being missing.

## Legibility: the artwork is not a quiet background

**The roads and markers were tuned for green and vanished over white.** The
region art is high-chroma green and blue with **large white regions** — cloud
around the whole border, snow on both mountain ranges. A translucent white
line over a translucent dark halo, and a white marker dot with a *white* outer
glow, are three light layers on a light ground: over cloud or snow they were
effectively invisible.

**The fix is a cased line, not a brighter one.** An opaque light core inside a
near-opaque dark casing is the standard cartographic answer, and it works
because the two halves cover opposite grounds: the casing separates the road
from white, the core reads against the casing over dark. Measured against
sampled map colours:

| | casing vs ground (cloud) | core vs casing (cloud) | marker ring, worst ground |
|---|---|---|---|
| before | 4.79:1 | 4.25:1 | **1.08:1** |
| after | 11.77:1 | 13.65:1 | 4.07:1 |

The marker keeps **both** rings — white inside, dark outside — for the same
reason: measured alone, the dark ring is better on cloud (1.08 → 4.19) and
*worse* on dark forest (2.87 → 2.03). Together the worst ground is 4.07:1.

**Raise the highlight states with the baseline.** `hot` / `here` went up too;
leaving them would have closed the gap between "a road" and "the road you are
pointing at", which is the whole of what hover means here.

**A route badge must not look like a place label.** A dark pill with white
text *is* a city label, so a route wearing one reads as another settlement.
Numbered routes get a round shield — the road-sign idiom, instantly not a town
— and named ones a squared plate, both in a paler slate than any label uses.
Their highlight uses `--fx-go-bg`/`--fx-go-ink`, **not `--ember` + white**,
which is 2.41:1 in dark mode and made the number unreadable exactly when you
hovered it.

**ROUTES ARE THE LINES.** `MAP_PLACES` holds the nodes, `MAP_LINKS` the
edges, and an edge *is* an area — Route 4 is the thing between Castelia and
Nimbasa, so it is drawn as that and is hoverable and clickable in its own
right. That is how the in-game map reads, and it is why a scatter of dots
does not: you never look a route up, you notice where it sits.

Each line gets a fat transparent `.ad-hit` stroke underneath — 2px of visible
line is not a click target — plus a badge at its midpoint. Hovering either
lights both, so they read as one thing. Links with no area are drawn dashed
and quieter, because implying you can visit a piece of adjacency is worse than
not drawing it.

**Markers carry three weights**: `city` (labelled always), `town` (label on
hover), `landmark` (small, squared off, muted). Forty identical dots is
unreadable however nice each dot is, and the region already has this
hierarchy.

**Only Black City is pinned.** White Forest is its Pokémon White counterpart
in the same spot and is unreachable in Blaze Black, so pinning both put two
indistinguishable markers on one coordinate.

**The battle sheet's encounter cards have ALWAYS shown opponent sprites** —
`battleIndex()` builds them from `SPRITE[o.n]`, 239 across 36 cards. An edit
that "added" them silently failed and left only a dead `.bsp` CSS rule behind.
Nothing caught it because nothing checked they render; `verify_app.mjs` now
does.

**A LINK MAY END AT A POINT, not only at another place.** Roads run between
towns, but a great many landmarks hang OFF one — Wellspring Cave opens onto
Route 3. A route is an EDGE on this map, not a node, so there was no way to
say that at all: you could only connect the cave to a town it does not touch.
A **spur** is a link whose far end is a coordinate: arm the place, then click
the road. It draws dashed and thinner, because "this opens off here" is not
the same claim as "you walk from A to B".

Stored as a coordinate and **never as a link index** — indices move when roads
are added or removed, and a spur that silently jumped to a different route
would be worse than one you have to drag again. One spur per place. A place
reachable only by a spur is not an orphan.

**Corrections travel — and the pipeline is now PINNED end to end.**
Calibration used to write only to `localStorage` with an Export-to-console
button — a personal workaround, not a fix. The app POSTs to `/api/map`, which
writes `state/map_positions.json`; `build_static.py` merges it over
`MAP_PLACES`. **Commit that file** and everyone who pulls gets the better
positions. It is deliberately *not* gitignored, unlike the other `state/`
files.

That is **four hops across two languages, every one of them silent when it
breaks**, because a correction that does not travel looks exactly like a
correction you have not made yet:

| | Hop | Where |
|---|---|---|
| 1 | `MapEdit.toPayload()` | browser |
| 2 | `POST /api/map` → `state/map_positions.json` | `serve` |
| 3 | `build_static.region_map()` merges it | Python |
| 4 | the file is not gitignored | `.gitignore` |

`tools/verify_maproute.py` runs the **real JS** to make the payload and the
**real Python** to consume it, and asserts all four operations survive: move a
marker, place one that never shipped, take one off (`hidden` removes it for
everyone), draw a road. It also asserts **notes never leave the browser** —
"Audino here" is a fact about your run, not about Unova — and that
`git check-ignore` still says the file is trackable, because a negated ignore
rule is exactly the thing that quietly stops working when the list above it is
edited.

**Hop 3 is the one with real drift risk:** `toPayload` is written in JS and
`region_map` reads it in Python, so the contract between them is a shape that
nothing else checks. Same reasoning as `verify_blob.py`.

**"Saved" was a lie by omission.** The button wrote the file and stopped
there, so the honest reading of it was "this worked" when nothing on the map
had changed yet and nothing had left the machine. It now names the file and
the **two steps left** — rebuild, then commit — because two silent steps is
how a collaborative fix quietly stays personal.

**They were placed by eye and some will be off.** Treat them as estimates, not
as measured the way the ROM tables are — and fix them in the **map editor**.

## The trainer card — Adventure

The game's own card, as far as the save actually tells us: OT name, id, money,
Pokédex counts and where you are. All of that is verified — the name, both ids
and the money were checked against the in-game card.

**Badges are a PLACEHOLDER and say so.** Eight dashed empty circles plus the
test that would settle it. `0x20393` bits 5/6/7 is a strong candidate and has
never been confirmed, and a trainer card that quietly invents your badge count
is worse than one that admits it cannot read it. When the badge byte is
confirmed, this is the panel that changes.

**The portrait is READ where it can be.** `Save.playerGender()` gets it off a
Pokémon you caught yourself; when that returns null the card falls back to a
remembered choice and draws the portrait with a dashed border, so a guess never
looks like a reading.

**It folds**, like the map and the progress spine. It is reference rather than
something you act on — most sessions you set it once.

**TOP-LEVEL PANELS ARE SPACED BY THE CONTAINER.** `.ad` is a flex column with
`gap: 14px`; no panel brings its own vertical margin. Before that, spacing was
whatever each panel happened to declare, and the trainer card and the story
progress panel ended up at **exactly 0px** — measured, not guessed. That is not
geometric overlap, but two bordered, shadowed cards touching read as one broken
box, which is what "still overlapping" meant. The progress panel had simply
never needed a margin while nothing followed it, so the next panel added would
have been flush again. A stub DOM does no layout, so `verify_adventure.mjs`
asserts it as a CSS rule: the root must lay out with a gap, and no panel may
re-introduce a margin.

## The map editor — `app/js/mapedit.js` + edit mode in `tabs/adventure.js`

Calibration mode is **gone**. It could only nudge a marker that was already on
the map, one at a time, from a permanent strip most people never touched —
and you could not add a missing place or draw a road at all.

**The toolbar sits UNDER the map, stuck to the bottom of the viewport.** Below
is where he wants it; sticky is what keeps the tools and the one-line
instructions on screen, since the map has no `max-height` in edit mode. Both
halves are asserted.

**Edit mode takes over the tab.** That is the fix, not a side effect: placing
markers was hard because encounter tables, trainers, items and the progress
bar were all competing for the screen. In edit mode the map and one toolbar
are the only things on it.

- **Move** — drag a marker. One pointer gesture is **one undo step**: the
  element moves live, the model is told once on pointerup.
- **Connect** — click one place, then another. Refuses self-links and
  duplicates *in either direction*, because a road drawn backwards is the
  same road. A leg can carry several areas (Route 5 *and* the drawbridge).
- **Bends** — handles appear only for the road you have selected, so the map
  is not covered in dots you did not ask for.
- **The tray** holds every area not on the map — click one, then click where
  it goes. This is how a place that never shipped on the map gets onto it.
- **Taking a marker off is reversible**: it returns to the tray. Nothing is
  destroyed, so there is no confirm dialog to click through.

**Three layers, and they are not the same kind of thing:**

| | Lives in | Travels? |
|---|---|---|
| defaults | `MAP_PLACES` / `MAP_LINKS` in `build_static.py` | ships |
| edits | `state/map_positions.json`, POSTed to `/api/map` | **committed** |
| notes | `localStorage` only | never leaves the browser |

**Notes are excluded from the payload on purpose.** "Audino here" is a fact
about your run, not about Unova. `verify_mapedit.mjs` asserts the note text
never appears in `toPayload()`.

**An untouched map writes no `links` key.** Absent means "still following the
shipped set", which is *not* the same as an empty list — writing a copy would
freeze the roads and stop tracking `MAP_LINKS`. Same reasoning as a tombstone:
the absence carries meaning.

`build_static.py` merges all of it: moved, newly placed (`kind` included),
`hidden` markers dropped, and an editor link set replacing `MAP_LINKS`
wholesale. It prints which happened.

**The old `blazeblack.map.nudges` key is migrated on first run.** It was the
only place earlier corrections lived, and a format change must never quietly
lose somebody's work.

Labels are hidden until hover. 41 always-on labels is what made the schematic
unreadable, and the same mistake was one CSS rule away here.

**NO full-map layer may take pointer events — this has now bitten twice.**
`.ad-markers`, `.ad-notes`, `.ad-handles` and `.ad-routetags` all cover the
whole map with `inset:0`. Setting any one of them to `auto` swallows every
click meant for anything beneath it: the map editor shipped with
`.ad-markers.editing` and `.ad-notes.editing` both set to `auto`, and *nothing
on the map was clickable at all*. Only the interactive children — `.ad-pin`,
`.ad-note`, `.ad-handle`, `.ad-routetag` — carry `auto`.

**A plain click must not re-render.** `click` fires *after* `pointerup`, so
re-rendering in the pointerup handler detaches the element before its click
handler can run. The editor shipped that way and no marker could ever be
selected — which also made "Take off the map" unreachable, since it only
exists for a selection. Only commit-and-redraw when the pointer actually
moved. Tests must drive a marker the way a mouse does — pointerdown,
pointerup, *then* click — because calling `onclick` directly walks straight
past this.

A stubbed DOM calls handlers directly and does no hit-testing, so this can
**only** be caught as a CSS rule. The first version of that test asserted the
`auto` rule was present, and so pinned the bug in place; it now asserts the
opposite for all four layers.

Related, same cause: a click on bare map is judged by what it **missed**
(`closest('.ad-pin, .ad-note, .ad-handle, g.ad-link')`), never by testing
`e.target === img`. `.ad-links` covers the map, so its `<svg>` is the hit
target over empty ground and the image is rarely what you actually clicked.

**The marker layer must stay `pointer-events: none`.** It covers the whole
map on top of the route lines, so without it the routes are not clickable at
all — a CSS rule causing a functional bug, which is why `verify_adventure.mjs`
asserts it rather than trusting it. Calibration mode puts it back so
shift-click can place a marker.

**Three label toggles, not two.** City names, route labels, and **Misc.** —
everything that is neither, i.e. towns and landmarks. Misc. is **off by
default**: 41 permanent labels is exactly what made the first version of this
map unreadable, and the third category is the bulk of them.

**The notes toggle is disabled until a note exists**, and its tooltip says
where to make one. A toggle for something you have none of is a dead control.
Notes are never hidden while editing, where you are looking at them on purpose.

**Clear the map** wipes every marker and road to a blank canvas and fills the
tray, for when placing them all yourself beats correcting what shipped. It is
*not* `reset()`, which goes back to the defaults. Notes survive it — different
layer. One undo step, and the Undo button names it.

A cleared map writes an **empty** `links` list, not a missing one: absent
means "still following the shipped roads", so the difference is the whole
point. `links()` hides roads whose endpoints are gone, which makes asserting
it is empty pass even when `clearAll` never touched them — check `linkEdits`.

**Labels: here, hovered, or selected.** Nine permanent city labels still
collide on a map this dense, so city names are a toggle (`City names on/off`,
default on) and everything else labels itself only in those three states.

**The map folds away**, and the fold plus the toggles persist.

**Trainers follow the spoiler policy, structurally** — but the line moved at
Gab's request. **What** a trainer has now shows up front as sprites: you are
about to fight them and will see it the moment you open the card. What still
waits for a click is the planning material — levels, abilities, movesets. The
battle companion's encounter cards carry the same sprite strip.

**Story progress** is an opt-in panel, and it is honest about what it can
measure. **Badges are not readable from the save** — their flag indices are
not derivable from the ROM tables here — so it counts the documented fights
you have ticked off in the battle companion, sharing its `bb_cleared` key.
36 segments in game order, gyms taller because they are the milestones people
measure themselves against, each one clicking through to that fight. It says
so on the panel rather than implying it read your badge case.

**The old spoiler wording:** A route gives a
*verdict* — "11 trainers · levels 25–28 · biggest team 6" — plus how that
compares to your party's levels. The roster is behind a click, every time.
Important trainers come from Drayano's own file, attached to areas by a fuzzy
join ("Nacrene Gym" → Nacrene City, and "Striation Gym" carries his typo for
Striaton); the nine with no location are the E4 and champions, which is
correct. Their teams are also behind a click.

A documented trainer also gets **"Plan this fight →"**, which sets the battle
sheet's `bb_enc` localStorage key to that encounter's index and switches tabs,
so you land on that exact fight with its damage numbers, speed ladder and
matchup planner. Tabs can hand off to each other through `ctx.goTo(id)`.

The test asserts the **mechanism** — that the roster grid does not exist
until revealed — not the absence of species names in the text. String-matching
flagged Drayano's own note ("You picked Oshawott") as a leak, which it is not.

## The story progress panel shows EVERY major fight

The first version showed the eight gym leaders and nothing else, which said the
gyms were the story and N, Ghetsis, the Elite Four and both rivals were not.
All 36 documented fights have portraits, so which of them you care to track is
a **filter** — the same `kind` vocabulary the battle companion's encounter
index uses (`KIND_LABEL` / `KIND_ORDER`), so a chip means the same thing on
both tabs. The choice persists.

**Clearing a fight is synced.** The battle companion owns `bb_cleared`; the
tick on a progress tile writes the same object under the same key, or the two
views would disagree about how far you are — worse than only one of them
offering the control. Opening a fight and ticking it off are **separate
controls** on the tile, so the commonest action (go look at this) is never the
one that changes your recorded progress.

**NEXT UP leads the panel.** It was a one-line strip under the tiles, which
made the single most actionable fact on the tab — who you fight next and
whether you are ready — read as an afterthought appended to a progress report.
It is a card now: portrait, name, place, level gap, and its own way into the
fight.

**Every route into the battle tab carries `bb_enc.jump`.** Switching tabs and
landing at the top of a very long page is what made "Plan this fight" feel
like it had done nothing. `planFight()` in `adventure.js` is the one helper
behind the spine segments, the progress tiles and the button; `battle.js`
reads `jump` **before injecting the template's script** (the template's own
`saveEnc()` rewrites that key during render and would drop it first), clears
it, and scrolls after a frame.

The target is **`#bidxwrap`, not its enclosing `.zone`** — zone 03 opens with
the level curve, so scrolling to the section put a chart on screen and the
fight you asked for below the fold. It is found by id rather than given one,
so the template, which is also the published artifact, stays untouched. The
scroll is **instant, not smooth**: arriving from another tab you want to be
there, not to watch a long page slide past.

**Progress ADDS signal, it does not remove it.** Desaturating the fights you
have not reached means at 0-of-9 the whole row is grey and the feature looks
broken — the same mistake `.ad-mon.caught` made, where every row was "caught"
and the entire tab read as permanently dimmed. An unreached fight is simply the
artwork; clearing one *marks* it.
