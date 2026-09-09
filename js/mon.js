/**
 * mon.js -- joins raw PK5 fields to the ROM tables, in both directions.
 *
 *   presentMon()  raw fields + Tables -> the readable object the UI wants
 *   buildRecord() a spec + Tables     -> a 136-byte record ready to write
 *
 * Port of parse_save.py's present() and write_team.py's build_record().
 *
 * =========================================================================
 * WHY buildRecord CLONES INSTEAD OF CONSTRUCTING
 * =========================================================================
 * It starts from a known-good record the cartridge has already accepted and
 * patches fields onto it.  Everything the codec does not model -- origin
 * game, language, ball, met location, met date, encounter type, ribbons,
 * the sanity word -- is carried over intact instead of being guessed.
 *
 * The consequence to remember: whatever the template *is*, the clone
 * inherits.  If the template is shiny, so is every clone unless `shiny` is
 * set explicitly.  That is why `shiny` is three-valued here.
 *
 * =========================================================================
 * WHAT A SAVE RECORD CAN AND CANNOT CHANGE
 * =========================================================================
 * Species, ability, moves, nature, IVs, EVs and gender are all stored in the
 * record, so an ability the species cannot legally have can simply be
 * written in and Gen 5 honours it -- it reads the ability byte directly.
 * TYPING IS NOT IN THE RECORD.  It lives in the ROM's personal table, so a
 * type change means patching the .nds, which this layer cannot do.
 */

import {
  B, CURVE_NAMES, computeStats, encodeRecord, encodeString, expForLevel,
  isShiny, levelForExp, NATURES, PK5_BOX_SIZE, SAVE_STAT_ORDER, decodeRecord,
  pk5Checksum, unshuffle, lcrngCrypt,
} from './pk5.js';
import { abilityId, abilityName, natureId } from './tables.js';

// -------------------------------------------------------------- presenting
/**
 * Turn decoded fields into the readable shape, resolving every name through
 * the ROM tables.  Mirrors state/party.json so existing consumers line up.
 *
 * Level: party records store it; box records store only EXP, so the level is
 * derived from the species' ROM growth curve.  With the ROM table present
 * that derivation is exact -- there is no inference to do and no confidence
 * to hedge.  Without it the level is reported as null rather than guessed.
 */
export function presentMon(f, tables, { location = {} } = {}) {
  const dex = f.species_id;
  const curve = tables?.growthCurve(dex) ?? null;

  let level = f.stored_level, levelSource = 'stored';
  if (level == null) {
    levelSource = 'derived';
    level = curve == null ? null : levelForExp(curve, f.exp);
  }

  const learnset = tables?.learnset(dex) ?? null;
  const moves = f.move_ids
    .map((id, i) => ({ id, i }))
    .filter(({ id }) => id !== 0)
    .map(({ id, i }) => {
      const d = tables?.moveData(id) ?? null;
      return {
        id,
        name: tables?.moveName(id) ?? null,
        pp: f.pp[i],
        pp_ups: f.pp_ups[i],
        learned_at_level: learnset ? (learnset.get(id) ?? null) : null,
        type: d?.type ?? null,
        category: d?.category ?? null,
        power: d?.power ?? null,
        accuracy: d?.accuracy ?? null,
        priority: d?.priority ?? null,
      };
    });

  const out = {
    ...location,
    where: f.where,
    slot: f.slot,
    species_id: dex,
    species: tables?.speciesName(dex) ?? `#${dex}`,
    nickname: f.nickname,
    is_nicknamed: f.is_nicknamed,
    is_egg: f.is_egg,
    is_shiny: f.is_shiny,
    gender: ['male', 'female', 'genderless'][f.gender] ?? null,
    level,
    level_source: levelSource,
    exp: f.exp,
    exp_curve: curve == null ? null : CURVE_NAMES[curve],
    exp_curve_source: curve == null ? 'unknown' : 'rom',
    nature: NATURES[f.nature_id] ?? null,
    nature_id: f.nature_id,
    ability: abilityName(f.ability_id),
    ability_id: f.ability_id,
    held_item: f.item_id ? { id: f.item_id, name: tables?.itemName(f.item_id) ?? null } : null,
    // Which ball it lives in. Cosmetic in game, but the Factory offers to
    // change it, and a picker cannot mark the current one without this.
    ball_id: f.ball_id ?? null,
    ball: f.ball_id ? (tables?.itemName(f.ball_id) ?? null) : null,
    moves,
    ivs: f.ivs,
    evs: f.evs,
    friendship: f.friendship,
    ot_name: f.ot_name,
    tid: f.tid,
    sid: f.sid,
    pid: f.pid,
    types: tables?.types(dex) ?? null,
    species_abilities: tables?.speciesData(dex)?.abilities ?? null,
    hidden_ability: tables?.speciesData(dex)?.hidden_ability ?? null,
    data_source: tables?.loaded.species ? 'rom' : 'none',
  };

  // Party records carry the game's own computed stats.  Recomputing them from
  // ROM base stats + the decoded IVs/EVs/nature/level and comparing is the
  // only check on this decoder that does not come from the decoder itself:
  // six independent equalities per party member, against numbers the game
  // wrote.  Anything but "ok" means the data is not trustworthy -- say so
  // rather than working around it.
  if (f.stored_stats) {
    out.stats = f.stored_stats;
    out.current_hp = f.current_hp;
    const base = tables?.baseStats(dex) ?? null;
    if (!base || level == null) {
      out.stats_check = 'no-base-stats';
    } else {
      const computed = computeStats(base, f.ivs, f.evs, level, f.nature_id, dex);
      const same = Object.keys(computed).every((k) => computed[k] === f.stored_stats[k]);
      out.stats_check = same ? 'ok' : 'MISMATCH';
      if (!same) { out.stats_computed = computed; out.base_stats = base; }
    }
  }
  return out;
}

/** presentMon over everything Save.readAll() returned. */
export function presentAll(all, tables) {
  return {
    ...all,
    party: all.party.map((f) => presentMon(f, tables)),
    battle_box: all.battle_box.map((f) => presentMon(f, tables)),
    boxes: all.boxes.map((b) => ({ ...b, pokemon: b.pokemon.map((f) => presentMon(f, tables)) })),
  };
}

// ---------------------------------------------------------------- building
/** The gender byte at body 0x38: gender = (byte >> 1) & 3. */
const GENDER_BYTE = { male: 0x00, female: 0x02, genderless: 0x04 };

/**
 * Default gender for a species from its ROM gender ratio.
 *   255 genderless, 254 always female, 0 always male,
 *   anything else is a mixed ratio and defaults to male.
 */
function defaultGender(ratio) {
  if (ratio === 255) return 'genderless';
  if (ratio === 254) return 'female';
  return 'male';
}

/**
 * Clone a 136-byte template record and patch it into `spec`.
 *
 * spec = {
 *   species,               name or dex id                          (required)
 *   level,                                                         (required)
 *   ability,               name or id -- may be one the species cannot legally have
 *   nature,                name or id
 *   moves: [names or ids], up to 4; PP is filled in from the ROM
 *   item | item_id,        held item, name or id
 *   evs, ivs,              partial objects keyed hp/atk/def/spa/spd/spe
 *   nick,                  sets the nicknamed flag so the game displays it
 *   shiny,                 true forces shiny, false forces normal,
 *                          OMITTED keeps whatever the template had
 *   gender,                'male' | 'female' | 'genderless'
 *   friendship, pp_ups
 * }
 *
 * EV DEFAULT: 252 in every stat, matching write_team.py.  That is 1512 EVs,
 * far past the 510 cap -- deliberate, because Gen 5 reads the stored bytes
 * directly and these are engineered Pokemon.  Pass `evs` to opt out.
 */
export function buildRecord(template, spec, tables) {
  if (!tables?.loaded.species) throw new Error('buildRecord needs the ROM species table');
  const t = decodeRecord(template, 0, false);
  if (!t) throw new Error('template record did not decode -- refusing to clone it');

  const body = new Uint8Array(t.body);
  const dv = new DataView(body.buffer);
  let pid = t.pid;

  const dex = typeof spec.species === 'number' ? spec.species : tables.speciesId(spec.species);
  if (!dex) throw new Error(`unknown species: ${spec.species}`);
  const sdata = tables.speciesData(dex);
  dv.setUint16(B.SPECIES, dex, true);

  const itemId = spec.item_id ?? (spec.item ? tables.itemId(spec.item) : 0);
  if (spec.item && itemId == null) throw new Error(`unknown item: ${spec.item}`);
  dv.setUint16(B.ITEM, itemId || 0, true);

  const level = spec.level;
  if (!(level >= 1 && level <= 100)) throw new Error(`level out of range: ${level}`);
  dv.setUint32(B.EXP, expForLevel(sdata.growth_curve_id, level), true);

  body[B.FRIENDSHIP] = spec.friendship ?? 255;

  const abil = typeof spec.ability === 'number' ? spec.ability : abilityId(spec.ability);
  if (spec.ability != null && !abil) throw new Error(`unknown ability: ${spec.ability}`);
  if (abil) body[B.ABILITY] = abil;
  // Gen 5 stores the ability explicitly in the byte above, so the Dream World
  // flag is cleared: setting it can make the game re-derive the ability and
  // overwrite a deliberately illegal one.
  body[B.DWFLAG] = 0;

  SAVE_STAT_ORDER.forEach((key, i) => { body[B.EVS + i] = spec.evs?.[key] ?? 252; });

  const moveIds = (spec.moves ?? []).map((m) => {
    const id = typeof m === 'number' ? m : tables.moveId(m);
    if (!id) throw new Error(`unknown move: ${m}`);
    return id;
  });
  if (moveIds.length > 4) throw new Error(`${moveIds.length} moves given, max 4`);
  const ppUps = spec.pp_ups ?? 3;
  for (let i = 0; i < 4; i++) {
    const id = moveIds[i] ?? 0;
    dv.setUint16(B.MOVES + 2 * i, id, true);
    // PP is stored already boosted: base + base*3/5 at 3 PP Ups.
    const basePp = id ? (tables.moveData(id)?.pp ?? 0) : 0;
    body[B.PP + i] = id ? basePp + Math.floor(basePp * ppUps / 5) : 0;
    body[B.PPUP + i] = id ? ppUps : 0;
  }

  let iv = 0;
  SAVE_STAT_ORDER.forEach((key, i) => {
    iv |= ((spec.ivs?.[key] ?? 31) & 0x1f) << (5 * i);
  });
  iv = iv >>> 0;                                   // egg flag (bit 30) stays 0
  if (spec.nick) iv = (iv | 0x80000000) >>> 0;     // nicknamed flag
  dv.setUint32(B.IVS, iv, true);

  body[B.GENDER] = GENDER_BYTE[spec.gender ?? defaultGender(sdata.gender_ratio)];
  const nat = typeof spec.nature === 'number' ? spec.nature : natureId(spec.nature);
  if (spec.nature != null && nat == null) throw new Error(`unknown nature: ${spec.nature}`);
  if (nat != null) body[B.NATURE] = nat;

  // Shininess is derived, not stored: shiny when
  //     TID ^ SID ^ (PID >> 16) ^ (PID & 0xFFFF) < 8
  // so the PID's high half is rebuilt to force that XOR to 0 (or well past 8).
  // Safe to change: the PID also seeds the block shuffle, but encodeRecord
  // re-shuffles with the same PID, and Gen 5 reads gender from 0x38 and
  // nature from 0x39 rather than from the PID -- both written explicitly above.
  if (spec.shiny != null) {
    const tid = dv.getUint16(B.TID, true), sid = dv.getUint16(B.SID, true);
    const low = pid & 0xffff;
    let high = (tid ^ sid ^ low) & 0xffff;
    if (!spec.shiny) high ^= 0x8000;
    pid = (((high << 16) >>> 0) | low) >>> 0;
  }

  // Nickname: an explicit `nick` sets a real nickname and the flag above so
  // the game shows it.  Otherwise the species name is stored with the flag
  // clear, which displays as the species name anyway.
  const nick = spec.nick || String(sdata.name).replace(/-.*$/, '').toUpperCase().slice(0, 10);
  body.set(encodeString(nick, 10, 22), B.NICKNAME);

  return encodeRecord(pid, t.sanity, body);
}

/** A blank 136-byte record -- what an empty box slot looks like. */
export const blankRecord = () => new Uint8Array(PK5_BOX_SIZE);

export { isShiny, pk5Checksum, unshuffle, lcrngCrypt };
