# ML / LLM features — the decision, not the design

Gab said on **2026-09-01** that he is considering adding ML/LLM-based features
in a separate session, before the pre-publishing work (tutorial, mobile pass,
README + LICENCE).

**This file exists so that session starts from the facts rather than from
enthusiasm. It deliberately does not design anything.** The standing
instruction on the "smart tooling" direction is *do not start by writing code —
ask which of these is meant*, and that still holds. What follows is what the
next session needs in order to have a useful conversation with him.

---

## What the repo currently is, stated precisely

These are checkable claims, not vibes, and they are the thing any model feature
spends:

| Property | How it is currently true |
|---|---|
| **Offline** | `grep -rnoE "https?://" app/js/ app/css/` returns **nothing**. The only `fetch()` in the app is same-origin, for `sheet_template.html`. |
| **Local** | `./serve` binds `127.0.0.1`; `--host 0.0.0.0` is an explicit opt-in. |
| **Deterministic** | Every number on screen comes from the ROM tables, the save, or `gen5.py`. The same save renders the same page. |
| **Free** | No key, no account, no quota. |
| **Yours** | Nothing is POSTed anywhere. Run facts live in `localStorage`. |
| **Verifiable** | ~30k lines (20.7k JS, 9.9k Python) pinned by 580 + 159 assertions. |

A model in the loop costs **all six**, not one of them. That is the honest
framing for the conversation — not "should we add AI", but "which of these are
we spending, on what, and does the thing we get back justify it".

## The three meanings, still unresolved

These have been on the list for weeks and none of them has been picked:

1. **Advice that reads the save and says something.** *"You have no answer to
   Ground and Clay is next."* Already computable from `defensiveGrid()`,
   `OPPONENTS` and the party. **Needs no model at all** — and the first
   instance of it shipped on 2026-09-02: the matrix-game board in the battle
   tab says whether a move is safe against everything the opponent can do,
   deterministically, offline, with no key. See `notes/battle-sheet.md`.
2. **Planning across time.** *"What should I catch on Route 4 given where the
   team is going."* Has the encounter tables and the level curve; lacks any
   notion of a *goal*.
3. **An actual model in the loop.** Costs money, needs a key, and is the first
   non-deterministic, non-offline thing in the project.

**Ask which one before writing anything.** They share a name and nothing else.

## THE OPTION THAT IS EASY TO MISS

**Claude Code is already the LLM in the loop.** Gab has run this entire project
through it — that is how every table here was extracted and every tab built.
The model is already present, already has a key he is already paying for, and
already reads the repo.

So there is a fourth option nobody has written down:

> Keep the app deterministic and offline, and make it a **better tool for a
> model to drive**. A documented JSON/CLI surface — or an MCP server — over
> `parse_save.py`, `defensiveGrid()`, `OPPONENTS`, the encounter tables and the
> matcher. The app stays exactly what it is. The intelligence is the model
> already sitting outside it.

This spends **none** of the six properties, ships to anyone who has Claude Code
or any other agent, and is the smallest possible change. It is also the option
that most directly matches how Gab actually uses this repo today. It should be
on the table before anything that embeds a key.

The trade: it helps people who already run an agent, and does nothing for
someone who clones the repo and opens `index.html`. Whether that is a real
audience is a question for him, not an assumption for us.

## What is already deterministic and must NOT be handed to a model

Handing a model a question the ROM already answers exactly is a **downgrade**:
it makes a correct answer probabilistic and adds latency and cost to do it.
The following are settled and must stay settled:

- Base stats, types, abilities, learnsets, TM compatibility, evolutions →
  `state/personal.json`
- Move power, accuracy, PP, category, priority → `state/moves.json`
- Type effectiveness → `gen5.py` (the Gen 5 17-type chart, no Fairy)
- Damage → `calcDamage` in `sheet_template.html`
- Encounters → the wiki tables + `docs/Wild Pokemon.txt`
- Which copy of a species a slot means → `matchSlot()` / `take()`
- The level cap → `nuzlocke.js`'s computed cap, never a typed-in number

Hard rules 4–7 exist because *vanilla knowledge is wrong for this hack*. A
model's priors are vanilla knowledge — it has read far more Smogon than Blaze
Black. **Anything a model says about this game that is not grounded in a table
in this repo is, by default, wrong.** That is the single most important
sentence in this file.

## Where a model would genuinely add something

Only where the answer is not computable, which mostly means **judgement and
prose**:

- **Explaining a plan.** The app can prove Excadrill outspeeds by 12; saying
  *why that matters for this fight* is language.
- **Goals in natural language.** *"I want a team that can win without using a
  legendary"* is a constraint no UI captures well. Note the honest version of
  this: the model translates the sentence into a **filter over the existing
  deterministic machinery**, and the machinery still produces the answer.
- **Naming things.** Team names, nicknames, the death-log epitaph. Cheap,
  low-stakes, and genuinely nicer than a template.
- **Reading the run back.** The nuzlocke graveyard is *"the artifact people
  screenshot and post"*. Turning a run's statistics into a paragraph worth
  posting is a real product feature and is almost entirely prose.

Note that three of those four are **output formatting, not reasoning** — the
model is writing up an answer the repo already computed. That is the safest
shape and the one to aim for.

## Costs to say out loud before he commits

1. **A key.** Someone cloning this from GitHub now needs an API key or the
   feature is dead weight in the UI. That changes what the README promises and
   who the project is for.
2. **The save is personal data.** Sending party contents to an API is a
   different privacy claim than the one the repo makes today. If it happens it
   must be opt-in, per-request, and visible — never a background call.
3. **Testing.** `./test-all` is 739 assertions of deterministic checks. Nothing
   in this repo currently tests a non-deterministic output, and the project's
   whole quality culture — mutation testing, "a test that pins the bug in
   place" — assumes determinism. That culture does not transfer for free.
4. **It is the first thing here that can be confidently wrong.** Every failure
   this project has recorded was something that *looked right and was not*
   (`notes/` is largely a catalogue of them). A fluent wrong answer about a
   gym leader is exactly that failure mode, produced on demand.

## What to actually ask him

1. Which of the four options — deterministic advice, planning, a model in the
   app, or a tool surface for the agent he already runs?
2. Is this for **him**, or for the people who will clone the repo? The answer
   changes everything: a key he already has is free, a key a stranger needs is
   a barrier.
3. If a model does go in the app: what is it allowed to be wrong about? A
   nickname, yes. A gym leader's threat, no.

## Where it should land if it is built

The standing note is explicit: *the tools used most are the swap tree and
the fight planner, so anything smart should land there rather than as a new
tab.*
That still holds, and it is the correct instinct — a new tab is where features
go to be ignored, and this app already has seven.
