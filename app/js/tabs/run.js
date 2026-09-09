/**
 * tabs/run.js -- your run: the rules you chose, and how it is going.
 *
 * =========================================================================
 * WHY A TAB, WHEN THE MODE IS NOT A TAB
 * =========================================================================
 * The nuzlocke itself is deliberately NOT a tab -- it is a set of constraints
 * on the whole app, and the shackles belong on the buttons they close, in the
 * Factory and the Bag and the Builder where you actually reach for them. A tab
 * that duplicated those surfaces would drift from them within a week.
 *
 * What does belong in one place is the part you are not doing mid-action:
 * CONFIGURING the run and REVIEWING it. That is this tab, and it splits in two:
 *
 *   Rules      an ascension ladder, then every switch individually, each
 *              saying what it takes away and whether the app can hold you to it
 *   The run    badges, money, the dex, the party, the level cap, and -- when
 *              the mode is on -- the encounter log and the graveyard
 *
 * =========================================================================
 * THE STATS HALF WORKS WITH THE MODE OFF
 * =========================================================================
 * Deliberately. Someone who will never nuzlocke still wants their run
 * summarised, and gating a summary behind a mode they do not want is how a
 * feature ends up unused. With the mode off the nuzlocke-only figures read as
 * absent rather than as zero -- "not tracking deaths" is not "no deaths".
 */

import * as N from '../nuzlocke.js';
import { buildIndex } from '../teams.js';
import { opponentsFor } from '../roster.js';
import { rich } from '../rich.js';

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') { if (v != null) n.className = v; }
    else if (k === 'checked' || k === 'value') n[k] = v;
    else if (k.startsWith('aria-') || k === 'role' || k === 'type' || k === 'title'
      || k === 'placeholder' || k === 'loading' || k === 'alt' || k === 'src') n.setAttribute(k, v);
    else n[k] = v;
  }
  n.append(...kids.filter((x) => x != null));
  return n;
};

const PREF = 'blazeblack.run.view';
let S = null, F = null, CTX = null, root = null;
let TRAINER = null, state = null, index = [], cleared = {};
let view = { pane: 'run' };

const KIND_LABEL = {
  enforced: 'The app enforces this',
  clause: 'This one loosens the run',
  honour: 'On your honour — the app cannot see it',
};

function persist() { N.save(TRAINER?.trainer_id ?? 0, state); CTX?.onNuzlockeChange?.(state); }
function savePrefs() {
  try { localStorage.setItem(PREF, JSON.stringify(view)); } catch { /* private mode */ }
}

// ==========================================================================
function render() {
  root.replaceChildren(header(), view.pane === 'rules' ? rulesPane() : runPane());
}

function header() {
  const bar = el('div', { class: 'rn-bar' });

  const toggle = el('button', {
    class: `rn-toggle${state.enabled ? ' on' : ''}`, type: 'button',
    'aria-pressed': String(state.enabled),
    title: state.enabled
      ? 'Turn the nuzlocke off. Your rules, encounters and graveyard are kept.'
      : 'Turn the nuzlocke on. Nothing anywhere in the app changes until you do.',
  }, el('b', {}, state.enabled ? '⛓' : '○'),
  state.enabled ? 'Nuzlocke on' : 'Nuzlocke off');
  toggle.onclick = () => {
    state.enabled = !state.enabled;
    if (state.enabled && !state.started) state.started = Date.now();
    persist(); render();
  };
  bar.append(toggle);

  const panes = el('div', { class: 'rn-panes', role: 'tablist' });
  for (const [id, label] of [['run', 'This run'], ['rules', 'Rules']]) {
    const b = el('button', { class: `rn-pane${view.pane === id ? ' on' : ''}`, type: 'button',
      role: 'tab', 'aria-selected': String(view.pane === id) }, label);
    b.onclick = () => { view.pane = id; savePrefs(); render(); };
    panes.append(b);
  }
  bar.append(panes);

  if (state.enabled) {
    const n = N.closedActions(state).length;
    bar.append(el('span', { class: 'rn-count', title: 'Actions your rules have closed' },
      `${n} ${n === 1 ? 'action' : 'actions'} locked`));
  }
  return bar;
}

// ------------------------------------------------------------------ rules
function rulesPane() {
  const wrap = el('div', { class: 'rn-rules' });
  wrap.append(el('p', { class: 'rn-lede' },
    'Pick how hard you want this. Every rule below is a real switch — the ones marked '
    + 'as enforced actually close buttons in the other tabs, and you will see them '
    + 'struck through and locked where they used to be. Nothing here changes anything '
    + 'until the nuzlocke is on.'));

  // ---- the ladder
  const cur = N.presetOf(state.rules);
  const ladder = el('div', { class: 'rn-ladder' });
  for (const p of N.PRESETS) {
    const on = cur === p.id;
    const b = el('button', { class: `rn-rung${on ? ' on' : ''}`, type: 'button',
      'aria-pressed': String(on) },
    el('b', {}, p.name),
    el('span', {}, p.blurb),
    el('i', {}, `${p.rules.length} rules`));
    b.onclick = () => { state.rules = p.rules.slice(); state.preset = p.id; persist(); render(); };
    ladder.append(b);
  }
  wrap.append(ladder);
  wrap.append(el('p', { class: 'rn-custom' }, cur
    ? `You are on ${N.PRESETS.find((p) => p.id === cur).name}. Change any switch below and it becomes a custom run.`
    : `Custom run — ${state.rules.length} rules, matching no preset.`));

  // ---- every switch, grouped by whether the app can hold you to it
  for (const kind of ['enforced', 'clause', 'honour']) {
    const rules = N.RULES.filter((r) => r.kind === kind);
    if (!rules.length) continue;
    const sec = el('section', { class: 'rn-group' }, el('h4', {}, KIND_LABEL[kind]));
    for (const r of rules) sec.append(ruleRow(r));
    wrap.append(sec);
  }
  return wrap;
}

function ruleRow(r) {
  const on = (state.rules ?? []).includes(r.id);
  const row = el('label', { class: `rn-rule${on ? ' on' : ''}` });
  const box = el('input', { type: 'checkbox', checked: on });
  box.onchange = () => {
    const set = new Set(state.rules);
    if (box.checked) set.add(r.id); else set.delete(r.id);
    state.rules = [...set];
    state.preset = N.presetOf(state.rules) ?? 'custom';
    persist(); render();
  };
  const body = el('div', {},
    el('b', {}, r.name),
    el('span', {}, r.blurb));
  // WHAT IT ACTUALLY TAKES AWAY, named. A rule that says "no editing" without
  // saying which buttons close is a promise; naming them makes it a contract.
  if (r.gates.length) {
    body.append(el('p', { class: 'rn-takes' },
      'Closes: ', ...r.gates.map((g, i) => el('code', {},
        (i ? ' · ' : '') + (ACTION_LABEL[g] ?? g)))));
  }
  row.append(box, body);
  return row;
}

/** Human names for the gate ids, so the picker never shows a bare key. */
const ACTION_LABEL = {
  'factory.create': 'Create a Pokémon',
  'factory.edit': 'Edit a Pokémon',
  'factory.moves': 'Change moves',
  'factory.heal': 'Heal the party',
  'builder.create': 'Build a missing team member',
  'builder.adjust': 'Adjust one to match a spec',
  'bag.edit': 'Change item counts',
  'bag.give': 'Give a held item',
  'bag.teach': 'Teach a TM',
  'dex.build': 'Build one from the Pokédex',
  'builder.illegal-evs': 'Write an impossible EV spread',
};

// -------------------------------------------------------------------- run
function runPane() {
  // OPPONENTS is keyed by starter and tagged by version; resolving it here the
  // same way every other consumer does is what keeps the level cap pointing at
  // a gym leader who is actually in this player's game.
  const opponents = opponentsFor(S, CTX?.starter ?? null, CTX?.version ?? 'black');
  const st = N.runStats({ state, trainer: TRAINER, index, opponents,
    cleared, S, here: CTX?.here ?? null });
  const wrap = el('div', { class: 'rn-run' });

  wrap.append(tiles(st));
  if (st.cap && !st.cap.done && st.cap.cap) wrap.append(capPanel(st));
  if (state.enabled) wrap.append(encounterPanel(), gravePanel());
  else {
    wrap.append(el('p', { class: 'rn-lede' },
      'The nuzlocke is off, so there is no encounter log or graveyard — the figures '
      + 'above are your run either way. Turn it on to start tracking.'));
  }
  return wrap;
}

function tiles(st) {
  const g = el('div', { class: 'rn-tiles' });
  const tile = (label, value, sub) => g.append(el('div', { class: 'rn-tile' },
    el('b', {}, value == null ? '—' : String(value)),
    el('span', {}, label),
    sub ? el('i', {}, sub) : null));

  tile('badges', st.badges == null ? null : `${st.badges}/8`);
  tile('fights cleared', `${st.fightsDone}/${st.fights}`);
  tile('Pokémon owned', st.owned, st.shinies ? `${st.shinies} shiny` : null);
  tile('in the party', st.party,
    st.levelLow != null ? `L${st.levelLow}–${st.levelHigh}, avg ${st.levelAvg}` : null);
  tile('Pokédex', st.caught == null ? null : `${st.caught}`, st.seen ? `${st.seen} seen` : null);
  tile('money', st.money == null ? null : `¥${st.money.toLocaleString()}`);
  if (state.enabled) {
    tile('encounters logged', st.encounters);
    tile('lost', st.deaths, st.deaths ? 'rest in peace' : null);
  }
  return g;
}

function capPanel(st) {
  const over = st.overCap;
  const box = el('section', { class: `rn-panel${over.length ? ' bad' : ''}` },
    el('h4', {}, 'Level cap'),
    el('p', {},
      `Nothing may pass level ${st.cap.cap} — `,
      el('b', {}, st.cap.next ?? 'the next gym'),
      st.cap.where ? ` at ${st.cap.where}` : '', '.'));
  // READ FROM THE SAVE, NOT TYPED IN. The badge count settles which gym is
  // next; the level comes from that leader's documented roster.
  box.append(el('p', { class: 'rn-hint' },
    'Computed from your badge count and that leader’s strongest Pokémon — nothing to '
    + 'keep up to date by hand.'));
  if (over.length) {
    box.append(el('ul', { class: 'rn-over' }, ...over.map((m) =>
      el('li', {}, el('b', {}, m.nickname || m.species), ` is level ${m.level}`))));
  } else if (N.active(state, 'level-cap')) {
    box.append(el('p', { class: 'rn-ok' }, 'Every party member is under the cap.'));
  }
  return box;
}

function encounterPanel() {
  const areas = Object.keys(S.AREAINDEX ?? {}).sort();
  const logged = state.encounters ?? {};
  const box = el('section', { class: 'rn-panel' },
    el('h4', {}, 'Encounters',
      el('span', {}, `${Object.keys(logged).length} of ${areas.length} areas`)));
  box.append(el('p', { class: 'rn-hint' },
    'One per area. Log what you met — the Adventure tab shows the same thing beside '
    + 'each route, and marks an area spent once you have.'));

  const rows = Object.entries(logged).sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0));
  if (!rows.length) {
    box.append(el('p', { class: 'rn-none' },
      'Nothing logged yet. Walk into a route and record what you met.'));
    return box;
  }
  const list = el('div', { class: 'rn-enc' });
  for (const [area, e] of rows) {
    const spName = S.SPECIES?.[String(e.speciesId)]?.name ?? '—';
    const rm = el('button', { class: 'rn-x', type: 'button', title: 'Remove this entry' }, '×');
    rm.onclick = () => { N.clearEncounter(state, area); persist(); render(); };
    list.append(
      el('span', { class: 'rn-earea' }, area),
      S.SPRITE?.[spName]
        ? el('img', { class: 'rn-esp', src: S.SPRITE[spName], alt: '', loading: 'lazy' })
        : el('span', { class: 'rn-esp' }),
      el('span', { class: 'rn-ename' }, e.nickname || spName),
      el('span', { class: `rn-est s-${e.status}` }, e.status),
      rm);
  }
  box.append(list);
  return box;
}

function gravePanel() {
  const deaths = [...(state.deaths ?? [])].reverse();
  const box = el('section', { class: 'rn-panel' },
    el('h4', {}, 'Graveyard', el('span', {}, `${deaths.length}`)));
  if (!deaths.length) {
    box.append(el('p', { class: 'rn-none' }, 'Nobody has died. Yet.'));
    return box;
  }
  const list = el('div', { class: 'rn-grave' });
  for (const d of deaths) {
    const spName = S.SPECIES?.[String(d.speciesId)]?.name ?? '—';
    const undo = el('button', { class: 'rn-x', type: 'button',
      title: 'Take them back out of the graveyard' }, '×');
    undo.onclick = () => { N.undoDeath(state, d.at); persist(); render(); };
    list.append(
      S.SPRITE?.[spName]
        ? el('img', { class: 'rn-gsp', src: S.SPRITE[spName], alt: '', loading: 'lazy' })
        : el('span', { class: 'rn-gsp' }),
      el('span', { class: 'rn-gname' }, d.nickname || spName,
        el('i', {}, spName !== (d.nickname || spName) ? ` the ${spName}` : '')),
      el('span', { class: 'rn-glv' }, d.level ? `L${d.level}` : ''),
      el('span', { class: 'rn-gwhere' }, d.area ?? d.cause ?? ''),
      undo);
  }
  box.append(list);
  return box;
}

// ==========================================================================
export default {
  id: 'run',
  label: 'Run',
  needsSave: true,

  mount(panel, ctx) {
    S = ctx.S;
    CTX = ctx;
    F = ctx.factory ?? null;
    const sv = ctx.save ?? F?.save ?? null;
    try { TRAINER = sv ? { ...sv.readTrainer(), pokedex: sv.readPokedex?.() ?? null } : null; }
    catch { TRAINER = null; }
    state = N.load(TRAINER?.trainer_id ?? 0);
    index = F ? buildIndex(F) : [];
    // The battle sheet's own tick store, shared rather than duplicated: a gym
    // ticked off there moves the level cap here.
    try { cleared = JSON.parse(localStorage.getItem('bb_cleared') ?? '{}') ?? {}; }
    catch { cleared = {}; }
    try {
      const p = JSON.parse(localStorage.getItem(PREF) ?? '{}');
      if (p && typeof p === 'object') view = { ...view, ...p };
    } catch { /* private mode */ }
    root = el('div', { class: 'rn' });
    panel.append(root);
    render();
  },

  unmount() { root?.remove?.(); root = null; },
};
