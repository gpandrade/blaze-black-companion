# The Team Builder, teams and cores

Pinned by `tools/verify_builder.mjs` and `tools/verify_blob.py`.

This is the archaeology — why the code is shaped the way it is, and which
mistakes shaped it. Read it before changing anything it describes; most of
what looks arbitrary here is load-bearing, and the note says which bug made
it so.

---

## The Team Builder — `app/js/teams.js` + `tabs/builder.js`

**A slot is a SPECIFICATION, not a pointer.** The obvious design — a slot
points at a Pokémon in the save — is wrong here: you want to design a team as
an idea before you own it. So the save is matched *against* the spec, and
every slot lands in one of three states:

| State | Meaning | Offer |
|---|---|---|
| `owned` | a Pokémon matches exactly | says which box it's in |
| `close` | you have the species, something differs | **Adjust it** — lists the diffs, edits in place |
| `missing` | nothing of that species | **Create it** — builds it into the first free box slot |

`close` is the common case and the useful one. Adjusting edits **in place**
rather than making a corrected copy, because a close match means you already
own it and want it different — a second copy just leaves you sorting out
which is which.

**Nickname and shininess are NOT differences.** Neither changes how a Pokémon
performs, and flagging them would bury the ones that matter. Level *is* a
difference but is ranked last.

**Two slots wanting one species claim two different Pokémon** — the same
problem `build_sheet.py`'s `take()` solves for the battle sheet, for the same
reason.

**One working copy across tabs.** `app.js` owns the `Factory` instance and
passes it in `ctx.factory`; Builder and Factory share it. Two working copies
of one file would diverge the instant you used both tabs, with two undo
stacks and two "unsaved changes" flags.

**A slot is a JOB; options are ways to fill it.** `Slot = {role, why, options: [Option]}`
where `options[0]` is the default and each `Option` is a full spec plus a
`badge` and a `note`. This mirrors `TEAM_LAYOUT`, where the swap tree is the
part of the sheet that actually gets used. Role and reason live on the *slot*:
they describe the job, and swapping who does it does not change what the job
is. `normalizeTeam()` migrates teams saved before this — a format change must
never quietly lose somebody's team.

**Seed a team from a core** rather than building six slots by hand:
`teamFromMons()` fills from your party, any box, or one of your cores.

**Visualizations:** defensive coverage and offensive coverage are always on —
they are the two that change decisions. Five toggles are opt-in and
remembered: **stat radar** (small multiples on a shared scale — six polygons
overlaid is unreadable, one chart each is not), **stat bars**, **speed
order**, **role balance** (with a sentence saying what the shape *means*),
and **type synergy** as a members × members matrix where each cell counts how
many of the row member's weaknesses the column member resists.

The Builder carries its own **Install / Download** pair. Creating and
adjusting stage into the same working copy the Factory holds, so making the
user switch tabs to press a button that acts on work done here is a papercut.

**`read_live()` returns a LIST, not a dict.** It used to key records by
`(location, species)`, which silently lost duplicates: two of the same species
in one box collided and only the later survived. Invisible while every box
held one of each — and wrong the moment boxes were reorganised. `tools/verify_blob.py`
caught it by diffing against the browser port, which kept every copy. Don't
re-introduce a keyed dict there.

**Saved teams become battle-companion tabs.** `toBattleTeam()` converts a
Builder team into exactly the shape `TEAM_LAYOUT` produces, and `battle.js`
appends them at mount — so switching tabs always picks up what the Builder
last saved, with no coordination between the two. The sheet cannot tell the
difference, so every calculation applies unchanged.

Two things that conversion decides, and why:

- **The numbers come from the SPEC, not from what you own.** A Builder team is
  a plan; "how would this perform" is the question. Slots you have not built
  are counted in the team's `warn` line instead of quietly rendering as real.
- **Every team gets a warning**, computed: the worst defensive hole, the
  offensive gaps, and how many members are not in the save as specified. A
  team sheet that only says nice things is not worth reading.

`specStats()` reimplements the stat formula for specs that may not exist in
the save, so `verify_builder.mjs` checks it against the Factory's own
computation for **every Pokémon in the save** — 274 labelled examples of the
right answer. Role is inferred from the spread and moves, overridable per
slot, and always one of the four the sheet styles.

**Persistence is both, on purpose.** `localStorage` keyed by trainer id is the
live store so the app works with no server; `POST /api/teams` writes
`state/teams.json` when `./serve` is running. Loading merges by id with the
newer `updated` winning. Neither is the source of truth for the other.

## The shipped rosters ARE cores — there is no "built in" any more

Kaiju, Rain, Trick Room, Edgelord, Mewtwo, Contrary Engine, Sun King and My
Uncle Works at Nintendo used to be rendered straight out of `TEAM_LAYOUT` as
battle tabs the team store knew nothing about. That made them a second class of
team: **visible everywhere, editable nowhere.** You could copy Kaiju, you could
field it, and you could never rename it, rewrite its pilot cards or retire it,
because it lived in Python. The distinction bought nothing — a core *is* a
line-up you adopted, and these are the most adopted line-ups in the project.

**`seedBuiltins()` in `app/js/teams.js` adopts them into the store on first
run.** After that they are ordinary cores. `app.js` calls it right after the
save loads (`adoptShippedRosters()`), not from a tab, because either the Battle
tab or the Builder can be the first thing you open and seeding from whichever
mounted first would mean Kaiju existing or not depending on where you clicked.
`tools/adopt_layout.mjs` is the same call from the CLI, wired into `./setup` so
`./refresh` before you have ever opened the app still produces a sheet with
teams on it.

**`TEAM_LAYOUT` still ships** — `state/teams.json` is gitignored, so without it
a fresh checkout would have no rosters at all. It is **seed data, not a source
of tabs**. `build_static.py` exports it as `LAYOUT` purely to seed.

**ONCE-ONLY TAKES TWO GUARDS, and each alone is wrong.** A localStorage marker
lists what has been offered — needed because "is there a core called Kaiju"
says no once you retire it (it becomes a team) or delete it (the tombstone is
pruned after 30 days), and seeding would hand back a roster you threw away. A
name check against the store — needed because the marker is per-browser and the
store is not, so a store seeded elsewhere (the repo copy, the CLI, another
machine) arrives with the cores in it and no marker. A roster is adopted only
when both say it is new, and either one seeing it records it as seeded.

**THE TAGS' LAST JOB, and it was a live bug.** A `TEAM_LAYOUT` slot names only
a SPECIES, and the save holds four Arcanines built for four different teams, so
`layoutToTeam()` disambiguates on the one-letter nickname tag. The tag lives in
`TEAM_TAG` *beside* the layout, not on it — the first migration ran without it,
every roster took the first free copy, and the whole assignment shifted by one:
Kaiju held the Uncle team's Wonder Guard Gengar, Contrary Engine held Kaiju's.
Nothing on screen said so; the nicknames in a debug dump were the tell.
`verify_builder.mjs` asserts the tag **changes the answer** rather than pinning
one person's Gengar to Levitate.

**`build_sheet.py` reads the same store.** `adopted_cores()` turns living cores
into the assembly's shape and `take()` resolves each slot against the save by
**scoring the spec** — ability, nature, moves, item, level — instead of matching
a nickname tag. Both sides sort newest-`updated` first so they agree on tab
order. `tools/verify_blob.py` diffs the two implementations over the same store
and the same save, which is the check that would have caught the shift.

**Field conditions are DECLARED and DETECTED, unioned on both sides.**
Detection reads what a team carries (Drizzle, Rain Dance, Trick Room), which is
right for a team you just built. It is not the whole answer for one you
adopted: Trick Room's roster opts into sand and sun toggles for weather the
*opponent* brings, and nothing on the team sets them. `toBattleTeam()` seeded
its `mech` from detection alone and silently took all three toggles off that
team.

**No teams at all is a real state.** The template used to read
`orderedTeams()[0].id` and take the whole page down — encounter data, reference
tables and all — for the one section that needs a team. It now says what to do
and the rest of the page carries on. `verify_app.mjs` runs the script against
an empty `TEAMS` to pin it.

## The sheet renders the Pokémon you OWN, not the one you specified

A slot is a specification and the save is matched against it, so for an `owned`
or `close` slot there are two honest answers to "what is this". `specToMon()`
gave the **spec's**, and that was wrong in a way that only ever showed up as a
number: the battle tab computes damage off `stats`, so a core whose spec froze
at level 32 kept calculating for a level-32 Mewtwo long after the real one hit
33. Damage, the speed ladder and the level-curve chart were all for a Pokémon
that no longer existed.

`build_sheet.py` always read the live record, so the two implementations
disagreed on 16 fields and `verify_blob.py` had been reporting it for days as a
suspected Battle Box duplicate. It was neither a duplicate nor a decode bug.

**Nothing is lost by preferring the live record.** What the spec *wanted* is
still carried, and more precisely, by `diffs` — rendered as
`Yours differs: level, ability.` So the page says what you have, the number is
true of it, and the gap from the plan is stated instead of being silently split
between the two. `missing` has no live record by definition and still renders
the spec, which is the point of a spec.

**The nickname is passed through RAW, not gated on `isNicknamed`.** An
un-nicknamed Pokémon stores its species name in caps ("GARCHOMP"); whether to
show that is the renderer's call, and `build_sheet.py` passes it straight
through. Filtering it here would be this layer quietly deciding something the
other implementation does not.

## When every copy is claimed — settled twice (2026-09-03, corrected 2026-09-04)

**The second answer was still wrong, and Gab caught it: *"I definitely own all
the mons for my original teams."*** He did. The sheet was reporting Gengar,
Snorlax, Cofagrigus, Zoroark and four of Rain's members as *not in your save*,
about Pokémon sitting in his boxes.

The count says why: **five cores list a Gengar and he owns four.** Also Mewtwo
(5 cores), Snorlax (4), Slowking, Tyranitar, Arcanine.

So the model was wrong, not the lookup. **Claiming quietly assumed teams
coexist.** They do not — a core is a line-up you field one at a time, and five
of them each listing the one Gengar you own is completely legitimate. Claiming
is right for what it was built for (his two Slowkings, one per team, must
resolve to *different* records) and wrong the moment demand exceeds supply.

Both previous answers were therefore wrong in different directions:

| | when the copies ran out |
|---|---|
| `take()`, originally | handed over whichever copy sorted first, **silently** |
| both sides, after 09-03 | reported `missing` — **denying a Pokémon in the save** |
| **now** | claim a distinct copy while there is one; otherwise fall back to the **best match** and say it is **shared** |

**The saying is half the fix.** A page that shows two teams on one Gengar
without mentioning it implies an exclusivity it does not have — which is the
failure claiming was built to prevent. The note reads *"Shared — another team
is built on this same copy."*

The fallback picks by the **same ranking** as a normal claim, so both sides
land on the same copy. That is asserted directly in `verify_builder.mjs` rather
than through `verify_blob`, because whether any slot is shared *at all* depends
on what happens to be in the store — the cross-side check could not see a
positional fallback at all on the current data, and a mutation proving it
survived is what sent the assertion here.

Result: the not-found list went from ten slots across five teams to **two** —
the Reuniclus and Escavalier of a new core he has genuinely not built yet.

## The earlier half of it, kept for its reasoning — 2026-09-03

The long-standing UNDECIDED entry in `verify_blob.py`, and it turned out to be
a page that lied.

When a slot wanted a species whose every copy an earlier team had already
claimed, the two sides answered differently:

| | answer |
|---|---|
| `build_sheet.take()` | `return lst[0]` — **reuse a copy another team already holds** |
| `matchSlot()` | `missing` — "not in your save yet" |

The whitelist said it was undecided and that *"whoever settles it should change
ONE side, not add a second whitelist"*. It is settled the **app's** way, and
`take()` returns `None`.

**Because the sheet was not merely displaying a duplicate — it was computing
off one.** *My Uncle Works at Nintendo* and *Sleight of Hand* both showed the
same Party Gengar, and the damage numbers under both came from that single
record. Two teams cannot field one Pokémon; one of those pages was wrong about
what it holds, which is the exact failure claiming exists to prevent.

**The whitelist entry is gone rather than reworded.** A whitelist for a bug
that has been fixed is how the next regression hides behind a known one.

### What that exposed, and how the checker learned it

Dropping the reuse means the sheet has no record to render for those slots, so
it omits them — while the app keeps them and marks them *"not in your save
yet"*, because a slot is a specification and the plan is the point.

That is a real difference between a published battle sheet and a builder, and
whitelisting *"slots may differ in length"* would have given up the check
entirely. Instead `verify_blob` sets the app's unbuilt options aside and
**asserts the correspondence**: every option the app has and the sheet does not
must be one the app itself marks unbuilt. An option that vanishes for any other
reason still fails, loudly — mutation-tested by making one disappear for a
different reason.

### And a second divergence underneath it

`role`. A slot built in the Builder declares none, the app fills one in with
`inferRole()`, and the sheet passed `sl.role` straight through — so an adopted
core showed role chips in the app and none on the page. `build_sheet` now runs
the same rule on the same inputs, which needed `specStats()` ported digit for
digit (Shedinja included) because the rule reads the **spec's** stats, not the
matched Pokémon's.

Three mutants, three caught: restoring the reuse, dropping the role inference,
and losing an option for a reason other than being unbuilt.

## Claiming is GLOBAL across the assembly

Gab keeps four Arcanines and two Slowkings, one per roster. If every team
matched against the full save on its own, two teams that both want a Slowking
would render the **same record** and one of them would be lying about what it
holds.

`build_sheet.py` has always claimed globally. The port did not —
`battleTeams()` called `toBattleTeam()` per team and `matchTeam()` made a fresh
`taken` set each time — and **it hid for months**, because every other
duplicate was told apart by its spec. Only two Wobbuffets that were identical
in species, level, nature, ability, item, moves and stats, differing solely in
a leftover nickname tag, could expose it.

`battleTeams()` threads one `taken` set through the whole assembly now. The
default stays per-team, which is right for the **Builder**: a team being edited
should show what it could claim on its own, not what is left over after every
other team has resolved.

**It only surfaced because a whitelist was removed.** `TEAMS.slots.options.
mon.nick` had been listed as an intentional difference; once the live-record
fix made nicknames converge, the entry became dead weight — and dead weight in
`INTENTIONAL` is exactly how `verify_blob`'s docstring says a real regression
ends up hiding behind a known one. Delete entries that stop being true.

## WHICH copy a slot claims — count differences, never score them

Claiming globally settles that two slots cannot share a record. It does not
settle **which** record each one takes, and the two implementations answered
that differently for a year.

`build_sheet.py`'s `take()` scored candidates on a weighted scale — ability 8,
nature 4, two per move, item 2, level 1. `app/js/teams.js`'s `matchSlot()`
counts **how many fields differ**, party first on a tie. Those agree on almost
every save, which is why it went unnoticed; they disagree the moment you own
several copies that are close in different ways.

Gab playing on 2026-08-31 produced exactly that: a fourth Gengar. Three level-21
box copies carrying the old `C ` / `S ` / `K ` team tags, plus his live level-40
`Athena` in the party. The app gave each tagged Gengar to the team its tag names
and `Athena` to the one whose spec she actually matches. Python gave **Uncle**
the Kaiju-tagged copy, and every assignment after it shifted by one — the same
shape as the first migration's bug, and the reason a slot resolves by
*specification* at all.

Weighting is the thing that was wrong. It encodes a claim about which fields
matter more, that claim was never written down or tested, and the app's
`diffSlot()` — which the UI shows the player as *"Yours differs: level,
ability."* — had already made the opposite choice. Two answers to one question,
and the one people can read on screen is the one that has to win.

`take()` counts differences now, EVs and IVs each counting **once** exactly as
`diffSlot()` does (it breaks out of its loop on the first differing stat), with
`Party` breaking a tie. `adopted_cores()` had to start passing `ivs`/`evs`
through for that to mean anything — they are matching inputs only and never
reach the emitted options, so the blob is unchanged by their presence.

**Both sides open a slot on the copy you are CARRYING.** `defaultIdx` was the
last difference left: the sheet had always picked the first option whose
Pokémon is in your party, the app hardcoded `0`. So a slot whose third swap you
had fielded showed the plan on the sheet and the first option in the app — with
different damage numbers under each, which is the failure that matters. The
sheet's rule is the better one and the app follows it.

## The slot editor: every control shaped like its decision

It was a column of number boxes and dropdowns. All correct, all dull, and
several of them actively slower than the thing they were standing in for.

**A picker closes once it has done its job.** The species grid used to sit open
for the life of the dialog — 380px of sprites between you and every other
field, long after you had chosen. Now: open while you are choosing, collapsed
to the choice afterwards, one click to reopen. Same rule for the held item, and
for the move list once all four slots are full. A new slot opens with the grid
up because you have not chosen yet; an existing one opens collapsed because you
have.

**The nature is the game's own 5×5 chart.** A nature *is* a pair of stats and
the id encodes exactly that — `id/5` is the raised stat, `id%5` the lowered
one, both indexing `NATURE_STAT_ORDER`. Laying it out that way makes "+Speed,
−Attack" one glance instead of recalling that this is called Timid, and puts
the five neutral natures on the diagonal where they belong.

`NATURE_STAT_ORDER` is exported from `js/tables.js` rather than restated here:
a second copy of a five-element order that decides which nature every cell
writes is a bug waiting. **`verify_builder.mjs` asserts a cell's POSITION
agrees with the nature it writes** — Timid at row 2, column 0 — because a
transposed grid would look perfectly plausible and hand you the opposite
spread.

**EVs are a BUDGET, and twelve number boxes hid it.** 510 to spend, 252 to any
one stat, and the whole skill is deciding where. There is a meter and a bar per
stat now, plus the two spreads everybody actually uses offered rather than
typed.

**The cap is computed at the moment of the edit, not at render time.** It
depends on what the other five stats hold *right now*, so a value closed over
at render is stale the instant anything else moves — which is only hidden in
the browser because the redraw happens between edits. Relying on that is
relying on a render to enforce a rule, and the test that drives the inputs
without a redraw in between caught exactly that.

**Small ones that were the same mistake:** four roles are chips carrying what
each means, not a dropdown; the level has a slider and the presets that matter
including *match my party*; shiny is a toggle; and "why this slot exists" is a
textarea with an example, because it is a sentence that shows on the battle tab.

## Why the sliders did not slide

`oninput` called the caller's `after()`, which is `draw()` — **a full rebuild
of the form**. That destroys the element you are dragging, so the browser has
nothing left to track the pointer against: the control jumps to wherever you
clicked and then stops dead. It reads as a styling problem and is a lifetime
problem.

There are two levels of update now. **`input`** fires continuously while you
drag and does the cheap thing — write the value, sync the paired number box,
refresh what depends on it *in place*. **`change`** fires once when you let go
and does the expensive thing, the redraw that recomputes the stat preview.

The EV meter's node is **kept and its contents swapped**, not replaced.
Replacing it would invalidate the handle on the first drag and leave every
later one updating a detached element — a bug that would look like "the meter
stops after the first change".

`verify_builder.mjs` pins it by identity: after a continuous `input`, the
slider node must be **the same object**. Mutation-tested by putting the redraw
back on `input`.

**IT IS THE SAME BUG IN FIVE PLACES, and fixing one did not fix the rest.**
The stat bars were fixed first; the **level slider** kept the redraw and kept
snapping, and the **move, item and ability searches** rebuilt their whole
picker on every keystroke — which recreates the `<input>`, drops focus and the
caret, and means typing "flame" takes five clicks back into the field.

The general rule: **an event that fires continuously must not rebuild the
element it fires on.** Redraw the LIST, never the box; redraw on `change`,
never on `input`. Each of the five is now mutation-tested individually, because
the fix is per-call-site and a shared invariant does not enforce itself.

The search assertions check two things, and the second matters: that the input
node survives, **and that the list still actually filters**. "Do not redraw" is
trivially satisfiable by doing nothing at all.

## The EV cap warned instead of blocking — eventually

The first version capped each stat at what was left, so you could not put 255
in all six. **That assertion was pinning behaviour which contradicted the app's
own rule.** The Factory writes abilities a species cannot legally have and
moves it cannot learn — flagged, never blocked — because Gen 5 reads those
bytes directly and building something illegal is a thing people come here to
do. An EV spread is the same kind of byte.

So the limit is stated and enforced by nobody: past 510 the meter turns red and
says the spread is impossible in a real game, and the value is still written.
A control that silently refuses your input is worse than one that tells you
what you have done.

**A NUZLOCKE RULE MAY TAKE IT AWAY.** `legal-spreads` caps the total at 510,
and it is the right shape for this: flagging stays the default, and a rule you
deliberately switched on is the one thing allowed to close it — exactly as
`no-editing` closes the editor. The cap belongs to the rule, not to the
control. It ships on Strict and Hardcore.

## Space, and where a control belongs

- **Shiny sits with the sprite.** It had a section of its own down among the
  number boxes, which put a property of the *picture* a long way from the
  picture.
- **Roles go across, not down.** Four chips stacked in a 168px column with the
  rest of the dialog empty beside them — they only stacked because the block
  was placed as an ordinary grid item rather than spanning the form.
- **IVs and EVs share one row.** Six labelled sliders in a narrow column left
  half the dialog empty, and the two are read together anyway: one is what you
  rolled, the other what you spent.
- **The IV column has its own meter**, and it earns its place twice: how far
  off perfect a spread is (186 is six 31s) is worth knowing, and it squares the
  two columns. They had sat side by side with the EV column taller by exactly
  one meter, and a ragged bottom on two things that are obviously a pair reads
  as a mistake rather than a choice.
- **`tb-meter` is the base class, `tb-evmeter` and `tb-ivmeter` the
  modifiers.** The IV meter first reused `tb-evmeter`, which it is not — and
  that made both the stylesheet and the test unable to tell the two apart.
- **Role and reason are LAST in the form.** They are what you conclude about a
  slot *after* speccing it — you cannot honestly say "this is the wall" before
  choosing its spread — and they had been sitting two prose fields between the
  species and the numbers. Same for a swap's badge and note, which describe a
  trade you have not made yet.
- **The copies you own are shut by default.** The panel already collapsed; it
  just opened by default, which put a list of your Butterfrees between the
  species picker and every other field, on every slot, for the one time in
  twenty anybody wanted it. It is an advanced path and now reads as one.
- **Shut is not GONE.** `display: none` on the whole panel hid the heading too,
  so the feature read as deleted rather than collapsed and nothing was left to
  say it existed. Only the rows fold away; the heading states how many copies
  you have and what opening it gets you.

**`tb-why` versus `tb-whyin`.** The slot card owns `tb-why` for the rendered
reason; the editor's input is a different thing that happens to hold the same
text. That is the fifth time the duplicate-selector check has caught this in
one project — the rule is to name the CONTROL, not the content.

## ONE set of controls, not two — `app/js/specform.js`

There were two editors for one record. The Team Builder's slot editor and the
Factory's edit/create sheet take the **same state** — species, nickname, level,
nature, ability, gender, shininess, held item, four moves, IVs, EVs — and they
had drifted badly: the Builder grew a nature chart, chip abilities and
searchable move and item pickers while the Factory still asked for a nature
from a 25-row dropdown and a move from a 559-row one. Neither had gender or a
nickname until the Builder got them, which is the drift showing from the other
side.

That is the failure the battle tab avoids by **hosting**
`sheet_template.html` rather than reimplementing it. So the controls live once,
in `specform.js`, and both editors compose them. The extraction removed **315
more lines than it added** while adding gender, nicknames and reordering.

**The prefix is `sf-`, not `tb-` or `fx-`.** A shared component wearing one
tab's prefix is a lie about where it lives, and the next person to change
`tb-natcell` would have no way to know the Factory renders it too.

**A control is a function of `(ctx)` returning an element**, where ctx carries
the state (mutated in place), `S`, per-dialog scratch, and `redraw()`. Two
habits every one of them keeps, both learned the hard way: never redraw on
`input`, and a picker closes once it has done its job and opens ready to type.

## Slot order is reorderable, and it is not cosmetic

It is the order the battle tab lists a team and the order `fieldCore()` writes
into the party, so it is what you lead with in game — and it was changeable
only by rebuilding a slot.

**Drag is not the only way in.** A drag is a poor fit for a touchscreen and
impossible without a pointer, so each card also carries two move buttons. Both
call the same `reorderSlots`, which returns a NEW array rather than splicing
in place: the caller holds a team other code may be reading, and an in-place
reorder during a render shows up as one card drawn twice.

## Cores claim first

A core is a line-up you have **settled** on; a team is still an experiment.
When both want the same Slowking the settled one gets it — otherwise a
scratchpad you were poking at last week quietly takes a Pokémon out of the
roster you actually play. Resolution order is not display order: the tabs come
back in the order they were merged in.

## The sheet publishes cores; the app also shows scratchpad teams

`build_sheet.adopted_cores()` says so in its name. `verify_blob` compares the
**cores**, which is what both sides claim to produce, and names the extras
rather than dropping them. It went unexercised for months because the store
held no living non-core team, and then surfaced as a bare "length 9 vs 10".

**Behind that length mismatch was a second, still-undecided divergence:** when
every copy of a species is already claimed, `build_sheet.take()` **reuses**
one (and prints "multiple copies"), while `matchSlot()` reports the slot
**missing**. Two Rain cores and one Floatzel is enough to hit it. It is listed
in `INTENTIONAL` with an explicit note that it is a question, not a decision —
whoever settles it should change one side, not add a second whitelist.

## Exporting a team — `app/js/showdown.js`

A team you cannot hand to anybody stays in one browser. The paste format is the
lingua franca: what Showdown imports, what every damage calculator accepts, and
what people put in a comment.

**It does not translate, and it says so in the paste itself.** This hack moved
base stats for 138 species, typings for 18 and abilities for 487, so a paste of
a Blaze Black Arcanine with Contrary describes *this* game's Arcanine and will
produce numbers for a different Pokémon in a modern calculator. The header
names the hack in `#` comment lines, which Showdown's importer ignores — so it
costs the recipient nothing and is the only place they could possibly learn it.

Rules of the format that each bit some implementation somewhere, all pinned:

- A nickname goes in front with the species in brackets; **with no nickname the
  species stands alone** — `Arcanine (Arcanine)` reads as a bug.
- Gender is `(M)`/`(F)` and is **omitted for a genderless species**.
- The `EVs:` and `IVs:` lines are **omitted entirely** when there is nothing to
  say; a bare `EVs:` does not parse.
- IVs list only what is **not 31**. A Trick Room build's whole line is
  `IVs: 0 Spe`.
- `Level: 100` is the default and is left out.
- **Only each slot's primary option.** The alternates are a swap tree; pasting
  them would make a nineteen-Pokémon team nothing can import.

**It is SHOWN, not silently copied.** A button that puts something on your
clipboard and announces success gives you no way to check what it took — and
this text carries a header you would want to read before pasting it somewhere
public. Copying is offered and falls back to selecting the text, because
`navigator.clipboard` needs a secure context and this app is also meant to run
from a `file://` page.

**Export is on the BATTLE tab too**, and that is where it is actually wanted:
you have just run a line-up against a gym leader, it worked, and you want to
send it. Making you switch to a builder to export the thing already on screen
is the friction that means a feature never gets used. Added from *outside* the
template like the edit and field controls, because `sheet_template.html` is
also the published artifact — static, with no team store and no clipboard.

It exports the **specs from the store**, not the rendered mons, so the paste
carries IVs, EVs and natures. The sheet's mon shape has final stats and no
spread; a paste built from it would be missing exactly the lines a recipient
needs. For a tab with no stored team behind it — the live party — it falls back
to what is on screen and **says in the paste that the spread is missing**,
rather than emitting something that looks complete.

**Export is separated from the two consequential buttons.** "Save as core"
commits a line-up and "Delete team" destroys one; Export only reads. Flush
against them it read as a third button of the same weight, with the
destructive one at the end of the row.

**Two buttons called "Export".** The teams bar already had one — every team as
JSON, for keeping — and the new one is a single team as a paste, for sending to
a person. Two identical labels a few centimetres apart is a coin toss; the test
picked the wrong one first time too. The bar's is **"Back up all"** now.

## Teams are a scratchpad; cores are what you adopted

His model, and the one the tab is built around: **you experiment in the
builder, and promote a line-up to a CORE once it settles.** Cores are the ones
you come back to.

That asymmetry is deliberate in the UI:

- A team is deleted with one button.
- A core has **no delete**. The only way to remove one is **"Move back to
  builder"**, which hands the line-up back as an editable team and retires the
  core. The extra step *is* the friction a settled thing should have, and you
  can never lose a line-up by accident — retiring gives it back.
- **"Field it"** puts a core's members into the party in one go, because
  moving six Pokémon through the in-game PC one at a time is miserable. Only
  members you actually own can be fielded; it says how many it found first.

Seeding offers **your party and your cores** — and the shipped rosters are
among the cores, because that is what they now are. They used to be a third
category listed as "built in", copyable and fieldable but never retirable,
which said they were a different kind of thing when they were not: Kaiju and
Sun King are line-ups that settled long ago, which is the definition of a core.
`layoutToTeam()` carries the **whole slot** across at adoption, alternates
included, so Kaiju arrives with its swap tree rather than six bare species.

What seeding does **not** list is the first six of every box — two dozen rows
nobody was ever going to pick.

**Your live party is always a battle tab**, synthesised from the save every
time and needing no setup at all. Someone may never touch teams or cores and
just want to see how what they are carrying holds up against the next gym;
that case should cost nothing. It routes through the same conversion as any
other team, so the damage calc, coverage warnings and weather detection all
apply. Id `live-party`, and it is first among the added tabs.

**Cores DO appear as battle tabs**, alongside teams. They were excluded at
first, on the theory that a core was an ingredient — backwards. A core is the
line-up you *adopted*, so it is exactly the one you want to check against a
gym. Promotion moves rather than copies, so nothing shows up twice; core tabs
get `core-` ids and are labelled `core · …`.

**Promoting a team to a core MOVES it.** Leaving a copy behind meant you could
not tell whether the original was safe to delete, and two things claiming the
same Pokémon. `coreFromTeam()` keeps slots whole — swaps, roles and reasons —
and "Move back to builder" restores all of it.

## Generated team names must not creep

`Team ${teams.length + 1}` counted **tombstones and cores**, so the number
climbed forever as teams were made and deleted — twelve cycles reached
"Team 13". `nextTeamName()` fills the first free gap among *living teams*, and
`pruneTombstones()` drops tombstones older than 30 days so the store cannot
grow without bound. Duplicate names are fine: everything downstream keys on
`id`, and the battle sheet builds its tab index with `byId`.

## Deletion is a TOMBSTONE, never a removal

Two stores means a delete has to be a *fact that travels*. Dropping a team
from `localStorage` left the repo copy alive and the next `merge()` brought it
straight back — that is exactly what "I deleted it and it reappeared when I
switched tabs" was. `tombstone()` replaces the record with `{deleted}`,
`living()` filters them, and the Builder pushes the tombstone to the repo too.
Never "fix" this by filtering the array.

## "Reload save" cannot show you what the emulator has not written

`GET /api/save` is read-only and safe mid-session, but **melonDS only writes
the `.sav` when you save in game.** Re-reading while playing returns identical
bytes, which looks like a broken button. The reload now re-fetches
`/api/config` (freshness is point-in-time), warns if it would discard staged
edits, and reports which happened — "identical to what was already loaded …
last written 2026-08-23 14:23 UTC" versus "Reloaded — 274 Pokémon".

## Fielding a team is a REPLACEMENT

`Factory.fieldParty(list)` puts exactly that line-up in the party and sends
whoever is there now to a box.

It used to call `moveMany()`, which **inserts** — it lifted six out of their
boxes and dropped them in alongside whoever was already there, so "Field it"
failed with *"Party holds 6. It already has 6, and 6 more will not fit"* the
moment your party was full, which is always. The confirm dialog had been
promising a replacement the whole time.

Three things it has to get right, all pinned:

- A member **already in the party stays put** rather than being evicted and
  re-added, so fielding a core that overlaps your party is not a shuffle.
- Every displaced Pokémon's destination is found **before anything moves**.
  Running out of box space halfway would leave the save in a state nobody asked
  for; instead it refuses and says so.
- One snapshot, so the whole thing is a single undo.

**"Field it" is on the battle tab too**, in the team header — the last step of
the loop the app is for: read the fight, pick the roster, field it, install,
reboot. It is app-side like the editor (the artifact has no save to write) and
renders into `#fieldslot`, an empty span the template leaves in the header, so
`build_sheet.py` is unchanged. It is hidden for the team already in your party
and for one whose members are not in the save, and it re-draws on every click
because the template re-renders on tab and swap changes.

## Team tags in nicknames — NO LONGER MAINTAINED

Every Pokémon on a team used to carry a one-letter tag in its nickname
(`K Gengar`, `R Politoed`). **You do not need to keep doing this.** The reason
they existed was human — telling four Arcanines apart in the PC — and the
Factory's search, its detail rail, "Find a Pokémon" and the Team Builder's
owned/close/missing matcher all answer that now, without a naming convention to
maintain. The tag chips are gone from the battle companion's tab strip and team
header, and so is the derived legend in the Reference zone.

**ONE THING STILL READS THEM: the one-time adoption of the shipped rosters.**
A `TEAM_LAYOUT` slot names only a SPECIES, and with four Arcanines in the save
there is nothing else to go on, so `seedBuiltins()` passes the team's tag to
`layoutToTeam()` when it turns those rosters into cores. After that the cores
carry full specs and nothing matches on a tag again.

So: tags are a **hint the seeder uses once**, harmless when absent, and not
worth maintaining afterwards. Builder teams and cores never needed them — a slot
there is a full spec, so `matchSlot()` disambiguates on level, nature, ability,
moves and item. `tag_and_dex.py` still exists if you ever want to re-apply them;
nothing requires you to.


---

## Suggesting a slot — taste is a constraint, not a weighting (2026-09-02)

Pinned by `tools/verify_suggest.mjs`. Model: `app/js/suggest.js`; UI: the
**Suggest** action on every slot card.

The obvious design is a score — rank every species by `w·features`, with `w`
tuned to the player. **The teams in this repo are the proof that it is wrong.**
Edgelord, My Uncle Works at Nintendo, Contrary Engine, Sun King: there is no
setting of weights over power features under which Superpower-spam is optimal.
Those teams are not points on a power/preference tradeoff, they are
**premises** — everything must have Contrary; everything must be Dark; nothing
legendary; only things I caught myself.

So three parts, and **the least trustworthy one is given the least to do**:

| | job | source |
|---|---|---|
| **Premise** | filters the candidates | inferred from the slots already filled, and **shown as chips you can switch off** |
| **Power** | ranks within the filter | types, real stats and Speed against the fights you have not cleared |
| **Preference** | breaks ties | **not fitted.** See below |

### Why the preference model is not built yet

Measured before building anything: `state/teams.json` holds **41 slots that
offer a real choice, at a mean choice-set size of 2.5** — about 41 observations
for a model with ten features, which is not enough to fit anything worth
trusting. It also holds **80 written notes and reasons**, which is twice the
signal and already labelled. So the fitted model is last in the queue, not
first, and the prose is where the next work goes.

### Why this does not call the battle tab's search

The Markov search would give a better power number and **cannot be imported**:
the template stays standalone because the published artifact has no modules.
Porting it would make two implementations of one question. The answer is to ask
a *coarser* question instead — choosing a team member is not choosing a move —
so this is types, real stats and Speed, with no damage formula and no third
copy of one. The panel says so, and points at the battle tab.

### Four things that were wrong before they were right

- **Type-only scoring put Wingull and Luvdisc at the top of a rain team.** A
  type chart says what a hit is multiplied BY, never what there was to
  multiply. Each side now gets a pressure ratio: best offensive stat over the
  defence that would receive it, times the multiplier. Pinned by asserting a
  species outranks the one it evolves from — *and* at the matchup itself,
  because the score alone can be satisfied by Speed.
- **Catch rate does not identify legendaries.** Metagross is rate 3 and
  ordinary; Zekrom is 45 and not. What works is **egg group 15 (Undiscovered)
  plus BST >= 570**: 46 species, lowest kept 580, highest dropped 520. The
  group alone sweeps in the babies and the Nidoran line.
- **Ability 0 is `--`, and it is not something to share.** Four specs with no
  ability chosen all "carried" `--`, the gimmick premise fired on it, and the
  filter then asked for species listing `--` — which is none. **Zero
  suggestions from a premise nobody has.** The assertion that should have
  caught it only checked for a *monotype* premise, and passed.
- **Story order is the wrong default when nothing is ticked cleared.** It hands
  a level-50 team the first rival, every candidate beats all five, and every
  card reads *"threatens 5 of the 5, outruns 5 of them"*. With no progress
  marked it now picks the fights nearest the team's own level.

### It says when it has nothing to say

With fewer than two other slots filled, every type is uncovered, so every
candidate earns every coverage reason and five cards read identically — the
suggester loudly confident about a team it cannot see. Below that threshold the
coverage half is dropped and the panel says it is ranking on the rosters alone.

### The cost is the half that makes it a suggestion

A row carrying only a number is a thing to trust or ignore; a row that says
what it adds **and what it gives up** is a thing to think with. That is the
idiom the swap tree already uses. Two kinds, and only the second proves the
with/without diff runs: *"3 of them hit it hard"* falls out of the matchup,
while *"no one left resists bug"* needs `soleContribution`.
