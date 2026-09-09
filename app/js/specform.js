/**
 * specform.js -- the controls for describing ONE Pokémon. No tab owns them.
 *
 * =========================================================================
 * WHY THIS EXISTS
 * =========================================================================
 * There were two editors for one record. The Team Builder's slot editor and
 * the Factory's edit/create sheet take the SAME state -- species, nickname,
 * level, nature, ability, gender, shininess, held item, four moves, IVs, EVs
 * -- and they had drifted badly: the Builder grew a nature chart, chip-based
 * abilities and searchable move and item pickers, while the Factory still
 * asked for a nature from a 25-row dropdown and a move from a 559-row one.
 * Neither had gender or a nickname until the Builder got them, which is the
 * drift showing from the other side.
 *
 * That is the same failure the battle tab avoids by HOSTING
 * `sheet_template.html` rather than reimplementing it. So these are the
 * controls, once, and both editors compose them.
 *
 * =========================================================================
 * THE PREFIX IS `sf-`, NOT `tb-` OR `fx-`
 * =========================================================================
 * A shared component wearing one tab's prefix is a lie about where it lives,
 * and the next person to change `tb-natcell` would have no way to know the
 * Factory renders it too. Their stylesheet is `app/css/specform.css`, loaded
 * app-wide like every other.
 *
 * =========================================================================
 * WHAT A CONTROL IS
 * =========================================================================
 * A function of `(ctx)` returning an element, where `ctx` carries:
 *
 *   state      the spec being edited, mutated in place
 *   S          app/data/static.json
 *   view       per-dialog scratch (open panels, search terms, focus token)
 *   redraw()   rebuild the whole form -- the EXPENSIVE one
 *   S.SPECIES  ...and everything else read off S
 *
 * Two habits every control here follows, both learned the hard way:
 *
 *   NEVER REDRAW ON `input`. A rebuild destroys the element the event fired
 *   on, so a slider snaps to where you clicked and a search box loses focus
 *   and the caret after every letter. Cheap update on `input`, `redraw()` on
 *   `change`; redraw the LIST, never the box.
 *
 *   A PICKER CLOSES ONCE IT HAS DONE ITS JOB, and opens ready to type. A list
 *   that is finished is furniture, and a search box you have to click into is
 *   a search box with an extra step.
 */

import { ABILITIES, natureEffect, NATURE_STAT_ORDER } from '../../js/tables.js';

export const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
export const STAT_LABEL = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') { if (v != null) n.className = v; }
    else if (k === 'checked' || k === 'value') n[k] = v;
    else if (k.startsWith('aria-') || k === 'role' || k === 'type' || k === 'title'
      || k === 'placeholder' || k === 'maxLength' || k === 'rows' || k === 'min'
      || k === 'max' || k === 'alt' || k === 'src' || k === 'loading') n.setAttribute(k, v);
    else n[k] = v;
  }
  n.append(...kids.filter((x) => x != null));
  return n;
};
export { el as sfEl };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));

/**
 * A one-shot "focus this on the next render".
 *
 * Not a `focus()` on every draw: the form redraws while you are typing in
 * other fields, and stealing the caret out of the nickname box because the
 * move list happens to be open would be its own bug.
 */
export function armFocus(view, id, clearKey) {
  view.focus = id;
  if (clearKey) view[clearKey] = '';
}
function takeFocus(view, id, node) {
  if (view.focus !== id || !node) return;
  view.focus = null;
  node.focus();
}

// ============================================================ identity
/**
 * Nickname, gender and shininess -- the three things that make a spec a
 * PARTICULAR Pokémon rather than a species with a spread, so they sit
 * together and next to the sprite.
 */
export function identityRow({ state, S, redraw }) {
  const sp = S.SPECIES[String(state.speciesId)];
  const row = el('div', { class: 'sf-idrow sf-span' });

  const nick = el('input', { class: 'sf-nick', type: 'text', maxLength: 10,
    placeholder: sp?.name ?? 'Nickname' });
  nick.value = state.nickname ?? '';
  // Ten characters, like the game. Refusing a longer one beats truncating it
  // silently at save time.
  nick.oninput = () => { state.nickname = nick.value.slice(0, 10); };
  row.append(el('label', { class: 'sf-idfield' }, el('span', {}, 'Nickname'), nick));

  row.append(el('div', { class: 'sf-idfield' }, el('span', {}, 'Gender'),
    genderChips({ state, S, redraw })));
  row.append(el('div', { class: 'sf-idfield' }, el('span', {}, 'Shiny'),
    shinyToggle({ state, redraw })));
  return row;
}

/**
 * Only what the species' ratio allows.
 *
 * 255 is genderless, 254 always female, 0 always male. Offering a gender the
 * species cannot have would be an illegal build with no upside -- unlike an
 * ability, gender buys you nothing, so this is the one field where the editor
 * does not bother offering the illegal option.
 */
export function legalGenders(ratio) {
  if (ratio === 255) return ['genderless'];
  if (ratio === 254) return ['female'];
  if (ratio === 0) return ['male'];
  return ['male', 'female'];
}

/** Fix a gender the species cannot have, after a species change. */
export function correctGender(state, S) {
  const r = S.SPECIES[String(state.speciesId)]?.ratio;
  const ok = legalGenders(r);
  if (ok.length === 1) { state.gender = ok[0]; return; }
  if (!ok.includes(state.gender)) state.gender = null;
}

function genderChips({ state, S, redraw }) {
  const ok = legalGenders(S.SPECIES[String(state.speciesId)]?.ratio);
  const wrap = el('div', { class: 'sf-genders' });
  const chip = (val, label) => {
    const on = (state.gender ?? null) === val;
    const b = el('button', { class: `sf-genchip${on ? ' on' : ''}`, type: 'button',
      'aria-pressed': String(on) }, label);
    b.onclick = () => { state.gender = val; redraw(); };
    return b;
  };
  // `null` means "let the PID decide", which is what a wild one does.
  if (ok.length > 1) wrap.append(chip(null, 'Either'));
  for (const g of ok) {
    wrap.append(chip(g, g === 'male' ? '♂ Male' : g === 'female' ? '♀ Female' : 'Genderless'));
  }
  return wrap;
}

function shinyToggle({ state, redraw }) {
  const b = el('button', { class: `sf-shiny${state.shiny ? ' on' : ''}`, type: 'button',
    'aria-pressed': String(Boolean(state.shiny)),
    title: 'Shininess is derived from the trainer ids and the PID, so this is written '
      + 'by rebuilding the PID — a real property of the record, not a flag.' },
  el('b', {}, '◆'), el('span', {}, state.shiny ? 'Shiny' : 'Not shiny'));
  b.onclick = () => { state.shiny = !state.shiny; redraw(); };
  return b;
}

// =============================================================== level
/**
 * A range you can see, plus the answers people actually want.
 *
 * A bare number box makes you think in keystrokes about a value you think
 * about in RELATION to things -- your party, the next gym. "Match my party"
 * is the real answer and a number box could never offer it.
 */
export function levelControl({ state, redraw, partyLevels = [] }) {
  const wrap = el('div', { class: 'sf-lvl sf-span' });
  const num = el('input', { class: 'sf-lvlnum', type: 'number', min: 1, max: 100,
    value: String(state.level) });
  const bar = el('input', { class: 'sf-lvlbar', type: 'range', min: 1, max: 100,
    value: String(state.level) });
  // Cheap on `input`, redraw on `change` -- the chips depend on the value.
  const sync = (v, live) => {
    state.level = clamp(v, 1, 100);
    if (num.value !== String(state.level)) num.value = String(state.level);
    if (bar.value !== String(state.level)) bar.value = String(state.level);
    if (!live) redraw();
  };
  num.oninput = () => sync(num.value, true);
  num.onchange = () => sync(num.value, false);
  bar.oninput = () => sync(bar.value, true);
  bar.onchange = () => sync(bar.value, false);

  const chips = el('div', { class: 'sf-lvlchips' });
  const preset = (label, v, tip) => {
    if (v == null) return;
    const b = el('button', { class: `sf-lvlchip${state.level === v ? ' on' : ''}`,
      type: 'button', title: tip }, label);
    b.onclick = () => sync(v, false);
    chips.append(b);
  };
  preset('5', 5, 'A freshly caught early-route Pokémon');
  preset('50', 50, 'The usual level for comparing builds');
  preset('100', 100, 'Maxed');
  const lv = partyLevels.filter(Number.isFinite);
  if (lv.length) {
    preset(`Party (${Math.max(...lv)})`, Math.max(...lv),
      'Match the highest level in your party right now');
  }
  wrap.append(el('div', { class: 'sf-lvlrow' }, el('b', {}, 'Lv'), num, bar), chips);
  return wrap;
}

// ============================================================== nature
/**
 * The game's own 5x5 chart, not a list of 25 names.
 *
 * A nature IS a pair of stats and the id encodes exactly that: `id/5` is the
 * raised stat and `id%5` the lowered one, both indexing NATURE_STAT_ORDER.
 * Laying it out this way makes "+Speed, −Attack" one glance instead of
 * recalling that this is called Timid, and puts the five neutral natures on
 * the diagonal where they belong.
 *
 * NATURE_STAT_ORDER is imported rather than restated: a second copy of the
 * order that decides which nature every cell writes is a bug waiting.
 */
export function natureChart({ state, S, redraw, natureNames }) {
  const names = natureNames ?? S.NATURES ?? [];
  const wrap = el('div', { class: 'sf-nat sf-span' });
  const grid = el('div', { class: 'sf-natgrid' });
  grid.append(el('span', { class: 'sf-natcorner' }, ''));
  for (const k of NATURE_STAT_ORDER) {
    grid.append(el('span', { class: 'sf-nathead' }, `−${STAT_LABEL[k]}`));
  }
  for (let up = 0; up < 5; up++) {
    grid.append(el('span', { class: 'sf-nathead sf-natside' },
      `+${STAT_LABEL[NATURE_STAT_ORDER[up]]}`));
    for (let down = 0; down < 5; down++) {
      const id = up * 5 + down;
      const neutral = up === down;
      const on = state.natureId === id;
      const b = el('button', {
        class: `sf-natcell${on ? ' on' : ''}${neutral ? ' neutral' : ''}`,
        type: 'button',
        title: neutral ? `${names[id]} — no effect on any stat`
          : `${names[id]} — +${STAT_LABEL[NATURE_STAT_ORDER[up]]}, `
            + `−${STAT_LABEL[NATURE_STAT_ORDER[down]]}`,
      }, names[id] ?? `#${id}`);
      b.onclick = () => { state.natureId = id; redraw(); };
      grid.append(b);
    }
  }
  const e = natureEffect(state.natureId);
  wrap.append(grid, el('p', { class: 'sf-hint' },
    el('b', {}, names[state.natureId] ?? '—'), e
      ? ` — 10% more ${STAT_LABEL[e.up]}, 10% less ${STAT_LABEL[e.down]}.`
      : ' — neutral: every stat as rolled.'));
  return wrap;
}

// ============================================================= ability
/**
 * The two or three a species can legally have, as buttons with their
 * descriptions; the other 162 behind a search you open deliberately.
 *
 * Illegal abilities are FLAGGED, NEVER BLOCKED. Gen 5 reads the ability byte
 * directly, so writing one the species cannot have works, and doing it is
 * something people come here for.
 */
export function abilityPicker({ state, S, view, redraw, legalAb }) {
  const wrap = el('div', { class: 'sf-pick sf-pick-ability sf-span' });
  const chips = el('div', { class: 'sf-abchips' });
  for (const id of [...legalAb].filter(Boolean)) {
    const on = state.abilityId === id;
    const c = el('button', { class: `sf-abchip${on ? ' on' : ''}`, type: 'button' },
      el('b', {}, ABILITIES[id] ?? `#${id}`),
      el('span', {}, S.ABIL?.[ABILITIES[id]] ?? ''));
    c.onclick = () => { state.abilityId = on ? 0 : id; redraw(); };
    chips.append(c);
  }
  const anyOn = !state.abilityId;
  const any = el('button', { class: `sf-abchip${anyOn ? ' on' : ''}`, type: 'button' },
    el('b', {}, 'Leave as is'),
    el('span', {}, 'Do not specify an ability'));
  any.onclick = () => { state.abilityId = 0; redraw(); };
  chips.append(any);
  wrap.append(chips);

  if (state.abilityId && !legalAb.has(state.abilityId)) {
    wrap.append(el('p', { class: 'sf-abnow' },
      el('b', {}, ABILITIES[state.abilityId] ?? `#${state.abilityId}`),
      ' — written in. ', el('i', {}, 'This species cannot legally have it; Gen 5 reads '
        + 'the ability byte directly, so the game honours it.')));
  }

  const more = el('button', { class: `sf-chip${view.abAll ? ' on' : ''}`, type: 'button' },
    view.abAll ? 'Hide the other abilities' : `Write in any of the ${ABILITIES.length - 1}…`);
  more.onclick = () => {
    view.abAll = !view.abAll;
    if (view.abAll) armFocus(view, 'ability', 'abq');
    redraw();
  };
  wrap.append(more);

  if (view.abAll) {
    const aq = el('input', { class: 'sf-search', type: 'text', value: view.abq ?? '',
      placeholder: 'Search abilities…' });
    const list = el('div', { class: 'sf-list' });
    const fill = () => {
      list.replaceChildren();
      const term = (view.abq ?? '').trim().toLowerCase();
      const hits = ABILITIES.map((n, i) => [i, n])
        .filter(([i, n]) => i > 0 && (!term || n.toLowerCase().includes(term))).slice(0, 200);
      if (!hits.length) list.append(el('p', { class: 'sf-none' }, 'Nothing matches.'));
      for (const [i, n] of hits) {
        const b = el('button', {
          class: `sf-row sf-row2${state.abilityId === i ? ' on' : ''}`
            + `${legalAb.has(i) ? '' : ' illegal'}`,
          type: 'button' },
        el('b', {}, n), el('span', { class: 'sf-desc' }, S.ABIL?.[n] ?? ''));
        b.onclick = () => { state.abilityId = i; redraw(); };
        list.append(b);
      }
    };
    fill();
    // The LIST, not the box.
    aq.oninput = () => { view.abq = aq.value; fill(); };
    wrap.append(aq, list);
    takeFocus(view, 'ability', aq);
  }
  return wrap;
}

// =========================================================== held item
export function itemPicker({ state, S, view, redraw, heldFirst = new Set() }) {
  const wrap = el('div', { class: 'sf-pick sf-pick-item sf-span' });
  const cur = state.itemId ? (S.ITEMS[String(state.itemId)] ?? `#${state.itemId}`) : null;

  const now = el('div', { class: `sf-now${cur ? '' : ' empty'}` },
    el('b', {}, cur ?? 'Nothing held'),
    el('u', {}, cur ? (S.ITEMINFO?.[String(state.itemId)]?.desc ?? '') : ''));
  if (cur) {
    const x = el('button', { class: 'sf-x', type: 'button', title: 'Hold nothing' }, '×');
    x.onclick = () => { state.itemId = 0; redraw(); };
    now.append(x);
  }
  wrap.append(now);

  const searching = Boolean((view.iq ?? '').trim());
  // A picker that has done its job gets out of the way.
  if (cur && !view.itemOpen && !searching) {
    const change = el('button', { class: 'sf-btn', type: 'button' }, 'Change item');
    change.onclick = () => { view.itemOpen = true; armFocus(view, 'item', 'iq'); redraw(); };
    wrap.append(change);
    return wrap;
  }

  const hint = el('p', { class: 'sf-hint' }, '');
  const iq = el('input', { class: 'sf-search', type: 'text', value: view.iq ?? '',
    placeholder: 'Search items…' });
  const list = el('div', { class: 'sf-list' });
  const fill = () => {
    list.replaceChildren();
    const term = (view.iq ?? '').trim().toLowerCase();
    // With no search, the items worth holding -- not item id 1 onwards.
    const hits = Object.entries(S.ITEMS)
      .filter(([id, n]) => Number(id) > 0
        && (term ? n.toLowerCase().includes(term) : heldFirst.has(n)))
      .slice(0, 250);
    if (!hits.length) list.append(el('p', { class: 'sf-none' }, 'Nothing matches.'));
    for (const [id, n] of hits) {
      const b = el('button', {
        class: `sf-row sf-row2${state.itemId === Number(id) ? ' on' : ''}`, type: 'button' },
      el('b', {}, n), el('span', { class: 'sf-desc' }, S.ITEMINFO?.[id]?.desc ?? ''));
      b.onclick = () => {
        state.itemId = state.itemId === Number(id) ? 0 : Number(id);
        view.itemOpen = false;    // one pick, job done
        view.iq = '';             // ...and the search with it
        redraw();
      };
      list.append(b);
    }
    hint.textContent = term
      ? `${hits.length} matching item${hits.length === 1 ? '' : 's'}`
      : `The ones people actually hold. Search to reach any of the ${Object.keys(S.ITEMS).length}.`;
  };
  fill();
  iq.oninput = () => { view.iq = iq.value; fill(); };
  wrap.append(hint, iq, list);
  takeFocus(view, 'item', iq);
  return wrap;
}

// =============================================================== moves
/**
 * Four slots you can aim at, over a searchable list.
 *
 * SLOT ORDER IS NOT COSMETIC -- the battle sheet reads slot 1 as the lead --
 * so "fill THIS one" has to be expressible. Clicking a slot arms it; the next
 * move picked lands there.
 */
export function movePicker({ state, S, view, redraw, legalMoves }) {
  const wrap = el('div', { class: 'sf-pick sf-pick-moves sf-span' });

  const slots = el('div', { class: 'sf-mvslots' });
  for (let i = 0; i < 4; i++) {
    const id = state.moveIds[i];
    const name = id ? (S.MOVEBYID[String(id)] ?? `#${id}`) : null;
    const mv = name ? S.MOVES[name] : null;
    const armed = (view.mvSlot ?? -1) === i;
    const cell = el('button', {
      class: `sf-mvslot${id ? '' : ' empty'}${armed ? ' armed' : ''}`
        + `${id && !legalMoves.has(id) ? ' illegal' : ''}`,
      type: 'button',
      title: armed ? 'Armed — the next move you pick goes here'
        : `Fill move ${i + 1}. Click, then pick from the list below.`,
    },
    el('b', {}, name ?? `Move ${i + 1}`),
    mv ? el('span', { class: `sf-t t-${mv.t}` }, mv.t) : null,
    mv ? el('u', {}, `${mv.p || '—'}/${mv.acc || '—'}`) : null);
    cell.onclick = () => {
      if (armed) { view.mvSlot = null; redraw(); return; }
      view.mvSlot = i;
      armFocus(view, 'moves', 'mq');
      redraw();
    };
    if (id) {
      const x = el('button', { class: 'sf-x', type: 'button', title: 'Clear this slot' }, '×');
      x.onclick = (e) => { e.stopPropagation(); state.moveIds[i] = 0; redraw(); };
      cell.append(x);
    }
    slots.append(cell);
  }
  wrap.append(slots);

  const full = state.moveIds.every(Boolean);
  const searching = Boolean((view.mq ?? '').trim());
  if (full && !Number.isInteger(view.mvSlot) && !searching) {
    const change = el('button', { class: 'sf-btn', type: 'button' }, 'Change a move');
    change.onclick = () => { view.mvSlot = 0; armFocus(view, 'moves', 'mq'); redraw(); };
    wrap.append(el('p', { class: 'sf-hint' },
      'All four are set. Click one above to replace it.'), change);
    return wrap;
  }

  const mq = el('input', { class: 'sf-search', type: 'text', value: view.mq ?? '',
    placeholder: 'Search moves by name or type…' });
  const legalOnly = el('button', { class: `sf-chip${view.mvAll ? '' : ' on'}`, type: 'button',
    title: 'Only the moves this species can legally learn. Gen 5 reads the move bytes '
      + 'directly, so an illegal one still works — it is flagged, never blocked.' },
  view.mvAll ? `All ${Object.keys(S.MOVEBYID).length}` : `Legal only (${legalMoves.size})`);
  legalOnly.onclick = () => { view.mvAll = !view.mvAll; redraw(); };
  wrap.append(el('div', { class: 'sf-mvbar' }, mq, legalOnly));

  const list = el('div', { class: 'sf-list' });
  const fill = () => {
    list.replaceChildren();
    const term = (view.mq ?? '').trim().toLowerCase();
    const rows = Object.entries(S.MOVEBYID)
      .filter(([id, n]) => (view.mvAll || legalMoves.has(Number(id)))
        && (!term || n.toLowerCase().includes(term)
          || (S.MOVES[n]?.t ?? '').toLowerCase() === term))
      .sort((a, b) => (S.MOVES[b[1]]?.p ?? 0) - (S.MOVES[a[1]]?.p ?? 0)
        || a[1].localeCompare(b[1]))
      .slice(0, 300);
    if (!rows.length) list.append(el('p', { class: 'sf-none' }, 'Nothing matches.'));
    for (const [id, n] of rows) {
      const mv = S.MOVES[n] ?? null;
      const has = state.moveIds.includes(Number(id));
      const b = el('button', {
        class: `sf-row sf-row4${has ? ' on' : ''}${legalMoves.has(Number(id)) ? '' : ' illegal'}`,
        type: 'button',
        title: legalMoves.has(Number(id)) ? '' : `${n} is not in this species' learnset`,
      },
      el('b', {}, n),
      el('span', { class: `sf-t t-${mv?.t ?? ''}` }, mv?.t ?? '—'),
      el('em', {}, mv?.c ?? ''),
      el('u', {}, `${mv?.p || '—'} / ${mv?.acc || '—'}`));
      b.onclick = () => {
        const at = state.moveIds.indexOf(Number(id));
        const slot = view.mvSlot;
        if (Number.isInteger(slot)) {
          // An armed slot wins over "it is already on the team": moving a move
          // from slot 4 to slot 1 is a real thing to want.
          if (at >= 0 && at !== slot) state.moveIds[at] = 0;
          state.moveIds[slot] = state.moveIds[slot] === Number(id) ? 0 : Number(id);
          view.mvSlot = null;
        } else if (at >= 0) {
          state.moveIds[at] = 0;          // toggle off
        } else {
          const free = state.moveIds.indexOf(0);
          if (free < 0) return;
          state.moveIds[free] = Number(id);
        }
        redraw();
      };
      list.append(b);
    }
  };
  fill();
  mq.oninput = () => { view.mq = mq.value; fill(); };
  wrap.append(el('p', { class: 'sf-hint' },
    Number.isInteger(view.mvSlot)
      ? `Move ${view.mvSlot + 1} is armed — the next one you pick goes there.`
      : 'Click a move to add it, or click a slot above to choose where it goes.'),
  list);
  takeFocus(view, 'moves', mq);
  return wrap;
}

// ====================================================== IVs, EVs, meters
/**
 * Six stats as sliders you can actually drag, the number typeable beside.
 *
 * `input` fires continuously and does the cheap thing; `change` fires once on
 * release and pays for the redraw. Rebuilding on `input` destroys the element
 * under the pointer and the drag dies after one step.
 *
 * `cap(k)` -- when given -- is read at the MOMENT OF THE EDIT, because it
 * depends on what the other five stats hold right now.
 */
export function statBars(obj, max, after, { nature = null, onLive = null, cap = null } = {}) {
  const eff = nature != null ? natureEffect(nature) : null;
  const row = el('div', { class: 'sf-bars' });
  for (const k of STAT_KEYS) {
    const mark = eff && eff.up === k ? ' up' : eff && eff.down === k ? ' down' : '';
    const num = el('input', { class: 'sf-barnum', type: 'number', min: 0, max,
      value: String(obj[k]) });
    const rng = el('input', { class: 'sf-barrange', type: 'range', min: 0, max,
      value: String(obj[k]) });
    const set = (v, live) => {
      const lid = cap ? Math.min(max, cap(k)) : max;
      obj[k] = Math.min(clamp(v, 0, max), lid);
      if (num.value !== String(obj[k])) num.value = String(obj[k]);
      if (rng.value !== String(obj[k])) rng.value = String(obj[k]);
      if (live) onLive?.();
      else after();
    };
    rng.oninput = () => set(rng.value, true);
    rng.onchange = () => set(rng.value, false);
    num.oninput = () => set(num.value, true);
    num.onchange = () => set(num.value, false);
    row.append(
      el('span', { class: `sf-barlab${mark}` }, STAT_LABEL[k]
        + (mark === ' up' ? ' ▲' : mark === ' down' ? ' ▼' : '')),
      rng, num);
  }
  return row;
}

/**
 * How much of the 510 is spent.
 *
 * IT WARNS, IT DOES NOT BLOCK -- unless a rule you chose says otherwise. The
 * app writes illegal abilities and illegal moves on purpose; an EV spread is
 * the same kind of byte.
 */
export function evMeter(total, capped = false) {
  const left = 510 - total;
  const over = left < 0;
  const pct = Math.min(100, Math.round((total / 510) * 100));
  return el('div', { class: `sf-meter sf-evmeter${over ? ' over' : ''}${capped ? ' capped' : ''}` },
    el('span', { class: 'sf-meterbar' }, el('i', { style: `width:${pct}%` })),
    el('b', {}, over ? `${-left} over` : `${left} left`),
    el('span', {}, `${total} of 510`),
    over
      ? el('em', {}, 'Impossible in a real game — 510 is the most any Pokémon can hold. '
        + 'It will still be written, and the game will read it.')
      : (capped
        ? el('em', { class: 'lock' }, '⛓ Your nuzlocke rules cap this at 510 — legal '
          + 'spreads only.')
        : null));
}

/** 186 is six 31s. Worth knowing, and it squares the two spread columns. */
export function ivMeter(total) {
  const pct = Math.round((total / 186) * 100);
  return el('div', { class: 'sf-meter sf-ivmeter' },
    el('span', { class: 'sf-meterbar' }, el('i', { style: `width:${pct}%` })),
    el('b', {}, total === 186 ? 'perfect' : `${186 - total} off perfect`),
    el('span', {}, `${total} of 186`));
}

/**
 * The spread presets both editors want.
 *
 * These live here rather than in each caller because they are facts about the
 * GAME, not about a tab: 31 is a perfect IV, a wild Pokémon rolls each one
 * independently, 252/252/4 is the standard split, and a Trick Room build wants
 * zero Speed. The Factory had "Speed 0" and the Builder did not, which is the
 * two-editors problem in miniature.
 *
 * `maxOut` is deliberately an illegal spread. The app flags rather than
 * blocks, and 255 across the board is the fastest way to see what a Pokémon
 * could theoretically do -- so it is offered, and closed only by the nuzlocke
 * rule that closes every other impossible spread.
 */
export function ivPresets(state, redraw, mk) {
  return [
    mk('All 31', 'A perfect spread', () => {
      for (const k of STAT_KEYS) state.ivs[k] = 31;
      redraw();
    }),
    mk('Trick Room', 'Perfect everywhere except Speed, which goes to 0 — under Trick '
      + 'Room the slowest Pokémon moves first, so 0 Speed is the build, not a mistake',
    () => {
      for (const k of STAT_KEYS) state.ivs[k] = 31;
      state.ivs.spe = 0;
      redraw();
    }),
    mk('Random (wild)',
      'Each IV rolled independently 0–31, the way a wild encounter generates them. '
      + 'Gen 5 has no floor and no guaranteed-perfect count, unlike the later games.',
      () => {
        for (const k of STAT_KEYS) state.ivs[k] = Math.floor(Math.random() * 32);
        redraw();
      }),
  ];
}

export function evPresets(state, redraw, mk, { capped = false } = {}) {
  const spread = (a, b, label) => mk(label,
    `252 ${STAT_LABEL[a]} / 252 ${STAT_LABEL[b]} / 4 HP — the standard split`,
    () => {
      for (const k of STAT_KEYS) state.evs[k] = 0;
      state.evs[a] = 252; state.evs[b] = 252; state.evs.hp = 4;
      redraw();
    });
  const out = [
    mk('Clear', 'Back to zero', () => {
      for (const k of STAT_KEYS) state.evs[k] = 0;
      redraw();
    }),
    spread('atk', 'spe', 'Physical'),
    spread('spa', 'spe', 'Special'),
    spread('hp', 'def', 'Bulky'),
  ];
  // 255 everywhere is 1530 against a budget of 510 -- impossible in a real
  // game, which is exactly why it is worth being able to see. It is the one
  // preset a nuzlocke rule takes away.
  const max = mk('Max everything',
    capped ? 'Closed by your nuzlocke rules — legal spreads only'
      : '255 in every stat. Impossible in a real game; the app writes it anyway '
        + 'and the meter will say so.',
    () => {
      if (capped) return;
      for (const k of STAT_KEYS) state.evs[k] = 255;
      redraw();
    });
  if (capped) {
    max.disabled = true;
    max.classList.add('shackled');
  }
  out.push(max);
  return out;
}

/**
 * The two spread columns, side by side and ending level.
 *
 * Six labelled sliders in one narrow column left half a dialog empty, and the
 * two are read together anyway: one is what you rolled, the other what you
 * spent.
 */
export function spreadBlock({ state, redraw, evCapped = false, extraIv = null, extraEv = null }) {
  const wrap = el('div', { class: 'sf-spreads sf-span' });
  const ivTotal = () => STAT_KEYS.reduce((a, k) => a + state.ivs[k], 0);
  const evTotal = () => STAT_KEYS.reduce((a, k) => a + state.evs[k], 0);

  const ivHead = el('div', { class: 'sf-sec' }, 'IVs');
  if (extraIv) ivHead.append(...extraIv);
  const ivm = ivMeter(ivTotal());
  const ivCol = el('div', { class: 'sf-spreadcol' }, ivHead, ivm,
    statBars(state.ivs, 31, redraw, {
      nature: state.natureId,
      onLive: () => {
        const next = ivMeter(ivTotal());
        ivm.className = next.className;
        ivm.replaceChildren(...[...next.children]);
      },
    }));

  const evHead = el('div', { class: 'sf-sec' }, 'EVs');
  if (extraEv) evHead.append(...extraEv);
  const evm = evMeter(evTotal(), evCapped);
  const evCol = el('div', { class: 'sf-spreadcol' }, evHead, evm,
    statBars(state.evs, 255, redraw, {
      cap: evCapped ? (k) => state.evs[k] + Math.max(0, 510 - evTotal()) : null,
      // In place, so the budget is honest while you are still dragging.
      onLive: () => {
        const next = evMeter(evTotal(), evCapped);
        evm.className = next.className;
        evm.replaceChildren(...[...next.children]);
      },
    }));

  wrap.append(ivCol, evCol);
  return wrap;
}
