/**
 * teams.js -- the Team Builder's model. No DOM.
 *
 * =========================================================================
 * A SLOT IS A SPECIFICATION, NOT A POINTER
 * =========================================================================
 * The obvious design is for a team slot to point at a Pokemon in the save.
 * It is wrong here. You want to design a team as an IDEA -- "Slowking with
 * Drizzle, max HP, Trick Room" -- before you own it, and then find out what
 * it would take to make it real.
 *
 * So a slot holds a spec, and the save is matched AGAINST it. Every slot is
 * then in one of three states, and the third is the one that matters:
 *
 *   owned    a Pokemon in the save matches the spec exactly
 *   close    you have the species, but something differs -- and we can say
 *            exactly what, and fix it in place
 *   missing  nothing of that species; the Factory can build it
 *
 * "Close" is the common case and the useful one. You have a Slowking. The
 * team wants a different ability and spread. That is an edit, not a new
 * Pokemon, and treating it as one would leave you with two Slowkings.
 *
 * =========================================================================
 * PERSISTENCE: BOTH, ON PURPOSE
 * =========================================================================
 * localStorage keyed by trainer id is the live store, so the app works for
 * anyone who just opens it with no server and no config. When ./serve is
 * running, teams can also be written to state/teams.json -- durable, in git,
 * survives clearing site data. Neither is the source of truth for the other;
 * loading merges by id with the newer `updated` winning.
 */

const LS_PREFIX = 'blazeblack.teams.';
const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

export const MAX_SLOTS = 6;

export const ROLES = ['setter', 'sweeper', 'wall', 'pivot'];

/**
 * A slot is a JOB, and a job can be filled more than one way.
 *
 *   Slot   = { role, why, options: [Option, ...] }   options[0] is the default
 *   Option = a full spec, plus a badge and a note describing the swap
 *
 * This mirrors TEAM_LAYOUT, where every slot carries alternatives and the
 * swap tree is the part of the battle sheet that actually gets used. Role and
 * reason belong to the SLOT rather than to an option: they describe the job,
 * and swapping who does it does not change what the job is.
 */

/** One way of filling a slot. */
export function blankOption(speciesId = 1) {
  return {
    speciesId,
    badge: '',             // two or three words: what this swap is for
    note: '',              // what it costs you
    rigged: '',            // disclaimer for a deliberately-broken Pokemon
    nickname: '',
    level: 50,
    natureId: 0,
    abilityId: 0,
    gender: null,          // null = derive from the species ratio
    shiny: false,
    itemId: 0,
    moveIds: [0, 0, 0, 0],
    ivs: Object.fromEntries(STAT_KEYS.map((k) => [k, 31])),
    evs: Object.fromEntries(STAT_KEYS.map((k) => [k, 0])),
  };
}

/** A slot with a single option. */
export function blankSlot(speciesId = 1) {
  return { role: null, why: '', options: [blankOption(speciesId)] };
}

/** The spec currently filling each slot -- what the visualisations describe. */
export const teamSpecs = (team) => team.slots.map((sl) => sl.options[0]);

/**
 * Bring a team up to the current shape.
 *
 * Slots used to BE specs. Anything saved before that carries a speciesId on
 * the slot itself, so it is wrapped rather than discarded -- a save format
 * change should never quietly lose somebody's team.
 */
export function normalizeTeam(t) {
  const slots = (t.slots ?? []).map((sl) => {
    if (sl && Array.isArray(sl.options)) {
      return { role: sl.role ?? null, why: sl.why ?? '',
        options: sl.options.map((o) => ({ badge: '', note: '', rigged: '', ...o })) };
    }
    // legacy: the slot was itself a spec
    const { role = null, why = '', ...spec } = sl ?? {};
    return { role, why, options: [{ badge: '', note: '', rigged: '', ...spec }] };
  }).filter((sl) => sl.options.length && sl.options[0].speciesId);
  // PILOT CARDS ARE STRUCTURED NOW, not derived from free text.
  //
  // A team's `notes` used to become the tagline plus a run of cards labelled
  // "Note 1", "Note 2"... which is why a Builder team never looked like Kaiju,
  // whose cards say LEAD, SPEED, WIN CON, SETUP, PANIC. The label is the
  // useful half -- it tells you what question the sentence answers.
  //
  // Migration keeps every existing team's prose: a team with no `pilot` still
  // splits its notes exactly as before. A format change must never quietly
  // lose somebody's writing.
  const pilot = Array.isArray(t.pilot)
    ? t.pilot.map((c) => ({ k: String(c?.k ?? '').slice(0, 18), v: String(c?.v ?? '') }))
      .filter((c) => c.k || c.v)
    : null;
  return { ...t, slots, pilot, warnNote: typeof t.warnNote === 'string' ? t.warnNote : '' };
}

export function blankTeam(name = 'New team') {
  return {
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    notes: '',
    tag: '',
    pilot: null,                     // [{k,v}] once authored; null = use notes
    warnNote: '',                    // overrides the computed warning line
    slots: [],                       // 1..6; a draft with fewer is normal
    updated: Date.now(),
  };
}

// ------------------------------------------------------------------ matching
const sameSet = (a, b) => {
  const x = [...a].filter(Boolean).sort((p, q) => p - q);
  const y = [...b].filter(Boolean).sort((p, q) => p - q);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/**
 * What differs between a spec and a Pokemon you own.
 *
 * Level is included but ranked last: a level difference is trivially fixable
 * and should not make an otherwise-perfect match look far off. Nickname and
 * shininess are NOT compared -- neither changes how the Pokemon performs, and
 * flagging them would bury the differences that matter.
 */
export function diffSlot(spec, mon, S) {
  const out = [];
  const name = (map, id) => (id ? (map[String(id)] ?? `#${id}`) : '—');

  if (spec.abilityId && spec.abilityId !== mon.abilityId) {
    out.push({ field: 'ability', want: name(S.ABILBYID, spec.abilityId), have: mon.ability });
  }
  if (spec.natureId !== mon.natureId) {
    out.push({ field: 'nature', want: NATURE_NAMES[spec.natureId], have: mon.nature });
  }
  if (!sameSet(spec.moveIds, mon.moveIds)) {
    out.push({
      field: 'moves',
      want: spec.moveIds.filter(Boolean).map((m) => name(S.MOVEBYID, m)).join(', ') || '—',
      have: mon.moves.map((m) => m.name).join(', ') || '—',
    });
  }
  if ((spec.itemId || 0) !== (mon.itemId || 0)) {
    out.push({ field: 'item', want: name(S.ITEMS, spec.itemId), have: mon.item ?? '—' });
  }
  for (const k of STAT_KEYS) {
    if (spec.evs[k] !== mon.evs[k]) {
      out.push({ field: 'EVs', want: STAT_KEYS.map((x) => spec.evs[x]).join('/'),
        have: STAT_KEYS.map((x) => mon.evs[x]).join('/') });
      break;
    }
  }
  for (const k of STAT_KEYS) {
    if (spec.ivs[k] !== mon.ivs[k]) {
      out.push({ field: 'IVs', want: STAT_KEYS.map((x) => spec.ivs[x]).join('/'),
        have: STAT_KEYS.map((x) => mon.ivs[x]).join('/') });
      break;
    }
  }
  if (spec.level !== mon.level) {
    out.push({ field: 'level', want: `L${spec.level}`, have: `L${mon.level}` });
  }
  return out;
}

export const NATURE_NAMES = [
  'Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty',
  'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax',
  'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive',
  'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash',
  'Calm', 'Gentle', 'Sassy', 'Careful', 'Quirky',
];

/**
 * Match one spec against everything in the save.
 *
 * `taken` is a set of "loc:index" keys already claimed by earlier slots, so
 * two slots wanting the same species resolve to two different Pokemon rather
 * than both pointing at one. Exactly the problem build_sheet.py's take()
 * solves for the battle sheet, for the same reason.
 */
export function matchSlot(spec, index, S, { taken = new Set() } = {}) {
  const all = [];
  for (const s of index) {
    if (s.mon.speciesId !== spec.speciesId) continue;
    all.push({ ...s, key: `${s.loc}:${s.index}`, diffs: diffSlot(spec, s.mon, S) });
  }
  if (!all.length) return { state: 'missing', at: null, diffs: null, shared: false };

  // Fewest differences wins; a party copy breaks a tie, because that is the
  // one already in play.
  const rank = (a, b) => a.diffs.length - b.diffs.length
    || (a.loc === 'party' ? 0 : 1) - (b.loc === 'party' ? 0 : 1);

  /* TEAMS ARE ALTERNATIVES, NOT A SIMULTANEOUS ARMY.
     Claiming exists so two teams that each want a Slowking get DIFFERENT
     Slowkings, and it quietly assumed the teams coexist. They do not -- you
     field one at a time, and five cores each listing the one Gengar you own is
     completely legitimate. When claiming ran out, the two sides answered
     differently and both answers were wrong: the sheet handed the fifth team
     somebody else's Gengar in silence, and this returned `missing` about a
     Pokemon sitting in the save.
     So: claim a distinct copy while there is one, and when there is not, fall
     back to the BEST MATCH and say it is shared. `shared` is not decoration --
     the note on the card carries it, because a page implying exclusivity it
     does not have is the failure claiming was built to prevent. */
  const free = all.filter((c) => !taken.has(c.key));
  const pool = free.length ? free : all;
  pool.sort(rank);
  const best = pool[0];
  return {
    state: best.diffs.length === 0 ? 'owned' : 'close',
    at: { loc: best.loc, index: best.index, key: best.key },
    diffs: best.diffs,
    mon: best.mon,
    shared: !free.length,
  };
}

/**
 * Match a whole team, claiming copies so duplicates resolve separately.
 * Returns one array of match results PER SLOT, one entry per option.
 *
 * `taken` MAY BE SHARED ACROSS TEAMS, and for the battle tab it must be.
 * A player may keep four Arcanines and two Slowkings, one per roster; if
 * every team matched against the full save independently, two teams that both
 * want a
 * Slowking would render the SAME record and one of them would be lying about
 * what it is holding. build_sheet.py claims globally across the whole
 * assembly for exactly this reason. Default is a fresh set, which is right
 * for the Builder: a team being edited should show what it could claim on its
 * own, not what is left over after the others.
 */
export function matchTeam(rawTeam, index, S, { taken = new Set() } = {}) {
  // Normalise first: this is a public entry point and may be handed a team
  // saved before slots grew options, or one assembled by a caller by hand.
  const team = normalizeTeam(rawTeam);
  return team.slots.map((sl) => sl.options.map((spec) => {
    const m = matchSlot(spec, index, S, { taken });
    if (m.at) taken.add(m.at.key);
    return m;
  }));
}

/** Just the primary option's match for each slot. */
export const matchPrimary = (team, index, S) => matchTeam(team, index, S).map((ms) => ms[0]);

/** Every Pokemon in the save, flattened, for the matcher to scan. */
export function buildIndex(factory) {
  const out = [];
  for (const l of factory.locations()) {
    for (const s of factory.read(l.loc)) if (s.mon) out.push({ loc: l.loc, index: s.index, mon: s.mon });
  }
  return out;
}

// ------------------------------------------------------------ visualisation
/**
 * How each of the 17 attacking types fares against the team.
 *
 * `worst` is the count of team members it hits for more than neutral, which
 * is the number that actually decides things: a type that is 2x on four of
 * your six is a hole, and one that is 2x on one is a matchup.
 */
export function defensiveGrid(specs, S) {
  const rows = [];
  for (const atk of S.TYPES) {
    const cells = specs.map((sp) => {
      const types = S.SPECIES[String(sp.speciesId)]?.types ?? [];
      return types.reduce((m, d) => m * (S.CHART[atk]?.[d] ?? 1), 1);
    });
    rows.push({ type: atk, cells, worst: cells.filter((x) => x > 1).length,
      immune: cells.filter((x) => x === 0).length });
  }
  return rows;
}

/**
 * What each member can DO to each defending type: a grid, not a checklist.
 *
 * This used to be seventeen green-or-red chips. The trouble with that shape
 * is that it answers only "is this covered", when the questions you actually
 * have are "who covers it" and "with what" -- and it buries both in a
 * tooltip. A grid the same shape as the defensive one answers all three at a
 * glance and reuses a reading habit the eye already has from the panel above.
 *
 * The cell is the best multiplier that member can reach with a DAMAGING move.
 * Status moves are excluded: "covers Ghost" via Will-O-Wisp is not the claim
 * anyone is making.
 */
export function offensiveGrid(specs, S) {
  return S.TYPES.map((def) => {
    const cells = specs.map((sp) => {
      let best = { mult: 0, move: null };
      for (const mid of sp.moveIds.filter(Boolean)) {
        const name = S.MOVEBYID[String(mid)];
        const mv = S.MOVES[name];
        if (!mv || mv.c === 'status') continue;
        const mult = S.CHART[mv.t]?.[def] ?? 1;
        if (mult > best.mult) best = { mult, move: name };
      }
      return best;
    });
    const supers = cells.filter((c) => c.mult > 1).length;
    return {
      type: def,
      cells,
      supers,
      // "Nothing here can touch it at all" is a different and worse problem
      // than "nothing hits it hard", so it is counted separately.
      untouchable: cells.every((c) => c.mult === 0),
      covered: supers > 0,
    };
  });
}

/** The yes/no summary, for callers that only need coverage gaps. */
export function offensiveCoverage(specs, S) {
  return offensiveGrid(specs, S).map((r) => ({
    type: r.type,
    covered: r.covered,
    hitters: r.cells.map((c, i) => (c.mult > 1
      ? { species: S.SPECIES[String(specs[i].speciesId)]?.name, move: c.move } : null)).filter(Boolean),
  }));
}


// -------------------------------------------------------------- persistence
const lsKey = (tid) => `${LS_PREFIX}${tid ?? 'anon'}`;

export function loadLocal(tid) {
  try {
    const raw = localStorage.getItem(lsKey(tid));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveLocal(tid, teams) {
  try {
    localStorage.setItem(lsKey(tid), JSON.stringify(pruneTombstones(teams)));
    return true;
  } catch { return false; }         // private mode, or quota
}

/**
 * Merge two lists by id, newest `updated` winning.
 *
 * TOMBSTONES, not removal. Deleting a team by dropping it from localStorage
 * did not work: the repo copy survived, and the next merge brought it back --
 * which is exactly what "I deleted it and it reappeared when I switched tabs"
 * was. A delete is now a record with `deleted` set, so it is a fact that
 * merges like any other and can beat an older live copy in the other store.
 */
export function merge(a, b) {
  const by = new Map();
  for (const t of [...a, ...b]) {
    const prev = by.get(t.id);
    if (!prev || (t.updated ?? 0) > (prev.updated ?? 0)) by.set(t.id, t);
  }
  return [...by.values()].sort((x, y) => (y.updated ?? 0) - (x.updated ?? 0));
}

/**
 * A CORE is a named group of Pokémon you start teams from.
 *
 * "Seed from a core" was only ever able to offer things that already existed
 * -- your party, a box, a built-in roster -- with no way to define one. A core
 * is just a saved list of specs, stored beside teams (same store, marked
 * `kind: 'core'`), so a group you keep coming back to becomes a starting point
 * rather than something you rebuild by hand each time.
 */
export function makeCore(name, specs) {
  return {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    kind: 'core',
    name,
    slots: specs.map((spec) => ({ role: null, why: '', options: [{ badge: '', note: '', ...spec }] })),
    updated: Date.now(),
  };
}

export const isCore = (t) => t.kind === 'core';

/**
 * Adopt the shipped rosters into the team store, once per trainer.
 *
 * THEY USED TO BE A SEPARATE KIND OF THING. `TEAM_LAYOUT` in build_sheet.py
 * held eight hand-written rosters that the battle companion rendered as tabs
 * you could not edit, retire or delete, while anything you built yourself was
 * a core that you could. The distinction bought nothing -- a core IS a line-up
 * you adopted, and these are the most adopted line-ups in the project -- and
 * it cost a naming convention: a LAYOUT slot names only a SPECIES, so with
 * four Arcanines in the save it needed a one-letter tag in each nickname to
 * say which one it meant. A core's slot is a full SPEC, so it matches on what
 * the Pokemon actually IS and the tags stop mattering.
 *
 * The rosters still SHIP, because `state/teams.json` is gitignored and the
 * writing in them is real work -- they are seed data now rather than a second
 * class of team. On first run they become ordinary cores.
 *
 * ONCE, AND ONCE ONLY -- which takes TWO guards, because they answer different
 * questions and each one alone is wrong:
 *
 *   the marker   a localStorage key listing what has been offered. Needed
 *                because "is there a core called Kaiju" says no once you
 *                retire it (it becomes a team) or delete it (the tombstone is
 *                pruned after 30 days), and seeding would hand back a roster
 *                you had deliberately thrown away.
 *   the name     needed because the marker is per-browser and the store is
 *                not: a store seeded elsewhere -- another machine, the repo
 *                copy, the CLI seeder -- arrives with the cores already in it
 *                and no marker, and would be seeded a second time.
 *
 * So a roster is adopted only when BOTH say it is new, and either one seeing
 * it records it as seeded.
 */
export function seedBuiltins(teams, index, S, { tid, force = false } = {}) {
  const key = `${LS_PREFIX}seeded:${tid ?? 'anon'}`;
  let seen = [];
  if (!force) {
    try { seen = JSON.parse(localStorage.getItem(key) ?? '[]'); } catch { /* private mode */ }
  }
  if (!Array.isArray(seen)) seen = [];

  const done = new Set(seen);
  const present = new Set(living(teams).filter(isCore).map((c) => c.name));
  const added = [];
  for (const bt of S.LAYOUT ?? []) {
    const known = done.has(bt.name) || present.has(bt.name);
    done.add(bt.name);
    if (known) continue;
    // THE TAGS' LAST JOB -- see the note above. `layoutToTeam` already reads
    // `bt.tag`; it lives in TEAM_TAG beside the layout, not on it. Without it
    // every roster takes the first free copy and the whole assignment shifts
    // by one, so Kaiju ends up holding another team's Gengar.
    const team = layoutToTeam({ ...bt, tag: S.TEAM_TAG?.[bt.id] ?? '' }, index, S);
    if (!team.slots.length) continue;
    const core = coreFromTeam(bt.name, team);
    core.mech = [...(bt.mech ?? [])];      // a rain team keeps its rain toggle
    core.tr = Boolean(bt.tr);
    core.adopted = 'built-in';
    added.push(core);
  }

  // Recorded even when nothing was added: a store that already carried them
  // has now been seen, and must not be seeded again if those cores are later
  // retired.
  if (done.size !== seen.length) {
    try { localStorage.setItem(key, JSON.stringify([...done])); } catch { /* private mode */ }
  }
  return { teams: added.length ? [...added, ...teams] : teams, added };
}

/**
 * A built-in TEAM_LAYOUT roster, as a Builder team.
 *
 * These -- Kaiju, Sun King, My Uncle Works at Nintendo -- are cores in every
 * sense that matters: hand-authored line-ups that settled long ago. Leaving
 * them out of "start from a core" was the wrong call.
 *
 * It carries the WHOLE slot across, alternates included, so starting from
 * Kaiju gives you its swap tree rather than six bare species. Where a member
 * is in the save, its actual build comes with it; where it is not, the slot
 * gets a blank spec of the right species that the Factory can then create.
 */
export function layoutToTeam(bt, index, S) {
  const byName = new Map();
  for (const [id, sp] of Object.entries(S.SPECIES)) byName.set(sp.name, Number(id));
  const taken = new Set();

  const pick = (name) => {
    const id = byName.get(name);
    if (!id) return null;
    // Prefer a copy carrying this team's tag, then any free copy -- the same
    // reason build_sheet.py's take() does: without it the living dex gets
    // claimed first purely because it sorts earlier.
    const free = index.filter((x) => x.mon.speciesId === id && !taken.has(`${x.loc}:${x.index}`));
    const hit = free.find((x) => (x.mon.nickname ?? '').startsWith(`${(bt.tag ?? '')} `)) ?? free[0];
    if (!hit) return { ...blankOption(id) };
    taken.add(`${hit.loc}:${hit.index}`);
    return { badge: '', note: '', rigged: '', ...monToSpec(hit.mon) };
  };

  const slots = (bt.slots ?? []).map((sl) => {
    const options = (sl.options ?? []).map((opt) => {
      // A slot option is TEAM_LAYOUT's own list: [name, badge, note, rigged].
      // Handing this the already-CONVERTED battle team instead threw here,
      // and a throw inside a click handler is invisible -- it is what "copy
      // into the Team Builder just fizzles out" actually was. Skipping the
      // wrong shape turns it into an empty team, which callers already check.
      if (!Array.isArray(opt)) return null;
      const [name, badge, note, rigged] = opt;
      const spec = pick(name);
      return spec ? { ...spec, badge: badge ?? '', note: note ?? '', rigged: rigged ?? '' } : null;
    }).filter(Boolean);
    return options.length ? { role: sl.role ?? null, why: sl.why ?? '', options } : null;
  }).filter(Boolean);

  // The pilot cards come across too. Starting from Kaiju and getting its swap
  // tree but none of its LEAD / SPEED / WIN CON prose was most of why a copied
  // roster stopped looking like the thing you copied.
  return {
    ...blankTeam(bt.name),
    notes: bt.tagline ?? '',
    // TWO SHAPES IN PLAY: build_sheet.py converts TEAM_LAYOUT's pilot pairs to
    // {k,v} for the sheet's own blob, while build_static.py exports LAYOUT raw,
    // so a card arrives as either ['Lead', '...'] or {k,v}. Reading only one
    // silently produced six blank cards.
    pilot: (bt.pilot ?? []).map((c) => (Array.isArray(c)
      ? { k: c[0] ?? '', v: c[1] ?? '' }
      : { k: c.k ?? '', v: c.v ?? '' })),
    warnNote: bt.warn ?? '',
    slots,
  };
}

/** Promote a team to a core, keeping its slots whole -- swaps, roles and all. */
export function coreFromTeam(name, team) {
  const t = normalizeTeam(team);
  return {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    kind: 'core',
    name,
    notes: t.notes ?? '',
    pilot: t.pilot ?? null,
    warnNote: t.warnNote ?? '',
    slots: t.slots.map((sl) => ({
      role: sl.role ?? null,
      why: sl.why ?? '',
      options: sl.options.map((o) => JSON.parse(JSON.stringify(o))),
    })),
    updated: Date.now(),
  };
}

/**
 * Turn a core back into an editable team, and retire the core.
 *
 * Cores are meant to be settled: you experiment in the builder, and promote a
 * line-up to a core once it stops changing. Coming back the other way is how
 * you un-settle one, and it is deliberately the ONLY way to remove a core --
 * the extra step is the friction. You never lose the line-up by accident,
 * because retiring it hands it straight back to you as a team.
 */
export function coreToTeam(core) {
  return {
    ...blankTeam(core.name),
    notes: core.notes ?? '',
    pilot: core.pilot ?? null,
    warnNote: core.warnNote ?? '',
    slots: core.slots.map((sl) => ({
      role: sl.role ?? null,
      why: sl.why ?? '',
      options: sl.options.map((o) => JSON.parse(JSON.stringify(o))),
    })),
  };
}

/**
 * The next unused "Team N".
 *
 * `teams.length + 1` was wrong twice over: it counted TOMBSTONES, so the
 * number climbed forever as teams were made and deleted, and it counted
 * CORES, which are not teams at all. Names may still collide if you type one
 * -- that is harmless, since everything downstream keys on id -- but the
 * generated ones should not pile up.
 */
export function nextTeamName(teams) {
  const used = new Set(onlyTeams(teams)
    .map((t) => /^Team (\d+)$/.exec(t.name ?? '')?.[1])
    .filter(Boolean)
    .map(Number));
  let n = 1;
  while (used.has(n)) n++;
  return `Team ${n}`;
}

/**
 * Drop tombstones nobody needs any more.
 *
 * A tombstone exists so a delete can beat a stale live copy in the other
 * store. Once it is older than any plausible unsynced copy it is just
 * clutter, and without this the store grows every time a team is made and
 * deleted. Thirty days is far longer than the two stores can realistically
 * drift, and a tombstone is a handful of bytes, so this errs long.
 */
export function pruneTombstones(teams, maxAgeMs = 30 * 24 * 60 * 60 * 1000, now = Date.now()) {
  return teams.filter((t) => !t.deleted || (now - t.deleted) < maxAgeMs);
}
export const cores = (teams) => living(teams).filter(isCore);
/** Teams, excluding cores -- cores are ingredients, not teams. */
export const onlyTeams = (teams) => living(teams).filter((t) => !isCore(t));

/** Teams that still exist -- tombstones filtered out. */
export const living = (teams) => teams.filter((t) => !t.deleted);

/** Mark a team deleted rather than removing it, so the deletion propagates. */
export function tombstone(teams, id) {
  return teams.map((t) => (t.id === id
    ? { id: t.id, name: t.name, slots: [], deleted: Date.now(), updated: Date.now() }
    : t));
}

export async function loadRepo(fetcher = fetch) {
  const res = await fetcher('/api/teams', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body.teams) ? body.teams : [];
}

export async function saveRepo(teams, fetcher = fetch) {
  const res = await fetcher('/api/teams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teams }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/** A spec in the shape js/mon.js's buildRecord wants. */
export function specToBuild(spec, S) {
  return {
    species: spec.speciesId,
    level: spec.level,
    ability: spec.abilityId || undefined,
    nature: spec.natureId,
    moves: spec.moveIds.filter(Boolean),
    item_id: spec.itemId || 0,
    evs: spec.evs,
    ivs: spec.ivs,
    shiny: spec.shiny,
    nick: spec.nickname?.trim() || null,
    ...(spec.gender ? { gender: spec.gender } : {}),
  };
}

// =========================================================================
// EXPORTING A TEAM TO THE BATTLE COMPANION
// =========================================================================
// The battle sheet consumes a very specific shape -- the one build_sheet.py
// builds out of TEAM_LAYOUT and the save. Everything below converts a
// Builder team into exactly that shape so a designed team becomes a tab
// alongside the hand-authored ones, using the same damage maths, the same
// type chart and the same matchup planner.
//
// The numbers come from the SPEC, not from whatever you currently own. A team
// in the Builder is a plan; "how would this perform" is the question being
// asked. Slots you have not built yet are counted in the team's warning line
// rather than quietly shown as if they were real.

const WEATHER_ABILITY = { Drizzle: 'rain', Drought: 'sun', 'Sand Stream': 'sand',
  'Snow Warning': 'hail' };
const WEATHER_MOVE = { 'Rain Dance': 'rain', 'Sunny Day': 'sun', Sandstorm: 'sand',
  'Trick Room': 'tr' };

/** Stats for a spec, in the sheet's hp/atk/def/spa/spd/spe order. */
export function specStats(spec, S) {
  const sp = S.SPECIES[String(spec.speciesId)];
  if (!sp) return [0, 0, 0, 0, 0, 0];
  const raised = Math.floor(spec.natureId / 5), lowered = spec.natureId % 5;
  const NAT_ORDER = ['atk', 'def', 'spe', 'spa', 'spd'];
  return STAT_KEYS.map((k) => {
    const core = Math.floor((2 * sp.base[k] + spec.ivs[k] + Math.floor(spec.evs[k] / 4))
      * spec.level / 100);
    if (k === 'hp') return spec.speciesId === 292 ? 1 : core + spec.level + 10;
    let v = core + 5;
    if (raised !== lowered) {
      if (NAT_ORDER[raised] === k) v = Math.floor(v * 11 / 10);
      else if (NAT_ORDER[lowered] === k) v = Math.floor(v * 9 / 10);
    }
    return v;
  });
}

/**
 * Guess a role from the spread and the moves.
 *
 * Only used when a slot has not been given one. It is a heuristic and the
 * Builder lets you override it, because "is this a wall or a pivot" is a
 * judgement about how you intend to play it, not a fact about its stats.
 */
export function inferRole(spec, S, override = null) {
  if (override) return override;
  if (spec.role) return spec.role;
  const names = spec.moveIds.filter(Boolean).map((m) => S.MOVEBYID[String(m)] ?? '');
  if (names.some((n) => ['U-turn', 'Volt Switch', 'Baton Pass'].includes(n))) return 'pivot';
  if (names.some((n) => ['Stealth Rock', 'Spikes', 'Toxic Spikes', 'Trick Room',
    'Rain Dance', 'Sunny Day', 'Sandstorm', 'Reflect', 'Light Screen'].includes(n))) return 'setter';
  const st = specStats(spec, S);
  const [hp, atk, def, spa, spd, spe] = st;
  if (def + spd + hp > atk + spa + spe) return 'wall';
  return 'sweeper';
}

const STAT_ORDER = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

/**
 * The mon object the battle sheet renders.
 *
 * =========================================================================
 * IT RENDERS THE POKEMON YOU OWN, NOT THE ONE YOU SPECIFIED
 * =========================================================================
 * A slot is a specification and the save is matched against it, so for an
 * `owned` or `close` slot there are two candidate answers to "what is this".
 * This used to give the SPEC's, and that was wrong in a way that only showed
 * up as a number: the battle tab computes damage off `stats`, so a core whose
 * spec froze at level 32 kept calculating for a level-32 Mewtwo long after
 * the real one hit 33. Every figure on the page -- damage, the speed ladder,
 * the level-curve chart -- was for a Pokemon that no longer existed.
 *
 * `build_sheet.py` always read the live record, so the two implementations
 * disagreed on 16 fields; `tools/verify_blob.py` had been reporting it for
 * days as a suspected Battle Box duplicate. It was neither a duplicate nor a
 * decode bug -- just two honest answers to different questions.
 *
 * NOTHING IS LOST BY PREFERRING THE LIVE RECORD. What the spec WANTED is
 * still carried, and more precisely, by `diffs`: the caller turns it into
 * "Yours differs: level, ability." So the page says what you have, the number
 * is true of it, and the gap from the plan is stated rather than silently
 * split between the two.
 *
 * `missing` has no live record by definition, so it still renders the spec --
 * which is the point of a spec: to describe something before you own it.
 */
function specToMon(spec, S, where, live = null) {
  const sp = S.SPECIES[String(spec.speciesId)];
  if (live) {
    return {
      name: sp?.name ?? live.species,
      lvl: live.level,
      nat: live.nature ?? 'Hardy',
      ab: live.ability ?? (sp?.abilities?.[0] ?? '—'),
      item: live.item ?? null,
      types: sp?.types ?? live.types ?? [],
      moves: (live.moves ?? []).map((m) => m.name),
      shiny: Boolean(live.shiny),
      // The nickname off the record in THIS save, not the one captured into
      // the spec when the core was saved. Renaming something in the Factory
      // should show up on the battle tab.
      //
      // RAW, not gated on `isNicknamed`. An un-nicknamed Pokemon stores its
      // species name in caps ("GARCHOMP"), and whether to show that is the
      // renderer's call -- build_sheet.py passes it straight through, so
      // filtering it here would be this layer quietly deciding something the
      // other implementation does not.
      nick: live.nickname ?? '',
      box: where,
      stats: live.stats ? STAT_ORDER.map((k) => live.stats[k]) : specStats(spec, S),
    };
  }
  return {
    name: sp?.name ?? `#${spec.speciesId}`,
    lvl: spec.level,
    nat: NATURE_NAMES[spec.natureId] ?? 'Hardy',
    ab: spec.abilityId ? (S.ABILBYID[String(spec.abilityId)] ?? `#${spec.abilityId}`)
      : (sp?.abilities?.[0] ?? '—'),
    item: spec.itemId ? (S.ITEMS[String(spec.itemId)] ?? null) : null,
    types: sp?.types ?? [],
    moves: spec.moveIds.filter(Boolean).map((m) => S.MOVEBYID[String(m)] ?? `#${m}`),
    shiny: Boolean(spec.shiny),
    nick: spec.nickname || '',
    box: where,
    stats: specStats(spec, S),
  };
}

/**
 * Convert a Builder team into the battle sheet's team shape.
 * Returns null for a team with no slots -- an empty tab helps nobody.
 */
export function toBattleTeam(rawTeam, index, S, { taken = new Set() } = {}) {
  const team = normalizeTeam(rawTeam);
  if (!team.slots.length) return null;
  const matches = matchTeam(team, index, S, { taken });
  const specs = teamSpecs(team);

  const slots = team.slots.map((sl, i) => ({
    role: inferRole(sl.options[0], S, sl.role),
    why: sl.why || '',
    // THE SWAP YOU ARE ACTUALLY CARRYING, not always the first option.
    //
    // build_sheet.py has always opened a slot card on whichever alternative is
    // in your PARTY, and this hardcoded 0 -- so a slot whose third swap you had
    // fielded showed the plan on the sheet and the first option in the app,
    // with different damage numbers under each. The sheet's rule is the better
    // one: a card should open on what you have.
    defaultIdx: Math.max(0, matches[i].findIndex((m) => m.at?.loc === 'party')),
    // Every option becomes a swap card, exactly as TEAM_LAYOUT's do. The note
    // carries what the swap costs you AND, when it is not in the save as
    // specified, that fact -- both are things you want before fielding it.
    options: sl.options.map((spec, j) => {
      const m = matches[i][j];
      const where = m.state === 'missing' ? 'not in your save yet'
        : (m.at.loc === 'party' ? 'Party'
          : m.at.loc === 'battleBox' ? 'Battle Box' : `Box ${m.at.loc + 1}`);
      const state = m.state === 'owned' ? null
        : m.state === 'close' ? `Yours differs: ${m.diffs.map((d) => d.field).join(', ')}.`
          : 'Not built yet — the Team Builder can create it.';
      // Said out loud: this is the same Pokemon another team is also built on.
      const share = m.shared ? 'Shared — another team is built on this same copy.' : null;
      return {
        mon: specToMon(spec, S, where, m.state === 'missing' ? null : m.mon),
        badge: spec.badge || (j === 0 ? null : 'alternate'),
        note: [spec.note, state, share].filter(Boolean).join(' ') || null,
        rigged: spec.rigged || null,
      };
    }),
  }));

  // DETECTED **AND** DECLARED. Detection reads what the team actually carries
  // -- Drizzle, Rain Dance, Trick Room -- which is right for a team you just
  // built. It is not the whole answer for one you adopted: a roster can opt
  // into a condition nothing on it SETS, because the toggle is there to model
  // the fight (Trick Room's team wants sand and sun toggles for the weather
  // the opponent brings). Dropping the declared list silently took every
  // toggle off that team.
  const mech = new Set(rawTeam.mech ?? []);
  for (const spec of specs) {
    const ab = spec.abilityId ? S.ABILBYID[String(spec.abilityId)] : null;
    if (ab && WEATHER_ABILITY[ab] && WEATHER_ABILITY[ab] !== 'hail') mech.add(WEATHER_ABILITY[ab]);
    for (const mid of spec.moveIds.filter(Boolean)) {
      const w = WEATHER_MOVE[S.MOVEBYID[String(mid)]];
      if (w) mech.add(w);
    }
  }
  const tr = mech.has('tr') || Boolean(rawTeam.tr);
  mech.delete('tr');

  const grid = defensiveGrid(specs, S);
  const worst = grid.slice().sort((a, b) => b.worst - a.worst)[0];
  const gaps = offensiveGrid(specs, S).filter((c) => !c.covered);
  const primary = matches.map((ms) => ms[0]);
  const unbuilt = primary.filter((m) => m.state !== 'owned').length;
  const warn = [
    worst && worst.worst >= 2
      ? `${worst.type[0].toUpperCase()}${worst.type.slice(1)} hits ${worst.worst} of `
        + `${specs.length} for super-effective damage.`
      : null,
    gaps.length ? `No super-effective answer to ${gaps.map((g) => g.type).join(', ')}.` : null,
    unbuilt ? `${unbuilt} of ${specs.length} ${unbuilt === 1 ? 'is' : 'are'} not `
      + 'in your save as specified yet.' : null,
  ].filter(Boolean).join(' ') || 'No obvious hole — check it against the encounters below.';

  const owned = primary.filter((m) => m.state === 'owned').length;
  const inParty = primary.filter((m) => m.at?.loc === 'party').length;
  const noteLines = (team.notes ?? '').split('\n').map((l) => l.trim()).filter(Boolean);

  return {
    id: `builder-${team.id}`,
    name: team.name,
    where: inParty === specs.length ? 'fielded'
      : owned === specs.length ? 'all owned' : `${owned}/${specs.length} owned`,
    state: inParty === specs.length ? 'fielded' : owned ? 'partial' : 'split',
    tag: team.tag ?? '',
    coreBoxes: [], inParty, coreN: specs.length, swapBoxes: [],
    tr, mech: [...mech],
    tagline: noteLines[0] ?? 'Designed in the Team Builder.',
    // The computed warning is replaced, never merged: if you have written
    // what this team actually loses to, that is better information than
    // "Ground hits half your team", and showing both would bury yours.
    warn: team.warnNote?.trim() || warn,
    rigged: null,
    pilot: team.pilot?.length
      ? team.pilot.filter((c) => c.v.trim()).map((c) => ({ k: c.k || 'note', v: c.v }))
      : noteLines.slice(1).map((l, i) => ({ k: `Note ${i + 1}`, v: l })),
    slots,
    fromBuilder: true,
  };
}

/**
 * Seed a team from Pokémon you already own -- your party, a box, or an
 * existing battle-companion roster. Building a team from scratch when the
 * core already exists in the save is the long way round.
 */
export function teamFromMons(name, mons) {
  return {
    ...blankTeam(name),
    slots: mons.slice(0, MAX_SLOTS).map((mon) => ({
      role: null, why: '', options: [{ badge: '', note: '', ...monToSpec(mon) }],
    })),
  };
}


/**
 * Every saved team worth showing on the battle tab.
 *
 * Reads BOTH stores. localStorage alone was not enough: a team saved to the
 * repo on one machine, or in a browser whose site data was since cleared,
 * exists only in state/teams.json, and the battle tab would silently show
 * nothing. `extra` is whatever the caller fetched from there.
 */
/**
 * Your current party, as a battle tab. Always present, always first.
 *
 * Someone may never touch teams or cores and just want to see how what they
 * are actually carrying holds up against the next gym. That case should need
 * no setup at all, so this is synthesised from the save every time rather
 * than being something you have to create and maintain.
 *
 * It routes through the same conversion as any other team, so the damage
 * calc, coverage warnings and weather detection all apply -- and the stats
 * are the ones specStats() produces, which are verified against the game's
 * own numbers for every Pokemon in the save.
 */
export function partyTeam(index, S) {
  const mons = index.filter((x) => x.loc === 'party').map((x) => x.mon);
  if (!mons.length) return null;
  const t = teamFromMons('Your party', mons);
  t.notes = 'Whatever you are carrying right now. Rebuilt from the save every time — '
    + 'nothing to maintain.';
  const bt = toBattleTeam(t, index, S);
  if (!bt) return null;
  bt.id = 'live-party';
  bt.where = 'fielded';
  bt.state = 'fielded';
  bt.live = true;
  return bt;
}

/**
 * Everything worth a battle tab: teams AND cores.
 *
 * Cores were excluded at first, on the theory that they were ingredients
 * rather than teams. That was backwards. A core is the line-up you ADOPTED --
 * of course it is the one you want to check against a gym. Promotion moves a
 * team rather than copying it, so nothing appears twice.
 */
export function battleTeams(trainerId, index, S, extra = []) {
  const all = living(merge(loadLocal(trainerId), extra)).map(normalizeTeam);
  // ONE claim set for the whole assembly, so a duplicate species resolves to a
  // DIFFERENT record in each team that wants one -- the behaviour
  // build_sheet.py has always had. Without it the port matched every team
  // against the full save independently, and two teams asking for the same
  // species both got the first copy. It only ever showed on two Wobbuffets
  // that were identical apart from their nickname, because every other
  // duplicate was told apart by its spec; tools/verify_blob.py caught it once
  // the nickname stopped being a whitelisted difference.
  //
  // CORES CLAIM FIRST. A core is a line-up you have SETTLED on; a team is
  // still an experiment. When both want the same Slowking the settled one
  // should have it, or a scratchpad you were poking at last week quietly
  // takes a Pokémon out of the roster you actually play -- which is what
  // happened the first time a living non-core team existed. It also makes the
  // app agree with the published sheet, which assembles cores alone.
  //
  // Resolution order is not display order: the tabs come back in the order
  // they were merged in.
  const taken = new Set();
  const order = [...all.keys()].sort((a, b) => Number(isCore(all[b])) - Number(isCore(all[a])));
  const built = new Array(all.length);
  for (const i of order) built[i] = toBattleTeam(all[i], index, S, { taken });
  return all.map((t, i) => {
    const bt = built[i];
    if (bt && isCore(t)) {
      bt.id = `core-${t.id}`;
      bt.adopted = true;
      // The sheet shows `where` next to the name; say which shelf it is on.
      bt.where = `core · ${bt.where}`;
    }
    return bt;
  }).filter(Boolean);
}

/** Teams that will NOT appear on the battle tab, and why. */
export function unexportable(trainerId, extra = []) {
  return onlyTeams(merge(loadLocal(trainerId), extra)).map(normalizeTeam)
    .filter((t) => !t.slots.length)
    .map((t) => ({ name: t.name, reason: 'it has no slots yet' }));
}

/**
 * Move a slot to a new position.
 *
 * SLOT ORDER IS NOT COSMETIC. It is the order the battle sheet lists the team
 * in, the order `fieldCore()` writes into the party, and therefore the order
 * you lead with in game. Being unable to say "this one goes first" meant
 * rebuilding a slot to move it.
 *
 * Returns a NEW slots array rather than splicing in place: the caller holds a
 * team object that other code may be reading, and an in-place reorder during a
 * render is the kind of thing that shows up as one card drawn twice.
 */
export function reorderSlots(slots, from, to) {
  const n = (slots ?? []).length;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return slots;
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return slots;
  const out = slots.slice();
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

/** Turn a Pokemon you own into a spec, for "start from this one". */
export function monToSpec(mon) {
  return {
    speciesId: mon.speciesId,
    role: null,
    why: '',
    nickname: mon.isNicknamed ? mon.nickname : '',
    level: mon.level ?? 50,
    natureId: mon.natureId,
    abilityId: mon.abilityId,
    gender: mon.gender,
    shiny: mon.shiny,
    itemId: mon.itemId ?? 0,
    moveIds: [0, 1, 2, 3].map((i) => mon.moveIds[i] ?? 0),
    ivs: { ...mon.ivs },
    evs: { ...mon.evs },
  };
}
