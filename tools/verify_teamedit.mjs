#!/usr/bin/env node
/**
 * verify_teamedit.mjs -- the battle tab's team-prose editor.
 *
 * Why this file asserts what it does: notes/battle-sheet.md
 *
 * Two halves, and the model half matters more:
 *
 *  1. The MODEL. A team's pilot cards, tagline, per-slot reason and warning
 *     have to survive normalizeTeam -> toBattleTeam intact, and a team that
 *     predates structured cards has to keep behaving exactly as it did. A
 *     format change must never quietly lose somebody's writing, which is the
 *     same rule normalizeTeam already carries for slots.
 *
 *  2. The UI. Open it against a stubbed DOM, type into it, press Save, and
 *     check what comes out -- including that it changed NOTHING it was not
 *     asked to. The editor sits next to the Factory and the Team Builder,
 *     both of which write real Pokemon, so "it only edits prose" is a
 *     contract worth pinning rather than a nice intention.
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
    this.nodeType = String(tag) === '#text' ? 3 : 1;
    this.children = []; this.attrs = {}; this.dataset = {};
    this.className = ''; this._text = ''; this.value = '';
    this.disabled = false; this.parentNode = null;
    this.style = { setProperty(k, v) { this[k] = v; } };
    this.classList = {
      add: (c) => { if (!this.className.split(' ').includes(c)) this.className = (this.className + ' ' + c).trim(); },
      remove: (c) => { this.className = this.className.split(' ').filter((x) => x && x !== c).join(' '); },
      contains: (c) => String(this.className ?? '').split(' ').includes(c),
    };
  }
  append(...kids) {
    for (const k of kids.flat()) {
      if (k == null) continue;
      const n = typeof k === 'string' ? Object.assign(new N('#text'), { textContent: k }) : k;
      n.parentNode = this; this.children.push(n);
    }
  }
  appendChild(k) { this.append(k); return k; }
  get textContent() { return this._text ?? ''; }
  set textContent(v) { this.children = []; this._text = String(v ?? ''); }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'value') this.value = String(v);
    if (k === 'disabled') this.disabled = true;
  }
  getAttribute(k) { return this.attrs[k] ?? null; }
  focus() {}
  click(ev = {}) { this.onclick?.({ target: this, stopPropagation() {}, ...ev }); }
  get text() { return (this.textContent || '') + this.children.map((c) => c.text ?? '').join(''); }
  *walk() { yield this; for (const c of this.children) if (c.walk) yield* c.walk(); }
  find(p) { for (const n of this.walk()) if (p(n)) return n; return null; }
  findAll(p) { return [...this.walk()].filter(p); }
  querySelector() { return null; }
}
const body = new N('body');
global.document = {
  body, createElement: (t) => new N(t),
  createTextNode: (t) => Object.assign(new N('#text'), { textContent: t, nodeType: 3 }),
  addEventListener() {}, removeEventListener() {},
};
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};

const T = await import('../app/js/teams.js');
const { openTeamEditor, activeTeamId, proseFields, proseDraft } = await import('../app/js/teamedit.js');
const S = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/data/static.json'), 'utf8'));

const spec = () => ({
  speciesId: 143, level: 50, natureId: 3, abilityId: 47, itemId: 234,
  moveIds: [33, 89, 0, 0], evs: {}, ivs: {}, badge: '', note: '', rigged: '',
});
const teamOf = (extra = {}) => T.normalizeTeam({
  id: 't1', name: 'Mine', notes: 'A tagline', slots: [
    { role: 'wall', why: 'soaks hits', options: [spec()] },
    { role: 'sweeper', why: '', options: [spec()] },
  ], ...extra,
});

console.log('\n── model');
{
  const t = teamOf({
    warnNote: 'Loses to Ground.',
    pilot: [{ k: 'LEAD', v: 'Slowking sets rain.' }, { k: 'PANIC', v: 'Bullet Punch.' }],
  });
  const bt = T.toBattleTeam(t, [], S);
  ok('a structured pilot card reaches the battle shape',
    bt.pilot.length === 2 && bt.pilot[0].k === 'LEAD', JSON.stringify(bt.pilot[0]));
  ok('the tagline comes from the notes', bt.tagline === 'A tagline', bt.tagline);
  ok('a written warning REPLACES the computed one', bt.warn === 'Loses to Ground.', bt.warn);
  ok('the per-slot reason survives', bt.slots[0].why === 'soaks hits', bt.slots[0].why);

  // The migration is the part that can silently destroy someone's work.
  const legacy = teamOf({ notes: 'Line one\nLine two\nLine three' });
  const lb = T.toBattleTeam(legacy, [], S);
  ok('a team with no pilot cards still splits its notes exactly as before',
    lb.tagline === 'Line one' && lb.pilot.length === 2 && lb.pilot[0].v === 'Line two',
    JSON.stringify(lb.pilot));
  ok('...and still gets the COMPUTED warning',
    !/Loses to Ground/.test(lb.warn) && lb.warn.length > 0, lb.warn.slice(0, 40));
  ok('normalizeTeam gives an un-authored team a null pilot, not an empty one',
    T.normalizeTeam({ slots: [] }).pilot === null);

  // Seeding from a built-in roster has to bring its writing across, or a copy
  // of Kaiju is six Pokemon and none of what makes Kaiju legible.
  const kaiju = S.LAYOUT.find((x) => (x.pilot ?? []).length);
  const seeded = T.layoutToTeam(kaiju, [], S);
  ok('seeding from a built-in roster carries its pilot cards',
    seeded.pilot.length === kaiju.pilot.length && seeded.pilot[0].v.length > 0,
    `${seeded.pilot.length} from ${kaiju.name}`);
  ok('...reading BOTH shapes, since LAYOUT exports pairs and the sheet uses {k,v}',
    seeded.pilot.every((c) => typeof c.k === 'string' && typeof c.v === 'string' && c.v),
    JSON.stringify(seeded.pilot[0]));
  ok('...and its warning line', (seeded.warnNote ?? '').length > 0);

  // Promotion and retirement both move a line-up whole; prose is part of it.
  const core = T.coreFromTeam('Core', t);
  ok('promoting to a core keeps the pilot cards', (core.pilot ?? []).length === 2);
  ok('and retiring it back to a team keeps them too',
    (T.coreToTeam(core).pilot ?? []).length === 2);
}

console.log('\n── the editor');
{
  const before = teamOf();
  const specBefore = JSON.stringify(before.slots[0].options[0]);
  let saved = null;
  const overlay = openTeamEditor(before, {
    speciesName: (id) => S.SPECIES?.[String(id)]?.name,
    onSave: (next) => { saved = next; },
  });

  const inputs = overlay.findAll((n) => n.tagName === 'INPUT' || n.tagName === 'TEXTAREA');
  ok('the dialog renders its fields', inputs.length >= 4, `${inputs.length} inputs`);
  const empty = overlay.find((n) => n.classList.contains('te-empty'));
  ok('with a real explanation when there are no pilot cards yet', Boolean(empty));

  const add = overlay.find((n) => n.tagName === 'BUTTON' && /Add a card/.test(n.text));
  ok('there is a control to add one', Boolean(add));
  add.click();
  add.click();
  const keys = overlay.findAll((n) => n.classList.contains('te-key'));
  ok('adding gives you two cards', keys.length === 2, `${keys.length}`);
  ok('and suggests the label the built-in rosters use',
    keys[0].value === 'Lead', keys[0].value);

  // Type into them the way a person would.
  const vals = overlay.findAll((n) => n.classList.contains('te-val'));
  keys[0].value = 'LEAD'; keys[0].oninput();
  vals[0].value = 'Slowking sets rain.'; vals[0].oninput();
  keys[1].value = 'PANIC'; keys[1].oninput();
  vals[1].value = 'Bullet Punch anything on a sliver.'; vals[1].oninput();

  // Reordering is a real operation, not decoration.
  const ups = overlay.findAll((n) => n.classList.contains('te-mini') && n.text === '↑');
  ok('the first card cannot be moved up', ups[0].disabled === '' || ups[0].getAttribute('disabled') !== null);
  ups[1].click();
  const afterMove = overlay.findAll((n) => n.classList.contains('te-key'));
  ok('moving one up reorders them', afterMove[0].value === 'PANIC', afterMove[0].value);
  ups[1].click();       // put it back

  const slotRows = overlay.findAll((n) => n.classList.contains('te-slot'));
  const slotIn = slotRows.map((r) => r.find((n) => n.tagName === 'INPUT'));
  ok('every slot gets a reason field', slotIn.length === 2, `${slotIn.length}`);
  // "Slot 2" makes you count down the roster to find which one you are writing
  // about; a spec carries speciesId, so the name has to be looked up.
  ok('and is labelled with the Pokémon, not a slot number',
    /Snorlax/.test(slotRows[0].text), slotRows[0].text.trim().slice(0, 24));
  slotIn[1].value = 'outspeeds and cleans up'; slotIn[1].oninput();

  const save = overlay.find((n) => n.tagName === 'BUTTON' && n.text === 'Save');
  save.click();

  ok('saving produces a record', Boolean(saved));
  ok('with the pilot cards on it', saved.pilot.length === 2 && saved.pilot[0].k === 'LEAD',
    JSON.stringify(saved.pilot.map((c) => c.k)));
  ok('and the slot reason written back to the right slot',
    saved.slots[1].why === 'outspeeds and cleans up' && saved.slots[0].why === 'soaks hits');
  // THE CONTRACT: this editor is prose only. It sits beside two editors that
  // write real Pokemon into a save, so a spec changing here would be a bug
  // with consequences well beyond a wrong caption.
  ok('the Pokémon specs are byte-identical afterwards',
    JSON.stringify(saved.slots[0].options[0]) === specBefore);
  ok('and the id and kind are untouched', saved.id === before.id);
  ok('the dialog closes on save', overlay.parentNode === null);
}

console.log('\n── cancelling');
{
  const t = teamOf();
  let saved = null;
  const overlay = openTeamEditor(t, { onSave: (n) => { saved = n; } });
  const name = overlay.find((n) => n.tagName === 'INPUT');
  name.value = 'Wrecked'; name.oninput();
  overlay.find((n) => n.tagName === 'BUTTON' && n.text === 'Cancel').click();
  ok('cancelling saves nothing', saved === null);
  ok('and leaves the original untouched', t.name === 'Mine', t.name);
  ok('and closes', overlay.parentNode === null);
}

console.log('\n── copying a built-in roster');
{
  // "Copy into the Team Builder" fizzled: it was handed the CONVERTED battle
  // team, whose slot options are {mon, badge, note} objects, while
  // layoutToTeam destructures the list ["Gengar", badge, note, rigged] that
  // TEAM_LAYOUT actually uses. Every name came out undefined, every slot was
  // dropped, and the copy was an empty team that then vanished.
  const raw = S.LAYOUT.find((l) => l.id === 'kaiju') ?? S.LAYOUT[0];
  const copy = T.layoutToTeam(raw, [], S);
  ok('copying a built-in roster keeps its slots',
    copy.slots.length === raw.slots.length, `${copy.slots.length} of ${raw.slots.length}`);
  ok('...every slot naming a real species',
    copy.slots.every((sl) => sl.options[0]?.speciesId > 0));
  ok('...its swap tree', copy.slots.some((sl) => sl.options.length > 1),
    `${Math.max(...copy.slots.map((sl) => sl.options.length))} options on the widest slot`);
  ok('...and its pilot cards', (copy.pilot ?? []).length === (raw.pilot ?? []).length,
    `${copy.pilot.length}`);

  // The shape the button was wrongly given, so the mistake cannot come back
  // by someone "simplifying" the two call sites into one.
  const converted = { ...raw, slots: raw.slots.map((sl) => ({
    ...sl, options: sl.options.map(([n]) => ({ mon: { name: n }, badge: null, note: null })) })) };
  ok('and the CONVERTED shape produces nothing, which is why it must not be used',
    T.layoutToTeam(converted, [], S).slots.length === 0);
}

console.log('\n── the fields are shared, not duplicated');
{
  // ONE IMPLEMENTATION, TWO PLACEMENTS: a modal on the battle tab, inline
  // under the team's own name in the Builder. Two copies would drift the first
  // time either grew a field.
  const t = teamOf({ pilot: [{ k: 'LEAD', v: 'sets rain' }], warnNote: 'Ground.' });
  const draft = proseDraft(t);
  let beats = 0;
  const block = proseFields(draft, { slots: t.slots, onInput: () => { beats++; } });
  ok('the block renders the existing cards',
    block.findAll((n) => n.classList.contains('te-key')).length === 1);
  ok('...the warning', block.findAll((n) => n.tagName === 'TEXTAREA')
    .some((n) => n.value === 'Ground.'));
  ok('...and a reason field per slot',
    block.findAll((n) => n.classList.contains('te-slot')).length === t.slots.length);
  // Inline editing has no Save button, so every keystroke must report.
  const key = block.find((n) => n.classList.contains('te-key'));
  key.value = 'PANIC'; key.oninput();
  ok('editing reports back so the caller can persist', beats === 1, `${beats}`);
  ok('...and mutates the draft', draft.pilot[0].k === 'PANIC', draft.pilot[0].k);
  ok('the draft is a COPY, so the team is untouched until applied',
    t.pilot[0].k === 'LEAD', t.pilot[0].k);
  block.find((n) => n.tagName === 'BUTTON' && /Add a card/.test(n.text)).click();
  ok('adding a card reports too', beats === 2, `${beats}`);
}

console.log('\n── which team is on screen');
{
  // The template rebuilds its tab strip on every click and puts no id on the
  // buttons, so this mirrors its own orderedTeams() through bb_taborder. If
  // that ever drifts, the edit button silently edits the wrong team.
  const ids = ['live-party', 'builder-t1', 'core-c9'];
  ok('with no stored order, the first team is the active one',
    activeTeamId(ids) === 'live-party', activeTeamId(ids));
  localStorage.setItem('bb_taborder', JSON.stringify(['core-c9', 'builder-t1']));
  ok('the stored order names the active team', activeTeamId(ids) === 'core-c9');
  localStorage.setItem('bb_taborder', JSON.stringify(['gone', 'builder-t1']));
  ok('a stale id is skipped rather than returned',
    activeTeamId(ids) === 'builder-t1', activeTeamId(ids));
}

console.log(failed ? `\n  ${failed} check(s) FAILED` : '\n  all checks passed');
process.exit(failed ? 1 : 0);
