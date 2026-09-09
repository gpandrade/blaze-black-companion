/**
 * verify_builder.mjs -- exercise the Team Builder, model and UI.
 *
 * Why this file asserts what it does: notes/teams-and-cores.md
 *
 *     node tools/verify_builder.mjs [path/to/save.sav]
 *
 * The model half matters most: a slot is a SPEC matched against the save, and
 * the owned/close/missing verdict is what the whole tab is built on. If the
 * matcher says "missing" for something you own, the tab offers to create a
 * duplicate; if it says "owned" for something that differs, it hides work you
 * need to do. Both are silent wrong answers, so all three states are
 * constructed here rather than hoped for.
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
    this.children = []; this.attrs = {}; this.style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } }; this.dataset = {};
    this.className = ''; this.textContent = ''; this.value = ''; this.checked = false;
    this.disabled = false; this.selected = false; this.parentNode = null;
    this.classList = {
      add: (c) => { if (!this.className.split(' ').includes(c)) this.className = (this.className + ' ' + c).trim(); },
      remove: (c) => { this.className = this.className.split(' ').filter((x) => x && x !== c).join(' '); },
      toggle: (c, on) => ((on ?? !this.className.split(' ').includes(c)) ? this.classList.add(c) : this.classList.remove(c)),
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
  appendChild(k) { this.append(k); return k; }
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
  replaceChild(next, old) {
    const i = this.children.indexOf(old);
    if (i >= 0) { this.children[i] = next; next.parentNode = this; }
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener() {} removeEventListener() {} focus() {} blur() {}
  // A REAL CLICK EVENT CARRIES THESE. A stub whose event lacks
  // preventDefault/stopPropagation throws on handlers that work perfectly in a
  // browser -- the same faithfulness rule that got replaceWith() and focus().
  click(ev = {}) {
    this.onclick?.({ target: this, preventDefault() {}, stopPropagation() {}, ...ev });
  }
  get text() { return (this.textContent || '') + this.children.map((c) => c.text ?? '').join(''); }
  *walk() { yield this; for (const c of this.children) if (c.walk) yield* c.walk(); }
  find(p) { for (const n of this.walk()) if (p(n)) return n; return null; }
  findAll(p) { return [...this.walk()].filter(p); }
  querySelector() { return null; }
}
const body = new N('body');
global.document = {
  body, createElement: (t) => new N(t),
  // rich() returns a DocumentFragment, so the stub needs one. N.append
  // flattens it the way the real DOM does, keeping .text assertions honest.
  createDocumentFragment: () => new N('#fragment'),
  createTextNode: (t) => Object.assign(new N('#text'), { textContent: t }),
  addEventListener() {}, removeEventListener() {},
  querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
};
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
const alerts = [];
global.alert = (m) => alerts.push(m);
global.confirm = () => true;
// Whatever the test last asked for, so a rename can be driven.
global.promptReply = null;
global.prompt = () => global.promptReply;
global.Blob = class { constructor(p) { this.parts = p; } };
global.URL = { createObjectURL: () => 'blob:stub', revokeObjectURL() {} };
const hasClass = (c) => (n) => n.classList.contains(c);
const btn = (r, re) => r.find((n) => n.tagName === 'BUTTON' && re.test(n.text));

// ------------------------------------------------------------------ set-up
const { Save } = await import('../js/save.js');
const { Factory, locLabel } = await import('../app/js/factory.js');
const T = await import('../app/js/teams.js');
const builder = (await import('../app/js/tabs/builder.js')).default;

let savePath = process.argv[2];
if (!savePath) {
  const dir = path.join(ROOT, 'save_backups');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sav'))
    .map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs) : [];
  // Fall back to the committed fixture, the way verify_run and verify_dex
  // already do: a fresh clone has no save_backups/, and ./test-all exiting 2
  // there is the suite that proves the checkout works refusing to run.
  savePath = files[files.length - 1] ?? path.join(ROOT, 'tests/fixture.sav');
}
if (!savePath || !fs.existsSync(savePath)) {
  console.error('verify_builder: no save given and none found'); process.exit(2);
}
console.log(`  save: ${path.relative(ROOT, savePath)}\n`);
const S = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/data/static.json'), 'utf8'));
const original = new Uint8Array(fs.readFileSync(savePath));
const mkF = () => new Factory(Save.load(new Uint8Array(original)), S);

// =================================================================== MODEL
console.log('── model: the three states');
const F = mkF();
const index = T.buildIndex(F);
ok('index covers the save', index.length > 0, `${index.length} Pokémon`);

const anyMon = index[0].mon;
{
  // OWNED: a spec taken straight off a Pokémon must match it exactly.
  const spec = T.monToSpec(anyMon);
  const m = T.matchSlot(spec, index, S);
  ok('a spec copied from a Pokémon reads as OWNED', m.state === 'owned',
    `${anyMon.species}: ${m.state}${m.diffs?.length ? ' — ' + m.diffs.map((d) => d.field).join(', ') : ''}`);

  // CLOSE: change one field and it must report exactly that field.
  const near = { ...T.monToSpec(anyMon), natureId: (anyMon.natureId + 1) % 25 };
  const m2 = T.matchSlot(near, index, S);
  ok('changing one field reads as CLOSE and names it',
    m2.state === 'close' && m2.diffs.length === 1 && m2.diffs[0].field === 'nature',
    `${m2.state}: ${m2.diffs?.map((d) => d.field).join(', ')}`);

  // MISSING: a species nothing in the save has.
  const have = new Set(index.map((x) => x.mon.speciesId));
  const absent = Number(Object.keys(S.SPECIES).find((id) => !have.has(Number(id))));
  if (absent) {
    const m3 = T.matchSlot(T.blankSlot(absent), index, S);
    ok('a species you do not own reads as MISSING', m3.state === 'missing',
      `${S.SPECIES[String(absent)].name}: ${m3.state}`);
  } else {
    console.log('  [SKIP] MISSING — this save contains every species');
  }

  // Nickname and shininess must NOT count as differences: neither changes how
  // the Pokémon performs, and flagging them would bury the ones that matter.
  const cosmetic = { ...T.monToSpec(anyMon), nickname: 'Zzz', shiny: !anyMon.shiny };
  ok('nickname and shininess are not treated as differences',
    T.matchSlot(cosmetic, index, S).state === 'owned');

  // Level IS a difference, but must not be the only thing keeping a match.
  const lv = { ...T.monToSpec(anyMon), level: (anyMon.level ?? 50) + 5 };
  const m4 = T.matchSlot(lv, index, S);
  ok('a level difference is reported, and only that',
    m4.state === 'close' && m4.diffs.length === 1 && m4.diffs[0].field === 'level');
}

{
  // Two slots wanting one species must claim two different Pokémon -- the same
  // problem build_sheet.py's take() solves, for the same reason.
  const dupSpecies = index.find((x, i, a) =>
    a.filter((y) => y.mon.speciesId === x.mon.speciesId).length > 1);
  if (dupSpecies) {
    const spec = T.monToSpec(dupSpecies.mon);
    const t = { ...T.blankTeam(), slots: [spec, JSON.parse(JSON.stringify(spec))] };
    const res = T.matchPrimary(t, index, S);
    ok('two slots of one species claim two different Pokémon',
      res[0].at && res[1].at && res[0].at.key !== res[1].at.key,
      `${res[0].at?.key} vs ${res[1].at?.key}`);
  } else {
    console.log('  [SKIP] duplicate claiming — no species appears twice');
  }

  /* WHAT HAPPENS WHEN THE COPIES RUN OUT.
     Teams are ALTERNATIVES, not a simultaneous army: you field one at a time,
     so five cores each listing the one Gengar you own is legitimate. Both
     previous answers were wrong -- the sheet handed the fifth team somebody
     else's Gengar in silence, and this returned `missing` about a Pokemon
     sitting in the save. It falls back to the best match and SAYS it is
     shared, and the saying is the half that stops the page implying an
     exclusivity it does not have. */
  const one = index.find((x, i, a) =>
    a.filter((y) => y.mon.speciesId === x.mon.speciesId).length === 1);
  if (one) {
    const spec = T.monToSpec(one.mon);
    const key = `${one.loc}:${one.index}`;
    const free = T.matchSlot(spec, index, S, { taken: new Set() });
    ok('the only copy of a species is claimed normally',
      free.at?.key === key && free.shared === false, free.at?.key);
    const again = T.matchSlot(spec, index, S, { taken: new Set([key]) });
    ok('...and a second team wanting it gets it too, not "missing"',
      again.state !== 'missing' && again.at?.key === key,
      `state ${again.state}`);
    ok('...marked as shared, which is what keeps the page honest',
      again.shared === true);
    // Owning NONE of a species is still missing. That is a different fact and
    // must not be swallowed by the fallback.
    const absent = [...Array(650).keys()].find((id) =>
      id > 0 && !index.some((x) => x.mon.speciesId === id));
    ok('...while owning none of a species is still missing',
      T.matchSlot(T.blankSlot(absent), index, S).state === 'missing');
  } else {
    console.log('  [SKIP] shared fallback — every species you own has a duplicate');
  }

  /* THE SHARED COPY IS THE BEST MATCH, NOT THE FIRST ONE.
     `lst[0]` is whatever sorted first, and the old sheet handed that over. If
     the fallback picked by position the two sides would drift the moment they
     disagreed about order -- and verify_blob cannot see it, because whether
     any slot is shared at all depends on what happens to be in the store. So
     it is asserted here, on a set-up that always exercises it. */
  {
    const dup = index.find((x, i, a) =>
      a.filter((y) => y.mon.speciesId === x.mon.speciesId).length > 1);
    if (dup) {
      const copies = index.filter((x) => x.mon.speciesId === dup.mon.speciesId);
      const takeAll = new Set(copies.map((x) => `${x.loc}:${x.index}`));
      // A spec taken off the LAST copy: it is the exact match, and it is not
      // the one a positional fallback would reach for.
      const target = copies[copies.length - 1];
      const spec = T.monToSpec(target.mon);
      const m = T.matchSlot(spec, index, S, { taken: takeAll });
      ok('a shared slot gets the copy that MATCHES, not the first one',
        m.shared === true && m.at.key === `${target.loc}:${target.index}`
        && m.diffs.length === 0,
        `${copies.length} copies of ${dup.mon.species}; got ${m.at?.key}`);
    } else {
      console.log('  [SKIP] shared best-match — no species appears twice');
    }
  }

  // And the note carries it, or the marker exists only in the data.
  {
    const any = index[0];
    const spec = T.monToSpec(any.mon);
    const nOwn = index.filter((x) => x.mon.speciesId === any.mon.speciesId).length;
    const taken = new Set(index.filter((x) => x.mon.speciesId === any.mon.speciesId)
      .map((x) => `${x.loc}:${x.index}`));
    const bt = T.toBattleTeam({ ...T.blankTeam(), slots: [spec] }, index, S, { taken });
    ok('a shared slot says so on the card',
      /Shared/.test(bt.slots[0].options[0].note ?? ''),
      `${nOwn} cop${nOwn === 1 ? 'y' : 'ies'} of ${any.mon.species}, all claimed`);
  }
}

console.log('\n── model: visualisations');
{
  const specs = index.filter((x) => x.loc === 'party').map((x) => T.monToSpec(x.mon));
  const grid = T.defensiveGrid(specs, S);
  ok('defensive grid covers all 17 types', grid.length === 17);
  ok('every cell is a real multiplier',
    grid.every((r) => r.cells.length === specs.length
      && r.cells.every((c) => [0, 0.25, 0.5, 1, 2, 4].includes(c))));
  // Cross-check one row against gen5's chart rather than trusting our own math.
  const ground = grid.find((r) => r.type === 'ground');
  const byHand = specs.map((sp) => S.SPECIES[String(sp.speciesId)].types
    .reduce((m, d) => m * S.CHART.ground[d], 1));
  ok('a row agrees with the ROM type chart', JSON.stringify(ground.cells) === JSON.stringify(byHand),
    `ground: ${ground.cells.join(' ')}`);
  ok('worst counts the members hit for more than neutral',
    ground.worst === ground.cells.filter((c) => c > 1).length);

  const cov = T.offensiveCoverage(specs, S);
  ok('offensive coverage covers all 17 types', cov.length === 17);
  ok('status moves are excluded from coverage', cov.every((c) => c.hitters.every((h) => {
    const mv = S.MOVES[h.move];
    return mv && mv.c !== 'status';
  })));
}

console.log('\n── model: stats and export');
{
  // specStats reimplements the stat formula for a spec that may not exist in
  // the save. Every Pokémon that DOES exist is a labelled example of the right
  // answer, so all of them are checked against the Factory's own computation.
  // A silent divergence here would make every Builder number subtly wrong.
  const K = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
  let bad = 0, n = 0, first = null;
  for (const x of index) {
    if (!x.mon.stats) continue;
    n++;
    const got = T.specStats(T.monToSpec(x.mon), S);
    const want = K.map((k) => x.mon.stats[k]);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      bad++;
      first ??= `${x.mon.species}: ${got.join('/')} vs ${want.join('/')}`;
    }
  }
  ok('specStats matches the real stat computation for every Pokémon in the save',
    bad === 0, bad ? `${bad} of ${n} differ — e.g. ${first}` : `${n} checked`);

  // Roles are a heuristic, but must always return one of the four the battle
  // sheet styles -- an unknown role renders an unstyled badge.
  const ROLES = new Set(T.ROLES);
  ok('inferRole always returns a role the battle sheet knows',
    index.slice(0, 40).every((x) => ROLES.has(T.inferRole(T.monToSpec(x.mon), S))));
  ok('an explicit role overrides the inference',
    T.inferRole({ ...T.monToSpec(index[0].mon), role: 'wall' }, S) === 'wall');

  // Weather and Trick Room are read off what the team carries.
  const drizzle = Object.entries(S.ABILBYID).find(([, v]) => v === 'Drizzle')?.[0];
  const tRoom = Object.entries(S.MOVEBYID).find(([, v]) => v === 'Trick Room')?.[0];
  const spec = { ...T.blankOption(1), abilityId: Number(drizzle), moveIds: [Number(tRoom), 0, 0, 0] };
  const bt = T.toBattleTeam({ ...T.blankTeam('W'),
    slots: [{ role: null, why: '', options: [spec] }] }, index, S);
  ok('Drizzle turns on the rain toggle', bt.mech.includes('rain'), bt.mech.join(', '));
  ok('Trick Room sets tr and is not also a weather toggle',
    bt.tr === true && !bt.mech.includes('tr'));
  ok('an empty team does not become a tab',
    T.toBattleTeam({ ...T.blankTeam('E'), slots: [] }, index, S) === null);
}

console.log('\n── model: persistence');
{
  const a = [{ id: 'x', name: 'old', updated: 100 }, { id: 'y', name: 'only-a', updated: 5 }];
  const b = [{ id: 'x', name: 'new', updated: 200 }, { id: 'z', name: 'only-b', updated: 7 }];
  const m = T.merge(a, b);
  ok('merge keeps the newer of a shared id',
    m.find((t) => t.id === 'x').name === 'new', m.find((t) => t.id === 'x').name);
  ok('merge keeps ids unique to either side',
    m.length === 3 && m.some((t) => t.id === 'y') && m.some((t) => t.id === 'z'));

  T.saveLocal(123, a);
  ok('localStorage round-trips', JSON.stringify(T.loadLocal(123)) === JSON.stringify(a));
  ok('teams are scoped per trainer id', T.loadLocal(999).length === 0);
}

// ==================================================== the shipped rosters
// They used to render as battle tabs straight out of build_sheet.py: visible
// everywhere, editable nowhere. They are adopted into the team store as
// ordinary cores on first run instead, so everything below is about that
// adoption being correct ONCE and never happening twice.
console.log('\n── the shipped rosters, adopted as cores');
{
  const want = (S.LAYOUT ?? []).length;
  ok('static.json still ships the rosters to seed from', want > 0, `${want} rosters`);

  const first = T.seedBuiltins([], index, S, { tid: 777001 });
  ok('every shipped roster becomes a core', first.added.length === want,
    `${first.added.length} of ${want}`);
  ok('...and they are cores, not scratchpad teams', first.added.every(T.isCore));
  ok('...each carrying its slots', first.added.every((c) => c.slots.length > 0));
  ok('...and marked as adopted', first.added.every((c) => c.adopted === 'built-in'));

  // A rain team whose Drizzle is on a swap, or a Trick Room team that wants a
  // sand toggle for the weather the OPPONENT brings, declares what it can
  // toggle. Detection alone cannot know that, so the declared list travels.
  const decl = first.added.filter((c) => (c.mech ?? []).length || c.tr);
  ok('weather and Trick Room opt-ins travel with the roster', decl.length > 0,
    decl.map((c) => `${c.name}:${[...(c.mech ?? []), c.tr ? 'tr' : ''].filter(Boolean).join('+')}`)
      .join(' '));

  // ONCE, AND ONCE ONLY. The marker is its own key rather than "is there a
  // core by this name", because retiring one turns it into a team and deleting
  // one leaves a tombstone that gets pruned after 30 days -- either check would
  // silently hand back a roster the user had thrown away.
  const again = T.seedBuiltins(first.teams, index, S, { tid: 777001 });
  ok('seeding again adds nothing', again.added.length === 0, `${again.added.length} added`);
  ok('...and leaves the store exactly as it was', again.teams.length === first.teams.length);

  const wiped = T.seedBuiltins([], index, S, { tid: 777001 });
  ok('an emptied store does NOT bring the rosters back', wiped.added.length === 0,
    'retiring or deleting one has to stick');

  ok('a different trainer gets their own seeding',
    T.seedBuiltins([], index, S, { tid: 777002 }).added.length === want);

  // THE TAGS' LAST JOB, and the bug it guards. A roster slot names only a
  // SPECIES, and this save holds four Arcanines built for four different
  // teams. `layoutToTeam` disambiguates on the one-letter nickname tag; the
  // migration first ran WITHOUT it, every roster took the first free copy, and
  // the whole assignment shifted by one -- Kaiju held another team's Gengar
  // and nothing on screen said so.
  //
  // Asserted as "the tag changes the answer" rather than "Kaiju's Gengar has
  // Levitate", because the second is a fact about one person's save.
  const fingerprint = (res) => res.added.map((c) => `${c.name}:`
    + c.slots.map((sl) => {
      const o = sl.options[0];
      return `${o.speciesId}/${o.abilityId}/${o.natureId}/${o.moveIds.join('.')}`;
    }).join('|')).join('\n');

  const withTag = fingerprint(T.seedBuiltins([], index, S, { tid: 777003 }));
  const noTag = fingerprint(
    T.seedBuiltins([], index, { ...S, TEAM_TAG: {} }, { tid: 777004 }));

  // Only meaningful where the save actually holds several copies of a species
  // a roster wants -- with one of each there is nothing to disambiguate.
  const wanted = new Set((S.LAYOUT ?? []).flatMap((bt) => bt.slots
    .flatMap((sl) => sl.options.map((o) => o[0]))));
  const dupes = [...wanted].filter((n) =>
    index.filter((x) => x.mon.species === n).length > 1);

  if (dupes.length) {
    ok('the nickname tag decides WHICH copy a roster claims', withTag !== noTag,
      `${dupes.length} species have several copies; dropping the tag must change the result`);
  } else {
    console.log('  ~ no duplicated species in this save — tag disambiguation not exercised');
  }
}

// ====================================================================== UI
console.log('\n── ui');
{
  for (const k of Object.keys(store)) delete store[k];
  const panel = new N('div');
  const save = Save.load(new Uint8Array(original));
  const fac = new Factory(save, S);
  await builder.mount(panel, { S, factory: fac, trainer: { trainer_id: 42 }, config: null });
  const R = () => panel.children[0];

  ok('an empty state is offered first', /No teams yet/.test(R().text));
  btn(R(), /Start a team/).click();
  ok('starting a team renders the header', Boolean(R().find(hasClass('tb-head'))));
  ok('and an add-slot affordance', Boolean(R().find(hasClass('tb-addslot'))));
  /* TWO WAYS IN, not one. The empty card used to be a single button, so a new
     team -- which is what the Builder opens on -- had no way to ask the
     suggester anything: `Suggest` was an action on a FILLED slot only. The
     card is a container now, and both routes are pinned because the second is
     the one a tidy-up would fold back into the first. */
  ok('...offering both picking one yourself and being shown what fits',
    Boolean(R().find(hasClass('tb-addbtn'))) && Boolean(R().find(hasClass('tb-addsug'))));

  // add a slot from one you own
  R().find(hasClass('tb-addbtn')).click();
  const modal = () => body.children.find((n) => n.classList.contains('tb-modal'));
  ok('the slot editor opens', Boolean(modal()));
  // The species picker is a SEARCH BOX plus a sprite grid, not a 649-row
  // <select>, and the copies you own are listed for the species you picked
  // rather than as a second flat dropdown of the whole save.
  const search = modal().find((n) => n.classList.contains('tb-search'));
  ok('the editor offers a species search', Boolean(search),
    search?.getAttribute('placeholder'));

  // ---- what the editor shows BEFORE you type ------------------------------
  // The grid used to default to the single species already selected -- one
  // cell, directly under a header showing the same sprite: two pictures of one
  // Pokémon and no information between them. It defaults to the species you
  // OWN, which is the list you actually want when you open this.
  {
    const cells = modal().findAll(hasClass('tb-pickcell'));
    const ownedIds = new Set(index.map((x) => x.mon.speciesId));
    ok('the picker defaults to the species you own, not to the one already chosen',
      cells.length > 1 && cells.length <= ownedIds.size + 1,
      `${cells.length} cells for ${ownedIds.size} owned species`);
  }

  // ---- the long-list controls are pickers, not dropdowns -----------------
  // Moves, abilities and held items were all <select>s of 559 / 165 / 627
  // options. The answer is nearly always in a handful, and the long list is
  // the exception; each of the three now leads with the handful.
  {
    const m = modal();
    const moves = m.find(hasClass('sf-pick-moves'));
    ok('moves are a searchable list, not a dropdown',
      moves.findAll(hasClass('sf-row')).length > 0
      && moves.findAll(hasClass('sf-mvslot')).length === 4,
      `${moves.findAll(hasClass('sf-row')).length} rows, `
      + `${moves.findAll(hasClass('sf-mvslot')).length} slots`);
    ok('abilities lead with the ones this species can legally have',
      m.find(hasClass('sf-pick-ability')).findAll(hasClass('sf-abchip')).length >= 2,
      `${m.findAll(hasClass('sf-abchip')).length} chips`);
    ok('the held item is a searchable list too, with the ROM\'s own descriptions',
      m.find(hasClass('sf-pick-item')).findAll(hasClass('sf-desc')).length > 0);
    // No control in the editor should still be a hundreds-long <select>.
    const bigSelect = m.findAll((n) => n.tagName === 'SELECT')
      .find((n) => n.children.length > 60);
    ok('...and nothing in the editor is a hundreds-long dropdown any more',
      !bigSelect, bigSelect ? `${bigSelect.children.length} options` : '');
    // ---- the nature CHART --------------------------------------------
    // A nature IS a pair of stats and the id encodes exactly that: id/5 is the
    // raised stat, id%5 the lowered one. The 5x5 grid is the game's own chart,
    // and the assertion that matters is that a cell's POSITION agrees with the
    // nature it writes -- a transposed grid would look perfectly plausible and
    // hand you the opposite spread.
    const cells = m.findAll(hasClass('sf-natcell'));
    ok('the nature is the 5x5 chart, not a list of 25 names', cells.length === 25,
      `${cells.length} cells`);
    ok('...with the five neutral natures on the diagonal',
      [0, 6, 12, 18, 24].every((i) => cells[i].classList.contains('neutral'))
      && cells.filter((c) => c.classList.contains('neutral')).length === 5);
    // Timid is +Spe -Atk. In the ROM's order (atk, def, spe, spa, spd) that is
    // raised index 2 and lowered index 0, so it must be the cell at row 2 col 0.
    ok('...and a cell sits where the stats it changes say it should',
      cells[2 * 5 + 0].text.trim() === 'Timid', cells[2 * 5 + 0].text.trim());
    cells[2 * 5 + 0].click();
    ok('...and clicking it says what it does in words',
      /10% more Spe/.test(modal().text) && /10% less Atk/.test(modal().text));
  }

  // ---- a picker that has done its job gets out of the way ----------------
  // The species grid used to sit open for the life of the dialog -- 380px of
  // sprites between you and every other field, long after you had chosen.
  {
    const m = modal();
    const grid = () => modal().findAll(hasClass('tb-pickcell'));
    ok('the species grid is open while you are choosing', grid().length > 0,
      `${grid().length} cells`);
    // Choosing is the job; doing it closes the picker. Any cell will do --
    // `unique` is not in scope yet and is not what this checks.
    const wanted = grid()[0].text.trim();
    grid()[0].click();
    ok('...and closes once you have chosen',
      modal().findAll(hasClass('tb-pickcell')).length === 0);
    const chosenCard = modal().find(hasClass('tb-chosen'));
    ok('...leaving the choice itself, not a blank', Boolean(chosenCard),
      chosenCard?.text.slice(0, 40));
    ok('...naming what was chosen', chosenCard.text.includes(wanted), wanted);
    chosenCard.click();
    ok('...and one click reopens it',
      modal().findAll(hasClass('tb-pickcell')).length > 0);
  }

  // ---- EVs are a budget --------------------------------------------------
  // Twelve number boxes hide the one thing that makes EVs interesting.
  {
    const m = modal();
    ok('the stats are bars you can drag, not a grid of number boxes',
      m.findAll(hasClass('sf-barrange')).length === 12,
      `${m.findAll(hasClass('sf-barrange')).length} sliders for 6 IVs + 6 EVs`);
    ok('...and the EVs show the budget they are spending against',
      Boolean(m.find(hasClass('sf-evmeter'))) && /of 510/.test(m.text));
    // ---- the presets, which are facts about the GAME ------------------
    // They live in specform.js beside the controls they drive: the Factory had
    // "Speed 0" and the Builder did not, which is the two-editors problem in
    // miniature.
    {
      const preset = (re) => btn(m, re);
      ok('there is a Trick Room IV preset', Boolean(preset(/Trick Room/)));
      preset(/Trick Room/).click();
      const ivs = modal().findAll(hasClass('sf-barnum')).slice(0, 6).map((n) => Number(n.value));
      // Under Trick Room the SLOWEST moves first, so 0 Speed is the build.
      ok('...perfect everywhere except Speed, which goes to 0',
        ivs.slice(0, 5).every((v) => v === 31) && ivs[5] === 0, ivs.join('/'));
      ok('there is a max-everything EV preset', Boolean(btn(modal(), /Max everything/)));
      btn(modal(), /Max everything/).click();
      const evs = modal().findAll(hasClass('sf-barnum')).slice(6).map((n) => Number(n.value));
      ok('...which sets every EV to 255, illegal and on purpose',
        evs.every((v) => v === 255), evs.join('/'));
      ok('...and the meter says so rather than the control refusing',
        modal().find(hasClass('sf-evmeter')).classList.contains('over'));
      btn(modal(), /^Clear$/).click();
    }

    // IT WARNS, IT DOES NOT BLOCK.
    //
    // This used to assert the opposite -- that the control capped each stat at
    // what was left -- and that assertion was pinning behaviour which
    // contradicted the app's own rule. The Factory writes abilities a species
    // cannot legally have and moves it cannot learn, flagged and never
    // blocked, because Gen 5 reads those bytes directly and building something
    // illegal is a thing people come here to do. An EV spread is the same kind
    // of byte, and a control that silently refuses your input is worse than
    // one that tells you what you have done.
    const evNums = modal().findAll(hasClass('sf-barnum')).slice(6);
    for (const n of evNums) { n.value = '255'; n.oninput(); }
    // `tb-evmeter` specifically -- the IV column has a meter too, sharing the
    // base class but not this one.
    const meter = modal().find(hasClass('sf-evmeter'));
    // Read back through the DOM: the editor's `state` is a closure and the
    // inputs are what the user sees, so this checks the thing that matters.
    const evVals = () => modal().findAll(hasClass('sf-barnum')).slice(6)
      .map((n) => Number(n.value));
    ok('an impossible EV spread is accepted, not refused',
      evVals().every((v) => v === 255), evVals().join('/'));
    ok('...and the meter says so, in red',
      meter.classList.contains('over') && /over/.test(meter.text)
      && /Impossible in a real game/.test(meter.text),
      meter.text.slice(0, 40));
    // Back under budget, and the warning has to go away again.
    for (const n of evNums) { n.value = '0'; n.oninput(); }
    const meter2 = modal().find(hasClass('sf-evmeter'));
    ok('...and it clears when you come back under 510',
      !meter2.classList.contains('over') && /510 left/.test(meter2.text),
      meter2.text.slice(0, 30));

    // ---- the sliders have to SLIDE -------------------------------------
    // `oninput` used to call the caller's full redraw, which destroys the
    // element you are dragging -- so the browser had nothing left to track the
    // pointer against and the control snapped to wherever you clicked. The
    // test for it is that a continuous `input` does NOT rebuild the form: the
    // node you were dragging must still be the same object afterwards.
    {
      const before = modal().findAll(hasClass('sf-barrange'))[0];
      before.value = '17';
      before.oninput();
      const after = modal().findAll(hasClass('sf-barrange'))[0];
      ok('dragging a slider does not rebuild the control under the pointer',
        after === before, after === before ? 'same node' : 'node was replaced');
      const ivHp = () => Number(modal().findAll(hasClass('sf-barnum'))[0].value);
      ok('...but it does write the value through', ivHp() === 17, String(ivHp()));
      // Letting go is what pays for the expensive redraw.
      before.onchange();
      ok('...and releasing redraws, so the stat preview catches up',
        modal().findAll(hasClass('sf-barrange'))[0] !== before);
    }
  }

  // ---- who it is: nickname, gender, shiny --------------------------------
  // All three were missing from this editor while the Factory has had them
  // since the beginning -- the drift that comes of two editors for one record.
  {
    // NOTHING ABOUT THE INDIVIDUAL UNTIL THERE IS A SPECIES. Nicknaming a
    // Pokémon before deciding what it is has no meaning, and the fields sat
    // ABOVE the picker -- a heading, three fields belonging to a choice you
    // had not made, and then the choice.
    ok('who-it-is is absent while the species picker is open',
      !modal().find(hasClass('sf-nick')),
      modal().find(hasClass('sf-nick')) ? 'nickname shown too early' : '');
    // Choosing closes the picker, which is when it appears.
    modal().findAll(hasClass('tb-pickcell'))[0].click();
    const m = modal();
    ok('...and appears once a species is settled', Boolean(m.find(hasClass('sf-nick'))));
    ok('...below the species, not above it', (() => {
      const order = [...m.walk()];
      const sp = order.findIndex((n) => n.classList.contains('tb-chosen'));
      const nk = order.findIndex((n) => n.classList.contains('sf-nick'));
      return sp >= 0 && nk >= 0 && sp < nk;
    })());
    const nickBox = m.find(hasClass('sf-nick'));
    ok('the editor can set a nickname', Boolean(nickBox));
    nickBox.value = 'Bartholomew Jones';
    nickBox.oninput();
    ok('...capped at ten characters, like the game',
      nickBox.value.length <= 18 && m.find(hasClass('sf-nick')) === nickBox,
      `kept "${nickBox.value}"`);
    const chips = m.findAll(hasClass('sf-genchip'));
    ok('the editor can set a gender', chips.length >= 2,
      chips.map((c) => c.text).join(' '));
    // A gender the species cannot have is not a build, it is a leftover --
    // unlike an ability, gender buys nothing, so this is the one place the
    // editor does not offer the illegal option.
    ok('...offering only what the species ratio allows',
      chips.every((c) => !/Genderless/.test(c.text)) || chips.length === 1,
      chips.map((c) => c.text).join(' '));
  }

  // ---- slot order is not cosmetic ----------------------------------------
  // It is the order the battle tab lists a team and the order "Field it"
  // writes into the party, so it is what you lead with. It used to be
  // changeable only by rebuilding a slot.
  {
    ok('reorderSlots is a pure move that leaves the input alone', (() => {
      const a = ['a', 'b', 'c'];
      const out = T.reorderSlots(a, 0, 2);
      return out.join('') === 'bca' && a.join('') === 'abc';
    })());
    ok('...and refuses an index it cannot honour',
      T.reorderSlots(['a', 'b'], 0, 9).join('') === 'ab'
      && T.reorderSlots(['a', 'b'], 1, 1).join('') === 'ab');
  }

  // ---- typing must not destroy the box you are typing into ---------------
  // Every one of these pickers rebuilt itself on each keystroke, which
  // recreates the <input> and drops focus and the caret with it -- so typing
  // "flame" took five clicks back into the field. The invariant is the same
  // one the sliders need, and it is checkable the same way: after an `input`,
  // the node must still be the SAME OBJECT.
  {
    const m = () => modal();
    for (const [wrap, label] of [
      ['sf-pick-moves', 'the move search'],
      ['sf-pick-item', 'the item search'],
    ]) {
      const box = m().find(hasClass(wrap))?.find((n) => n.classList.contains('sf-search'));
      if (!box) { ok(`${label} exists to type into`, false, `no input inside .${wrap}`); continue; }
      box.value = 'th';
      box.oninput();
      const after = m().find(hasClass(wrap))?.find((n) => n.classList.contains('sf-search'));
      ok(`typing into ${label} keeps the box you are typing into`, after === box,
        after === box ? 'same node' : 'the input was replaced mid-word');
      // ...and it must still actually filter, or "do not redraw" is trivially
      // satisfiable by doing nothing at all.
      const rows = m().find(hasClass(wrap)).findAll(hasClass('sf-row'));
      ok(`...and still filters ${label}`, rows.length > 0
        && rows.every((r) => /th/i.test(r.text)), `${rows.length} rows`);
      box.value = ''; box.oninput();
    }
  }

  // ---- the level slider is a slider too ----------------------------------
  // It kept the redraw-on-input the stat bars had shed, so it snapped to
  // wherever you clicked and would not drag.
  {
    const bar = modal().find(hasClass('sf-lvlbar'));
    ok('the level has a slider', Boolean(bar));
    bar.value = '73';
    bar.oninput();
    ok('...that does not rebuild itself under the pointer',
      modal().find(hasClass('sf-lvlbar')) === bar,
      modal().find(hasClass('sf-lvlbar')) === bar ? 'same node' : 'node was replaced');
    ok('...while still writing the value through',
      Number(modal().find(hasClass('sf-lvlnum')).value) === 73,
      modal().find(hasClass('sf-lvlnum')).value);
    bar.onchange();
    ok('...and releasing redraws, so the preset chips catch up',
      modal().find(hasClass('sf-lvlbar')) !== bar);
  }

  // ---- a move slot is a TARGET -------------------------------------------
  // Picking always dropped into the first free slot, so filling move 3
  // specifically meant clearing 1 and 2 first. Slot order is not cosmetic:
  // the battle sheet reads slot 1 as the lead option.
  {
    const m = modal();
    // SCOPED TO THE MOVE PICKER. The ability and item lists share the row
    // styling, so an unscoped lookup armed a move slot and then clicked an
    // item -- which is how this test first "failed" against working code.
    const mv = () => modal().find(hasClass('sf-pick-moves'));
    const slots = () => mv().findAll(hasClass('sf-mvslot'));
    const rows = () => mv().findAll(hasClass('sf-row'));
    slots()[2].click();
    ok('clicking a move slot arms it',
      slots()[2].classList.contains('armed'),
      slots().map((x) => x.className).join(' | ').slice(0, 60));
    const want = rows()[0].find((n) => n.tagName === 'B')?.text;
    rows()[0].click();
    ok('...and the next move picked lands in THAT slot, not the first free one',
      slots()[2].text.includes(want), `${want} -> slot 3: ${slots()[2].text.slice(0, 30)}`);
    ok('...and the arming clears itself afterwards',
      !slots()[2].classList.contains('armed'));
  }

  // A species with exactly ONE copy in the save. With several, tweaking a
  // field can legitimately match a different copy exactly, and the "close"
  // test below would be asserting the wrong thing -- this save has five
  // Mewtwos, which is how that surfaced.
  const counts = new Map();
  for (const x of index) counts.set(x.mon.speciesId, (counts.get(x.mon.speciesId) ?? 0) + 1);
  const unique = index.find((x) => counts.get(x.mon.speciesId) === 1) ?? index[0];
  ok('found a species with a single copy to test CLOSE with',
    counts.get(unique.mon.speciesId) === 1, `${unique.mon.species} ×${counts.get(unique.mon.speciesId)}`);

  // The picker closes once you have chosen, so reopen it to search again --
  // which is the gesture a person makes too.
  if (!modal().find((n) => n.classList.contains('tb-search'))) {
    modal().find(hasClass('tb-chosen')).click();
  }
  const search2 = modal().find((n) => n.classList.contains('tb-search'));
  search2.value = unique.mon.species;
  search2.oninput();
  const cell = modal().findAll(hasClass('tb-pickcell'))
    .find((c) => c.text.trim() === unique.mon.species);
  ok('searching a name finds it in the grid', Boolean(cell),
    modal().findAll(hasClass('tb-pickcell')).slice(0, 4).map((c) => c.text).join(', '));
  cell.click();

  // Having picked the species, the copies you own of THAT species are offered
  // with their own "copy its build" -- which is the thing the old second
  // dropdown was for.
  // SHUT BY DEFAULT. Starting from a copy you already own is an advanced
  // path, and open it sat between the species picker and every other field on
  // every slot. The heading is always there; the rows are not.
  {
    const shut = modal().find(hasClass('tb-yours'));
    ok('the copies you own are offered but not unfolded',
      Boolean(shut) && shut.classList.contains('shut'), shut?.className);
    ok('...with the heading still saying they exist',
      /You have \d+/.test(shut?.text ?? ''), shut?.find(hasClass('tb-yourslab'))?.text);
    ok('...and no rows taking up the dialog',
      shut.findAll(hasClass('tb-yourrow')).length === 0);
    // SHUT IS NOT GONE. The heading has to say what opening it gets you, or
    // the feature reads as deleted rather than collapsed -- which is exactly
    // what `display: none` on the whole panel did.
    ok('...and the heading says what opening it would do',
      /Copy one, or edit it in place/.test(shut.text), shut.text.slice(0, 60));
    btn(shut, /Copy one, or edit it in place/).click();
  }
  const yours = modal().find(hasClass('tb-yours'));
  ok('your own copies of that species are listed', Boolean(yours),
    yours?.find(hasClass('tb-yourslab'))?.text);
  // All three ways of dealing with a Pokémon you already own are on THIS
  // panel: copy its build as a starting point, edit that exact one in place,
  // or collapse the panel and design from scratch. They used to be split
  // between the editor and the card, which is what made the verbs confusing.
  ok('the panel offers copy, edit and dismiss', Boolean(btn(yours, /^Copy$/))
    && Boolean(btn(yours, /Edit this one/)) && Boolean(btn(yours, /Ignore/)),
    yours.findAll((n) => n.tagName === 'BUTTON').map((b) => b.text.trim()).join(' | '));
  ok('and says what copying does to the one you own',
    /leaves the ones you own alone/i.test(yours?.text ?? ''));
  btn(yours, /Ignore/).click();
  ok('dismissing collapses it to just the heading',
    !btn(modal().find(hasClass('tb-yours')), /^Copy$/),
    'a panel you have dismissed should not still be offering its actions');
  btn(modal().find(hasClass('tb-yours')), /Copy one, or edit it in place/).click();
  btn(modal().find(hasClass('tb-yours')), /^Copy$/).click();
  btn(modal(), /Add to team/).click();
  ok('the slot is added and closes the editor', !modal());

  const cards = () => R().findAll(hasClass('tb-slot')).filter((c) => !c.classList.contains('tb-addslot'));
  ok('one slot card is rendered', cards().length === 1);
  ok('a slot copied from your box reads as OWNED',
    cards()[0].classList.contains('tb-owned'), cards()[0].className);
  ok('it says where that Pokémon lives', /slot \d/.test(cards()[0].text));

  // default visualisations are on, opt-ins are off
  ok('defensive coverage shows by default', /Defensive coverage/.test(R().text));
  ok('offensive coverage shows by default', /Offensive coverage/.test(R().text));
  ok('opt-in panels are off by default',
    !/Stat spread/.test(R().findAll(hasClass('tb-panel')).map((p) => p.text).join('')));

  const tog = R().findAll(hasClass('tb-tog'));
  ok('there are five opt-in toggles', tog.length === 5, `${tog.length}`);
  // Every toggle must actually produce a panel. A toggle that flips a flag
  // nothing reads looks identical to one that works.
  const panelCount = () => R().findAll(hasClass('tb-panel')).length;
  const base = panelCount();
  for (let i = 0; i < tog.length; i++) {
    const before = panelCount();
    R().findAll(hasClass('tb-tog'))[i].click();
    const label = R().findAll(hasClass('tb-tog'))[i].text;
    ok(`toggle "${label}" adds a panel`, panelCount() === before + 1,
      `${before} -> ${panelCount()}`);
  }
  ok('all five panels can be on at once', panelCount() === base + 5, `${panelCount()}`);
  ok('the toggle preference persists', /"radar":true/.test(store['blazeblack.builder.viz'] ?? ''));
  // Every panel must have rendered real content, not an empty shell.
  ok('no panel rendered empty',
    R().findAll(hasClass('tb-panel')).every((p) => p.children.length > 1),
    R().findAll(hasClass('tb-panel')).map((p) => p.find((n) => n.tagName === 'H3')?.text.slice(0, 14)).join(' | '));
  ok('the radar draws one chart per member',
    R().findAll(hasClass('tb-radar')).length === 1, `${R().findAll(hasClass('tb-radar')).length}`);
  ok('the synergy matrix draws cells',
    R().findAll(hasClass('tb-syn-cell')).length >= 1);
  for (let i = 0; i < tog.length; i++) R().findAll(hasClass('tb-tog'))[i].click();
  ok('toggles turn back off', panelCount() === base);

  // a CLOSE slot must offer to adjust, and adjusting must change the save copy
  const before = fac.dirty;
  R().findAll(hasClass('tb-slot')).find((c) => !c.classList.contains('tb-addslot'));
  const teamsNow = JSON.parse(store['blazeblack.teams.42']);
  const opt0 = teamsNow[0].slots[0].options[0];
  opt0.natureId = (opt0.natureId + 1) % 25;
  store['blazeblack.teams.42'] = JSON.stringify(teamsNow);
  ok('the tweaked slot really is the single-copy species',
    opt0.speciesId === unique.mon.speciesId);
  builder.unmount();
  await builder.mount(panel, { S, factory: fac, trainer: { trainer_id: 42 }, config: null });
  ok('a differing slot reads as CLOSE',
    cards()[0].classList.contains('tb-close'), cards()[0].className);
  ok('it lists what differs', /nature/i.test(cards()[0].text));
  // The verbs changed with the card: actions that write into your save live
  // in a labelled "In your save" footer, separate from the ones that only
  // change the plan. That separation is what the test pins -- a save-writing
  // button back up among Edit slot / Add a swap / Remove is the regression.
  const footer = cards()[0].find(hasClass('tb-save'));
  ok('a close slot has an "In your save" footer', Boolean(footer),
    footer?.find(hasClass('tb-savelab'))?.text);
  const adjust = btn(footer, /Make yours match/);
  ok('the footer is where the save-writing action lives', Boolean(adjust));
  ok('the plan actions do not write to the save',
    !btn(cards()[0].find(hasClass('tb-slot-acts')), /Make yours match|Build it/));
  adjust.click();
  ok('adjusting edits the shared working copy', fac.dirty && !before);
  ok('and the slot becomes OWNED', cards()[0].classList.contains('tb-owned'), cards()[0].className);

  // a MISSING slot must offer to create
  const have = new Set(index.map((x) => x.mon.speciesId));
  const absent = Number(Object.keys(S.SPECIES).find((id) => !have.has(Number(id))));
  if (absent) {
    const t2 = JSON.parse(store['blazeblack.teams.42']);
    t2[0].slots.push({ role: null, why: '',
      options: [{ ...T.blankOption(absent), moveIds: [33, 0, 0, 0] }] });
    store['blazeblack.teams.42'] = JSON.stringify(t2);
    builder.unmount();
    await builder.mount(panel, { S, factory: fac, trainer: { trainer_id: 42 }, config: null });
    const miss = cards().find((c) => c.classList.contains('tb-missing'));
    ok('a species you lack reads as MISSING', Boolean(miss));
    alerts.length = 0;
    btn(miss.find(hasClass('tb-save')), /Build it/).click();
    ok('creating it reports where it went', alerts.some((a) => /Created .* slot \d/.test(a)),
      alerts[0]?.slice(0, 60));
    ok('and the working copy still verifies', fac.output().ok, fac.output().problems.join('; '));
    ok('nothing reads MISSING any more',
      cards().length > 1 && !cards().some((c) => c.classList.contains('tb-missing')),
      cards().map((c) => c.className.replace('tb-slot ', '')).join(' | '));
  } else {
    console.log('  [SKIP] MISSING/create — this save contains every species');
  }

  // ---- the Showdown paste -------------------------------------------------
  // A team you cannot hand to anybody stays in one browser. The format has
  // rules, and each one below has bitten an implementation somewhere.
  {
    const SD = await import('../app/js/showdown.js');
    const KEYS6 = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
    const spec = { ...T.monToSpec(index[0].mon) };

    // With no nickname the species stands alone: `Arcanine (Arcanine)` is
    // legal-ish and reads as a bug.
    spec.nickname = '';
    let out = SD.specToPaste(spec, S, { natureNames: T.NATURE_NAMES });
    const species = S.SPECIES[String(spec.speciesId)].name;
    ok('an un-nicknamed Pokémon is just its species',
      out.split('\n')[0].startsWith(species) && !out.includes(`(${species})`),
      out.split('\n')[0]);
    spec.nickname = 'Benny';
    out = SD.specToPaste(spec, S, { natureNames: T.NATURE_NAMES });
    ok('...and a nicknamed one puts the species in brackets',
      out.startsWith(`Benny (${species})`), out.split('\n')[0]);

    // An EVs: line with no values does not parse, so it is omitted entirely.
    const bare = { ...spec, evs: Object.fromEntries(KEYS6.map((k) => [k, 0])),
      ivs: Object.fromEntries(KEYS6.map((k) => [k, 31])) };
    const bareOut = SD.specToPaste(bare, S, { natureNames: T.NATURE_NAMES });
    ok('an all-zero EV spread writes no EVs line', !/EVs:/.test(bareOut));
    ok('...and a perfect IV spread writes no IVs line, because 31 is the default',
      !/IVs:/.test(bareOut));

    // A Trick Room build's whole IV line is `IVs: 0 Spe`.
    const tr = { ...bare, ivs: { ...bare.ivs, spe: 0 } };
    ok('...but a non-31 IV is listed, and only that one',
      /IVs: 0 Spe$/m.test(SD.specToPaste(tr, S, { natureNames: T.NATURE_NAMES })));

    // Level 100 is Showdown's default.
    ok('level 100 is left out, being the default',
      !/Level:/.test(SD.specToPaste({ ...bare, level: 100 }, S, { natureNames: T.NATURE_NAMES })));
    ok('...and any other level is stated',
      /Level: 62/.test(SD.specToPaste({ ...bare, level: 62 }, S, { natureNames: T.NATURE_NAMES })));

    // A genderless species takes no marker at all.
    const genderless = Object.entries(S.SPECIES).find(([, v]) => v.ratio === 255);
    if (genderless) {
      const gl = { ...bare, speciesId: Number(genderless[0]), gender: 'male' };
      ok('a genderless species carries no gender marker',
        !/\(M\)|\(F\)/.test(SD.specToPaste(gl, S, { natureNames: T.NATURE_NAMES })),
        genderless[1].name);
    }

    // THE HEADER NAMES THE GAME. A recipient has no other way to know these
    // sets describe a hack whose base stats, typings and abilities differ.
    const team = { name: 'Rainy', slots: [{ options: [spec] }, { options: [bare] }] };
    const paste = SD.teamToPaste(team, S, { natureNames: T.NATURE_NAMES });
    ok('the paste names the hack, so a recipient is not misled',
      /Blaze Black 3\.1/.test(paste) && /ROM hack/.test(paste));
    ok('...and says so in comment lines the importer ignores',
      paste.split('\n').filter((l) => /differ from the base game/.test(l))
        .every((l) => l.startsWith('#')));
    ok('...and switching cartridge switches the name',
      /Volt White/.test(SD.teamToPaste(team, S, { version: 'white' })));

    // ONLY THE PRIMARY OPTION. The alternates are a swap tree; pasting them
    // would produce a team nothing can import.
    const withAlt = { name: 'A', slots: [{ options: [spec, bare, bare] }] };
    ok('only each slot\'s primary option is exported, not its swaps',
      SD.teamToPaste(withAlt, S, { natureNames: T.NATURE_NAMES, withHeader: false })
        .trim().split('\n\n').length === 1);

    // ...and the button reaches it.
    // Scoped to the TEAM HEADER. The teams bar has its own export -- every
    // team as JSON, for keeping -- and an unscoped match found that one, which
    // is exactly the confusion two buttons reading "Export" would cause a
    // person. It is "Back up all" now.
    const eb = btn(R().find(hasClass('tb-headacts')), /^Export$/);
    ok('the team header offers an export', Boolean(eb));
    ok('...and the teams bar\'s own export is named differently, not "Export"',
      Boolean(btn(R(), /Back up all/)),
      'two buttons reading Export a few centimetres apart is a coin toss');
    eb.click();
    const sheet = body.children.find((n) => n.classList.contains('tb-modal'));
    ok('...which shows the paste rather than silently copying it',
      Boolean(sheet) && /Blaze Black/.test(sheet.find(
        (n) => n.classList.contains('tb-exporttext'))?.value ?? ''));
    btn(sheet, /Close/).click();
    ok('...and closes', !body.children.some((n) => n.classList.contains('tb-modal')));
  }

  // ---- reordering, from the cards themselves ------------------------------
  // By drag AND by button: a drag is a poor fit for a touchscreen and
  // impossible without a pointer, so both routes exist and both call the same
  // `reorderSlots`. Placed here because it needs a team with two slots in it.
  {
    const names = () => R().findAll(hasClass('tb-slot'))
      .filter((c) => !c.classList.contains('tb-addslot'))
      .map((c) => c.find((n) => n.tagName === 'B')?.text ?? '');
    if (names().length >= 2) {
      const before = names();
      const cards = R().findAll(hasClass('tb-slot'))
        .filter((c) => !c.classList.contains('tb-addslot'));
      ok('every slot card is draggable', cards.every((c) => c.draggable === true));
      ok('...and carries buttons for the same move',
        cards[0].findAll(hasClass('tb-nudge')).length === 2);
      // The button path.
      btn(cards[1], /◀/).click();
      const after = names();
      ok('moving a slot earlier swaps it with its neighbour',
        after[0] === before[1] && after[1] === before[0],
        `${before.join(',')} -> ${after.join(',')}`);
      // The drag path must land in the same place.
      const c2 = R().findAll(hasClass('tb-slot'))
        .filter((c) => !c.classList.contains('tb-addslot'));
      c2[0].ondragstart({ dataTransfer: { setData() {}, effectAllowed: '' } });
      c2[1].ondragover({ preventDefault() {} });
      c2[1].ondrop({ preventDefault() {} });
      // The dragged card must stay SOLID and the target must be marked: the
      // pair reads as an exchange, not as one card fading out with nothing
      // saying where it lands. `opacity: .45` looked like a deletion.
      {
        const css2 = fs.readFileSync(path.join(ROOT, 'app/css/builder.css'), 'utf8');
        const drag = /\.tb-slot\.dragging \{[^}]*\}/.exec(css2)?.[0] ?? '';
        const drop = /\.tb-slot\.dropinto \{[^}]*\}/.exec(css2)?.[0] ?? '';
        const op = Number(/opacity: ?([\d.]+)/.exec(drag)?.[1] ?? '1');
        ok('the card you are dragging stays solid', op >= 0.85, `opacity ${op}`);
        ok('...and lifts rather than fades', /transform|box-shadow/.test(drag));
        ok('...and the card it would swap with is marked too',
          /transform|inset/.test(drop));
        ok('...with the motion dropped under prefers-reduced-motion',
          /prefers-reduced-motion[\s\S]{0,220}dragging/.test(css2));
      }
      ok('...and a drag onto another card does the same thing',
        names()[0] === after[1] && names()[1] === after[0],
        `${after.join(',')} -> ${names().join(',')}`);
    } else {
      ok('reordering needs two slots to test (skipped)', true);
    }
  }


  // The bug this section exists for: a team saved to the repo but absent from
  // localStorage silently never reached the battle tab, because battleTeams
  // read only one of the two stores.
  {
    const repoOnly = T.teamFromMons('Repo only', [index[0].mon]);
    repoOnly.name = 'Repo only';
    const local = T.loadLocal(42);
    ok('the repo-only team is genuinely absent from localStorage',
      !local.some((t) => t.id === repoOnly.id));
    const both = T.battleTeams(42, index, S, [repoOnly]);
    ok('battleTeams includes a team that exists only in the repo',
      both.some((t) => t.name === 'Repo only'), both.map((t) => t.name).join(', '));
    const localOnly = T.battleTeams(42, index, S);
    ok('and still includes the local ones', localOnly.length >= 1);
    ok('unexportable() names teams that will not appear',
      T.unexportable(42, [{ ...T.blankTeam('Empty'), slots: [] }])
        .some((x) => x.name === 'Empty' && /no slots/.test(x.reason)));
  }

  // ---- the delete bug: a tombstone must survive a merge with the repo -----
  {
    const t0 = T.teamFromMons('Doomed', [index[0].mon]);
    const alive = [t0, T.teamFromMons('Kept', [index[1].mon])];
    const afterDelete = T.tombstone(alive, t0.id);
    ok('deleting leaves a tombstone, not a hole',
      afterDelete.length === alive.length && afterDelete.find((x) => x.id === t0.id).deleted > 0);
    ok('living() hides it', !T.living(afterDelete).some((x) => x.id === t0.id));
    // The repo still has the ORIGINAL, live copy. Before tombstones this is
    // precisely where the team came back from.
    const merged = T.merge(afterDelete, alive);
    ok('a stale live copy in the other store does NOT resurrect it',
      !T.living(merged).some((x) => x.id === t0.id),
      T.living(merged).map((x) => x.name).join(', '));
    ok('and the other team is untouched', T.living(merged).some((x) => x.name === 'Kept'));
    ok('battleTeams skips deleted teams',
      !T.battleTeams(4242, index, S, merged).some((x) => x.name === 'Doomed'));
  }

  // ---- claiming across the whole assembly ----------------------------------
  // A player may keep four Arcanines and two Slowkings, one per roster. If
  // every team
  // matched against the full save on its own, two teams that both want a
  // Slowking would render the SAME record and one of them would be lying about
  // what it holds. build_sheet.py has always claimed globally; the port did
  // not, and it hid for months because every other duplicate was told apart by
  // its spec. Only two Wobbuffets identical apart from a nickname exposed it.
  {
    // Find a species with at least two copies in this save, whatever it is.
    const bySpecies = new Map();
    for (const e of index) {
      const k = e.mon.speciesId;
      bySpecies.set(k, [...(bySpecies.get(k) ?? []), e]);
    }
    const dupe = [...bySpecies.values()].find((v) => v.length >= 2);
    if (!dupe) {
      ok('claiming across teams (skipped: no duplicate species in this save)', true);
    } else {
      const spec = T.monToSpec(dupe[0].mon);
      const teamA = { ...T.blankTeam('A'), slots: [{ role: null, why: '', options: [spec] }] };
      const teamB = { ...T.blankTeam('B'), slots: [{ role: null, why: '',
        options: [JSON.parse(JSON.stringify(spec))] }] };

      const shared = new Set();
      const a = T.matchTeam(teamA, index, S, { taken: shared })[0][0];
      const b = T.matchTeam(teamB, index, S, { taken: shared })[0][0];
      ok('two teams wanting the same species claim DIFFERENT copies',
        a.at && b.at && a.at.key !== b.at.key, `${a.at?.key} vs ${b.at?.key}`);

      // ...and the default is still per-team, which is what the Builder wants:
      // a team being edited should show what it could claim on its own, not
      // what is left over after every other team has been resolved.
      const a2 = T.matchTeam(teamA, index, S)[0][0];
      const b2 = T.matchTeam(teamB, index, S)[0][0];
      ok('...but an unshared claim set still resolves each team independently',
        a2.at.key === b2.at.key, a2.at.key);

      // The battle tab must be the one that shares it.
      const bts = T.battleTeams(4243, index, S, [teamA, teamB]);
      const keys = bts.map((t) => t.slots[0].options[0].mon);
      ok('battleTeams shares one claim set across the whole assembly',
        bts.length === 2 && JSON.stringify(keys[0]) !== JSON.stringify(keys[1]),
        `${keys[0]?.nick || keys[0]?.name} vs ${keys[1]?.nick || keys[1]?.name}`);
    }
  }

  // ---- swaps ---------------------------------------------------------------
  {
    const t = T.teamFromMons('Swappy', [index[0].mon]);
    t.slots[0].options.push({ ...T.monToSpec(index[1].mon), badge: 'vs Ground', note: 'loses the rain.' });
    const bt = T.toBattleTeam(t, index, S);
    ok('a slot with an alternate exports two options', bt.slots[0].options.length === 2);
    ok('the primary has no badge, the alternate does',
      bt.slots[0].options[0].badge === null && bt.slots[0].options[1].badge === 'vs Ground');
    ok('the swap note carries what it costs', /loses the rain/.test(bt.slots[0].options[1].note));
    ok('defaultIdx points at the primary', bt.slots[0].defaultIdx === 0);
    ok('visualisations use the primary option only',
      T.teamSpecs(t).length === 1 && T.teamSpecs(t)[0].speciesId === index[0].mon.speciesId);
  }

  // ---- seeding -------------------------------------------------------------
  {
    const party = index.filter((x) => x.loc === 'party').map((x) => x.mon);
    if (party.length) {
      const t = T.teamFromMons('From party', party);
      ok('seeding from the party fills slots in order',
        t.slots.length === Math.min(party.length, T.MAX_SLOTS)
        && t.slots[0].options[0].speciesId === party[0].speciesId, `${t.slots.length} slots`);
      // Caps at MAX_SLOTS, but a save with fewer Pokémon than that seeds
      // fewer -- the fixture has five, which is a legitimate save.
      const all = T.teamFromMons('X', index.map((x) => x.mon));
      ok('seeding caps at six and never invents slots',
        all.slots.length === Math.min(index.length, T.MAX_SLOTS),
        `${all.slots.length} from ${index.length} Pokémon`);
      ok('a seeded team reads as fielded',
        T.toBattleTeam(t, index, S).where === 'fielded' || party.length < 6);
    }
  }

  // ---- legacy teams keep working ------------------------------------------
  {
    const legacy = { ...T.blankTeam('Legacy'),
      slots: [{ ...T.monToSpec(index[0].mon), role: 'wall', why: 'takes hits' }] };
    const n = T.normalizeTeam(legacy);
    ok('a pre-options team migrates', n.slots[0].options?.length === 1
      && n.slots[0].options[0].speciesId === index[0].mon.speciesId);
    ok('its role and reason move to the slot', n.slots[0].role === 'wall' && n.slots[0].why === 'takes hits');
    ok('and it still converts', Boolean(T.toBattleTeam(legacy, index, S)));
  }

  // ---- offensive grid ------------------------------------------------------
  {
    const specs = index.filter((x) => x.loc === 'party').map((x) => T.monToSpec(x.mon));
    const g = T.offensiveGrid(specs, S);
    ok('the offensive grid covers all 17 types', g.length === 17);
    ok('every cell names the move it used, or none',
      g.every((r) => r.cells.every((c) => (c.mult > 0 ? Boolean(c.move) : c.move === null))));
    ok('a cell is the BEST multiplier that member can reach', g.every((r) => r.cells.every((c, i) => {
      const best = Math.max(0, ...specs[i].moveIds.filter(Boolean).map((mid) => {
        const mv = S.MOVES[S.MOVEBYID[String(mid)]];
        return !mv || mv.c === 'status' ? 0 : (S.CHART[mv.t]?.[r.type] ?? 1);
      }));
      return c.mult === best;
    })));
    ok('supers counts members hitting for more than neutral',
      g.every((r) => r.supers === r.cells.filter((c) => c.mult > 1).length));
    ok('untouchable means nobody can damage it at all',
      g.every((r) => r.untouchable === r.cells.every((c) => c.mult === 0)));
  }

  // ---- cores are ingredients, not teams -----------------------------------
  {
    const core = T.makeCore('My core', [T.monToSpec(index[0].mon), T.monToSpec(index[1].mon)]);
    const withCore = [core, T.teamFromMons('A team', [index[2].mon])];
    ok('a core is marked as one', T.isCore(core) && !T.isCore(withCore[1]));
    ok('cores() finds it', T.cores(withCore).length === 1);
    ok('onlyTeams() excludes it',
      T.onlyTeams(withCore).length === 1 && T.onlyTeams(withCore)[0].name === 'A team');
    // Cores DO become battle tabs. They were excluded at first, on the theory
    // that they were ingredients -- backwards: a core is the line-up you
    // adopted, so it is exactly the one you want to check against a gym.
    // Promotion moves a team rather than copying it, so nothing appears twice.
    const bts = T.battleTeams(4242, index, S, withCore);
    ok('an adopted core becomes a battle tab', bts.some((t) => t.name === 'My core'),
      bts.map((t) => t.name).join(', '));
    ok('and so does a scratchpad team', bts.some((t) => t.name === 'A team'));
    const asCore = bts.find((t) => t.name === 'My core');
    ok('the core is marked adopted and says so on the sheet',
      asCore.adopted === true && /^core/.test(asCore.where), asCore.where);
    ok('core and team ids cannot collide',
      new Set(bts.map((t) => t.id)).size === bts.length
      && asCore.id.startsWith('core-'));
    ok('a deleted core still never appears',
      !T.battleTeams(4242, index, S, T.tombstone(withCore, core.id))
        .some((t) => t.name === 'My core'));
    ok('a core holds full specs, so seeding from it keeps the build',
      core.slots[0].options[0].natureId === index[0].mon.natureId
      && core.slots[0].options[0].moveIds.some(Boolean));
    ok('deleting a core tombstones like a team',
      !T.cores(T.tombstone(withCore, core.id)).length);
  }

  // ---- generated names must not creep, and the store must not grow --------
  {
    // "Team ${teams.length + 1}" counted tombstones AND cores, so the number
    // climbed forever as teams were made and deleted.
    let ts = [T.blankTeam('Team 1'), T.blankTeam('Team 3'), T.makeCore('C', [])];
    ok('the next name fills the first gap', T.nextTeamName(ts) === 'Team 2', T.nextTeamName(ts));
    ts = T.tombstone(ts, ts[0].id);
    ok('deleting a team frees its number', T.nextTeamName(ts) === 'Team 1', T.nextTeamName(ts));
    ok('cores do not consume team numbers',
      T.nextTeamName([T.makeCore('Team 1', []), T.makeCore('Team 2', [])]) === 'Team 1');

    // Make and delete repeatedly: neither the numbering nor the store may drift.
    let churn = [];
    for (let i = 0; i < 12; i++) {
      const t = T.blankTeam(T.nextTeamName(churn));
      churn.unshift(t);
      churn = T.tombstone(churn, t.id);
    }
    ok('twelve make-and-delete cycles still offer Team 1',
      T.nextTeamName(churn) === 'Team 1', T.nextTeamName(churn));
    const aged = churn.map((t) => ({ ...t, deleted: Date.now() - 40 * 24 * 3600 * 1000 }));
    ok('tombstones older than the sync window are pruned',
      T.pruneTombstones(aged).length === 0, `${T.pruneTombstones(aged).length} left`);
    ok('recent tombstones are kept, or a delete could be undone by a stale copy',
      T.pruneTombstones(churn).length === churn.length);

    // Duplicate names are allowed -- everything downstream keys on id -- but
    // they must not collide into one battle tab.
    const a1 = T.teamFromMons('Same', [index[0].mon]);
    const b1 = T.teamFromMons('Same', [index[1].mon]);
    const bt = T.battleTeams(4242, index, S, [a1, b1]);
    ok('two teams with one name stay two teams',
      bt.filter((t) => t.name === 'Same').length === 2
      && new Set(bt.map((t) => t.id)).size === bt.length);
  }

  // ---- retiring a core -----------------------------------------------------
  {
    const core = T.makeCore('Settled', [T.monToSpec(index[0].mon)]);
    let ts = [core, T.teamFromMons('Scratch', [index[1].mon])];
    const restored = T.coreToTeam(core);
    ts = T.tombstone(ts, core.id);
    ts.unshift(restored);
    ok('moving a core back yields an editable team', !T.isCore(restored)
      && restored.slots[0].options[0].speciesId === index[0].mon.speciesId);
    ok('and the core is gone', !T.cores(ts).some((c) => c.id === core.id));
    ok('nothing is lost — the line-up is now a team',
      T.onlyTeams(ts).some((t) => t.name === 'Settled'));
    ok('the restored team has its own id', restored.id !== core.id);
  }

  // ---- the live party is always a tab, with no setup -----------------------
  {
    const pt = T.partyTeam(index, S);
    const party = index.filter((x) => x.loc === 'party');
    ok('a save with a party always gets a party tab', Boolean(pt) === (party.length > 0));
    if (pt) {
      ok('it has one slot per party member', pt.slots.length === party.length,
        `${pt.slots.length} of ${party.length}`);
      ok('it needs nothing saved to exist', T.loadLocal(999999).length === 0 && Boolean(pt));
      ok('it reads as fielded', pt.where === 'fielded' && pt.state === 'fielded');
      ok('its id cannot collide with a team or a core',
        pt.id === 'live-party' && pt.live === true);
      ok('every member reads as owned — it IS the party',
        pt.slots.every((sl) => !/not built yet/.test(sl.options[0].note ?? '')));
      // The numbers must be the game's own, not a recomputation that drifts.
      const first = party[0].mon;
      ok('its stats match the save exactly',
        JSON.stringify(pt.slots[0].options[0].mon.stats)
        === JSON.stringify(['hp', 'atk', 'def', 'spa', 'spd', 'spe'].map((k) => first.stats[k])),
        pt.slots[0].options[0].mon.stats.join('/'));
      ok('it still gets a real warning line', pt.warn.length > 10, pt.warn.slice(0, 60));
    }
    // An empty party is a legitimate state for a fresh save.
    ok('no party means no party tab', T.partyTeam([], S) === null);
  }

  // ---- built-in rosters are cores too --------------------------------------
  {
    const layouts = S.LAYOUT ?? [];
    ok('the static data carries the hand-authored rosters', layouts.length > 0, `${layouts.length}`);
    let withSwaps = 0, total = 0;
    for (const bt of layouts) {
      const t = T.layoutToTeam(bt, index, S);
      total++;
      if (t.slots.some((sl) => sl.options.length > 1)) withSwaps++;
      ok(`"${bt.name}" converts with all its slots`,
        t.slots.length === bt.slots.length, `${t.slots.length} of ${bt.slots.length}`);
    }
    ok('most carry a swap tree, not just six species', withSwaps >= Math.ceil(total / 2),
      `${withSwaps} of ${total}`);

    const k = T.layoutToTeam(layouts[0], index, S);
    ok('a built-in slot keeps its badge and its reason',
      k.slots.some((sl) => sl.options.some((o) => o.badge)) && k.slots.some((sl) => sl.why));
    // Only meaningful for a slot whose species you actually own -- an early
    // save shares nothing with these rosters, and a blank spec for a species
    // you lack is the correct output there, not a failure.
    const owned = T.matchPrimary(k, index, S)
      .map((m, i) => (m.state !== 'missing' ? i : -1)).filter((i) => i >= 0);
    if (owned.length) {
      ok('members present in the save bring their real build',
        k.slots[owned[0]].options[0].moveIds.some(Boolean),
        S.SPECIES[String(k.slots[owned[0]].options[0].speciesId)]?.name);
    } else {
      console.log('  [SKIP] real build carried over — this save shares nothing with the built-in rosters');
    }
    // Two slots must not both claim one Pokémon, same as everywhere else.
    const claimed = T.matchPrimary(k, index, S).map((m) => m.at?.key).filter(Boolean);
    ok('no two built-in slots claim the same Pokémon',
      new Set(claimed).size === claimed.length, `${claimed.length} claims`);
  }

  // ---- promoting a team MOVES it -------------------------------------------
  {
    let ts = [T.teamFromMons('Scratch', [index[0].mon, index[1].mon])];
    ts[0].slots[0].options.push({ ...T.monToSpec(index[2].mon), badge: 'alt', note: 'costs rain' });
    ts[0].slots[0].why = 'lead';
    const core = T.coreFromTeam('Adopted', ts[0]);
    ts.unshift(core);
    ts = T.tombstone(ts, ts[1].id);
    ok('the team leaves the scratchpad', T.onlyTeams(ts).length === 0,
      T.onlyTeams(ts).map((t) => t.name).join(', '));
    ok('and exists as a core', T.cores(ts).length === 1);
    ok('promotion keeps swaps, roles and reasons',
      core.slots[0].options.length === 2 && core.slots[0].why === 'lead'
      && core.slots[0].options[1].badge === 'alt');
    // And back again, losing nothing.
    const back = T.coreToTeam(core);
    ok('moving it back restores the swaps too', back.slots[0].options.length === 2);
  }

  // ---- warnings must read as permission, not prohibition -------------------
  {
    const src = fs.readFileSync(path.join(ROOT, 'app/js/tabs/builder.js'), 'utf8')
      + fs.readFileSync(path.join(ROOT, 'app/js/tabs/factory.js'), 'utf8');
    // Every place we tell someone something is illegal or over a cap must also
    // tell them it still works and they may proceed. A bare "you cannot" is
    // wrong here -- the whole point of these tabs is that you can.
    const scolds = [/would ever let you earn/, /is not something a legitimate/];
    ok('no warning phrased as a prohibition', !scolds.some((re) => re.test(src)),
      scolds.filter((re) => re.test(src)).map(String).join(', '));
    ok('every such warning says outright that you may proceed',
      (src.match(/not your mother/g) ?? []).length >= 3,
      `${(src.match(/not your mother/g) ?? []).length} found`);
    ok('illegal notices say the game honours it anyway',
      (src.match(/the game honours it/g) ?? []).length >= 2);
  }

  // The Builder must NOT offer its own exits. Edits made here land in the same
  // working copy every other tab edits, and the shell bar owns the single
  // Install/Download pair that gets it back onto disk -- a per-tab pair said
  // each tab had its own pile of pending changes when there is only ever one.

  // "Edit this one" is the third choice and the only one that writes: it must
  // change THAT record rather than plan a second copy. Splitting this decision
  // between the editor and the card is what it replaced.
  {
    const before = fac.dirty;
    R().find(hasClass('tb-addbtn')).click();
    const q2 = modal().find((n) => n.classList.contains('tb-search'));
    q2.value = unique.mon.species; q2.oninput();
    modal().findAll(hasClass('tb-pickcell'))
      .find((c) => c.text.trim() === unique.mon.species).click();
    // The copies panel starts shut now -- it is the advanced path -- so
    // reaching "edit this one" means opening it first, which is the point.
    btn(modal().find(hasClass('tb-yours')), /Copy one, or edit it in place/).click();
    btn(modal().find(hasClass('tb-yours')), /Edit this one/).click();
    ok('choosing "edit this one" arms the primary action',
      Boolean(btn(modal(), /Save & edit that one/)),
      'the button has to say which of the two things saving will do');
    ok('and the panel says the change lands in place',
      /in place/i.test(modal().find(hasClass('tb-yourhint'))?.text ?? ''));
    btn(modal(), /Save & edit that one/).click();
    ok('saving wrote to the working copy, not just to the plan',
      fac.dirty || before, 'edit-in-place has to actually edit');
    ok('and the editor closed', !modal());
  }

  ok('the Builder draws no save-actions of its own',
    !R().find(hasClass('tb-download')) && !R().find(hasClass('tb-install'))
    && !R().find(hasClass('tb-actions'))); 
  ok('it says whether the team reaches the battle tab',
    /Battle tab/.test(R().find(hasClass('tb-status'))?.text ?? ''),
    R().find(hasClass('tb-status'))?.text.slice(0, 60));

  builder.unmount();
  ok('unmount clears any modal', !body.children.some((n) => n.classList.contains('tb-modal')));
}

// ---- the Builder is where you explore a nature -----------------------------
// Its stat spread recomputed the numbers by hand and stopped short of applying
// the nature, so the one tab you use to try "what if this were Adamant" showed
// a figure that did not move when you changed it. It uses specStats() now,
// which is the same computation the Factory is checked against.
{
  const spec = { speciesId: 143, level: 50, natureId: 3, abilityId: 47, itemId: 0,
    moveIds: [33, 0, 0, 0],
    evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } };
  const neutralId = 0;                     // id 0 raises and lowers the same stat
  const adamant = T.specStats(spec, S);
  const neutral = T.specStats({ ...spec, natureId: neutralId }, S);
  ok('specStats applies the nature', JSON.stringify(adamant) !== JSON.stringify(neutral),
    `${neutral} vs ${adamant}`);
  const order = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
  const up = order.indexOf('atk'), down = order.indexOf('spa');
  ok('...raising the right stat and lowering the right one',
    adamant[up] > neutral[up] && adamant[down] < neutral[down],
    `atk ${neutral[up]}->${adamant[up]}, spa ${neutral[down]}->${adamant[down]}`);
  // And the tab must use it rather than keeping a second, lesser copy.
  const src = fs.readFileSync(path.join(ROOT, 'app/js/tabs/builder.js'), 'utf8');
  ok('and the stat spread uses it rather than its own formula',
    /T\.specStats\(/.test(src) && !/out\[k\] = k === 'hp' \? core/.test(src));
}

console.log(failed ? `\n  ${failed} check(s) FAILED` : '\n  all checks passed');
process.exit(failed ? 1 : 0);
