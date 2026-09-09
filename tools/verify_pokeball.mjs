/**
 * verify_pokeball.mjs -- the easter egg cannot cost the app anything.
 *
 * Why this file asserts what it does: notes/pokeball.md
 *
 *     node tools/verify_pokeball.mjs
 *
 * It is a toy, so nothing here checks that it looks good. What it checks is
 * that a decorative, full-viewport, animated layer stays harmless:
 *
 *   - the burst layer is pointer-events: none (a full-area layer taking
 *     clicks has broken this app twice)
 *   - every particle removes itself when its animation ends, so pressing the
 *     ball fifty times leaves nothing behind
 *   - it reads no save data and imports nothing from the app
 *   - the flavours all emit finite vectors -- one NaN and a particle vanishes
 *     to nowhere and never cleans up
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const ok = (name, pass, detail = '') => {
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? '  ' + detail : ''}`);
  if (!pass) failed++;
};

// ---------------------------------------------------------------- DOM stub
const anims = [];
class N {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.attrs = {}; this.className = ''; this.parentNode = null;
    this.style = new Proxy({}, { set: (t, k, v) => ((t[k] = v), true) });
    this.classList = {
      add: (c) => { if (!this.className.split(' ').includes(c)) this.className = (this.className + ' ' + c).trim(); },
      remove: (c) => { this.className = this.className.split(' ').filter((x) => x && x !== c).join(' '); },
      contains: (c) => String(this.className ?? '').split(' ').includes(c),
    };
  }
  append(...k) { for (const c of k) { if (c == null) continue; c.parentNode = this; this.children.push(c); } }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  click() { this.onclick?.({ target: this }); }
  getBoundingClientRect() { return { left: 100, top: 200, width: 30, height: 30 }; }
  animate(frames, opts) {
    const a = { frames, opts, onfinish: null, oncancel: null };
    anims.push(a);
    return a;
  }
  *walk() { yield this; for (const c of this.children) if (c.walk) yield* c.walk(); }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html ?? ''; }
}
const body = new N('body');
const docEl = new N('html');
docEl.getAttribute = (k) => docEl.attrs[k] ?? null;
// The arrow-key binding needs a document that listens, and a querySelector so
// it can stand down while a modal is open.
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
const listeners = new Map();
global.document = {
  body, documentElement: docEl, createElement: (t) => new N(t),
  addEventListener: (k, fn) => listeners.set(k, fn),
  removeEventListener: (k) => listeners.delete(k),
  querySelector: () => null,
};
global.getComputedStyle = () => ({ getPropertyValue: () => '' });
global.window = { matchMedia: () => ({ matches: false }), innerWidth: 1280, innerHeight: 800 };
global.setTimeout = globalThis.setTimeout;
global.matchMedia = global.window.matchMedia;
global.getComputedStyle = global.getComputedStyle;

const { mountPokeball, _internals } = await import('../app/js/pokeball.js');

console.log('── the toy');
{
  const src = fs.readFileSync(path.join(ROOT, 'app/js/pokeball.js'), 'utf8');
  ok('it imports nothing from the app', !/^\s*import\s/m.test(src),
    'an easter egg that depends on app state is not deletable');
  // Strip comments first: the module's own doc block says the words "save
  // data" while explaining that it touches none, which a naive grep reads as
  // the very thing it is promising not to do.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('and reads no save data',
    !/\b(readParty|readBox|Factory|ctx\.save|__BATTLE_D__)\b/.test(code));

  const css = fs.readFileSync(path.join(ROOT, 'app/css/theme.css'), 'utf8');
  const layer = css.match(/\.pb-layer\s*\{([^}]*)\}/);
  ok('the burst layer exists', Boolean(layer));
  ok('THE BURST LAYER IS pointer-events: none',
    /pointer-events:\s*none/.test(layer?.[1] ?? ''),
    'it is fixed and covers the viewport; this has broken the app twice before');
}

console.log('\n── pressing it');
{
  const SPRITES = { Snorlax: '/s.png', Gengar: '/g.png', Mew: '/m.png', Mewtwo: '/m2.png' };
  const teardown = mountPokeball(global.document, { sprites: SPRITES });
  const balls = [...body.walk()].filter((n) => n.className.includes('pb-ball'));
  const btn = balls[balls.length - 1];                 // the plain one, at the bottom
  const layer = [...body.walk()].find((n) => n.className.includes('pb-layer'));
  ok('four balls and a layer are mounted', balls.length === 4 && Boolean(layer),
    `${balls.length} balls`);
  ok('Poké at the bottom, Master at the top',
    balls[0].className.includes('pb-master') && balls[3].className.includes('pb-poke'),
    balls.map((b) => b.className.replace('pb-ball ', '')).join(' / '));
  ok('each is a button, so they are reachable by keyboard',
    balls.every((b) => b.tagName === 'BUTTON'));
  ok('and each is labelled for screen readers',
    balls.every((b) => b.attrs['aria-label']));
  ok('the layer is hidden from screen readers', layer.attrs['aria-hidden'] === 'true');

  anims.length = 0;
  btn.onclick();
  ok('pressing it opens the ball', btn.classList.contains('open'));
  ok('and emits particles', layer.children.length > 5, `${layer.children.length}`);
  ok('every particle is animated', anims.length >= layer.children.length,
    `${anims.length} animations for ${layer.children.length} particles`);

  // THE ONE THAT MATTERS: nothing accumulates.
  const spawned = layer.children.length;
  for (const a of anims) a.onfinish?.();
  ok('every particle removes itself when its animation ends',
    layer.children.length === 0, `${spawned} spawned, ${layer.children.length} left`);

  // ...and again, fifty times, which is what actually happens
  anims.length = 0;
  for (let i = 0; i < 50; i++) btn.onclick();
  const many = layer.children.length;
  for (const a of anims) a.onfinish?.();
  ok('fifty presses leave nothing behind', layer.children.length === 0,
    `${many} at peak, ${layer.children.length} after`);

  // ---- arrow keys ------------------------------------------------------
  {
    const key = listeners.get('keydown');
    ok('it listens for keys', typeof key === 'function');
    const { BALLS } = _internals;
    ok('every ball has its own arrow', new Set(BALLS.map((b) => b.key)).size === 4,
      BALLS.map((b) => `${b.id}:${b.key}`).join(' '));

    const fired = () => layer.children.length;
    for (const a of anims) a.onfinish?.();
    const before = fired();
    key({ key: 'ArrowDown', target: { tagName: 'BODY' } });
    ok('an arrow fires a ball', fired() > before);

    // IT MUST STAND DOWN WHERE ARROWS MEAN SOMETHING ELSE. An easter egg that
    // goes off while you are editing a Pokémon's moves is a bug, not a joke.
    for (const a of anims) a.onfinish?.();
    const quiet = fired();
    key({ key: 'ArrowDown', target: { tagName: 'INPUT' } });
    key({ key: 'ArrowUp', target: { tagName: 'TEXTAREA' } });
    key({ key: 'ArrowLeft', target: { tagName: 'SELECT' } });
    key({ key: 'ArrowRight', target: { tagName: 'DIV', isContentEditable: true } });
    key({ key: 'ArrowDown', target: { tagName: 'BODY' }, ctrlKey: true });
    key({ key: 'ArrowDown', target: { tagName: 'BODY' }, metaKey: true });
    key({ key: 'k', target: { tagName: 'BODY' } });
    ok('and stays quiet in a text field, under a modifier, or on another key',
      fired() === quiet, `${fired() - quiet} unwanted bursts`);

    // A modal open means the arrows belong to the modal.
    global.document.querySelector = () => ({});
    key({ key: 'ArrowDown', target: { tagName: 'BODY' } });
    ok('and while a modal is open', fired() === quiet);
    global.document.querySelector = () => null;
  }

  // ---- off is a real state ---------------------------------------------
  {
    const key = listeners.get('keydown');
    const stack = [...body.walk()].find((n) => n.className.includes('pb-stack'));
    const tog = [...body.walk()].find((n) => n.className.includes('pb-toggle'));
    ok('there is a way to put them away', Boolean(tog));

    for (const a of anims) a.onfinish?.();
    tog.onclick();
    ok('turning them off collapses the stack', stack.className.includes('off'));
    const quiet = layer.children.length;
    key({ key: 'ArrowDown', target: { tagName: 'BODY' } });
    key({ key: 'ArrowUp', target: { tagName: 'BODY' } });
    ok('and the arrow keys stand down with them', layer.children.length === quiet,
      'someone scrolling a box list with the keyboard does not want a Snorlax');
    ok('the choice is remembered', store[_internals.ON_KEY] === 'off');

    tog.onclick();
    ok('and they come back', !stack.className.includes('off'));
    key({ key: 'ArrowDown', target: { tagName: 'BODY' } });
    ok('with the keys live again', layer.children.length > quiet);
    for (const a of anims) a.onfinish?.();
  }

  teardown();
  ok('teardown removes both', !body.children.includes(btn) && !body.children.includes(layer));
  ok('and unbinds the key listener', !listeners.has('keydown'),
    'a listener outliving its buttons is a leak');
}

console.log('\n── procedural, and finite');
{
  const { vector, FLAVOURS } = _internals;
  let bad = null;
  for (const f of FLAVOURS) {
    for (let i = 0; i < 64; i++) {
      const [dx, dy] = vector(f, i, 64, 300);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) { bad = `${f}[${i}]`; break; }
    }
    if (bad) break;
  }
  ok('every flavour emits finite vectors', bad === null,
    bad ? `${bad} produced NaN — that particle would never clean up` : `${FLAVOURS.length} flavours`);

  // Two presses must not look identical, or "procedural" is a lie.
  const a = Array.from({ length: 40 }, (_, i) => vector('bloom', i, 40, 300).join());
  const b = Array.from({ length: 40 }, (_, i) => vector('bloom', i, 40, 300).join());
  ok('two bursts of the same flavour differ', a.join('|') !== b.join('|'));
  ok('there is more than one flavour to draw from', FLAVOURS.length >= 4, `${FLAVOURS.length}`);

  // FOUR BALLS, FOUR LOOKS. If two share a style the stack is decoration.
  const { STYLES, BALLS } = _internals;
  ok('every ball has its own burst style',
    new Set(BALLS.map((b) => b.style)).size === BALLS.length,
    BALLS.map((b) => `${b.id}:${b.style}`).join(' '));
  ok('and its own guest',
    new Set(BALLS.map((b) => b.guest)).size === BALLS.length,
    BALLS.map((b) => b.guest).join(' '));
  ok('every named style exists', BALLS.every((b) => STYLES[b.style]));
  ok('the styles differ in more than one dimension', (() => {
    const sig = (s) => JSON.stringify([s.flavours, s.rings, s.spin, s.n]);
    return new Set(Object.values(STYLES).map(sig)).size === Object.keys(STYLES).length;
  })());
}

console.log('\n── the fish');
{
  const { FISH, school } = _internals;
  // He is a MAGIKARP when the sprite is there; the pixel map is the fallback.
  {
    const l2 = new N('div');
    anims.length = 0;
    _internals.fish(l2, 0, 1, '/karp.png');
    ok('a fish uses the Magikarp sprite when it has one',
      l2.children[0]?.className.includes('pb-karp'), l2.children[0]?.className);
    for (const a of anims) a.onfinish?.();
    ok('and still cleans up', l2.children.length === 0);
    const l3 = new N('div');
    _internals.fish(l3, 0, 1, null);
    ok('and falls back to the drawn one without a sprite',
      l3.children[0]?.className.includes('pb-fish'));
  }
  ok('the fish is a pixel map, not an image',
    Array.isArray(FISH) && FISH.length >= 6 && FISH.every((r) => r.length === FISH[0].length),
    `${FISH[0].length}x${FISH.length}`);
  ok('it has an eye, so it reads as a fish and not a blob',
    FISH.some((r) => r.includes('o')));

  const { schoolSize, SCHOOL_MIN, SCHOOL_CAP, FISH_CHANCE } = _internals;

  // It is always a SCHOOL, and its size is heavy-tailed: a flat range would
  // mean every school is the same school, and the point is that once in a
  // while you get an absurd number of them.
  const sizes = Array.from({ length: 20000 }, schoolSize).sort((a, b) => a - b);
  const q = (p) => sizes[Math.floor(p * sizes.length)];
  ok('a school is never a lone fish', sizes[0] >= SCHOOL_MIN, `min ${sizes[0]}`);
  ok('most schools are small', q(0.5) <= SCHOOL_MIN * 4, `median ${q(0.5)}`);
  ok('but the tail is long', q(0.99) >= SCHOOL_MIN * 6,
    `p90 ${q(0.9)}, p99 ${q(0.99)} — a flat range would make every school alike`);
  ok('and it is capped, so a joke cannot become a stutter',
    sizes[sizes.length - 1] <= SCHOOL_CAP,
    `max ${sizes[sizes.length - 1]} of ${SCHOOL_CAP} (~110 SVG cells each)`);
  // Each ball now brings its OWN guest every time, so the fish are no longer a
  // dice roll on one button -- they are what the Poké Ball is for.
  ok('the Poké Ball always brings fish', FISH_CHANCE === 1);

  const layer = new N('div');
  anims.length = 0;
  school(layer, 7);
  ok('a school is one element per fish', layer.children.length === 7);
  ok('every fish is animated', anims.length === 7);

  // Pac-Man: it must actually turn around, or it is just a fish leaving.
  const legs = anims[0].frames;
  ok('a fish crosses the screen more than once', legs.length >= 3, `${legs.length - 1} legs`);
  const facings = legs.map((f) => /scaleX\((-?1)\)/.exec(f.transform)?.[1]);
  ok('and flips to face the way it is going', new Set(facings).size === 2,
    facings.join(','));

  // THE FLIP MUST BE A SNAP AT THE TURN, not a slow interpolation across the
  // leg -- otherwise scaleX passes through 0 for most of the traverse and the
  // fish spends its life squashed flat. Every facing change must therefore
  // happen between two keyframes that share a position.
  const posOf = (f) => /translate\(([^)]*)\)/.exec(f.transform)?.[1];
  let smeared = null;
  for (let k = 1; k < legs.length; k++) {
    const changed = /scaleX\((-?1)\)/.exec(legs[k].transform)[1]
      !== /scaleX\((-?1)\)/.exec(legs[k - 1].transform)[1];
    if (changed && posOf(legs[k]) !== posOf(legs[k - 1])) { smeared = k; break; }
  }
  ok('the flip is a snap at the turn, not a squash across the leg',
    smeared === null,
    smeared === null ? '' : `keyframe ${smeared} changes facing AND position`);
  ok('every keyframe is finite',
    legs.every((f) => !/NaN|undefined/.test(f.transform)));

  for (const a of anims) a.onfinish?.();
  ok('the school clears itself up', layer.children.length === 0);

  // The rainbow is one CSS animation on `color`, which every cell inherits.
  const css = fs.readFileSync(path.join(ROOT, 'app/css/theme.css'), 'utf8');
  ok('the rainbow cycle exists', /@keyframes\s+pb-rainbow/.test(css));
  ok('and the sprite cells inherit it',
    /currentColor/.test(fs.readFileSync(path.join(ROOT, 'app/js/pokeball.js'), 'utf8')));
}

console.log('\n── snorlax');
{
  const { stepBounce, snorlax } = _internals;

  // THE LOOP MUST TERMINATE. A bounce that keeps its energy runs forever, and
  // this one is driven by requestAnimationFrame -- an unbounded loop here is a
  // pinned CPU core for as long as the tab is open.
  const b = { vw: 1000, vh: 600, w: 120, h: 107 };
  let st = { x: 100, y: -50, vx: 6, vy: 0, spin: 0, resting: false };
  let frames = 0, hits = 0, escaped = false;
  while (frames < 5000) {
    st = stepBounce(st, b);
    frames += 1; hits += st.hits.length;
    if (!Number.isFinite(st.x) || !Number.isFinite(st.y)) break;
    if (st.x < -1 || st.x + b.w > b.vw + 1 || st.y + b.h > b.vh + 1) { escaped = true; break; }
    if (st.resting && Math.abs(st.vx) < 0.4) break;
  }
  ok('the bounce settles instead of running forever', st.resting && frames < 2000,
    `${frames} frames, ${hits} bounces`);
  ok('and stays finite', Number.isFinite(st.x) && Number.isFinite(st.y));
  ok('he never leaves the screen', !escaped, 'walls and floor must actually stop him');
  ok('every bounce puffs dust', hits >= 3, `${hits} wall/floor hits`);

  // Energy has to come DOWN, or "settles" above was luck.
  let a = { x: 500, y: 0, vx: 0, vy: 12, spin: 0, resting: false };
  const peaks = [];
  for (let i = 0; i < 900; i++) {
    const before = a.vy;
    a = stepBounce(a, b);
    if (a.hits.some((h) => h.ny === -1)) peaks.push(Math.abs(before));
  }
  ok('each bounce is smaller than the last',
    peaks.length >= 2 && peaks.every((v, i) => i === 0 || v <= peaks[i - 1] + 0.01),
    peaks.map((v) => v.toFixed(1)).join(' > '));

  // With no requestAnimationFrame -- which is exactly this test environment --
  // he must not leave an element behind.
  const layer = new N('div');
  snorlax(layer, '/snorlax.png');
  ok('with no rAF he cleans up rather than sitting there', layer.children.length === 0);

  // There is never just one.
  const { laxCount, LAX_CAP } = _internals;
  const counts = Array.from({ length: 20000 }, laxCount).sort((a, b) => a - b);
  const q = (p) => counts[Math.floor(p * counts.length)];
  ok('there is never only one Snorlax', counts[0] >= 2, `min ${counts[0]}`);
  ok('usually a few, sometimes a lot', q(0.5) <= 4 && q(0.99) >= 6,
    `median ${q(0.5)}, p90 ${q(0.9)}, p99 ${q(0.99)}`);
  ok('and capped, since each one is a rAF loop of its own',
    counts[counts.length - 1] <= LAX_CAP, `max ${counts[counts.length - 1]}`);
}

console.log('\n── the other guests');
{
  const { gengar, mewduo } = _internals;
  const SPR = { g: '/g.png', mew: '/m.png', mewtwo: '/m2.png' };

  let layer = new N('div');
  anims.length = 0;
  gengar(layer, SPR.g);
  const ghosts = layer.children.filter((c) => c.className.includes('pb-ghost'));
  ok('Gengar appears several times', ghosts.length >= 8, `${ghosts.length} elements`);
  ok('and throws after-images', ghosts.some((c) => c.className.includes('pb-echo')));
  ok('every one of him is animated', anims.length >= ghosts.length);
  for (const a of anims) a.onfinish?.();
  ok('and he clears up completely', layer.children.length === 0,
    `${layer.children.length} left behind`);

  layer = new N('div');
  anims.length = 0;
  mewduo(layer, SPR.mew, SPR.mewtwo);
  ok('Mew hops around', layer.children.filter((c) => c.className.includes('pb-mew')).length >= 5);
  ok('and Mewtwo turns up once',
    layer.children.filter((c) => c.className.includes('pb-mewtwo')).length === 1);
  for (const a of anims) a.onfinish?.();
  ok('the pair clear up too', layer.children.length === 0);

  // A missing sprite must not throw -- static.json is built from the ROM and
  // someone else's build may not have every name.
  const bare = new N('div');
  let threw = null;
  try { mewduo(bare, undefined, undefined); gengar(bare, undefined); }
  catch (e) { threw = e.message; }
  ok('a missing sprite is survivable, not an exception', threw === null, threw ?? '');
}

console.log(failed ? `\n  ${failed} check(s) FAILED` : '\n  all checks passed');
process.exit(failed ? 1 : 0);
