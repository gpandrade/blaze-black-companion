# The battle companion and the published team sheet

Internals of `sheet_template.html` and the data `build_sheet.py` feeds it.
Pinned by `verify_sheet.js` and `tools/verify_app.mjs`.

This is the archaeology — why the code is shaped the way it is, and which
mistakes shaped it. Read it before changing anything it describes; most of
what looks arbitrary here is load-bearing, and the note says which bug made
it so.

---

## Stat-stage boosts — a what-if layer, read from the ROM

Each roster slot offers a button for every stat-changing move that Pokémon
actually knows. Clicking applies it, clicking again stacks it, clicking past
its cap clears it. Everything on the tab recomputes.

- **Where they apply.** `statMul()` is the single choke point for our side's
  stats, so damage, speed order, the bars and the matrices all pick boosts up
  without knowing they exist. The defending side is built from base stats
  inside `calcDamage()`, so *foe* stages are applied there instead.
- **Where they come from.** The ROM's move entry, not memory:
  byte 20 target (`0x07` = the user), bytes 21/22 stat ids, bytes 24/25 signed
  stage deltas, bytes 16-17 a u16 effect id for the three that bake it in
  (Belly Drum, Shell Smash, Curse). `move_stages()` in `build_sheet.py`.
- **Only CERTAIN changes are offered.** Byte 20 is the *move's* target, not the
  stat change's — Close Combat reads "foe" at face value when the drop lands on
  the user, so guaranteed self-drops go through `SELF_DROP_EFFECTS` instead.
  Damaging moves with a *percentage chance* to drop a stat (Crunch, Aurora
  Beam) are excluded outright rather than presenting a maybe as a fact.
- **Not persisted, deliberately.** A boost is a hypothetical about one turn,
  not a preference. A banner names who is boosted whenever any is on, because
  otherwise the numbers move with nothing to explain why.

Accuracy and evasion stages are shown greyed: they are applied, but the damage
numbers do not model accuracy, and a chip that implied otherwise would lie.

## What the page does

Four numbered zones: **01 Roster & swaps** (click a swap card to field it,
every number below recomputes) · **02 Combat reference** (opponent lookup by
name or type, battle-condition toggles, per-type ranking, damage matrix, turn
order) · **03 Known opponents** (32 encounters in story order with a
singles/doubles matchup planner) · **04 Reference**.

`MECH` in the template defines rain / sun / sand / Trick Room. Toggling one
rewrites offensive multipliers and the turn order everywhere on the tab. A
team opts in via `mech=[...]` in `TEAM_LAYOUT`.

## Opponent data

Parsed from `docs/Important Trainer Rosters.txt` in document order, which is
game order. Rematch blocks are dropped by the `replaces` marker in their
location. **Gym rosters are exact; rival rosters are not** — their tables wrap
across lines with per-starter variants, so those entries show the documented
pool and say so on the page. The Elite Four still do not parse.

**Version-gated fights are DROPPED too.** `VERSION = 'black'` sits beside
`STARTER` in `build_sheet.py`. Drayano documents both Opelucid leaders in one
file and tags their location `"Opelucid Gym, Black"` / `", White"`; only one is
in your cartridge, so the other is removed. The old test was one-directional
(`'white' in loc`) and could only ever hide Iris; it reads the tag and compares
now, so a Volt White run drops Drayden instead. **The gym count is eight, not
nine.**

A permanently disabled card is a puzzle to solve rather than a fight to plan
against, and it makes every total on the page wrong by one. But dropping
silently would leave a reader wondering where Iris went — so `gates()` emits
the two forks as prose and the Reference zone renders them: what your starter
decides, what your version decides, and why they are removed rather than
greyed. It is in both blobs (`GATES`).

Note the indices shifted: `bb_cleared` and `bb_enc` key on position in
`OPPONENTS`, so anything ticked off **after** Iris (old index 23) moved down by
one. Nothing before her changed.

**The other starters' lines are DROPPED, not greyed.** Cheren's documented
table wraps all three starter lines into one block, so his roster rendered as
nine Pokémon with three shaded out — a puzzle to solve rather than a team to
plan against, when he is only ever going to face one line. `build_sheet.py`
filters against `STARTER_LINES[keep]`; Cheren 4 is five Pokémon, not nine.

## The starter fork — a SETTING, not a constant

**He picked Oshawott**, which is still the default in `build_sheet.py`
(`STARTER`) because the published artifact is static and has to bake one in.
For the app it is a setting, and that was a real defect until 2026-08-29:
`STARTER` was a module constant, so **two players in three opened the app and
were planned against a gym leader they will never meet**, with rival rosters
they will never see. Nothing on the page said so, because everything on the
page was internally consistent.

**IT CANNOT BE A TAG, WHICH IS WHY IT LOOKS DIFFERENT FROM THE VERSION FORK.**
The version fork decides whether a fight *exists* — one Opelucid leader or the
other — so one list carries both, each tagged `ver`, and the app filters. The
starter fork changes what is *inside* a fight: Cheren brings a different six.
So `build_static.py` runs `parse_trainers()` three times and exports
`OPPONENTS` keyed by starter, the way `GATES` is keyed by version.

**THE THREE ROSTERS ARE INDEX-ALIGNED, AND THAT IS LOAD-BEARING.**
`AREAINDEX[].opponents` and the sheet's saved encounter both store a
*position*, so misalignment would silently point every area at the wrong
trainer — and every neighbour is a plausible fight, so nothing would look
wrong. Each list keeps exactly one Striaton leader and each rival keeps its
slot, so all three are 36 long and only slot 5 names a different fight.
`verify_adventure.mjs` asserts the alignment, asserts that exactly one slot
forks, and asserts the fork *changes the answer* — including that the rivals
bring different teams, not just different names.

**Do not check alignment on `loc`.** Drayano's own file spells Cilan's block
`Striation Gym` and the other two `Striaton Gym`, so a string compare there
fails on his typo rather than on drift. `kind` is the stable field.

### Crossing tabs needs a KEY, not an index

Adventure holds the **complete** roster (both Opelucid leaders, because
`AREAINDEX` indexes into it); the battle tab has already dropped the one that
is not in your cartridge. Two lists of different lengths, and `planFight()`
handed an **index** across — so "Plan this fight" opened the wrong trainer for
everything after Opelucid: **Cheren 7 landed on Shauntal**. It passes
`opp.key` now and the template resolves it, the same stable-slug rule
`bb_cleared` already followed. Pinned in `verify_adventure.mjs`, on both
halves.

## Rival rosters come from the ROM, not the doc

Five late rival fights rendered as **eight Pokémon**. `docs/Important Trainer
Rosters.txt` stacks the three per-starter variants **inside single table
cells**, and the RTF conversion renders those as bare newlines —
indistinguishable from an ordinary cell break. So a block that is really 3
fixed Pokémon plus 3 slots × 3 variants parsed as nine loose species.

**Filtering by `STARTER_LINES` cannot fix it, and was wrong in a way nobody
would have noticed.** The old single list put the monkey in with the starter,
so `Serperior` and `Simisage` both looked like the grass line — but the ROM
says a Serperior Cheren carries **Simipour**. A rival's monkey is the line
**their own starter beats**, which the doc states nowhere. `STARTER_LINES` and
`MONKEY_LINES` are separate now, and only the starter line identifies a
variant.

`a/0/9/3` has each variant as its own trainer entry, so `rom_variant()` matches
on **(name, top level, subset of the doc's own pool)** — unique for every
rival block in the file — and takes the species and the exact per-Pokémon
levels from there. The doc still supplies items, abilities and moves. All 14
rival fights are now exact and none is flagged `approx`.

Two things that make the match safe: the top level has to be read from **every
`Level` row in the block**, since `rows` keeps only the first and the starter
sits on the second; and it returns `None` rather than guessing when the match
is not unique, because a silently mismatched roster would carry the ROM's
authority while being about a different battle.

**A gym file holds TWO tables**, and only the first is a trainer list. The
second is the important trainer transposed — one row per Pokémon, first cell a
sprite — and counting those rows made Nacrene Gym report **ten** trainers when
it has four, and the Pokémon League forty-two when it has six. A trainer row
is a person, so its name is never an image.

## Contrary and Simple rewrite the move

`stagesOf()` applies them where the stage deltas are read. This was a wrong
answer, not a missing nicety: a **Contrary Arcanine with V-create** (ROM:
Spe −1, Def −1) had the drop applied literally, so two clicks put it at ×0.5
speed and three at ×0.4 — and the turn order flipped from "you first" to
"them first" as the boost was stacked **up**. The sheet named the ability in
`statNote()` prose and then ignored it in every number on the page.

- Only the **self** side is inverted. Contrary changes what happens to its own
  holder; a foe-targeting drop we inflict is unaffected by our ability.
- **Simple doubles**, so it also halves the click cap. `bMax` therefore needs
  the Pokémon, not just the move — and the click handler only has the key, so
  `boostRow()` puts the cap on the button as `data-bmax`.
- The **tooltip must quote the effective direction**. A button reading
  "Spe −1" while the page gets faster is worse than no tooltip.
- The regression was non-monotonic speed, so `verify_sheet.js` asserts
  monotonicity rather than a single value.

## Both sides get their abilities

The tab exists to say how YOUR team does against THEM, which it cannot do while
their abilities are ignored. `abilMul()` is the ability-and-weather half of
`statMul()`, split out so it can be applied to the opponent too:

- **The defender's Def/SpD** now goes through it in `calcDamage()`. Their
  nature, IVs and EVs remain the stated assumption (neutral / 31 / 0); their
  ability is not an assumption, it is in the roster.
- **`enemySpe()`** applies it, so a Swift Swim opponent is faster in the rain
  rather than listed as slower than you.
- **Stat stages stay out of `abilMul`** — those are the what-if layer and belong
  to your side only.

**Trick Room now flips the matchup line's turn-order verdict.** The speed ladder
already knew; `matchLine()` did not, so the one team the mechanic exists for was
being told it moved second.

Natures need no folding anywhere: `read_live()` runs `compute_stats` with the
nature, so every figure the sheet derives from `m.stats` already has it. The
nature marks are presentation only.

**Exploring "with vs without" is the other tabs' job**, and both do it: the
Factory's editor and the Builder's slot editor each offer every ability (illegal
ones flagged, never blocked) and every nature. The Builder's stat spread used to
stop short of applying the nature — so the one tab you use to try "what if this
were Adamant" showed a figure that did not move — and now uses `specStats()`,
which is checked against the Factory's own computation for every Pokémon in the
save.

## The free-form calculator — and why it is in the TEMPLATE

Every damage number on this page is against a **documented** fight: a gym
leader, a rival, one of the trainers in Drayano's own file. That answers "am I
ready for what is next" and says nothing about the Pokémon you just walked into
on a route, or the what-if you are turning over.

**It lives in `sheet_template.html`, not in a tab of its own, because
`calcDamage` does.** The Gen 5 formula, the type chart, both sides' abilities,
the item multipliers, the weather toggles and the stat-stage what-ifs are all
here. A calculator anywhere else would be a second implementation of every one
of them — the drift this project spends most of its tests preventing. Hosting
it here also means the **published artifact gets it for free**.

It sits in **02 Combat reference**, under the opponent lookup, because it
answers the same question — *what about THIS one* — with numbers rather than a
switch-in ranking.

**THE DEFENDER USES THE PAGE'S STANDING ASSUMPTION** — 31 IVs, 0 EVs, neutral
nature — exactly as every other opponent on the page is built. A calculator
that quietly used a different one would disagree with the card above it. The
attacker is real: your own stats, from the save. The panel says so rather than
leaving it to be discovered.

**The level is clamped, never trusted.** A level-0 defender divides by zero
further down the formula.

**Typing the defender's name does not redraw per keystroke** — it redraws once
the name *matches something*, which is also the only moment there is anything
new to show. Same rule as everywhere else: a rebuild would recreate the
`<input>` and drop the caret.

### The assertion that matters is agreement, not rendering

`verify_sheet.js` computes a range with `calcDamage` directly and requires the
panel's damage cell to be **that exact string**. If it ever diverges, the
calculator has grown maths of its own.

**Two versions of that check were worthless and the mutation test found both.**
The first used `html.includes(range)` — four moves often share a range, so it
matched a different row. The second scoped to the move's row and still passed,
because **`hpBar()` puts the same range in its own `title` attribute**. Only
extracting the `<td class="num">` cells actually fails when the column is
changed underneath it.

## Field effects — a reference tab that answers "can I do this"

Weather, rooms, screens, hazards and Tailwind/Gravity, in `FIELD` in
`build_sheet.py`. Gen 5 values, and several are not what people remember — most
importantly **weather set by an ability is permanent here**, which Gen 6 put on
a five-turn clock and which is the reason half the teams on this page exist.

**Every move and ability it names is checked against the ROM at build time** and
raises if absent, the same discipline `SPECIAL_STAGES` uses. Durations and
fractions are written out, because the ROM's move table carries power, accuracy
and PP and nothing about duration.

`who` — which of YOUR Pokémon can set each — is what makes it more than a wiki
page. It is computed at build time for the artifact and **in `roster.js` for the
app**, because `build_static.py` has no save to look in.

## Editing a team's prose — `app/js/teamedit.js`

The shipped rosters carry writing a Builder team never could: a tagline, a row
of **labelled pilot cards** (Kaiju's LEAD / SPEED / WIN CON / SETUP / PANIC), a
per-slot line saying what the slot is *for*, and a warning naming what the team
actually loses to. A Builder team got a computed warning and, at best, its
free-text `notes` split into cards labelled "Note 1", "Note 2" — which is why
your own cores never read like the shipped ones.

**Pilot cards are structured now**: `pilot: [{k, v}]` and `warnNote` on the
team record, edited from an "Edit this team" button on the battle tab.

- **It is NOT in the template.** `sheet_template.html` is the published
  artifact as well as the battle tab, and the artifact is static — no team
  store, no server, no reason to offer an editor. The control is added from
  outside, exactly the way `battle.js` already restyles the masthead and
  retitles the `<h1>`. `build_sheet.py` still renders the artifact unchanged.
- **It edits prose only.** Species, moves, abilities, natures and items belong
  to the Team Builder and the Factory, which already do that properly against
  the save. `verify_teamedit.mjs` asserts the specs are **byte-identical**
  after a save — this editor sits beside two that write real Pokémon, so
  "prose only" is a contract, not an intention.
- **Migration keeps everyone's writing.** A team with no `pilot` still splits
  its notes exactly as before, and still gets the computed warning. A written
  warning *replaces* the computed one rather than joining it: if you have said
  what the team loses to, that beats "Ground hits half your team", and showing
  both buries yours.
- **Every tab is editable now but one.** The shipped rosters used to be
  Python-side, so the only honest offer for Kaiju was a copy; they are adopted
  as cores on first run, so the store owns them and the editor writes straight
  to them. The one exception is **your live party**, synthesised from the save
  at every mount — there is no record behind it to write to, so it still offers
  the copy, routed through `teamFromMons()`.
- **`LAYOUT` exports pilot cards as PAIRS, the sheet uses `{k,v}`.**
  `build_sheet.py` converts for its own blob; `build_static.py` exports raw.
  `layoutToTeam()` reads both — reading one silently produced blank cards.

**Which team is on screen** is read from `bb_taborder`, not the DOM. The
template rebuilds its tab strip on every click and puts no id on the buttons,
so there is nothing to read back; `activeTeamId()` mirrors the template's own
`orderedTeams()` through that key, which is the only way the two cannot drift.

**ONE IMPLEMENTATION, TWO PLACEMENTS.** `proseFields()` is the shared block.
The battle tab wraps it in a modal with Save and Cancel, because you are not in
an editing context there and a dialog says "this is a detour". The Team Builder
embeds it **inline, under the team's own name and tagline**, in a closed
`Advanced` disclosure that opens automatically when the team already has any of
this writing — and it edits live, with no Save button, because every other
field up there already does.

It was a "Notes & pilot cards" button in the actions row next to *Save as core*
and *Delete team*, which made an optional part of the team's description look
like a third destructive-ish verb and gave no hint what it opened.

**Your live party can be copied too.** `live-party` is synthesised from the save
every mount and has no `LAYOUT` entry, so the LAYOUT path told you it "cannot be
copied". It goes through `teamFromMons()` on the party instead.

**`layoutToTeam` takes the RAW `S.LAYOUT` entry, never a converted battle
team.** A slot option in `TEAM_LAYOUT` is the list `["Gengar", badge, note,
rigged]`; `blob.TEAMS` has already turned those into `{mon, badge, note}`
objects. Passing the converted shape **threw** inside a click handler, which
is invisible — it is exactly what *"copy into the Team Builder just fizzles
out"* was. It now skips a non-array option, so a wrong caller yields an empty
team the caller already checks for instead of a silent crash.

## Sprite grids are FIXED columns, not wrapping flex

Both the encounter cards and Adventure's "who is here" strip lay their team out
as `repeat(6, …)`. A wrapping flex row left every card's team hugging the left
of a card it never filled, and gave no sense of scale between a two-Pokémon
card and a six-Pokémon one. Two details that took a second pass:

- **Fixed columns, not fractions.** `repeat(6, 1fr)` on a 1000px card gives
  180px cells holding an 88px sprite, so five Pokémon read as five islands.
  `repeat(6, minmax(0, 92px))` with `justify-content: start` keeps a sprite the
  same size on every card whatever the card's width.
- **A trainer must not read smaller than their own Pokémon.** The portraits are
  sized above the team sprites on both surfaces.
- **A portrait TAGS the top-left of a card, so the text beside it top-aligns.**
  Centring left the name floating against the picture's middle, lining up with
  nothing.
- **Adventure's boss card is the exception that stretches.** Its cells are real
  cards with a name and a level in them, not bare sprites, so `1fr` columns are
  content rather than padding — and a four-Pokémon fight filling the same width
  as a six-Pokémon one stops the shorter rosters reading as scraps against the
  left edge.

**The "Levels, abilities and moves" reveal is gone.** It swapped the sprite
strip for a nearly identical grid whose only new information was the level,
while ability, item and moves stayed in a tooltip either way. A control that
hides a number you could just show is friction wearing a spoiler policy's
clothes — and the real spoiler line moved long ago, when the sprites came up
front. The grid IS the strip now, named and levelled by default.

`.oppline` was **already** a centred flex row; adding a second `.oppline` rule
to "fix" the alignment only clobbered its gap. `verify_sheet.js` now has the
duplicate-selector check `verify_app.mjs` has had for `app/css` since two
`.tb-note` rules fought — the sheet needs it *more*, because its stylesheet is
injected app-wide at boot, so a duplicate there reaches every tab. It compares
**values**, not just property names: two rules setting the same property to the
same thing are dead weight, not a bug.

### The stub DOM has to be faithful, or it lies about your code

`verify_teamedit.mjs` failed three times on the stub rather than the module,
and each gap is one a future stub will hit:

| Missing | What it broke |
|---|---|
| `nodeType` | `el()` tells an element from a string with it, so every child got wrapped in a text node and the dialog rendered as flat text |
| `textContent = ''` clearing children | the card list redraws that way, so two clicks produced three cards |
| the `value` attribute seeding the `.value` property | every redrawn field read empty |

## The Reference zone carries no one playthrough's furniture

**Box name tags are DERIVED from the save, not listed.** It used to be a
hardcoded legend of one player's teams — "K Kaiju", "R Rain", "Box 1 is your
own caught Pokémon" — which is a fine thing to have and no business being baked
into a page anybody else can open. `tagLegend()` reads the leading letter off
the nicknames that actually have one, reports how many carry each and which
boxes they are in, names a tag where a team on the page declares it, ignores a
letter used only once, and renders **nothing at all** when there are no tags.
`TEAMTAGS` is gone from both blobs.

The rest of the zone was already fine: status conditions and the type chart are
generic; where-you-are-standing, your TMs and find-a-Pokémon are live from the
save. **"What this playthrough is gated on" is parameterised** by `STARTER` and
`VERSION` rather than written out — still a configured constant, so a Snivy
player has to change one line, which the tab itself says.

---

## The turn as a matrix game — built 2026-09-02

Pinned by `verify_sheet.js` (58 assertions). Code lives beside `calcDamage` in
`sheet_template.html`, so the published artifact and the app's battle tab get
it from one file — the same reasoning as the free-form calculator.

Everything else on this page answers *"how much damage does X do to Y"*. That
is a number you can only act on if you already know what the other side will
do, and **you do not**. A turn is simultaneous and the information is
imperfect: both trainers commit, then the moves resolve. So the honest object
is not a number, it is a payoff matrix.

Three things fall out of that, in order of worth:

1. **"Scald, Psyshock and Ice Beam are all safe."** A dominant strategy — at
   least as good as every alternative against everything they can do. *No
   calculator that reports one matchup at a time can tell you this*, and it is
   the single most useful sentence the page produces.
2. **"No safe move."** Your best guaranteed outcome and what it costs. This is
   the maximin, and it is worth saying out loud that **maximin is the
   nuzlocke's own objective function**: a nuzlocker is not maximising expected
   damage, they are maximising the worst case, because a loss is permanent.
   The mode already in this app wants exactly this number.
3. **The mix.** When there is no pure equilibrium, the equilibrium is a
   probability — and *"you have to guess, here is the split"* is a real answer
   rather than a shrug.

Nothing is learned and nothing is fitted. The same fight gives the same board
every time, offline, with no key.

### `calcIncoming` — the direction the page never had

`calcDamage()` has only ever gone from you to them, so **"what can they do to
me" has never been a number here** — only a type multiplier on the match line.
The new function is deliberately asymmetric, and the asymmetry is the point:
**their** attack stat is estimated from base stats at the page's standing
31/0/neutral assumption; **your** defence and HP are real, out of the save,
with your stat stages and abilities applied. It is useful well beyond this
board.

### The modelling decisions, and why each is pinned

- **A speed tie goes to THEM.** This board exists to report a worst case, and
  a coin flip resolved in your favour is not one.
- **Priority beats speed**, and a switch always resolves before an attack.
- **A knockout you land first costs you nothing** — payoff exactly `+1`. That
  short-circuit is what makes turn order change the payoff rather than the
  flavour.
- **Every payoff stays inside `[-1, +1]`**, because the legend under the board
  says −100…+100 and a value outside that range would make the sentence and
  the colour scale both lie.
- **Switching can never score as a gain.** It is priced only by the hit the
  incoming Pokémon takes; what it buys arrives next turn, which a one-turn
  board cannot see. Said out loud in the footnote rather than fudged.
- **A fight with no documented moves gets no board**, and says why. Every gym
  leader, Elite Four member, champion and Plasma fight documents moves (107 of
  181 opponent Pokémon); most route rivals do not, because those rosters come
  from the ROM's trainer table rather than Drayano's doc. Inventing a board
  from an empty move list would be the worst failure this feature could have.

### The solver, and the test that cannot be faked

Zero-sum by linear programming: shift every payoff positive, solve the column
player's `max 1'z  s.t.  Bz ≤ 1, z ≥ 0` by simplex, and read the row player's
strategy off **the dual** — the objective row under the slack columns at
optimality. Value is `1/(1'z)`, shifted back. Every `b_i` is 1 so the origin is
feasible and no phase 1 is needed.

It is checked against games whose answers exist independently of this code
(rock-paper-scissors is uniform at value 0 whatever anybody's simplex says),
and — the check that matters — against **the duality condition**: the value
must simultaneously equal `min_j (x·A[:,j])` and `max_i (A[i,:]·y)`. A solver
returning a plausible-looking mix fails that instantly. Replacing the dual
read-off with a uniform mix breaks **six** assertions.

Six mutants, six caught: the dual read-off, the speed tie, the KO
short-circuit, crediting a switch with damage, sizing incoming damage off the
wrong HP, and losing weak dominance from the dominance test.

### Two things the render caught that no assertion did

- **Several rows tie for dominance** — three moves that all one-shot are all
  equally safe. The first version named one of them, which is true and reads
  as a claim that the other two are worse. All of them are named now.
- **`ico()` and `spr()` are sized for the roster cards.** Left alone inside a
  dense matrix they made the row-header column wider than the whole board and
  pushed the `worst` column — the one the verdict is read from — off the right
  edge. And `.gnote` wore `.lbl`, the mono-caps *kicker* idiom, which turned
  two paragraphs of prose into a wall of tracked capitals.

## The defender's ability list is the species', not the game's

In *Damage against anything*, naming a defender and then scrolling all 165
abilities to find one of its two is a search through noise — and the answer is
a property of the species that the ROM already knows. `DEX` carries an `a`
field now: both ability slots plus the hidden one, de-duplicated, from this
hack's own personal table. That is also how **Slowking offers Drizzle**, a
Blaze Black change a vanilla-shaped list would bury.

Three details that make it safe rather than merely shorter:

- **The full list is one click away, not gone.** This page models rigged
  Pokémon elsewhere, and an opponent with an ability it cannot legally have is
  a thing you might genuinely be facing.
- **A choice already made survives the narrowing**, marked *(not natural)* —
  otherwise the field would silently reset the moment the list shrank.
- **Changing species drops an ability the new one cannot have.** Keeping it
  would quietly model a Garchomp with Regenerator, which is the sort of wrong
  answer that looks like a right one.

`DEX.a` is built in **both** `build_sheet.py` and `build_static.py`, because
`verify_blob.py` diffs them — and the first version read `v['hidden']` when
`personal.json` calls it `hidden_ability`, so the hidden ability was silently
missing from all 649. Caught by asserting that *some* species has three, which
is the kind of check that only looks redundant until it fires: **201 do**.

## The threat board — promoted and rebuilt (2026-09-02)

Gab's most-used reference in the tab, so it moved **above** "Most useful in
this fight" and "Your move": you arrive at a fight wanting to know what you are
facing, and the other two are what you do about it.

**It computed `worstIn` and threw it away.** A type multiplier against your
whole team, calculated every render and never rendered — so a *threat* board
said nothing about the threat, only about your answer. It is a **duel card**
now, read top to bottom in the order the turn happens:

```
you bring   Slowking · Psyshock    279–328%  1HKO
            ▼ it moves first
it answers  Megahorn into Slowking  27–32%   4HKO
```

The second half is priced **against the very Pokémon the card just told you to
bring** — if you bring Slowking, this is what Slowking takes. That needed
`calcIncoming()`, which did not exist when this board was written; it arrived
with the matrix game and this is its second customer.

The verdict ladder distinguishes the two very different bad outcomes — *it
kills you first* / *it can kill back* versus *slow to kill* — and sorts worst
first, because the card you have to think about is the one you should see.

**A roster with no documented moves falls back to the type read and says so.**
Rivals and N come from the ROM's trainer table rather than Drayano's doc, and
inventing a number there would be worse than the multiplier it used to show.

Three layout notes. At 236px the names cropped to *"Scoli…"* and the metadata
broke one word per line, which is the shape of a layout sized for less content
— cards are 300px now. The verdict left the header row for a full-width band,
because it was the thing competing with the name for space. And **the column
count divides the roster**: `auto-fill` packs as many as fit, which for the
usual six meant **four on the first row and two stranded on the second** — the
worst split available, and the first thing you see. Six reads 3+3, four reads
2+2, and five is 3+2, which is the least bad a prime allows.

**It sits below "Most useful in this fight", not above it.** The first pass
promoted it to the top of the tab; that was one step too far. "Most useful"
answers a question the threat board raises, so it reads first, and the turn
planner is what you do once both are settled: *your six -> who to bring -> what
you are facing -> the turn -> speed -> detail*. Pinned as an order, so a later
insertion cannot quietly land in the middle of it.

Five mutants, five caught. Two needed the assertion sharpened first: dropping
turn order renders `speed ?`, which my check accepted as "states who moves
first"; and the ordering check was vacuous against an early gym this team
sweeps, so it sweeps for a fight whose cards are **not all the same verdict**.

### Depth — the battle as a Markov game (2026-09-02)

The one-turn board had a tell: **a switch could never score positive.** That
was not a bug, it was the horizon. Over a single turn a switch deals nothing
and takes a hit, so its payoff is ≤ 0 *by construction* — and everything that
makes switching correct lives exactly one ply past where the board could see.
The same argument applies to a setup move.

So the board is now the base case of a recursion rather than the whole model.
The object is a two-player zero-sum **Markov game**, and the solution is
Shapley's: the value of a state is the value of a matrix game whose entries are
the values of the successor states.

```
V(S, d) = leaf(S)                              if d = 0 or S is over
        = gameValue([ V(step(S,a,b), d-1) ])   otherwise
```

The old board is `V(S, 1)`. Everything else is that sentence made runnable.

**It works, and the number to remember is this:** the best switch on a real
board goes from **−0.004 at one turn to +0.660 at two**, and across a sweep of
every documented fight, **24 of 153 matchups change their recommendation** with
one turn of foresight — including *Kingdra vs Masquerain: "Draco Meteor" →
"switch to Slowking"*, which is exactly the complaint that prompted it. Both
are asserted, the second as a sweep rather than a single case, because the
interesting one is the one you would not have picked by hand.

### What makes it tractable

The state space is astronomical, so four things do the work:

- **The opponent's exact roster is in the ROM**, so there is no belief state.
- **Damage is the average roll**, so a joint action leads to ONE successor
  rather than a distribution. That is the assumption that collapses the chance
  nodes, and it is stated on the page.
- **HP is quantised to 1/256 of a bar**, which makes the state space finite and
  the transposition table exact with respect to that abstraction.
- **A node budget**, because a search that can hang the page is not shippable.

Measured on a real 6v6: depth 2 is **7 ms / 4.3k nodes**, depth 3 is **29 ms /
89k nodes**. Depth 4 spends the whole 240k budget and then falls back to the
shallow estimate in places — *a worse answer wearing a deeper label*, which is
the one outcome a depth control must not have — so `turnGame` clamps at 3, the
same 1–3 the control offers.

### The unit changed, and it had to

Cells are now **whole Pokémon**: +100 means you are one Pokémon ahead on the
exchange. Past one turn it runs further than that, which the legend says. This
replaced "share of their HP minus share of yours", which does not compose over
turns.

**`POS_W = 0.35` is the one arguable number in the feature.** Everything else
is the game's own arithmetic; this is a judgement about what a good position is
worth in Pokémon-equivalents, and it is what lets a leaf reached right after a
switch see the reason you switched rather than only the hit you took. Deleting
it is a mutant, and it is caught.

### Stat stages — the hole depth made worse, patched same day

Depth is exactly what should reveal what a Dragon Dance buys, and while stages
went unmodelled a setup move was scored on the damage it does this turn — none
— at *every* depth. It also made **Draco Meteor's -2 Sp. Atk and Close
Combat's dropped defences free**, which flatters precisely the moves the search
likes most.

The move table already had everything: `st` is `{stat: stages}` and `tg` is
`self`/`foe`. Stages ride the state, scale damage through `stageMul`, decide
turn order, and are **lost when the Pokémon switches out** — which is both the
real Gen 5 rule and the thing that keeps the state space finite, since a branch
only carries stages while something is still standing there set up. Measured:
Slowking's Nasty Plot goes from **+1 to +66** with one turn of foresight.

**The first test for it was a false positive, and instructively so.** It
asserted that a setup move scores higher at depth 2 than at depth 1 — which it
does, and *would do with stages ripped out entirely*, because depth 2 hands you
a second turn in which to attack. It passed against all five mutants. The
replacement drives `stepTurn` and `leaf` directly, where the answer cannot come
from somewhere else, and now catches seven.

Two of those seven needed their conditions built rather than found:

- **A boosted attack takes more HP off** — the first version used the fight's
  lead, which this team one-shots either way, so both sides read 0% left. It
  now sweeps for a target that *survives* the neutral hit.
- **Speed stages decide who moves first** — measurable only as a knockout,
  since that is the one way a single turn's HP differs on order alone. And the
  test attacker's Speed has to be set **from the opponent's** (slower at +0,
  faster once multiplied by four): a fixed Speed of 1 is slower even at +6,
  which is how the first version passed against a mutant that ignored speed
  stages entirely.

Still not modelled, and said on the page: status conditions, held-item
triggers, recoil and healing.

### One turn or two, and not three

Three was offered, and it works — 29 ms, well inside the budget. Gab's verdict:
*"a bit unintuitive at that point when displayed this way"*, which is right,
and the reason is worth keeping. Three turns of equilibrium play is a much
stronger claim than two — it assumes both sides keep playing the mix for three
turns — and the numbers stop reading as Pokémon-equivalents you can picture. It
also buys little: the sweep shows the recommendation moving at **1 → 2 and
settling after**. So the depth that fixed the horizon is offered, and the one
that only adds confidence in a bigger assumption is not.

### The planner remembers who is on the field

The fight was remembered across a reload and so was the look-ahead, but the
**pairing** was not — so every reload emptied the one thing you have to click
twice to set, and the board you were reading went with it. Stored by **name**,
like the fight key, because rosters differ by cartridge and by starter; a stale
name simply drops out when `encounterPanel` filters both lists against the
current roster. Changing fight still clears their side, because a lead from
another roster is not a lead here.

### Rules the search keeps

- **A teammate with no documented moves is left OUT of their switches**, never
  priced at zero damage — an error in the one direction this board must never
  make. Every gym leader documents its whole team, so that assertion is vacuous
  on real data and a regression would sail past it: the test **fabricates** a
  moveless teammate so the rule is actually exercised.
- **A fainted attacker does not attack.** Tested as: if you move first and
  knock it out, every one of their *move* columns must score identically,
  because none of them ever lands. Also constructed rather than searched for —
  nothing in the real save is both faster than its opponent and able to one-shot
  it in a fight that documents moves, so an opportunistic search finds nothing
  and passes by being vacuous.
- **A speed tie goes to them**, still.

Six mutants, six caught by targeted assertions: recursing to the leaf instead
of recursing (caught only by *"a third turn changes it again"* — degrading
depth 3 to depth 2 leaves every other check green), a fainted attacker
attacking, dropping their switch columns, including moveless teammates,
removing the positional term, and flipping the speed tie.

### Two things the render caught

**Their switches made the board wide enough to scroll**, and the first thing
off the right edge was `worst` — the column the reading guide points at and the
one the verdict is computed from. Both anchors are `position: sticky` now: row
labels left, the guarantee right. And a cell can be *both* the pinned column and
the row's worst, so the two `box-shadow`s had to be restated as one or the ring
would silently drop.

**`step` was already taken.** The encounter stepper behind the prev/next
buttons is a `const step` in a function scope, so it shadowed the new one
harmlessly — but two unrelated `step`s in one script is a trap set for whoever
next moves code between scopes. Renamed `stepTurn`.

### One card, not two — and a grid nobody has to be told about

"Mock the battle" and "The turn as a game" were two sibling sections asking one
question, and the second had a title that named the *technique* rather than the
job. They are one card called **"Your move"**: pick one on each side, get the
pairing worked out, and then get what is actually *safe*.

**The game theory moved into a disclosure.** What has to be on screen is how to
read the thing:

- **A colour key made of the actual cell colours**, so the reader matches a cell
  to the legend by colour — which is how anybody actually uses a heat map. It
  was a sentence describing the colours first, which is not a key.
- **"Reading it"**, naming both directions: a row is a thing you could do, a
  column a thing they could do, read *across* a row to see how a choice can go
  and read the **worst** column to see how badly.
- The framing (*a turn is simultaneous, so it is a game rather than a
  calculation*) and the assumptions fold away behind a `?`. First read and
  sceptical read, not every visit.

**Both rows of the key are one grid.** The captions were a single flowing
sentence with ellipses between the phrases, sitting under a five-up colour bar
— so no phrase lined up with the swatch it described, and the whole strip read
as a mistake. Five equal columns in *both* rows puts each caption under its own
colour by construction, rather than by luck with the wording. Pinned as "two
rows, five cells each".

Two more things the render caught: the key's swatches had **no colour**, because the
`g0..g4` rules were scoped to `.gtab` and the legend is not in the table; and
only the *first* of three tied rows was ringed while the verdict named all
three — a contradiction on screen, and the ring is exactly what the reading
guide points at.

### A latent bug it exposed: the sheet has no charset

`state/team_sheet.html` is a **fragment** — no doctype, no `<head>` — because a
Claude artifact supplies those, and the artifact wrapper declares UTF-8. Served
raw, nothing does: `SimpleHTTPRequestHandler` guesses `text/html` with no
charset, the browser falls back to a legacy encoding, and every em dash and
every "Pokémon" on the page arrives as mojibake. `app/index.html` was immune
only because it carries its own `<meta charset>`.

`./serve` now appends `charset=utf-8` to every text type. The template stays a
fragment, because that is what the artifact contract wants.
