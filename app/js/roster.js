/**
 * roster.js -- the LIVE half of the battle companion's data.
 *
 * build_sheet.py used to do all of this in Python at generate time:
 * read_live() decoded every Pokemon in the save and take() claimed copies
 * for teams. (Teams themselves now come from the team store at mount, not
 * from here -- see buildTeams below.)
 * This is that logic, in the browser, against a save the user just loaded.
 *
 * Together with app/data/static.json it produces exactly the `D` blob the
 * battle companion has always consumed -- verified field by field against
 * build_sheet.py by tools/verify_blob.mjs.
 *
 * =========================================================================
 * WHY SLOTS CLAIM COPIES INSTEAD OF SHARING THEM
 * =========================================================================
 * A player may keep two Slowkings, one per team. If both slots looked up
 * "Slowking" they would render the same record and one team would be lying
 * about what
 * it is actually holding. So each slot CLAIMS a copy: party copies first,
 * then boxes.
 *
 * And the tag rule on top of that is load-bearing, not cosmetic. Every
 * Pokemon in a team box carries a one-letter team tag as its nickname
 * ("K Slowking"). A slot prefers a record tagged for ITS team -- without
 * that, the living dex in boxes 11-15 gets claimed first purely because it
 * sorts earlier by box, and the Uncle team silently displays somebody
 * else's Dragonite.
 */

import { Save } from '../../js/save.js';
import { NATURES, computeStats, levelForExp, isShiny } from '../../js/pk5.js';

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

/**
 * Every Pokemon in the save, in the shape the sheet's renderer expects.
 * Keyed by species name -> list of copies, party first.
 */
export function readLive(save, S) {
  const all = save.readAll();
  const out = [];

  const one = (f, where) => {
    const sp = S.SPECIES[String(f.species_id)];
    if (!sp) return;
    const level = f.stored_level ?? levelForExp(sp.curve, f.exp);
    const stats = computeStats(sp.base, f.ivs, f.evs, level, f.nature_id, f.species_id);
    out.push({
      name: sp.name,
      lvl: level,
      nat: NATURES[f.nature_id] ?? null,
      ab: S.ABILBYID[String(f.ability_id)] ?? `#${f.ability_id}`,
      item: f.item_id ? (S.ITEMS[String(f.item_id)] ?? null) : null,
      types: sp.types,
      moves: f.move_ids.filter(Boolean).map((m) => S.MOVEBYID[String(m)] ?? `#${m}`),
      shiny: f.is_shiny,
      nick: f.nickname,
      box: where,
      stats: STAT_KEYS.map((k) => stats[k]),
      // Not used by the sheet, but the Factory and Team Builder will need a
      // way back to the exact record this came from.
      _at: { where: f.where, slot: f.slot },
      _ivs: f.ivs, _evs: f.evs, _pid: f.pid, _speciesId: f.species_id,
    });
  };

  // Battle Box first, then party, then boxes -- the order read_live() used.
  // The Battle Box is easy to forget and forgetting it once made six Pokemon
  // appear to have vanished from every box.
  for (const f of all.battle_box) one(f, 'Battle Box');
  for (const f of all.party) one(f, 'Party');
  for (const b of all.boxes) for (const f of b.pokemon) one(f, `Box ${b.box}`);
  return out;
}

/** species name -> copies, party first. Mirrors build_sheet's `copies` map. */
function copiesByName(live) {
  const copies = new Map();
  for (const m of live) {
    if (!copies.has(m.name)) copies.set(m.name, []);
    copies.get(m.name).push(m);
  }
  // Stable sort: party copies are handed out first.
  for (const lst of copies.values()) {
    // Stable by insertion order within each group: Array.sort is stable in
    // modern JS, but the index is explicit so a future refactor cannot
    // silently reorder copies and change which record a slot claims.
    lst.forEach((m, i) => { m._ord = i; });
    lst.sort((x, y) => (x.box === 'Party' ? 0 : 1) - (y.box === 'Party' ? 0 : 1) || x._ord - y._ord);
  }
  return copies;
}

/**
 * The sheet's TEAMS array -- which the app deliberately leaves EMPTY.
 *
 * It used to fold `TEAM_LAYOUT` together with the save here, so the eight
 * shipped rosters arrived baked into the blob as tabs you could not edit,
 * retire or delete. They are ordinary cores now (`seedBuiltins()` in
 * teams.js adopts them on first run), and every team the battle tab shows
 * comes from the team store at mount instead -- your live party, your teams,
 * your cores, the adopted rosters among them.
 *
 * SO THIS RETURNS NO TEAMS ON PURPOSE. Building them here as well would show
 * every adopted roster twice, once from the blob and once from the store,
 * with the blob's copy unable to be edited -- the exact split that was just
 * removed. `build_sheet.py` still assembles them for the PUBLISHED artifact,
 * which is static and has no store to read at runtime.
 *
 * `duplicates` is still counted here: it describes the SAVE (how many copies
 * of each species it holds), not the teams, and the sheet's search panel uses
 * it either way.
 */
export function buildTeams(live, S) {
  const copies = copiesByName(live);
  const duplicates = {};
  for (const [name, lst] of copies) if (lst.length > 1) duplicates[name] = lst.length;
  return { teams: [], missing: [], duplicates, skipped: [] };
}

/** Flat index of everything in the PC, for the sheet's search panel. */
export function boxedIndex(live) {
  return live
    .filter((m) => m.box !== 'Battle Box')
    .map((m) => ({ n: m.name, k: m.nick || '', b: m.box, l: m.lvl, a: m.ab, t: m.types }));
}

/**
 * Wild encounters for wherever the player is standing.
 *
 * Surf and fishing rows are MARKED, not dropped -- without HM03 or the rod
 * they are real encounters you simply cannot reach yet, and saying so is
 * more use than hiding them.
 */
export function herePanel(save, S) {
  const pos = save.readPosition();
  const bag = save.readBag();
  const named = (ids) => ids.map((e) => S.ITEMS[String(e.item_id)] ?? '');
  const hasSurf = named(bag.tms_hms).some((n) => n.startsWith('HM03'));
  const hasRod = named(bag.key_items).some((n) => /Rod/.test(n));

  const loc = S.ZONES[String(pos.zone_id)] ?? '';
  // Area directory names are inconsistently spelled and cased, so match the
  // same two ways build_sheet did: dir-name inside location, then location
  // inside dir-name.
  const areas = Object.keys(S.AREAS);
  const low = loc.toLowerCase();
  let key = areas.find((a) => low.includes(a.toLowerCase().replace(/s$/, '')))
    ?? areas.find((a) => a.toLowerCase().includes(low) && low);

  const rows = (key ? S.AREAS[key] : []).map((r) => ({
    method: r.method,
    mons: r.mons,
    total: r.total,
    suspect: r.suspect,
    gated: (r.method.includes('surf') && !hasSurf) || (r.method.includes('fishing') && !hasRod),
  }));
  return { loc, area: key ?? null, rows, hasSurf, hasRod, zone: pos.zone_id, tile: pos.tile };
}

/**
 * Every TM/HM owned, cross-referenced against who can legally learn it.
 * Compatibility is the ROM's own per-species tmhm list, so this is "can
 * actually be taught", not a guess.
 */
export function bagTms(save, live, S) {
  const byName = {};
  for (const sp of Object.values(S.SPECIES)) byName[sp.name] = sp;
  const owned = boxedIndex(live);
  const uniq = [...new Map(owned.map((m) => [m.n, m])).values()];

  const out = [];
  for (const e of save.readBag().tms_hms) {
    const label = S.ITEMS[String(e.item_id)] ?? '';
    const m = label.match(/^(TM\d+|HM\d+)\s+(.*)$/);
    if (!m) continue;
    const [, slot, move] = m;
    // "Who can learn this" is only useful about the six you are running --
    // a full list is 200+ names for something like Hidden Power.
    const party = [...new Set(owned.filter((x) => x.b === 'Party'
      && (byName[x.n]?.tmhm ?? []).includes(slot)).map((x) => x.n))].sort();
    const n = uniq.filter((x) => (byName[x.n]?.tmhm ?? []).includes(slot)).length;
    out.push({ slot, move, count: e.count, party, n, owned: uniq.length });
  }
  return out;
}

/**
 * Assemble the complete `D` blob the battle companion consumes.
 * Static half straight through; live half computed from the save.
 */
/**
 * The documented fights for ONE run: your cartridge and your starter.
 *
 * TWO FORKS, AND THEY ARE NOT THE SAME SHAPE. The version fork is a tag on a
 * fight -- only Opelucid differs, so one list carries both and this filters.
 * The starter fork changes what is INSIDE a fight (Cheren brings a different
 * six), so build_static.py emits the whole roster three times and this picks
 * one.
 *
 * The three are index-aligned, which is what lets AREAINDEX[].opponents and
 * the sheet's saved encounter position keep storing a POSITION. Filtering by
 * version must therefore preserve the original index wherever a caller stores
 * one -- see progressPanel() in the template, which pairs {o, i}.
 *
 * `version` may be null, which means DO NOT FILTER. The Adventure tab needs
 * that: it stores original indices and pairs {o, i} itself, so it wants the
 * complete list and does its own filtering.
 *
 * An older blob had OPPONENTS as a bare array. Reading one is harmless and
 * costs a line, so it is still accepted.
 */
export function opponentsFor(S, starter = null, version = 'black') {
  const all = Array.isArray(S.OPPONENTS)
    ? S.OPPONENTS
    : (S.OPPONENTS?.[starter ?? S.STARTER] ?? S.OPPONENTS?.[S.STARTER] ?? []);
  return version ? all.filter((o) => !o.ver || o.ver === version) : all;
}

/** The same pick for the prose that explains why those fights and not others. */
export function gatesFor(S, starter = null, version = 'black') {
  const g = S.GATES;
  if (Array.isArray(g)) return g;
  const byStarter = g?.[version];
  if (Array.isArray(byStarter)) return byStarter;
  return byStarter?.[starter ?? S.STARTER] ?? byStarter?.[S.STARTER] ?? [];
}

export function buildBlob(save, S, { ot = null, version = 'black', starter = null } = {}) {
  const live = readLive(save, S);
  const { teams, missing, duplicates, skipped } = buildTeams(live, S);
  // THE PARTY'S LEVEL RANGE, not the teams'. It used to be read off the
  // assembled teams; teams come from the store at mount now, so there are
  // none here at all and the kicker would simply lose its level range.
  const party = live.filter((m) => m.box === 'Party');
  const lv = [...new Set((party.length ? party : live).map((m) => m.lvl))]
    .sort((a, b) => a - b);
  const lvtxt = lv.length === 0 ? '' : lv.length === 1 ? `L${lv[0]}` : `L${lv[0]}–${lv[lv.length - 1]}`;
  const pos = save.readPosition();

  return {
    blob: {
      TYPES: S.TYPES, CHART: S.CHART, MOVES: S.MOVES, ABIL: S.ABIL,
      ITEMDESC: S.ITEMDESC, DEX: S.DEX, SPRITE: S.SPRITE, TICON: S.TICON,
      // Trainer portraits. PATHS here, where the app is served over HTTP;
      // build_sheet.py embeds the same images as base64 because a published
      // artifact cannot fetch anything. The template reads whichever it is
      // given, so the only thing that has to match is the key -- and leaving
      // it off this list fails silently, since face() renders nothing when
      // TRFACE is empty.
      TRFACE: S.TRFACE,
      SPNAME: S.SPNAME,
      // ONE FIGHT DIFFERS BETWEEN THE CARTRIDGES: Opelucid is Drayden in Black
      // and Iris in White. static.json carries both, tagged, so the choice is
      // a setting rather than a rebuild -- and the sheet is handed only the
      // ones that exist in your game, exactly as the published artifact is.
      OPPONENTS: opponentsFor(S, starter, version),
      STATUS: S.STATUS,
      NOTES: S.NOTES,
      // Field effects come from static.json without `who` -- build_static has
      // no save to look in. Which of YOUR Pokémon can set each is the half
      // that makes the tab worth opening, so it is filled here.
      FIELD: (S.FIELD ?? []).map((f) => ({
        ...f,
        who: [...new Set(live
          .filter((m) => (m.moves ?? []).some((mv) => f.setters.includes(mv))
            || f.abilities.includes(m.ab))
          .map((m) => m.name))].sort(),
      })),
      GATES: gatesFor(S, starter, version),
      TEAMS: teams,
      HERE: herePanel(save, S),
      BAGTM: bagTms(save, live, S),
      BOXED: boxedIndex(live),
      META: {
        kicker: `${version === 'white' ? 'Volt White' : 'Blaze Black'} 3.1 · `
          + `OT ${ot ?? '—'} · ${lvtxt}`,
        built: `Read live from your save · ${S.ZONES[String(pos.zone_id)] ?? 'unknown location'}`,
        footer: '<b>Refreshing this.</b> Click <b>Reload save</b> after levelling up, '
          + 'evolving, or swapping an item — levels, stats, natures, abilities, held items, '
          + 'moves and shininess are all re-read from the save. Team membership, roles '
          + 'and prose are yours to edit — every tab here is a team or a core from the '
          + '<b>Team Builder</b>, including the rosters that shipped with the app.',
      },
    },
    live, missing, duplicates, skipped,
  };
}
