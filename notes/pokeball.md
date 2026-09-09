# The Poké Balls — the easter egg

Pinned by `tools/verify_pokeball.mjs`.

This is the archaeology — why the code is shaped the way it is, and which
mistakes shaped it. Read it before changing anything it describes; most of
what looks arbitrary here is load-bearing, and the note says which bug made
it so.

---

## The Poké Balls — `app/js/pokeball.js`

Four balls stacked in the corner, Poké at the bottom and Master at the top —
the order you earn them in, and the order of escalating consequences. Each
opens differently and lets something different out. **None of it is useful and
none of it is meant to be**; it exists to make someone laugh the first time
they find it, and later to be the thing a first-run tutorial nudges them into.

| Ball | Burst | Guest |
|---|---|---|
| Ball | Key | Burst | Guest |
|---|---|---|---|
| Poké | `↓` | `aurora` — neon triad, five emission flavours | a school of Magikarp |
| Great | `←` | `ripple` — cyan, 8–14 concentric rings, water-like | Snorlax, several, bouncing |
| Ultra | `→` | `mandala` — gold, eight-fold mirrored, heavy spin | Gengar, phasing |
| Master | `↑` | `spiral` — violet, a logarithmic spiral of streaks | Mewtwo and Mew |

### The arrow keys fire them

Something to fidget with while thinking. Two things make it safe rather than
annoying:

- **It does not `preventDefault`.** Arrow keys scroll, and stealing that to
  throw confetti would be a bad trade. The page still scrolls; a ball goes off
  as well.
- **It stands down wherever the arrows already mean something** — any
  `input` / `textarea` / `select` / contenteditable, any modifier held, or any
  open modal. An easter egg that fires while you are editing a Pokémon's moves
  is a bug, not a joke. The test drives all of those cases and asserts zero
  unwanted bursts, and that teardown unbinds the listener.

Nobody guesses a keybinding, so the hover label carries the keycap.

`verify_pokeball.mjs` asserts **every ball has its own style and its own
guest**, and that the four styles differ in more than one dimension — if two
balls look alike the stack is decoration rather than a joke.

### The guests are the real sprites, masked and hue-cycled

The first Snorlax was a hand-drawn 18×16 pixel map and read as a blob. **The
outline is what makes a Pokémon recognisable and sixteen rows cannot carry
it.** The guests are the game's own sprites now, scaled up with
`image-rendering: pixelated` so they stay chunky, under an animated
`hue-rotate`.

**On hue-rotate.** There is a standing rule against it — shininess must never
be faked with a filter, because that invents colours the game does not use and
the Factory would be *claiming* something false about a Pokémon you own. That
rule is about data integrity. Nothing here claims anything: a strobing rainbow
Gengar is not going to be mistaken for a shiny. The filter is fine in exactly
this one place, and nowhere else.

**Sprite URLs are PASSED IN, not imported.** `mountPokeball(document, {
sprites })` keeps the file dependent on nothing, so deleting it and its two
call sites still removes the whole thing in one move. A missing sprite is
survivable rather than an exception — someone else's `static.json` may not
carry every name.

### Rules it plays by, because a toy must not cost the app anything

- The burst layer is `position: fixed; inset: 0` and is therefore
  `pointer-events: none`. This is the shape of the bug that has broken the app
  twice; the test asserts it by name.
- **Every particle removes itself on `animationfinish`.** The test presses a
  ball fifty times — thousands of particles at peak — and asserts the layer is
  empty afterwards. Without it this is a memory leak with confetti on it.
  Gengar and the Mew pair are asserted to clear up completely too.
- **Anything on `requestAnimationFrame` must TERMINATE.** An unbounded rAF
  loop is a pinned CPU core for as long as the tab is open. Snorlax's physics
  is a pure `stepBounce(state, bounds) -> state` function precisely so this is
  testable without a browser: that it comes to rest, that each bounce is
  smaller than the last, and that he never leaves the screen.
- **`draw()` runs before the first frame.** Until it does he sits where the
  stylesheet put him, `translate(-200%)`. Found while screenshotting: under a
  headless virtual clock rAF never fired and the element was present with an
  empty transform.
- `prefers-reduced-motion` gets a short, calm bloom and no guests at all.

### The fish are Magikarp

Same trick as the other guests — the game's own sprite, scaled up pixelated
and hue-cycled. **The hand-drawn 16×10 map survives as the fallback** for a
build whose `static.json` does not carry the name; its cells inherit
`currentColor` so one `@keyframes` on `color` cycles the whole sprite, and the
eye is the one cell that opts out.

Worth knowing when editing: **the drawn fish faces left and the Magikarp
sprite faces right**, so "forwards" differs between them and the `scaleX`
convention is flipped per source.

**There is never only one Snorlax.** Two or three usually, up to eight —
another power law, with a much smaller cap than the fish because each one is a
`requestAnimationFrame` loop of its own. They land staggered, not all at once.

**School size is a power law, not a range.** A flat `rand(5, 9)` means every
school is the same school; the surprise is that once in a while there are an
absurd number. Median about six, one in ten gives eighteen, one in a hundred
fills the screen. **Capped at 48** — each fish is ~110 SVG cells — and they
shrink as the school grows, or forty-eight is a wall rather than a shoal.

**The flip is a snap at the turn.** One keyframe per leg with the facing
flipped between them makes `scaleX` interpolate 1 → −1 across the *whole*
traverse, so a fish spends most of its life squashed flat. Each turn gets a
pair of keyframes at the same position instead; the test asserts no keyframe
changes facing and position at once.
