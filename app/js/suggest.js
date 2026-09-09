/**
 * suggest.js -- what to put in a slot, and why.
 *
 * =========================================================================
 * TASTE IS A CONSTRAINT, NOT A WEIGHTING
 * =========================================================================
 * The obvious design is a score: rank every species by w·features, with w
 * tuned to the player. It is the wrong one here, and the teams in this repo
 * are the proof. Edgelord, My Uncle Works at Nintendo, Contrary Engine, Sun
 * King -- there is no setting of weights over power features under which
 * Superpower-spam is optimal. Those teams are not points on a
 * power/preference tradeoff. They are PREMISES: everything must have
 * Contrary; everything must be Dark; nothing legendary; only things I caught
 * myself.
 *
 * So the three parts do very different jobs, and the least trustworthy one is
 * given the least to do:
 *
 *   PREMISE     filters the candidates   inferred from the slots already
 *                                        filled, and shown so you can correct
 *                                        it -- never guessed at silently
 *   POWER       ranks within the filter  computed from the ROM: types, real
 *                                        stats, speed, against the fights you
 *                                        have not cleared
 *   PREFERENCE  breaks ties              not fitted yet. `state/teams.json`
 *                                        holds 41 real choices at a mean set
 *                                        size of 2.5, which is not enough to
 *                                        fit anything worth trusting. It also
 *                                        holds 80 written reasons, which is
 *                                        twice the signal and the better place
 *                                        to start. Neither is used here.
 *
 * =========================================================================
 * WHY THIS DOES NOT CALL THE BATTLE TAB'S SEARCH
 * =========================================================================
 * The Markov search in sheet_template.html would give a better power number.
 * It cannot be imported: the template has to stay a standalone file because
 * the published artifact has no modules, so anything it uses lives inside it.
 * Porting it here would make two implementations of one question, which this
 * project has been bitten by before.
 *
 * The answer is to ask a COARSER question rather than the same one twice.
 * Choosing a team member is not choosing a move: what matters is whether a
 * Pokémon resists what they throw, threatens what they bring, and moves
 * first. That is types, real stats and speed -- no damage formula, no third
 * copy of it -- and the suggestion says so, and points at the battle tab for
 * the exact numbers.
 */

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

/** Effectiveness of one attacking type against a list of defending types. */
export function effOf(atk, types, S) {
  return types.reduce((m, d) => m * (S.CHART[atk]?.[d] ?? 1), 1);
}

/** name -> species id, built once from SPNAME. Opponents are named, not keyed. */
export function nameIndex(S) {
  const out = new Map();
  for (const [id, name] of Object.entries(S.SPNAME ?? {})) out.set(name, Number(id));
  return out;
}

/** An opponent's Speed at its level, on this page's standing 31/0/neutral. */
export function foeSpeed(sp, level) {
  if (!sp) return null;
  return Math.floor((2 * sp.base.spe + 31) * level / 100) + 5;
}

/**
 * The types a spec can actually attack with.
 *
 * Two answers, and which one you get is worth saying out loud. A spec that
 * carries real moves is read from those moves -- that is what it DOES. A bare
 * species is read from its level-up learnset up to that level plus its own
 * STAB, which is what it COULD do, and is marked `potential` so the reason
 * does not overclaim.
 */
export function attackTypes(spec, S) {
  const sp = S.SPECIES[String(spec.speciesId)];
  if (!sp) return { types: [], potential: false };
  const real = (spec.moveIds ?? []).filter(Boolean)
    .map((m) => S.MOVES[S.MOVEBYID[String(m)]])
    .filter((d) => d && d.c !== 'status' && d.p > 1)
    .map((d) => d.t);
  if (real.length) return { types: [...new Set(real)], potential: false };
  const learn = (sp.lvl ?? [])
    .filter(([lv]) => lv <= (spec.level ?? 50))
    .map(([, id]) => S.MOVES[S.MOVEBYID[String(id)]])
    .filter((d) => d && d.c !== 'status' && d.p > 1)
    .map((d) => d.t);
  return { types: [...new Set([...sp.types, ...learn])], potential: true };
}

/** An opponent's stats at its level, on the standing 31/0/neutral assumption. */
export function foeStats(sp, level) {
  const st = {};
  for (const k of STAT_KEYS) {
    const core = Math.floor((2 * sp.base[k] + 31) * level / 100);
    st[k] = k === 'hp' ? core + level + 10 : core + 5;
  }
  return st;
}

/**
 * How one spec fares against one opposing Pokémon.
 *
 * PRESSURE, NOT TYPE ALONE. The first version of this counted type
 * effectiveness and nothing else, and the top suggestion for a rain team was
 * Wingull -- super-effective on eight of eighteen and incapable of hurting any
 * of them. A type chart says what a hit is multiplied BY; it says nothing
 * about what there was to multiply.
 *
 * So each side gets a ratio: its best offensive stat over the defensive stat
 * that would actually receive it, times the type multiplier. That is real
 * stats at real levels and still no damage formula -- see the header for why
 * there is no third copy of one.
 */
export function matchup(spec, foe, S, atk = null) {
  const sp = S.SPECIES[String(spec.speciesId)];
  const fsp = foe.sp;
  if (!sp || !fsp) return null;
  const mine = sp.types, theirs = fsp.types;
  const worstIn = Math.max(...theirs.map((t) => effOf(t, mine, S)), 0);
  const a = atk ?? attackTypes(spec, S);
  const bestOut = Math.max(...a.types.map((t) => effOf(t, theirs, S)), 0);

  const s = specStatsOf(spec, S);
  const me = { hp: s[0], atk: s[1], def: s[2], spa: s[3], spd: s[4], spe: s[5] };
  const them = foeStats(fsp, foe.level);
  // Whichever attacking stat is bigger decides which defence receives it.
  const myPhys = me.atk >= me.spa, theirPhys = them.atk >= them.spa;
  const out = (myPhys ? me.atk / them.def : me.spa / them.spd) * bestOut;
  const inc = (theirPhys ? them.atk / me.def : them.spa / me.spd) * worstIn;

  return {
    name: fsp.name,
    out, inc,
    walls: inc <= 0.6,
    immune: worstIn === 0,
    threatened: inc >= 2,
    covers: out >= 2,
    blanked: bestOut === 0,
    outspeeds: foe.spe != null && me.spe > foe.spe,
    potential: a.potential,
  };
}

/** Local copy of teams.js's stat maths, so this module imports nothing. */
export function specStatsOf(spec, S) {
  const sp = S.SPECIES[String(spec.speciesId)];
  if (!sp) return [0, 0, 0, 0, 0, 0];
  const raised = Math.floor((spec.natureId ?? 0) / 5), lowered = (spec.natureId ?? 0) % 5;
  const NAT = ['atk', 'def', 'spe', 'spa', 'spd'];
  return STAT_KEYS.map((k) => {
    const iv = spec.ivs?.[k] ?? 31, ev = spec.evs?.[k] ?? 0;
    const core = Math.floor((2 * sp.base[k] + iv + Math.floor(ev / 4)) * (spec.level ?? 50) / 100);
    if (k === 'hp') return spec.speciesId === 292 ? 1 : core + (spec.level ?? 50) + 10;
    let v = core + 5;
    if (raised !== lowered) {
      if (NAT[raised] === k) v = Math.floor(v * 11 / 10);
      else if (NAT[lowered] === k) v = Math.floor(v * 9 / 10);
    }
    return v;
  });
}

/**
 * WHICH FIGHTS TO JUDGE AGAINST.
 *
 * The first three you have not ticked off, which is right the moment any are
 * ticked. With NONE ticked it is wrong in a way that quietly ruins the
 * suggestions: story order starts at the first rival, so a level-50 team gets
 * ranked against five level-7 Pokémon and every candidate beats all of them.
 * Every card then reads "threatens 5 of the 5, outruns 5 of them" and the list
 * stops discriminating -- which is what it looked like on a fresh profile.
 *
 * So with no progress marked, fall back to the fights nearest the team's own
 * level. That needs nothing from the player and is a better guess than "you
 * have not started".
 */
export function fightsToJudge(all, cleared, teamLevel, n = 3) {
  const left = (all ?? []).filter((e) => !cleared?.[e.key]);
  if (!left.length) return [];
  const anyCleared = (all ?? []).some((e) => cleared?.[e.key]);
  if (anyCleared || !teamLevel) return left.slice(0, n);
  const dist = (e) => Math.abs((e.lvmax ?? 50) - teamLevel);
  return [...left].sort((a, b) => dist(a) - dist(b)).slice(0, n)
    .sort((a, b) => (a.lvmax ?? 0) - (b.lvmax ?? 0));
}

/** Flatten the fights you have not cleared into the Pokémon in them. */
export function foesOf(fights, S) {
  const idx = nameIndex(S);
  const out = [];
  for (const f of fights ?? []) {
    for (const o of f.team ?? []) {
      const sp = S.SPECIES[String(idx.get(o.n))];
      if (!sp) continue;
      const level = parseInt(o.l, 10) || f.lvmax || 50;
      out.push({ n: o.n, sp, level, spe: foeSpeed(sp, level), from: f.leader });
    }
  }
  return out;
}

/** Totals across every foe, which is what the reasons are counted from. */
export function scoreAgainst(spec, foes, S) {
  const atk = attackTypes(spec, S);
  const per = foes.map((f) => matchup(spec, f, S, atk)).filter(Boolean);
  const n = (k) => per.filter((m) => m[k]).length;
  const tally = { walls: n('walls'), immune: n('immune'), threatened: n('threatened'),
    covers: n('covers'), blanked: n('blanked'), outspeeds: n('outspeeds'),
    total: per.length, potential: atk.potential };
  /* The weights are stated rather than tuned: covering something is worth
     more than walling it, being outsped is worth as much as being resisted,
     and being threatened costs double because a fainted Pokémon does nothing
     else on the list. Nothing here is fitted -- see the header. */
  tally.score = tally.covers * 2 + tally.walls + tally.outspeeds - tally.threatened * 2;
  return { per, ...tally };
}

// ===========================================================================
// PREMISES
// ===========================================================================
/**
 * What the team already filled in says about what it is FOR.
 *
 * Each premise is detected from the specs, carries the evidence it was
 * detected from, and hands back a `test` the candidate list is filtered by.
 * Nothing here is a guess the app acts on quietly: the UI shows what it
 * inferred and lets you drop it, which is the whole reason a premise is a
 * separate thing from a score.
 */
const WEATHER_ABIL = { Drizzle: 'rain', Drought: 'sun', 'Sand Stream': 'sand', 'Snow Warning': 'hail' };
const WEATHER_RIDER = { 'Swift Swim': 'rain', 'Rain Dish': 'rain', 'Dry Skin': 'rain',
  Chlorophyll: 'sun', 'Solar Power': 'sun', 'Leaf Guard': 'sun', 'Flower Gift': 'sun',
  'Sand Rush': 'sand', 'Sand Force': 'sand', 'Sand Veil': 'sand',
  'Ice Body': 'hail', 'Snow Cloak': 'hail' };
const CONTRARY = new Set(['Contrary', 'Simple', 'Defiant', 'Competitive']);

/**
 * Legendary, inferred -- the personal table carries no flag for it.
 *
 * Egg group 15 is Undiscovered: 67 species that cannot breed. That alone is
 * not enough (it holds the babies, Unown and the Nidoran line), but with a
 * base-stat floor it is exact for this ROM: 46 species, lowest kept 580,
 * highest dropped 520. Catch rate -- the obvious guess -- does not work at
 * all, since Metagross is 3 while Zekrom is 45.
 */
export const UNDISCOVERED = 15;
export const LEGEND_BST = 570;
export function isLegendary(id, S) {
  const sp = S.SPECIES[String(id)];
  if (!sp) return false;
  return (sp.eggs ?? []).includes(UNDISCOVERED) && (sp.bst ?? 0) >= LEGEND_BST;
}

/* ABILITY 0 IS "--", THE ABSENCE OF ONE, AND IT IS NOT SOMETHING TO SHARE.
   A team of four specs that had never had an ability chosen all read as
   carrying `--`, the gimmick premise fired on it, and the filter then asked
   for candidates whose species lists `--` -- which is none of them. Zero
   suggestions, from a premise nobody has. */
const abilOf = (spec, S) => {
  const a = S.ABILBYID?.[String(spec.abilityId)] ?? null;
  return a && a !== '--' ? a : null;
};
const speciesAbils = (id, S) => S.SPECIES[String(id)]?.abilities ?? [];

export const PREMISES = [
  {
    id: 'monotype',
    detect(specs, S) {
      const sets = specs.map((s) => S.SPECIES[String(s.speciesId)]?.types ?? []);
      if (sets.length < 2) return null;
      const shared = sets[0].filter((t) => sets.every((x) => x.includes(t)));
      if (!shared.length) return null;
      const t = shared[0];
      return { label: `mono-${t}`,
        why: `every slot you have filled is ${t}`,
        test: (id) => (S.SPECIES[String(id)]?.types ?? []).includes(t) };
    },
  },
  {
    id: 'gimmick',
    detect(specs, S) {
      // A shared ability across the team, whether or not it is one of the
      // famous ones -- a Contrary team and a Levitate team are the same idea.
      const names = specs.map((s) => abilOf(s, S)).filter(Boolean);
      if (names.length < 2 || new Set(names).size !== 1) return null;
      const a = names[0];
      return { label: `every one has ${a}`,
        why: `all ${names.length} filled slots carry ${a}`
          + (CONTRARY.has(a) ? ' — the whole point of the team' : ''),
        test: (id) => speciesAbils(id, S).includes(a)
          || S.SPECIES[String(id)]?.hidden === a };
    },
  },
  {
    id: 'weather',
    detect(specs, S) {
      const w = specs.map((s) => {
        const a = abilOf(s, S);
        return WEATHER_ABIL[a] ?? WEATHER_RIDER[a] ?? null;
      }).filter(Boolean);
      if (w.length < 2 || new Set(w).size !== 1) return null;
      const kind = w[0];
      const ok = (id) => [...speciesAbils(id, S), S.SPECIES[String(id)]?.hidden]
        .some((a) => WEATHER_ABIL[a] === kind || WEATHER_RIDER[a] === kind);
      return { label: `${kind} team`,
        why: `${w.length} filled slots set or ride ${kind}`,
        test: ok };
    },
  },
  {
    id: 'nolegend',
    detect(specs, S) {
      /* There is no legendary FLAG in the personal table, so it has to be
         inferred -- and catch rate, the obvious guess, does not work: Metagross
         is 3 while Zekrom is 45 and Kyogre is 5. What DOES separate them is the
         Undiscovered egg group plus a floor on base stats. 67 species cannot
         breed; 46 of them are over 570 BST and every one is a legendary, and
         the 21 below are the babies, Unown and the Nidoran line. The boundary
         is not close: the lowest kept is 580 and the highest dropped is 520. */
      if (specs.length < 3) return null;
      if (specs.some((s) => isLegendary(s.speciesId, S))) return null;
      return { label: 'nothing legendary',
        why: `none of your ${specs.length} filled slots is one`,
        test: (id) => !isLegendary(id, S) };
    },
  },
  {
    id: 'bstcap',
    detect(specs, S) {
      if (specs.length < 3) return null;
      const bs = specs.map((s) => S.SPECIES[String(s.speciesId)]?.bst ?? 0);
      const hi = Math.max(...bs);
      if (hi >= 540) return null;                 // no self-imposed ceiling
      const cap = Math.min(600, hi + 20);
      return { label: `nothing over ${cap} BST`,
        why: `your biggest filled slot is ${hi}`,
        test: (id) => (S.SPECIES[String(id)]?.bst ?? 0) <= cap };
    },
  },
  {
    id: 'owned',
    detect(specs, S, ctx) {
      const ms = ctx?.matches;
      if (!ms || !ms.length || ms.length !== specs.length) return null;
      if (!ms.every((m) => m && m.state === 'owned')) return null;
      const own = ctx.ownedIds ?? new Set();
      if (!own.size) return null;
      return { label: 'only what you already own',
        why: `all ${specs.length} filled slots are Pokémon in your save`,
        test: (id) => own.has(id) };
    },
  },
];

/**
 * Every premise the filled slots support, strongest evidence first.
 *
 * `specs` is the slots that are actually decided -- an empty team says
 * nothing, and neither does one slot.
 */
export function inferPremise(specs, S, ctx = {}) {
  const filled = (specs ?? []).filter((s) => s && s.speciesId);
  if (filled.length < 2) return [];
  const out = [];
  for (const p of PREMISES) {
    let hit = null;
    try { hit = p.detect(filled, S, ctx); } catch { hit = null; }
    if (hit) out.push({ id: p.id, ...hit, from: filled.length });
  }
  return out;
}

// ===========================================================================
// WHAT A SWAP COSTS
// ===========================================================================
/**
 * The types this team resists, and the types it can hit for extra damage.
 * Used twice -- with the slot and without it -- so the difference IS the cost.
 */
export function teamCover(specs, S) {
  const res = new Set(), hit = new Set();
  for (const sp of specs) {
    const s = S.SPECIES[String(sp.speciesId)];
    if (!s) continue;
    for (const t of S.TYPES) if (effOf(t, s.types, S) < 1) res.add(t);
    for (const t of attackTypes(sp, S).types) {
      for (const d of S.TYPES) if ((S.CHART[t]?.[d] ?? 1) > 1) hit.add(d);
    }
  }
  return { res, hit };
}

/** What only this slot was providing -- which is exactly what dropping it costs. */
export function soleContribution(specs, i, S) {
  const all = teamCover(specs, S);
  const without = teamCover(specs.filter((_, k) => k !== i), S);
  return {
    res: [...all.res].filter((t) => !without.res.has(t)),
    hit: [...all.hit].filter((t) => !without.hit.has(t)),
  };
}

// ===========================================================================
// THE SUGGESTION
// ===========================================================================
/**
 * Rank candidates for one slot, with the reason and the cost spelled out.
 *
 * `ctx.candidates` is a list of {speciesId, spec} -- the caller decides where
 * they come from, because "what you own" and "what is catchable next" and
 * "all 649" are three different questions and only the caller knows which was
 * asked. Ranking 649 badly is worse than ranking thirty well.
 */
export function suggestForSlot(team, i, S, ctx = {}) {
  const slots = team.slots ?? [];
  const others = slots.map((sl) => sl.options?.[0]).filter((s, k) => k !== i && s?.speciesId);
  const current = slots[i]?.options?.[0] ?? null;
  const foes = ctx.foes ?? [];
  const premises = (ctx.premises ?? inferPremise(others, S, ctx)).filter((p) => !p.off);

  const withCur = others.slice();
  if (current?.speciesId) withCur.splice(Math.min(i, withCur.length), 0, current);
  const lost = current?.speciesId
    ? soleContribution(withCur, Math.min(i, withCur.length - 1), S)
    : { res: [], hit: [] };
  const base = teamCover(others, S);
  /* Too little team to fit anything around. Not an error -- a different
     question, and one the panel has to be told it is answering. */
  const thin = others.length < 2;

  const rows = [];
  for (const c of ctx.candidates ?? []) {
    /* A bare candidate is judged at the level the CALLER names -- normally the
       level of the fights it is being judged against. Leaving it at the
       current slot's level compares a level-30 idea against a level-53 gym. */
    const spec = c.spec ?? { ...(current ?? {}), speciesId: c.speciesId,
      level: ctx.level ?? current?.level ?? 50,
      moveIds: [0, 0, 0, 0], abilityId: 0 };
    if (!S.SPECIES[String(spec.speciesId)]) continue;
    if (current && spec.speciesId === current.speciesId && !c.spec) continue;
    if (!premises.every((p) => p.test(spec.speciesId))) continue;

    const sc = scoreAgainst(spec, foes, S);
    const after = teamCover([...others, spec], S);
    const gainRes = [...after.res].filter((t) => !base.res.has(t));
    const gainHit = [...after.hit].filter((t) => !base.hit.has(t));

    /* WHY, and WHAT IT COSTS. The second half is what makes it a suggestion
       rather than an advert, and it is the idiom the swap tree already uses:
       every option carries a note saying what taking it gives up. */
    const why = [];
    /* "NOTHING ELSE HERE RESISTS IT" IS VACUOUS WHEN THERE IS NOTHING ELSE.
       With one slot filled every type is uncovered, so every candidate earns
       every coverage reason and five cards read identically -- the suggester
       being loudly confident about a team it cannot see yet. Below two other
       slots the coverage half is dropped and `thin` is reported, so the panel
       can say what it is actually ranking on. */
    if (!thin && gainRes.length) why.push(`covers ${gainRes.join(', ')} — nothing else here resists ${gainRes.length > 1 ? 'them' : 'it'}`);
    if (!thin && gainHit.length) why.push(`hits ${gainHit.join(', ')} for extra damage, which the rest cannot`);
    if (foes.length) {
      if (sc.covers) why.push(`threatens ${sc.covers} of the ${sc.total} you have left to face`);
      if (sc.walls) why.push(`takes little from ${sc.walls} of them`);
      if (sc.outspeeds) why.push(`outruns ${sc.outspeeds} of them`);
    }
    const cost = [];
    for (const t of lost.res) if (!after.res.has(t)) cost.push(`no one left resists ${t}`);
    for (const t of lost.hit) if (!after.hit.has(t)) cost.push(`nothing left hits ${t} hard`);
    if (foes.length && sc.threatened) {
      cost.push(`${sc.threatened} of them hit it hard`);
    }
    rows.push({ spec, speciesId: spec.speciesId,
      name: S.SPECIES[String(spec.speciesId)].name,
      owned: !!c.spec,
      score: sc.score + (thin ? 0 : gainRes.length * 2 + gainHit.length),
      tally: sc, why, cost, potential: sc.potential });
  }
  rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return { premises, rows, lost, thin, filled: others.length };
}
