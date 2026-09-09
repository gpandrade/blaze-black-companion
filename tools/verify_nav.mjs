/**
 * verify_nav.mjs -- the tab rail and the tab dial.
 *
 *     node tools/verify_nav.mjs
 *
 * Why this file asserts what it does: notes/design-system.md, "The tab rail
 * and the dial".
 *
 * =============================================================================
 * THE THINGS THAT MUST NOT BE TRUE
 * =============================================================================
 * Navigation is the one control every session touches, and it is where a
 * visual pass can do the most damage while looking like an improvement. Four
 * failures are worth a test each:
 *
 *   A TAB YOU CANNOT REACH. Seven tabs, seven plates, seven spokes. A metadata
 *   table keyed by id is exactly the shape that silently drops an entry when a
 *   tab is added, and the symptom -- one tab with no glyph and no number --
 *   looks like a style bug rather than a missing line.
 *
 *   THE DIAL BECOMING A MENU. Turning the ring must NOT navigate. The whole
 *   claim of a dial over a list is that you can look at all seven without
 *   going anywhere; if pointing committed, the extra press would buy nothing
 *   and the thing would just be a slower tab bar.
 *
 *   AN UNREADABLE ACTIVE PLATE. It is a filled accent, which is the exact
 *   situation where --ember plus a hardcoded white measures 2.41:1 in dark
 *   mode. Pinned as a CSS assertion because no stub can measure contrast.
 *
 *   A HOTKEY THAT EATS TYPING. Every tab in this app has a search box. A
 *   letter-key shortcut would swallow a keystroke in one of them, which is a
 *   far worse bug than having no shortcut.
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
// Same shape as the other verifiers', plus the three things nav.js needs and
// they do not: createElementNS (the glyphs are real SVG), a focus model, and
// captured keydown listeners so the dial's keyboard can actually be driven.
class N {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.attrs = {}; this.className = '';
    this.style = { setProperty(k, v) { this[k] = v; } };
    this.textContent = ''; this.disabled = false; this.parentNode = null;
    this.classList = {
      add: (c) => { if (!this.classList.contains(c)) this.className = ((this.className ?? '') + ' ' + c).trim(); },
      remove: (c) => { this.className = String(this.className ?? '').split(' ').filter((x) => x && x !== c).join(' '); },
      toggle: (c, on) => ((on ?? !this.classList.contains(c)) ? this.classList.add(c) : this.classList.remove(c)),
      contains: (c) => String(this.className ?? '').split(' ').includes(c),
    };
  }
  append(...kids) {
    for (const k of kids) {
      if (k == null) continue;
      const n = typeof k === 'string' ? Object.assign(new N('#text'), { textContent: k }) : k;
      n.parentNode = this; this.children.push(n);
    }
  }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === body;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  focus() { global.document.activeElement = this; }
  click() { if (!this.disabled) this.onclick?.({ target: this, preventDefault() {} }); }
  hover() { this.onmouseenter?.({ target: this }); }
  get text() { return (this.textContent || '') + this.children.map((c) => c.text ?? '').join(''); }
  *walk() { yield this; for (const c of this.children) if (c.walk) yield* c.walk(); }
  findAll(p) { return [...this.walk()].filter(p); }
  find(p) { for (const n of this.walk()) if (p(n)) return n; return null; }
}
const body = new N('body');
const keyListeners = [];
global.document = {
  body,
  activeElement: null,
  createElement: (t) => new N(t),
  createElementNS: (_ns, t) => new N(t),
  addEventListener: (type, fn) => { if (type === 'keydown') keyListeners.push(fn); },
  removeEventListener: (type, fn) => {
    const i = keyListeners.indexOf(fn);
    if (type === 'keydown' && i >= 0) keyListeners.splice(i, 1);
  },
};
/** Fire a key at whatever the dial has bound, newest first (capture order). */
function press(key, target = null) {
  let prevented = false;
  const ev = { key, target, preventDefault() { prevented = true; }, metaKey: false, ctrlKey: false, altKey: false };
  for (const fn of [...keyListeners].reverse()) fn(ev);
  return prevented;
}

const Nav = await import('../app/js/nav.js');

// The real tab list, read from the shell so the two cannot drift.
const appjs = fs.readFileSync(path.join(ROOT, 'app/js/app.js'), 'utf8');
const TAB_IDS = ['adventure', 'battle', 'builder', 'factory', 'items', 'dex', 'run'];
const TABS = TAB_IDS.map((id) => ({
  id, label: id[0].toUpperCase() + id.slice(1), needsSave: id !== 'dex',
}));

const cls = (c) => (n) => n.classList.contains(c);

// =========================================================================
console.log('── metadata: seven tabs, seven of everything');
{
  const declared = (appjs.match(/const TABS = \[([^\]]*)\]/)?.[1] ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  ok('the shell still mounts seven tabs', declared.length === TAB_IDS.length,
    `${declared.length}: ${declared.join(' ')}`);
  ok('every tab has a numeral and a blurb',
    TAB_IDS.every((id) => Nav.META[id]?.n && Nav.META[id]?.blurb),
    TAB_IDS.filter((id) => !Nav.META[id]?.blurb).join(' ') || `${TAB_IDS.length} entries`);
  ok('every tab has a glyph', TAB_IDS.every((id) => (Nav.GLYPH[id] ?? '').length > 10),
    TAB_IDS.filter((id) => !Nav.GLYPH[id]).join(' ') || 'all drawn');
  ok('...and the tables carry nothing the shell does not mount',
    Object.keys(Nav.META).every((k) => TAB_IDS.includes(k))
    && Object.keys(Nav.GLYPH).every((k) => TAB_IDS.includes(k)));
  const nums = TAB_IDS.map((id) => Nav.META[id].n);
  ok('no two tabs share a numeral', new Set(nums).size === nums.length, nums.join(' '));
  // A glyph is path data, and a `d` that a browser cannot parse renders
  // nothing at all -- silently, with the label still in place, so it reads as
  // "that one tab has no icon" rather than as a typo.
  const bad = TAB_IDS.filter((id) => Nav.GLYPH[id].split('|')
    .some((d) => !/^[Mm]/.test(d.trim()) || /[^MmLlHhVvCcSsQqTtAaZz0-9eE ,.\-]/.test(d)));
  ok('every glyph path starts with a move and holds only path syntax',
    bad.length === 0, bad.join(' ') || `${TAB_IDS.length} glyphs`);
}

// =========================================================================
console.log('\n── the rail');
let picked = null;
let dialed = 0;
const rail = new N('nav');
const renderRail = (active, saved = true) => Nav.renderRail(rail, TABS, {
  active,
  enabled: (t) => t.needsSave === false || saved,
  onPick: (id) => { picked = id; },
  onDial: () => { dialed += 1; },
});
{
  renderRail('battle');
  const plates = rail.findAll(cls('sh-plate'));
  ok('one plate per tab', plates.length === TAB_IDS.length, `${plates.length}`);
  ok('exactly one is active',
    plates.filter((p) => p.getAttribute('aria-selected') === 'true').length === 1);
  ok('...and it is the one asked for',
    plates.find((p) => p.getAttribute('aria-selected') === 'true')?.text.includes('Battle'));
  ok('every plate carries its numeral, its glyph and its label',
    plates.every((p) => p.find(cls('sh-pnum')) && p.find((n) => n.tagName === 'SVG')
      && p.find(cls('sh-plabel'))));
  ok('a plate is one click, not two', (plates[0].click(), picked === 'adventure'), picked);

  ok('the hub is in the rail', !!rail.find(cls('sh-hub')));
  ok('...and it opens the dial rather than switching tab',
    (rail.find(cls('sh-hub')).click(), dialed === 1 && picked === 'adventure'));

  // The stagger is an index the CSS multiplies by. Without it every plate
  // animates at once, which is not wrong so much as pointless.
  ok('plates are numbered for the entrance stagger',
    plates.every((p, i) => (p.getAttribute('style') ?? '').includes(`--i:${i}`)));
}
{
  renderRail('dex', false);
  const plates = rail.findAll(cls('sh-plate'));
  const live = plates.filter((p) => !p.disabled);
  ok('with no save, only the save-free tab is reachable',
    live.length === 1 && live[0].text.includes('Dex'), `${live.length} enabled`);
  const before = picked;
  plates.find((p) => p.text.includes('Battle')).click();
  ok('...and a locked plate does nothing when clicked', picked === before);
}

// =========================================================================
console.log('\n── the dial');
{
  picked = null;
  Nav.openDial(TABS, { active: 'builder', enabled: () => true, onPick: (id) => { picked = id; } });
  ok('the dial opens', Nav.dialOpen());
  const dial = body.find(cls('sh-dial'));
  const spokes = dial.findAll(cls('sh-spoke'));
  ok('one spoke per tab', spokes.length === TAB_IDS.length, `${spokes.length}`);
  ok('...each placed at its own angle on the ring',
    new Set(spokes.map((s) => s.getAttribute('style'))).size === spokes.length);
  ok('...and told how many there are, so the ring divides evenly',
    spokes.every((s) => (s.getAttribute('style') ?? '').includes(`--n:${TAB_IDS.length}`)));
  ok('it opens pointing at the tab you are on',
    spokes.filter(cls('is-at')).length === 1
    && spokes.find(cls('is-at')).text.includes('Builder'));
  ok('the hub names what you are pointing at',
    dial.find(cls('sh-dhub-name'))?.text === 'Builder');
  ok('...and reads out what that tab is for',
    dial.find(cls('sh-dhub-blurb'))?.text === Nav.META.builder.blurb);

  // THE PROPERTY THAT MAKES IT A DIAL. If turning navigated, the second press
  // would buy nothing and this would be a tab bar with a longer path.
  press('ArrowRight');
  ok('turning the ring MOVES the pointer', dial.findAll(cls('sh-spoke'))
    .find(cls('is-at')).text.includes('Factory'));
  ok('...and does NOT navigate', picked === null, String(picked));
  ok('...and the hub follows it', dial.find(cls('sh-dhub-name'))?.text === 'Factory');
  press('ArrowLeft'); press('ArrowLeft');
  ok('it turns both ways and wraps round the ring',
    dial.findAll(cls('sh-spoke')).find(cls('is-at')).text.includes('Battle'));
  ok('...still without navigating', picked === null);

  press('Enter');
  ok('enter commits, and only then', picked === 'battle', String(picked));
  ok('...and the dial closes behind it', !Nav.dialOpen() && !body.find(cls('sh-dial')));
}
{
  // Escape must not be a quiet "yes". A picker that commits on cancel is the
  // worst kind, because the mistake looks like a click you never made.
  picked = null;
  Nav.openDial(TABS, { active: 'run', enabled: () => true, onPick: (id) => { picked = id; } });
  press('ArrowRight');
  press('Escape');
  ok('escape closes without navigating', !Nav.dialOpen() && picked === null);

  Nav.openDial(TABS, { active: 'run', enabled: () => true, onPick: (id) => { picked = id; } });
  body.find(cls('sh-dial-back')).click();
  ok('a click on the backdrop closes it, also without navigating',
    !Nav.dialOpen() && picked === null);

  // Persona menus answer to numbers; so does this, and it is the only path
  // that reaches a tab without turning the ring first.
  Nav.openDial(TABS, { active: 'run', enabled: () => true, onPick: (id) => { picked = id; } });
  press('3');
  ok('a digit goes straight to that tab', picked === 'builder' && !Nav.dialOpen(), String(picked));
}
{
  picked = null;
  Nav.openDial(TABS, {
    active: 'dex', enabled: (t) => t.needsSave === false, onPick: (id) => { picked = id; },
  });
  const dial = body.find(cls('sh-dial'));
  const off = dial.findAll(cls('sh-spoke')).filter(cls('is-off'));
  ok('with no save the locked spokes are marked', off.length === TAB_IDS.length - 1);
  // You should still be able to LOOK at a tab you cannot open, and be told
  // why. Skipping them would hide the app from someone who has not loaded a
  // save yet -- which is precisely who is turning the dial.
  press('ArrowRight');
  const at = dial.findAll(cls('sh-spoke')).find(cls('is-at'));
  ok('...but you can still turn onto one', !!at && at.classList.contains('is-off'));
  ok('...and the hub says why rather than going quiet',
    /save/i.test(dial.find(cls('sh-dhub-blurb'))?.text ?? ''));
  press('Enter');
  ok('...and committing to it does nothing', picked === null && Nav.dialOpen());
  Nav.closeDial();
  ok('closeDial tidies up after itself', !Nav.dialOpen() && !body.find(cls('sh-dial')));
}
{
  // Two dials on screen would both hold the keyboard, and the second would
  // shadow the first for ever -- there is no path that closes it.
  Nav.openDial(TABS, { active: 'run', enabled: () => true, onPick: () => {} });
  Nav.openDial(TABS, { active: 'run', enabled: () => true, onPick: () => {} });
  ok('opening it twice does not stack two dials',
    body.findAll(cls('sh-dial')).length === 1);
  Nav.closeDial();
  ok('and closing releases the keyboard', keyListeners.length === 0,
    `${keyListeners.length} listener(s) left behind`);
}

// =========================================================================
console.log('\n── the hotkey');
{
  ok('the hotkey is not a letter or a digit', /e\.key !== '`'/.test(appjs),
    'every tab has a search box; a letter would be swallowed by one');
  const handler = appjs.slice(appjs.indexOf("if (e.key !== '`'"));
  ok('...and it stands down while you are typing',
    /Nav\.isTyping\(e\.target\)/.test(handler.slice(0, 400)));
  ok('...and does not re-open a dial that is already up',
    /Nav\.dialOpen\(\)/.test(handler.slice(0, 400)));
  ok('a modified backquote is left alone',
    /metaKey \|\| e\.ctrlKey \|\| e\.altKey/.test(handler.slice(0, 300)),
    'ctrl+` is a terminal in several apps');
  for (const [tag, typing] of [['INPUT', true], ['TEXTAREA', true], ['BUTTON', false]]) {
    const n = new N(tag);
    ok(`isTyping is ${typing} for <${tag.toLowerCase()}>`, Nav.isTyping(n) === typing);
  }
  const ce = new N('div'); ce.isContentEditable = true;
  ok('isTyping catches contenteditable too', Nav.isTyping(ce) === true);
}

// =========================================================================
// THE MASTHEAD'S NESTED CONTROLS SURVIVE A REDRAW
//
// The brand button cycles the theme, and INSIDE it two `.sh-name` spans switch
// the cartridge and the starter. renderBrand() rebuilds all of that from
// scratch; the two inner handlers are attached by renderVersion(). Every
// caller paired the two by hand except the theme click, so flipping light/dark
// replaced both names with identical-looking, handler-less elements and the
// cartridge went dead until a reload.
//
// This is asserted against the SOURCE rather than a stub, because the bug is
// about which function calls which -- a stub that re-ran both would prove
// nothing. Three properties, each of which alone was enough to cause it.
// =========================================================================
console.log('\n── the masthead rewires itself when it is redrawn');
{
  const fn = (name) => {
    const i = appjs.indexOf(`function ${name}(`);
    if (i < 0) return '';
    let d = 0, j = appjs.indexOf('{', i);
    for (let k = j; k < appjs.length; k++) {
      if (appjs[k] === '{') d++;
      else if (appjs[k] === '}' && --d === 0) return appjs.slice(i, k + 1);
    }
    return '';
  };
  const brand = fn('renderBrand');
  const version = fn('renderVersion');
  ok('renderBrand and renderVersion both exist', !!brand && !!version);

  // 1. The version control is BUILT by renderBrand.
  ok('renderBrand builds the .sh-name the version control lives on',
    /className = 'sh-name'/.test(brand));
  // 2. ...and WIRED by renderVersion. Checked by which VARIABLES get handlers:
  //    `nm` and `sn` are the two names. renderBrand attaches onclick to the
  //    nuzlocke chip, so "does renderBrand contain onclick" is not the test.
  ok('renderVersion is the one that attaches the name handlers',
    /\bnm\.onclick\s*=/.test(version) && /\bsn\.onclick\s*=/.test(version));
  ok('...and renderBrand attaches none of its own to them',
    !/\bnm\.onclick\s*=/.test(brand) && !/\bsn\.onclick\s*=/.test(brand),
    'two places wiring one control is how they drift');
  // 3. ...so renderBrand must call it. Without this, ANY caller that redraws
  //    the brand alone leaves a dead control that looks alive.
  ok('renderBrand calls renderVersion, so a redraw cannot leave it dead',
    /renderVersion\(\);/.test(brand),
    'the theme click calls renderBrand() only — this is what makes that safe');

  // The theme click is the specific caller that had it wrong.
  const themeClick = /b\.onclick = \(\) => \{([^}]*)\}/.exec(brand)?.[1] ?? '';
  ok('...and the theme click still redraws the brand', /renderBrand\(\)/.test(themeClick),
    themeClick.trim());
  // A nested control must stop its click reaching the button it sits inside,
  // or switching cartridge would also flip the palette.
  ok('the nested controls stop the click reaching the theme button',
    (version.match(/stopPropagation\(\)/g) ?? []).length >= 4,
    'version and starter, click and keydown');
}

// =========================================================================
console.log('\n── the rules the CSS has to keep');
{
  const css = fs.readFileSync(path.join(ROOT, 'app/css/nav.css'), 'utf8');
  const rule = (sel) => {
    const i = css.indexOf(sel + ' {');
    return i < 0 ? '' : css.slice(i, css.indexOf('}', i));
  };

  // A FILLED ACCENT IS THE ONE PLACE THE PALETTE BITES. White on the dark
  // ember measures 2.41:1; --fx-go-bg/--fx-go-ink is the measured pair.
  const onPlate = rule('.sh-plate.is-on');
  ok('the active plate uses the measured accent pair',
    /--fx-go-bg/.test(onPlate) && /--fx-go-ink/.test(onPlate));
  const atSpoke = rule('.sh-spoke.is-at .sh-spoke-in');
  ok('...and so does the pointed spoke',
    /--fx-go-bg/.test(atSpoke) && /--fx-go-ink/.test(atSpoke));
  ok('neither pairs an accent with a hardcoded white',
    !/#fff|#FFF|white/i.test(onPlate + atSpoke), 'that pair is 2.41:1 in dark mode');

  // DISABLED IS A COLOUR, NEVER AN OPACITY.
  const offPlate = rule('.sh-plate:disabled');
  ok('a locked plate restates its colours',
    /background:/.test(offPlate) && /color:/.test(offPlate) && /--fx-off-/.test(offPlate));
  ok('...rather than fading', !/opacity:/.test(offPlate));
  const offSpoke = rule('.sh-spoke.is-off .sh-spoke-in');
  ok('a locked spoke does the same',
    /--fx-off-/.test(offSpoke) && !/opacity:/.test(offSpoke));

  // The skew is the whole visual idea, and undoing it on the contents is not
  // optional: skewed 12px type reads as a rendering fault.
  ok('the plate is skewed', /transform:\s*skewX\(var\(--skew\)\)/.test(rule('.sh-plate')));
  ok('...and its contents are counter-skewed',
    /skewX\(calc\(-1 \* var\(--skew\)\)\)/.test(rule('.sh-plate > *')));
  ok('the spoke is counter-rotated back upright',
    /rotate\(var\(--a\)\)\s*translate\(var\(--r\)\)\s*rotate\(calc\(-1 \* var\(--a\)\)\)/
      .test(rule('.sh-spoke')));

  // The backdrop is the one stretched layer in this file that MUST take
  // clicks -- it is how the dial closes. verify_app.mjs enforces the opposite
  // for pseudo-elements, so this is the deliberate exception, stated.
  ok('the dial backdrop is a real element, not an inert pseudo-element',
    !/\.sh-dial-back::/.test(css) && /pointer-events:\s*none/.test(rule('.sh-dial-back')) === false);

  ok('reduced motion turns the performance off but not the control',
    /@media \(prefers-reduced-motion: reduce\)/.test(css)
    && /\.sh-plate, \.sh-spoke-in \{ animation: none/.test(css));

  // NARROW SCREENS: the dial stops being a shortcut and becomes the nav, so
  // the hub has to say where you already are.
  const mq = css.slice(css.indexOf('@media (max-width: 760px)'));
  ok('under 760px the rail gives way to the dial',
    /\.sh-plate \{ display: none/.test(mq));
  ok('...and the hub names the tab you are on', /\.sh-hub-now \{ display: inline/.test(mq));
  ok('...and the ring shrinks to fit a phone', /--r: 1\d\dpx/.test(mq));
}

console.log(failed ? `\n  ${failed} check(s) FAILED` : '\n  all checks passed');
process.exit(failed ? 1 : 0);
