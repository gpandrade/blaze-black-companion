/**
 * tabs/builder.js -- the Team Builder.
 *
 * Design a team as an idea, see what it would take to make it real, and make
 * it real. The model is in app/js/teams.js; this file is DOM only.
 *
 * It shares the Factory's working copy (ctx.factory), so "adjust this one" and
 * "create this one" land in the same staged save the Factory tab shows, with
 * one undo stack and one download. Two working copies of one file would
 * diverge the instant you used both tabs.
 */

import * as T from '../teams.js';
import { locLabel } from '../factory.js';
import { ABILITIES, natureEffect, NATURE_STAT_ORDER as NATURE_ORDER }
  from '../../../js/tables.js';
import { rich } from '../rich.js';
import { proseFields, proseDraft } from '../teamedit.js';
import * as SF from '../specform.js';
import * as SD from '../showdown.js';
import * as SG from '../suggest.js';
import { opponentsFor } from '../roster.js';
import { gate } from '../nuzlocke.js';
import * as NUZMOD from '../nuzlocke.js';
import { shackle, shackleBanner, closed } from '../shackle.js';

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

/** Species ids present anywhere in the save, for the picker's default list. */
function ownedSpeciesIds() {
  const out = new Set();
  for (const e of index ?? []) out.add(e.mon.speciesId);
  return out;
}
const STAT_LABEL = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
// What the item list shows before you search. `HELD_INTEREST` is the set the
// battle sheet already treats as competitively meaningful, so this is one list
// rather than a second opinion about what matters.
let HELD_FIRST = new Set();
const VIZ_PREF = 'blazeblack.builder.viz';
const VIZ_TIPS = {
  radar: 'One hexagon per member on a shared scale — compare shapes at a glance',
  spread: 'Every stat as a bar, member by member',
  speed: 'Who moves first, neutral nature and unboosted',
  roles: 'How the jobs are distributed, and what the shape means',
  synergy: 'Who can safely switch into what each member fears',
};

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'checked' || k === 'value') n[k] = v;
    else if (k.startsWith('aria-') || k === 'role' || k === 'type' || k === 'min'
      || k === 'max' || k === 'maxLength' || k === 'title' || k === 'rows') n.setAttribute(k, v);
    else n[k] = v;
  }
  n.append(...kids.filter((x) => x != null));
  return n;
};

let S = null, F = null, CONFIG = null, TRAINER = null, root = null, NUZ = null;
const may = (action) => gate(NUZ, action);
let CTX = null;                 // the shell, for refreshActions()
let teams = [];
let cur = null;                 // current team id
let index = [];                 // flattened save contents
let view = { opt: new Map() }; // which alternate each slot card shows
// The slot a drag started from, or null. Module-level because dragover and
// drop fire on the TARGET card, which has no other way to know the source.
let dragFrom = null;
let viz = { radar: false, spread: false, speed: false, roles: false, synergy: false };
// Which alternate each slot card is showing. A view preference, not part of
// the team: it resets when you switch teams and is never persisted.


const team = () => T.onlyTeams(teams).find((t) => t.id === cur) ?? null;
const shown = () => T.onlyTeams(teams);
const touch = () => { const t = team(); if (t) t.updated = Date.now(); persistLocal(); };
const persistLocal = () => T.saveLocal(TRAINER?.trainer_id, teams);

// ==========================================================================
function render() {
  // Building and adjusting stage into the working copy the Factory shares,
  // and the shell owns the buttons that get it back onto disk.
  CTX?.refreshActions?.();
  index = T.buildIndex(F);
  const t = team();
  root.replaceChildren(
    ...[shackleBanner(document, NUZ,
      ['builder.create', 'builder.adjust'], NUZMOD)].filter(Boolean),
    teamBar(),
    t ? el('div', { class: 'tb-body' }, teamHead(t), slotGrid(t), vizPanels(t)) : emptyState());
}

function emptyState() {
  const b = el('button', { class: 'tb-btn primary' }, 'Start a team');
  b.onclick = () => newTeam();
  return el('div', { class: 'tb-empty' },
    el('h3', {}, 'No teams yet'),
    el('p', {}, 'Build one as an idea first — the Factory can make anything you design.'),
    b);
}

function teamBar() {
  const bar = el('div', { class: 'tb-bar' });
  const chips = el('div', { class: 'tb-chips' });
  for (const t of shown()) {
    const c = el('button', { class: 'tb-chip', 'aria-current': String(t.id === cur) },
      el('span', {}, t.name), el('i', {}, `${t.slots.length}`));
    c.onclick = () => { cur = t.id; view.opt.clear(); render(); };
    chips.append(c);
  }
  const add = el('button', { class: 'tb-chip tb-add',
    title: 'Start a new team — empty, or from your party or one of your cores' },
    '+ New team');
  add.onclick = () => openSeed();
  chips.append(add);
  bar.append(el('h2', {}, 'Team Builder'), chips, el('span', { class: 'tb-spacer' }));

  if (CONFIG) {
    const save = el('button', { class: 'tb-btn',
      title: 'Write every team to state/teams.json, so they survive clearing site data' },
      'Save to repo');
    save.onclick = async () => {
      try {
        const r = await T.saveRepo(teams);
        alert(`Saved ${r.count} team${r.count === 1 ? '' : 's'} to ${r.path}.`);
      } catch (e) { alert(`Could not save: ${e.message}`); }
    };
    bar.append(save);
  }
  // "Back up all", NOT "Export". There are two exports in this tab and they
  // are different things: this one is every team as JSON, for keeping; the one
  // on a team's own header is that team as a Showdown paste, for sending to a
  // person. Two buttons reading "Export" a few centimetres apart is a coin
  // toss, and the test picked the wrong one first time too.
  const exp = el('button', { class: 'tb-btn',
    title: 'Download every team as a JSON file — a backup you can keep or move '
      + 'to another machine. For sending ONE team to a person, use Export on the '
      + 'team itself.' }, 'Back up all');
  exp.onclick = () => exportTeams();
  bar.append(exp);

  // Building and adjusting stage into the SAME working copy the Factory
  // holds, and the shell bar owns the one Install/Download pair that gets that
  // copy back onto disk -- so there is nothing to draw here. Three tabs each
  // drawing their own pair implied three separate piles of pending changes.
  return bar;
}

function teamHead(t) {
  const name = el('input', { class: 'tb-name', type: 'text', value: t.name, maxLength: 40 });
  name.oninput = () => { t.name = name.value; touch(); teamBarRefresh(); };

  const notes = el('textarea', { class: 'tb-notes', rows: 2,
    placeholder: 'What this team is for, what it loses to, how to pilot it…' });
  notes.value = t.notes ?? '';
  notes.oninput = () => { t.notes = notes.value; touch(); };

  // ADVANCED, INLINE, UNDER THE NAME AND TAGLINE.
  //
  // This was a "Notes & pilot cards" button in the actions row, next to
  // "Save as core" and "Delete team" -- which made an optional part of the
  // team's own description look like a third destructive-ish verb, and gave
  // no hint of what it opened. It belongs with the name and the tagline it
  // extends: a closed disclosure most people never touch, and the rest of
  // the overview for the people who want it.
  //
  // It edits LIVE, like every other field up here, so there is no Save
  // button. The battle tab still gets the modal, where a dialog is right
  // because you are not in an editing context there.
  const draft = proseDraft(t);
  const adv = el('details', { class: 'tb-adv' },
    el('summary', {},
      el('span', { class: 'tb-advlab' }, 'Advanced'),
      el('span', { class: 'tb-advsub' },
        'pilot cards, what it loses to, what each slot is for')),
    proseFields(draft, {
      speciesName: (id) => S.SPECIES?.[String(id)]?.name,
      slots: t.slots,
      onInput: () => {
        t.pilot = draft.pilot;
        t.warnNote = draft.warnNote;
        draft.slots.forEach((sl, i) => { if (t.slots[i]) t.slots[i].why = sl.why; });
        touch();
      },
    }));
  // Open if there is anything in it, so a team that HAS this writing does not
  // hide it behind a click you have to know about.
  if (draft.pilot.length || draft.warnNote || draft.slots.some((x) => x.why)) {
    adv.setAttribute('open', '');
  }

  const asCore = el('button', { class: 'tb-btn promote',
    title: 'Keep this line-up as a reusable starting point for future teams' },
    'Save as core');
  asCore.onclick = () => {
    const name = prompt('Name this core', t.name);
    if (!name) return;
    // Promoting MOVES the team out of the scratchpad. Leaving a copy behind
    // was confusing -- you could not tell whether the original was safe to
    // delete, and having both meant two things claiming the same Pokémon.
    if (!confirm(`Promote “${t.name}” to a core?\n\nIt leaves the builder and becomes a `
      + 'core — the settled version. Nothing is lost: "Move back to builder" under '
      + '“+ New team” brings it back here whenever you want to change it.')) return;
    teams.unshift(T.coreFromTeam(name, t));
    teams = T.tombstone(teams, t.id);
    cur = T.onlyTeams(teams)[0]?.id ?? null;
    view.opt.clear();
    persistLocal();
    render();
    alert(`“${name}” is now a core.\n\nFind it under “+ New team”, where you can start new `
      + 'teams from it, field it into your party, or move it back here to edit.');
  };

  const del = el('button', { class: 'tb-btn danger',
    title: 'Remove this team everywhere — including the battle tab and state/teams.json' },
    'Delete team');
  del.onclick = async () => {
    if (!confirm(`Delete "${t.name}"?`)) return;
    // A TOMBSTONE, not a removal. Dropping it from localStorage left the repo
    // copy alive, and the next merge brought it straight back -- which is what
    // "I deleted it and it reappeared when I switched tabs" was. The deletion
    // has to be a fact that travels, so it is recorded and pushed.
    teams = T.tombstone(teams, t.id);
    cur = T.onlyTeams(teams)[0]?.id ?? null;
    persistLocal();
    render();
    if (CONFIG) {
      try { await T.saveRepo(teams); } catch { /* offline: the local tombstone still wins */ }
    }
  };
  // The commonest confusion this tab can cause is saving a team and not
  // finding it on the Battle tab, so it says which it is rather than leaving
  // you to guess.
  const reaches = t.slots.length > 0;
  const status = el('p', { class: `tb-status ${reaches ? 'info' : 'no'}` },
    reaches
      ? `Appears on the Battle tab as “${t.name}” — switch there to run it against the encounters.`
      : 'Add at least one slot and this will appear as its own tab in the battle companion.');

  // A TEAM YOU CANNOT HAND TO ANYBODY STAYS IN ONE BROWSER. The paste format
  // is what Showdown imports, what every calculator accepts and what people
  // put in a comment -- the cheapest thing this app can do to let a team
  // travel.
  const exp = el('button', { class: 'tb-btn ghost', type: 'button',
    title: 'This team as a Pokémon Showdown paste — the format Showdown imports, '
      + 'every damage calculator accepts, and people put in comments' }, 'Export');
  exp.onclick = () => openExport(t);

  // EXPORT IS NOT ONE OF THE OTHER TWO. "Save as core" commits a line-up and
  // "Delete team" destroys one; Export only reads. Sitting flush against them
  // it read as a third button of the same weight, and the one that only reads
  // is the one you least want to fat-finger next to the one that deletes.
  return el('div', { class: 'tb-head' }, name, notes, status,
    el('div', { class: 'tb-headacts' },
      exp,
      el('span', { class: 'tb-actsplit' }),
      asCore, del), adv);
}

/** Redraw only the chip bar, so renaming a team does not steal focus from
 *  the input you are typing in. */
function teamBarRefresh() {
  const bar = root.children[0];
  if (bar) root.replaceChild(teamBar(), bar);
}

// ------------------------------------------------------------------- slots
/**
 * Reorder by drag, and by keyboard.
 *
 * SLOT ORDER IS NOT COSMETIC: it is the order the battle sheet lists the team
 * in and the order `fieldCore()` writes into the party, so it is the order you
 * lead with in game. Until now the only way to move a slot was to rebuild it.
 *
 * DRAG IS NOT THE ONLY WAY IN. A drag is a poor fit for a touchscreen and
 * impossible without a pointer, so each card also carries two move buttons.
 * They are the same operation -- `reorderSlots` -- reached two ways, rather
 * than a drag path and a separate fallback that can disagree.
 */
function wireDrag(card, t, i) {
  card.draggable = true;
  card.ondragstart = (e) => {
    dragFrom = i;
    card.classList.add('dragging');
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); }
    catch { /* some browsers refuse setData outside a real drag */ }
  };
  card.ondragend = () => { dragFrom = null; render(); };
  card.ondragover = (e) => {
    if (dragFrom == null || dragFrom === i) return;
    e.preventDefault?.();
    card.classList.add('dropinto');
  };
  card.ondragleave = () => card.classList.remove('dropinto');
  // Marking the SOURCE too, so the pair reads as one exchange. Without it the
  // dragged card carried the only state and a drop looked like it happened to
  // an unrelated card.
  card.ondragenter = () => { if (dragFrom != null && dragFrom !== i) card.classList.add('dropinto'); };
  card.ondrop = (e) => {
    e.preventDefault?.();
    card.classList.remove('dropinto');
    if (dragFrom == null || dragFrom === i) return;
    t.slots = T.reorderSlots(t.slots, dragFrom, i);
    dragFrom = null;
    touch();
    render();
  };
  return card;
}

function moveSlotBy(t, i, delta) {
  const to = i + delta;
  if (to < 0 || to >= t.slots.length) return;
  t.slots = T.reorderSlots(t.slots, i, to);
  touch();
  render();
}

/**
 * The paste, in a box you can read before you send it.
 *
 * SHOWN, NOT SILENTLY COPIED. A button that puts something on your clipboard
 * and says "copied" gives you no way to check what it took -- and this text
 * carries a header about which game it is from, which is the part a recipient
 * most needs and the part you would want to see before pasting it somewhere
 * public.
 *
 * Copying is offered, and falls back to "select it yourself" rather than
 * failing silently: `navigator.clipboard` needs a secure context, and this app
 * is also meant to run from a file:// page.
 */
function openExport(t) {
  const text = SD.teamToPaste(T.normalizeTeam(t), S, {
    natureNames: T.NATURE_NAMES,
    version: CTX?.version ?? 'black',
  });
  const overlay = el('div', { class: 'tb-modal', role: 'dialog', 'aria-modal': 'true' });
  const sheet = el('div', { class: 'tb-sheet tb-exportsheet' });
  overlay.append(sheet);
  const close = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  const box = el('textarea', { class: 'tb-exporttext', rows: 18, readOnly: true });
  box.value = text;

  const status = el('span', { class: 'tb-hint' },
    `${(t.slots ?? []).length} Pokémon — the primary option of each slot.`);
  const copy = el('button', { class: 'tb-btn primary', type: 'button' }, 'Copy');
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = 'Copied. Paste it into Showdown’s team importer.';
    } catch {
      // No clipboard API, or no secure context. Select it and say so, rather
      // than reporting a success that did not happen.
      box.focus();
      box.select?.();
      status.textContent = 'Could not reach the clipboard — the text is selected, copy it yourself.';
    }
  };
  const done = el('button', { class: 'tb-btn', type: 'button' }, 'Close');
  done.onclick = close;

  sheet.append(
    el('h3', {}, `Export “${t.name}”`),
    el('p', { class: 'tb-hint' },
      'Pokémon Showdown paste format. The header names the hack, because base '
      + 'stats, typings and abilities differ from the base game for most species '
      + 'and a recipient has no other way to know.'),
    box,
    el('div', { class: 'tb-exportbar' }, status, copy, done));
  document.body.append(overlay);
  box.focus();
  return overlay;
}

function slotGrid(t) {
  const matches = T.matchTeam(t, index, S);
  const grid = el('div', { class: 'tb-grid' });
  t.slots.forEach((sl, i) => grid.append(wireDrag(slotCard(t, sl, i, matches[i]), t, i)));
  if (t.slots.length < T.MAX_SLOTS) {
    /* THE EMPTY SLOT NEEDS THE SUGGESTER MOST, and had it least.
       `Suggest` was an action on a FILLED slot card only, so a new team --
       which is what the Builder opens on, and what anybody starts from -- had
       nowhere to ask the question from at all. "I can't interact with this" was
       a team with zero slots and therefore zero buttons.
       The model always supported it: an index past the end of `slots` simply
       has no current occupant, so nothing is being replaced and there is no
       cost to price. Only the way in was missing. */
    const wrap = el('div', { class: 'tb-slot tb-addslot' });
    const add = el('button', { class: 'tb-addbtn', type: 'button',
      title: 'Add another member. A team can be any size up to six — half-built is fine.' },
      el('b', {}, '+'), el('span', {}, `Add slot ${t.slots.length + 1}`));
    add.onclick = () => openSlotEditor(t, null);
    const sug = el('button', { class: 'tb-btn ghost tb-addsug', type: 'button' }, 'Suggest one');
    sug.title = t.slots.length
      ? 'What would fit here, ranked against the fights you have not cleared'
      : 'Nothing to fit around yet — this ranks on the fights alone until you have a slot or two';
    sug.onclick = () => openSuggest(t, t.slots.length);
    wrap.append(add, sug);
    grid.append(wrap);
  }
  return grid;
}

/**
 * One slot: the option currently filling it, plus its alternates as a strip.
 *
 * Which option a card SHOWS is a view preference, not part of the team, so it
 * lives in `view.opt` and resets when you change teams. The stored order is
 * what the battle sheet uses, and option 0 is the default there.
 */
/**
 * A type as the battle sheet draws it.
 *
 * The type icons are 96x32 WORD badges -- the image already says "GHOST" --
 * so they are sized by height with the width left to follow, exactly as the
 * sheet does (`height:17px;width:auto`). Rendering one as a 13x13 square
 * squashed the word into a smear, and printing the name beside it said the
 * same thing twice.
 */
function typeChip(name) {
  const src = S.TICON?.[name];
  return src
    ? el('img', { class: 'tb-type', src, alt: name, title: name, loading: 'lazy' })
    : el('span', { class: 'tb-type tb-type-txt' }, name);
}

function slotCard(t, sl, i, ms) {
  const oi = Math.min(view.opt.get(i) ?? 0, sl.options.length - 1);
  const spec = sl.options[oi];
  const m = ms[oi];
  const sp = S.SPECIES[String(spec.speciesId)];
  const card = el('div', { class: `tb-slot tb-${m.state}` });

  // The move handles. Two buttons rather than a drag ONLY: a drag is a poor
  // fit for a touchscreen and impossible without a pointer, and slot order
  // decides what you lead with. Both routes call the same `reorderSlots`.
  const nudge = (delta, label, tip) => {
    const b = el('button', { class: 'tb-nudge', type: 'button', title: tip }, label);
    b.disabled = delta < 0 ? i === 0 : i === t.slots.length - 1;
    b.onclick = (e) => { e.stopPropagation(); moveSlotBy(t, i, delta); };
    return b;
  };
  card.append(el('div', { class: 'tb-slot-head' },
    el('span', { class: 'tb-grip', title: 'Drag to reorder — slot order is the order '
      + 'the battle tab lists them and the order “Field it” writes into your party' },
    '⠿'),
    S.SPRITE[sp?.name] ? el('img', { src: S.SPRITE[sp.name], alt: sp.name, loading: 'lazy' }) : null,
    el('div', { class: 'tb-slot-id' },
      el('b', {}, sp?.name ?? `#${spec.speciesId}`),
      el('span', {}, `L${spec.level} · ${T.NATURE_NAMES[spec.natureId]}`),
      el('span', { class: 'tb-types' }, ...(sp?.types ?? []).map(typeChip))),
    el('div', { class: 'tb-nudgebar' },
      nudge(-1, '◀', 'Move earlier'), nudge(1, '▶', 'Move later')),
    el('span', { class: `tb-state tb-state-${m.state}` },
      m.state === 'owned' ? 'owned' : m.state === 'close' ? 'close' : 'missing')));

  // ---------------------------------------------------------- IN YOUR SAVE
  // DIRECTLY UNDER THE NAME, because "do I have this one?" is the FIRST
  // question you ask of a slot, not the last. It used to be a footer at the
  // very bottom of the card, which put the answer as far from the question as
  // the card allowed and read as an appendix.
  //
  // It is still a separate, labelled zone on its own surface: the plan and
  // the save file are different things, and the button in here is the only
  // one on the card that writes anything.
  // Returns the button, so a nuzlocke rule can close it. A maker that
  // swallows its element cannot be shackled.
  const mk = (into, label, cls, fn, tip = '') => {
    const b = el('button', { class: `tb-btn ${cls}`, title: tip }, label);
    b.onclick = fn;
    into.append(b);
    return b;
  };
  const save = el('div', { class: `tb-save tb-save-${m.state}` });
  const line = el('div', { class: 'tb-saveline' });
  line.append(el('span', { class: 'tb-savelab' }, 'In your save'));
  line.append(el('span', { class: 'tb-savetext' },
    m.state === 'owned'
      ? `${locLabel(m.at.loc)}, slot ${m.at.index + 1} — matches this plan.`
      : m.state === 'close'
        ? `${locLabel(m.at.loc)}, slot ${m.at.index + 1} — differs:`
        : 'You do not have this species.'));
  if (m.state === 'close') {
    shackle(mk(line, 'Make yours match', 'primary', () => adjust(t, spec, m),
      'Edit the Pokémon you already own so it matches this plan — in place, not a copy'),
    may('builder.adjust'));
  }
  if (m.state === 'missing') {
    shackle(mk(line, 'Build it', 'primary', () => create(t, spec),
      'Build this Pokémon into the first free box slot of your working copy'),
    may('builder.create'));
  }
  save.append(line);
  if (m.state === 'close') {
    const list = el('ul', { class: 'tb-diffs' });
    for (const d of m.diffs.slice(0, 4)) {
      list.append(el('li', {}, el('b', {}, d.field), el('span', {}, `${d.have} → ${d.want}`)));
    }
    if (m.diffs.length > 4) list.append(el('li', {}, el('span', {}, `+${m.diffs.length - 4} more`)));
    save.append(list);
  }
  card.append(save);

  // ------------------------------------------------------------- THE PLAN
  // Everything below describes the Pokémon you INTEND. None of it touches
  // your save.
  const plan = el('div', { class: 'tb-plan' });

  const abil = spec.abilityId ? (S.ABILBYID[String(spec.abilityId)] ?? `#${spec.abilityId}`) : '—';
  const role = T.inferRole(sl.options[0], S, sl.role);
  plan.append(el('div', { class: 'tb-slot-meta' },
    el('span', { class: `tb-role tb-role-${role}` }, role),
    `${abil}${spec.itemId ? ` · @${S.ITEMS[String(spec.itemId)]}` : ''}`));
  // A fixed 2x2. Four moves as free-flowing chips wrapped at a different
  // point on every card -- three on one line here, two and two there -- so a
  // row of cards never lined up. Four is the cap the game imposes, so the
  // shape can just be the shape.
  plan.append(el('div', { class: 'tb-moves' },
    ...spec.moveIds.filter(Boolean).map((mid) => {
      const name = S.MOVEBYID[String(mid)];
      const mv = S.MOVES[name];
      const icon = S.TICON?.[mv?.t];
      return el('span', { class: 'tb-move' },
        icon ? el('img', { src: icon, alt: mv?.t ?? '', loading: 'lazy' }) : null,
        el('span', { class: 'tb-movename' }, name));
    })));
  if (sl.why) plan.append(el('p', { class: 'tb-why' }, rich(sl.why)));
  if (oi > 0 && spec.note) plan.append(el('p', { class: 'tb-why' }, rich(spec.note)));
  if (oi > 0 && spec.rigged) {
    plan.append(el('div', { class: 'tb-rigged' },
      el('span', { class: 'tb-rlab' }, 'Engineered'), el('span', {}, rich(spec.rigged))));
  }

  // Alternates, AFTER the description and under their own heading, drawn as
  // the battle sheet draws them: sprite, name over a location/ability line,
  // badge right, note beneath. They used to sit between the name and the
  // moves, so the card stopped describing this Pokémon halfway through and
  // started offering others.
  if (sl.options.length > 1) {
    const strip = el('div', { class: 'tb-opts' });
    strip.append(el('span', { class: 'tb-optslab' }, 'Swap this slot'));
    sl.options.forEach((o, j) => {
      const n = S.SPECIES[String(o.speciesId)]?.name ?? '?';
      const om = ms[j];
      // The sheet writes "Box 4 · Levitate". Writing the slot index too gave
      // "Box 4 12 · Levitate", which reads as a typo, and the index is not
      // something you need while choosing between swaps.
      const where = om.state === 'missing' ? 'not built yet' : locLabel(om.at.loc);
      const ab = o.abilityId ? (S.ABILBYID[String(o.abilityId)] ?? '—')
        : (S.SPECIES[String(o.speciesId)]?.abilities?.[0] ?? '—');
      const opt = el('button', {
        class: `tb-optcard${j === oi ? ' on' : ''}`,
        'aria-current': String(j === oi),
        title: j === 0 ? 'The option fielded by default on the battle tab'
          : 'A swap — click to preview it here',
      },
        S.SPRITE[n] ? el('img', { src: S.SPRITE[n], alt: n, loading: 'lazy' }) : el('i', {}, '?'),
        el('span', { class: 'tb-optbody' },
          el('span', { class: 'tb-optname' }, n),
          el('span', { class: 'tb-optsub' }, `${where} · ${ab}`)),
        el('span', { class: 'tb-optbadge' }, j === 0 ? 'default' : (o.badge || 'alternate')));
      opt.onclick = () => { view.opt.set(i, j); render(); };
      strip.append(opt);
      if (j > 0 && o.note) strip.append(el('p', { class: 'tb-optnote' }, rich(o.note)));
      // The sheet renders `rigged` as its own labelled block. Dropping it here
      // left an ENGINEERED badge with nothing explaining what was broken.
      if (o.rigged) {
        strip.append(el('div', { class: 'tb-rigged' },
          el('span', { class: 'tb-rlab' }, 'Engineered'),
          el('span', {}, rich(o.rigged))));
      }
    });
    plan.append(strip);
  }

  // Editing the PLAN. These three change the idea and nothing else.
  const planActs = el('div', { class: 'tb-slot-acts' });
  mk(planActs, 'Edit slot', '', () => openSlotEditor(t, i, oi), oi === 0
    ? 'Change the plan for this slot: species, moves, spread, and the job it does'
    : 'Change this swap');
  mk(planActs, 'Add a swap', 'ghost', () => openSlotEditor(t, i, null, { addOption: true }),
    'Add an alternative for this slot — it becomes a swap card on the battle tab');
  mk(planActs, 'Suggest', 'ghost', () => openSuggest(t, i),
    'What else could go here, ranked against the fights you have not cleared — '
    + 'and what each one would cost you');
  mk(planActs, 'Remove', 'ghost', () => {
    if (sl.options.length > 1 && oi > 0) {
      sl.options.splice(oi, 1);
      view.opt.set(i, 0);
    } else {
      t.slots.splice(i, 1);
      view.opt.delete(i);
    }
    touch(); render();
  }, oi > 0 ? 'Drop this swap from the slot' : 'Drop this slot from the team');
  plan.append(planActs);

  card.append(plan);
  return card;
}

/**
 * Apply a spec onto the Pokemon you already have, in place.
 *
 * In place rather than making a corrected copy: a "close" match means you
 * already own this Pokemon and want it different, and creating a second one
 * leaves you sorting out which is which. The Factory's undo covers the
 * mistake, and nothing reaches the save file until you install or download.
 */
function adjust(t, spec, m) {
  const names = m.diffs.map((d) => d.field).join(', ');
  if (!confirm(`Change your ${S.SPECIES[String(spec.speciesId)].name} in `
    + `${locLabel(m.at.loc)} slot ${m.at.index + 1}?\n\nThis edits ${names} on the Pokémon you `
    + 'already have, rather than making a second copy. Undo is available, and nothing '
    + 'touches your save file until you install or download.')) return;
  try {
    F.write({ loc: m.at.loc, index: m.at.index }, T.specToBuild(spec, S));
    render();
  } catch (e) { alert(`Could not adjust it: ${e.message}`); }
}

/** Build the spec into the first free box slot, and say where it went. */
function create(t, spec) {
  let free = null;
  for (const l of F.locations()) {
    if (typeof l.loc !== 'number' || l.hidden) continue;
    free = F.firstFree(l.loc);
    if (free) break;
  }
  if (!free) { alert('Every visible box is full — free a slot first.'); return; }
  try {
    F.write(free, T.specToBuild(spec, S));
    render();
    alert(`Created ${S.SPECIES[String(spec.speciesId)].name} in ${locLabel(free.loc)}, `
      + `slot ${free.index + 1}.\n\nIt is staged in the working copy — install or download `
      + 'from the Factory tab to keep it.');
  } catch (e) { alert(`Could not create it: ${e.message}`); }
}

// ----------------------------------------------------------- visualisation
function vizPanels(t) {
  const specs = T.teamSpecs(t);
  const wrap = el('div', { class: 'tb-viz' });

  const toggles = el('div', { class: 'tb-toggles' },
    el('span', { class: 'tb-tog-label' }, 'Also show'));
  for (const [k, label] of [['radar', 'Stat radar'], ['spread', 'Stat bars'],
    ['speed', 'Speed order'], ['roles', 'Role balance'], ['synergy', 'Type synergy']]) {
    const b = el('button', { class: 'tb-tog', 'aria-pressed': String(viz[k]),
      title: VIZ_TIPS[k] ?? '' }, label);
    b.onclick = () => {
      viz[k] = !viz[k];
      try { localStorage.setItem(VIZ_PREF, JSON.stringify(viz)); } catch { /* private mode */ }
      render();
    };
    toggles.append(b);
  }
  wrap.append(toggles);

  if (!specs.length) return wrap;
  wrap.append(defensivePanel(specs), offensivePanel(specs));
  if (viz.radar) wrap.append(radarPanel(specs));
  if (viz.spread) wrap.append(spreadPanel(specs));
  if (viz.speed) wrap.append(speedPanel(specs));
  if (viz.roles) wrap.append(rolePanel(specs));
  if (viz.synergy) wrap.append(synergyPanel(specs));
  return wrap;
}

function panel(title, hint, body) {
  return el('section', { class: 'tb-panel' },
    el('h3', {}, title, hint ? el('span', {}, hint) : null), body);
}

const MUL_CLASS = (v) => (v === 0 ? 'm0' : v <= 0.25 ? 'm25' : v < 1 ? 'm5' : v === 1 ? 'm1' : v >= 4 ? 'm4' : 'm2');
const MUL_TEXT = (v) => (v === 0 ? '0' : v === 0.25 ? '¼' : v === 0.5 ? '½' : v === 1 ? '' : `${v}`);

function defensivePanel(specs) {
  const rows = T.defensiveGrid(specs, S);
  const table = el('div', { class: 'tb-dgrid', style: `--n:${specs.length}` });
  table.append(el('span', { class: 'tb-corner' }, ''));
  for (const sp of specs) {
    const s = S.SPECIES[String(sp.speciesId)];
    table.append(el('span', { class: 'tb-colhead', title: s?.name },
      S.SPRITE[s?.name] ? el('img', { src: S.SPRITE[s.name], alt: s.name, loading: 'lazy' }) : el('i', {}, '?')));
  }
  table.append(el('span', { class: 'tb-colhead tb-worst' }, '#'));

  for (const r of rows) {
    table.append(el('span', { class: 'tb-rowhead' }, r.type.slice(0, 3)));
    for (const c of r.cells) {
      table.append(el('span', { class: `tb-cell ${MUL_CLASS(c)}`, title: `${r.type} → ${c}×` }, MUL_TEXT(c)));
    }
    table.append(el('span', { class: `tb-cell tb-count${r.worst >= 3 ? ' bad' : r.worst === 0 ? ' good' : ''}` },
      String(r.worst)));
  }
  const holes = rows.filter((r) => r.worst >= 3);
  return panel('Defensive coverage',
    holes.length
      ? `${holes.map((h) => h.type).join(', ')} hits half your team or more`
      : 'nothing hits three or more of you',
    table);
}

/**
 * Offensive coverage as a grid, deliberately shaped like the defensive one.
 *
 * The old version was seventeen green-or-red chips. That answers "is this
 * covered" and nothing else, and hides "who covers it, with what" in a
 * tooltip. Same rows, same reading direction, one glance.
 *
 * The colour ramp is one-directional (more is better) rather than the
 * defensive panel's diverging one, because here a 2x is good news. Using the
 * same red-for-two would invert the meaning halfway down the page.
 */
function offensivePanel(specs) {
  const rows = T.offensiveGrid(specs, S);
  const table = el('div', { class: 'tb-dgrid tb-ogrid', style: `--n:${specs.length}` });
  table.append(el('span', { class: 'tb-corner' }, ''));
  for (const sp of specs) {
    const s2 = S.SPECIES[String(sp.speciesId)];
    table.append(el('span', { class: 'tb-colhead', title: s2?.name },
      S.SPRITE[s2?.name] ? el('img', { src: S.SPRITE[s2.name], alt: s2.name, loading: 'lazy' })
        : el('i', {}, '?')));
  }
  table.append(el('span', { class: 'tb-colhead tb-worst', title: 'how many can hit it hard' }, '#'));

  for (const r of rows) {
    table.append(el('span', { class: 'tb-rowhead' }, r.type.slice(0, 3)));
    for (const c of r.cells) {
      const cls = c.mult === 0 ? 'o0' : c.mult < 1 ? 'olow' : c.mult === 1 ? 'o1'
        : c.mult >= 4 ? 'o4' : 'o2';
      table.append(el('span', {
        class: `tb-cell ${cls}`,
        title: c.move ? `${c.move} — ${c.mult}× vs ${r.type}`
          : `nothing damaging vs ${r.type}`,
      }, c.mult === 0 ? '–' : c.mult === 1 ? '' : c.mult < 1 ? `${c.mult}` : `${c.mult}×`));
    }
    table.append(el('span', {
      class: `tb-cell tb-count${r.supers === 0 ? ' bad' : r.supers >= 2 ? ' good' : ''}`,
    }, String(r.supers)));
  }

  const gaps = rows.filter((r) => !r.covered);
  const blind = rows.filter((r) => r.untouchable);
  return panel('Offensive coverage',
    blind.length ? `nothing can even touch ${blind.map((b) => b.type).join(', ')}`
      : gaps.length ? `no super-effective answer to ${gaps.map((g) => g.type).join(', ')}`
        : 'every type has an answer',
    el('div', {}, table,
      el('p', { class: 'tb-note-inline' },
        'Cell = the best multiplier that member can reach with a damaging move. '
        + 'Blank is neutral; – means it cannot touch that type at all.')));
}

function spreadPanel(specs) {
  const rows = el('div', { class: 'tb-spread' });
  const stats = specs.map((sp) => {
    const s = S.SPECIES[String(sp.speciesId)];
    const vals = T.specStats(sp, S);
    const out = {};
    STAT_KEYS.forEach((k, i) => { out[k] = vals[i]; });
    return { name: s.name, out, nature: natureEffect(sp.natureId) };
  });
  const max = Math.max(...stats.flatMap((x) => STAT_KEYS.map((k) => x.out[k])), 1);
  for (const x of stats) {
    const row = el('div', { class: 'tb-spread-row' }, el('b', {}, x.name));
    for (const k of STAT_KEYS) {
      // The nature is already IN these numbers; the mark says which two it
      // moved, so changing the nature moves both the figure and the mark.
      const mark = x.nature && k === x.nature.up ? ' nat-up'
        : x.nature && k === x.nature.down ? ' nat-down' : '';
      row.append(el('span', { class: `tb-sl${mark}` }, STAT_LABEL[k]),
        el('span', { class: 'tb-track' }, el('i', { style: `width:${(x.out[k] / max) * 100}%` })),
        el('u', { class: mark.trim() }, String(x.out[k])));
    }
    rows.append(row);
  }
  return panel('Stat spread', 'nature applied — change it in the slot editor and these move', rows);
}

function speedPanel(specs) {
  const rows = specs.map((sp) => {
    const s = S.SPECIES[String(sp.speciesId)];
    const core = Math.floor((2 * s.base.spe + sp.ivs.spe + Math.floor(sp.evs.spe / 4)) * sp.level / 100) + 5;
    return { name: s.name, spe: core, sprite: S.SPRITE[s.name] };
  }).sort((a, b) => b.spe - a.spe);
  const max = Math.max(...rows.map((r) => r.spe), 1);
  const list = el('div', { class: 'tb-speed' });
  for (const r of rows) {
    list.append(
      r.sprite ? el('img', { src: r.sprite, alt: r.name, loading: 'lazy' }) : el('i', {}, '?'),
      el('b', {}, r.name),
      el('span', { class: 'tb-track' }, el('i', { style: `width:${(r.spe / max) * 100}%` })),
      el('u', {}, String(r.spe)));
  }
  return panel('Speed order', 'neutral nature, unboosted', list);
}

/**
 * Small-multiple radars: one hexagon per member.
 *
 * Six polygons overlaid on one chart is unreadable at this many series -- the
 * shapes occlude each other and the legend does the work the picture should.
 * One small chart each compares shapes at a glance, which is the actual
 * question ("who is the fast frail one").
 */
function radarPanel(specs) {
  // One column per member, set explicitly. auto-fit still decides the count
  // from the available width, so six charts came out five-and-one at some
  // window sizes -- a lone radar on its own row.
  const grid = el('div', { class: 'tb-radars', style: `--n:${specs.length}` });
  // A shared scale, so the charts are comparable to each other rather than
  // each normalised to its own maximum.
  const all = specs.map((sp) => T.specStats(sp, S));
  const max = Math.max(...all.flat(), 1);

  specs.forEach((sp, i) => {
    const st = all[i];
    const name = S.SPECIES[String(sp.speciesId)]?.name ?? '?';
    const R = 34, CX = 44, CY = 42;
    const pt = (k, r) => {
      const a = (Math.PI / 3) * k - Math.PI / 2;
      return [CX + Math.cos(a) * r, CY + Math.sin(a) * r];
    };
    const ring = (f) => STAT_KEYS.map((_, k) => pt(k, R * f).map((n) => n.toFixed(1)).join(',')).join(' ');
    const shape = st.map((v, k) => pt(k, (v / max) * R).map((n) => n.toFixed(1)).join(',')).join(' ');

    const svg = `<svg viewBox="0 0 88 84" role="img" aria-label="${name} stat shape">
      <polygon points="${ring(1)}" class="tb-r-grid"/>
      <polygon points="${ring(0.66)}" class="tb-r-grid"/>
      <polygon points="${ring(0.33)}" class="tb-r-grid"/>
      ${STAT_KEYS.map((_, k) => {
        const [x, y] = pt(k, R);
        return `<line x1="${CX}" y1="${CY}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="tb-r-spoke"/>`;
      }).join('')}
      <polygon points="${shape}" class="tb-r-shape"/>
      ${STAT_KEYS.map((k, j) => {
        const [x, y] = pt(j, R + 7);
        return `<text x="${x.toFixed(1)}" y="${(y + 2).toFixed(1)}" class="tb-r-label">${STAT_LABEL[k]}</text>`;
      }).join('')}
    </svg>`;

    const cell = el('figure', { class: 'tb-radar' });
    cell.innerHTML = svg;
    cell.append(el('figcaption', {},
      S.SPRITE[name] ? el('img', { src: S.SPRITE[name], alt: '', loading: 'lazy' }) : null,
      el('span', {}, name)));
    grid.append(cell);
  });
  return panel('Stat radar', `same scale across all ${specs.length}; nature applied`, grid);
}

/**
 * Role balance. Counting is the easy half; saying what a shape MEANS is the
 * half that is worth reading, so it does.
 */
function rolePanel(specs) {
  const counts = new Map(T.ROLES.map((r) => [r, 0]));
  for (const sp of specs) counts.set(T.inferRole(sp, S), counts.get(T.inferRole(sp, S)) + 1);
  const bar = el('div', { class: 'tb-rolebar' });
  for (const r of T.ROLES) {
    const n = counts.get(r);
    if (!n) continue;
    bar.append(el('span', { class: `tb-roleseg tb-role-${r}`,
      style: `flex:${n}`, title: `${n} × ${r}` }, `${r} ${n}`));
  }
  const notes = [];
  if (!counts.get('setter')) notes.push('Nothing sets up — no weather, screens, hazards or Trick Room.');
  if (!counts.get('wall')) notes.push('Nothing takes a hit; every member wants to be moving first.');
  if (counts.get('sweeper') >= specs.length - 1 && specs.length > 2) {
    notes.push('Almost all offence — one bad matchup and there is no fallback.');
  }
  if (!notes.length) notes.push('A reasonable spread of jobs.');
  return panel('Role balance', 'inferred where you have not set one',
    el('div', {}, bar, el('p', { class: 'tb-note-inline' }, notes.join(' '))));
}

/**
 * Synergy as a MATRIX rather than a list of chips.
 *
 * Cell (row, col) is how many of the row member's weaknesses that column
 * member resists. The diagonal is blank. Reading down a column tells you who
 * is carrying the team defensively; a blank row is somebody nobody can switch
 * in for.
 */
function synergyPanel(specs) {
  const names = specs.map((sp) => S.SPECIES[String(sp.speciesId)]?.name ?? '?');
  const weak = specs.map((sp) => {
    const ts = S.SPECIES[String(sp.speciesId)]?.types ?? [];
    return S.TYPES.filter((atk) => ts.reduce((m, d) => m * (S.CHART[atk]?.[d] ?? 1), 1) > 1);
  });
  const resists = (j, atk) => {
    const ts = S.SPECIES[String(specs[j].speciesId)]?.types ?? [];
    return ts.reduce((m, d) => m * (S.CHART[atk]?.[d] ?? 1), 1) < 1;
  };

  const grid = el('div', { class: 'tb-syn', style: `--n:${specs.length}` });
  grid.append(el('span', { class: 'tb-syn-corner' }, ''));
  for (const n of names) {
    grid.append(el('span', { class: 'tb-syn-head', title: n },
      S.SPRITE[n] ? el('img', { src: S.SPRITE[n], alt: n, loading: 'lazy' }) : el('i', {}, '?')));
  }
  specs.forEach((_, i) => {
    grid.append(el('span', { class: 'tb-syn-row-head', title: `${names[i]} fears ${weak[i].join(', ') || 'nothing'}` },
      S.SPRITE[names[i]] ? el('img', { src: S.SPRITE[names[i]], alt: names[i], loading: 'lazy' }) : el('i', {}, '?')));
    specs.forEach((__, j) => {
      if (i === j) { grid.append(el('span', { class: 'tb-syn-cell self' }, '·')); return; }
      const covers = weak[i].filter((atk) => resists(j, atk));
      const cls = covers.length === 0 ? 'none' : covers.length >= 2 ? 'strong' : 'some';
      grid.append(el('span', {
        class: `tb-syn-cell ${cls}`,
        title: covers.length
          ? `${names[j]} resists ${covers.join(', ')} — safe switch-in for ${names[i]}`
          : `${names[j]} resists none of what ${names[i]} fears`,
      }, covers.length ? String(covers.length) : ''));
    });
  });

  const orphans = specs.map((_, i) => ({
    i, helped: specs.some((__, j) => i !== j && weak[i].some((atk) => resists(j, atk))),
  })).filter((x) => weak[x.i].length && !x.helped);
  return panel('Type synergy',
    orphans.length
      ? `nobody covers ${orphans.map((x) => names[x.i]).join(', ')}`
      : 'every member has a safe switch-in',
    el('div', {}, grid,
      el('p', { class: 'tb-note-inline' },
        'Cell = how many of the row member’s weaknesses the column member resists.')));
}

// -------------------------------------------------------------- seed a team
/**
 * Start a team from Pokémon you already have.
 *
 * Building six slots by hand when the core is already sitting in your party
 * is the long way round, and it was the only way round.
 */
/**
 * WHAT ELSE COULD GO HERE -- and what taking it would cost.
 *
 * Three parts, and they are deliberately not one score:
 *
 *   THE PREMISE is inferred from the slots you have already filled and shown
 *   as chips you can switch OFF. That is the whole reason it is a separate
 *   thing: a filter the app applies silently is a filter you cannot argue
 *   with, and the app is guessing. Turning one off re-ranks immediately.
 *
 *   THE RANK is computed -- types, real stats, speed, against the Pokémon in
 *   the fights you have not marked cleared. Nothing here is fitted to you.
 *
 *   THE REASONS are the product. A row that only carried a number would be a
 *   thing to trust or ignore; a row that says what it adds AND what it costs
 *   is a thing to think with. The second half is the idiom the swap tree
 *   already uses -- every option carries a note saying what taking it gives up.
 */
function openSuggest(t, i) {
  const overlay = el('div', { class: 'tb-modal', role: 'dialog', 'aria-modal': 'true' });
  const sheet = el('div', { class: 'tb-sheet tb-suggest' });
  overlay.append(sheet);
  const close = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  const others = t.slots.map((sl) => sl.options?.[0])
    .filter((s, k) => k !== i && s?.speciesId);
  const ownedIds = new Set(index.map((e) => e.mon.speciesId));
  const premises = SG.inferPremise(others, S, { ownedIds }).map((p) => ({ ...p, off: false }));

  /* WHICH FIGHTS. The ones you have not ticked off, nearest first -- a
     suggestion for the whole rest of the game is a suggestion about nothing in
     particular. `bb_cleared` is the battle tab's own progress, keyed on the
     fight's stable slug, so the two agree without a second store. */
  let cleared = {};
  try { cleared = JSON.parse(localStorage.getItem('bb_cleared') ?? '{}') ?? {}; } catch { /* none */ }
  const all = opponentsFor(S, CTX?.starter, CTX?.version ?? 'black');
  /* WHAT LEVEL TO JUDGE AT. The team's own, when it has one -- but a brand new
     team has no slots and therefore no level, which sent it back to story order
     and ranked a full box against the first rival. Your party is the better
     fallback: it is where you actually are. */
  const partyLevel = Math.max(0, ...index
    .filter((e) => e.loc === 'party').map((e) => e.mon.level ?? 0));
  const teamLevel = Math.max(0, ...t.slots.map((sl) => sl.options?.[0]?.level ?? 0))
    || partyLevel
    || Math.max(0, ...index.map((e) => e.mon.level ?? 0));
  const next = SG.fightsToJudge(all, cleared, teamLevel);
  const foes = SG.foesOf(next, S);
  const level = foes.length
    ? Math.round(foes.reduce((a, f) => a + f.level, 0) / foes.length) : 50;

  // "What you own" first: a suggestion you can act on today beats a
  // theoretical one, and ranking 649 badly is worse than ranking thirty well.
  let source = 'owned';
  const draw = () => {
    sheet.replaceChildren();
    const cur = t.slots[i]?.options?.[0];
    sheet.append(el('div', { class: 'tb-sheet-head' },
      el('h3', {}, cur
        ? `Slot ${i + 1} — instead of ${S.SPECIES[String(cur.speciesId)]?.name}`
        : `Slot ${i + 1} — what could go here`),
      el('span', { class: 'tb-hint' }, foes.length
        ? `judged against ${foes.length} Pokémon in ${next.map((e) => e.leader).join(', ')}`
        : 'no uncleared fights — ranked on what it adds to the team alone')));

    // The premise, as chips you can argue with.
    const prow = el('div', { class: 'tb-premise' });
    prow.append(el('span', { class: 'tb-plabel' }, 'PREMISE'));
    if (!premises.length) {
      prow.append(el('span', { class: 'tb-hint' },
        others.length < 2
          ? 'fill two slots and this works out what the team is for'
          : 'nothing shared across your filled slots — every candidate is on the table'));
    } else {
      for (const p of premises) {
        const b = el('button', {
          class: `tb-pchip${p.off ? ' off' : ''}`, type: 'button',
          title: `${p.why} — click to ${p.off ? 'apply it again' : 'ignore it'}`,
        }, p.label);
        b.onclick = () => { p.off = !p.off; draw(); };
        prow.append(b);
      }
      prow.append(el('span', { class: 'tb-hint' }, 'click one to drop it'));
    }
    sheet.append(prow);

    const srow = el('div', { class: 'tb-premise' });
    srow.append(el('span', { class: 'tb-plabel' }, 'FROM'));
    for (const [k, label] of [['owned', 'what you own'], ['all', 'every species']]) {
      const b = el('button', { class: `tb-pchip${source === k ? '' : ' off'}`, type: 'button' }, label);
      b.onclick = () => { source = k; draw(); };
      srow.append(b);
    }
    sheet.append(srow);

    /* WHAT YOU OWN IS JUDGED AS YOU OWN IT -- real moves, real spread, real
       level -- which is the whole reason that source is the default. A bare
       species is judged on what it could learn, and says so on the card. One
       entry per species: six Gengars are one suggestion. */
    const candidates = source === 'owned'
      ? index.filter((e, k, a) => a.findIndex((x) => x.mon.speciesId === e.mon.speciesId) === k)
        .map((e) => ({ speciesId: e.mon.speciesId, spec: T.monToSpec(e.mon) }))
      : Object.keys(S.SPECIES).map((id) => ({ speciesId: Number(id) }));

    const { rows, thin } = SG.suggestForSlot(t, i, S,
      { candidates, foes, level, premises: premises.filter((p) => !p.off), ownedIds });

    /* SAY WHEN THERE IS NOT ENOUGH TEAM TO FIT ANYTHING AROUND. One filled
       slot means every type is uncovered, so every candidate earns every
       coverage reason and the list reads as five identical cards -- confident
       about a team it cannot see. The ranking is still worth having; it is
       just answering a narrower question, and it should say which. */
    if (thin) {
      sheet.append(el('p', { class: 'tb-note warn' },
        `Only ${others.length} other slot${others.length === 1 ? '' : 's'} filled, so there is `
        + 'nothing to fit around yet — this is ranked purely on how each one does against '
        + 'those rosters. Fill two or three and it starts weighing what the team is missing.'));
    }

    const list = el('div', { class: 'tb-suglist' });
    if (!rows.length) {
      list.append(el('p', { class: 'tb-note warn' },
        'Nothing gets through the premise. Drop one of the chips above, or widen the source.'));
    }
    for (const r of rows.slice(0, 12)) {
      const card = el('div', { class: 'tb-sug' });
      const head = el('div', { class: 'tb-sug-head' });
      const img = S.SPRITE?.[String(r.speciesId)];
      if (img) head.append(el('img', { src: img, alt: r.name }));
      head.append(el('div', {},
        el('div', { class: 'tb-sug-name' }, r.name),
        el('div', { class: 'tb-hint' },
          (S.SPECIES[String(r.speciesId)].types ?? []).join(' / ')
          + ` · ${S.SPECIES[String(r.speciesId)].bst} BST`
          + (r.potential ? ' · judged on what it could learn' : ''))));
      const take = el('button', { class: 'tb-btn primary', type: 'button' }, 'Use this');
      take.onclick = () => {
        if (!t.slots[i]) {
          // Suggested into the empty card: this creates the slot.
          t.slots.push({ role: null, why: '', options: [T.blankOption(r.speciesId)] });
        } else {
          const opt = t.slots[i].options[0];
          opt.speciesId = r.speciesId;
          opt.moveIds = [0, 0, 0, 0];
          opt.abilityId = 0;
        }
        // The module-level render, redrawing the Builder behind the modal.
        touch(); close(); render();
      };
      head.append(take);
      card.append(head);
      if (r.why.length) {
        card.append(el('ul', { class: 'tb-sugwhy' },
          ...r.why.map((w) => el('li', {}, w))));
      }
      if (r.cost.length) {
        card.append(el('ul', { class: 'tb-sugcost' },
          ...r.cost.map((w) => el('li', {}, w))));
      }
      list.append(card);
    }
    sheet.append(list);

    /* SAID OUT LOUD, because the number is coarser than the battle tab's and
       somebody will otherwise assume it is not. */
    sheet.append(el('p', { class: 'tb-note' },
      'Ranked on types, real stats and Speed against those rosters — not on damage. '
      + 'The battle tab works out the exact numbers, and the turn.'));
    const foot = el('div', { class: 'tb-foot' });
    const done = el('button', { class: 'tb-btn', type: 'button' }, 'Close');
    done.onclick = close;
    foot.append(done);
    sheet.append(foot);
  };
  draw();
  document.body.append(overlay);
}

function openSeed() {
  const overlay = el('div', { class: 'tb-modal', role: 'dialog', 'aria-modal': 'true' });
  const sheet = el('div', { class: 'tb-sheet tb-narrow' });
  overlay.append(sheet);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() { document.removeEventListener('keydown', onKey); overlay.remove(); }

  const draw = () => {
    sheet.replaceChildren();
    sheet.append(el('h3', {}, 'New team'),
      el('div', { class: 'tb-sub' },
        'Start empty, or from a line-up you already have. Teams are a scratchpad — '
        + 'when one settles, save it as a core, and it shows up here to start from.'));

    const list = el('div', { class: 'tb-seedlist' });

    // Starting blank is just one way of starting, so it lives in the same list
    // rather than behind a second control that looks like this one.
    const blank = el('button', { class: 'tb-seed tb-seed-blank' },
      el('div', { class: 'tb-seed-main' },
        el('div', { class: 'tb-seed-head' },
          el('b', {}, 'Empty team'),
          el('i', {}, 'design it from scratch')),
        // Six empty slots, so it carries the same weight as the rows offering
        // six Pokémon. It is one of three equal ways to start, not a footnote.
        el('div', { class: 'tb-seed-mons tb-seed-blanks' },
          ...Array.from({ length: T.MAX_SLOTS }, (_, k) =>
            el('span', { class: 'tb-blankslot' }, String(k + 1))))));
    blank.onclick = () => { close(); newTeam(); };
    list.append(blank);

    // Your party, and cores you saved. Nothing else: offering the first six of
    // every box produced two dozen rows nobody was ever going to pick.
    const party = F.read('party').filter((x) => x.mon).map((x) => x.mon);
    if (party.length) {
      list.append(seedRow({
        label: 'Your party', sub: `${party.length} in play right now`,
        mons: party.map((m) => ({ species: m.species, level: m.level })),
        onPick: () => adoptTeam(T.teamFromMons('From party', party)),
      }));
    }

    // Cores, the shipped rosters among them. They used to be listed separately
    // as "built in", which said they were a different kind of thing -- they are
    // adopted into the store on first run now, so they are just cores.
    for (const c of T.cores(teams)) {
      const specs = c.slots.map((sl) => sl.options[0]);
      const swaps = c.slots.reduce((n, sl) => n + sl.options.length - 1, 0);
      list.append(seedRow({
        label: c.name,
        sub: `core · ${specs.length} member${specs.length === 1 ? '' : 's'}`
          + (swaps ? ` · ${swaps} swap${swaps === 1 ? '' : 's'}` : ''),
        core: c, specs,
        mons: specs.map((sp) => ({ species: S.SPECIES[String(sp.speciesId)]?.name ?? '?', level: sp.level })),
        onPick: () => adoptTeam({
          ...T.blankTeam(c.name),
          slots: c.slots.map((sl) => ({ role: sl.role ?? null, why: sl.why ?? '',
            options: sl.options.map((o) => JSON.parse(JSON.stringify(o))) })),
        }),
      }));
    }

    if (!party.length && !T.cores(teams).length) {
      list.append(el('p', { class: 'tb-note' },
        'Nothing to copy from yet — start empty. Once a team settles, “Save as core” '
        + 'puts it in this list.'));
    }
    sheet.append(list);

    const cancel = el('button', { class: 'tb-btn' }, 'Cancel');
    cancel.onclick = close;
    sheet.append(el('div', { class: 'tb-foot' }, cancel));
  };

  function adoptTeam(t) {
    teams.unshift(t);
    cur = t.id;
    view.opt.clear();
    persistLocal();
    close();
    render();
  }

  function seedRow({ label, sub, mons, onPick, core = null, specs = null }) {
    const row = el('div', { class: 'tb-seed' });
    const head = el('button', { class: 'tb-seed-main', title: 'Copy this into a new team' },
      el('div', { class: 'tb-seed-head' }, el('b', {}, label), el('i', {}, sub)),
      el('div', { class: 'tb-seed-mons' },
        ...mons.slice(0, T.MAX_SLOTS).map((m) => (S.SPRITE[m.species]
          ? el('img', { src: S.SPRITE[m.species], alt: m.species,
            title: `${m.species}${m.level ? ` L${m.level}` : ''}`, loading: 'lazy' })
          : el('span', {}, String(m.species).slice(0, 3))))));
    head.onclick = onPick;
    row.append(head);

    if (core) {
      const acts = el('div', { class: 'tb-seed-acts' });

      const field = el('button', { class: 'tb-btn ghost',
        title: 'Put this core’s members into your party, so you do not have to move them '
          + 'one at a time in the in-game PC' }, 'Field it');
      field.onclick = () => { fieldCore({ name: label }, specs); close(); };
      acts.append(field);

      // The ONLY way to remove a core, and deliberately so: it hands the
      // line-up back as an editable team rather than destroying it, and that
      // extra step is the friction a settled thing should have.
      const back = el('button', { class: 'tb-btn ghost',
        title: 'Un-settle this core: it becomes an editable team again and stops being a core' },
        'Move back to builder');
      back.onclick = () => {
        if (!confirm(`Move “${core.name}” back into the builder?\n\n`
          + 'It becomes an editable team again and stops being a core. This is how you '
          + 'retire a core — nothing is lost, it just goes back to the scratchpad.')) return;
        const t = T.coreToTeam(core);
        teams = T.tombstone(teams, core.id);
        teams.unshift(t);
        cur = t.id;
        view.opt.clear();
        persistLocal();
        close();
        render();
      };
      acts.append(back);
      row.append(acts);
    }
    return row;
  }

  draw();
  document.body.append(overlay);
}

/**
 * Put a core's members into the party.
 *
 * Moving six Pokemon into the party one at a time through the in-game PC is
 * genuinely tedious, and this tab already holds a working copy of the save.
 * Only members you actually OWN can be fielded -- a spec is not a Pokemon --
 * so it says how many it found before doing anything.
 */
function fieldCore(core, specs) {
  const found = [];
  const missing = [];
  const taken = new Set();
  for (const spec of specs) {
    const m = T.matchSlot(spec, index, S, { taken });
    if (m.at) { taken.add(m.at.key); found.push({ loc: m.at.loc, index: m.at.index }); }
    else missing.push(S.SPECIES[String(spec.speciesId)]?.name ?? '?');
  }
  if (!found.length) {
    alert(`None of “${core.name}” is in your save yet. Start a team from it and use `
      + '“Build it” on each slot first — it is in the "In your save" footer of the card.');
    return;
  }
  const msg = missing.length
    ? `${found.length} of ${specs.length} are in your save. ${missing.join(', ')} `
      + `${missing.length === 1 ? 'is' : 'are'} not built yet.\n\nField the ${found.length} you have?`
    : `Field all ${found.length} of “${core.name}”?`;
  if (!confirm(`${msg}\n\nWhoever is in your party now goes back to a box. This stages the `
    + 'change — install or download to keep it.')) return;
  try {
    // REPLACE, not insert. moveMany() adds alongside whoever is already there,
    // so this used to fail with "Party holds 6. It already has 6, and 6 more
    // will not fit" the moment your party was full -- which is always.
    const r = F.fieldParty(found);
    render();
    CTX?.refreshActions?.();
    alert(`Fielded ${r.fielded}.`
      + (r.displaced ? ` ${r.displaced} went back to a box.` : '')
      + ' Install or download to write it to your save.');
  } catch (e) { alert(`Could not field it: ${e.message}`); }
}

// ------------------------------------------------------------ slot editor// ------------------------------------------------------------ slot editor
function openSlotEditor(t, slotIndex, optIndex = 0, { addOption = false } = {}) {
  // The search term is editor-local and deliberately not persisted: it is a
  // way of getting somewhere, not a preference.
  // `yours` is collapsible and `editAt` records "saving should write back to
  // THAT Pokémon". Both are editor-local: a way of getting somewhere, not a
  // preference, so neither is persisted.
  // `yoursOpen: false` -- starting from a copy you already own is an advanced
  // path. Open it sat between the species picker and every other field, on
  // every slot, for the one time in twenty anybody wanted it. The comment on
  // the panel itself explains the rest.
  const editView = { q: '', yoursOpen: false, editAt: null };

  /**
   * OPENING A PICKER MEANS OPENING IT READY TO TYPE.
   *
   * Two habits, and the pickers had neither. A search box you still have to
   * click into is a search box with an extra step -- and the one you just
   * opened is the whole reason the panel is there. Worse, the term from LAST
   * time was still in it, so reopening the item list showed you the results of
   * a search you finished ten minutes ago and had to clear by hand.
   *
   * `armFocus` is a one-shot token consumed by the next render, rather than a
   * focus() on every draw: the form redraws while you are typing in other
   * fields, and stealing the caret out of the nickname box because the move
   * list happens to be open would be its own bug.
   */
  const armFocus = (id, clearKey) => {
    editView.focus = id;
    if (clearKey) editView[clearKey] = '';
  };
  const takeFocus = (id, node) => {
    if (editView.focus !== id || !node) return;
    editView.focus = null;
    node.focus();
  };
  const newSlot = slotIndex == null;
  const newOpt = addOption || optIndex == null;
  const slot = newSlot ? { role: null, why: '', options: [] } : t.slots[slotIndex];
  const oi = newOpt ? slot.options.length : optIndex;
  const state = (newSlot || newOpt)
    ? T.blankOption(slot.options[0]?.speciesId ?? 1)
    : JSON.parse(JSON.stringify(slot.options[oi]));
  const meta = { role: slot.role, why: slot.why };

  const overlay = el('div', { class: 'tb-modal', role: 'dialog', 'aria-modal': 'true' });
  const sheet = el('div', { class: 'tb-sheet' });
  overlay.append(sheet);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() { document.removeEventListener('keydown', onKey); overlay.remove(); }

  const draw = () => {
    const sp = S.SPECIES[String(state.speciesId)];
    const legalMoves = F.legalMoves(state.speciesId);
    const legalAb = new Set((sp?.ability_ids ?? []).filter(Boolean));
    sheet.replaceChildren();

    const title = newSlot ? 'Add a slot'
      : newOpt ? `Add a swap for slot ${slotIndex + 1}`
        : `${sp?.name}${oi > 0 ? ` — swap ${oi}` : ''}`;
    sheet.append(el('div', { class: 'tb-sheet-head' },
      el('div', { class: `tb-art${state.shiny ? ' shiny' : ''}` },
        S.SPRITE[sp?.name] ? el('img', { src: S.SPRITE[sp.name], alt: sp.name }) : el('span', {}, '?'),
        state.shiny ? el('b', {}, '◆') : null),
      el('div', {},
        el('h3', {}, title),
        el('div', { class: 'tb-sub' }, (sp?.types ?? []).join(' / ')))));

    const form = el('div', { class: 'tb-form' });
    const field = (label, control, span = false) =>
      el('div', { class: `tb-field${span ? ' tb-span' : ''}` }, el('label', {}, label), control);

    // ---------------------------------------------------------- species
    // WHY THIS IS NOT A <select>
    // It was one, with all 649 species in it, which meant finding Sableye
    // involved scrolling a 649-row dropdown -- and the "start from one of
    // yours" control beside it was a SECOND 276-row dropdown saying almost
    // the same thing. Search plus sprites beats both: you recognise a
    // Pokémon by its picture long before you can spell it.
    form.append(el('div', { class: 'tb-sec' }, 'Species'));
    const pick = el('div', { class: 'tb-pick tb-span' });

    const q = el('input', { class: 'tb-search', type: 'text', value: editView.q,
      placeholder: `Search ${Object.keys(S.SPECIES).length} species by name, number or type…` });
    const results = el('div', { class: 'tb-pickgrid' });

    const drawResults = () => {
      results.replaceChildren();
      const term = editView.q.trim().toLowerCase();
      const all = Object.entries(S.SPECIES);
      // WITH NO SEARCH, SHOW WHAT YOU OWN -- not the species already chosen.
      // It used to show exactly that one cell, directly under a header showing
      // the same sprite at the same moment: two pictures of one Pokémon and no
      // information between them. The species in your save is the list you
      // actually want when you open this, and it is never redundant with the
      // header.
      const mine = ownedSpeciesIds();
      const hits = (term
        ? all.filter(([id, v]) => v.name.toLowerCase().includes(term)
          || id === term
          || (v.types ?? []).some((ty) => ty.toLowerCase() === term))
        : all.filter(([id]) => mine.has(Number(id)) || Number(id) === state.speciesId)
      ).slice(0, 120);
      if (!hits.length) {
        results.append(el('p', { class: 'tb-picknone' }, editView.q
          ? `Nothing matches “${editView.q}”.`
          : 'Nothing in your save yet — search to plan with any of the 649.'));
        return;
      }
      for (const [id, v] of hits) {
        const on = Number(id) === state.speciesId;
        const b = el('button', {
          class: `tb-pickcell${on ? ' on' : ''}`, 'aria-current': String(on),
          title: `${v.name} · #${id} · ${(v.types ?? []).join(' / ')}`,
        },
          S.SPRITE[v.name] ? el('img', { src: S.SPRITE[v.name], alt: v.name, loading: 'lazy' })
            : el('i', {}, '?'),
          el('span', {}, v.name));
        b.onclick = () => {
          state.speciesId = Number(id);
          // The job is done in one pick, so this is where it closes -- and the
          // search goes with it, or reopening shows last time's results.
          editView.speciesOpen = false;
          editView.q = '';
          // A gender the new species cannot have is not a build, it is a
          // leftover. The Factory corrects the same way on a species change.
          SF.correctGender(state, S);
          draw();
        };
        results.append(b);
      }
    };
    q.oninput = () => { editView.q = q.value; drawResults(); };
    drawResults();

    // A PICKER CLOSES ONCE IT HAS DONE ITS JOB.
    //
    // The grid used to sit open for the whole life of the dialog, 380px of
    // sprites between you and every other field, long after you had chosen.
    // A list that is finished is furniture. So: open while you are choosing,
    // collapsed to the choice afterwards, and one click to reopen.
    //
    // `speciesOpen` is undefined on first draw, which is deliberate -- a NEW
    // slot opens with the grid up because you have not chosen yet, and an
    // existing one opens collapsed because you have.
    const chosen = S.SPECIES[String(state.speciesId)];
    const open = editView.speciesOpen ?? newSlot;
    const summary = el('button', { class: 'tb-chosen', type: 'button',
      title: 'Change the species' },
    S.SPRITE[chosen?.name]
      ? el('img', { src: S.SPRITE[chosen.name], alt: chosen.name })
      : el('i', {}, '?'),
    el('span', {},
      el('b', {}, chosen?.name ?? '—'),
      el('u', {}, (chosen?.types ?? []).map((t) => t[0].toUpperCase() + t.slice(1)).join(' / '))),
    el('em', {}, 'Change'));
    summary.onclick = () => {
      editView.speciesOpen = true;
      armFocus('species', 'q');
      draw();
    };
    if (open) {
      const done = el('button', { class: 'tb-btn ghost', type: 'button' }, 'Done');
      done.onclick = () => { editView.speciesOpen = false; draw(); };
      pick.append(q, el('p', { class: 'tb-hint' },
        editView.q ? '' : 'The species you own. Search to plan with any of the 649.'),
      results, el('div', { class: 'tb-pickfoot' }, done));
      takeFocus('species', q);
    } else {
      pick.append(summary);
    }



    // The copies you already have of THIS species -- scoped to the choice you
    // just made, rather than a flat list of everything in the save. Copying
    // one fills the whole spec from that exact Pokémon, which is how you say
    // "the same as that one, but…".
    // THE THREE CHOICES LIVE HERE, NOT ON A SECOND SCREEN
    // You have copies of this species. There are exactly three things you can
    // mean, and all three are on this panel: COPY one as a starting point for
    // a new Pokémon, EDIT that exact one in place, or dismiss the panel and
    // design from scratch. Splitting "which build" from "which Pokémon"
    // across the editor and the card was the confusing part.
    const mine = index.filter((x) => x.mon.speciesId === state.speciesId);
    if (mine.length) {
      // Shut until asked for -- see the note on editView.
      const yoursOpen = Boolean(editView.yoursOpen);
      const yours = el('div', { class: `tb-yours${yoursOpen ? '' : ' shut'}` });
      const head = el('button', { class: 'tb-yourshead', type: 'button',
        'aria-expanded': String(yoursOpen),
        title: yoursOpen ? 'Hide these and design from scratch'
          : 'Start from one of the copies you already own, or edit one in place' },
        el('span', { class: 'tb-yourslab' },
          `You have ${mine.length} ${sp?.name ?? ''}${mine.length === 1 ? '' : 's'}`),
        el('i', { class: 'tb-yoursmore' },
          yoursOpen ? 'Ignore' : 'Copy one, or edit it in place'));
      head.onclick = () => { editView.yoursOpen = !editView.yoursOpen; draw(); };
      yours.append(head);

      if (yoursOpen) {
        for (const x of mine.slice(0, 8)) {
          const key = `${x.loc}:${x.index}`;
          const on = editView.editAt && `${editView.editAt.loc}:${editView.editAt.index}` === key;
          const row = el('div', { class: `tb-yourrow${on ? ' on' : ''}` },
            S.SPRITE[x.mon.species] ? el('img', { src: S.SPRITE[x.mon.species], alt: '' }) : null,
            el('span', { class: 'tb-yourwhere' },
              el('b', {}, `${locLabel(x.loc)} ${x.index + 1}`),
              el('i', {}, `L${x.mon.level} · ${T.NATURE_NAMES[x.mon.natureId] ?? '?'}`)));

          const copy = el('button', { class: 'tb-btn ghost', type: 'button',
            title: 'Fill this form from that Pokémon, then design a NEW one from there. '
              + 'The one you own is left alone.' }, 'Copy');
          copy.onclick = () => {
            Object.assign(state, T.monToSpec(x.mon));
            editView.editAt = null;
            draw();
          };

          const edit = el('button', {
            class: `tb-btn ${on ? 'primary' : ''}`, type: 'button',
            title: 'Fill this form from that Pokémon and write your changes back to IT '
              + 'when you save — no second copy.' }, on ? 'Editing this' : 'Edit this one');
          edit.onclick = () => {
            Object.assign(state, T.monToSpec(x.mon));
            editView.editAt = { loc: x.loc, index: x.index };
            draw();
          };

          row.append(copy, edit);
          yours.append(row);
        }
        yours.append(el('p', { class: 'tb-yourhint' }, editView.editAt
          ? `Saving edits your ${sp?.name} in ${locLabel(editView.editAt.loc)} `
            + `${editView.editAt.index + 1} in place. Undo is available, and nothing reaches `
            + 'your save file until you install or download.'
          : 'Copying leaves the ones you own alone — the slot plans a new Pokémon, and the '
            + 'card offers to build it. “Edit this one” changes the Pokémon itself instead.'));
      }
      pick.append(yours);
    }
    form.append(pick);

    // ---- WHO IT IS ------------------------------------------------------
    // AFTER THE SPECIES, AND ONLY ONCE THERE IS ONE.
    //
    // It sat above the picker, so the form read "Species" / nickname, gender,
    // shininess / ...and then the species search box -- a heading, three
    // fields belonging to a choice you had not made yet, and then the choice.
    // Nicknaming a Pokémon before deciding what it is has no meaning.
    //
    // While the picker is open you are choosing the species and nothing else,
    // so nothing about the individual is on screen to compete with it.
    if (!open) {
      form.append(el('div', { class: 'tb-sec' }, 'Who it is'),
        SF.identityRow({ state, S, redraw: draw }));
    }

    form.append(el('div', { class: 'tb-sec' }, 'Level'),
      SF.levelControl({ state, redraw: draw,
        partyLevels: index.filter((x) => x.loc === 'party').map((x) => x.mon.level) }));

    form.append(el('div', { class: 'tb-sec' }, 'Nature'),
      SF.natureChart({ state, S, redraw: draw, natureNames: T.NATURE_NAMES }));

    // ---- WHAT THIS SLOT IS FOR -----------------------------------------
    // DEFINED HERE, RENDERED LAST. Role and reason are what you conclude about
    // a slot AFTER you have specced it -- you cannot honestly say "this is the
    // wall" before choosing its spread. They also sat two prose fields between
    // the species and the numbers, which is the wrong place for both. Same for
    // a swap's badge and note: they describe a trade you have not made yet.
    const slotProse = () => {
    if (oi === 0) {
      // FOUR OPTIONS IS NOT A DROPDOWN. Roles are a small closed set and each
      // one means something specific, so they are chips carrying what they
      // mean -- and the inferred default is a chip too, saying what it
      // inferred, rather than a blank first option nobody reads.
      const inferred = T.inferRole(state, S);
      const ROLE_BLURB = {
        setter: 'Puts the condition up — weather, Trick Room, screens, hazards',
        sweeper: 'Wins the game once it is set up',
        wall: 'Absorbs what the rest of the team cannot',
        pivot: 'Comes in safely and leaves again — U-turn, Volt Switch',
      };
      const roles = el('div', { class: 'tb-roles' });
      const roleChip = (val, label, blurb) => {
        const on = (meta.role ?? '') === val;
        const b = el('button', { class: `tb-rolechip${on ? ' on' : ''}`, type: 'button' },
          el('b', {}, label), el('span', {}, blurb));
        b.onclick = () => { meta.role = val || null; draw(); };
        return b;
      };
      roles.append(roleChip('', `Auto — ${inferred}`,
        'Read from the spread and the moves. Fine unless you disagree.'));
      for (const r of T.ROLES) {
        roles.append(roleChip(r, r[0].toUpperCase() + r.slice(1), ROLE_BLURB[r] ?? ''));
      }
      form.append(el('div', { class: 'tb-sec' }, 'Role'),
        el('div', { class: 'tb-span' }, roles));

      // It is a sentence that appears under the slot on the battle tab, so it
      // gets the room a sentence needs and says what a good one looks like.
      const why = el('textarea', { class: 'tb-whyin', rows: 2, maxLength: 120,
        placeholder: 'e.g. “The only thing here that resists Dragon” — it shows under '
          + 'this slot on the battle tab' });
      why.value = meta.why ?? '';
      why.oninput = () => { meta.why = why.value; };
      form.append(el('div', { class: 'tb-sec' }, 'Why this slot exists'),
        el('div', { class: 'tb-span' }, why));
    } else {
      // A swap needs to say what it is FOR and what it costs, which is the
      // whole content of a swap card on the battle sheet.
      const badge = el('input', { type: 'text', value: state.badge ?? '', maxLength: 28,
        placeholder: 'e.g. vs Ground' });
      badge.oninput = () => { state.badge = badge.value; };
      form.append(field('Swap badge', badge));

      const note = el('input', { type: 'text', value: state.note ?? '', maxLength: 160,
        placeholder: 'What you give up by fielding it' });
      note.oninput = () => { state.note = note.value; };
      form.append(field('What it costs', note, true));
    }
    };

    form.append(el('div', { class: 'tb-sec' }, 'Ability'),
      SF.abilityPicker({ state, S, view: editView, redraw: draw, legalAb }));

    form.append(el('div', { class: 'tb-sec' }, 'Held item'),
      SF.itemPicker({ state, S, view: editView, redraw: draw, heldFirst: HELD_FIRST }));

    form.append(el('div', { class: 'tb-sec' }, 'Moves'),
      SF.movePicker({ state, S, view: editView, redraw: draw, legalMoves }));

    // ---- IVs and EVs ---------------------------------------------------
    // The presets are facts about the GAME, not about this tab, so they live
    // in specform.js beside the controls they drive -- the Factory had
    // "Speed 0" and the Builder did not, which is the two-editors problem in
    // miniature.
    const mkBtn = (label, tip, fn) => {
      const b2 = el('button', { class: 'tb-btn ghost', type: 'button', title: tip }, label);
      b2.onclick = fn;
      return b2;
    };
    const evCapped = closed(may('builder.illegal-evs'));
    form.append(SF.spreadBlock({
      state,
      redraw: draw,
      evCapped,
      extraIv: SF.ivPresets(state, draw, mkBtn),
      extraEv: SF.evPresets(state, draw, mkBtn, { capped: evCapped }),
    }));

    // Last, now that everything it describes has been chosen.
    slotProse();

    const illegalMv = state.moveIds.filter((m) => m && !legalMoves.has(m));
    if (illegalMv.length || (state.abilityId && !legalAb.has(state.abilityId))) {
      form.append(el('div', { class: 'tb-note warn' },
        el('b', {}, 'Heads up: '),
        'marked illegal for this species. Gen 5 stores both in the record and reads them '
        + 'directly, so the game honours it and it works in battle — a legitimately-obtained '
        + 'Pokémon just could not have it. ',
        el('i', {}, 'I’m not your mother, though — design it if you want, and the Factory '
          + 'will build it.')));
    }
    form.append(el('div', { class: 'tb-note' },
      `Typing is fixed at ${(sp?.types ?? []).join(' / ') || '?'} — it lives in the ROM, not the save.`));

    sheet.append(form);
    const ok = el('button', { class: 'tb-btn primary' },
      editView.editAt ? 'Save & edit that one'
        : newSlot ? 'Add to team' : newOpt ? 'Add swap' : 'Save');
    ok.onclick = () => {
      if (newSlot) {
        t.slots.push({ role: meta.role, why: meta.why, options: [state] });
      } else {
        slot.role = meta.role; slot.why = meta.why;
        if (newOpt) slot.options.push(state); else slot.options[oi] = state;
        view.opt.set(slotIndex, newOpt ? slot.options.length - 1 : oi);
      }
      // "Edit this one" means what it says: the spec is applied to that exact
      // record here, rather than being left as a plan for the card to offer
      // later. A slot is still a SPECIFICATION -- this writes once, now, and
      // does not bind the slot to a pointer.
      if (editView.editAt) {
        try { F.write(editView.editAt, T.specToBuild(state, S)); }
        catch (e) { alert(`Saved the plan, but could not edit that Pokémon: ${e.message}`); }
      }
      touch(); close(); render();
    };
    const cancel = el('button', { class: 'tb-btn' }, 'Cancel');
    cancel.onclick = close;
    sheet.append(el('div', { class: 'tb-foot' }, ok, cancel));
  };
  draw();
  document.body.append(overlay);
}

// ----------------------------------------------------------------- helpers
/**
 * Six stats as bars you drag, with the number still typeable beside them.
 *
 * `budget` -- when given -- caps each stat at what is LEFT rather than at the
 * per-stat maximum, so the control cannot spend EVs you do not have. Typing a
 * number over the budget is clamped the same way; silently accepting 300 and
 * writing 252 would be worse than refusing it.
 *
 * `nature` marks the raised and lowered stat, because a nature and a spread
 * are one decision made in two places and the second half is where you forget
 * the first.
 */

function select(pairs, value) {
  const s = el('select');
  for (const [v, label] of pairs) {
    const o = el('option', { value: v }, label);
    if (String(v) === String(value)) o.selected = true;
    s.append(o);
  }
  return s;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));

function newTeam() {
  const t = T.blankTeam(T.nextTeamName(teams));
  teams.unshift(t);
  cur = t.id;
  persistLocal();
  render();
}

function exportTeams() {
  const blob = new Blob([JSON.stringify({ teams }, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: 'blaze-black-teams.json' });
  document.body.append(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// -------------------------------------------------------------------- tab
export default {
  id: 'builder',
  label: 'Team Builder',
  needsSave: true,

  async mount(panel, ctx) {
      S = ctx.S;
    F = ctx.factory;
    HELD_FIRST = new Set(ctx.S?.HELD_INTEREST ?? []);
    CONFIG = ctx.config ?? null;
    CTX = ctx;
    NUZ = ctx.nuz ?? null;
    TRAINER = ctx.trainer ?? null;
    try { viz = { ...viz, ...JSON.parse(localStorage.getItem(VIZ_PREF) ?? '{}') }; } catch { /* ignore */ }

    teams = T.loadLocal(TRAINER?.trainer_id).map(T.normalizeTeam);
    root = el('div', { class: 'tb' });
    panel.append(root);
    render();

    // The repo copy is merged in after the first paint, so a slow or missing
    // server never delays the tab.
    if (CONFIG) {
      try {
        const repo = await T.loadRepo();
        if (repo.length) {
          teams = T.merge(teams, repo).map(T.normalizeTeam);
          if (!team()) cur = T.onlyTeams(teams)[0]?.id ?? null;
          persistLocal();
          render();
        }
      } catch { /* no server, or no teams file yet */ }
    }
    if (!cur && T.onlyTeams(teams).length) { cur = T.onlyTeams(teams)[0].id; render(); }
  },

  unmount() {
    document.querySelector?.('.tb-modal')?.remove();
    // Take our own markup out. app.js clears the panel before mounting, so
    // this is belt and braces there -- but a tab that leaves its root behind
    // stacks up silently when mounted twice, which is exactly what happened
    // in the test harness.
    root?.remove?.();
    root = null;
  },
};
