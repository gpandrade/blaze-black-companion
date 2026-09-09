# Nuzlocke mode — the rules, and the shackles

Pinned by `tools/verify_run.mjs`.

This is the archaeology — why the code is shaped the way it is, and which
mistakes shaped it. Read it before changing anything it describes; most of
what looks arbitrary here is load-bearing, and the note says which bug made
it so.

---

## A rule is a CAPABILITY SWITCH, not a label

The obvious design is a checklist that reminds you what you promised. It is
the wrong one: **a nuzlocke you can break by clicking the same button as
always is a note, not a rule.** Worse, a picker full of switches that change
nothing claims a constraint it does not keep — that is not a missing feature,
it is a false one.

So every rule in `app/js/nuzlocke.js` names **gates**: action ids it closes.
A tab asks `gate(ctx.nuz, 'factory.create')` before offering the control, and
shackles it when the answer is no.

`verify_run.mjs` refuses a rule that gates nothing, tracks nothing, and is not
declared honour. `auto-purge` was caught by exactly that check while being
written — it had no gates, and the reason was that **nothing could mark a
death yet.** The check found a missing feature, not a missing field.

## A CLOSED CONTROL STAYS ON SCREEN

Three ways to say "you may not", and two are wrong:

| | why it fails |
|---|---|
| hide it | you forget the constraint exists and the app quietly becomes a different app — the exact opposite of the point |
| grey it out | indistinguishable from "not available yet" or from a bug, and every other disabled control in this app already means the latter |
| **shackle it** | the control stays exactly where it was, struck through in the danger colour, wearing a lock, its tooltip naming the rule |

Only the third reads as *I did this to myself*.

**Clicking a shackled control is inert but not silent** — it carries an
`aria-label` explaining which rule closed it and where to change your mind. A
dead button is a bug; a button that explains itself is a rule.

**DISABLED IS A COLOUR, NEVER AN OPACITY.** `.shackled` restates background
and ink from the measured `--x4` / `--x4b` pair rather than fading whatever was
underneath — the standing rule from `notes/design-system.md`, where an
`opacity: .42` over a filled accent took a measured 7.08:1 down to 2.27:1. The
**strike-through carries it without colour**, which matters: "unavailable" and
"forbidden" have to be distinguishable to someone who cannot tell the red from
the grey.

It is styled **once, in `theme.css`**, because five tabs render it and a
shackle that looks different in the Bag than in the Factory reads as two
different kinds of unavailable.

## Enforced versus honour, said out loud

Some rules the app can hold you to, because the action goes through it. Others
it genuinely cannot — it cannot see you use a Potion mid-battle or switch,
because those happen in the emulator. Pretending otherwise would be the same
class of lie as a trainer card that invents a badge count.

So every rule declares `kind`, the picker groups by it under a heading that
says which is which, and `verify_run.mjs` asserts **honour rules gate nothing**
— they cannot pretend to be enforced. That honesty is what makes the enforced
ones worth trusting.

## The ladder is a ladder

Three presets, each a **strict superset** of the one before, so "harder" is a
direction rather than a different pile of switches — the roguelike-ascension
idiom. `verify_run.mjs` asserts the superset property rung by rung, so a
future preset cannot quietly be *easier* than the one it sits after.

Changing any switch makes it a **custom** run, said plainly rather than left
showing a preset name that is no longer true.

**The picker names the buttons each rule closes.** A rule that says "no
editing" without saying which controls go dark is a promise; naming them makes
it a contract. It renders human labels, never a bare gate key — asserted.

## The duplicates clause works on the FAMILY

Catching a Pidgey when you already have a Pidgeotto is *the* case the clause
exists for, and a species-only check misses every one of them. `familyOf()`
walks the blob's `evo` links **forward from the base and backward from the
top**, so any member of a line identifies the whole line.

**A duplicate does not spend the area.** That is the entire point, and it is
applied by the app at the moment you log the encounter rather than left for
you to remember — the difference between a rule the app keeps and a note.

## The level cap is COMPUTED, never typed in

Every input was already here: the documented fights in game order, `kind ===
'gym'`, and now the badge count read from the save.

**Badges beat the battle sheet's ticks** when both exist. A tick you forgot to
make would otherwise *lower* your cap, which is the failure that matters — a
cap that drifts down silently lets you break the rule while believing you are
keeping it. The ticks are still the fallback when there is no badge count.

Asserted: the cap never goes backwards as badges accumulate, and eight badges
reads as done rather than as a cap of zero.

## Marking a death: the log is written BEFORE the body is touched

`auto-purge` stages the release; `death-is-permanent` alone only writes the
graveyard entry and leaves the Pokémon where it is, which is how most people
run it.

**Order is load-bearing.** A Pokémon must never be removed without also being
remembered — an auto-purge that loses the graveyard entry is data loss wearing
a rule's clothes. `verify_run.mjs` asserts both halves and that the release is
**staged, not written**: `F.dirty` goes true and the file on disk is untouched
until you install.

The action is absent entirely outside a nuzlocke, because outside one there is
no such event — a fainted Pokémon just needs a Centre.

## The Run tab, and why the mode is not one

The nuzlocke itself is deliberately **not** a tab: it is a set of constraints
on the whole app, and the shackles belong on the buttons they close, where you
reach for them. A tab duplicating the Factory, Bag and Builder surfaces would
drift from them within a week.

What belongs in one place is what you are *not* doing mid-action: configuring
the run and reviewing it.

**The summary half works with the mode OFF, deliberately.** Someone who will
never nuzlocke still wants their run summarised, and gating a summary behind a
mode they do not want is how a feature ends up unused. With the mode off the
nuzlocke-only figures read as **absent rather than zero** — "not tracking
deaths" is not "no deaths".

**Encounter logging lives in Adventure too**, because that is where you are
standing when you meet something. Logging it three clicks away in another tab
is how a log stops being kept. The panel is absent entirely when the mode is
off — an empty "Encounter" box would be a difference, and a player who is not
nuzlocking must see none.

## What a nuzlocke is NOT about

The first rule set over-reached, and the shape of the mistake is worth keeping.

**A nuzlocke restricts which Pokémon you may use and what happens when they
faint.** It does not stop you handing something a Leftovers you already own,
teaching it a TM you bought, or naming it. `no-item-writes` closed
`bag.give` and `bag.teach`, which took away the app's convenience without
taking away anything the rules are actually about — it is narrowed to
`bag.edit` alone, which is *inventing* items and is a different thing.

Narrowing a rule that people may already have switched on hands capability
**back**. That is the safe direction for a change of meaning, and the reason
the id was kept rather than replaced.

**`nickname-all` and `no-editing` contradicted each other outright.** One
requires a nickname; the other closed the only control that could set one. Two
rules in the same preset, cancelling.

The fix is a **Rename** operation of its own — never gated, because the game
has a name rater and renaming is unambiguously legal in a playthrough. It uses
`patchAt` and touches only the name field and the `is_nicknamed` bit; an empty
name clears the flag and restores the species name, which is how the game says
"no nickname". `verify_run.mjs` asserts the control exists and is **not**
wrapped in a `shackle()`.

The general lesson: **a gate must name an action that the rule is actually
about.** It is easy to close a whole tab's worth of buttons because they sit
near each other, and the result is a mode nobody wants to switch on.

## The run wears its difficulty

A pill reading "8 rules" is a fact you read once and stop seeing. Choosing a
hard run should be *present*, so `data-nuz` carries an intensity of 1–3, banded
on the presets' own shape, and the chrome escalates: the page ground's pattern
hardens from asanoha to the tighter kikko and gains weight, the shell bar's
neon hairline turns to the danger colour and thickens, and at the top of the
ladder the chrome's own type tightens.

**Three things it may not touch**, and they are what keep this from wrecking
the design:

1. **Never a surface or a measured pair.** No card background, no ink, no
   `--fx-go-*` or `--x*` value moves. Every contrast ratio this project has
   measured stays exactly as measured — a mode that quietly made text harder
   to read would be the worst possible way to express difficulty. Asserted by
   scanning the block for those tokens, and mutation-tested.
2. **Chrome only** — the bar, the ground, the hairlines. Never the data.
3. **The ABSENCE of `data-nuz` is the normal app**, the same rule the theme
   follows and for the same reason: it is removed rather than set to `0`, so
   someone not nuzlocking can never be affected by a block they do not match.

## The two halves of the contract, and the one usually broken

1. A rule closes what it names.
2. **With the mode off, nothing anywhere changes.**

The second is the half a feature like this breaks, so `verify_run.mjs` mounts
the Factory, the Bag and the Pokédex **twice** — once with rules on, once off —
and asserts zero shackled controls and no banner in the off case, against the
real tabs rather than against the model.

## It has to be findable from outside its own tab

The first thing reported after it shipped was *"I can't see where nuzlocke mode
is or how to activate it."* It was entirely inside the Run tab — and the two
other settings of the same kind, the cartridge and the starter, are in the
masthead. So that is where people looked, found nothing, and concluded the
feature was missing. It was.

The masthead now carries a chip stating whether a nuzlocke is live and how many
rules are in force. **It does not toggle.** Turning one on is a decision with a
rule set behind it, and a one-click switch sitting beside the theme control is
exactly what you press by accident; it navigates to where the decision is made
and states the current answer on the way. Pinned in `verify_app.mjs`, including
that it is a link and not a toggle.

## Traps hit while building it

- **`mk()` helpers that swallow their element cannot be shackled.** Both the
  Factory's and the Builder's action makers appended and returned nothing, so
  `shackle(mk(...))` silently did nothing. They return the button now.
- **A slot is a `div` with `role="button"`, not a `<button>`.** A test
  selecting on the tag found nothing and skipped itself while reporting PASS.
- **`replaceChildren(null, …)` coerces null to the string `"null"`.** Spread a
  filtered array instead; a placeholder element would also invent a class
  nothing styles.
- **The Bag's quantity row only exists inside a selected item's detail pane**,
  so a test that mounts and looks immediately exercises nothing.
