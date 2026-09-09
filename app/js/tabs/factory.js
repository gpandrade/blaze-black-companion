/**
 * tabs/factory.js -- the Pokemon Factory.
 *
 * Your party and every box as a sprite grid, with move / delete / edit /
 * create and an editor modal. Everything happens in a working copy; the only
 * way out is a verified download.
 *
 * The operations live in app/js/factory.js. This file is DOM only.
 */

import { Factory, FactoryError, locLabel, locCapacity, SORT_LABELS } from '../factory.js';
import { NATURES } from '../../../js/pk5.js';
import { ABILITIES, natureEffect } from '../../../js/tables.js';
import { pickMoveSlot } from '../pick.js';
import * as SF from '../specform.js';
import { BOX_COUNT } from '../../../js/save.js';
import { gate } from '../nuzlocke.js';
import * as NUZMOD from '../nuzlocke.js';
import * as NZ from '../nuzlocke.js';
import { shackle, shackleBanner } from '../shackle.js';

// Where the Pokédex leaves "build one of these". Read once and cleared.
const HANDOFF = 'bb_dexcreate';

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const STAT_LABEL = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
const EV_CAP_TOTAL = 510;

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('aria-') || k === 'role' || k === 'type' || k === 'value'
      || k === 'min' || k === 'max' || k === 'maxLength' || k === 'checked' || k === 'title') {
      if (k === 'checked' || k === 'value') n[k] = v; else n.setAttribute(k, v);
    } else n[k] = v;
  }
  n.append(...kids.filter((x) => x != null));
  return n;
};

let F = null;              // the Factory
let CONFIG = null;         // /api/config, for the install button
let CTX = null;            // the shell, for refreshActions()
let WALLPAPERS = [];
// The rules, from the shell. `gate()` opens everything when the mode is off.
let NUZ = null;
const may = (action) => gate(NUZ, action);       // the game's own per-box wallpaper index, 0..15
let S = null;              // static data
let root = null;
// Party, Battle Box and one PC box are all on screen at once, so a selection
// is keyed by LOCATION AND SLOT rather than by slot alone. That is what makes
// "pick two out of a box and drop them in the party" a single gesture instead
// of a round trip through a menu.
//
// `box` is which PC box the lower area shows; `moving` holds absolute pairs so
// an armed move survives switching boxes underneath it.
let view = { box: 0, sel: new Set(), anchor: null, moving: null, hideBattle: false };

const KEY = (loc, index) => `${loc}:${index}`;
const unKEY = (k) => {
  const i = k.lastIndexOf(':');
  const loc = k.slice(0, i);
  return { loc: (loc === 'party' || loc === 'battleBox') ? loc : Number(loc), index: Number(k.slice(i + 1)) };
};
const LOC_RANK = (loc) => (loc === 'party' ? -2 : loc === 'battleBox' ? -1 : loc);
const selList = () => [...view.sel].map(unKEY)
  .sort((a, b) => LOC_RANK(a.loc) - LOC_RANK(b.loc) || a.index - b.index);
const only = () => (view.sel.size === 1 ? selList()[0] : null);

const BATTLE_HIDDEN = 'fx.hideBattleBox';

// ------------------------------------------------------------------ render
function render() {
  // The shell owns Install/Download for the shared working copy, so it has
  // to be told whenever this tab changes it.
  CTX?.refreshActions?.();
  const areas = el('div', { class: 'fx-left' });

  // Party first and always visible: it is the thing you move Pokémon INTO,
  // and burying it in a menu alongside 24 boxes made the most common action
  // the most awkward one.
  areas.append(area('party', { title: 'Party', sortable: true }));

  if (view.hideBattle) {
    const show = el('button', { class: 'fx-btn fx-ghost' }, 'Show Battle Box');
    show.onclick = () => { setHideBattle(false); render(); };
    areas.append(el('div', { class: 'fx-stub' }, show));
  } else {
    areas.append(area('battleBox', { title: 'Battle Box', sortable: true, hideable: true }));
  }

  areas.append(boxArea());
  // The shackles in force, named, at the top of the tab -- so you know before
  // reaching for a button rather than after it refuses.
  root.replaceChildren(
    ...[shackleBanner(document, NUZ,
      ['factory.create', 'factory.edit', 'factory.heal', 'bag.give', 'bag.teach'],
      NUZMOD)].filter(Boolean),
    toolbar(), el('div', { class: 'fx-main' }, areas, detail()));
  root.classList.toggle('fx-moving', Boolean(view.moving));
}

function setHideBattle(v) {
  view.hideBattle = v;
  try { localStorage.setItem(BATTLE_HIDDEN, v ? '1' : '0'); } catch { /* private mode */ }
}

function toolbar() {
  const out = F.output();

  const undo = el('button', { class: 'fx-btn', disabled: !F.canUndo }, 'Undo');
  undo.onclick = () => { F.undo(); view.moving = null; render(); };

  const org = el('button', { class: 'fx-btn', title: 'Sort or regroup every box at once' },
    'Organize boxes…');
  org.onclick = () => openOrganize();

  // Install and Download are NOT here any more. They act on the one working
  // copy the whole app shares, so they live once in the shell bar next to the
  // save itself. Three tabs each drawing their own pair implied three separate
  // piles of pending changes.
  return el('div', { class: 'fx-bar' },
    el('h2', {}, 'Pokémon Factory'),
    !out.ok && F.dirty
      ? el('span', { class: 'fx-err' }, `cannot save: ${out.problems[0]}`) : null,
    el('span', { class: 'fx-spacer' }),
    org, undo);
}

/**
 * One slot area. Party and Battle Box are six across; a PC box is thirty.
 * Same cell renderer for all three, so a Pokémon looks identical wherever it
 * lives and dragging between them reads as one surface.
 */
function area(loc, { title, sortable = false, hideable = false, head: extraHead = null } = {}) {
  const slots = F.read(loc);
  const filled = slots.filter((s) => s.mon).length;
  const cap = locCapacity(loc);

  const g = el('div', { class: 'fx-grid' });
  const movingKeys = new Set((view.moving ?? []).map((f) => KEY(f.loc, f.index)));
  for (const s of slots) g.append(cell(s, movingKeys));

  const head = el('div', { class: 'fx-grid-head' },
    el('h3', {}, title),
    el('span', {}, `${filled} of ${cap}`),
    el('span', { class: 'fx-spacer' }));
  if (extraHead) head.append(extraHead);
  if (loc === 'party' && filled) {
    const hurt = slots.filter((x) => x.mon && x.mon.currentHp != null
      && x.mon.currentHp < x.mon.maxHp).length;
    const h = el('button', {
      class: `fx-btn fx-heal${hurt ? ' needed' : ''}`,
      title: 'Full HP, full PP, no status — everything a Pokémon Centre does, without the walk. '
        + 'Staged like any other edit; install or download to keep it.',
    }, hurt ? `Heal party (${hurt} hurt)` : 'Heal party');
    shackle(h, may('factory.heal'));
    h.onclick = () => {
      try {
        const r = F.healParty();
        render();
        alert(r.healed.length
          ? `Healed ${r.count}:\n\n${r.healed.map((x) => `${x.name} — `
            + [x.hp ? `+${x.hp} HP` : null, x.pp ? `+${x.pp} PP` : null].filter(Boolean).join(', ')).join('\n')}`
            + '\n\nStaged — install or download to keep it.'
          : 'Everyone was already at full HP and PP.');
      } catch (e) { alertish(e); }
    };
    head.append(h);
  }
  if (sortable && filled > 1) head.append(selectAllBtn(loc, filled), sortMenu(loc));
  if (hideable) {
    const h = el('button', { class: 'fx-btn fx-ghost', title: 'Hide this area' }, 'Hide');
    h.onclick = () => { setHideBattle(true); render(); };
    head.append(h);
  }
  const wrap = el('div', { class: 'fx-grid-wrap' }, head, g);

  // THE BOX KEEPS THE WALLPAPER THE GAME GAVE IT.
  // A PC box in Blaze Black has one of sixteen wallpapers and the save records
  // which; here every box was the same grey rectangle. The index picks a
  // wagara pattern and a hue, so boxes are told apart at a glance the way they
  // are in game -- without inventing sixteen background images.
  if (typeof loc === 'number') {
    const w = (WALLPAPERS[loc] ?? loc) % 16;
    wrap.classList.add('fx-wall', `fx-wall-p${w % 4}`);
    wrap.style.setProperty('--fx-wall-h', String(Math.round((w / 16) * 360)));
  }
  return wrap;
}

function cell(s, movingKeys) {
  const k = KEY(s.loc, s.index);
  const isSel = view.sel.has(k);
  const isSrc = movingKeys.has(k);
  const c = el('div', {
    class: `fx-slot${s.mon ? '' : ' empty'}${isSrc ? ' movesrc' : ''}`,
    role: 'button',
    tabIndex: 0,
    'aria-selected': String(Boolean(isSel)),
    title: s.mon ? `${s.mon.species} · L${s.mon.level}` : 'empty slot',
  }, el('span', { class: 'fx-num' }, String(s.index + 1)));

  if (s.mon) {
    if (s.mon.shiny) c.append(el('span', { class: 'fx-star', title: 'shiny' }, '◆'));
    if (s.mon.sprite) c.append(el('img', { src: s.mon.sprite, alt: s.mon.species, loading: 'lazy' }));
    c.append(el('b', {}, s.mon.isNicknamed ? s.mon.nickname : s.mon.species),
      el('em', {}, `L${s.mon.level ?? '?'}`));
    // Only the party carries current HP. Worth seeing at a glance: coming back
    // to a save and heading straight into a gym with a half-dead lead is a
    // mistake this bar prevents for free.
    if (s.mon.currentHp != null && s.mon.maxHp) {
      const frac = s.mon.currentHp / s.mon.maxHp;
      const state = frac <= 0 ? 'ko' : frac <= 0.2 ? 'low' : frac <= 0.5 ? 'mid' : 'ok';
      c.append(el('span', {
        class: `fx-hp fx-hp-${state}`,
        title: `${s.mon.currentHp} of ${s.mon.maxHp} HP`,
      }, el('u', { style: `width:${Math.max(0, Math.min(1, frac)) * 100}%` }, '')));
    }
  } else {
    c.append(el('em', {}, '—'));
  }
  const act = (ev) => onSlot(s, ev ?? {});
  c.onclick = act;
  c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(e); } };
  return c;
}

function selectAllBtn(loc, filled) {
  const mine = F.read(loc).filter((x) => x.mon).map((x) => KEY(loc, x.index));
  const allOn = mine.length > 0 && mine.every((k) => view.sel.has(k));
  const b = el('button', { class: 'fx-btn fx-ghost' }, allOn ? 'None' : 'All');
  b.onclick = () => {
    if (allOn) mine.forEach((k) => view.sel.delete(k));
    else mine.forEach((k) => view.sel.add(k));
    render();
  };
  return b;
}

function sortMenu(loc) {
  const sel = select([['', 'Sort…'], ...Object.entries(SORT_LABELS)], '');
  sel.onchange = () => {
    if (!sel.value) return;
    try { F.sortBox(loc, sel.value); view.sel.clear(); } catch (e) { alertish(e); }
    render();
  };
  return sel;
}

/** The PC box area: a chip per box, then the thirty slots of the chosen one. */
function boxArea() {
  const counts = F.counts();
  const cap = F.boxCapacity;
  const names = F.locations().filter((l) => typeof l.loc === 'number');

  const chips = el('div', { class: 'fx-chips' });
  for (const item of names) {
    const n = counts.get(item.loc) ?? 0;
    const b = el('button', {
      class: `fx-chip${item.hidden ? ' hidden-box' : ''}${n === 0 ? ' empty' : ''}`,
      'aria-current': String(view.box === item.loc),
      title: item.hidden
        ? `${item.label} exists in the file but the game does not show it`
        : `${item.label}${item.name ? ` — ${item.name}` : ''} · ${n} Pokémon`,
    }, String(item.loc + 1));
    b.onclick = () => { view.box = item.loc; render(); };
    chips.append(b);
  }

  // The game ships showing EIGHT boxes. The other sixteen exist in the file
  // and are perfectly writable -- they are just unreachable in game, which is
  // exactly how six Pokémon once became invisible. Offer the fix where the
  // locked boxes are actually visible, not buried in a toolbar.
  let unlock = null;
  if (cap < 24) {
    const b = el('button', { class: 'fx-btn fx-unlock' },
      el('b', {}, `Unlock all 24 boxes`),
      el('i', {}, `your save shows ${cap}`));
    b.onclick = () => {
      if (!confirm(`Your game currently shows ${cap} of the 24 boxes.\n\n`
        + 'The other 16 already exist in the save file — this flips the byte that '
        + 'tells the game how many to display, so they become reachable in game.\n\n'
        + 'Undo is available, and nothing is written to your save until you install '
        + 'or download.')) return;
      F.setBoxCapacity(24);
      render();
    };
    unlock = b;
  }

  const here = names.find((l) => l.loc === view.box);
  const label = `Box ${view.box + 1}${here?.name && here.name !== `BOX ${view.box + 1}` ? ` — ${here.name}` : ''}`;
  const warn = here?.hidden
    ? el('span', { class: 'fx-flag', title: 'The game shows only the first ' + cap + ' boxes' }, 'not in game')
    : null;
  const a = area(view.box, { title: label, sortable: true, head: warn });
  return el('div', { class: 'fx-boxarea' },
    el('div', { class: 'fx-chiprow' }, chips, unlock), a);
}

function onSlot(s, ev = {}) {
  const k = KEY(s.loc, s.index);

  if (view.moving) {
    const froms = view.moving;
    view.moving = null;
    try {
      const landed = froms.length === 1 && !ev.shiftKey
        ? (F.move(froms[0], { loc: s.loc, index: s.index }), [{ loc: s.loc, index: s.index }])
        : F.moveMany(froms, s.loc, s.index);
      if (typeof s.loc === 'number') view.box = s.loc;
      view.sel = new Set(landed.map((l) => KEY(l.loc, l.index)));
    } catch (e) { alertish(e); }
    render();
    return;
  }

  // Ctrl/Cmd toggles one, Shift extends within the SAME area (a run spanning
  // the party and a box is not a thing anyone means), a plain click replaces.
  if (ev.metaKey || ev.ctrlKey) {
    if (view.sel.has(k)) view.sel.delete(k); else view.sel.add(k);
    view.anchor = { loc: s.loc, index: s.index };
  } else if (ev.shiftKey && view.anchor && view.anchor.loc === s.loc) {
    const [lo, hi] = [Math.min(view.anchor.index, s.index), Math.max(view.anchor.index, s.index)];
    const slots = F.read(s.loc);
    for (let i = lo; i <= hi; i++) if (slots[i].mon) view.sel.add(KEY(s.loc, i));
  } else {
    view.sel = new Set([k]);
    view.anchor = { loc: s.loc, index: s.index };
  }
  render();
}

function detail() {
  const wrap = el('div', { class: 'fx-detail' });

  if (view.sel.size === 0) {
    // The rail is reserved whether or not anything is selected, so an empty
    // one should still be worth the space it takes. It used to hold the words
    // "Select a slot." in a bordered box and nothing else.
    const all = F.locations().filter((l) => !l.hidden)
      .flatMap((l) => F.read(l.loc)).filter((x) => x.mon).map((x) => x.mon);
    const party = F.read('party').filter((x) => x.mon).map((x) => x.mon);
    const shiny = all.filter((m) => m.shiny).length;
    const boxesUsed = F.locations().filter((l) => typeof l.loc === 'number' && !l.hidden
      && F.read(l.loc).some((x) => x.mon)).length;
    const levels = all.map((m) => m.level).filter((n) => n > 0);

    wrap.append(el('h3', {}, 'This save'));
    const kv = el('dl', { class: 'fx-kv' });
    const row = (k, v) => kv.append(el('dt', {}, k), el('dd', {}, v));
    row('Pokémon', `${all.length}`);
    row('Party', `${party.length} of 6`);
    if (levels.length) {
      row('Levels', `${Math.min(...levels)}–${Math.max(...levels)}`);
    }
    row('Boxes in use', `${boxesUsed}`);
    row('Shiny', `${shiny}`);
    wrap.append(kv);
    wrap.append(el('p', { class: 'fx-hint' },
      'Click a slot to see and edit it. Ctrl-click (⌘ on a Mac) picks out several; '
      + 'Shift-click takes a run. Every edit happens in a copy held in this tab — '
      + 'nothing reaches your save file until you install or download from the bar above.'));
    return wrap;
  }

  if (view.sel.size > 1) return multiDetail(wrap);

  const { loc, index } = only();
  const m = F.read(loc)[index]?.mon ?? null;

  if (!m) {
    wrap.append(
      el('div', { class: 'fx-hero' }, el('div', {}, el('h3', {}, 'Empty slot'),
        el('div', { class: 'fx-sub' }, `${locLabel(loc)} · slot ${index + 1}`))));
    const create = el('button', { class: 'fx-btn primary' }, 'Create a Pokémon here');
    create.onclick = () => openEditor(null, { loc, index });
    shackle(create, may('factory.create'));
    const acts = el('div', { class: 'fx-acts' }, create);
    if (view.moving) acts.append(cancelMoveBtn());
    wrap.append(acts, templateNote());
    return wrap;
  }

  wrap.append(el('div', { class: 'fx-hero' },
    m.sprite ? el('img', { src: m.sprite, alt: m.species,
      class: m.shiny ? 'fx-shinyart' : '' }) : null,
    el('div', {},
      el('h3', {}, m.isNicknamed ? m.nickname : m.species),
      el('div', { class: 'fx-sub' },
        `${m.isNicknamed ? m.species + ' · ' : ''}#${m.speciesId} · ${locLabel(loc)} slot ${index + 1}`))));

  const kv = el('dl', { class: 'fx-kv' });
  const row = (k, ...v) => { kv.append(el('dt', {}, k), el('dd', {}, ...v)); };
  row('Level', String(m.level ?? '?'));
  row('Types', m.types.join(' / ') || '—');
  row('Nature', m.nature ?? '—');
  row('Ability', m.ability,
    m.abilityLegal ? null : el('span', { class: 'fx-flag',
      title: 'This species cannot legally have this ability. Gen 5 reads the ability byte '
        + 'directly, so the game honours it and it works in battle — the label is just so you '
        + 'know it was not obtained legitimately. Nothing is stopping you.' }, 'illegal'));
  row('Gender', m.gender);
  row('Held item', m.item ?? '—');
  row('Moves', m.moves.map((x) => x.name).join(', ') || '—');
  row('OT', `${m.otName} (${m.tid})`);
  if (m.currentHp != null && m.maxHp) {
    row('HP', `${m.currentHp} / ${m.maxHp}`,
      m.currentHp < m.maxHp ? el('span', { class: 'fx-flag' }, 'hurt') : null);
  }
  if (m.shiny) row('Shiny', 'yes');
  if (m.isEgg) row('Egg', 'yes');
  wrap.append(kv);

  if (m.stats) {
    const max = Math.max(...STAT_KEYS.map((k) => m.stats[k]), 1);
    // The nature's ±10% marked the way the game marks it, on the stat name.
    const nat = natureEffect(m.natureId);
    const sr = el('div', { class: 'fx-statrow' });
    for (const k of STAT_KEYS) {
      const mark = nat && k === nat.up ? ' nat-up' : nat && k === nat.down ? ' nat-down' : '';
      sr.append(el('i', { class: `fx-statname${mark}`,
        title: mark ? `${NATURES[m.natureId]}: ${mark === ' nat-up' ? '+' : '−'}10% ${STAT_LABEL[k]}` : '' },
        STAT_LABEL[k]),
        el('div', { class: 'fx-track' }, el('span', { style: `width:${(m.stats[k] / max) * 100}%` })),
        el('u', { class: `fx-statval${mark}` }, String(m.stats[k])));
    }
    wrap.append(sr);
  }

  // IVs and EVs as paired bars rather than two slash-separated numbers. They
  // are on different scales (0-31 and 0-252), so each is drawn against its own
  // maximum and labelled -- a shared axis would make a perfect IV look like a
  // rounding error next to a maxed EV.
  const evTotal = STAT_KEYS.reduce((a, k) => a + m.evs[k], 0);
  // The number goes BEFORE its bar, and the two are one cell.
  //
  // After the bar it was ambiguous however the gaps were tuned: a bar stretches
  // to fill its column, so its right edge lands hard against the next column
  // and the number ended up sitting between two bars, closer to the one it did
  // not describe. In front, the number is pinned to the left edge of its own
  // bar and the big gap falls between pairs, so proximity reads correctly.
  const pair = (fillCls, title, pct, num, numCls) =>
    el('span', { class: 'fx-ivev-pair', title },
      el('span', { class: `fx-ivev-num${numCls}` }, String(num)),
      el('span', { class: 'fx-ivev-bar' }, el('u', { class: fillCls, style: `width:${pct}%` }, '')));

  const iv = el('div', { class: 'fx-ivev' },
    el('span', { class: 'fx-ivev-head' }, ''),
    el('span', { class: 'fx-ivev-head' }, 'IV'),
    el('span', { class: 'fx-ivev-head' }, 'EV'));
  for (const k of STAT_KEYS) {
    const ivv = m.ivs[k], evv = m.evs[k];
    iv.append(
      el('i', {}, STAT_LABEL[k]),
      pair(ivv === 31 ? 'max' : ivv === 0 ? 'zero' : '', `${ivv} of 31 IVs`,
        (ivv / 31) * 100, ivv, ivv === 31 ? ' max' : ivv === 0 ? ' zero' : ''),
      pair(`ev${evv >= 252 ? ' max' : ''}`, `${evv} of 252 EVs`,
        Math.min(evv / 252, 1) * 100, evv, evv >= 252 ? ' max' : ''));
  }
  wrap.append(iv);
  if (evTotal > EV_CAP_TOTAL) {
    wrap.append(el('p', { class: 'fx-hint fx-over' },
      `${evTotal} EVs total — past the ${EV_CAP_TOTAL} the game hands out. Works fine; just noting it.`));
  }

  const acts = el('div', { class: 'fx-acts' });
  // Returns the button: a rule has to be able to close one, and it cannot do
  // that if the maker swallows the element.
  const mk = (label, cls, fn, title) => {
    const b = el('button', { class: `fx-btn ${cls}` }, label);
    if (title) b.setAttribute('title', title);
    b.onclick = fn;
    acts.append(b);
    return b;
  };
  shackle(mk('Edit', '', () => openEditor(m, { loc, index })), may('factory.edit'));
  // NEVER GATED. The game has a name rater, so renaming is unambiguously legal
  // in a playthrough -- and a nuzlocke's `nickname-all` rule REQUIRES a
  // nickname while `no-editing` closes the editor, so without its own control
  // the two rules contradicted each other outright.
  mk('Rename…', '', () => {
    const cur = m.isNicknamed ? m.nickname : '';
    const next = prompt(`Nickname for this ${m.species}?\n\n`
      + 'Ten characters. Leave it empty to go back to the species name.', cur);
    if (next === null) return;
    try { F.rename({ loc, index }, next.trim()); } catch (e) { alertish(e); }
    CTX?.refreshActions?.();
    render();
  }, 'Give it a nickname, or clear the one it has. Ten characters, like the game.');
  if (view.moving) acts.append(cancelMoveBtn());
  else mk('Move to…', '', () => { view.moving = selList(); render(); });
  // The same two actions the Bag offers, from the other direction: here you
  // have the Pokemon and want to find the item, rather than the reverse.
  shackle(mk('Give item…', '', () => openGive({ loc, index }, m),
    'Hand it something out of your bag. Whatever it is holding goes back in.'),
  may('bag.give'));
  // Teaching a TM you OWN is a legal thing to do in a playthrough, so it asks
  // only about the bag. It used to also ask `factory.moves`, which meant
  // "no rewriting what you caught" took away a Machine you had bought.
  shackle(mk('Teach TM…', '', () => openTeach({ loc, index }, m),
    'Teach it one of the TMs or HMs you own that it can legally learn'),
  may('bag.teach'));
  mk('Ball…', '', () => openBall({ loc, index }, m),
    'Which ball it lives in. Cosmetic in Gen 5 — the summary screen and the '
    + 'send-out flash, nothing else — and it does not cost you a ball.');
  mk('Duplicate', '', () => {
    try {
      const at = F.duplicate({ loc, index });
      if (typeof at.loc === 'number') view.box = at.loc;
      view.sel = new Set([KEY(at.loc, at.index)]);
    } catch (e) { alertish(e); }
    render();
  });
  // ---- IT DIED -------------------------------------------------------
  // Only when the nuzlocke is on and fainting means death, because outside a
  // nuzlocke there is no such event -- a fainted Pokémon just needs a Centre.
  //
  // The graveyard entry is written first and the release is staged second, so
  // a Pokémon is never removed without also being remembered. `auto-purge`
  // decides whether the body goes with it; without that rule it stays in the
  // box and only the log changes, which is how most people run it.
  if (NUZ?.enabled && NZ.active(NUZ, 'death-is-permanent')) {
    const purge = NZ.active(NUZ, 'auto-purge');
    mk('It died', 'danger', () => {
      const who = m.isNicknamed ? m.nickname : m.species;
      if (!confirm(`Mark ${who} as dead?\n\n`
        + (purge
          ? 'Your "the dead are released" rule will also stage its release. Nothing is '
            + 'written to your save until you install or download.'
          : 'It stays where it is — only the graveyard changes.'))) return;
      NZ.recordDeath(NUZ, { speciesId: m.speciesId, nickname: m.isNicknamed ? m.nickname : null,
        level: m.level, area: locLabel(loc), cause: 'fainted' });
      if (purge) {
        try { F.remove({ loc, index }); } catch (e) { alertish(e); }
      }
      CTX?.onNuzlockeChange?.(NUZ);
      CTX?.refreshActions?.();
      render();
    }, purge
      ? 'Log it in the graveyard and stage its release — your rules say the dead are released'
      : 'Log it in the graveyard. It stays in the box; only the log changes.');
  }

  mk('Delete', 'danger', () => {
    if (!confirm(`Delete ${m.isNicknamed ? m.nickname : m.species} from ${locLabel(loc)} slot ${index + 1}?\n\nThis only changes the working copy — undo is available.`)) return;
    try { F.remove({ loc, index }); view.sel.clear(); } catch (e) { alertish(e); }
    render();
  });
  wrap.append(acts);

  if (view.moving) wrap.append(movingHint());
  return wrap;
}

function multiDetail(wrap) {
  const picked = selList().map((f) => F.read(f.loc)[f.index]?.mon).filter(Boolean);
  const where = [...new Set(selList().map((f) => locLabel(f.loc)))];
  wrap.append(el('div', { class: 'fx-hero' }, el('div', {},
    el('h3', {}, `${picked.length} selected`),
    el('div', { class: 'fx-sub' },
      where.length <= 2 ? where.join(' + ') : `${where.length} locations`))));

  const strip = el('div', { class: 'fx-strip' });
  for (const m of picked.slice(0, 24)) {
    strip.append(m.sprite
      ? el('img', { src: m.sprite, alt: m.species, title: `${m.species} · L${m.level}` })
      : el('span', { title: m.species }, m.species.slice(0, 3)));
  }
  if (picked.length > 24) strip.append(el('span', {}, `+${picked.length - 24}`));
  wrap.append(strip);

  const levels = picked.map((m) => m.level).filter((x) => x != null);
  wrap.append(el('p', { class: 'fx-hint' },
    `Levels ${Math.min(...levels)}–${Math.max(...levels)} · `
    + `${picked.filter((m) => m.shiny).length} shiny · `
    + `${picked.filter((m) => !m.abilityLegal).length} with an illegal ability`));

  const acts = el('div', { class: 'fx-acts' });
  if (view.moving) {
    acts.append(cancelMoveBtn());
  } else {
    const mv = el('button', { class: 'fx-btn primary' }, `Move ${picked.length} to…`);
    mv.onclick = () => { view.moving = selList(); render(); };
    acts.append(mv);
  }
  const del = el('button', { class: 'fx-btn danger' }, `Delete ${picked.length}`);
  del.onclick = () => {
    if (!confirm(`Delete these ${picked.length} Pokémon?\n\nThis only changes the working copy — undo is available.`)) return;
    // Highest slot first: deleting from the party compacts, so removing low
    // to high would shift the slots out from under the later deletions.
    try {
      for (const f of selList().reverse()) F.remove(f);
      view.sel.clear();
    } catch (e) { alertish(e); }
    render();
  };
  acts.append(del);
  wrap.append(acts);
  if (view.moving) wrap.append(movingHint());
  return wrap;
}

function cancelMoveBtn() {
  const b = el('button', { class: 'fx-btn' }, 'Cancel move');
  b.onclick = () => { view.moving = null; render(); };
  return b;
}

function movingHint() {
  const n = view.moving.length;
  return el('p', { class: 'fx-hint' }, n === 1
    ? 'Click the destination slot. Moving onto an occupied slot swaps them; hold Shift to insert instead.'
    : `Click where they go — switch boxes first if you like. The ${n} are inserted at that slot and the box closes up around them.`);
}

function templateNote() {
  const src = F.templateSource();
  return el('p', { class: 'fx-hint' }, src
    ? `New Pokémon are cloned from ${src.species} in ${locLabel(src.loc)} slot ${src.index + 1}, so `
      + 'origin game, language, ball and met data come from it. Everything the editor shows is then overwritten.'
    : 'This save has no Pokémon to clone from.');
}

// --------------------------------------------------------- items and TMs
/**
 * Give this Pokemon something out of the bag.
 *
 * Only held items are offered -- category 0, TMs excluded. Handing somebody a
 * Repel is legal as far as the save is concerned and useless as far as the
 * game is concerned, so the list does not pretend otherwise.
 */
/**
 * Which ball a Pokemon lives in.
 *
 * Every ball in the game is offered, not only the ones in your bag: the field
 * is a single byte the game reads for display and nothing else, so there is
 * no stock to spend and pretending otherwise would be inventing a rule. It
 * does not consume anything, which the dialog says.
 *
 * Ball ids come from the ROM's own item table -- item 4 IS Poké Ball, which
 * is how B.BALL was confirmed in the first place -- filtered to the ball
 * category rather than hardcoded, so a hack that renamed one still shows the
 * right name.
 */
function openBall(at, m) {
  // Every ball in the game, not only the ones in your bag: the field is a
  // single byte the game reads for display and nothing else, so there is no
  // stock to spend and pretending otherwise would be inventing a rule.
  //
  // The ids come from the ROM's own item table filtered to the ball category,
  // never hardcoded -- item 4 IS Poké Ball, which is how B.BALL was confirmed
  // in the first place, and a hack that renamed one still shows the right name.
  const balls = Object.entries(S.ITEMINFO ?? {})
    .map(([id, v]) => ({ id: Number(id), name: v.name ?? '' }))
    .filter((b) => b.id > 0 && b.id < 100 && /\bBall$/.test(b.name))
    .sort((a, b) => a.id - b.id);
  if (!balls.length) { alertish(new Error('No ball items in the ROM tables.')); return; }

  const overlay = el('div', { class: 'pk-modal', role: 'dialog', 'aria-modal': 'true' });
  const sheet = el('div', { class: 'pk-sheet' });
  overlay.append(sheet);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() { document.removeEventListener('keydown', onKey); overlay.remove(); }

  const cur = m.ballId ?? 0;
  const grid = el('div', { class: 'fx-ballgrid' });
  for (const b of balls) {
    const src = (S.ITEMICON ?? {})[String(b.id)];
    const btn = el('button', {
      class: `fx-ball${b.id === cur ? ' on' : ''}`,
      'aria-pressed': String(b.id === cur),
      title: b.id === cur ? `${b.name} — where it is now` : `Move it to a ${b.name}`,
    }, src ? el('img', { src, alt: '', loading: 'lazy' }) : el('span', { class: 'fx-balldot' }, '●'),
      el('span', { class: 'fx-ballname' }, b.name.replace(/ Ball$/, '')));
    btn.onclick = () => {
      if (b.id !== cur) {
        try { F.setBall(at, b.id); } catch (e) { alertish(e); }
      }
      close();
      CTX?.refreshActions?.();
      render();
    };
    grid.append(btn);
  }

  sheet.append(
    el('h3', {}, `Which ball for ${m.isNicknamed ? m.nickname : m.species}?`),
    el('p', { class: 'pk-sub' },
      'Cosmetic in Gen 5 — the summary screen and the send-out flash, nothing '
      + 'else. It costs you nothing, so every ball is offered.'),
    grid);
  document.body.append(overlay);
}

function openGive(at, mon) {
  const bag = F.save.readPocket('items');
  const holdable = bag.filter((e) => {
    const d = S.ITEMINFO?.[String(e.item_id)];
    return d && d.cat === 0 && !d.tm;
  });

  const overlay = el('div', { class: 'pk-modal', role: 'dialog', 'aria-modal': 'true' });
  const sheet = el('div', { class: 'pk-sheet' });
  overlay.append(sheet);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() { document.removeEventListener('keydown', onKey); overlay.remove(); }

  sheet.append(el('h3', {}, `Give ${mon.species} an item`),
    el('p', { class: 'pk-sub' }, mon.item
      ? `It is holding ${mon.item}, which goes back into your bag.`
      : 'It is not holding anything.'));

  const list = el('div', { class: 'pk-list' });
  if (mon.item) {
    const take = el('button', { class: 'pk-row' },
      el('span', { class: 'pk-noicon' }, '—'),
      el('span', { class: 'pk-body' },
        el('span', { class: 'pk-name' }, 'Take it away'),
        el('span', { class: 'pk-sub2' }, `${mon.item} goes back into the bag`)));
    take.onclick = () => { close(); give(0); };
    list.append(take);
  }
  for (const e of holdable) {
    const d = S.ITEMINFO[String(e.item_id)];
    const b = el('button', { class: 'pk-row' },
      S.ITEMICON?.[String(e.item_id)]
        ? el('img', { src: S.ITEMICON[String(e.item_id)], alt: '', loading: 'lazy' })
        : el('span', { class: 'pk-noicon' }, d.name.slice(0, 2)),
      el('span', { class: 'pk-body' },
        el('span', { class: 'pk-name' }, `${d.name} ×${e.count}`),
        el('span', { class: 'pk-sub2' }, (d.desc ?? '').slice(0, 70))));
    b.onclick = () => { close(); give(e.item_id); };
    list.append(b);
  }
  if (!holdable.length && !mon.item) {
    list.append(el('p', { class: 'pk-empty' }, 'No held items in your bag.'));
  }
  sheet.append(list);
  const cancel = el('button', { class: 'pk-btn' }, 'Cancel');
  cancel.onclick = close;
  sheet.append(el('div', { class: 'pk-foot' }, cancel));
  document.body.append(overlay);

  function give(itemId) {
    try {
      const had = F.giveItem(at, itemId);
      if (itemId) {
        const cur = F.save.readPocket('items').find((x) => x.item_id === itemId)?.count ?? 0;
        F.save.setBagItem('items', itemId, cur - 1);
      }
      if (had) {
        const cur = F.save.readPocket('items').find((x) => x.item_id === had)?.count ?? 0;
        F.save.setBagItem('items', had, cur + 1);
      }
      render();
    } catch (e) { alertish(e); }
  }
}

/** Teach one of the TMs or HMs you own, if this species can legally learn it. */
function openTeach(at, mon) {
  const sp = S.SPECIES[String(mon.speciesId)];
  const known = new Set(sp?.tmhm ?? []);
  const owned = F.save.readPocket('tms_hms')
    .map((e) => ({ ...e, d: S.ITEMINFO?.[String(e.item_id)] }))
    .filter((e) => e.d?.tm);
  const usable = owned.filter((e) => known.has(e.d.tm));

  const overlay = el('div', { class: 'pk-modal', role: 'dialog', 'aria-modal': 'true' });
  const sheet = el('div', { class: 'pk-sheet' });
  overlay.append(sheet);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() { document.removeEventListener('keydown', onKey); overlay.remove(); }

  sheet.append(el('h3', {}, `Teach ${mon.species} a TM`),
    el('p', { class: 'pk-sub' },
      `${usable.length} of the ${owned.length} TMs and HMs you own can be taught to it. `
      + 'In Gen 5 a TM is reusable, so this does not use it up.'));

  const list = el('div', { class: 'pk-list' });
  for (const e of usable) {
    const mv = S.MOVES[e.d.move];
    const b = el('button', { class: 'pk-row' },
      el('span', { class: 'pk-noicon' }, e.d.tm.slice(0, 2)),
      el('span', { class: 'pk-body' },
        el('span', { class: 'pk-name' }, `${e.d.tm} ${e.d.move}`),
        el('span', { class: 'pk-sub2' }, mv
          ? `${mv.t} ${mv.c}${mv.p ? ` · ${mv.p} BP` : ''} · ${mv.pp} PP` : '')));
    b.onclick = () => {
      close();
      pickMoveSlot({ mon, moveName: e.d.move, S, onPick: (slot) => {
        try { F.teachMove(at, e.d.move_id, slot); render(); } catch (err) { alertish(err); }
      } });
    };
    list.append(b);
  }
  if (!usable.length) {
    list.append(el('p', { class: 'pk-empty' },
      owned.length ? `None of your ${owned.length} TMs can be taught to ${mon.species}.`
        : 'You do not own any TMs yet.'));
  }
  sheet.append(list);
  const cancel = el('button', { class: 'pk-btn' }, 'Cancel');
  cancel.onclick = close;
  sheet.append(el('div', { class: 'pk-foot' }, cancel));
  document.body.append(overlay);
}

// ------------------------------------------------------------- organize all
/**
 * Bulk box organisation, with the destructive option clearly separated.
 *
 * "Sort each box" never moves a Pokémon between boxes, which is what makes it
 * safe on a save whose boxes MEAN something -- teams in their own boxes, a
 * living dex across a run of five, a box of Pokémon actually caught. Order
 * inside a box is not load-bearing for any of that; box membership is.
 *
 * "Gather and regroup" does move them, and says how many before you commit.
 * It is the one that answers "put all the Grass types together", and the one
 * that will scatter a team box, so it gets a count and a warning rather than
 * a shrug.
 */
function openOrganize() {
  const state = { key: 'dex', mode: 'each', from: 0, to: Math.max(0, F.boxCapacity - 1) };

  const overlay = el('div', { class: 'fx-modal', role: 'dialog', 'aria-modal': 'true' });
  const sheet = el('div', { class: 'fx-sheet fx-narrow' });
  overlay.append(sheet);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() { document.removeEventListener('keydown', onKey); overlay.remove(); }

  const draw = () => {
    sheet.replaceChildren();
    sheet.append(el('h3', {}, 'Organize boxes'),
      el('div', { class: 'fx-sub' }, `${F.boxCapacity} boxes are visible in game`));

    const form = el('div', { class: 'fx-form' });
    const field = (label, control, span = false) =>
      el('div', { class: `fx-field${span ? ' fx-span' : ''}` }, el('label', {}, label), control);

    const key = select(Object.entries(SORT_LABELS), state.key);
    key.onchange = () => { state.key = key.value; draw(); };
    form.append(field('Sort by', key));

    const mode = select([['each', 'Sort each box separately'],
      ['regroup', 'Gather and regroup across boxes']], state.mode);
    mode.onchange = () => { state.mode = mode.value; draw(); };
    form.append(field('How', mode));

    const range = [];
    for (let n = 0; n < F.boxCapacity; n++) range.push([String(n), `Box ${n + 1}`]);
    if (state.mode === 'regroup') {
      const from = select(range, String(state.from));
      from.onchange = () => { state.from = Number(from.value); draw(); };
      const to = select(range, String(state.to));
      to.onchange = () => { state.to = Number(to.value); draw(); };
      form.append(field('From', from), field('To', to));
    }

    const boxes = state.mode === 'regroup'
      ? rangeBoxes(state.from, state.to) : F.visibleBoxes();

    if (state.mode === 'each') {
      const n = boxes.filter((b) => F.read(b).filter((x) => x.mon).length > 1).length;
      form.append(el('div', { class: 'fx-note' },
        `Sorts each of the ${n} box${n === 1 ? '' : 'es'} with more than one Pokémon, `
        + 'independently. Nothing moves between boxes, so which box a Pokémon lives in '
        + 'does not change — only the order inside it. One undo step for the lot.'));
    } else {
      const pv = F.regroupPreview(state.key, 1, { boxes });
      form.append(el('div', { class: pv.moving ? 'fx-note warn' : 'fx-note' },
        `Gathers all ${pv.total} Pokémon from Box ${boxes[0] + 1}–${boxes[boxes.length - 1] + 1}, `
        + `sorts them as one pool, and lays them back out in order. `
        + `${pv.moving} would end up in a different box.`
        + (pv.moving ? ' Anything organised BY box — a team, a living dex — gets scattered.' : '')));
    }

    const err = el('div', { class: 'fx-err' });
    const go = el('button', { class: 'fx-btn primary' },
      state.mode === 'each' ? 'Sort every box' : 'Gather and regroup');
    go.onclick = () => {
      try {
        if (state.mode === 'each') {
          const done = F.sortAllBoxes(state.key);
          close();
          view.sel.clear();
          render();
          alert(`Sorted ${done.length} box${done.length === 1 ? '' : 'es'} by `
            + `${SORT_LABELS[state.key].toLowerCase()}. Undo is one step.`);
        } else {
          const pv = F.regroupPreview(state.key, 1, { boxes });
          if (!confirm(`Move ${pv.moving} of ${pv.total} Pokémon between boxes?\n\n`
            + `Boxes ${boxes[0] + 1}–${boxes[boxes.length - 1] + 1} will be rewritten in `
            + `${SORT_LABELS[state.key].toLowerCase()} order. Undo is one step.`)) return;
          const r = F.regroupBoxes(state.key, 1, { boxes });
          close();
          view.sel.clear();
          render();
          alert(`Regrouped ${r.moved} Pokémon across ${r.boxes.length} boxes.`);
        }
      } catch (e) { err.textContent = e.message; }
    };
    const cancel = el('button', { class: 'fx-btn' }, 'Cancel');
    cancel.onclick = close;
    sheet.append(form, el('div', { class: 'fx-foot' }, go, cancel,
      el('span', { class: 'fx-spacer' }), err));
  };

  draw();
  document.body.append(overlay);
}

const rangeBoxes = (a, b) => {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
};

// ------------------------------------------------------------------ editor
/**
 * @param {object|null} mon     the record to edit, or null to create
 * @param {object} at           { loc, index } -- where it will live
 * @param {object} [opts]       `speciesId` pre-picks the species when creating,
 *                              which is how the Pokédex hands one over. It is
 *                              deliberately separate from `mon`: passing a
 *                              fake record instead would make `creating` false
 *                              and turn a create into an edit of a slot that
 *                              holds nothing.
 */
/**
 * "Build one in the Factory", arriving from the Pokédex.
 *
 * A ONE-SHOT MESSAGE, cleared the moment it is read, because the alternative
 * is a tab that reopens the same modal every time you visit it. It lands in
 * the first free box slot; if the PC is genuinely full it says so rather than
 * opening an editor that cannot save.
 */
function openHandoff() {
  let msg = null;
  try {
    const raw = localStorage.getItem(HANDOFF);
    if (raw) { msg = JSON.parse(raw); localStorage.removeItem(HANDOFF); }
  } catch { return; }
  const id = Number(msg?.speciesId);
  if (!Number.isInteger(id) || !S.SPECIES[String(id)]) return;

  for (let box = 0; box < BOX_COUNT; box += 1) {
    const free = F.firstFree(box);
    if (free == null) continue;
    view.box = box;
    render();
    openEditor(null, { loc: box, index: free }, { speciesId: id });
    return;
  }
  alert(`Every box is full, so there is nowhere to put a ${S.SPECIES[String(id)].name}. `
    + 'Free a slot and try again.');
}

/** The party's levels, for the level control's "match my party" preset. */
function partyLevels() {
  try { return F.read('party').filter((s) => s.mon).map((s) => s.mon.level); }
  catch { return []; }
}

function openEditor(mon, at, { speciesId = null } = {}) {
  const creating = !mon;
  const start = mon ?? defaultMon();
  // Per-dialog scratch for the shared pickers: which panel is open, what has
  // been typed into each search, and the one-shot focus token.
  const editView = { mq: '', iq: '', abq: '', mvSlot: null, focus: null };

  const state = {
    speciesId: (creating && speciesId) || start.speciesId,
    nickname: start.isNicknamed ? start.nickname : '',
    level: start.level ?? 50,
    natureId: start.natureId,
    abilityId: start.abilityId,
    gender: start.gender,
    shiny: start.shiny,
    itemId: start.itemId,
    moveIds: [0, 1, 2, 3].map((i) => start.moveIds[i] ?? 0),
    ivs: { ...start.ivs },
    evs: { ...start.evs },
    friendship: start.friendship ?? 255,
  };

  const overlay = el('div', { class: 'fx-modal', role: 'dialog', 'aria-modal': 'true' });
  const sheet = el('div', { class: 'fx-sheet' });
  overlay.append(sheet);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() { document.removeEventListener('keydown', onKey); overlay.remove(); }

  const draw = () => {
    const sp = S.SPECIES[String(state.speciesId)];
    const legalMoves = F.legalMoves(state.speciesId);
    const legalAbilities = new Set((sp?.ability_ids ?? []).filter(Boolean));
    sheet.replaceChildren();

    // A sprite beside the fields, because picking a species out of a 649-long
    // dropdown by name alone is miserable.
    //
    // The shiny state gets a gold ring and a badge rather than recoloured
    // art: the wiki clone ships ONE sprite per species and no shiny variants,
    // so a hue-shifted fake would be inventing colours the game does not use.
    // This says "shiny" without pretending to show you what it looks like.
    const art = el('div', { class: `fx-art${state.shiny ? ' shiny' : ''}` },
      S.SPRITE[sp?.name] ? el('img', { src: S.SPRITE[sp.name], alt: sp.name }) : el('span', {}, '?'),
      state.shiny ? el('b', {}, '◆ shiny') : null);
    sheet.append(el('div', { class: 'fx-head' }, art, el('div', {},
      el('h3', {}, creating ? 'Create a Pokémon' : `Edit ${sp?.name ?? '?'}`),
      el('div', { class: 'fx-sub' },
        `${locLabel(at.loc)} · slot ${at.index + 1} · ${(sp?.types ?? []).join(' / ')}`))));

    const form = el('div', { class: 'fx-form' });
    const field = (label, control, span = false) =>
      el('div', { class: `fx-field${span ? ' fx-span' : ''}` }, el('label', {}, label), control);

    // ---- identity
    const speciesSel = select(
      Object.entries(S.SPECIES).map(([id, v]) => [id, `${v.name}  #${id}`]), String(state.speciesId));
    speciesSel.onchange = () => {
      state.speciesId = Number(speciesSel.value);
      const ns = S.SPECIES[String(state.speciesId)];
      // Gender is constrained by the species' ratio, so a species change can
      // invalidate it. Snap to something legal rather than writing nonsense.
      state.gender = ns.ratio === 255 ? 'genderless' : ns.ratio === 254 ? 'female'
        : ns.ratio === 0 ? 'male' : state.gender;
      if (state.gender === 'genderless' && ns.ratio !== 255) state.gender = 'male';
      draw();
    };
    form.append(field('Species', speciesSel));

    const nick = el('input', { type: 'text', maxLength: 10, value: state.nickname,
      placeholder: sp?.name ?? '' });
    nick.oninput = () => { state.nickname = nick.value; };

    // THE SAME CONTROLS THE TEAM BUILDER USES. This sheet and the Builder's
    // slot editor take the same state, and they had drifted badly -- a nature
    // from a 25-row dropdown here, the game's own 5x5 chart there. See
    // app/js/specform.js for why they are one implementation now.
    form.append(SF.identityRow({ state, S, redraw: draw }));
    form.append(el('div', { class: 'fx-sec' }, 'Level'),
      SF.levelControl({ state, redraw: draw, partyLevels: partyLevels() }));
    form.append(el('div', { class: 'fx-sec' }, 'Nature'),
      SF.natureChart({ state, S, redraw: draw, natureNames: NATURES }));
    form.append(el('div', { class: 'fx-sec' }, 'Ability'),
      SF.abilityPicker({ state, S, view: editView, redraw: draw,
        legalAb: legalAbilities }));
    form.append(el('div', { class: 'fx-sec' }, 'Held item'),
      SF.itemPicker({ state, S, view: editView, redraw: draw,
        heldFirst: new Set(S.HELD_INTEREST ?? []) }));

    form.append(el('div', { class: 'fx-sec' }, 'Moves'),
      SF.movePicker({ state, S, view: editView, redraw: draw, legalMoves }));

    // ---- IVs / EVs
    // The same presets the Team Builder offers, from the same place.
    const mk2 = (label, tip, fn) => {
      const b = el('button', { class: 'fx-btn', type: 'button', title: tip }, label);
      b.onclick = fn;
      return b;
    };
    const evTotal = STAT_KEYS.reduce((a2, k) => a2 + state.evs[k], 0);
    form.append(SF.spreadBlock({
      state,
      redraw: draw,
      extraIv: SF.ivPresets(state, draw, mk2),
      extraEv: SF.evPresets(state, draw, mk2),
    }));

    // ---- notes
    if (evTotal > EV_CAP_TOTAL) {
      form.append(el('div', { class: 'fx-note warn' },
        el('b', {}, 'Heads up: '),
        `${evTotal} EVs is past the ${EV_CAP_TOTAL} the game hands out. Gen 5 reads the stored `
        + 'bytes directly, so it works exactly as written — a legitimately-raised Pokémon just '
        + 'could not have it. ',
        el('i', {}, 'I’m not your mother, though. Do it if you want.')));
    }
    const illegalMoves = state.moveIds.filter((m) => m && !legalMoves.has(m));
    const abilIllegal = state.abilityId && !legalAbilities.has(state.abilityId);
    if (illegalMoves.length || abilIllegal) {
      form.append(el('div', { class: 'fx-note' },
        el('b', {}, 'Heads up: '),
        [abilIllegal ? `${ABILITIES[state.abilityId]} is not an ability ${sp?.name} can legally have.` : null,
          illegalMoves.length ? `${sp?.name} cannot legally learn ${illegalMoves.map((m) => S.MOVEBYID[String(m)]).join(', ')}.` : null,
          'Gen 5 stores both in the record and reads them directly, so the game honours it and it works in battle.',
        ].filter(Boolean).join(' '), ' ',
        el('i', {}, 'I’m not your mother, though — do it if you want. Building deliberately '
          + 'illegal Pokémon is half the point of this tab.')));
    }
    form.append(el('div', { class: 'fx-note' },
      `Typing is fixed at ${(sp?.types ?? []).join(' / ') || '?'} — it lives in the ROM's species table, not in the save, `
      + 'so no save edit can change it.'));

    sheet.append(form);

    const err = el('div', { class: 'fx-err' });
    const save = el('button', { class: 'fx-btn primary' }, creating ? 'Create' : 'Save changes');
    save.onclick = () => {
      try {
        F.write(at, {
          species: state.speciesId,
          level: state.level,
          ability: state.abilityId,
          nature: state.natureId,
          moves: state.moveIds.filter(Boolean),
          item_id: state.itemId,
          evs: state.evs,
          ivs: state.ivs,
          gender: state.gender,
          shiny: state.shiny,
          nick: state.nickname.trim() || null,
          friendship: state.friendship,
        });
        if (typeof at.loc === 'number') view.box = at.loc;
        view.sel = new Set([KEY(at.loc, at.index)]);
        close();
        render();
      } catch (e) {
        err.textContent = e.message;
      }
    };
    const cancel = el('button', { class: 'fx-btn' }, 'Cancel');
    cancel.onclick = close;
    sheet.append(el('div', { class: 'fx-foot' }, save, cancel, el('span', { class: 'fx-spacer' }), err));
  };

  draw();
  document.body.append(overlay);
}

function defaultMon() {
  const src = F.templateSource();
  const first = src ? F.read(src.loc)[src.index].mon : null;
  return {
    speciesId: 1, isNicknamed: false, nickname: '', level: 50,
    natureId: 0, abilityId: (S.SPECIES['1'].ability_ids ?? [65])[0], gender: 'male',
    shiny: false, itemId: 0, moveIds: [33, 0, 0, 0],
    ivs: Object.fromEntries(STAT_KEYS.map((k) => [k, 31])),
    evs: Object.fromEntries(STAT_KEYS.map((k) => [k, 0])),
    friendship: first?.friendship ?? 255,
  };
}

function numRow(obj, min, max, after) {
  const row = el('div', { class: 'fx-nums' });
  for (const k of STAT_KEYS) {
    const inp = el('input', { type: 'number', min, max, value: String(obj[k]) });
    inp.oninput = () => { obj[k] = clamp(inp.value, min, max); after(); };
    row.append(el('div', { class: 'fx-field' }, el('label', {}, STAT_LABEL[k]), inp));
  }
  return row;
}

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
const alertish = (e) => {
  if (e instanceof FactoryError) alert(e.message);
  else { console.error(e); alert(`Something went wrong: ${e.message}`); }
};

/**
 * Install straight over the save file, via ./serve.
 *
 * The server does the dangerous part and does it in this order: refuse if
 * melonDS is running, validate the bytes, back up the current save, write a
 * temp file beside the target, re-validate it, move it into place, re-read
 * it, and restore the backup if anything is wrong. The reply names the backup
 * file, which is what gets shown here -- an install whose backup you cannot
 * name is not one worth trusting.
 */
// -------------------------------------------------------------------- tab
export default {
  id: 'factory',
  label: 'Factory',
  needsSave: true,

  mount(panel, ctx) {
    S = ctx.S;
    CONFIG = ctx.config ?? null;
    CTX = ctx;
    // Shared with the Team Builder: one working copy, one undo stack, one
    // dirty flag. Falls back to its own only when mounted standalone (tests).
    F = ctx.factory ?? new Factory(ctx.save, S);
    NUZ = ctx.nuz ?? null;
    try { WALLPAPERS = F.save.boxWallpapers(); } catch { WALLPAPERS = []; }
    let hide = false;
    try { hide = localStorage.getItem(BATTLE_HIDDEN) === '1'; } catch { /* private mode */ }
    view = { box: 0, sel: new Set(), anchor: null, moving: null, hideBattle: hide };
    root = el('div', { class: 'fx' });
    panel.append(root);
    this._esc = (e) => { if (e.key === 'Escape' && view.moving) { view.moving = null; render(); } };
    document.addEventListener('keydown', this._esc);
    render();
    openHandoff();
  },

  unmount() {
    if (this._esc) document.removeEventListener('keydown', this._esc);
    document.querySelector('.fx-modal')?.remove();
    document.querySelector('.pk-modal')?.remove();
    root?.remove?.();
    F = null; root = null;
  },
};
