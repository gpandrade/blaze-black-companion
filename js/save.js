/**
 * save.js -- the Gen 5 save container: slots, blocks, checksums, read/write.
 *
 * Port of parse_save.py's validation + slot selection + block readers and
 * write_team.py's three-tier reseal.  Depends only on pk5.js.
 *
 * =========================================================================
 * FILE LAYOUT
 * =========================================================================
 * The file is 0x80000 bytes; only the first 0x48000 is live (0x48000..0x7FFFF
 * is erased flash, all 0xFF).  Two save slots of 0x24000 each, at 0x00000 and
 * 0x24000 -- NOT two 0x40000 halves.
 *
 * SLOT-RELATIVE OFFSETS
 *   0x00000  box names + wallpapers, len 0x3E0
 *            +0x000 u32 currently-selected box (0-indexed)
 *            +0x004 24 names, stride 0x28, UTF-16LE, 0xFFFF-terminated
 *            +0x3C4 24 wallpaper bytes
 *            +0x3DD u8  NUMBER OF BOXES THE GAME EXPOSES -- ships as 8, which
 *                       is why anything written to boxes 9+ is invisible in
 *                       game even though it passes every checksum.
 *   0x00400  PC box N at 0x400 + N*0x1000; 30 x 136 = 0xFF0 used, 0x10 pad
 *   0x18400  Bag, len 0x09C0
 *   0x18E00  party, len 0x534 (+0x00 u32 capacity, +0x04 u32 count,
 *            +0x08 six slots of 220 bytes)
 *   0x20A00  Battle Box, len 0x35C -- six records in BOX format (136 bytes).
 *            Easy to forget, and forgetting it once made six Pokemon appear
 *            to have vanished from every box.
 *   0x23F00  checksum table, 70 u16 entries
 *   0x23F8C  footer: u32 counter, u32 length, u32 magic 0x31053527,
 *            u16 pad, u16 CRC
 *
 * =========================================================================
 * THREE TIERS OF INTEGRITY -- refresh ALL THREE or the game wipes the save
 * =========================================================================
 *   1. each block's own inline checksum, two bytes past the block end
 *   2. the matching entry in the central table at 0x23F00
 *   3. the footer CRC at 0x23F8C+0x0E, CRC16-CCITT over [0x23F00, 0x23F8C)
 *
 * Tier 3 is the one that gets forgotten.  An edit that refreshed tiers 1 and
 * 2 and left the footer alone passed every check the reader knew about, and
 * the game still declared the save corrupt and offered to delete it.
 */

import {
  crc16ccitt, decodeRecord, decodeString, encodeRecord, encodeString,
  lcrngCrypt, PARTY_EXTRA_LEN, PARTY_EXTRA_OFF, PB, PK5_BOX_SIZE, PK5_PARTY_SIZE,
  SAVE_STAT_ORDER,
} from './pk5.js';

const encodeRecordFrom = (f) => encodeRecord(f.pid, f.sanity, f.body);

export const SAVE_SIZE = 524288;
export const SLOT_SIZE = 0x24000;
export const SLOT_OFFSETS = Object.freeze([0x00000, 0x24000]);

export const BOXNAME_BLOCK = 0x00000, BOXNAME_LEN = 0x3e0, BOXNAME_STRIDE = 0x28;
export const BOXNAME_FIRST = 0x004;      // names start here, NOT at +0x000
export const BOX_CAPACITY_OFF = 0x3dd;   // u8: how many boxes the game shows
export const BOX_BASE = 0x400, BOX_STRIDE = 0x1000, BOX_DATA_LEN = 0xff0;
export const BOX_COUNT = 24, BOX_SLOTS = 30;

export const PARTY_BLOCK = 0x18e00, PARTY_LEN = 0x534;
export const PARTY_COUNT_OFF = 0x04, PARTY_FIRST = 0x08, PARTY_SLOTS = 6;

export const BATTLE_BOX = 0x20a00, BATTLE_BOX_LEN = 0x35c, BATTLE_BOX_SLOTS = 6;

export const BAG_BLOCK = 0x18400, BAG_LEN = 0x09c0;
export const TRAINER_BLOCK = 0x19400, TRAINER_LEN = 0x0068;
export const POSITION_BLOCK = 0x19500, POSITION_LEN = 0x009c;
// Money is a STRONG CANDIDATE, not a fact: it is the only u32 in the slot
// that is non-decreasing, stays in money range, and moves only in windows
// where the game was actually played. Label it a candidate until someone
// reads their own money screen once and confirms it.
/* MONEY IS AT 0x21200, AND 0x1DA00 WAS WRONG.
   0x1DA00 was inferred from fifteen backups: the only u32 in the slot that was
   non-decreasing, stayed in money range, and moved only in windows where he
   had played. Every one of those things was true and the conclusion was still
   wrong -- it reads 18,130 while the trainer card says 9,254,754.
   The card settled it. 0x21200 is the only offset in the whole file that
   matches the card AND matches an older card value in an older backup, and it
   tracks across all 35 backups. There is a second copy at 0x45200 that moves
   with it; the slot-relative mapping between the two is NOT established, so a
   save where slot 1 is active is untested.
   Read-only: the checksummed block that contains it has not been identified,
   so nothing here writes money. */
export const MONEY_OFFSET = 0x21200;

/* BADGES: 0x21204, ONE BIT PER BADGE, LOW BITS FIRST -- CONFIRMED 2026-08-29.
   Settled by the only experiment that could settle it: a save kept
   immediately before the fourth gym leader, the leader beaten, a save taken
   again. 0x21204 went 0b0111 -> 0b1111.

   What makes it a fact rather than another fingerprint is the shape across
   all 42 backups -- the value is ALWAYS exactly the low N bits, never with a
   gap, and N never decreases. Three earlier candidates (0x20393, 0x1DBDD,
   0x1D91C) each fit a window of history and each failed; 0x20393 in
   particular did not move at all when the fourth badge was earned. */
export const BADGES_OFFSET = 0x21204;
export const DEX_BLOCK = 0x21600, DEX_LEN = 0x04d4;
export const DEX_CAUGHT = 0x08, DEX_STRIDE = 0x54, DEX_SEEN_FIELDS = 4;
/** pocket -> [offset within the bag block, capacity in slots] */
export const POCKETS = Object.freeze({
  items: [0x000, 310], key_items: [0x4d8, 83], tms_hms: [0x624, 109],
  medicine: [0x7d8, 55], berries: [0x8b4, 67],
});
export const MAX_STACK = 999;            // Gen 5 per-slot cap

export const CHECKSUM_TABLE = 0x23f00, CHECKSUM_ENTRIES = 70;
export const FOOTER = 0x23f8c, FOOTER_MAGIC = 0x31053527, FOOTER_CRC_OFF = 0x0e;

/** Checksum-table entry numbers, by block. */
export const CHK = Object.freeze({
  BOXNAMES: 0, BOX_FIRST: 1, BAG: 25, PARTY: 26, TRAINER: 27, POSITION: 28,
  MONEY: 52, BATTLE_BOX: 49, DEX: 55,
});

/** A block descriptor: slot-relative start, length, checksum-table entry. */
export const boxBlock = (n) => ({ start: BOX_BASE + n * BOX_STRIDE, len: BOX_DATA_LEN, entry: CHK.BOX_FIRST + n, name: `box ${n + 1}` });
export const BLOCKS = Object.freeze({
  boxNames: { start: BOXNAME_BLOCK, len: BOXNAME_LEN, entry: CHK.BOXNAMES, name: 'box names' },
  bag: { start: BAG_BLOCK, len: BAG_LEN, entry: CHK.BAG, name: 'bag' },
  party: { start: PARTY_BLOCK, len: PARTY_LEN, entry: CHK.PARTY, name: 'party' },
  battleBox: { start: BATTLE_BOX, len: BATTLE_BOX_LEN, entry: CHK.BATTLE_BOX, name: 'battle box' },
  trainer: { start: TRAINER_BLOCK, len: TRAINER_LEN, entry: CHK.TRAINER, name: 'trainer card' },
  position: { start: POSITION_BLOCK, len: POSITION_LEN, entry: CHK.POSITION, name: 'position' },
  /* Money AND badges live in this one, found 2026-08-29 by walking
     0x100-aligned starts and accepting only where the computed CRC, the
     block's own inline checksum and the central table all agree. It verifies
     on both slots of all 42 saves -- 84 of 84.

     NOTHING HERE WRITES IT, and having a descriptor does not change that. It
     exists so a future writer has a proven target instead of a guess: the
     note this replaces said a wrong descriptor would reseal the wrong bytes,
     and that hazard is what the 84-of-84 check retires. */
  money: { start: MONEY_OFFSET, len: 0x00EC, entry: CHK.MONEY, name: 'money and badges' },
});

export class SaveError extends Error {}

export class Save {
  /**
   * @param {Uint8Array} bytes  the whole .sav, taken by reference
   * @param {object} meta       provenance for the UI (name, size, lastModified)
   */
  constructor(bytes, meta = {}) {
    this.bytes = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.meta = meta;
    const { index, reports, reason } = this.chooseSlot();
    this.slotIndex = index;
    this.slotReports = reports;
    this.slotReason = reason;
    this.base = SLOT_OFFSETS[index];
  }

  /**
   * Validate and wrap a save.  Accepts an ArrayBuffer, a Uint8Array, or a
   * browser File/Blob-derived ArrayBuffer.
   *
   * `minAgeSeconds` reproduces parse_save.py's staleness guard: melonDS
   * buffers and flushes the .sav shortly after an in-game save, so a read
   * taken too soon can catch a partial write.  In a browser there is no
   * mtime unless the caller passes `lastModified` from the File, so the
   * check is skipped when it is absent rather than silently passing.
   */
  static load(input, { minAgeSeconds = 2, lastModified = null, name = null, now = Date.now() } = {}) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length !== SAVE_SIZE) {
      throw new SaveError(
        `save is ${bytes.length} bytes, expected exactly ${SAVE_SIZE}. ` +
        'Refusing to parse a wrong-sized file.');
    }
    let age = null;
    if (lastModified != null) {
      age = (now - lastModified) / 1000;
      if (age < minAgeSeconds) {
        throw new SaveError(
          `save was modified ${age.toFixed(2)}s ago (minimum ${minAgeSeconds}s). ` +
          'The emulator flushes the .sav shortly after an in-game save, so this ' +
          'read could catch a partial write. Wait a moment and re-load.');
      }
    }
    return new Save(bytes, { name, bytes: bytes.length, lastModified, ageSeconds: age });
  }

  // ------------------------------------------------------------- checksums
  /** The stored value of central-table entry `i` in slot `slotIndex`. */
  tableEntry(i, slotIndex = this.slotIndex) {
    return this.dv.getUint16(SLOT_OFFSETS[slotIndex] + CHECKSUM_TABLE + 2 * i, true);
  }

  /** The CRC actually computed over a block's bytes right now. */
  blockCrc(block, slotIndex = this.slotIndex) {
    const off = SLOT_OFFSETS[slotIndex] + block.start;
    return crc16ccitt(this.bytes, off, off + block.len);
  }

  /** A block's own inline checksum, stored two bytes past its end. */
  inlineChecksum(block, slotIndex = this.slotIndex) {
    return this.dv.getUint16(SLOT_OFFSETS[slotIndex] + block.start + block.len + 2, true);
  }

  slotReport(index) {
    const base = SLOT_OFFSETS[index];
    const entry = (i) => this.dv.getUint16(base + CHECKSUM_TABLE + 2 * i, true);
    const crcOf = (start, len) => crc16ccitt(this.bytes, base + start, base + start + len);

    const namesOk = crcOf(BOXNAME_BLOCK, BOXNAME_LEN) === entry(CHK.BOXNAMES);
    const boxesOk = [];
    for (let n = 0; n < BOX_COUNT; n++) {
      boxesOk.push(crcOf(BOX_BASE + n * BOX_STRIDE, BOX_DATA_LEN) === entry(CHK.BOX_FIRST + n));
    }
    const partyOk = crcOf(PARTY_BLOCK, PARTY_LEN) === entry(CHK.PARTY);

    return {
      index,
      offset: base,
      counter: this.dv.getUint32(base + FOOTER, true),
      footer_length: this.dv.getUint32(base + FOOTER + 4, true),
      footer_magic_ok: this.dv.getUint32(base + FOOTER + 8, true) === FOOTER_MAGIC,
      footer_crc_ok: crc16ccitt(this.bytes, base + CHECKSUM_TABLE, base + FOOTER)
        === this.dv.getUint16(base + FOOTER + FOOTER_CRC_OFF, true),
      box_names_crc_ok: namesOk,
      boxes_crc_ok: boxesOk.filter(Boolean).length,
      boxes_crc_total: BOX_COUNT,
      party_crc_ok: partyOk,
      valid: namesOk && partyOk && boxesOk.every(Boolean),
    };
  }

  /** Pick the newer valid slot by save counter; explain the choice. */
  chooseSlot() {
    const warnings = [];
    const reports = SLOT_OFFSETS.map((_, i) => this.slotReport(i));
    const valid = reports.filter((r) => r.valid);
    if (!valid.length) {
      throw new SaveError(
        'neither save slot passes its block checksums. The save may be corrupt ' +
        'or mid-write; refusing to emit stats.');
    }
    const best = Math.max(...valid.map((r) => r.counter));
    const tied = valid.filter((r) => r.counter === best);
    const chosen = tied[0];
    let reason;
    if (tied.length === 1) {
      reason = `slot ${chosen.index} has the higher save counter (${best})`;
    } else {
      const a = this.bytes.subarray(SLOT_OFFSETS[tied[0].index], SLOT_OFFSETS[tied[0].index] + SLOT_SIZE);
      const b = this.bytes.subarray(SLOT_OFFSETS[tied[1].index], SLOT_OFFSETS[tied[1].index] + SLOT_SIZE);
      const same = a.length === b.length && a.every((v, i) => v === b[i]);
      if (same) {
        reason = `both slots tie at counter ${best} and their contents are byte-identical; using slot ${chosen.index}`;
      } else {
        reason = `AMBIGUOUS: both slots tie at counter ${best} but their contents DIFFER; fell back to slot ${chosen.index}`;
        warnings.push(
          `Save slots ${tied[0].index} and ${tied[1].index} both report counter ${best} but ` +
          `contain different data. Cannot tell which is newer, so slot ${chosen.index} was used. ` +
          'Treat this output as suspect and re-save in game to resolve it.');
      }
    }
    const invalid = reports.filter((r) => !r.valid).map((r) => r.index);
    if (invalid.length) {
      warnings.push(
        `Save slot(s) ${invalid.join(', ')} failed block checksum validation and were ` +
        'ignored. This is normal if the game has only ever written one slot.');
    }
    this.warnings = warnings;
    return { index: chosen.index, reports, reason };
  }

  // ------------------------------------------------------------------ read
  /** How many boxes the game actually shows.  Ships as 8; the rest are real but unreachable. */
  get boxCapacity() { return this.bytes[this.base + BOXNAME_BLOCK + BOX_CAPACITY_OFF]; }

  get selectedBox() { return this.dv.getUint32(this.base + BOXNAME_BLOCK, true); }

  /**
   * The wallpaper the GAME has on each box, 0..15.
   *
   * They sit immediately after the names: 4 bytes of selected-box index, then
   * 24 names at stride 0x28 (0x3C0 bytes), so the wallpapers start at 0x3C4.
   * parse_save.py's docstring says 0x3C0, which forgets the leading u32 --
   * reading there returns the last four bytes of the final name followed by a
   * shifted run. The tell that 0x3C4 is right: a fresh save reads
   * 0,1,2,...,15,0,1,2,... which is the game cycling 16 wallpapers over 24
   * boxes, and 0x3C0 reads four zeros first.
   */
  /** Money, as the trainer card shows it. Confirmed against the card. */
  get money() { return this.dv.getUint32(this.base + MONEY_OFFSET, true); }

  /** Which badges you hold, as gym indices 0..7. */
  readBadges() {
    const b = this.bytes[this.base + BADGES_OFFSET];
    return { mask: b, count: (b.toString(2).match(/1/g) ?? []).length,
      list: [...Array(8).keys()].filter((i) => (b >> i) & 1) };
  }

  boxWallpapers() {
    const at = this.base + BOXNAME_BLOCK + BOXNAME_FIRST + BOX_COUNT * BOXNAME_STRIDE;
    return Array.from({ length: BOX_COUNT }, (_, n) => this.bytes[at + n]);
  }

  boxNames() {
    const out = [];
    for (let n = 0; n < BOX_COUNT; n++) {
      out.push(decodeString(
        this.bytes, this.base + BOXNAME_BLOCK + BOXNAME_FIRST + n * BOXNAME_STRIDE,
        BOXNAME_STRIDE / 2));
    }
    return out;
  }

  /** u32 the game stores as its party count.  Cross-check it against readParty().length. */
  get partyCountDeclared() { return this.dv.getUint32(this.base + PARTY_BLOCK + PARTY_COUNT_OFF, true); }

  recordOffset(where, index) {
    if (where === 'party') return this.base + PARTY_BLOCK + PARTY_FIRST + index * PK5_PARTY_SIZE;
    if (where === 'battleBox') return this.base + BATTLE_BOX + index * PK5_BOX_SIZE;
    if (typeof where === 'number') return this.base + BOX_BASE + where * BOX_STRIDE + index * PK5_BOX_SIZE;
    throw new Error(`unknown location ${where}`);
  }

  /**
   * A copy of one slot's raw 136 bytes -- the box-format record.  A party
   * slot's first 136 bytes ARE a box record (the extra block starts at 0x88),
   * so this works for every location and is what buildRecord() clones.
   */
  recordBytes(where, index) {
    const off = this.recordOffset(where, index);
    return new Uint8Array(this.bytes.subarray(off, off + PK5_BOX_SIZE));
  }

  /** Decode one slot.  `where` is a 0-indexed box number, 'party' or 'battleBox'. */
  readSlot(where, index) {
    const isParty = where === 'party';
    const size = isParty ? PK5_PARTY_SIZE : PK5_BOX_SIZE;
    const off = this.recordOffset(where, index);
    const f = decodeRecord(this.bytes, off, isParty);
    if (f) { f.where = where; f.slot = index + 1; }
    return f;
  }

  /** Decode every populated slot in one location. */
  readGroup(where) {
    const n = where === 'party' ? PARTY_SLOTS : where === 'battleBox' ? BATTLE_BOX_SLOTS : BOX_SLOTS;
    const out = [];
    for (let i = 0; i < n; i++) {
      const f = this.readSlot(where, i);
      if (f) out.push(f);
    }
    return out;
  }

  readParty() { return this.readGroup('party'); }
  readBattleBox() { return this.readGroup('battleBox'); }
  readBox(n) { return this.readGroup(n); }

  /** Every Pokemon in the save: party, all 24 boxes, and the Battle Box. */
  readAll() {
    const names = this.boxNames();
    return {
      slot_used: this.slotIndex,
      slot_selection: this.slotReason,
      slots: this.slotReports,
      warnings: this.warnings,
      box_capacity: this.boxCapacity,
      party_count_declared: this.partyCountDeclared,
      party: this.readParty(),
      battle_box: this.readBattleBox(),
      boxes: Array.from({ length: BOX_COUNT }, (_, n) => {
        const mons = this.readBox(n);
        return { box: n + 1, name: names[n], count: mons.length, pokemon: mons };
      }),
    };
  }

  /** Read one bag pocket as [{item_id, count}], stopping at the terminating zero id. */
  readPocket(pocket) {
    const [off0, cap] = POCKETS[pocket];
    const base = this.base + BAG_BLOCK + off0;
    const out = [];
    for (let i = 0; i < cap; i++) {
      const id = this.dv.getUint16(base + 4 * i, true);
      if (id === 0) break;
      out.push({ item_id: id, count: this.dv.getUint16(base + 4 * i + 2, true) });
    }
    return out;
  }

  readBag() {
    const out = {};
    for (const p of Object.keys(POCKETS)) out[p] = this.readPocket(p);
    return out;
  }

  /**
   * Where the player is standing.
   *
   * Two position records live in this block; the first is the live one and
   * the second looks like an entry/respawn point. Both read the same zone in
   * every save seen so far, so which is which cannot be separated from one
   * file -- `secondary_zone_id` reports it rather than pretending.
   *
   * Tile coordinates are u32 fixed point; the tile is the high half.
   * Zone id -> place name needs state/maps.json, so it is left to the caller.
   */
  readPosition() {
    const b = this.base + POSITION_BLOCK;
    return {
      zone_id: this.dv.getUint16(b + 0x04, true),
      secondary_zone_id: this.dv.getUint16(b + 0x80, true),
      tile: {
        x: this.dv.getUint32(b + 0x10, true) >>> 16,
        z: this.dv.getUint32(b + 0x18, true) >>> 16,
      },
    };
  }

  /**
   * The Pokedex: which species have been caught, and which seen.
   *
   * The caught bitfield is 0x54 bytes at DEX+0x08 -- 672 bits for 649
   * species. "Seen" is the union of FOUR following bitfields, one per
   * gender/shiny combination, because the game tracks each form you have laid
   * eyes on separately.
   */
  readPokedex() {
    const b = this.base + DEX_BLOCK + DEX_CAUGHT;
    const bit = (off, n) => (this.bytes[off + (n >> 3)] >> (n & 7)) & 1;
    const caught = [], seen = [];
    for (let dex = 1; dex <= 649; dex++) {
      const n = dex - 1;
      if (bit(b, n)) caught.push(dex);
      let s = 0;
      for (let f = 1; f <= DEX_SEEN_FIELDS; f++) s |= bit(b + f * DEX_STRIDE, n);
      // Caught implies seen. The game does not always set both, and a species
      // that reads caught-but-unseen would show as "new" in the encounter list.
      if (s || bit(b, n)) seen.push(dex);
    }
    return { caught, seen, caughtSet: new Set(caught), seenSet: new Set(seen) };
  }

  /** OT name, trainer id, secret id, and money -- all facts now. */
  readTrainer() {
    const b = this.base + TRAINER_BLOCK;
    const t = {
      ot_name: decodeString(this.bytes, b + 0x04, 8),
      trainer_id: this.dv.getUint16(b + 0x14, true),
      secret_id: this.dv.getUint16(b + 0x16, true),
      money: this.money,
      badges: this.readBadges(),
    };
    t.gender = this.playerGender(t);
    return t;
  }

  /**
   * The player's gender: 0 male, 1 female, or NULL when it cannot be read.
   *
   * NOT decoded from the trainer card block. There is a byte there that says
   * it, but locating it needs two saves of opposite gender to contrast
   * against, and every save available here -- his, the vanilla Black one
   * beside it, the fixture -- is the same trainer. Six bytes in that block
   * read zero and any of them would "fit". This project has already been
   * burned twice by exactly that reasoning while hunting money (`0x1AA04`,
   * `0x1DA00`): a fingerprint that fits is not a confirmation.
   *
   * What IS verifiable is that every Pokemon carries the gender of its
   * ORIGINAL TRAINER, in bit 7 of the met byte. For a Pokemon you caught
   * yourself that trainer is you -- so this reads the first record whose OT
   * name and both ids match the card, and which has real met data behind it.
   *
   * Returns null rather than guessing, and null is a real answer here: a save
   * whose records were all written by a tool (this one included) has its met
   * data zeroed, and "never recorded" is not the same as "male".
   */
  playerGender(card = null) {
    const t = card ?? {
      ot_name: decodeString(this.bytes, this.base + TRAINER_BLOCK + 0x04, 8),
      trainer_id: this.dv.getUint16(this.base + TRAINER_BLOCK + 0x14, true),
      secret_id: this.dv.getUint16(this.base + TRAINER_BLOCK + 0x16, true),
    };
    const mine = (m) => m && m.ot_gender !== null
      && m.ot_name === t.ot_name && m.tid === t.trainer_id && m.sid === t.secret_id;
    for (let i = 0; i < 6; i++) {
      const m = this.readSlot('party', i);
      if (mine(m)) return m.ot_gender;
    }
    for (let box = 0; box < 24; box++) {
      for (let i = 0; i < 30; i++) {
        const m = this.readSlot(box, i);
        if (mine(m)) return m.ot_gender;
      }
    }
    return null;
  }

  // ----------------------------------------------------------------- write
  /**
   * Prove encode(decode(x)) === x on every populated record before writing
   * anything.  This is the single best guard against a bad port: if the
   * codec cannot reproduce records the cartridge already accepted, it has no
   * business producing new ones.
   */
  selfTestRoundTrip() {
    let checked = 0;
    const failures = [];
    const groups = ['party', 'battleBox', ...Array.from({ length: BOX_COUNT }, (_, n) => n)];
    for (const where of groups) {
      const n = where === 'party' ? PARTY_SLOTS : where === 'battleBox' ? BATTLE_BOX_SLOTS : BOX_SLOTS;
      for (let i = 0; i < n; i++) {
        const f = this.readSlot(where, i);
        if (!f) continue;
        checked++;
        const off = this.recordOffset(where, i);
        const stored = this.bytes.subarray(off, off + PK5_BOX_SIZE);
        const rebuilt = encodeRecordFrom(f);
        if (!rebuilt.every((v, k) => v === stored[k])) {
          failures.push(`${where === 'party' ? 'party' : where === 'battleBox' ? 'battle box' : `box ${where + 1}`} slot ${i + 1}`);
        }
      }
    }
    return { checked, failures, ok: failures.length === 0 };
  }

  /** Overwrite one 136-byte record, in BOTH save slots.  Does not reseal. */
  writeSlot(where, index, record) {
    if (record.length !== PK5_BOX_SIZE) throw new Error(`record must be ${PK5_BOX_SIZE} bytes`);
    if (where === 'party') throw new Error('party slots are 220 bytes; use writeBox/writeBattleBox');
    for (let s = 0; s < SLOT_OFFSETS.length; s++) {
      const off = SLOT_OFFSETS[s] + (this.recordOffset(where, index) - this.base);
      this.bytes.set(record, off);
    }
    return this;
  }

  /**
   * Fill a box with `records`, blanking the remaining slots so no stale
   * record survives.  Writes both save slots and reseals that box.
   */
  writeBox(n, records, { blankRest = true, reseal = true } = {}) {
    if (n >= this.boxCapacity) {
      this.warnings.push(
        `box ${n + 1} is beyond the ${this.boxCapacity} boxes this save exposes ` +
        `(byte 0x3DD). The write will pass every checksum and be invisible in game. ` +
        'Raise boxCapacity first.');
    }
    const blank = new Uint8Array(PK5_BOX_SIZE);
    for (let i = 0; i < BOX_SLOTS; i++) {
      if (i < records.length) this.writeSlot(n, i, records[i]);
      else if (blankRest) this.writeSlot(n, i, blank);
    }
    if (reseal) this.reseal([boxBlock(n)]);
    return this;
  }

  writeBattleBox(records, { reseal = true } = {}) {
    const blank = new Uint8Array(PK5_BOX_SIZE);
    for (let i = 0; i < BATTLE_BOX_SLOTS; i++) {
      this.writeSlot('battleBox', i, i < records.length ? records[i] : blank);
    }
    if (reseal) this.reseal([BLOCKS.battleBox]);
    return this;
  }

  /**
   * Read one party slot as its two halves: the 136-byte box record, and the
   * DECRYPTED 84-byte party extra block.
   */
  partySlotRaw(index) {
    const off = this.recordOffset('party', index);
    const record = new Uint8Array(this.bytes.subarray(off, off + PK5_BOX_SIZE));
    const pid = this.dv.getUint32(off, true);
    const extra = lcrngCrypt(
      this.bytes.subarray(off + PARTY_EXTRA_OFF, off + PARTY_EXTRA_OFF + PARTY_EXTRA_LEN), pid);
    return { record, extra, pid };
  }

  /**
   * Patch a party extra block for a different Pokemon.
   *
   * The extra block is CLONED, never constructed. Bytes 0x18..0x53 of it are
   * populated in every real record and are plainly uninitialised junk -- one
   * save carries the ASCII "ata.c" in there, a fragment of some filename left
   * in the emulator's memory. Since there is no way to prove offline that the
   * game ignores them, the conservative move is the same one write_team.py
   * makes for whole records: start from bytes the cartridge has already
   * accepted and patch only what is understood.
   *
   * @param {Uint8Array} template  a decrypted 84-byte extra from a real party slot
   */
  static patchPartyExtra(template, { level, stats, currentHp = null }) {
    const out = new Uint8Array(template);
    const dv = new DataView(out.buffer);
    out[PB.LEVEL] = level;
    const maxHp = stats.hp;
    dv.setUint16(PB.CURHP, currentHp == null ? maxHp : Math.min(currentHp, maxHp), true);
    SAVE_STAT_ORDER.forEach((k, i) => dv.setUint16(PB.STATS + 2 * i, stats[k], true));
    // Status condition: clear it. A Pokemon moved or edited here should not
    // arrive still burned from whatever the template was doing.
    dv.setUint32(0x00, 0, true);
    return out;
  }

  /**
   * Rewrite the whole party, in both save slots.
   *
   * The game expects the party to be CONTIGUOUS -- slots 0..count-1 filled,
   * nothing after. Entries are written in order, the rest are blanked, and
   * the count header is set to match, so a gap can never be left behind.
   *
   * @param {Array<{record: Uint8Array, extra: Uint8Array}>} entries  max 6
   */
  writeParty(entries, { reseal = true } = {}) {
    if (entries.length > PARTY_SLOTS) throw new Error(`party holds ${PARTY_SLOTS}, got ${entries.length}`);
    for (let i = 0; i < PARTY_SLOTS; i++) {
      const e = entries[i];
      const rel = this.recordOffset('party', i) - this.base;
      for (const s of SLOT_OFFSETS) {
        const off = s + rel;
        if (!e) {
          this.bytes.fill(0, off, off + PK5_PARTY_SIZE);
          continue;
        }
        if (e.record.length !== PK5_BOX_SIZE) throw new Error('party record must be 136 bytes');
        if (e.extra.length !== PARTY_EXTRA_LEN) throw new Error('party extra must be 84 bytes');
        this.bytes.set(e.record, off);
        // The extra block is encrypted under the PID, not the checksum.
        const pid = this.dv.getUint32(off, true);
        this.bytes.set(lcrngCrypt(e.extra, pid), off + PARTY_EXTRA_OFF);
      }
    }
    for (const s of SLOT_OFFSETS) {
      this.dv.setUint32(s + PARTY_BLOCK + PARTY_COUNT_OFF, entries.length, true);
    }
    if (reseal) this.reseal([BLOCKS.party]);
    return this;
  }

  /** Raise (or lower) how many boxes the game exposes.  Ships at 8. */
  setBoxCapacity(n, { reseal = true } = {}) {
    if (n < 1 || n > BOX_COUNT) throw new Error(`box capacity must be 1..${BOX_COUNT}`);
    for (const s of SLOT_OFFSETS) this.bytes[s + BOXNAME_BLOCK + BOX_CAPACITY_OFF] = n;
    if (reseal) this.reseal([BLOCKS.boxNames]);
    return this;
  }

  setBoxName(n, name, { reseal = true } = {}) {
    const raw = encodeString(name, 8, BOXNAME_STRIDE);
    for (const s of SLOT_OFFSETS) this.bytes.set(raw, s + BOXNAME_BLOCK + BOXNAME_FIRST + n * BOXNAME_STRIDE);
    if (reseal) this.reseal([BLOCKS.boxNames]);
    return this;
  }

  /**
   * Add item stacks to the Bag, in both slots.  Existing entries are topped
   * up rather than duplicated, and the pocket's terminating zero id is
   * preserved, so nothing already in the bag is lost.
   * @param {Array<{item_id:number,count:number,pocket:string}>} additions
   */
  addBagItems(additions, { reseal = true } = {}) {
    for (const s of SLOT_OFFSETS) {
      for (const { item_id, count, pocket } of additions) {
        const [off0, cap] = POCKETS[pocket];
        const base = s + BAG_BLOCK + off0;
        let idx = null, found = false;
        for (let i = 0; i < cap; i++) {
          const id = this.dv.getUint16(base + 4 * i, true);
          if (id === item_id) { idx = i; found = true; break; }
          if (id === 0) { idx = i; break; }
        }
        if (idx === null) throw new Error(`pocket ${pocket} is full -- cannot add item ${item_id}`);
        const cur = found ? this.dv.getUint16(base + 4 * idx + 2, true) : 0;
        this.dv.setUint16(base + 4 * idx, item_id, true);
        this.dv.setUint16(base + 4 * idx + 2, Math.min(cur + count, MAX_STACK), true);
        if (!found && idx + 1 < cap) this.dv.setUint16(base + 4 * (idx + 1), 0, true);
      }
    }
    if (reseal) this.reseal([BLOCKS.bag]);
    return this;
  }

  /**
   * Set one item's count, in both slots. A count of 0 REMOVES it.
   *
   * addBagItems() only ever tops up, which is enough for handing yourself a
   * TM but cannot take anything away. A pocket is a flat array terminated by
   * a zero id, so removing means shifting everything after the entry down one
   * and zeroing what was the last slot -- leaving a hole would truncate the
   * pocket at that point and silently lose everything past it.
   */
  setBagItem(pocket, itemId, count, { reseal = true } = {}) {
    const [off0, cap] = POCKETS[pocket];
    if (!POCKETS[pocket]) throw new Error(`no such pocket: ${pocket}`);
    const n = Math.max(0, Math.min(MAX_STACK, Math.floor(count)));

    for (const s of SLOT_OFFSETS) {
      const base = s + BAG_BLOCK + off0;
      const get = (i) => this.dv.getUint16(base + 4 * i, true);
      const put = (i, id, c) => {
        this.dv.setUint16(base + 4 * i, id, true);
        this.dv.setUint16(base + 4 * i + 2, c, true);
      };

      let at = -1, end = cap;
      for (let i = 0; i < cap; i++) {
        const id = get(i);
        if (id === 0) { end = i; break; }
        if (id === itemId) at = i;
      }

      if (n === 0) {
        if (at < 0) continue;                       // already absent
        for (let i = at; i < end - 1; i++) {
          put(i, get(i + 1), this.dv.getUint16(base + 4 * (i + 1) + 2, true));
        }
        put(end - 1, 0, 0);                          // close the gap
      } else if (at >= 0) {
        put(at, itemId, n);
      } else {
        if (end >= cap) throw new Error(`the ${pocket} pocket is full`);
        put(end, itemId, n);
        if (end + 1 < cap) put(end + 1, 0, 0);       // keep the terminator
      }
    }
    if (reseal) this.reseal([BLOCKS.bag]);
    return this;
  }

  /**
   * Refresh all three integrity tiers for `blocks`, in both save slots.
   * Tier 3 (the footer CRC over the checksum table) is refreshed every time
   * regardless of which blocks changed, because it covers the whole table.
   */
  reseal(blocks) {
    for (const s of SLOT_OFFSETS) {
      const table = s + CHECKSUM_TABLE;
      for (const { start, len, entry } of blocks) {
        const off = s + start;
        const crc = crc16ccitt(this.bytes, off, off + len);
        this.dv.setUint16(off + len + 2, crc, true);        // tier 1: inline
        this.dv.setUint16(table + 2 * entry, crc, true);     // tier 2: central table
      }
      const footerCrc = crc16ccitt(this.bytes, table, s + FOOTER);
      this.dv.setUint16(s + FOOTER + FOOTER_CRC_OFF, footerCrc, true);  // tier 3
    }
    return this;
  }

  /**
   * Recompute every tier and report what does not agree.  Call this before
   * handing the user a download -- it is the client-side stand-in for
   * write_team.py's "write to a temp file, parse it, then copy over".
   */
  verify() {
    const problems = [];
    for (let s = 0; s < SLOT_OFFSETS.length; s++) {
      const base = SLOT_OFFSETS[s];
      const all = [BLOCKS.boxNames, BLOCKS.bag, BLOCKS.party, BLOCKS.battleBox,
        ...Array.from({ length: BOX_COUNT }, (_, n) => boxBlock(n))];
      for (const block of all) {
        const crc = this.blockCrc(block, s);
        if (this.inlineChecksum(block, s) !== crc) problems.push(`slot ${s}: ${block.name} inline checksum (tier 1)`);
        if (this.tableEntry(block.entry, s) !== crc) problems.push(`slot ${s}: ${block.name} central table entry ${block.entry} (tier 2)`);
      }
      const footer = crc16ccitt(this.bytes, base + CHECKSUM_TABLE, base + FOOTER);
      if (this.dv.getUint16(base + FOOTER + FOOTER_CRC_OFF, true) !== footer) {
        problems.push(`slot ${s}: footer CRC over the checksum table (tier 3)`);
      }
      if (this.dv.getUint32(base + FOOTER + 8, true) !== FOOTER_MAGIC) problems.push(`slot ${s}: footer magic`);
    }
    return { ok: problems.length === 0, problems };
  }

  /** A copy of the whole save, ready to hand to a Blob for download. */
  toBytes() { return new Uint8Array(this.bytes); }

  /** A detached deep copy -- edit without touching the loaded save. */
  clone() { return new Save(new Uint8Array(this.bytes), { ...this.meta }); }
}
