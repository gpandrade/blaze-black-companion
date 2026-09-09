/**
 * verify_tutor.mjs -- Slowking.
 *
 *     node tools/verify_tutor.mjs
 *
 * Why this file asserts what it does: notes/design-system.md, "Professor
 * Slowking".
 *
 * =============================================================================
 * THE THINGS THAT MUST NOT BE TRUE
 * =============================================================================
 *   A MASCOT THAT WILL NOT GO AWAY. Clippy's whole sin. Slowking must be silent
 *   unless the tour is running or you clicked them, must run the tour exactly
 *   once, and must be dismissible for good in one press -- and `hidden` has to
 *   mean not mounted, not merely invisible.
 *
 *   A TOUR THAT MISSES THE POINT OF ITSELF. It exists because two features are
 *   documented as unfindable: the move-first Pokédex search, and the Poké Ball
 *   easter egg the tutorial is supposed to walk you into. If either sentence
 *   goes missing the tour has lost its reason to exist, so both are pinned by
 *   content rather than by count.
 *
 *   A TOUR THAT BREAKS ON A FRESH INSTALL. The first person to see it has no
 *   save, and a step that rings a tab they cannot open teaches nothing.
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
class N {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.attrs = {}; this.className = ''; this.innerHTML = '';
    this.style = {}; this.textContent = ''; this.hidden = false; this.parentNode = null;
    this.classList = {
      add: (c) => { if (!this.classList.contains(c)) this.className = `${this.className} ${c}`.trim(); },
      remove: (c) => { this.className = this.className.split(' ').filter((x) => x && x !== c).join(' '); },
      toggle: (c, on) => ((on ?? !this.classList.contains(c)) ? this.classList.add(c) : this.classList.remove(c)),
      contains: (c) => this.className.split(' ').includes(c),
    };
  }
  append(...k) {
    for (const x of k) {
      if (x == null) continue;
      const n = typeof x === 'string' ? Object.assign(new N('#text'), { textContent: x }) : x;
      n.parentNode = this; this.children.push(n);
    }
  }
  replaceChildren(...k) { this.children = []; this.append(...k); }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  /* RIGHT AND BOTTOM ARE NOT OPTIONAL. The placement maths reads all four
     edges, and a stub that returned only left/top/width/height fed it NaN --
     which lands as `left: NaNpx` and looks, on a stub, exactly like working
     code. Set `n.rect` to move an element somewhere specific. */
  getBoundingClientRect() {
    const r = { left: 10, top: 10, width: 40, height: 20, ...(this.rect ?? {}) };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height };
  }
  scrollIntoView() {}
  focus() {}
  click() { this.onclick?.({ target: this, preventDefault() {} }); }
  /* innerHTML counts. The bubble writes its prose that way -- it carries <b>
     -- so a `text` that only walked textContent read every bubble as empty and
     four assertions failed on the stub rather than on the code. */
  get text() {
    const own = (this.innerHTML || '').replace(/<[^>]*>/g, ' ');
    return `${this.textContent || ''} ${own} `
      + this.children.map((c) => c.text ?? '').join(' ');
  }
  * walk() { yield this; for (const c of this.children) if (c.walk) yield* c.walk(); }
  find(p) { for (const n of this.walk()) if (p(n)) return n; return null; }
  findAll(p) { return [...this.walk()].filter(p); }
}
const body = new N('body');
const store = {};
global.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
const keys = [];
const qs = new Map();
let hasSave = true;
global.document = {
  body,
  createElement: (t) => new N(t),
  createElementNS: (_n, t) => new N(t),
  addEventListener: (t, fn) => { if (t === 'keydown') keys.push(fn); },
  removeEventListener() {},
  defaultView: {
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    innerWidth: 1200,
    innerHeight: 800,
  },
  /* One node per selector, kept. Handing back a fresh element every call meant
     a test could not move a target and see where Slowking went. */
  querySelector: (sel) => {
    if (sel === '.sh-dot.ok') return hasSave ? new N('span') : null;
    if (!qs.has(sel)) qs.set(sel, new N('div'));
    return qs.get(sel);
  },
  querySelectorAll: () => [new N('button')],
};
const press = (key) => keys.forEach((fn) => fn({ key }));

const T = await import('../app/js/tutor.js');
const cls = (c) => (n) => n.classList.contains(c);
const btn = (root, label) => root.find((n) => n.tagName === 'BUTTON'
  && n.text.replace(/\s+/g, ' ').trim() === label);

// =========================================================================
console.log('── the tour says the things it exists to say');
{
  const list = T.steps(global.document);
  ok('every step has a title and something to say',
    list.length >= 5 && list.every((s) => s.title && s.body && s.id), `${list.length} steps`);
  /* AN EMOTE IS A WHOLE-PIXEL MOVE OF A BITMAP. Two hand-drawn mascots came
     before this one and both were thrown out on sight, so the sprite is the
     cartridge's own art now and the only thing a pose can do is shift it.
     What is worth asserting is that every pose a step names has a rule at all
     -- an emote the stylesheet has never heard of is silently nothing. */
  {
    const css = fs.readFileSync(path.join(ROOT, 'app/css/tutor.css'), 'utf8');
    const used = [...new Set(list.map((s) => s.emote).filter(Boolean))];
    const orphan = used.filter((e) => !css.includes(`.tu-${e}`));
    ok('every emote a step names is a pose the CSS knows', !orphan.length,
      orphan.length ? `no rule for ${orphan.join(', ')}` : used.join(' '));
    const poseRule = (e) => /transform: *([^;}]+)/
      .exec(new RegExp(`\\.tu-me\\.tu-${e}[^{]*\\{([^}]*)\\}`).exec(css)?.[1] ?? '')?.[1];
    ok('...and celebrating does not look like talking',
      poseRule('cheer') && poseRule('talk') && poseRule('cheer') !== poseRule('talk'),
      `cheer ${poseRule('cheer')} vs talk ${poseRule('talk')}`);
    /* NEVER ROTATE OR SCALE THE SPRITE. It is a bitmap of the game's own art;
       either one resamples it, and mush is exactly what the hand-drawn ones
       were thrown out for. */
    const moves = used.map(poseRule).filter(Boolean).join(' ');
    ok('...and no pose rotates or scales it', !/rotate|scale/.test(moves),
      'a bitmap survives translation and nothing else');
  }

  /* THE FIRST THING IT SAYS HAS TO EXPLAIN THE THING IN THE CORNER.
     "Skip the tour" is on step 0, so anyone who takes it has read exactly one
     card -- and if that card did not say what the Pokémon in the corner is or
     that it can be clicked, they are left with an unexplained mascot, which is
     the Clippy read. The end card says it too, but the end card is the one
     place you are guaranteed NOT to have reached. */
  ok('the first card says why it will be sitting in the corner',
    /corner/i.test(list[0].body) && /click/i.test(list[0].body),
    'skipping on step 0 must still leave you knowing what it is');
  ok('...and introduces itself by name', /Slowking/.test(list[0].title));

  const all = list.map((s) => `${s.title} ${s.body}`).join(' ');
  // THE TWO IT WAS BUILT FOR -- both named in the tour's own brief. A tour
  // missing either is a tour that has forgotten why it was written.
  ok('it surfaces the move-first Pokédex search',
    /move name/i.test(all) && /Pokédex/.test(all),
    'documented as invisible to anyone who does not already know');
  ok('...and walks you into pressing a Poké Ball',
    /Poké Balls/.test(all) && /press one/i.test(all));
  ok('...and names the dial key, which nobody would guess',
    /<b>`<\/b>/.test(all));
  ok('...and says why the app exists at all, not just what the buttons do',
    /487 abilities/.test(all), 'the hack changed the data every other source has');

  // A FRESH INSTALL HAS NO SAVE.
  const needs = list.filter((s) => s.need);
  ok('the steps that need a save are marked', needs.length >= 2, `${needs.length} of ${list.length}`);
  ok('...and the ones that do not include the Pokédex',
    !list.find((s) => s.id === 'dex')?.need, 'it is the only tab that works with no save');
}

// =========================================================================
console.log('\n── it runs once, and it goes away');
{
  for (const k of Object.keys(store)) delete store[k];
  ok('a first visit has not seen it', T.tutorState().seen === false);

  const h = T.mountTutor(global.document, { onNav() {}, activeTab: () => 'adventure' });
  ok('Slowking mounts', !!body.find(cls('tu-root')) && !!h.el);
  ok('...and says nothing until asked', body.find(cls('tu-bubble')).hidden === true,
    'the whole difference between a helper and Clippy');

  h.start();
  const bubble = body.find(cls('tu-bubble'));
  ok('the tour speaks when started', bubble.hidden === false && /Slowking/.test(bubble.text));
  ok('...and offers a way out of it on the very first step', !!btn(bubble, 'Skip the tour'));

  btn(bubble, 'Skip the tour').click();
  ok('skipping closes it', bubble.hidden === true);
  ok('...and is remembered, so it never ambushes you twice', T.tutorState().seen === true);
}

// =========================================================================
console.log('\n── the help that stays');
{
  const h = body.find(cls('tu-root')) ? null : null;
  const me = body.findAll(cls('tu-me')).pop();
  const bubble = body.findAll(cls('tu-bubble')).pop();
  me.click();
  ok('clicking Slowking offers help for the tab you are on',
    bubble.hidden === false && /dimmed/.test(bubble.text), 'adventure');
  ok('...with a way back into the tour', !!btn(bubble, 'Show me around'));
  ok('...and Escape closes it', (press('Escape'), bubble.hidden === true));

  me.click();
  ok('every tab has something to say about it',
    ['adventure', 'battle', 'builder', 'factory', 'items', 'dex', 'run']
      .every((t) => (T.TAB_TIPS[t] ?? '').length > 30),
    `${Object.keys(T.TAB_TIPS).length} tips`);
  // The dex tip is the one that matters most, for the same reason as the step.
  ok('...and the Pokédex tip is the move search again',
    /move/i.test(T.TAB_TIPS.dex));

  const root = body.findAll(cls('tu-root')).pop();
  btn(body.findAll(cls('tu-bubble')).pop(), 'Hide me').click();
  ok('"Hide me" removes Slowking from the page, not just hides them',
    root.parentNode === null);
  ok('...and is remembered', T.tutorState().hidden === true);
}

// =========================================================================
console.log('\n── a fresh install, with no save');
{
  for (const k of Object.keys(store)) delete store[k];
  hasSave = false;
  let cur = null;
  const h = T.mountTutor(global.document, {
    onNav(id) { cur = id; }, activeTab: () => cur,
  });
  h.start();
  const bubble = body.findAll(cls('tu-bubble')).pop();
  ok('the tour still runs with nothing loaded', bubble.hidden === false);
  /* WALKED WITH A WAIT, because a step that has to change tab renders 220ms
     later -- the tour navigates first and speaks once the tab is up. A
     synchronous loop clicked Next twenty times into a bubble that never
     changed, and the failure looked like the tour not terminating. */
  const tick = () => new Promise((r) => setTimeout(r, 320));
  let guard = 0;
  while (guard++ < 20) {
    if (/That is everything/.test(bubble.text)) break;
    const next = btn(bubble, 'Next') ?? btn(bubble, 'Done');
    if (!next) break;
    next.click();
    await tick();
  }
  ok('...and reaches the end without a save', /That is everything/.test(bubble.text),
    `${guard} steps walked`);
  ok('...having marked itself seen', T.tutorState().seen === true);
  hasSave = true;
}

// =========================================================================
/* THE SPRITE IS THE GAME'S OWN ART AND IT IS PASSED IN.
   Two hand-drawn mascots shipped and both were rejected on sight -- the second
   was called creepy, because the accent-coloured spectacle frames read as deep
   red rings around the eyes. notes/pokeball.md had already recorded the
   answer for the easter egg's guests: a hand-drawn face does not read, and the
   cartridge's own does. */
console.log('\n── the sprite comes from the cartridge, not from this file');
{
  for (const k of Object.keys(store)) delete store[k];
  const h = T.mountTutor(global.document, { face: '/app/img/trainers/051.png' });
  const me = body.findAll(cls('tu-me')).pop();
  const img = me.find((n) => n.tagName === 'IMG');
  ok('the badge shows the sprite it was handed', img?.src === '/app/img/trainers/051.png');
  ok('...and this module never picks the path itself',
    !/img\/trainers|wiki\/docs\/img/.test(fs.readFileSync(path.join(ROOT, 'app/js/tutor.js'), 'utf8')),
    'passed in like pokeball.js takes its guests, so tutor.js imports nothing');
  h.root.remove();

  /* NO ART IS A REAL STATE: ./setup extracts the portraits from the player's
     own ROM, so a fresh clone has none. A broken-image glyph in the corner
     would be the same "looks bad" failure by another route. */
  const bare = T.mountTutor(global.document, {});
  const bm = body.findAll(cls('tu-me')).pop();
  ok('with no art there is no broken image', !bm.find((n) => n.tagName === 'IMG'));
  ok('...the badge draws a Poké Ball instead', bm.classList.contains('tu-noface'));
  bare.start();
  ok('...and the tour still runs',
    body.findAll(cls('tu-bubble')).pop().hidden === false);
  bare.close();
  bare.root.remove();
}

// =========================================================================
/* BACK. Asked for: "in case you move on too fast and want to step back." */
console.log('\n── you can step back through the tour');
{
  for (const k of Object.keys(store)) delete store[k];
  let cur = null;
  const h = T.mountTutor(global.document, { onNav(id) { cur = id; }, activeTab: () => cur });
  const bubble = body.findAll(cls('tu-bubble')).pop();
  h.start();
  const first = bubble.text;
  ok('the first step has nowhere to go back to', !btn(bubble, 'Back'));
  btn(bubble, 'Next').click();
  const second = bubble.text;
  ok('...the second step offers Back', !!btn(bubble, 'Back') && second !== first);
  btn(bubble, 'Back').click();
  ok('...and it returns to the step before', bubble.text === first);
  // Walk to the end card: that is exactly where you notice you went one too far.
  const tick = () => new Promise((r) => setTimeout(r, 320));
  let guard = 0;
  while (guard++ < 20 && !/That is everything/.test(bubble.text)) {
    const n = btn(bubble, 'Next') ?? btn(bubble, 'Done');
    if (!n) break;
    n.click();
    await tick();
  }
  ok('the end card offers Back too', !!btn(bubble, 'Back'), 'the last step is one click away');
  btn(bubble, 'Back').click();
  await tick();
  ok('...and it lands on a real step, not on nothing',
    !/That is everything/.test(bubble.text) && bubble.text.trim().length > 20);
  h.close();
  h.root.remove();
}

// =========================================================================
/* HAZEL WALKS OVER TO WHAT SHE IS POINTING AT.
   The first tour stood in the bottom-left corner and rang an element anywhere
   on screen: you read the sentence in one place, then hunted the far side of a
   dimmed page for the thing it described. */
console.log('\n── the bubble stands next to what is ringed');
{
  for (const k of Object.keys(store)) delete store[k];
  qs.clear();
  let cur = null;
  const h = T.mountTutor(global.document, { onNav(id) { cur = id; }, activeTab: () => cur });
  const root = body.findAll(cls('tu-root')).pop();
  const bubble = root.find(cls('tu-bubble'));
  const px = (v) => Number(String(v ?? '').replace('px', ''));

  h.start();
  ok('the greeting rings nothing, so it stays in the corner',
    !root.classList.contains('tu-anchored') && !root.style.left,
    'there is nothing to stand next to yet');

  btn(bubble, 'Next').click();
  const save = qs.get('#shell-save');          // left 10, top 10, 40x20
  ok('a step with a target moves the pair to it', root.classList.contains('tu-anchored'));
  ok('...just below it, not across the page',
    px(root.style.top) >= save.getBoundingClientRect().bottom
    && px(root.style.top) < save.getBoundingClientRect().bottom + 40,
    `top ${root.style.top} for a target ending at 30px`);

  // Same element, now at the bottom of the window: below no longer fits.
  save.rect = { left: 600, top: 700, width: 100, height: 80 };
  h.close();
  h.start();
  btn(bubble, 'Next').click();
  const bot = px(root.style.top) + 20;         // the stub's box is 20 tall
  ok('...and flips ABOVE it when below would fall off the screen', bot <= 700,
    `bottom of the bubble at ${bot}px, target starts at 700px`);
  ok('...never covering the thing it is ringing', bot <= 700 || px(root.style.top) >= 780);

  h.close();
  ok('closing puts Slowking back in the corner',
    !root.classList.contains('tu-anchored') && !root.style.left);
  h.start();
  btn(bubble, 'Next').click();
  h.helpHere();
  ok('...and so does asking for help mid-tour', !root.classList.contains('tu-anchored'),
    'the tip is about the tab, not about one element');
  h.close();
  root.remove();
}

// =========================================================================
console.log('\n── the rules the CSS has to keep');
{
  const css = fs.readFileSync(path.join(ROOT, 'app/css/tutor.css'), 'utf8');
  const rule = (sel) => {
    const i = css.indexOf(`${sel} {`);
    return i < 0 ? '' : css.slice(i, css.indexOf('}', i));
  };
  // THE SPOTLIGHT COVERS THE VIEWPORT. A full-area layer taking clicks has
  // broken this app twice, and here it would swallow the very button the tour
  // is telling you to press.
  ok('the spotlight never takes a click', /pointer-events: none/.test(rule('.tu-spot')));
  /* THE DIM LAYER IS A SIBLING OF THE BUBBLE, so its z-index is measured
     against the bubble and not against the app -- .tu-root already lifts the
     whole subtree. At 68 against the bubble's `auto` it painted over the very
     sentence it existed to spotlight. */
  const z = (sel) => Number(/z-index: *(-?\d+)/.exec(rule(sel))?.[1] ?? NaN);
  ok('...and it dims the page UNDER the words, not over them',
    z('.tu-spot') < z('.tu-me, .tu-bubble'),
    `spot ${z('.tu-spot')} < bubble ${z('.tu-me, .tu-bubble')}`);
  ok('...which needs the bubble positioned, or a z-index on it does nothing',
    /position: relative/.test(rule('.tu-me, .tu-bubble')));
  ok('...and it is a real element, so it is not caught by the ::before check',
    !/\.tu-spot::/.test(css), 'asserted here instead');
  // Filled accent: the measured pair, never --ember with a white.
  ok('the primary bubble button uses the measured accent pair',
    /--fx-go-bg/.test(rule('.tu-btn.go')) && /--fx-go-ink/.test(rule('.tu-btn.go'))
    && !/#fff/i.test(rule('.tu-btn.go')));
  // Slowking must not stand on the easter egg.
  const theme = fs.readFileSync(path.join(ROOT, 'app/css/theme.css'), 'utf8');
  const balls = /\.pb-stack \{([^}]*)\}/.exec(theme)?.[1] ?? '';
  ok('Slowking is bottom-left and the Poké Balls are bottom-right',
    /left: 16px/.test(rule('.tu-root')) && /right: 16px/.test(balls),
    'a mascot standing on the easter egg would be the first bug reported');
  // No looping idle. This is the rule a mascot lives or dies by.
  ok('nothing about Slowking animates forever',
    !/animation:/.test(css) && !/infinite/.test(css),
    'and with a still sprite there is no ambient motion left at all');
  ok('...and reduced motion turns even the transitions off',
    /@media \(prefers-reduced-motion: reduce\)/.test(css));
}

console.log(failed ? `\n  ${failed} check(s) FAILED` : '\n  all checks passed');
process.exit(failed ? 1 : 0);
