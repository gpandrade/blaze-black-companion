/**
 * nuzlocke.js -- the run's rules, and what they take away from you. No DOM.
 *
 * =========================================================================
 * A RULE IS A CAPABILITY SWITCH, NOT A LABEL
 * =========================================================================
 * The obvious design is a checklist that reminds you what you promised. It is
 * the wrong one: a nuzlocke you can break by clicking the same button as
 * always is a note, not a rule. Every rule here names GATES -- actions it
 * closes -- and the app asks `gate()` before offering them.
 *
 * So a rule changes what the app will DO, and the UI shows the closure rather
 * than hiding it: a shackled control stays exactly where it was, struck
 * through, naming the rule that took it. Hiding it would let you forget the
 * constraint; showing it greyed and unexplained would read as a bug. You chose
 * this, and the app should say so every time it bites.
 *
 * =========================================================================
 * ENFORCED VERSUS HONOUR
 * =========================================================================
 * Some rules the app can hold you to, because the action goes through it --
 * creating a Pokémon, editing one, teaching a TM. Others it genuinely cannot:
 * it cannot see you use a Potion in battle, or switch, because those happen in
 * the emulator. Pretending otherwise would be the same class of lie as a
 * trainer card that invents a badge count.
 *
 * So every rule declares `kind`, the picker groups by it, and an honour rule
 * says plainly that it is on you. That honesty is what makes the enforced ones
 * worth trusting.
 *
 * =========================================================================
 * NOTHING HERE TOUCHES THE SAVE
 * =========================================================================
 * Encounters and deaths are facts about your RUN, not about Unova, and they
 * live in localStorage keyed by trainer id -- the same store shape teams use.
 * They are never POSTed to the repo. `auto-purge` is the one rule that acts on
 * the save, and even then it only stages a delete into the Factory's working
 * copy, which you still have to install.
 */

const KEY = 'blazeblack.nuzlocke.';
const MAX_LOG = 500;

/**
 * The rules.
 *
 * `gates` are action ids the UI asks about. Keep them coarse and name them
 * after the ACTION, not the button: two tabs offer "teach a TM" and both must
 * close when the rule closes it.
 */
export const RULES = [
  // ---- the classic three -------------------------------------------------
  {
    id: 'one-per-area',
    name: 'One encounter per area',
    blurb: 'You may catch the first Pokémon you meet in each area, and nothing else there.',
    kind: 'enforced',
    gates: [],
    tracks: true,
    on: true,
  },
  {
    id: 'death-is-permanent',
    name: 'Fainting is death',
    blurb: 'A Pokémon that faints is dead and may never be used again.',
    kind: 'enforced',
    gates: [],
    tracks: true,
    on: true,
  },
  {
    id: 'nickname-all',
    name: 'Nickname everything',
    blurb: 'Every Pokémon you keep must be nicknamed. It is what makes losing one hurt.',
    kind: 'honour',
    gates: [],
    on: true,
  },
  // ---- clauses that LOOSEN the run --------------------------------------
  {
    id: 'dupes-clause',
    name: 'Duplicates clause',
    blurb: 'An encounter from a family you already own does not count — you may try again.',
    kind: 'clause',
    gates: [],
    on: true,
  },
  {
    id: 'shiny-clause',
    name: 'Shiny clause',
    blurb: 'A shiny may always be caught, whatever the area rule says.',
    kind: 'clause',
    gates: [],
    on: false,
  },
  // ---- the ones that actually shackle the app ---------------------------
  {
    id: 'no-creating',
    name: 'No creating Pokémon',
    blurb: 'The Factory cannot build a Pokémon out of nothing. You play what you caught.',
    kind: 'enforced',
    gates: ['factory.create', 'builder.create', 'dex.build'],
    on: true,
  },
  {
    id: 'no-editing',
    name: 'No rewriting what you caught',
    blurb: 'Natures, IVs, EVs and abilities are what the game rolled. Giving it an '
      + 'item, teaching it a TM you own and renaming it are all still yours — those '
      + 'are things you can do in the game.',
    kind: 'enforced',
    // NOT `bag.give` OR `bag.teach`. Handing a Pokémon a Leftovers you own and
    // teaching it a TM you own are ordinary, legal things to do in a
    // playthrough; a nuzlocke restricts which Pokémon you may use and what
    // happens when they faint, not whether you may hold an item. Closing them
    // took away the app's convenience without taking away anything the rules
    // are actually about.
    //
    // Renaming is deliberately not here either -- see `nickname-all`, which
    // REQUIRES nicknames. Gating the only control that sets one made the two
    // rules contradict each other outright.
    gates: ['factory.edit', 'builder.adjust'],
    on: true,
  },
  {
    id: 'no-item-writes',
    name: 'No inventing items',
    blurb: 'Quantities in your bag stay as the game left them — no conjuring a stack '
      + 'of Rare Candies. Giving and teaching what you already own is unaffected.',
    kind: 'enforced',
    // Narrowed from ['bag.edit', 'bag.give', 'bag.teach']. Anyone who had this
    // switched on gets a LOOSER rule than they chose, which is the safe
    // direction for a change of meaning: it hands capability back rather than
    // silently taking more away.
    gates: ['bag.edit'],
    on: false,
  },
  {
    id: 'legal-spreads',
    name: 'Legal EV spreads only',
    blurb: 'EVs are capped at 510 total, the way the game caps them. Off, the Team '
      + 'Builder lets you write an impossible spread and only warns you — which is '
      + 'the app\u2019s usual habit with illegal builds.',
    kind: 'enforced',
    gates: ['builder.illegal-evs'],
    on: false,
  },
  {
    id: 'no-healing',
    name: 'No healing from the app',
    blurb: 'Heal at a Pokémon Center like everyone else.',
    kind: 'enforced',
    gates: ['factory.heal'],
    on: true,
  },
  {
    id: 'auto-purge',
    name: 'The dead are released',
    blurb: 'Marking a Pokémon dead stages its release immediately, rather than boxing it. '
      + 'You still have to install the save — nothing is deleted behind your back.',
    kind: 'enforced',
    gates: [],
    // It gates nothing; it changes what "It died" DOES in the Factory. That is
    // still a capability switch, so it is marked as tracking rather than left
    // looking inert -- verify_run.mjs refuses a rule that does neither.
    tracks: true,
    on: false,
  },
  {
    id: 'level-cap',
    name: 'Level cap at the next gym',
    blurb: 'Nothing may exceed the level of the next gym leader’s strongest Pokémon.',
    kind: 'enforced',
    gates: [],
    tracks: true,
    on: false,
  },
  // ---- honour rules, said plainly to be honour rules ---------------------
  {
    id: 'set-mode',
    name: 'Set mode, no items in battle',
    blurb: 'Switch style off and no healing items mid-fight. The app cannot see this one — '
      + 'it happens in the emulator.',
    kind: 'honour',
    gates: [],
    on: false,
  },
  {
    id: 'no-legendaries',
    name: 'No legendaries',
    blurb: 'Static legendary encounters are off the table.',
    kind: 'honour',
    gates: [],
    on: false,
  },
];

export const RULE_BY_ID = Object.fromEntries(RULES.map((r) => [r.id, r]));

/**
 * Presets, in the shape of an ascension ladder rather than a menu.
 *
 * Each is strictly a superset of the one before it, so "harder" is a
 * direction rather than a different pile of switches. `custom` is not listed:
 * it is what you get the moment you change anything.
 */
export const PRESETS = [
  {
    id: 'standard',
    name: 'Standard',
    blurb: 'The classic three, with the duplicates clause. The app still lets you build '
      + 'and edit — this is a nuzlocke, not a lockdown.',
    rules: ['one-per-area', 'death-is-permanent', 'nickname-all', 'dupes-clause'],
  },
  {
    id: 'strict',
    name: 'Strict',
    blurb: 'Adds the shackles: no creating, no editing, no healing from the app.',
    rules: ['one-per-area', 'death-is-permanent', 'nickname-all', 'dupes-clause',
      'no-creating', 'no-editing', 'no-healing', 'legal-spreads'],
  },
  {
    id: 'hardcore',
    name: 'Hardcore',
    blurb: 'Level-capped to the next gym, the bag is sealed, the dead are released, '
      + 'and set mode is on you.',
    rules: ['one-per-area', 'death-is-permanent', 'nickname-all',
      'no-creating', 'no-editing', 'no-healing', 'no-item-writes',
      'auto-purge', 'level-cap', 'legal-spreads', 'set-mode'],
  },
];

// ---------------------------------------------------------------- the state
export function blankState() {
  return {
    enabled: false,
    preset: 'standard',
    rules: PRESETS[0].rules.slice(),
    encounters: {},        // area name -> { speciesId, status, nickname, at }
    deaths: [],            // { speciesId, nickname, level, area, cause, at }
    started: null,
  };
}

const clean = (o) => {
  const b = blankState();
  if (!o || typeof o !== 'object') return b;
  return {
    enabled: Boolean(o.enabled),
    preset: typeof o.preset === 'string' ? o.preset : b.preset,
    rules: Array.isArray(o.rules) ? o.rules.filter((r) => RULE_BY_ID[r]) : b.rules,
    encounters: o.encounters && typeof o.encounters === 'object' ? o.encounters : {},
    deaths: Array.isArray(o.deaths) ? o.deaths.slice(-MAX_LOG) : [],
    started: Number.isFinite(o.started) ? o.started : null,
  };
};

export function load(trainerId, store = globalThis.localStorage) {
  try { return clean(JSON.parse(store?.getItem(KEY + trainerId) ?? 'null')); }
  catch { return blankState(); }
}

export function save(trainerId, state, store = globalThis.localStorage) {
  try { store?.setItem(KEY + trainerId, JSON.stringify(clean(state))); }
  catch { /* private mode: the run lasts for this tab only */ }
  return state;
}

// ---------------------------------------------------------------- the gates
/**
 * May this action happen?
 *
 * Returns `{ ok: true }` or `{ ok: false, rule, name, why }`. The caller
 * renders the closure -- it never silently drops the control, because a
 * missing button is indistinguishable from a broken one, and the shackle is
 * the entire point.
 *
 * A disabled MODE opens every gate. Someone who is not running a nuzlocke must
 * see no difference anywhere in the app.
 */
export function gate(state, action) {
  if (!state?.enabled) return { ok: true };
  for (const id of state.rules ?? []) {
    const r = RULE_BY_ID[id];
    if (r && r.gates.includes(action)) {
      return { ok: false, rule: id, name: r.name, why: r.blurb };
    }
  }
  return { ok: true };
}

/** Every action currently closed, for the "what you gave up" summary. */
export function closedActions(state) {
  if (!state?.enabled) return [];
  const out = new Map();
  for (const id of state.rules ?? []) {
    for (const a of RULE_BY_ID[id]?.gates ?? []) out.set(a, id);
  }
  return [...out].map(([action, rule]) => ({ action, rule }));
}

export const active = (state, id) =>
  Boolean(state?.enabled) && (state.rules ?? []).includes(id);

/** Which preset a rule set corresponds to, or null for a custom one. */
export function presetOf(rules) {
  const key = [...(rules ?? [])].sort().join('|');
  return PRESETS.find((p) => [...p.rules].sort().join('|') === key)?.id ?? null;
}

// ------------------------------------------------------------- the level cap
/**
 * The level of the next gym leader's strongest Pokémon.
 *
 * COMPUTED, NEVER TYPED IN. Every input is already here: the documented fights
 * in game order, `kind === 'gym'`, and which of them you have ticked off in the
 * battle companion. A cap you have to look up and enter by hand is one you
 * enter wrong once and then trust for the rest of the run.
 *
 * `cleared` is the battle sheet's own `bb_cleared` map, keyed by the fight's
 * stable slug -- the same store, so ticking a gym off there moves the cap here.
 */
export function levelCap(opponents, cleared = {}, badges = null) {
  const gyms = (opponents ?? []).filter((o) => o.kind === 'gym');
  if (!gyms.length) return null;
  // Badges are read from the save and are the better signal when we have them:
  // they cannot drift the way a forgotten tick can. Fall back to the ticks.
  let idx = Number.isInteger(badges) ? badges : gyms.findIndex((g) => !cleared[g.key]);
  if (idx < 0 || idx >= gyms.length) return { done: true, next: null, cap: null };
  const g = gyms[idx];
  const cap = Number(g.lvmax) || Math.max(0, ...(g.team ?? [])
    .map((m) => Number(m.l)).filter(Number.isFinite));
  return { done: false, next: g.leader ?? null, where: g.loc ?? null, cap: cap || null };
}

/** Party members standing over the cap. */
export function overCap(party, cap) {
  if (!cap) return [];
  return (party ?? []).filter((m) => (m.level ?? m.lvl ?? 0) > cap);
}

// ------------------------------------------------------------- encounters
/**
 * Whether this area's encounter is already spent.
 *
 * A `dupe` or a `fled` does NOT spend it under the duplicates clause -- that
 * is what the clause is for. Without the clause every outcome spends it.
 */
export function areaSpent(state, area) {
  const e = state?.encounters?.[area];
  if (!e) return false;
  if (e.status === 'dupe' && active(state, 'dupes-clause')) return false;
  return true;
}

/**
 * Does this species count as a duplicate?
 *
 * On the EVOLUTION FAMILY, not the species: catching a Pidgey when you already
 * have a Pidgeotto is the case the clause exists for, and a species-only check
 * misses every one of them. The family is walked from the blob's `evo` links.
 */
export function familyOf(speciesId, S) {
  const seen = new Set([Number(speciesId)]);
  const byName = new Map();
  for (const [id, v] of Object.entries(S.SPECIES ?? {})) byName.set(v.name, Number(id));
  // Forward: everything it becomes.
  const walk = (id) => {
    for (const name of S.SPECIES?.[String(id)]?.evo ?? []) {
      const next = byName.get(name);
      if (next && !seen.has(next)) { seen.add(next); walk(next); }
    }
  };
  walk(Number(speciesId));
  // Backward: anything that becomes something already in the set.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, v] of Object.entries(S.SPECIES ?? {})) {
      const n = Number(id);
      if (seen.has(n)) continue;
      if ((v.evo ?? []).some((name) => seen.has(byName.get(name)))) { seen.add(n); grew = true; }
    }
  }
  return seen;
}

export function isDuplicate(state, speciesId, ownedIds, S) {
  if (!active(state, 'dupes-clause')) return false;
  const fam = familyOf(speciesId, S);
  return (ownedIds ?? []).some((id) => fam.has(Number(id)));
}

export function recordEncounter(state, area, entry) {
  state.encounters = { ...state.encounters, [area]: { ...entry, at: Date.now() } };
  if (!state.started) state.started = Date.now();
  return state;
}

export function clearEncounter(state, area) {
  const e = { ...state.encounters };
  delete e[area];
  state.encounters = e;
  return state;
}

export function recordDeath(state, entry) {
  state.deaths = [...(state.deaths ?? []), { ...entry, at: Date.now() }].slice(-MAX_LOG);
  if (!state.started) state.started = Date.now();
  return state;
}

export function undoDeath(state, at) {
  state.deaths = (state.deaths ?? []).filter((d) => d.at !== at);
  return state;
}

// ---------------------------------------------------------------- the stats
/**
 * A summary of the run, WHETHER OR NOT the nuzlocke mode is on.
 *
 * Everything here is read, not estimated. The save has no play-time counter we
 * have located, so there is no "hours played" -- inventing one would be the
 * same lie as a guessed badge count. What it does have is badges, money, the
 * dex, everything in the boxes and where you are standing.
 */
export function runStats({ state, trainer, index, opponents, cleared, S, here }) {
  const mons = (index ?? []).map((e) => e.mon);
  const party = (index ?? []).filter((e) => e.loc === 'party').map((e) => e.mon);
  const levels = party.map((m) => m.level).filter(Number.isFinite);
  const types = new Map();
  for (const m of mons) for (const t of m.types ?? []) types.set(t, (types.get(t) ?? 0) + 1);
  const fights = (opponents ?? []).length;
  const done = (opponents ?? []).filter((o) => cleared?.[o.key]).length;
  const cap = levelCap(opponents, cleared, trainer?.badges?.count ?? null);

  return {
    badges: trainer?.badges?.count ?? null,
    money: trainer?.money ?? null,
    caught: trainer?.pokedex?.caught_count ?? null,
    seen: trainer?.pokedex?.seen_count ?? null,
    owned: mons.length,
    shinies: mons.filter((m) => m.shiny).length,
    party: party.length,
    levelLow: levels.length ? Math.min(...levels) : null,
    levelHigh: levels.length ? Math.max(...levels) : null,
    levelAvg: levels.length
      ? Math.round((levels.reduce((a, b) => a + b, 0) / levels.length) * 10) / 10 : null,
    types: [...types].sort((a, b) => b[1] - a[1]),
    where: here ?? null,
    fights,
    fightsDone: done,
    cap,
    overCap: overCap(party, cap?.cap ?? null).map((m) => ({
      species: m.species, nickname: m.nickname, level: m.level })),
    // Nuzlocke-only, and null rather than zero when the mode is off, so the UI
    // can tell "no deaths" from "not tracking deaths".
    encounters: state?.enabled ? Object.keys(state.encounters ?? {}).length : null,
    deaths: state?.enabled ? (state.deaths ?? []).length : null,
    alive: state?.enabled
      ? mons.length - (state.deaths ?? []).length : null,
  };
}
