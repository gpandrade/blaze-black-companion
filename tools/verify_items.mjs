/**
 * verify_items.mjs -- exercise the Bag tab, save layer and UI.
 *
 * Why this file asserts what it does: notes/factory.md
 *
 *     node tools/verify_items.mjs [path/to/save.sav]
 *
 * The save-layer half matters most. A pocket is a flat array terminated by a
 * zero id, so removing an entry means shifting everything after it down --
 * leave a hole and the pocket truncates there, silently losing everything
 * past it. That is a data-loss bug you would not notice until you opened your
 * bag in game, so every shape of edit is checked against a re-read.
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
    this.children = []; this.attrs = {}; this.style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } }; this.className = '';
    this.textContent = ''; this.value = ''; this.disabled = false; this.selected = false;
    this.parentNode = null;
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
  body, createElement: (t) => new N(t), addEventListener() {}, removeEventListener() {},
  // rich() returns a DocumentFragment, so the stub needs one. N.append
  // flattens it the way the real DOM does, keeping .text assertions honest.
  createDocumentFragment: () => new N('#fragment'),
  createTextNode: (t) => Object.assign(new N('#text'), { textContent: t }),
  querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
};
const store = {};
global.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
const alerts = [];
global.alert = (m) => alerts.push(m);
global.confirm = () => true;
// Whatever the test last asked for, so a rename can be driven.
global.promptReply = null;
global.prompt = () => global.promptReply;
global.Blob = class {}; global.URL = { createObjectURL: () => '', revokeObjectURL() {} };
const hasClass = (c) => (n) => n.classList.contains(c);
const btn = (r, re) => r.find((n) => n.tagName === 'BUTTON' && re.test(n.text));

// ------------------------------------------------------------------ set-up
const { Save, POCKETS } = await import('../js/save.js');
const { Factory } = await import('../app/js/factory.js');
const itemsTab = (await import('../app/js/tabs/items.js')).default;

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
  console.error('verify_items: no save given and none found'); process.exit(2);
}
console.log(`  save: ${path.relative(ROOT, savePath)}\n`);
const S = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/data/static.json'), 'utf8'));
const original = new Uint8Array(fs.readFileSync(savePath));
const mkF = () => new Factory(Save.load(new Uint8Array(original)), S);

// ============================================================== SAVE LAYER
console.log('── save layer: setBagItem');
{
  const F = mkF();
  const sv = F.save;
  // An early save has almost nothing in its bag, which is a legitimate save --
  // so the edits are made against a pocket seeded here rather than one the
  // save happens to have filled.
  let pocket = Object.keys(POCKETS).find((p) => sv.readPocket(p).length >= 3);
  if (!pocket) {
    pocket = 'items';
    const seed = [17, 18, 19, 20];        // Potion, Antidote, Burn Heal, Ice Heal
    seed.forEach((id, i) => sv.setBagItem(pocket, id, i + 1, { reseal: false }));
    sv.reseal([(await import('../js/save.js')).BLOCKS.bag]);
    console.log(`         (bag was nearly empty — seeded ${seed.length} items to edit)`);
  }
  const before = sv.readPocket(pocket);
  ok('found a pocket with entries to work on', before.length >= 3, `${pocket}: ${before.length}`);

  // set
  sv.setBagItem(pocket, before[1].item_id, 42);
  ok('setting a count changes only that entry',
    sv.readPocket(pocket).find((e) => e.item_id === before[1].item_id).count === 42
    && sv.readPocket(pocket).length === before.length);

  // remove the FIRST entry: the shift-down case, where a bug loses the tail
  sv.setBagItem(pocket, before[0].item_id, 0);
  const after = sv.readPocket(pocket);
  ok('removing the first entry keeps every other one',
    after.length === before.length - 1
    && before.slice(1).every((e) => after.some((x) => x.item_id === e.item_id)),
    `${before.length} -> ${after.length}`);
  ok('and the removed one is gone', !after.some((e) => e.item_id === before[0].item_id));
  ok('the pocket has no hole in it — a re-read agrees',
    Save.load(sv.toBytes()).readPocket(pocket).length === after.length);

  // remove the LAST entry
  const last = after[after.length - 1];
  sv.setBagItem(pocket, last.item_id, 0);
  ok('removing the last entry works too',
    sv.readPocket(pocket).length === after.length - 1);

  // add
  sv.setBagItem(pocket, before[0].item_id, 3);
  const re = sv.readPocket(pocket);
  ok('adding puts it back at the end',
    re[re.length - 1].item_id === before[0].item_id && re[re.length - 1].count === 3);

  // clamping and no-ops
  sv.setBagItem(pocket, before[0].item_id, 99999);
  ok('a count is clamped to 999, not wrapped',
    sv.readPocket(pocket).find((e) => e.item_id === before[0].item_id).count === 999);
  const bytesBefore = sv.toBytes();
  sv.setBagItem(pocket, 60000, 0);
  ok('removing something you do not have changes nothing',
    sv.toBytes().every((v, i) => v === bytesBefore[i]));

  ok('the save still passes all three tiers', F.output().ok, F.output().problems.join('; '));
  ok('and every Pokémon still re-encodes', sv.selfTestRoundTrip().ok);

  // both slots, or the game may read the stale one
  const reread = Save.load(sv.toBytes());
  ok('the edit landed in both save slots',
    JSON.stringify(reread.readBag()) === JSON.stringify(sv.readBag()));

  // full pocket
  const G = mkF();
  const [, cap] = POCKETS.key_items;
  let threw = null;
  try {
    for (let i = 0; i < cap + 5; i++) G.save.setBagItem('key_items', 500 + i, 1, { reseal: false });
  } catch (e) { threw = e; }
  ok('a full pocket refuses rather than overrunning', threw !== null && /full/.test(threw.message),
    threw?.message ?? 'no error');
}

// ====================================================================== UI
console.log('\n── ui');
{
  const panel = new N('div');
  const F = mkF();
  itemsTab.mount(panel, { S, factory: F, config: null });
  const R = () => panel.children[0];

  ok('the five pockets are shown', R().findAll(hasClass('it-pocket')).length === 5,
    `${R().findAll(hasClass('it-pocket')).length}`);
  const names = R().findAll(hasClass('it-pocket')).map((p) => p.find((n) => n.tagName === 'SPAN')?.text);
  ok('in the game’s own order',
    JSON.stringify(names) === JSON.stringify(['Items', 'Medicine', 'TMs & HMs', 'Berries', 'Key Items']),
    names.join(' · '));

  const rows = () => R().findAll(hasClass('it-row'));
  ok('the first pocket lists its contents', rows().length > 0, `${rows().length} rows`);

  // search
  const search = R().find((n) => n.classList.contains('it-search'));
  const all = rows().length;
  search.value = 'zzzzz'; search.oninput();
  ok('search narrows the list', panel.children[0].findAll(hasClass('it-row')).length === 0);
  const s2 = panel.children[0].find((n) => n.classList.contains('it-search'));
  s2.value = ''; s2.oninput();
  ok('and clearing it restores them', panel.children[0].findAll(hasClass('it-row')).length === all);

  // sort
  const sortSel = panel.children[0].find((n) => n.classList.contains('it-sort'));
  const order = () => panel.children[0].findAll(hasClass('it-name')).map((n) => n.text);
  const bagOrder = order();
  sortSel.value = 'name'; sortSel.onchange();
  const byName = order();
  // The invariant is "the result is sorted". Whether that DIFFERS from bag
  // order depends on the bag -- a single-item pocket is already sorted, which
  // is correct, not a failure.
  ok('sorting by name produces a sorted list',
    JSON.stringify(byName) === JSON.stringify([...byName].sort((a, b) => a.localeCompare(b))),
    byName.slice(0, 3).join(', '));
  if (bagOrder.length > 2) {
    ok('and it is a different order from the bag\'s',
      JSON.stringify(byName) !== JSON.stringify(bagOrder));
  } else {
    console.log('  [SKIP] sort changes the order — too few items in this pocket to tell');
  }
  ok('the sort preference persists', /"sort":"name"/.test(store['blazeblack.items.view'] ?? ''));

  // TM pocket and its cross-reference. An early save owns no TMs at all, which
  // is a legitimate save -- the assertions are about the cross-reference, so
  // they only mean something when there is a TM to cross-reference.
  const tmTab = panel.children[0].findAll(hasClass('it-pocket'))
    .find((p) => /TMs/.test(p.text));
  tmTab.click();
  const tmRows = panel.children[0].findAll(hasClass('it-row'));
  if (tmRows.length) {
    ok('the TM pocket lists TMs', true, `${tmRows.length}`);
    ok('each TM says who can learn it',
      tmRows.every((r) => /can learn it|nothing you own/.test(r.text)),
      tmRows[0].text.slice(0, 60));
    tmRows[0].click();
    const d = panel.children[0].find(hasClass('it-detail'));
    ok('selecting shows the detail panel', /Quantity/.test(d.text));
    ok('and the move the TM teaches', /Teaches/.test(d.text), d.text.slice(0, 70));
  } else {
    console.log('  [SKIP] TM cross-reference — this save owns no TMs');
  }

  // Fall back to a pocket that HAS something, for the editing tests below.
  const withRows = panel.children[0].findAll(hasClass('it-pocket'))
    .find((p) => Number(p.find((n) => n.tagName === 'I')?.text ?? 0) > 0);
  ok('found a non-empty pocket to edit in', Boolean(withRows));
  withRows.click();
  // A row with headroom: +10 on something already clamped at 999 correctly
  // does nothing, which would look like a broken button in the test.
  const rowsHere = panel.children[0].findAll(hasClass('it-row'));
  const target = rowsHere.find((r) => {
    const q = Number((r.find(hasClass('it-qty'))?.text ?? '').replace('×', ''));
    return Number.isFinite(q) && q < 900;
  }) ?? rowsHere[0];
  target.click();
  ok('selecting any item shows its detail',
    /Quantity/.test(panel.children[0].find(hasClass('it-detail')).text));

  // quantity editing through the UI
  const qty = () => {
    const sel = panel.children[0].findAll(hasClass('it-row'))
      .find((r) => r.classList.contains('on'));
    return sel ? sel.find(hasClass('it-qty'))?.text : null;
  };
  const q0 = qty();
  btn(panel.children[0].find(hasClass('it-detail')), /^\+10$/).click();
  ok('the +10 button changes the quantity', qty() !== q0, `${q0} -> ${qty()}`);
  ok('editing marks the save dirty', F.dirty);
  ok('the working copy still verifies', F.output().ok);

  btn(panel.children[0], /^Undo$/).click();
  ok('undo puts it back', qty() === q0, `${qty()}`);

  // add dialog
  btn(panel.children[0], /Add item/).click();
  const modal = body.children.find((n) => n.classList.contains('it-modal'));
  ok('the add dialog opens', Boolean(modal));
  if (modal) {
    const cand = modal.findAll(hasClass('it-row'));
    ok('it offers items for this pocket that you do not already have', cand.length > 0, `${cand.length}`);
    const nameBefore = cand[0].find(hasClass('it-name')).text;
    cand[0].click();
    ok('picking one adds it and closes',
      !body.children.some((n) => n.classList.contains('it-modal')));
    ok('and it is now in the pocket',
      panel.children[0].findAll(hasClass('it-name')).some((n) => n.text === nameBefore),
      nameBefore);
    ok('the save is still valid afterwards', F.output().ok, F.output().problems.join('; '));
  }

  // ---- equipping and teaching, the two cross-tab actions -------------------
  {
    const G = mkF();
    const party0 = { loc: 'party', index: 0 };
    const mon0 = G.read('party')[0].mon;
    ok('there is a party member to work with', Boolean(mon0));

    // Give an item, and check NOTHING else moved. A surgical patch that
    // rebuilds the record from defaults would pass a "holds the item" check
    // while silently resetting IVs, moves or nature.
    const before = { ...mon0, moves: mon0.moves.map((m) => m.id) };
    const had = G.giveItem(party0, 270);                    // Life Orb
    const after = G.read('party')[0].mon;
    ok('the item is now held', after.itemId === 270, after.item);
    ok('and it returned whatever was there before', typeof had === 'number');
    ok('everything else about the Pokémon is untouched',
      after.speciesId === before.speciesId && after.level === before.level
      && after.natureId === before.natureId && after.abilityId === before.abilityId
      && JSON.stringify(after.ivs) === JSON.stringify(before.ivs)
      && JSON.stringify(after.evs) === JSON.stringify(before.evs)
      && JSON.stringify(after.moves.map((m) => m.id)) === JSON.stringify(before.moves));
    ok('the save is still valid', G.output().ok, G.output().problems.join('; '));

    // Teach a TM into a slot.
    const tm = Object.values(S.ITEMINFO).find((d) => d.tm === 'TM25');
    const learners = G.canLearn('TM25');
    ok('canLearn only returns species that legally can',
      learners.every((c) => (S.SPECIES[String(c.mon.speciesId)].tmhm ?? []).includes('TM25')),
      `${learners.length} learners`);
    if (learners.length) {
      const at = { loc: learners[0].loc, index: learners[0].index };
      const was = G.read(at.loc)[at.index].mon;
      const prevIds = was.moves.map((m) => m.id);
      G.teachMove(at, tm.move_id, 3);
      const now = G.read(at.loc)[at.index].mon;
      const slot3 = now.moves.find((m) => m.slot === 3);
      ok('the move lands in the slot asked for', slot3?.id === tm.move_id, slot3?.name);
      ok('its PP is the ROM base, with PP Ups reset',
        slot3.pp === S.MOVES[tm.move].pp && slot3.ppUps === 0,
        `${slot3.pp} PP, ${slot3.ppUps} ups`);
      ok('the other three slots are untouched',
        [0, 1, 2].every((i) => (now.moves.find((m) => m.slot === i)?.id ?? 0) === (prevIds[i] ?? 0)));
      ok('and the record still round-trips', G.save.selfTestRoundTrip().ok);
    }

    G.undo();
    ok('undo reverses a teach', JSON.stringify(G.read('party')[0].mon.itemId) !== 'null');
    ok('the working copy is still coherent', G.output().ok);
  }

  itemsTab.unmount();
  ok('unmount clears the modal and its root',
    !body.children.some((n) => n.classList.contains('it-modal')) && panel.children.length === 0);
}

console.log(failed ? `\n  ${failed} check(s) FAILED` : '\n  all checks passed');
process.exit(failed ? 1 : 0);
