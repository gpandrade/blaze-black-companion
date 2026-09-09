/**
 * verify_suggest.mjs -- the Team Builder's suggester.
 *
 *     node tools/verify_suggest.mjs
 *
 * Why this file asserts what it does: notes/teams-and-cores.md, "Taste is a
 * constraint, not a weighting".
 *
 * =============================================================================
 * THE THINGS THAT MUST NOT BE TRUE
 * =============================================================================
 *   A SUGGESTION THAT IS TYPE-CORRECT AND USELESS. The first version ranked on
 *   type effectiveness alone and put Wingull and Luvdisc at the top of a rain
 *   team: super-effective on eight of eighteen and incapable of hurting any of
 *   them. A type chart says what a hit is multiplied BY, never what there was
 *   to multiply. Pinned by asserting the strong version of a species outranks
 *   the weak one it evolves from.
 *
 *   A PREMISE INVENTED OUT OF NOTHING. The filter decides what the player is
 *   even shown, so a premise that fires on a team that does not have one is
 *   worse than no premise at all. Asserted against the real store: the three
 *   teams built on a mechanic are detected, and the three that are collections
 *   are left alone.
 *
 *   A SUGGESTION WITH NO COST. The second half is what makes it a suggestion
 *   rather than an advert, and it is the half a later tidy-up would drop.
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

const SG = await import('../app/js/suggest.js');
const S = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/data/static.json'), 'utf8'));
const byName = new Map(Object.entries(S.SPECIES).map(([id, v]) => [v.name, Number(id)]));
const spec = (name, over = {}) => ({
  speciesId: byName.get(name), level: 50, natureId: 0, moveIds: [0, 0, 0, 0],
  abilityId: 0, ivs: {}, evs: {}, ...over,
});

let store = [];
try {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'state/teams.json'), 'utf8'));
  store = (Array.isArray(raw) ? raw : raw.teams ?? []).filter((t) => !t.deleted);
} catch { /* a fresh checkout has no team store; the checks below skip */ }

// =========================================================================
console.log('── legendaries, inferred from a table that does not flag them');
{
  const leg = Object.keys(S.SPECIES).filter((id) => SG.isLegendary(Number(id), S));
  ok('the marker finds a plausible number of them', leg.length > 30 && leg.length < 60,
    `${leg.length} species`);
  const is = (n) => SG.isLegendary(byName.get(n), S);
  // CATCH RATE DOES NOT WORK, and these are the pairs that prove it: Metagross
  // is rate 3 and ordinary, Zekrom is 45 and not.
  ok('...and is not fooled by catch rate in either direction',
    is('Zekrom') && is('Kyogre') && !is('Metagross'),
    'Zekrom is rate 45, Kyogre 5, Metagross 3');
  ok('...gets the obvious ones right',
    ['Mewtwo', 'Rayquaza', 'Dialga', 'Ho-Oh', 'Kyurem'].every(is));
  ok('...and leaves ordinary Pokémon alone',
    !['Garchomp', 'Dragonite', 'Slowking', 'Tyranitar', 'Slaking'].some(is),
    'Slaking is 670 BST and not legendary');
  // The Undiscovered group also holds the babies and the Nidoran line, which
  // is exactly why the base-stat floor is there.
  ok('...and does not sweep in the babies that also cannot breed',
    !['Pichu', 'Cleffa', 'Togepi', 'Elekid', 'Nidoqueen', 'Unown'].some(is));
}

// =========================================================================
console.log('\n── premises are detected, not invented');
{
  ok('two slots or fewer say nothing at all',
    SG.inferPremise([spec('Slowking')], S).length === 0
    && SG.inferPremise([], S).length === 0);

  const mono = ['Houndoom', 'Umbreon', 'Absol', 'Spiritomb'].map((n) => spec(n));
  const p = SG.inferPremise(mono, S).find((x) => x.id === 'monotype');
  ok('a mono-type team is seen as one', !!p && /dark/.test(p.label), p?.label);
  ok('...and the filter it hands back actually filters',
    !!p && p.test(byName.get('Absol')) && !p.test(byName.get('Slowking')));

  const mixed = ['Slowking', 'Garchomp', 'Ferrothorn', 'Arcanine'].map((n) => spec(n));
  // NOT JUST "no monotype". The first version of this checked only that, and
  // passed while the gimmick premise was firing on `--` -- the null ability
  // that every spec without a chosen one carries. A premise nobody has is
  // worse than none: it filtered the candidate list down to zero.
  ok('a team with nothing in common is left alone',
    !SG.inferPremise(mixed, S).some((x) => ['monotype', 'gimmick', 'weather'].includes(x.id)),
    SG.inferPremise(mixed, S).map((x) => x.label).join(' · ') || 'none');
  ok('...and having no ability chosen is not a shared ability',
    !SG.inferPremise(['Slowking', 'Garchomp', 'Ferrothorn', 'Arcanine']
      .map((n) => spec(n, { abilityId: 0 })), S).some((x) => x.id === 'gimmick'),
    'ability 0 is "--", the absence of one');

  // The legendary premise is about an ABSENCE, so it must not fire on a team
  // too small for the absence to mean anything.
  const three = ['Slowking', 'Garchomp', 'Ferrothorn'].map((n) => spec(n));
  ok('"nothing legendary" fires on an absence across enough slots',
    SG.inferPremise(three, S).some((x) => x.id === 'nolegend'));
  ok('...and not when there is a legendary in the team',
    !SG.inferPremise([...three, spec('Kyogre')], S).some((x) => x.id === 'nolegend'));
}

// =========================================================================
console.log('\n── against the real store, which is the only honest test of it');
if (store.length >= 4) {
  const nameOf = (t) => t.name ?? '';
  const specsOf = (t) => (t.slots ?? []).map((sl) => sl.options?.[0])
    .filter((s) => s?.speciesId);
  const found = new Map();
  for (const t of store) found.set(nameOf(t), SG.inferPremise(specsOf(t), S).map((p) => p.id));

  const has = (n, id) => (found.get(n) ?? []).includes(id);
  // The three teams built ON a mechanic must be recognised as such.
  const gimmicks = [['Contrary Engine', 'gimmick'], ['Rain1', 'weather'], ['Sun King', 'weather']];
  for (const [n, id] of gimmicks) {
    if (!found.has(n)) continue;
    ok(`"${n}" is recognised as a ${id} team`, has(n, id),
      (found.get(n) ?? []).join(' · ') || 'nothing detected');
  }
  // ...and the ones that are collections rather than premises must NOT get a
  // mechanical one invented for them. A filter applied to a team that has no
  // premise is the failure that hides the good suggestions.
  for (const n of ['My Uncle Works at Nintendo', 'Mewtwo', 'Gengar']) {
    if (!found.has(n)) continue;
    ok(`"${n}" gets no mechanical premise invented for it`,
      !has(n, 'gimmick') && !has(n, 'weather') && !has(n, 'monotype'),
      (found.get(n) ?? []).join(' · ') || 'none');
  }
  ok('at least one team in the store is left with no premise at all',
    [...found.values()].some((v) => v.length === 0),
    'otherwise the detector is firing on everything');
} else {
  /* NO STORE IS A CLEAN CLONE, NOT A REGRESSION. state/teams.json is
     gitignored -- saved teams are personal -- and it only appears once the app
     has run and adopted the shipped rosters, which needs a save. Failing here
     turned ./test-all red on a fresh checkout for a check that had nothing to
     read. Loud skip: what it cannot check, it says it cannot check. */
  console.log('  [SKIP] premise detection against real teams'
    + ' — state/teams.json absent, run the app once');
}

// =========================================================================
console.log('\n── power is stats, not just the type chart');
{
  const fights = (S.OPPONENTS.oshawott ?? []).filter((f) => f.kind === 'gym').slice(3, 6);
  const foes = SG.foesOf(fights, S);
  ok('the fights resolve into Pokémon with levels and Speed',
    foes.length > 10 && foes.every((f) => f.sp && f.level > 0 && f.spe > 0),
    `${foes.length} from ${fights.map((f) => f.leader).join(', ')}`);

  const lvl = Math.round(foes.reduce((a, f) => a + f.level, 0) / foes.length);
  const at = (n) => SG.scoreAgainst(spec(n, { level: lvl }), foes, S);
  // THE FAILURE THIS EXISTS FOR. Wingull and Pelipper share a typing exactly,
  // so on type alone they are identical; Pelipper has 60 more BST in the right
  // places. If the score cannot tell them apart it is a type chart with extra
  // steps.
  const wing = at('Wingull'), peli = at('Pelipper');
  ok('two Pokémon with the same typing are not scored the same',
    peli.score > wing.score,
    `Wingull ${wing.score} vs Pelipper ${peli.score} — identical types`);
  // ...and asserted at the MATCHUP, because the line above can be satisfied by
  // Speed alone: strip the stats out of the pressure and Pelipper still
  // outruns more things, so the score still differs and the check still
  // passes. What must differ is how hard each of them actually hits.
  {
    const foe = foes[0];
    const w = SG.matchup(spec('Wingull', { level: lvl }), foe, S);
    const p2 = SG.matchup(spec('Pelipper', { level: lvl }), foe, S);
    ok('...and the difference is in the pressure, not only the Speed',
      p2.out > w.out + 1e-9 && p2.inc < w.inc - 1e-9,
      `vs ${foe.n}: out ${w.out.toFixed(2)} → ${p2.out.toFixed(2)}, `
      + `in ${w.inc.toFixed(2)} → ${p2.inc.toFixed(2)}`);
  }
  // Same test through the evolution line, where the typing is also identical.
  const pairs = [['Magikarp', 'Gyarados'], ['Metapod', 'Butterfree'], ['Bagon', 'Salamence']];
  const wrong = pairs.filter(([a, b]) => at(b).score <= at(a).score);
  ok('...and evolving into something better scores better',
    wrong.length === 0, wrong.map(([a, b]) => `${a} >= ${b}`).join(', ')
      || pairs.map(([a, b]) => `${a}→${b}`).join(' '));

  // A spec with real moves is read from them; a bare species from what it can
  // learn -- and the difference is flagged so a reason cannot overclaim.
  const bare = SG.attackTypes(spec('Slowking'), S);
  ok('a bare species is judged on what it could learn, and says so',
    bare.potential && bare.types.length > 0, `${bare.types.length} types`);
  const surf = Object.entries(S.MOVEBYID).find(([, n]) => n === 'Surf')?.[0];
  const real = SG.attackTypes(spec('Slowking', { moveIds: [Number(surf), 0, 0, 0] }), S);
  ok('...and one with real moves is judged on those',
    !real.potential && real.types.length === 1 && real.types[0] === 'water',
    real.types.join(','));
}

// =========================================================================
console.log('\n── which fights it judges against');
{
  const all = S.OPPONENTS.oshawott ?? [];
  // With progress marked, the next uncleared ones in story order.
  const some = { [all[0].key]: 1, [all[1].key]: 1 };
  const nxt = SG.fightsToJudge(all, some, 50);
  ok('with progress marked, the next uncleared fights in story order',
    nxt.length === 3 && nxt[0].key === all[2].key, nxt.map((e) => e.leader).join(', '));
  // WITHOUT progress marked, story order is actively wrong: it hands a
  // level-50 team the first rival and every candidate beats all of it, so the
  // list stops discriminating. That is what a fresh profile looked like.
  const none = SG.fightsToJudge(all, {}, 50);
  const naive = all.slice(0, 3);
  ok('with none marked, it uses the fights nearest your level instead',
    none.length === 3 && none.some((e) => !naive.includes(e)),
    `${none.map((e) => `${e.leader} (L${e.lvmax})`).join(', ')}`);
  ok('...which are actually near it', none.every((e) => Math.abs((e.lvmax ?? 0) - 50) < 15),
    none.map((e) => e.lvmax).join(', '));
  ok('...and a low-level team still gets low-level fights',
    SG.fightsToJudge(all, {}, 12).every((e) => (e.lvmax ?? 99) < 30),
    SG.fightsToJudge(all, {}, 12).map((e) => `${e.leader} (L${e.lvmax})`).join(', '));
  // A BRAND NEW TEAM HAS NO LEVEL OF ITS OWN, and passing 0 sends it back to
  // story order -- which is the weak default this function exists to avoid.
  // The caller falls back to the party's level; this pins that 0 is treated as
  // "unknown" rather than as "level zero".
  ok('a team with no level of its own falls back rather than picking level 1',
    SG.fightsToJudge(all, {}, 0).length === 3
    && SG.fightsToJudge(all, {}, 0)[0].key === all[0].key,
    'zero means unknown, and the caller supplies the party level instead');

  ok('everything cleared means nothing to judge against',
    SG.fightsToJudge(all, Object.fromEntries(all.map((e) => [e.key, 1])), 50).length === 0);
}

// =========================================================================
console.log('\n── a suggestion is its reasons, and its cost');
{
  const fights = (S.OPPONENTS.oshawott ?? []).filter((f) => f.kind === 'gym').slice(3, 6);
  const foes = SG.foesOf(fights, S);
  const team = { slots: ['Slowking', 'Ludicolo', 'Kingdra', 'Gastrodon']
    .map((n) => ({ options: [spec(n, { level: 50 })] })) };
  const candidates = Object.keys(S.SPECIES).map((id) => ({ speciesId: Number(id) }));
  const r = SG.suggestForSlot(team, 3, S, { candidates, foes, level: 50 });

  ok('it ranks something', r.rows.length > 0, `${r.rows.length} candidates`);
  ok('...and the premise filtered the field rather than passing it through',
    r.rows.length < Object.keys(S.SPECIES).length,
    `${r.rows.length} of ${Object.keys(S.SPECIES).length}`);
  ok('...and every premise it applied is honoured by every row',
    r.rows.every((row) => r.premises.every((p) => p.test(row.speciesId))));
  ok('...and no legendary survives a "nothing legendary" premise',
    !r.premises.some((p) => p.id === 'nolegend')
    || !r.rows.some((row) => SG.isLegendary(row.speciesId, S)));
  // THE HALF A TIDY-UP WOULD DROP.
  ok('the top suggestions say what they add', r.rows.slice(0, 5).every((x) => x.why.length > 0));
  ok('...and at least one says what it would cost',
    r.rows.slice(0, 8).some((x) => x.cost.length > 0),
    r.rows.find((x) => x.cost.length)?.cost[0] ?? 'nothing named a cost');
  // SPECIFICALLY THE COMPUTED KIND. There are two sorts of cost -- "this many
  // of them hit it hard", which falls out of the matchup, and "no one left
  // resists X", which is the with/without diff of the team's own coverage.
  // Only the second needs soleContribution, so only the second proves it runs.
  ok('...including what the outgoing slot was the only one providing',
    r.rows.some((x) => x.cost.some((c) => /^no one left resists|^nothing left hits/.test(c))),
    r.rows.flatMap((x) => x.cost).find((c) => /^no one left/.test(c)) ?? 'no coverage loss named');
  // A TEAM TOO THIN TO FIT ANYTHING AROUND has to say so rather than earning
  // every coverage reason for every candidate -- which is what one filled slot
  // does, since with nothing else there nothing else resists anything.
  {
    const one = { slots: [spec('Gengar'), spec('Slowking')].map((s) => ({ options: [s] })) };
    const r1 = SG.suggestForSlot(one, 1, S, { candidates, foes, level: 50 });
    ok('one other filled slot is reported as thin', r1.thin === true && r1.filled === 1);
    ok('...and no candidate claims to cover what nothing else covers',
      !r1.rows.some((x) => x.why.some((w) => /nothing else here/.test(w))),
      r1.rows[0]?.why.join('; ').slice(0, 70) ?? '');
    const four = { slots: ['Gengar', 'Slowking', 'Garchomp', 'Ferrothorn']
      .map((n) => ({ options: [spec(n)] })) };
    const r4 = SG.suggestForSlot(four, 3, S, { candidates, foes, level: 50 });
    ok('...and a real team is not', r4.thin === false && r4.filled === 3);
    ok('...where the coverage reasons come back',
      r4.rows.some((x) => x.why.some((w) => /nothing else here/.test(w))));
  }

  ok('it never suggests the Pokémon already in the slot',
    !r.rows.some((x) => x.speciesId === team.slots[3].options[0].speciesId));

  // Switching a premise OFF has to change the answer, or the chips are a lie.
  const off = SG.suggestForSlot(team, 3, S, { candidates, foes, level: 50, premises: [] });
  ok('dropping the premises widens the field', off.rows.length > r.rows.length,
    `${r.rows.length} → ${off.rows.length}`);
}

console.log(failed ? `\n  ${failed} check(s) FAILED` : '\n  all checks passed');
process.exit(failed ? 1 : 0);
