/**
 * pk5.js -- the PK5 record codec for Pokemon Black/White (Gen 5, NDS).
 *
 * A direct port of the crypto and record layout in parse_save.py and
 * write_team.py.  Pure and table-free: it knows byte layouts, LCRNG crypto,
 * CRC16 and the stat/experience formulas, and nothing about species names.
 * Name resolution lives in tables.js; the save container lives in save.js.
 *
 * No imports, no Node APIs -- runs unchanged in a browser from file://, on
 * GitHub Pages, and under `node --experimental-...`-free plain ESM.
 *
 * =========================================================================
 * PK5 RECORD (136 bytes stored, 220 in a party slot)
 * =========================================================================
 *   0x00  u32 PID
 *   0x04  u16 sanity
 *   0x06  u16 checksum
 *   0x08  four 32-byte blocks, encrypted and shuffled
 *
 * Decrypt: LCRNG seeded with the *checksum*.  Per u16,
 *     seed = (seed * 0x41C64E6D + 0x6073) mod 2^32
 *     plaintext = ciphertext ^ (seed >>> 16)
 * Unshuffle: ((PID & 0x3E000) >>> 13) % 24 indexes the 24 permutations of
 * "ABCD" in lexicographic order; that permutation is the stored order.
 * Verify: the stored checksum must equal the sum of the 64 decrypted u16s.
 *
 * A party slot carries an extra 84 bytes at 0x88, encrypted separately with
 * the *PID* as the seed.  Level lives at +0x04 into it.
 *
 * =========================================================================
 * STAT ORDERING -- READ THIS BEFORE TOUCHING STAT CODE
 * =========================================================================
 *   save order = HP, Atk, Def, Spe, SpA, SpD   (EV bytes, IV bitfield, stats)
 *   our order  = HP, Atk, Def, SpA, SpD, Spe   (everything this module emits)
 * Speed is 4th in the save and 6th everywhere else.  Positional stat tuples
 * are converted to named keys at the decode boundary and never travel as
 * bare arrays.  Every stat object here is keyed hp/atk/def/spa/spd/spe.
 */

// ---------------------------------------------------------------- geometry
export const PK5_BOX_SIZE = 136;
export const PK5_PARTY_SIZE = 220;
export const PARTY_EXTRA_OFF = 0x88;
export const PARTY_EXTRA_LEN = 84;

/** Offsets into the 128-byte decrypted+unshuffled body (record offset - 8). */
export const B = Object.freeze({
  SPECIES: 0x00, ITEM: 0x02, TID: 0x04, SID: 0x06,
  EXP: 0x08, FRIENDSHIP: 0x0c, ABILITY: 0x0d,
  EVS: 0x10,                       // 6 bytes, save order
  MOVES: 0x20,                     // 4 x u16
  PP: 0x28, PPUP: 0x2c,            // 4 bytes each
  IVS: 0x30,                       // u32 bitfield, save order + egg/nick flags
  GENDER: 0x38, NATURE: 0x39, DWFLAG: 0x3a,
  NICKNAME: 0x40, NICKNAME_LEN: 11,
  OT_NAME: 0x60, OT_NAME_LEN: 8,
  // Met data. BODY coordinates, so these are record 0x7D and 0x7E.
  // BALL is confirmed, not inferred: it reads 4 on every record in the save
  // and item 4 is Poké Ball in the ROM's own item table.
  BALL: 0x75,
  // Met level in bits 0-6, the OT's GENDER in bit 7. Both read zero on a
  // record whose met data was never filled in -- which is every record in
  // this save, because they were written by write_team.py rather than caught.
  MET: 0x76,
});

/** Offsets into the decrypted 84-byte party extra block. */
export const PB = Object.freeze({ LEVEL: 0x04, CURHP: 0x06, STATS: 0x08 });

export const SAVE_STAT_ORDER = Object.freeze(['hp', 'atk', 'def', 'spe', 'spa', 'spd']);
export const STAT_ORDER = Object.freeze(['hp', 'atk', 'def', 'spa', 'spd', 'spe']);

// ------------------------------------------------------------------ CRC16
// CRC16-CCITT: poly 0x1021, init 0xFFFF, no reflection, no final xor.
const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let b = 0; b < 256; b++) {
    let c = b << 8;
    for (let i = 0; i < 8; i++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    t[b] = c;
  }
  return t;
})();

/** CRC16-CCITT over bytes[start, end). */
export function crc16ccitt(bytes, start = 0, end = bytes.length) {
  let crc = 0xffff;
  for (let i = start; i < end; i++) crc = (((crc << 8) & 0xffff) ^ CRC_TABLE[((crc >> 8) ^ bytes[i]) & 0xff]) & 0xffff;
  return crc;
}

// ----------------------------------------------------------------- crypto
/**
 * Symmetric LCRNG stream cipher: XOR each u16 with the high half of a
 * stepped LCRNG.  Returns a new Uint8Array; the input is not modified.
 *
 * Math.imul is load-bearing -- 0x41C64E6D * seed overflows float64's exact
 * integer range, so plain `*` silently loses low bits and every decode
 * downstream turns to noise.
 */
export function lcrngCrypt(data, seed) {
  const out = new Uint8Array(data);
  let s = seed >>> 0;
  for (let i = 0; i + 1 < data.length; i += 2) {
    s = (Math.imul(s, 0x41c64e6d) + 0x6073) >>> 0;
    const word = ((data[i] | (data[i + 1] << 8)) ^ (s >>> 16)) & 0xffff;
    out[i] = word & 0xff;
    out[i + 1] = word >>> 8;
  }
  return out;
}

/** The 24 permutations of "ABCD" in lexicographic order. */
export const BLOCK_ORDERS = (() => {
  const out = [];
  const perm = (prefix, rest) => {
    if (!rest.length) { out.push(prefix); return; }
    for (let i = 0; i < rest.length; i++) perm(prefix + rest[i], rest.slice(0, i) + rest.slice(i + 1));
  };
  perm('', 'ABCD');
  return Object.freeze(out);
})();

const orderFor = (pid) => BLOCK_ORDERS[(((pid >>> 0) & 0x3e000) >>> 13) % 24];

/** Stored (shuffled) 128-byte body -> canonical ABCD order. */
export function unshuffle(body, pid) {
  const order = orderFor(pid);
  const out = new Uint8Array(128);
  for (let i = 0; i < 4; i++) out.set(body.subarray(i * 32, i * 32 + 32), (order.charCodeAt(i) - 65) * 32);
  return out;
}

/** Canonical ABCD body -> stored (shuffled) order.  Inverse of unshuffle. */
export function shuffle(body, pid) {
  const order = orderFor(pid);
  const out = new Uint8Array(128);
  for (let i = 0; i < 4; i++) {
    const src = (order.charCodeAt(i) - 65) * 32;
    out.set(body.subarray(src, src + 32), i * 32);
  }
  return out;
}

/** The record checksum: sum of the 64 u16s of the decrypted body. */
export function pk5Checksum(body) {
  let sum = 0;
  for (let i = 0; i < 128; i += 2) sum += body[i] | (body[i + 1] << 8);
  return sum & 0xffff;
}

/** Shininess is derived, never stored. */
export function isShiny(tid, sid, pid) {
  return (((tid ^ sid ^ ((pid >>> 16) & 0xffff) ^ (pid & 0xffff)) & 0xffff) < 8);
}

// --------------------------------------------------------------- strings
/** UTF-16LE, terminated by 0x0000 or 0xFFFF. */
export function decodeString(bytes, off, maxChars) {
  let s = '';
  for (let i = 0; i < maxChars; i++) {
    const c = bytes[off + i * 2] | (bytes[off + i * 2 + 1] << 8);
    if (c === 0x0000 || c === 0xffff) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/**
 * Encode into a fixed-width field: UTF-16LE, 0xFFFF terminator, zero padded.
 * Gen 5 caps nicknames at 10 characters and OT names at 7.
 */
export function encodeString(str, maxChars, fieldBytes) {
  const out = new Uint8Array(fieldBytes);
  const s = String(str).slice(0, maxChars);
  let i = 0;
  for (; i < s.length && i * 2 + 1 < fieldBytes; i++) {
    const c = s.charCodeAt(i);
    out[i * 2] = c & 0xff;
    out[i * 2 + 1] = c >>> 8;
  }
  if (i * 2 + 1 < fieldBytes) { out[i * 2] = 0xff; out[i * 2 + 1] = 0xff; }
  return out;
}

// ---------------------------------------------------------------- natures
export const NATURES = Object.freeze([
  'Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty',
  'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax',
  'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive',
  'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash',
  'Calm', 'Gentle', 'Sassy', 'Careful', 'Quirky',
]);

// Nature id maps to these stats: raised = id / 5, lowered = id % 5.
const NATURE_STAT_ORDER = Object.freeze(['atk', 'def', 'spe', 'spa', 'spd']);

/** [numerator, denominator] for one nature's effect on one stat. */
export function natureMultiplier(natureId, stat) {
  if (natureId >= 25) return [10, 10];
  const raised = NATURE_STAT_ORDER[Math.floor(natureId / 5)];
  const lowered = NATURE_STAT_ORDER[natureId % 5];
  if (raised === lowered) return [10, 10];
  if (stat === raised) return [11, 10];
  if (stat === lowered) return [9, 10];
  return [10, 10];
}

// ------------------------------------------------------------ experience
export const CURVE_NAMES = Object.freeze(['medium-fast', 'erratic', 'fluctuating', 'medium-slow', 'fast', 'slow']);
export const MEDIUM_FAST = 0, ERRATIC = 1, FLUCTUATING = 2, MEDIUM_SLOW = 3, FAST = 4, SLOW = 5;
export const MAX_LEVEL = 100;

/** Total EXP required to reach `level` on `curve`.  Level 1 is always 0. */
export function expForLevel(curve, level) {
  const n = level;
  if (n <= 1) return 0;
  const n3 = n * n * n;
  switch (curve) {
    case MEDIUM_FAST: return n3;
    case FAST: return Math.floor(4 * n3 / 5);
    case SLOW: return Math.floor(5 * n3 / 4);
    case MEDIUM_SLOW: return Math.floor(6 * n3 / 5) - 15 * n * n + 100 * n - 140;
    case ERRATIC:
      if (n < 50) return Math.floor(n3 * (100 - n) / 50);
      if (n < 68) return Math.floor(n3 * (150 - n) / 100);
      if (n < 98) return Math.floor(n3 * Math.floor((1911 - 10 * n) / 3) / 500);
      return Math.floor(n3 * (160 - n) / 100);
    case FLUCTUATING:
      if (n < 15) return Math.floor(n3 * (Math.floor((n + 1) / 3) + 24) / 50);
      if (n < 36) return Math.floor(n3 * (n + 14) / 50);
      return Math.floor(n3 * (Math.floor(n / 2) + 32) / 50);
    default: throw new Error(`unknown curve ${curve}`);
  }
}

/** Highest level whose EXP threshold `exp` has reached, on `curve`. */
export function levelForExp(curve, exp) {
  let level = 1;
  for (let n = 2; n <= MAX_LEVEL; n++) {
    if (expForLevel(curve, n) <= exp) level = n; else break;
  }
  return level;
}

/** Which curves could produce `exp` at exactly `level`? */
export function curvesConsistentWith(exp, level) {
  const out = [];
  for (let c = 0; c < 6; c++) {
    if (exp < expForLevel(c, level)) continue;
    if (level >= MAX_LEVEL || exp < expForLevel(c, level + 1)) out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------- stats
/**
 * Gen 3+ stat formula.  All four stat objects are keyed hp/atk/def/spa/spd/spe.
 * Shedinja (#292) has its max HP hardcoded to 1 by the engine, not by data.
 */
export function computeStats(base, ivs, evs, level, natureId, speciesId = null) {
  const out = {};
  for (const key of STAT_ORDER) {
    const core = Math.floor((2 * base[key] + ivs[key] + Math.floor(evs[key] / 4)) * level / 100);
    if (key === 'hp') {
      out[key] = speciesId === 292 ? 1 : core + level + 10;
    } else {
      const [num, den] = natureMultiplier(natureId, key);
      out[key] = Math.floor((core + 5) * num / den);
    }
  }
  return out;
}

/** Convert a positional stat tuple in `order` into our named-key object. */
export function namedStats(values, order) {
  const byName = {};
  order.forEach((k, i) => { byName[k] = values[i]; });
  const out = {};
  for (const k of STAT_ORDER) out[k] = byName[k];
  return out;
}

// ------------------------------------------------------------ record I/O
/**
 * Decode one PK5 record.
 *
 * Returns null for an empty or unreadable slot.  Three separate ways a slot
 * reads as empty, and all three matter: an all-zero slot, a slot whose
 * checksum does not match (corrupt), and -- the subtle one -- a *cleared*
 * slot, which the game rewrites with a valid non-zero checksum and species 0.
 * Without that last guard a blank slot decodes cleanly as a phantom record
 * and miscounts every box.
 *
 * @param {Uint8Array} bytes  buffer holding the record
 * @param {number} off        record start
 * @param {boolean} isParty   read the 84-byte party extra block too
 */
export function decodeRecord(bytes, off = 0, isParty = false) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pid = dv.getUint32(off, true);
  const sanity = dv.getUint16(off + 4, true);
  const checksum = dv.getUint16(off + 6, true);
  if (pid === 0 && checksum === 0) return null;

  const body = unshuffle(lcrngCrypt(bytes.subarray(off + 8, off + PK5_BOX_SIZE), checksum), pid);
  if (pk5Checksum(body) !== checksum) return null;

  const bv = new DataView(body.buffer);
  const species = bv.getUint16(B.SPECIES, true);
  if (species === 0) return null;

  const ivField = bv.getUint32(B.IVS, true);
  const tid = bv.getUint16(B.TID, true);
  const sid = bv.getUint16(B.SID, true);
  const ivs = [];
  for (let i = 0; i < 6; i++) ivs.push((ivField >>> (5 * i)) & 0x1f);
  const moveIds = [];
  for (let i = 0; i < 4; i++) moveIds.push(bv.getUint16(B.MOVES + 2 * i, true));

  const fields = {
    pid, sanity, checksum, body,
    species_id: species,
    item_id: bv.getUint16(B.ITEM, true),
    tid, sid,
    exp: bv.getUint32(B.EXP, true),
    friendship: body[B.FRIENDSHIP],
    ability_id: body[B.ABILITY],
    nature_id: body[B.NATURE],
    gender: (body[B.GENDER] >> 1) & 3,   // 0 male, 1 female, 2 genderless
    gender_byte: body[B.GENDER],
    evs: namedStats(Array.from(body.subarray(B.EVS, B.EVS + 6)), SAVE_STAT_ORDER),
    ivs: namedStats(ivs, SAVE_STAT_ORDER),
    is_egg: Boolean((ivField >>> 30) & 1),
    is_nicknamed: Boolean((ivField >>> 31) & 1),
    is_shiny: isShiny(tid, sid, pid),
    move_ids: moveIds,
    pp: Array.from(body.subarray(B.PP, B.PP + 4)),
    pp_ups: Array.from(body.subarray(B.PPUP, B.PPUP + 4)),
    nickname: decodeString(body, B.NICKNAME, B.NICKNAME_LEN),
    ot_name: decodeString(body, B.OT_NAME, B.OT_NAME_LEN),
    ball_id: body[B.BALL],
    met_level: body[B.MET] & 0x7f,
    // Null rather than 0 when the met data is blank: "male" and "never
    // recorded" are different answers and only one of them is worth acting on.
    ot_gender: body[B.MET] & 0x7f ? (body[B.MET] >> 7) & 1 : null,
    stored_level: null,
  };

  if (isParty && bytes.length - off >= PK5_PARTY_SIZE) {
    const extra = lcrngCrypt(
      bytes.subarray(off + PARTY_EXTRA_OFF, off + PARTY_EXTRA_OFF + PARTY_EXTRA_LEN), pid);
    const ev = new DataView(extra.buffer);
    const stats = [];
    for (let i = 0; i < 6; i++) stats.push(ev.getUint16(PB.STATS + 2 * i, true));
    fields.stored_level = extra[PB.LEVEL];
    fields.current_hp = ev.getUint16(PB.CURHP, true);
    fields.stored_stats = namedStats(stats, SAVE_STAT_ORDER);
    fields.party_extra = extra;
  }
  return fields;
}

/**
 * Encode a 136-byte record from a PID, a sanity word and a 128-byte body.
 * The checksum is recomputed from the body, so it is order-independent and
 * encodeRecord(decodeRecord(x)) is byte-identical to x.
 */
export function encodeRecord(pid, sanity, body) {
  if (body.length !== 128) throw new Error(`body must be 128 bytes, got ${body.length}`);
  const chk = pk5Checksum(body);
  const out = new Uint8Array(PK5_BOX_SIZE);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, pid >>> 0, true);
  dv.setUint16(4, sanity, true);
  dv.setUint16(6, chk, true);
  out.set(lcrngCrypt(shuffle(body, pid), chk), 8);
  return out;
}

/** Re-encode a record straight from what decodeRecord returned. */
export const reencode = (f) => encodeRecord(f.pid, f.sanity, f.body);
