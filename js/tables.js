/**
 * tables.js -- name resolution for the JS save layer.
 *
 * Two kinds of table live here, and the difference matters:
 *
 *   EMBEDDED -- natures and ability names.  Fixed by the Gen 5 engine, tiny,
 *   and needed before any ROM file is loaded.  The ability list was generated
 *   from wiki/docs/includes/abilities.md, truncated at 164 (Gen 5's last
 *   ability -- everything above it in that file is post-Gen-5 and cannot
 *   appear in this ROM), and cross-checked against every ability_id in
 *   state/personal.json with zero mismatches.
 *
 *   LOADED -- species, moves and items.  These come from the ROM extraction
 *   (state/personal.json, state/moves.json, state/items.json) and are the
 *   ONLY acceptable source: Blaze Black's Full patch changed base stats for
 *   138 species, typings for 18 and abilities for 487, so anything remembered
 *   from vanilla Black/White is wrong here.  Nothing in this module falls
 *   back to vanilla data; without the JSON it says it does not know.
 *
 * ID CONVENTIONS, all verified against the live save:
 *   * MOVE IDs in the save index state/moves.json directly -- key "89" is
 *     Earthquake, which is what the save stores.  (write_team.py's docstring
 *     says "moves.json id + 1", which refers to its positional enumeration of
 *     the dict, not to the keys.  Use the keys.)
 *   * ABILITY IDs are 1-indexed into the table below.
 *   * ITEM IDs index state/items.json.  TMs and HMs are NOT contiguous:
 *         328..419 TM01..TM92    420..425 HM01..HM06    618..620 TM93..TM95
 *   * PP is stored already boosted: max = base + base*3/5 with 3 PP Ups.
 */

import { CURVE_NAMES, NATURES } from './pk5.js';

export { NATURES, CURVE_NAMES };

/** Ability id -> name.  Index 0 is "(none)"; the last real Gen 5 ability is 164. */
export const ABILITIES = Object.freeze([
  '(none)', 'Stench', 'Drizzle', 'Speed Boost', 'Battle Armor', 'Sturdy', 'Damp', 'Limber',
  'Sand Veil', 'Static', 'Volt Absorb', 'Water Absorb', 'Oblivious', 'Cloud Nine',
  'Compound Eyes', 'Insomnia', 'Color Change', 'Immunity', 'Flash Fire', 'Shield Dust',
  'Own Tempo', 'Suction Cups', 'Intimidate', 'Shadow Tag', 'Rough Skin', 'Wonder Guard',
  'Levitate', 'Effect Spore', 'Synchronize', 'Clear Body', 'Natural Cure', 'Lightning Rod',
  'Serene Grace', 'Swift Swim', 'Chlorophyll', 'Illuminate', 'Trace', 'Huge Power',
  'Poison Point', 'Inner Focus', 'Magma Armor', 'Water Veil', 'Magnet Pull', 'Soundproof',
  'Rain Dish', 'Sand Stream', 'Pressure', 'Thick Fat', 'Early Bird', 'Flame Body', 'Run Away',
  'Keen Eye', 'Hyper Cutter', 'Pickup', 'Truant', 'Hustle', 'Cute Charm', 'Plus', 'Minus',
  'Forecast', 'Sticky Hold', 'Shed Skin', 'Guts', 'Marvel Scale', 'Liquid Ooze', 'Overgrow',
  'Blaze', 'Torrent', 'Swarm', 'Rock Head', 'Drought', 'Arena Trap', 'Vital Spirit',
  'White Smoke', 'Pure Power', 'Shell Armor', 'Air Lock', 'Tangled Feet', 'Motor Drive',
  'Rivalry', 'Steadfast', 'Snow Cloak', 'Gluttony', 'Anger Point', 'Unburden', 'Heatproof',
  'Simple', 'Dry Skin', 'Download', 'Iron Fist', 'Poison Heal', 'Adaptability', 'Skill Link',
  'Hydration', 'Solar Power', 'Quick Feet', 'Normalize', 'Sniper', 'Magic Guard', 'No Guard',
  'Stall', 'Technician', 'Leaf Guard', 'Klutz', 'Mold Breaker', 'Super Luck', 'Aftermath',
  'Anticipation', 'Forewarn', 'Unaware', 'Tinted Lens', 'Filter', 'Slow Start', 'Scrappy',
  'Storm Drain', 'Ice Body', 'Solid Rock', 'Snow Warning', 'Honey Gather', 'Frisk', 'Reckless',
  'Multitype', 'Flower Gift', 'Bad Dreams', 'Pickpocket', 'Sheer Force', 'Contrary', 'Unnerve',
  'Defiant', 'Defeatist', 'Cursed Body', 'Healer', 'Friend Guard', 'Weak Armor', 'Heavy Metal',
  'Light Metal', 'Multiscale', 'Toxic Boost', 'Flare Boost', 'Harvest', 'Telepathy', 'Moody',
  'Overcoat', 'Poison Touch', 'Regenerator', 'Big Pecks', 'Sand Rush', 'Wonder Skin', 'Analytic',
  'Illusion', 'Imposter', 'Infiltrator', 'Mummy', 'Moxie', 'Justified', 'Rattled', 'Magic Bounce',
  'Sap Sipper', 'Prankster', 'Sand Force', 'Iron Barbs', 'Zen Mode', 'Victory Star', 'Turboblaze',
  'Teravolt'
]);

export const abilityName = (id) => ABILITIES[id] ?? `#${id}`;
export const natureName = (id) => NATURES[id] ?? null;

/**
 * Which stat a nature raises and which it lowers, or null for a neutral one.
 *
 * Gen 5 packs this into the id itself: `id / 5` is the stat raised and
 * `id % 5` the stat lowered, over [atk, def, spe, spa, spd] -- note SPEED
 * sits THIRD, which is the save's stat order, not the order these are printed
 * in. The five natures where the two land on the same stat (0, 6, 12, 18, 24 --
 * Hardy, Docile, Serious, Bashful, Quirky) are the neutral ones.
 */
/* The order the nature id encodes: id/5 is the RAISED stat and id%5 the
   lowered one, both indexing this list. Exported because the Team Builder
   draws the 5x5 nature chart from it, and a second copy of a five-element
   order that decides which nature every cell is would be a bug waiting. */
export const NATURE_STAT_ORDER = Object.freeze(['atk', 'def', 'spe', 'spa', 'spd']);

export function natureEffect(id) {
  if (!Number.isInteger(id) || id < 0 || id > 24) return null;
  const up = Math.floor(id / 5), down = id % 5;
  if (up === down) return null;                     // neutral
  return { up: NATURE_STAT_ORDER[up], down: NATURE_STAT_ORDER[down] };
}

/** Nature id from a name, or null.  Case-insensitive. */
export function natureId(name) {
  const i = NATURES.findIndex((n) => n.toLowerCase() === String(name).toLowerCase());
  return i < 0 ? null : i;
}

/** Ability id from a name, or null.  Case-insensitive. */
export function abilityId(name) {
  const i = ABILITIES.findIndex((n) => n.toLowerCase() === String(name).toLowerCase());
  return i < 1 ? null : i;
}

const lower = (s) => String(s).toLowerCase();

/**
 * The ROM-extracted tables, wrapped so lookups are by id or by name.
 *
 * Construct with whatever you have; every accessor degrades to null rather
 * than guessing.  `loaded` tells you which tables are present, so a caller
 * can say "no ROM data" instead of quietly reporting vanilla numbers.
 */
export class Tables {
  /**
   * @param {object} [personal] parsed state/personal.json
   * @param {object} [moves]    parsed state/moves.json
   * @param {object} [items]    parsed state/items.json
   */
  constructor({ personal = null, moves = null, items = null } = {}) {
    this.species = personal ? (personal.species ?? personal) : null;
    this.moves = moves ? (moves.moves ?? moves) : null;
    this.items = items ? (items.items ?? items) : null;
    this.meta = { personal: personal?.meta ?? null, moves: moves?.meta ?? null, items: items?.meta ?? null };

    this.byName = { species: new Map(), moves: new Map(), items: new Map() };
    if (this.species) for (const [id, v] of Object.entries(this.species)) this.byName.species.set(lower(v.name), Number(id));
    if (this.moves) for (const [id, v] of Object.entries(this.moves)) this.byName.moves.set(lower(v.name), Number(id));
    if (this.items) {
      for (const [id, v] of Object.entries(this.items)) {
        this.byName.items.set(lower(v.name), Number(id));
        if (v.tm_hm) this.byName.items.set(lower(v.tm_hm), Number(id));   // "TM25" -> Thunder's item id
      }
    }
  }

  /** Load from a base URL in a browser, or from a directory via a custom fetcher. */
  static async fetch(baseUrl = './state/', fetcher = fetch) {
    const get = async (name) => {
      const res = await fetcher(`${baseUrl}${name}`);
      if (!res.ok) throw new Error(`${baseUrl}${name}: HTTP ${res.status}`);
      return res.json();
    };
    const [personal, moves, items] = await Promise.all([
      get('personal.json'), get('moves.json'), get('items.json'),
    ]);
    return new Tables({ personal, moves, items });
  }

  get loaded() {
    return { species: Boolean(this.species), moves: Boolean(this.moves), items: Boolean(this.items) };
  }

  // ------------------------------------------------------------- species
  speciesData(id) { return this.species?.[String(id)] ?? null; }
  speciesName(id) { return this.speciesData(id)?.name ?? null; }
  speciesId(name) { return this.byName.species.get(lower(name)) ?? null; }
  baseStats(id) { return this.speciesData(id)?.base_stats ?? null; }
  types(id) { return this.speciesData(id)?.types ?? null; }
  growthCurve(id) { return this.speciesData(id)?.growth_curve_id ?? null; }
  genderRatio(id) { return this.speciesData(id)?.gender_ratio ?? null; }

  /** move id -> the level this species learns it, or null (TM, egg move, pre-evo). */
  learnset(id) {
    const d = this.speciesData(id);
    if (!d?.learnset) return null;
    const out = new Map();
    for (const e of d.learnset) if (!out.has(e.move_id)) out.set(e.move_id, e.level);
    return out;
  }

  /** Does this species legally learn this move at all?  Null when unknown. */
  canLearn(speciesId, moveId) {
    const ls = this.learnset(speciesId);
    return ls ? ls.has(moveId) : null;
  }

  // --------------------------------------------------------------- moves
  moveData(id) { return this.moves?.[String(id)] ?? null; }
  moveName(id) { return id === 0 ? null : (this.moveData(id)?.name ?? null); }
  moveId(name) { return this.byName.moves.get(lower(name)) ?? null; }

  // --------------------------------------------------------------- items
  itemData(id) { return this.items?.[String(id)] ?? null; }
  itemId(name) { return this.byName.items.get(lower(name)) ?? null; }
  itemName(id) {
    if (!id) return null;
    const d = this.itemData(id);
    if (!d) return null;
    return d.tm_hm ? `${d.tm_hm} ${d.move}` : d.name;
  }
}
