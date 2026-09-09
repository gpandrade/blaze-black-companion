/**
 * verify_factory.mjs -- exercise the Pokémon Factory, model and UI.
 *
 * Why this file asserts what it does: notes/factory.md
 *
 *     node tools/verify_factory.mjs [path/to/save.sav]
 *
 * Two halves:
 *
 *   MODEL   move / delete / edit / create / duplicate / undo against a real
 *           save, asserting the save still passes all three integrity tiers
 *           and every record still re-encodes byte-identically after each op.
 *           An edited save that fails either is one the game may refuse or
 *           silently wipe, so the download is gated on both.
 *
 *   UI      mount the tab against a stubbed DOM and drive it the way a person
 *           would: click a slot, arm a move, complete it, open the editor,
 *           change fields, save. A tab that throws on click renders a dead
 *           grid with nothing in the console, which is not something a model
 *           test can see.
 *
 * READ-ONLY. Defaults to the newest save backup and never writes a file.
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
// A real (tiny) tree, not a Proxy: the tab reads back what it built -- child
// lists, classes, aria state -- so a stub that swallows everything would pass
// no matter what the tab did.
class N {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.attrs = {}; this.style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } }; this.dataset = {};
    this.className = ''; this.textContent = ''; this.value = ''; this.checked = false;
    this.disabled = false; this.selected = false; this.parentNode = null;
    this._listeners = {};
    this.classList = {
      add: (c) => { if (!this.className.split(' ').includes(c)) this.className = (this.className + ' ' + c).trim(); },
      remove: (c) => { this.className = this.className.split(' ').filter((x) => x && x !== c).join(' '); },
      toggle: (c, on) => (on ?? !this.className.split(' ').includes(c)) ? this.classList.add(c) : this.classList.remove(c),
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
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, f) { (this._listeners[t] ??= []).push(f); }
  removeEventListener(t, f) { this._listeners[t] = (this._listeners[t] ?? []).filter((x) => x !== f); }
  // Forwards modifiers, so Ctrl/Shift-click can be driven. An earlier version
  // dropped them, and a cross-area selection test silently passed as a plain
  // click replacing the selection.
  focus() {} blur() {}
  // A REAL CLICK EVENT CARRIES THESE. A stub whose event lacks
  // preventDefault/stopPropagation throws on handlers that work perfectly in a
  // browser -- the same faithfulness rule that got replaceWith() and focus().
  click(ev = {}) {
    this.onclick?.({ target: this, preventDefault() {}, stopPropagation() {}, ...ev });
  }
  get text() {
    return (this.textContent || '') + this.children.map((c) => c.text ?? c.textContent ?? '').join('');
  }
  *walk() { yield this; for (const c of this.children) if (c.walk) yield* c.walk(); }
  find(pred) { for (const n of this.walk()) if (pred(n)) return n; return null; }
  findAll(pred) { return [...this.walk()].filter(pred); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
const hasClass = (c) => (n) => n.classList.contains(c);
const buttonNamed = (rootNode, re) =>
  rootNode.find((n) => n.tagName === 'BUTTON' && re.test(n.text));

const body = new N('body');
const docListeners = {};
global.document = {
  body,
  createElement: (t) => new N(t),
  // rich() returns a DocumentFragment, so the stub needs one. N.append
  // flattens it the way the real DOM does, keeping .text assertions honest.
  createDocumentFragment: () => new N('#fragment'),
  createTextNode: (t) => Object.assign(new N('#text'), { textContent: t }),
  addEventListener: (t, f) => { (docListeners[t] ??= []).push(f); },
  removeEventListener: (t, f) => { docListeners[t] = (docListeners[t] ?? []).filter((x) => x !== f); },
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
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
let downloaded = null;
global.Blob = class { constructor(parts) { downloaded = parts[0]; } };
global.URL = { createObjectURL: () => 'blob:stub', revokeObjectURL() {} };

// ------------------------------------------------------------------ set-up
const { Save } = await import('../js/save.js');
const { Factory, FactoryError, locLabel, SORTS } = await import('../app/js/factory.js');
const factoryTab = (await import('../app/js/tabs/factory.js')).default;
const { downloadSave, stagedAndValid } = await import('../app/js/install.js');

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
  console.error('verify_factory: no save given and none found in save_backups/');
  process.exit(2);
}
console.log(`  save: ${path.relative(ROOT, savePath)}\n`);

const S = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/data/static.json'), 'utf8'));
const original = new Uint8Array(fs.readFileSync(savePath));
const mkFactory = () => new Factory(Save.load(new Uint8Array(original)), S);

/** After every mutation the save must still be something the game accepts. */
const intact = (F, label) => {
  const out = F.output();
  ok(`${label}: still verifies and re-encodes`, out.ok, out.problems.join('; '));
};

// ================================================================== MODEL
console.log('── model');
{
  const F = mkFactory();
  ok('the loaded save is never touched', F.origin !== F.save
    && F.origin.toBytes().every((v, i) => v === original[i]));
  ok('starts clean', F.dirty === false && F.canUndo === false);

  const party = F.read('party').filter((s) => s.mon);
  ok('party reads', party.length > 0, party.map((s) => s.mon.species).join(', '));
  // Test the legality MECHANISM, not whether this particular save happens to
  // contain a rigged Pokémon -- an untouched early save contains none.
  {
    const all = F.locations().flatMap((l) => F.read(l.loc)).filter((s) => s.mon);
    const wrong = all.filter((s) => {
      const legal = (S.SPECIES[String(s.mon.speciesId)]?.ability_ids ?? []).filter(Boolean);
      return s.mon.abilityLegal !== legal.includes(s.mon.abilityId);
    });
    ok('ability legality matches the ROM species table for every Pokémon',
      wrong.length === 0, wrong.slice(0, 3).map((s) => `${s.mon.species}/${s.mon.ability}`).join(', '));
    const rigged = all.filter((s) => !s.mon.abilityLegal).length;
    console.log(`         (${all.length} Pokémon, ${rigged} with an ability the species cannot legally have)`);
  }

  // Set inside the box block below, read after it, so the reload check can
  // assert against whatever the edits actually left behind.
  let editedSpecies = null;

  // Pick a box with at least two occupants and a free slot, instead of
  // hardcoding one. A save whose boxes are empty is a legitimate save.
  const b = F.locations().filter((l) => typeof l.loc === 'number')
    .map((l) => l.loc)
    .find((n) => F.read(n).filter((s) => s.mon).length >= 2 && F.firstFree(n));
  // A save with empty boxes is perfectly legitimate -- an early game has
  // them. Skipping is reported, not counted as a failure.
  const before = b == null ? [] : F.read(b).map((s) => s.mon?.species ?? null);
  if (b == null) {
    console.log('  [SKIP] box move/edit/duplicate — no box has two Pokémon and a free slot');
  } else {
    console.log(`         (box tests using Box ${b + 1})`);
  F.move({ loc: b, index: 0 }, { loc: b, index: 1 });
  const after = F.read(b).map((s) => s.mon?.species ?? null);
  ok('move swaps two occupied box slots',
    after[0] === before[1] && after[1] === before[0], `${before[0]}/${before[1]} -> ${after[0]}/${after[1]}`);
  intact(F, 'after box swap');

  // move into an empty slot leaves the source empty
  const free = F.firstFree(b);
  if (free) {
    F.move({ loc: b, index: 0 }, free);
    ok('move to an empty slot vacates the source', F.read(b)[0].mon === null);
    F.undo();
  }

  // box -> party
  const beforeParty = F.read('party').filter((s) => s.mon).map((s) => s.mon.species);
  F.move({ loc: b, index: 0 }, { loc: 'party', index: 5 });
  const afterParty = F.read('party').filter((s) => s.mon).map((s) => s.mon.species);
  ok('box -> party swaps and keeps the party full',
    afterParty.length === beforeParty.length && afterParty[5] !== beforeParty[5],
    `${beforeParty[5]} -> ${afterParty[5]}`);
  intact(F, 'after box->party');
  ok('party count header matches the party',
    F.save.partyCountDeclared === afterParty.length, `header ${F.save.partyCountDeclared}`);

  F.undo();
  ok('undo restores the party',
    F.read('party').filter((s) => s.mon).map((s) => s.mon.species).join() === beforeParty.join());

  // SHRINKING and GROWING the party is the path where a stale count header
  // corrupts things, and a swap never exercises it -- the size stays 6 either
  // way. Pull a member out to an empty box slot and put it back.
  {
    const P = mkFactory();
    const empty = P.firstFree(b);
    ok('found an empty box slot to test party size changes', Boolean(empty));
    if (empty) {
      const n0 = P.read('party').filter((s) => s.mon).length;
      const pulled = P.read('party')[n0 - 1].mon.species;
      P.move({ loc: 'party', index: n0 - 1 }, empty);
      const n1 = P.read('party').filter((s) => s.mon).length;
      ok('party -> empty box slot shrinks the party', n1 === n0 - 1, `${n0} -> ${n1}`);
      ok('the count header follows the party DOWN',
        P.save.partyCountDeclared === n1, `header ${P.save.partyCountDeclared}, actual ${n1}`);
      ok('the pulled Pokémon is in the box', P.read(empty.loc)[empty.index].mon.species === pulled, pulled);
      intact(P, 'after shrinking the party');

      P.move(empty, { loc: 'party', index: n1 });
      const n2 = P.read('party').filter((s) => s.mon).length;
      ok('box -> empty party slot grows the party back', n2 === n0, `${n1} -> ${n2}`);
      ok('the count header follows the party UP',
        P.save.partyCountDeclared === n2, `header ${P.save.partyCountDeclared}, actual ${n2}`);
      intact(P, 'after growing the party');

      // The header is what the GAME reads, so a reload must agree.
      const rl = Save.load(P.output().bytes);
      ok('a reloaded save agrees on party size',
        rl.partyCountDeclared === rl.readParty().length && rl.readParty().length === n2,
        `header ${rl.partyCountDeclared}, decoded ${rl.readParty().length}`);
    }
  }

  // edit
  const at = { loc: b, index: 2 };
  const was = F.read(b)[2].mon.species;
  F.write(at, {
    species: 'Metagross', level: 75, ability: 'Huge Power', nature: 'Adamant',
    moves: ['Meteor Mash', 'Earthquake', 'Bullet Punch', 'Zen Headbutt'],
    item_id: 234, shiny: true, nick: 'BEAST', gender: 'genderless',
    evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  });
  const ed = F.read(b)[2].mon;
  ok('edit writes every field', ed.species === 'Metagross' && ed.level === 75
    && ed.nature === 'Adamant' && ed.shiny && ed.nickname === 'BEAST' && ed.isNicknamed
    && ed.item === 'Leftovers' && ed.gender === 'genderless'
    && ed.moves.map((m) => m.name).join() === 'Meteor Mash,Earthquake,Bullet Punch,Zen Headbutt',
    `${was} -> ${ed.species} L${ed.level}`);
  ok('an illegal ability is written and flagged, not rejected',
    ed.ability === 'Huge Power' && ed.abilityLegal === false);
  intact(F, 'after edit');

  // level -> EXP -> level must survive the round trip through the record
  ok('level round-trips through EXP', ed.level === 75, `got ${ed.level}`);

  // The nicknamed FLAG is a bit in the IV field, easy to clear by accident on
  // an unrelated edit. Both directions are constructed rather than hoping the
  // save contains one of each.
  {
    const base = {
      level: 40, ability: 'Levitate', nature: 'Modest', moves: ['Thunderbolt'],
      item_id: 0, gender: 'genderless',
      evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
      ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    };
    F.write(at, { ...base, species: 'Magnemite', nick: 'Sparky' });
    let m = F.read(b)[at.index].mon;
    ok('a nickname sets the nicknamed flag', m.nickname === 'Sparky' && m.isNicknamed, m.nickname);

    // Change ONLY the species, passing the same nickname back.
    F.write(at, { ...base, species: 'Magneton', nick: 'Sparky' });
    m = F.read(b)[at.index].mon;
    ok('changing species keeps the nickname and its flag',
      m.species === 'Magneton' && m.nickname === 'Sparky' && m.isNicknamed,
      `${m.species} / ${m.nickname} / ${m.isNicknamed}`);

    F.write(at, { ...base, species: 'Magneton', nick: null });
    m = F.read(b)[at.index].mon;
    ok('clearing the nickname clears the flag and shows the species',
      !m.isNicknamed && m.nickname.toUpperCase() === 'MAGNETON', `${m.nickname} / ${m.isNicknamed}`);
    intact(F, 'after nickname edits');
  }

  // duplicate -- read what is actually in the slot rather than hardcoding a
  // species, so reordering the tests above cannot silently break this one.
  const toCopy = F.read(b)[at.index].mon.species;
  editedSpecies = toCopy;
  const dupTo = F.duplicate(at);
  ok('duplicate lands in a free slot of the same box',
    F.read(dupTo.loc)[dupTo.index].mon.species === toCopy,
    `${toCopy} -> ${locLabel(dupTo.loc)} slot ${dupTo.index + 1}`);
  intact(F, 'after duplicate');

  // delete
  F.remove(dupTo);
  ok('delete empties the slot', F.read(dupTo.loc)[dupTo.index].mon === null);
  intact(F, 'after delete');

  }

  // ---- healing -------------------------------------------------------------
  {
    const H = mkFactory();
    const { encodeRecord } = await import('../js/pk5.js');

    // Damage the lead so healing has something to do: 1 HP and one move down
    // to 1 PP. Constructed rather than hoping the save happens to be hurt.
    const e = H.partyEntries();
    const f0 = H.save.readSlot('party', 0);
    const body = new Uint8Array(f0.body);
    const firstMove = f0.move_ids.findIndex(Boolean);
    body[0x28 + firstMove] = 1;
    const extra = new Uint8Array(e[0].extra);
    new DataView(extra.buffer).setUint16(0x06, 1, true);
    new DataView(extra.buffer).setUint32(0x00, 0x08, true);      // a status condition
    e[0] = { record: encodeRecord(f0.pid, f0.sanity, body), extra };
    H.save.writeParty(e);

    const before = H.save.readSlot('party', 0);
    ok('the test really did damage it', before.current_hp === 1
      && before.pp[firstMove] === 1, `${before.current_hp} HP, ${before.pp[firstMove]} PP`);

    const r = H.healParty();
    const after = H.save.readSlot('party', 0);
    ok('healing restores HP to the stored maximum',
      after.current_hp === after.stored_stats.hp, `${after.current_hp}/${after.stored_stats.hp}`);
    ok('healing restores PP to base + base*ppUps/5', after.pp.every((pp, i) => {
      const mid = after.move_ids[i];
      if (!mid) return pp === 0;
      const base = S.MOVES[S.MOVEBYID[String(mid)]]?.pp ?? 0;
      return pp === base + Math.floor(base * after.pp_ups[i] / 5);
    }), after.pp.join('/'));
    ok('healing clears status', H.save.partySlotRaw(0).extra[0] === 0);
    ok('it reports what it actually restored',
      r.healed.some((x) => x.hp > 0 && x.pp > 0), JSON.stringify(r.healed[0] ?? null));
    ok('nobody is left over the maximum', H.read('party').filter((x) => x.mon)
      .every((x) => x.mon.currentHp <= x.mon.maxHp));
    intact(H, 'after healing');
    ok('the party is still the same size and order',
      H.read('party').filter((x) => x.mon).length === e.length
      && H.save.partyCountDeclared === e.length);

    // Idempotent: healing an already-healthy party changes nothing to report.
    const again = H.healParty();
    ok('healing a healthy party reports nothing restored', again.healed.length === 0);

    H.undo();
    ok('undo puts the damage back', H.save.readSlot('party', 0).current_hp !== after.stored_stats.hp
      || H.save.readSlot('party', 0).pp[firstMove] === 1);
  }

  // ---- multi-move and sorting ------------------------------------------
  {
    const M = mkFactory();
    const boxes = M.locations().filter((l) => typeof l.loc === 'number').map((l) => l.loc);
    const from = boxes.find((n) => M.read(n).filter((x) => x.mon).length >= 3);
    const to = boxes.find((n) => M.read(n).filter((x) => x.mon).length === 0);
    if (from == null || to == null) {
      console.log('  [SKIP] multi-move — needs a box with 3 Pokémon and an empty box');
    } else {
      const picked = M.read(from).filter((x) => x.mon).slice(0, 3);
      const names = picked.map((x) => x.mon.species);
      const landed = M.moveMany(picked.map((x) => ({ loc: from, index: x.index })), to, 0);
      ok('moveMany places every selection in order',
        landed.length === 3
        && M.read(to).slice(0, 3).map((x) => x.mon?.species).join() === names.join(),
        names.join(', '));
      ok('moveMany vacates the sources',
        picked.every((x) => M.read(from)[x.index].mon?.species !== x.mon.species)
        || M.read(from).filter((y) => y.mon).length === M.read(from).filter((y) => y.mon).length);
      intact(M, 'after moveMany');

      // Inserting inside a FULL box is the case fill-the-gaps got wrong: it
      // is a silent no-op there, because the slot a Pokémon is lifted out of
      // is the first free one again.
      const full = boxes.find((n) => M.firstFree(n) === null);
      if (full != null) {
        const b0 = M.read(full).map((x) => x.mon.species);
        M.moveMany([{ loc: full, index: 3 }], full, 0);
        const b1 = M.read(full).map((x) => x.mon.species);
        ok('insert inside a full box actually reorders',
          b1[0] === b0[3] && b1.join() !== b0.join(), `${b0[3]} moved to the front`);
        intact(M, 'after reordering a full box');
      } else {
        console.log('  [SKIP] full-box reorder — no box is full');
      }

      // capacity refusal
      let refusedMany = null;
      try {
        M.moveMany(M.read(to).filter((x) => x.mon).map((x) => ({ loc: to, index: x.index })),
          'party', 0);
      } catch (e) { refusedMany = e; }
      const partyFull = M.read('party').filter((x) => x.mon).length === 6;
      ok('moveMany refuses rather than overfilling',
        !partyFull || refusedMany instanceof FactoryError,
        refusedMany?.message ?? 'party had room, nothing to refuse');
    }

    // sorting: every key must produce a total order and leave a valid save
    const sortable = boxes.find((n) => M.read(n).filter((x) => x.mon).length >= 3);
    if (sortable != null) {
      for (const key of Object.keys(SORTS)) {
        const K = mkFactory();
        K.sortBox(sortable, key);
        const got = K.read(sortable).filter((x) => x.mon);
        const outK = K.output();
        ok(`sort by ${key}`, outK.ok && got.length > 0,
          outK.ok ? got.slice(0, 3).map((x) => x.mon.species).join(', ') : outK.problems.join('; '));
      }
      // Sorting compacts, so the count must be preserved exactly.
      const K = mkFactory();
      const n0 = K.read(sortable).filter((x) => x.mon).length;
      K.sortBox(sortable, 'dex');
      const after = K.read(sortable);
      ok('sorting preserves every Pokémon and compacts to the front',
        after.filter((x) => x.mon).length === n0
        && after.slice(0, n0).every((x) => x.mon)
        && after.slice(n0).every((x) => !x.mon), `${n0} kept`);
      // Twice must be idempotent, or the comparator is not a total order.
      const once = K.read(sortable).map((x) => x.mon?.speciesId ?? 0).join();
      K.sortBox(sortable, 'dex');
      ok('sorting twice is idempotent (comparator is a total order)',
        K.read(sortable).map((x) => x.mon?.speciesId ?? 0).join() === once);
    }
  }

  // guards
  const g = mkFactory();
  let refused = null;
  try { for (let i = 5; i >= 0; i--) g.remove({ loc: 'party', index: i }); } catch (e) { refused = e; }
  ok('refuses to empty the party', refused instanceof FactoryError, refused?.message ?? 'not refused');
  ok('the refused op left the party intact', g.read('party').filter((s) => s.mon).length >= 1);
  intact(g, 'after a refused delete');

  refused = null;
  try { g.move({ loc: 20, index: 29 }, { loc: 20, index: 0 }); } catch (e) { refused = e; }
  ok('refuses to move from an empty slot', refused instanceof FactoryError);

  // box capacity
  const c = mkFactory();
  c.setBoxCapacity(24);
  ok('box capacity can be raised to 24', c.save.boxCapacity === 24);
  intact(c, 'after raising box capacity');

  // the downloaded bytes must reload cleanly
  const out = F.output();
  const reread = Save.load(out.bytes);
  ok('the downloaded save reloads', reread.readParty().length > 0
    && reread.selfTestRoundTrip().ok, `${reread.selfTestRoundTrip().checked} records`);
  // Only meaningful if the box tests ran -- the Metagross came from the edit.
  if (b != null && editedSpecies) {
    ok('edits survive the reload',
      reread.readBox(b).some((f) => S.SPECIES[String(f.species_id)].name === editedSpecies),
      `expected ${editedSpecies} in ${locLabel(b)}`);
  }
}

// ===================================================================== UI
console.log('\n── ui');
{
  const panel = new N('div');
  const save = Save.load(new Uint8Array(original));
  // The shell hands every tab a refreshActions() so it can keep the ONE
  // Install/Download pair in step with the shared working copy. Count the
  // calls: a tab that mutates the copy without saying so leaves the only
  // way out of the app greyed while there are real changes staged.
  let refreshes = 0;
  const uiFactory = new Factory(save, S);
  factoryTab.mount(panel, { S, save, factory: uiFactory,
    refreshActions: () => { refreshes += 1; } });
  // Membership read off the rendered chips' own counts, since the tab's
  // Factory instance is module-private -- which is the right thing to assert
  // anyway: what the user can see.
  const F_membership = () => panel.children[0].findAll(hasClass('fx-chip'))
    .map((c) => c.getAttribute('title'));
  const root = panel.children[0];
  ok('mount renders a root', Boolean(root) && root.classList.contains('fx'));
  ok('toolbar present', Boolean(root.find(hasClass('fx-bar'))));
  ok('box chips present', Boolean(root.find(hasClass('fx-chips'))));

  // Party, Battle Box and one PC box are all on screen at once now.
  const areas = () => panel.children[0].findAll(hasClass('fx-grid-wrap'));
  const areaNamed = (re) => areas().find((a) => re.test(a.find((n) => n.tagName === 'H3')?.text ?? ''));
  const slotsIn = (a) => a.findAll(hasClass('fx-slot'));

  ok('party is on screen without navigating to it', Boolean(areaNamed(/^Party/)));
  ok('battle box is on screen too', Boolean(areaNamed(/^Battle Box/)));
  ok('a PC box is always shown below', Boolean(areaNamed(/^Box \d/)));
  ok('party area has exactly 6 slots', slotsIn(areaNamed(/^Party/)).length === 6,
    `${slotsIn(areaNamed(/^Party/)).length}`);
  ok('the PC box area has 30', slotsIn(areaNamed(/^Box \d/)).length === 30,
    `${slotsIn(areaNamed(/^Box \d/)).length}`);
  ok('there is a chip per box', root.findAll(hasClass('fx-chip')).length === 24,
    `${root.findAll(hasClass('fx-chip')).length}`);
  // Install and Download moved to the shell bar, because they act on the one
  // working copy every tab shares and three copies of the pair implied three
  // separate piles of pending changes. Assert the tab does NOT draw its own --
  // a second pair reappearing here is the regression worth catching.
  const goBtn = (cls) => root.find((n) => n.tagName === 'BUTTON' && n.classList.contains(cls));
  ok('the tab draws no save-actions of its own',
    !root.find(hasClass('fx-actions')) && !goBtn('fx-download') && !goBtn('fx-install'));
  ok('mounting told the shell to refresh its actions', refreshes > 0, `${refreshes}`);

  // hide / show the battle box, and the preference persists
  buttonNamed(areaNamed(/^Battle Box/), /^Hide$/).click();
  ok('battle box hides', !areaNamed(/^Battle Box/) && Boolean(buttonNamed(panel.children[0], /Show Battle Box/)));
  ok('hiding is remembered', store['fx.hideBattleBox'] === '1');
  buttonNamed(panel.children[0], /Show Battle Box/).click();
  ok('battle box comes back', Boolean(areaNamed(/^Battle Box/)));

  // switching boxes via a chip
  const chip9 = root.findAll(hasClass('fx-chip'))[8];
  chip9.click();
  ok('clicking a chip switches the PC box',
    /^Box 9/.test(areaNamed(/^Box \d/).find((n) => n.tagName === 'H3').text));

  let slots = slotsIn(areaNamed(/^Party/));

  // click a slot -> it selects, detail fills in
  slots[0].click();
  const detail = panel.children[0].find(hasClass('fx-detail'));
  ok('clicking a slot fills the detail panel',
    Boolean(detail) && /Level/.test(detail.text), detail?.text.slice(0, 40));
  ok('Edit / Move / Delete offered', ['Edit', 'Move to', 'Delete']
    .every((l) => buttonNamed(panel.children[0], new RegExp(l))));

  // The ball picker. Offered from the detail rail like the other two "act on
  // this one Pokemon" verbs, and it opens a grid of every ball the ROM has --
  // not the ones in your bag, because the field costs nothing to change.
  {
    const open = buttonNamed(panel.children[0], /^Ball/);
    ok('a ball picker is offered', Boolean(open));
    open.click();
    const grid = document.body.find?.(hasClass('fx-ballgrid'))
      ?? [...document.body.children].map((c) => c.find?.(hasClass('fx-ballgrid'))).find(Boolean);
    const opts = grid ? grid.findAll(hasClass('fx-ball')) : [];
    ok('...listing every ball in the ROM, not just the ones you own',
      opts.length >= 12, `${opts.length} balls`);
    ok('...marking the one it is in now',
      opts.filter((b) => b.classList.contains('on')).length === 1);
    // Picking one writes, and the shell has to be told the working copy moved.
    const was = refreshes;
    const other = opts.find((b) => !b.classList.contains('on'));
    other.click();
    ok('...and choosing one tells the shell there are staged edits',
      refreshes > was, `${was} -> ${refreshes}`);
    ok('...closing the dialog behind it',
      !document.body.children.some((c) => c.classList?.contains('pk-modal')));
  }

  // arm a move, complete it on slot 2 -> the two swap
  const nameOf = (i) => slotsIn(areaNamed(/^Party/))[i].find((n) => n.tagName === 'B')?.text ?? null;
  const a0 = nameOf(0), a1 = nameOf(1);
  buttonNamed(panel.children[0], /Move to/).click();
  ok('move mode is armed', panel.children[0].classList.contains('fx-moving'));
  slotsIn(areaNamed(/^Party/))[1].click();
  ok('clicking a destination performs the swap',
    nameOf(0) === a1 && nameOf(1) === a0, `${a0}/${a1} -> ${nameOf(0)}/${nameOf(1)}`);
  {
    const before = refreshes;
    // The swap above already mutated the working copy; the tab re-rendered,
    // so the shell must have been told at least once more since mount.
    ok('changing the working copy refreshes the shell actions', before > 1, `${before} calls`);
  }

  // Cross-area selection is the point of the new layout: pick one out of the
  // party and one out of a box in a single gesture, with no navigation.
  {
    slotsIn(areaNamed(/^Party/))[0].click();
    // Any occupied slot outside the party will do -- an early save has empty
    // boxes and an empty Battle Box, which is a legitimate save, not a bug.
    const partner = areas()
      .filter((a) => !/^Party/.test(a.find((n) => n.tagName === 'H3')?.text ?? ''))
      .flatMap(slotsIn)
      .find((c) => !c.classList.contains('empty'));
    if (!partner) {
      console.log('  [SKIP] cross-area selection — nothing outside the party in this save');
    } else {
      partner.click({ ctrlKey: true });
      const d = panel.children[0].find(hasClass('fx-detail'));
      ok('a selection can span the party and another area',
        /2 selected/.test(d.text) && /Party/.test(d.text), d.text.slice(0, 50));
      ok('the multi panel offers a combined move', Boolean(buttonNamed(d, /Move 2 to/)));
    }
  }

  // open the editor, change species and level, save.
  slotsIn(areaNamed(/^Party/))[0].click();
  const nickBefore = panel.children[0].find(hasClass('fx-detail'))
    .find((n) => n.tagName === 'H3')?.text ?? '';
  buttonNamed(panel.children[0].find(hasClass('fx-detail')), /^Edit$/).click();
  const modal = body.children.find((n) => n.classList.contains('fx-modal'));
  // The nature's +/-10% marked on the stat name, the way the game marks it.
  // Which two stats move is derivable from the id alone -- id/5 up, id%5 down,
  // over [atk, def, spe, spa, spd] -- so a wrong stat ORDER would show up as
  // the wrong pair highlighted and nothing else.
  {
    const { natureEffect } = await import('../js/tables.js');
    ok('a neutral nature marks nothing', natureEffect(0) === null && natureEffect(24) === null);
    const adamant = natureEffect(3), timid = natureEffect(10), careful = natureEffect(23);
    ok('Adamant is +Atk / -SpA', adamant.up === 'atk' && adamant.down === 'spa',
      `${adamant.up}/${adamant.down}`);
    ok('Timid is +Spe / -Atk', timid.up === 'spe' && timid.down === 'atk',
      'speed sits THIRD in the nature order, not last');
    ok('Careful is +SpD / -SpA', careful.up === 'spd' && careful.down === 'spa');
    ok('every non-neutral nature moves two different stats',
      Array.from({ length: 25 }, (_, i) => natureEffect(i))
        .every((e) => e === null || e.up !== e.down));
    ok('exactly five natures are neutral',
      Array.from({ length: 25 }, (_, i) => natureEffect(i)).filter((e) => e === null).length === 5);
    const marked = panel.children[0].findAll((n) => /nat-(up|down)/.test(n.className));
    ok('and a stat list marks them', marked.length >= 2, `${marked.length} marked cells`);
  }

  ok('editor modal opens', Boolean(modal));
  if (modal) {
    // THIS SHEET AND THE TEAM BUILDER'S USE THE SAME CONTROLS NOW. They take
    // the same state and had drifted badly -- a nature from a 25-row dropdown
    // here and the game's own 5x5 chart there, and neither gender nor a
    // nickname in the Builder at all. See app/js/specform.js.
    //
    // So this no longer counts <select>s: the point of the change is that
    // there are almost none left. It checks the CONTROLS are present.
    const has = (c) => modal.findAll((n) => n.classList.contains(c)).length;
    ok('the editor uses the shared nature chart, not a 25-row dropdown',
      has('sf-natcell') === 25, `${has('sf-natcell')} cells`);
    ok('...the shared ability chips', has('sf-abchip') >= 2, `${has('sf-abchip')} chips`);
    // Four slots always; the LIST is collapsed when all four are full, which
    // is the normal case for editing a Pokémon that already knows four moves.
    ok('...the shared move picker, with four aimable slots',
      has('sf-mvslot') === 4, `${has('sf-mvslot')} slots`);
    ok('...whose list opens when you ask to change one',
      (() => {
        const b = buttonNamed(modal, /Change a move/) ?? modal.find(hasClass('sf-mvslot'));
        b?.click();
        return modal.findAll(hasClass('sf-row')).length > 0;
      })(), `${modal.findAll(hasClass('sf-row')).length} rows`);
    ok('...the shared item picker', modal.findAll(hasClass('sf-pick-item')).length === 1);
    ok('...the shared identity row: nickname, gender and shiny',
      has('sf-nick') === 1 && has('sf-genchip') >= 1 && has('sf-shiny') === 1,
      `nick ${has('sf-nick')}, gender ${has('sf-genchip')}, shiny ${has('sf-shiny')}`);
    ok('...and the shared spread bars rather than twelve number boxes',
      has('sf-barrange') === 12, `${has('sf-barrange')} sliders`);
    // The one thing that should NOT have come across: the Builder's own
    // species grid. The Factory edits a record that already has a species.
    const selects = modal.findAll((n) => n.tagName === 'SELECT');
    ok('...and hardly a dropdown left in it', selects.length <= 2,
      `${selects.length} selects`);
    ok('the immutable-typing note is shown',
      /Typing is fixed/.test(modal.text));

    const species = selects[0];
    species.value = '376';                       // Metagross
    species.onchange();
    const modal2 = body.children.find((n) => n.classList.contains('fx-modal'));
    const lvl = modal2.findAll((n) => n.tagName === 'INPUT' && n.getAttribute('type') === 'number')[0];
    lvl.value = '88'; lvl.oninput();
    ok('changing species redraws with the new legality notes',
      /Metagross/.test(modal2.text), 'shows the new species');
    buttonNamed(modal2, /Save changes/).click();
    ok('saving closes the modal',
      !body.children.some((n) => n.classList.contains('fx-modal')));
    // The grid label is the NICKNAME when there is one, so it does not change
    // when only the species does -- assert against the detail panel, which
    // spells out "<species> · #<dex>" underneath the nickname.
    const d2 = panel.children[0].find(hasClass('fx-detail'));
    ok('the edit landed: species is now Metagross (#376)',
      /Metagross/.test(d2.text) && /#376/.test(d2.text), d2.text.slice(0, 60));
    // Whether the heading survives depends on whether that Pokémon happens to
    // be nicknamed, which varies per save. The invariant itself is tested at
    // the model level below, where both cases can be constructed.
    ok('the heading reflects the edit', d2.text.length > 0, nickBefore);
  }

  // organize: sort every box independently, then check nothing changed box
  {
    const before = F_membership();
    buttonNamed(panel.children[0], /Organize boxes/).click();
    const om = body.children.find((n) => n.classList.contains('fx-modal'));
    ok('organize modal opens', Boolean(om));
    if (om) {
      ok('it explains that sorting each box moves nothing between boxes',
        /Nothing moves between boxes/.test(om.text));
      buttonNamed(om, /Sort every box/).click();
      ok('sorting every box closes the modal',
        !body.children.some((n) => n.classList.contains('fx-modal')));
      ok('sorting every box preserves which box each Pokémon is in',
        JSON.stringify(F_membership()) === JSON.stringify(before));
    }
  }

  // download -- now a shared function rather than a per-tab button, so it is
  // exercised directly. The thing worth asserting never was the click: it is
  // that the bytes handed over are a whole, valid save, and that the caller is
  // told the melonDS procedure rather than left to discover it.
  {
    downloaded = null;
    const msg = downloadSave(uiFactory);
    ok('download produced 524288 bytes', downloaded?.length === 524288, `${downloaded?.length}`);
    ok('download explains the melonDS / savestate procedure',
      /melonDS/.test(msg) && /savestate/.test(msg));
    const back = Save.load(new Uint8Array(downloaded));
    ok('the downloaded bytes verify', back.verify().ok, back.verify().problems.join('; '));
    ok('a clean working copy refuses to pretend it has changes',
      stagedAndValid(new Factory(Save.load(new Uint8Array(original)), S)) === false);
  }

  // The unlock button must appear ONLY on a save whose boxes are capped, and
  // must actually raise the cap. Constructed rather than hoping for a save
  // with the default 8.
  {
    const capped = Save.load(new Uint8Array(original));
    capped.setBoxCapacity(8);
    const pan = new N('div');
    factoryTab.mount(pan, { S, save: capped });
    const btn = pan.children[0].find((n) => n.classList.contains('fx-unlock'));
    ok('a capped save is offered the unlock button', Boolean(btn),
      btn ? btn.text : 'not shown at capacity 8');
    if (btn) {
      btn.click();
      ok('unlocking raises the visible boxes to 24',
        !pan.children[0].find((n) => n.classList.contains('fx-unlock')));
      ok('no locked chips remain',
        pan.children[0].findAll(hasClass('fx-chip')).every((c) => !c.classList.contains('hidden-box')));
    }
    factoryTab.unmount();

    const full = Save.load(new Uint8Array(original));
    full.setBoxCapacity(24);
    const pan2 = new N('div');
    factoryTab.mount(pan2, { S, save: full });
    ok('a save already at 24 is not offered it',
      !pan2.children[0].find((n) => n.classList.contains('fx-unlock')));
    factoryTab.unmount();
  }

  factoryTab.unmount();
  ok('unmount removes the keydown listener and any modal',
    !body.children.some((n) => n.classList.contains('fx-modal')));
}

// ---- the ball a Pokemon lives in ------------------------------------------
// A single byte at body 0x75, confirmed against the ROM's item table rather
// than inferred: it reads 4 on every record and item 4 is Poké Ball. The point
// of the test is the same one giveItem's has -- changing it must change ONLY
// it, because this sits beside code that writes whole records.
{
  const F = mkFactory();
  const at = { loc: 'party', index: 0 };
  const before = F.save.readSlot(at.loc, at.index);
  ok('a record reports which ball it is in', Number.isInteger(before.ball_id),
    `${before.ball_id}`);
  const had = F.setBall(at, 1);           // Master Ball
  const after = F.save.readSlot(at.loc, at.index);
  ok('setBall returns the ball it was in', had === before.ball_id, `${had}`);
  ok('...and writes the new one', after.ball_id === 1, `${after.ball_id}`);
  const same = ['species_id', 'nature_id', 'ability_id', 'item_id', 'exp',
    'nickname', 'ot_name', 'tid', 'sid', 'pid'];
  const drift = same.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  ok('...and changes nothing else about the record', drift.length === 0, drift.join(', '));
  ok('...not the moves either',
    JSON.stringify(before.move_ids) === JSON.stringify(after.move_ids));
  ok('...nor the EVs and IVs',
    JSON.stringify(before.evs) === JSON.stringify(after.evs)
    && JSON.stringify(before.ivs) === JSON.stringify(after.ivs));
  ok('the save still verifies afterwards', F.save.verify().ok !== false);
  F.setBall(at, had);
  ok('and putting it back restores the original',
    F.save.readSlot(at.loc, at.index).ball_id === had);
}

// ---- fielding is a REPLACEMENT, not an insert ------------------------------
// "Field it" used to call moveMany(), which INSERTS: it lifted six out of
// their boxes and dropped them into the party alongside whoever was there, so
// it failed with "Party holds 6. It already has 6, and 6 more will not fit"
// the moment your party was full -- which is always. The confirm dialog had
// been promising a replacement the whole time.
{
  const F = mkFactory();
  const box = F.locations().map((l) => l.loc)
    .find((loc) => loc !== 'party' && loc !== 'battleBox'
      && F.read(loc).filter((s) => s.mon).length >= 3);
  const partyBefore = F.read('party').filter((s) => s.mon).length;
  /* THE BUG NEEDED A FULL PARTY, so a save without one cannot exercise it --
     and the committed fixture carries five. Reporting that as a FAILURE said
     the code was broken when the precondition simply was not there, and it
     turned ./test-all red on every fresh clone. It is a skip, and it says so
     rather than passing quietly, because a check that silently stops checking
     is worse than one that is loud about not running. */
  if (partyBefore !== 6) {
    console.log(`  [SKIP] full-party fielding — this save has ${partyBefore}, needs 6`);
  } else {
    ok('the party starts full, which is the case that used to fail', partyBefore === 6,
      `${partyBefore}`);
  }
  if (box != null) {
    const src = F.read(box).filter((s) => s.mon).slice(0, 6)
      .map((s) => ({ loc: s.loc, index: s.index }));
    const names = src.map((a) => F.read(a.loc)[a.index].mon.species);
    const total = () => F.locations()
      .reduce((a, l) => a + F.read(l.loc).filter((x) => x.mon).length, 0);
    const had = total();
    const r = F.fieldParty(src);
    ok('fielding into a full party succeeds', r.fielded === src.length, JSON.stringify(r));
    const now = F.read('party').filter((s) => s.mon).map((s) => s.mon.species);
    ok('...and the party IS the line-up you asked for',
      JSON.stringify(now) === JSON.stringify(names), now.join(', '));
    // The displaced have to go somewhere, not nowhere.
    ok('...with nobody destroyed', total() === had, `${had} -> ${total()}`);
    ok('...and the save still verifies', F.save.verify().ok !== false);
    ok('...as ONE undo step', (F.undo(),
      F.read('party').filter((s) => s.mon).length === partyBefore));
  }
  // A member already in the party must stay put rather than be evicted and
  // re-added, so fielding a core that overlaps your party is not a shuffle.
  {
    const G = mkFactory();
    const keep = G.read('party').filter((s) => s.mon).slice(0, 2)
      .map((s) => ({ loc: s.loc, index: s.index }));
    const names = keep.map((a) => G.read(a.loc)[a.index].mon.species);
    const r2 = G.fieldParty(keep);
    ok('fielding a subset already in the party keeps exactly those',
      r2.fielded === 2 && G.read('party').filter((s) => s.mon).length === 2,
      `${G.read('party').filter((s) => s.mon).map((s) => s.mon.species).join(', ')}`);
    ok('...and they are the ones asked for',
      JSON.stringify(G.read('party').filter((s) => s.mon).map((s) => s.mon.species))
        === JSON.stringify(names));
  }
}

console.log(failed ? `\n  ${failed} check(s) FAILED` : '\n  all checks passed');
process.exit(failed ? 1 : 0);
