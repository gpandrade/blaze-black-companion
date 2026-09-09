# The Slowking — the first-run tutorial and the mascot

Pinned by `tools/verify_tutor.mjs`. Two harnesses go with it, and both exist
because the only way to judge this thing is to look at it:

| Harness | Shows |
|---|---|
| `tools/hazel_poses.html` | the real badge in all five poses; `?light`, `?white`, `?scientist`, `?noface` |
| `tools/tour_shot.html` | the real app in an iframe, driven `?n=` steps into the tour |

Screenshot them with headless Edge from the Windows side — Playwright is not
installed here and there is no Linux Chrome:

```
"/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --headless --disable-gpu --window-size=1200,820 --virtual-time-budget=9000 \
  --screenshot=C:\\Users\\Gab\\shot.png "http://127.0.0.1:8080/tools/tour_shot.html?n=3"
```

`--virtual-time-budget` is what makes the tour harness work at all: the tour
starts on a 600ms timer and each step is a click, and a plain `--screenshot`
captures at load and sees none of it.

## What it is

A mascot in the corner and a tour that runs itself once. `mountTutor(doc, …)`
returns `{ start, close, say, helpHere, root, el }`; `app.js` mounts it after
the chrome (so the tour has something to point at), auto-starts it when
`tutorState().seen` is false, and never mounts it again once **Hide me** has
been pressed. `steps(doc)` is data: each step names a tab, a target to ring, a
title, prose and an emote, and a step whose target is missing is **skipped
rather than pointed at nothing**, because the app changes and a tour that rings
empty space is worse than one that is a step shorter.

Step 7 exists to satisfy a promise made in the project handoff: the move-first
Pokédex search shipped invisible, and the chips on the search box were only
half the fix.

## The sprite is the ROM's own art, and it took two rejections to get there

Three mascots shipped. The first was smooth vector — paths and gradients — and
read as a corporate illustration standing next to 649 pieces of cartridge art.
The second was a hand-authored 24×30 pixel grid, which Gab called **creepy**:
the spectacle frames took the cartridge accent, and on skin an ember rectangle
around each eye reads as a deep red ring. He was right both times.

**The name.** It was "Professor Hazel" for three commits — a drawn character
needs a name — and it is just **Slowking** now. Gab asked for whatever the
talking Slowking in *Pokémon 2000* called itself; as far as I can establish it
never gave itself a personal name in the film and is simply addressed as
Slowking, and there is no source in this repo that could settle it, so that is
what shipped. Say the word if you had a specific name in mind.

**`notes/pokeball.md` had already written the answer down**, about the easter
egg's guests, and it was not applied here:

> The first Snorlax was a hand-drawn 18×16 pixel map and read as a blob. **The
> outline is what makes a Pokémon recognisable and sixteen rows cannot carry
> it.** The guests are the game's own sprites now.

A face is harder than a Snorlax, not easier. **the Slowking is a Slowking** — Gab's
call, and the joke is the reason: it is the one Pokémon that has talked like a
person on screen, so a Slowking explaining the app is funny in a way a stock
mascot is not.

**There is no professor in the trainer table, and that was checked** before
falling back. Juniper never battles you, so she has no battle sprite; `a/0/8/3`
and `a/0/9/5`, the two other NARCs carrying graphics with cell data, decode to
battle UI — status icons, type labels, move-category panels. The overworld
sprite set is not decoded and finding it is open-ended archaeology. The nearest
thing the cartridge holds is **trainer sprite 51, the Scientist** — lab coat,
glasses, a Poké Ball in hand — and it shipped for one commit before Gab said he
preferred the Slowking. It stays as the second choice, for anyone whose wiki
clone is missing, and `?scientist` in the pose harness shows it.

**The URL is passed in, not imported.** `mountTutor(doc, { face })`, exactly as
`pokeball.js` takes its guests, so this module still depends on nothing and
stays deletable in one move. `app.js` passes
`SPRITE.Slowking ?? TRFACE['51'] ?? null`, so swapping the mascot is one line
and needs no change here at all.

**No art is a real state**, not a hypothetical: `./setup` extracts the
portraits from the player's own ROM, so a fresh clone has none, and neither
does any test. A broken-image glyph in the corner would be the same "looks bad"
failure by another route, so the badge falls back to a Poké Ball drawn in CSS
and the tour runs unchanged.

### The badge is 56×88 because that is the sprite's shape

Both candidates stand in a square canvas with a lot of air either side —
Slowking is 44×68 of a 96×96 sheet, the Scientist 34×75 of 80×80 — so a square
badge renders the character at about a third of the space and it looks tiny.
The badge is cut to that ~2:3 silhouette and `object-fit: cover` clips the
margin instead of scaling the figure down into it. No per-sprite crop offsets
are needed: both are centred, so cover finds them.

**Do not zoom past 1:1.** 118% fills the badge beautifully with Slowking, which
has fourteen rows of margin above and below — and takes the FEET off the
Scientist, whose sprite runs to row 79 of 80. Trainer portraits have already
shipped twice with mangled feet (see *the arrangement bug* in
`rom-graphics.md`), and
buying a few pixels on the mascot by re-shipping that on the fallback is not a
trade. It was measured, looked at, and reverted.

### An emote is a whole-pixel move

A still cannot wave. The five names the steps use (`idle`, `talk`, `point`,
`think`, `cheer`) map onto three honest gestures — rest, lean, hop — as a class
on the badge and a `translateY` in the CSS. **Never rotate or scale it**: it is
a bitmap, either one resamples it, and mush is exactly what the hand-drawn
mascots were thrown out for. `verify_tutor.mjs` fails the file if a pose rule
contains `rotate` or `scale`, and fails it if a step names an emote the
stylesheet has never heard of — an unknown pose is silently nothing.

Losing the grid lost the blink, which was the only ambient motion. That makes
the Clippy rule easier to keep, not harder.

**The pose harness kept its own copy of the drawing twice and drifted both
times**, showing me an old the Slowking while I judged a new one. It mounts the real
tutor and adds a pose class now, so there is nothing left in it to go stale.

## The tour walks over to what it is ringing

Gab: *"it's also darkening the text explaining what's being highlighted; move
both the professor and the text near the area being highlighted."* Two separate
bugs sat under that sentence.

**The dim layer painted over the words.** `.tu-spot` had `z-index: 68`, which
looks like it is fighting the app. It is not: `.tu-root` already lifts the
whole subtree to 71, so 68 was only ever measured against its *siblings* — the
bubble and the Slowking, both at `auto`. The spotlight covered the very sentence it
existed to spotlight. It is `z-index: 1` now against the bubble's `2`, and the
bubble needed `position: relative` before a z-index on it meant anything.

**The pair never left the corner.** `place(rect)` tries four positions in order
— below, above, right, left — clamps each into the viewport, and takes the
first that does not overlap the ring (or the least-overlapping one if none
fit). `close()`, `helpHere()` and the final step call `unplace()` and the Slowking
walks back to the corner. `reflow` re-places on scroll and resize as well as
re-ringing, because `scrollIntoView` is still smoothly scrolling when `show()`
returns and the pair would otherwise land where the target used to be.

**The first card explains the corner**, and that is not a nicety: "Skip the
tour" sits on step 0, so someone who takes it has read exactly one card. If
that card does not say what the Pokémon in the corner is and that it can be
clicked, they are left with an unexplained mascot, which is the Clippy read.
The end card says it too, and the end card is the one place a skipper is
guaranteed not to reach. Pinned.

**Back exists because the tour is read at reading speed.** Gab: *"in case you
move on too fast and want to step back."* Every step past the first offers it,
and so does the end card — that is exactly where you notice you went one too
far.

DOM order is `[spot, me, bubble]`. It was `[spot, bubble, me]`, which meant
opening the bubble shoved the Slowking bodily across the screen — the speech has to
come out of the character.

**The stub DOM's rect had no `right` or `bottom`.** The placement maths reads
all four edges, so it computed `NaN` and set `left: NaNpx`, which on a stub
looks exactly like working code. `getBoundingClientRect()` derives them now,
and `querySelector` caches one node per selector so a test can move a target
and see where the Slowking goes.

## The rule a mascot lives or dies by

**It must not move unless it is saying something.** A looping idle is what made
Clippy intolerable. There is no ambient motion at all now — a still sprite
cannot blink — `prefers-reduced-motion` removes even the transitions, and
`verify_tutor.mjs` fails the file if `animation:` or `infinite` ever appears in
`tutor.css`.

the Slowking stands bottom **left**. The Poké Balls are bottom right, and a mascot
standing on the easter egg would be the first bug reported.
