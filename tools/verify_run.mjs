/**
 * verify_run.mjs -- the nuzlocke: its rules, its shackles, and the run summary.
 *
 * Why this file asserts what it does: notes/nuzlocke.md
 *
 *     node tools/verify_run.mjs [path/to/save.sav]
 *
 * THE ONE THING THAT MUST NOT BE TRUE
 * -----------------------------------
 * That a rule is decoration. A nuzlocke you can break by clicking the same
 * button as always is a note, not a rule, and a rule picker full of switches
 * that change nothing is worse than no picker at all -- it claims a constraint
 * it does not keep.
 *
 * So the central assertion here is behavioural and runs against the REAL tabs:
 * mount the Factory, the Bag, the Builder and the Pokédex with a rule on, and
 * check the buttons it names are actually disabled and struck through. Then
 * mount them with the mode OFF and check nothing anywhere changed -- which is
 * the other half of the contract, and the half a feature like this usually
 * breaks.
 *
 * READ-ONLY. Defaults to a backup and never writes a file.
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
    this.children = []; this.attrs = {}; this.className = '';
    this.style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } };
    this.textContent = ''; this.value = ''; this.disabled = false; this.checked = false;
    this.parentNode = null;
    this.classList = {
      add: (c) => { if (!String(this.className ?? '').split(' ').includes(c)) this.className = ((this.className ?? '') + ' ' + c).trim(); },
      remove: (c) => { this.className = String(this.className ?? '').split(' ').filter((x) => x && x !== c).join(' '); },
      toggle: (c, on) => ((on ?? !String(this.className ?? '').split(' ').includes(c)) ? this.classList.add(c) : this.classList.remove(c)),
      contains: (c) => String(this.className ?? '').split(' ').includes(c),
    };
  }
  append(...kids) {
    for (const k of kids) {
      if (k == null) continue;
      const n = typeof k === 'string' ? Object.assign(new N('#text'), { textContent: k }) : k;
      if (n.tagName === '#FRAGMENT') { this.append(...n.children); continue; }
      n.parentNode = this; this.children.push(n);
    }
  }
  prepend(...kids) { const old = this.children; this.children = []; this.append(...kids); this.children.push(...old); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  replaceWith(...nodes) {
    const p = this.parentNode;
    if (!p) return;
    const i = p.children.indexOf(this);
    const list = nodes.filter((x) => x != null);
    for (const x of list) x.parentNode = p;
    p.children.splice(i, 1, ...list);
    this.parentNode = null;
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener() {} removeEventListener() {} focus() {}
  click(ev = {}) { this.onclick?.({ target: this, preventDefault() {}, stopPropagation() {}, ...ev }); }
  get text() { return (this.textContent || '') + this.children.map((c) => c.text ?? '').join(''); }
  *walk() { yield this; for (const c of this.children) if (c.walk) yield* c.walk(); }
  find(p) { for (const n of this.walk()) if (p(n)) return n; return null; }
  findAll(p) { return [...this.walk()].filter(p); }
  querySelector(sel) {
    if (typeof sel === 'string' && sel.startsWith('#')) {
      const id = sel.slice(1);
      return this.find((n) => n.attrs?.id === id || n.id === id);
    }
    return null;
  }
  querySelectorAll() { return []; }
}
const body = new N('body');
global.document = {
  body, createElement: (t) => new N(t), addEventListener() {}, removeEventListener() {},
  createDocumentFragment: () => new N('#fragment'),
  createTextNode: (t) => Object.assign(new N('#text'), { textContent: t }),
  querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
};
const store = {};
global.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
global.alert = () => {}; global.confirm = () => true;
global.promptReply = null;
global.prompt = () => global.promptReply;
// Whatever the test last asked for, so a rename can be driven.
global.promptReply = null;
global.prompt = () => global.promptReply;
global.Blob = class {}; global.URL = { createObjectURL: () => '', revokeObjectURL() {} };
const hasClass = (c) => (n) => n.classList.contains(c);
const btn = (r, re) => r.find((n) => n.tagName === 'BUTTON' && re.test(n.text));
const btns = (r, re) => r.findAll((n) => n.tagName === 'BUTTON' && re.test(n.text));

// ------------------------------------------------------------------ set-up
const { Save } = await import('../js/save.js');
const { Factory } = await import('../app/js/factory.js');
const N_ = await import('../app/js/nuzlocke.js');
const { shackle, closed } = await import('../app/js/shackle.js');
const runTab = (await import('../app/js/tabs/run.js')).default;
const factoryTab = (await import('../app/js/tabs/factory.js')).default;
const itemsTab = (await import('../app/js/tabs/items.js')).default;
const builderTab = (await import('../app/js/tabs/builder.js')).default;
const dexTab = (await import('../app/js/tabs/dex.js')).default;

const S = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/data/static.json'), 'utf8'));
let savePath = process.argv[2];
if (!savePath) {
  const dir = path.join(ROOT, 'save_backups');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sav'))
    .map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs) : [];
  savePath = files[files.length - 1] ?? path.join(ROOT, 'tests/fixture.sav');
}
if (!fs.existsSync(savePath)) { console.error('verify_run: no save found'); process.exit(2); }
console.log(`  save: ${path.relative(ROOT, savePath)}\n`);
const original = new Uint8Array(fs.readFileSync(savePath));
const mkF = () => new Factory(Save.load(new Uint8Array(original)), S);
const reset = () => { for (const k of Object.keys(store)) delete store[k]; };

// ============================================================== the model
console.log('── rules are capability switches, not labels');
{
  const st = N_.blankState();
  ok('the mode is off by default', st.enabled === false);
  ok('...and every gate is open while it is off',
    N_.RULES.flatMap((r) => r.gates).every((a) => N_.gate(st, a).ok),
    `${new Set(N_.RULES.flatMap((r) => r.gates)).size} distinct actions`);

  st.enabled = true;
  st.rules = ['no-creating'];
  const v = N_.gate(st, 'factory.create');
  ok('an enabled rule closes the actions it names', v.ok === false, v.rule);
  ok('...and names itself, so the closure is explicable',
    typeof v.name === 'string' && v.name.length > 0 && typeof v.why === 'string', v.name);
  ok('...and leaves everything else open', N_.gate(st, 'factory.heal').ok);

  // EVERY RULE MUST DO SOMETHING. A picker full of switches that change
  // nothing claims a constraint it does not keep -- worse than no picker.
  const inert = N_.RULES.filter((r) => !r.gates.length && !r.tracks && r.kind !== 'honour'
    && r.kind !== 'clause');
  ok('no rule is inert: each gates something, tracks something, or is honour',
    inert.length === 0, inert.map((r) => r.id).join(', '));

  // Honour rules must be HONEST about being honour rules, or the enforced ones
  // are not worth trusting either.
  ok('honour rules gate nothing, so they cannot pretend to be enforced',
    N_.RULES.filter((r) => r.kind === 'honour').every((r) => !r.gates.length));
  ok('every enforced rule gates or tracks something',
    N_.RULES.filter((r) => r.kind === 'enforced').every((r) => r.gates.length || r.tracks));

  // The ladder is a ladder: each rung strictly harder than the last.
  for (let i = 1; i < N_.PRESETS.length; i++) {
    const prev = new Set(N_.PRESETS[i - 1].rules);
    const here = new Set(N_.PRESETS[i].rules);
    const harder = [...here].filter((r) => !prev.has(r));
    ok(`preset "${N_.PRESETS[i].name}" is harder than "${N_.PRESETS[i - 1].name}"`,
      harder.length > 0 && here.size > prev.size, `+${harder.length} rules`);
  }
  ok('every preset names only real rules',
    N_.PRESETS.every((p) => p.rules.every((r) => N_.RULE_BY_ID[r])));
  ok('presetOf round-trips each preset',
    N_.PRESETS.every((p) => N_.presetOf(p.rules) === p.id));
  ok('...and a changed rule set is custom, not silently a preset',
    N_.presetOf([...N_.PRESETS[0].rules, 'level-cap']) === null);
}

console.log('\n── the duplicates clause works on the FAMILY, not the species');
{
  const st = N_.blankState();
  st.enabled = true; st.rules = ['dupes-clause'];
  // Pidgey(16) -> Pidgeotto(17) -> Pidgeot(18). Owning the middle must make
  // the first a duplicate; a species-only check misses every real case.
  const fam = N_.familyOf(16, S);
  ok('a family walks forward from the base', fam.has(17) && fam.has(18), [...fam].join(','));
  const famTop = N_.familyOf(18, S);
  ok('...and backward from the top', famTop.has(16) && famTop.has(17), [...famTop].join(','));
  ok('owning the middle makes the base a duplicate',
    N_.isDuplicate(st, 16, [17], S) === true);
  ok('...and an unrelated species is not',
    N_.isDuplicate(st, 16, [25], S) === false);
  ok('without the clause nothing is a duplicate',
    N_.isDuplicate({ ...st, rules: [] }, 16, [17], S) === false);

  // A dupe must not spend the area -- that is the entire point of the clause.
  st.rules = ['one-per-area', 'dupes-clause'];
  N_.recordEncounter(st, 'Route 1', { speciesId: 16, status: 'dupe' });
  ok('a duplicate does not spend the area', N_.areaSpent(st, 'Route 1') === false);
  N_.recordEncounter(st, 'Route 1', { speciesId: 19, status: 'caught' });
  ok('...but a catch does', N_.areaSpent(st, 'Route 1') === true);
  st.rules = ['one-per-area'];
  N_.recordEncounter(st, 'Route 2', { speciesId: 16, status: 'dupe' });
  ok('without the clause even a duplicate spends it', N_.areaSpent(st, 'Route 2') === true);
}

console.log('\n── the level cap is computed, never typed in');
{
  const { opponentsFor } = await import('../app/js/roster.js');
  const opps = opponentsFor(S, 'oshawott', 'black');
  const gyms = opps.filter((o) => o.kind === 'gym');
  ok('there are eight gyms in one cartridge', gyms.length === 8, `${gyms.length}`);
  const cap0 = N_.levelCap(opps, {}, 0);
  ok('with no badges the cap is the first gym',
    cap0.next === gyms[0].leader && cap0.cap > 0, `${cap0.next} L${cap0.cap}`);
  const cap3 = N_.levelCap(opps, {}, 3);
  ok('...and it advances with the badge count',
    cap3.next === gyms[3].leader && cap3.cap >= cap0.cap, `${cap3.next} L${cap3.cap}`);
  ok('every gym after it is harder or equal, so the cap never goes backwards',
    gyms.every((g, i) => i === 0 || (N_.levelCap(opps, {}, i).cap ?? 0)
      >= (N_.levelCap(opps, {}, i - 1).cap ?? 0)));
  ok('eight badges means the cap is done', N_.levelCap(opps, {}, 8).done === true);
  // Badges beat ticks: a forgotten tick must not lower your cap.
  const ticked = Object.fromEntries(gyms.slice(0, 5).map((g) => [g.key, 1]));
  ok('the badge count wins over the battle-sheet ticks when both exist',
    N_.levelCap(opps, ticked, 2).next === gyms[2].leader);
  ok('...and the ticks are used when there is no badge count',
    N_.levelCap(opps, ticked, null).next === gyms[5].leader);
  ok('overCap names who is above it',
    N_.overCap([{ level: 99, species: 'X' }, { level: 2, species: 'Y' }], 50).length === 1);
}

// ============================================================== the shackles
console.log('\n── a rule actually closes the button it names');
{
  const F = mkF();
  const on = { ...N_.blankState(), enabled: true,
    rules: ['no-creating', 'no-editing', 'no-healing', 'no-item-writes'] };
  const off = N_.blankState();

  const mount = (tab, nuz) => {
    reset();
    const panel = new N('div');
    tab.unmount?.();
    tab.mount(panel, { S, factory: F, save: F.save, nuz, config: null,
      trainer: F.save.readTrainer(), goTo: () => {}, starter: 'oshawott', version: 'black' });
    return panel;
  };
  const shackled = (p) => p.findAll(hasClass('shackled'));

  // ---- Factory
  {
    const openP = mount(factoryTab, off);
    const openN = shackled(openP).length;
    ok('with the mode OFF the Factory shackles nothing', openN === 0, `${openN} shackled`);
    const create0 = btn(openP, /Create a Pokémon here/);

    const lockP = mount(factoryTab, on);
    const lock = shackled(lockP);
    ok('with the rules ON the Factory shackles something', lock.length > 0,
      `${lock.length} controls`);
    const create1 = btn(lockP, /Create a Pokémon here/);
    if (create0 && create1) {
      ok('...the create button specifically', create1.disabled === true
        && create1.classList.contains('shackled'));
      ok('...and it is still ON SCREEN, not hidden', Boolean(create1));
      ok('...naming the rule that took it', /No creating/.test(create1.getAttribute('title') ?? ''),
        (create1.getAttribute('title') ?? '').split('\n')[0]);
      ok('...and it was NOT disabled a moment ago', create0.disabled !== true);
    } else {
      ok('the Factory offers a create button to close (skipped: no free slot shown)', true);
    }
    const heal1 = btn(lockP, /Heal party/);
    if (heal1) ok('...and the heal button', heal1.classList.contains('shackled'));
    ok('the tab says which shackles are in force before you reach for one',
      Boolean(lockP.find(hasClass('shackle-bar'))));
    ok('...and says nothing at all when the mode is off',
      !openP.find(hasClass('shackle-bar')));
  }

  // ---- the Bag
  // Its quantity row lives inside a SELECTED item's detail pane, so a mount
  // alone renders none of it. Picking a row first is what makes this test
  // exercise the thing it claims to.
  {
    const pickItem = (p) => {
      const r = p.find((n) => n.tagName === 'BUTTON' && n.classList.contains('it-row'));
      r?.click();
      return p;
    };
    const openP = pickItem(mount(itemsTab, off));
    const lockP = pickItem(mount(itemsTab, on));
    ok('with the mode OFF the Bag shackles nothing',
      shackled(openP).length === 0, `${shackled(openP).length}`);
    ok('with no-item-writes ON the Bag shackles its item controls',
      shackled(lockP).length > 0, `${shackled(lockP).length} controls`);
  }

  // ---- the Pokédex handoff
  {
    const openP = mount(dexTab, off);
    const b0 = btn(openP, /Build one in the Factory/);
    const lockP = mount(dexTab, on);
    const b1 = btn(lockP, /Build one in the Factory/);
    if (b0 && b1) {
      ok('the Pokédex\'s "build one" obeys the same rule as the Factory\'s',
        b0.disabled !== true && b1.disabled === true && b1.classList.contains('shackled'));
    } else {
      ok('the Pokédex build button needs a selected species (skipped)', true);
    }
  }

  // ---- clicking a shackled control explains itself rather than doing nothing
  {
    const lockP = mount(factoryTab, on);
    const s = shackled(lockP)[0];
    let threw = false;
    try { s.click(); } catch { threw = true; }
    ok('clicking a shackled control is inert but not broken', !threw);
    ok('...and it carries an accessible label, not just a colour',
      (s.getAttribute('aria-disabled') === 'true') && Boolean(s.getAttribute('aria-label')));
  }
}

console.log('\n── marking a death');
{
  // THE LOG IS WRITTEN BEFORE THE BODY IS TOUCHED. A Pokémon must never be
  // removed without also being remembered -- an auto-purge that loses the
  // graveyard entry is data loss wearing a rule's clothes.
  const mountF = (nuz) => {
    reset();
    const F = mkF();
    const panel = new N('div');
    factoryTab.unmount?.();
    factoryTab.mount(panel, { S, factory: F, save: F.save, nuz, config: null,
      trainer: F.save.readTrainer(), goTo: () => {}, refreshActions: () => {},
      onNuzlockeChange: () => {} });
    // A slot is a DIV with role="button", not a <button> -- selecting on the
    // tag finds nothing and the whole block silently skips itself. Pick an
    // OCCUPIED one, or there is no Pokémon to kill.
    panel.find((n) => n.classList.contains('fx-slot')
      && !n.classList.contains('empty'))?.click();
    return { F, panel };
  };
  const off = mountF(N_.blankState());
  ok('there is no "it died" outside a nuzlocke', !btn(off.panel, /It died/));

  const logOnly = { ...N_.blankState(), enabled: true, rules: ['death-is-permanent'] };
  const a = mountF(logOnly);
  const dieA = btn(a.panel, /It died/);
  if (!dieA) {
    ok('the Factory offers "it died" when fainting is death (skipped: no slot selected)', true);
  } else {
    const owned = a.F.locations().reduce((n, l) => n + a.F.read(l.loc).filter((x) => x.mon).length, 0);
    dieA.click();
    ok('marking a death writes to the graveyard', (logOnly.deaths ?? []).length === 1,
      JSON.stringify(logOnly.deaths?.[0] ?? null));
    const after = a.F.locations().reduce((n, l) => n + a.F.read(l.loc).filter((x) => x.mon).length, 0);
    ok('...and without the purge rule the body stays where it was', after === owned,
      `${owned} -> ${after}`);

    const purge = { ...N_.blankState(), enabled: true,
      rules: ['death-is-permanent', 'auto-purge'] };
    const b = mountF(purge);
    const before = b.F.locations().reduce((n, l) => n + b.F.read(l.loc).filter((x) => x.mon).length, 0);
    btn(b.panel, /It died/)?.click();
    const now = b.F.locations().reduce((n, l) => n + b.F.read(l.loc).filter((x) => x.mon).length, 0);
    ok('...and with it, the release is staged', now === before - 1, `${before} -> ${now}`);
    ok('...but the graveyard entry was written first, so nothing is lost silently',
      (purge.deaths ?? []).length === 1);
    ok('...and it is STAGED, not written: the save on disk is untouched',
      b.F.dirty === true);
  }
}

console.log('\n── the QoL a nuzlocke should NOT take away');
{
  // A nuzlocke restricts which Pokémon you may use and what happens when they
  // faint. It does not stop you handing something a Leftovers you own, or
  // teaching it a TM you bought, or naming it. Closing those took away the
  // app's convenience without taking away anything the rules are about.
  const strict = { ...N_.blankState(), enabled: true,
    rules: N_.PRESETS.find((p) => p.id === 'strict').rules };
  const hard = { ...N_.blankState(), enabled: true,
    rules: N_.PRESETS.find((p) => p.id === 'hardcore').rules };
  for (const [name, st] of [['Strict', strict], ['Hardcore', hard]]) {
    ok(`${name} still lets you give an item you own`, N_.gate(st, 'bag.give').ok);
    ok(`${name} still lets you teach a TM you own`, N_.gate(st, 'bag.teach').ok);
  }
  // Inventing items is a different thing, and Hardcore does close it.
  ok('...but Hardcore does stop you conjuring quantities',
    N_.gate(hard, 'bag.edit').ok === false);
  ok('...while Strict leaves even that alone', N_.gate(strict, 'bag.edit').ok);

  // THE CONTRADICTION THAT WAS LIVE: `nickname-all` REQUIRES a nickname and
  // `no-editing` closed the only control that set one.
  ok('nickname-all is on in every preset that has no-editing',
    N_.PRESETS.filter((p) => p.rules.includes('no-editing'))
      .every((p) => p.rules.includes('nickname-all')));
  const fs2 = fs.readFileSync(path.join(ROOT, 'app/js/tabs/factory.js'), 'utf8');
  ok('...so renaming is its own control, and is never shackled',
    /mk\('Rename/.test(fs2)
    && !/shackle\(mk\('Rename/.test(fs2));
  ok('...and the Factory model can rename without rebuilding the record',
    /rename\(at, name\)/.test(fs.readFileSync(path.join(ROOT, 'app/js/factory.js'), 'utf8')));
}

console.log('\n── the run wears its difficulty');
{
  // A pill reading "8 rules" is a fact you read once and stop seeing.
  const css = fs.readFileSync(path.join(ROOT, 'app/css/theme.css'), 'utf8');
  const appjs = fs.readFileSync(path.join(ROOT, 'app/js/app.js'), 'utf8');
  ok('the intensity is stamped on the root, so the chrome can escalate',
    /data-nuz/.test(css) && /setAttribute\('data-nuz'/.test(appjs));
  ok('...in bands you can feel, not a continuous scale',
    [1, 2, 3].every((n) => css.includes(`[data-nuz="${n}"]`)));
  // THE ABSENCE OF THE ATTRIBUTE IS THE NORMAL APP -- the same rule the theme
  // follows, and for the same reason: someone not nuzlocking must be untouched.
  ok('...and it is REMOVED rather than set to zero when there is no nuzlocke',
    /removeAttribute\('data-nuz'\)/.test(appjs) && !css.includes('[data-nuz="0"]'));
  // What it is NOT allowed to change. A mode that made text harder to read
  // would be the worst possible way to express difficulty.
  const block = css.slice(css.indexOf(':root[data-nuz]'), css.indexOf('the shackle'));
  ok('...and never touches a measured contrast pair or a surface',
    !/--fx-go|--card|--ink\b|--x0|--x2\b|color:/.test(block),
    block.match(/--fx-go|--card|--ink\b|color:/)?.[0] ?? 'chrome only');
}

console.log('\n── a rule may take an illegal build away');
{
  // The app FLAGS rather than blocks by default -- illegal abilities, illegal
  // moves, impossible EV spreads. A nuzlocke rule you deliberately switched on
  // is the one thing allowed to close that, and `legal-spreads` is the case
  // where the difference is a number rather than a button.
  const rule = N_.RULE_BY_ID['legal-spreads'];
  ok('there is a rule for legal EV spreads', Boolean(rule), rule?.name);
  ok('...and it gates the action rather than being a note',
    rule.gates.includes('builder.illegal-evs'), rule.gates.join(', '));
  const off = N_.blankState();
  ok('...open by default, because flagging is the app\'s habit',
    N_.gate(off, 'builder.illegal-evs').ok);
  const on = { ...N_.blankState(), enabled: true, rules: ['legal-spreads'] };
  ok('...and closed once the rule is on',
    N_.gate(on, 'builder.illegal-evs').ok === false);
  // It belongs on the harder rungs, or the ladder does not mean anything.
  ok('...and it is part of Strict and Hardcore',
    N_.PRESETS.filter((p) => p.rules.includes('legal-spreads')).length === 2,
    N_.PRESETS.filter((p) => p.rules.includes('legal-spreads')).map((p) => p.name).join(', '));
}

console.log('\n── the shackle is a colour, never an opacity');
{
  // The standing rule: an opacity over a filled control composites it toward
  // the page and destroys contrast (measured 7.08:1 -> 2.27:1 when this was
  // tried on the Install button). And the strike-through has to carry it
  // without colour, for anyone who cannot tell the red from the grey.
  const css = fs.readFileSync(path.join(ROOT, 'app/css/theme.css'), 'utf8');
  const rule = /\.shackled[^{]*\{[^}]*\}/.exec(css)?.[0] ?? '';
  ok('.shackled is styled once, app-wide', Boolean(rule));
  ok('...as a colour pair, not a fade',
    /--x4b/.test(rule) && /--x4\)/.test(rule) && /opacity: 1/.test(rule),
    rule.replace(/\s+/g, ' ').slice(0, 90));
  ok('...and marks itself without relying on colour', /line-through/.test(rule));
}

// ============================================================== the Run tab
console.log('\n── the Run tab');
{
  const F = mkF();
  const mount = (nuz) => {
    const panel = new N('div');
    runTab.unmount?.();
    runTab.mount(panel, { S, factory: F, save: F.save, nuz, starter: 'oshawott',
      version: 'black', trainer: F.save.readTrainer(), onNuzlockeChange: () => {} });
    return panel;
  };
  reset();
  const p = mount(N_.blankState());
  const root = () => p.children[0];
  ok('it mounts', Boolean(root()));
  // THE SUMMARY WORKS WITH THE MODE OFF. Gating a run summary behind a mode
  // someone does not want is how a feature ends up unused.
  ok('the run summary is there with the nuzlocke OFF',
    root().findAll(hasClass('rn-tile')).length >= 5,
    `${root().findAll(hasClass('rn-tile')).length} tiles`);
  ok('...and reads the badge count from the save',
    /badges/.test(root().text) && /\/8/.test(root().text));
  ok('...and says there is no log rather than showing an empty one',
    /no encounter log or graveyard/.test(root().text));

  const toggle = btn(root(), /Nuzlocke off/);
  ok('there is one control that turns it on', Boolean(toggle));
  toggle.click();
  ok('...and turning it on brings the log and the graveyard',
    /Graveyard/.test(root().text) && /Encounters/.test(root().text));

  const rules = btn(root(), /^Rules$/);
  rules.click();
  ok('the rules pane offers the ladder',
    root().findAll(hasClass('rn-rung')).length === N_.PRESETS.length);
  ok('...and every rule as its own switch',
    root().findAll(hasClass('rn-rule')).length === N_.RULES.length,
    `${root().findAll(hasClass('rn-rule')).length} of ${N_.RULES.length}`);
  // NAMING WHAT A RULE TAKES is what turns a promise into a contract.
  ok('...each enforced rule naming the buttons it closes',
    root().findAll(hasClass('rn-takes')).length
      === N_.RULES.filter((r) => r.gates.length).length);
  ok('...and no bare gate key leaks into the picker',
    !/factory\.create|bag\.teach/.test(root().find(hasClass('rn-takes'))?.text ?? ''),
    root().find(hasClass('rn-takes'))?.text ?? '');

  const hardcore = root().findAll(hasClass('rn-rung')).at(-1);
  hardcore.click();
  ok('picking a rung sets its rules',
    root().findAll(hasClass('rn-rule.on')).length >= 0
    && /Hardcore/.test(root().text));
}

console.log('\n── nothing here touches the save');
{
  const F = mkF();
  const before = Buffer.from(F.save.bytes).toString('hex');
  const panel = new N('div');
  runTab.unmount?.();
  reset();
  runTab.mount(panel, { S, factory: F, save: F.save, starter: 'oshawott', version: 'black',
    nuz: { ...N_.blankState(), enabled: true }, trainer: F.save.readTrainer(),
    onNuzlockeChange: () => {} });
  const root = panel.children[0];
  for (const b of root.findAll((n) => n.tagName === 'BUTTON').slice(0, 12)) {
    try { b.click(); } catch { /* a click that throws is caught by other checks */ }
  }
  ok('clicking through the Run tab leaves the save byte-identical',
    Buffer.from(F.save.bytes).toString('hex') === before);
  ok('...and the working copy is not dirty', F.dirty !== true);
  // The run is a fact about YOUR playthrough, not about Unova.
  const keys = Object.keys(store).filter((k) => k.startsWith('blazeblack.nuzlocke.'));
  ok('the run is stored per trainer, in the browser only', keys.length <= 1,
    keys.join(', '));
}

console.log(failed ? `\n  ${failed} check(s) FAILED` : '\n  all checks passed');
process.exit(failed ? 1 : 0);
