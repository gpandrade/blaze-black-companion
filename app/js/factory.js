/**
 * factory.js -- the Pokemon Factory's operations model.
 *
 * A working copy of the save plus move / delete / edit / create, with undo.
 * No DOM in here; tabs/factory.js draws it.
 *
 * =========================================================================
 * NOTHING TOUCHES THE LOADED SAVE
 * =========================================================================
 * The constructor clones. Every edit lands in that clone, and the only way
 * out is `bytes()`, which refuses to hand anything back unless all three
 * integrity tiers verify. The user then places the downloaded file over
 * their own save, having backed it up. That is deliberately more friction
 * than a write endpoint would be -- the file is expensive to lose.
 *
 * =========================================================================
 * WHAT A SAVE RECORD CAN AND CANNOT CHANGE
 * =========================================================================
 * Species, ability, moves, nature, IVs, EVs, gender, held item, level and
 * nickname are all stored IN the record, so the editor can write any of
 * them -- including an ability the species cannot legally have, which Gen 5
 * honours because it reads the ability byte directly.
 *
 * TYPING IS NOT IN THE RECORD. It lives in the ROM's personal table, so no
 * amount of save editing can change a Pokemon's type. The UI says so rather
 * than leaving it as a mysterious gap.
 *
 * =========================================================================
 * THE PARTY IS NOT JUST ANOTHER BOX
 * =========================================================================
 * A party slot is 220 bytes: a 136-byte box record plus an 84-byte extra
 * block holding level, current HP and the six computed stats. That block is
 * CLONED from a real party member and patched, never built from scratch --
 * bytes 0x18..0x53 of it are populated in every record and are plainly
 * uninitialised junk (one save carries the ASCII "ata.c" in there, a
 * fragment of a filename left in emulator memory). There is no way to prove
 * offline that the game ignores them, so the conservative move is to start
 * from bytes the cartridge has already accepted.
 *
 * The party must also stay CONTIGUOUS and non-empty, so removing from it
 * compacts, and removing the last member is refused.
 */

import { Save, BOX_COUNT, BOX_SLOTS, PARTY_SLOTS, BATTLE_BOX_SLOTS, boxBlock, BLOCKS } from '../../js/save.js';
import { B, computeStats, decodeRecord, encodeRecord, encodeString, expForLevel,
  levelForExp, NATURES, PB, PK5_BOX_SIZE } from '../../js/pk5.js';
import { buildRecord } from '../../js/mon.js';

const UNDO_LIMIT = 25;

/** Sort comparators, by key. Every one is a total order on its own field. */
export const SORTS = {
  dex: (a, b) => a.speciesId - b.speciesId,
  name: (a, b) => a.species.localeCompare(b.species),
  nickname: (a, b) => (a.isNicknamed ? a.nickname : a.species)
    .localeCompare(b.isNicknamed ? b.nickname : b.species),
  level: (a, b) => b.level - a.level,                      // highest first
  type: (a, b) => (a.types[0] ?? '').localeCompare(b.types[0] ?? ''),
  shiny: (a, b) => Number(b.shiny) - Number(a.shiny),      // shinies first
  bst: (a, b) => sumStats(b) - sumStats(a),
};
const sumStats = (m) => m.stats
  ? Object.values(m.stats).reduce((x, y) => x + y, 0) : 0;

export const SORT_LABELS = {
  dex: 'Dex number', name: 'Species name', nickname: 'Nickname',
  level: 'Level (high first)', type: 'Primary type',
  shiny: 'Shiny first', bst: 'Total stats',
};

/** A location key: 'party', 'battleBox', or a 0-indexed box number. */
export const locLabel = (loc) =>
  loc === 'party' ? 'Party' : loc === 'battleBox' ? 'Battle Box' : `Box ${loc + 1}`;

export const locCapacity = (loc) =>
  loc === 'party' ? PARTY_SLOTS : loc === 'battleBox' ? BATTLE_BOX_SLOTS : BOX_SLOTS;

export class FactoryError extends Error {}

export class Factory {
  constructor(save, S) {
    this.S = S;
    this.save = save.clone();
    this.origin = save;
    this.undoStack = [];
    this.dirty = false;
  }

  // ------------------------------------------------------------- reading
  /** Locations in the order the UI shows them. Boxes beyond capacity are marked. */
  locations() {
    const cap = this.save.boxCapacity;
    const names = this.save.boxNames();
    const out = [
      { loc: 'party', label: 'Party', hidden: false },
      { loc: 'battleBox', label: 'Battle Box', hidden: false },
    ];
    for (let n = 0; n < BOX_COUNT; n++) {
      out.push({ loc: n, label: `Box ${n + 1}`, name: names[n], hidden: n >= cap });
    }
    return out;
  }

  get boxCapacity() { return this.save.boxCapacity; }

  /** Every slot in one location, occupied or not. */
  read(loc) {
    const n = locCapacity(loc);
    const out = [];
    for (let i = 0; i < n; i++) {
      const f = this.save.readSlot(loc, i);
      out.push({ loc, index: i, mon: f ? this.describe(f) : null });
    }
    return out;
  }

  /** How many Pokemon are in each location, for the sidebar counts. */
  counts() {
    const out = new Map();
    for (const { loc } of this.locations()) out.set(loc, this.save.readGroup(loc).length);
    return out;
  }

  /** A decoded record, joined to the ROM tables, in the shape the UI draws. */
  describe(f) {
    const S = this.S;
    const sp = S.SPECIES[String(f.species_id)];
    const level = f.stored_level ?? (sp ? levelForExp(sp.curve, f.exp) : null);
    const stats = sp && level != null
      ? computeStats(sp.base, f.ivs, f.evs, level, f.nature_id, f.species_id) : null;
    const legalAbilities = sp ? [...new Set([...(sp.ability_ids ?? [])].filter(Boolean)) ] : [];
    return {
      speciesId: f.species_id,
      species: sp?.name ?? `#${f.species_id}`,
      types: sp?.types ?? [],
      sprite: S.SPRITE[sp?.name] ?? null,
      nickname: f.nickname,
      isNicknamed: f.is_nicknamed,
      level,
      exp: f.exp,
      nature: NATURES[f.nature_id] ?? null,
      natureId: f.nature_id,
      abilityId: f.ability_id,
      ability: S.ABILBYID[String(f.ability_id)] ?? `#${f.ability_id}`,
      abilityLegal: legalAbilities.includes(f.ability_id),
      gender: ['male', 'female', 'genderless'][f.gender] ?? 'male',
      shiny: f.is_shiny,
      isEgg: f.is_egg,
      itemId: f.item_id,
      item: f.item_id ? (S.ITEMS[String(f.item_id)] ?? `#${f.item_id}`) : null,
      // Which ball it lives in. Cosmetic in game, but the picker cannot mark
      // the current one without it.
      ballId: f.ball_id ?? null,
      ball: f.ball_id ? (S.ITEMS[String(f.ball_id)] ?? `#${f.ball_id}`) : null,
      moveIds: f.move_ids,
      moves: f.move_ids.map((id, i) => (id ? {
        id, name: S.MOVEBYID[String(id)] ?? `#${id}`, slot: i,
        pp: f.pp[i], ppUps: f.pp_ups[i],
      } : null)).filter(Boolean),
      ivs: f.ivs,
      evs: f.evs,
      friendship: f.friendship,
      stats,
      // Only party records store current HP -- a boxed Pokemon has none.
      currentHp: f.current_hp ?? null,
      maxHp: f.stored_stats?.hp ?? stats?.hp ?? null,
      otName: f.ot_name,
      tid: f.tid,
      sid: f.sid,
      pid: f.pid,
    };
  }

  /** Legal moves for a species: level-up plus TM/HM, as a Set of move ids. */
  legalMoves(speciesId) {
    const sp = this.S.SPECIES[String(speciesId)];
    if (!sp) return new Set();
    const out = new Set(sp.learn ?? []);
    for (const label of sp.tmhm ?? []) {
      const mid = this.S.TMMOVE[label];
      if (mid) out.add(mid);
    }
    return out;
  }

  // ------------------------------------------------------------- undo
  snapshot() {
    this.undoStack.push(this.save.toBytes());
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
  }

  get canUndo() { return this.undoStack.length > 0; }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.save = Save.load(prev);
    this.dirty = this.undoStack.length > 0 || !this.matchesOrigin();
    return true;
  }

  matchesOrigin() {
    const a = this.save.toBytes(), b = this.origin.toBytes();
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }

  // ------------------------------------------------------- party helpers
  /**
   * A decrypted 84-byte extra block known to be good, for cloning.
   * Prefers the slot being written to, then any other party member.
   */
  partyExtraTemplate(preferIndex = null) {
    const count = this.save.partyCountDeclared;
    const order = preferIndex == null ? [] : [preferIndex];
    for (let i = 0; i < PARTY_SLOTS; i++) if (!order.includes(i)) order.push(i);
    for (const i of order) {
      if (i >= count) continue;
      if (!this.save.readSlot('party', i)) continue;
      return this.save.partySlotRaw(i).extra;
    }
    throw new FactoryError(
      'This save has no party member to copy a party slot layout from, and building '
      + 'one from scratch is not safe. Put at least one Pokémon in your party in game first.');
  }

  /** Turn a 136-byte box record into a party entry, cloning an extra block. */
  toPartyEntry(record, preferIndex = null) {
    const f = decodeRecord(record, 0, false);
    if (!f) throw new FactoryError('that record does not decode');
    const sp = this.S.SPECIES[String(f.species_id)];
    if (!sp) throw new FactoryError(`unknown species #${f.species_id}`);
    const level = levelForExp(sp.curve, f.exp);
    const stats = computeStats(sp.base, f.ivs, f.evs, level, f.nature_id, f.species_id);
    const extra = Save.patchPartyExtra(this.partyExtraTemplate(preferIndex), { level, stats });
    return { record, extra };
  }

  /** The party as a compact array of {record, extra}. */
  partyEntries() {
    const out = [];
    for (let i = 0; i < PARTY_SLOTS; i++) {
      if (!this.save.readSlot('party', i)) continue;
      out.push(this.save.partySlotRaw(i));
    }
    return out;
  }

  writePartyEntries(entries) {
    if (entries.length === 0) {
      throw new FactoryError('the party cannot be empty — the game needs at least one Pokémon in it');
    }
    this.save.writeParty(entries);
  }

  // ------------------------------------------------------------- writing
  /** The raw 136-byte record at a slot, or null. */
  recordAt(loc, index) {
    return this.save.readSlot(loc, index) ? this.save.recordBytes(loc, index) : null;
  }

  putBox(loc, index, record) {
    this.save.writeSlot(loc, index, record ?? new Uint8Array(PK5_BOX_SIZE));
    this.save.reseal([loc === 'battleBox' ? BLOCKS.battleBox : boxBlock(loc)]);
  }

  /**
   * Move or swap between any two slots.
   *
   * Party <-> box crossings are the interesting case: going in, the record
   * needs an extra block cloned from a real party member; coming out, the
   * extra is simply dropped. Either way the party is rewritten whole so it
   * stays contiguous.
   */
  move(from, to) {
    if (from.loc === to.loc && from.index === to.index) return;
    const src = this.recordAt(from.loc, from.index);
    if (!src) throw new FactoryError('nothing to move from that slot');
    const dst = this.recordAt(to.loc, to.index);

    this.snapshot();
    try {
      const touchesParty = from.loc === 'party' || to.loc === 'party';
      if (!touchesParty) {
        this.putBox(to.loc, to.index, src);
        this.putBox(from.loc, from.index, dst);           // swap, or blank
      } else if (from.loc === 'party' && to.loc === 'party') {
        const e = this.partyEntries();
        if (from.index >= e.length) throw new FactoryError('that party slot is empty');
        const target = Math.min(to.index, e.length - 1);
        const [item] = e.splice(from.index, 1);
        e.splice(target, 0, item);
        this.writePartyEntries(e);
      } else if (to.loc === 'party') {
        const e = this.partyEntries();
        const entry = this.toPartyEntry(src, to.index);
        if (to.index < e.length) {
          const displaced = e[to.index].record;
          e[to.index] = entry;
          this.putBox(from.loc, from.index, displaced);   // swap back into the box
        } else {
          if (e.length >= PARTY_SLOTS) throw new FactoryError('the party is full');
          e.push(entry);
          this.putBox(from.loc, from.index, null);
        }
        this.writePartyEntries(e);
      } else {                                            // party -> box
        const e = this.partyEntries();
        if (from.index >= e.length) throw new FactoryError('that party slot is empty');
        const rec = e[from.index].record;
        if (dst) {
          e[from.index] = this.toPartyEntry(dst, from.index);
        } else {
          if (e.length <= 1) {
            throw new FactoryError('that is your last party Pokémon — the party cannot be empty');
          }
          e.splice(from.index, 1);
        }
        this.writePartyEntries(e);
        this.putBox(to.loc, to.index, rec);
      }
      this.dirty = true;
    } catch (err) {
      this.undo();
      throw err;
    }
  }

  /**
   * A whole location as a positional array: entry or null per slot.
   * Party entries carry their extra block; box entries are records only.
   */
  slotsOf(loc) {
    const n = locCapacity(loc);
    const out = [];
    for (let i = 0; i < n; i++) {
      if (!this.save.readSlot(loc, i)) { out.push(null); continue; }
      out.push(loc === 'party' ? this.save.partySlotRaw(i)
        : { record: this.save.recordBytes(loc, i) });
    }
    return out;
  }

  /**
   * Write a positional array back to a location.
   *
   * The party is the special case twice over: it compacts (the game expects
   * slots 0..count-1 filled with nothing after), and any entry arriving from
   * a box needs an extra block cloned for it.
   */
  putSlots(loc, arr) {
    if (loc === 'party') {
      const entries = arr.filter(Boolean).map((e, i) => (e.extra ? e : this.toPartyEntry(e.record, i)));
      this.writePartyEntries(entries);
      return;
    }
    for (let i = 0; i < locCapacity(loc); i++) {
      this.save.writeSlot(loc, i, arr[i]?.record ?? new Uint8Array(PK5_BOX_SIZE));
    }
    this.save.reseal([loc === 'battleBox' ? BLOCKS.battleBox : boxBlock(loc)]);
  }

  /**
   * Move several Pokemon at once into `toLoc`, inserting at `startIndex`.
   *
   * ONE RULE, because two would be unpredictable: the selection is lifted
   * out, and dropped in at the target position with the destination's
   * remaining Pokemon closing up around it. Gaps in the destination box are
   * closed. That is what "move these five to Box 3" should do, and unlike
   * filling free slots it also does the right thing when reordering inside a
   * box that is already full -- where fill-the-gaps is a silent no-op.
   *
   * Never swaps: with more than one source there is nothing sensible to swap
   * with. It refuses up front if the destination cannot hold everything, so
   * a reorganisation either happens completely or not at all.
   */
  moveMany(froms, toLoc, startIndex = 0) {
    const list = froms.filter((f) => this.recordAt(f.loc, f.index));
    if (!list.length) throw new FactoryError('nothing selected to move');

    const byLoc = new Map();
    const arrOf = (loc) => {
      if (!byLoc.has(loc)) byLoc.set(loc, this.slotsOf(loc));
      return byLoc.get(loc);
    };

    // Lift the selection out first, so a source already in the destination
    // frees its own slot instead of competing with itself for room.
    const carried = list
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((f) => {
        const e = arrOf(f.loc)[f.index];
        arrOf(f.loc)[f.index] = null;
        return e;
      });

    const dest = arrOf(toLoc);
    const keep = dest.filter(Boolean);
    const cap = locCapacity(toLoc);
    if (keep.length + carried.length > cap) {
      throw new FactoryError(
        `${locLabel(toLoc)} holds ${cap}. It already has ${keep.length}, `
        + `and ${carried.length} more will not fit.`);
    }
    // Ordinal insert position: how many of the survivors sit before the slot
    // that was clicked.
    const before = dest.slice(0, startIndex).filter(Boolean).length;

    this.snapshot();
    try {
      const merged = [...keep.slice(0, before), ...carried, ...keep.slice(before)];
      const next = new Array(cap).fill(null);
      merged.forEach((e, i) => { next[i] = e; });
      byLoc.set(toLoc, next);
      for (const [loc, arr] of byLoc) this.putSlots(loc, arr);
      this.dirty = true;
      return carried.map((_, k) => ({ loc: toLoc, index: before + k }));
    } catch (err) {
      this.undo();
      throw err;
    }
  }

  /**
   * Sort one location, compacting to the front.
   *
   * Sorting the party reorders who leads, which matters in game, so it is
   * offered there too rather than being restricted to boxes.
   */
  /**
   * Put exactly this line-up in the party, sending whoever is there now away.
   *
   * NOT moveMany(). That one INSERTS -- it lifts the six out of their boxes and
   * drops them into the party alongside whoever is already there, so fielding a
   * core into a full party asked for twelve slots and failed with "Party holds
   * 6. It already has 6, and 6 more will not fit." Fielding is a REPLACEMENT,
   * which is what the confirm dialog had been promising all along.
   *
   * Three things this has to get right:
   *
   *   - A member already IN the party stays put rather than being evicted and
   *     re-added, so fielding a core that overlaps your party is not a shuffle.
   *   - Everyone displaced needs somewhere to go, and it has to be found BEFORE
   *     anything moves: running out of box space halfway through would leave
   *     the save in a state nobody asked for. If there is not room, this
   *     refuses and says so.
   *   - The party must end up contiguous and non-empty, which putSlots()
   *     enforces.
   *
   * One snapshot, so the whole thing is a single undo.
   */
  fieldParty(list) {
    const want = list.slice(0, locCapacity('party'));
    if (!want.length) throw new FactoryError('nothing to field');

    const key = (a) => `${a.loc}:${a.index}`;
    const wanted = new Set(want.map(key));
    const party = this.slotsOf('party');
    const staying = [];
    const evict = [];
    party.forEach((e, i) => {
      if (!e) return;
      (wanted.has(key({ loc: 'party', index: i })) ? staying : evict)
        .push({ at: { loc: 'party', index: i }, entry: e });
    });

    // Find every destination up front, on a copy of the box occupancy, so a
    // half-done field is impossible.
    const boxes = new Map();
    const occupied = (loc) => {
      if (!boxes.has(loc)) boxes.set(loc, this.slotsOf(loc).map(Boolean));
      return boxes.get(loc);
    };
    const incoming = new Set(want.filter((a) => a.loc !== 'party').map(key));
    const homes = [];
    for (const e of evict) {
      let spot = null;
      for (const { loc } of this.locations()) {
        if (loc === 'party') continue;
        const occ = occupied(loc);
        // A slot a wanted Pokemon is about to vacate counts as free.
        const i = occ.findIndex((full, idx) => !full || incoming.has(`${loc}:${idx}`));
        if (i >= 0) { occ[i] = true; incoming.delete(`${loc}:${i}`); spot = { loc, index: i }; break; }
      }
      if (!spot) {
        throw new FactoryError('there is no free box slot for the Pokémon currently '
          + 'in your party. Free one up, or raise the number of boxes, and try again.');
      }
      homes.push({ from: e, to: spot });
    }

    this.snapshot();
    try {
      // Read every record we are about to place BEFORE writing anything --
      // once a slot is overwritten its old contents are gone.
      const bring = want.filter((a) => a.loc !== 'party')
        .map((a) => ({ at: a, record: this.save.recordBytes(a.loc, a.index) }));
      const kept = staying.map((e) => e.entry);

      // Clear the source box slots and the old party, then place.
      const cleared = new Map();
      const clear = (loc, index) => {
        if (!cleared.has(loc)) cleared.set(loc, this.slotsOf(loc));
        cleared.get(loc)[index] = null;
      };
      for (const b of bring) clear(b.at.loc, b.at.index);
      for (const h of homes) {
        clear(h.to.loc, h.to.index);
        cleared.get(h.to.loc)[h.to.index] = { record: h.from.entry.record };
      }
      for (const [loc, arr] of cleared) this.putSlots(loc, arr);

      this.putSlots('party', [...kept, ...bring.map((b) => ({ record: b.record }))]);
      this.dirty = true;
      return { fielded: want.length, displaced: homes.length };
    } catch (err) {
      this.undo();
      throw err;
    }
  }

  sortBox(loc, key, dir = 1) {
    const arr = this.slotsOf(loc);
    const filled = arr.filter(Boolean);
    if (filled.length < 2) return;

    const meta = filled.map((e) => {
      const f = decodeRecord(e.record, 0, false);
      const m = this.describe(f);
      return { e, m };
    });
    const cmp = SORTS[key];
    if (!cmp) throw new FactoryError(`unknown sort "${key}"`);
    // Ties fall back to dex then level so a sort is deterministic -- otherwise
    // sorting the same box twice could give two different layouts.
    meta.sort((a, b) => (cmp(a.m, b.m) * dir)
      || (a.m.speciesId - b.m.speciesId) || (b.m.level - a.m.level));

    this.snapshot();
    try {
      const next = new Array(arr.length).fill(null);
      meta.forEach((x, i) => { next[i] = x.e; });
      this.putSlots(loc, next);
      this.dirty = true;
    } catch (err) {
      this.undo();
      throw err;
    }
  }

  /**
   * sortBox's body without the snapshot, so sorting 24 boxes is ONE undo step
   * rather than 24. Undoing a bulk operation halfway is worse than not
   * offering it.
   */
  sortOneNoSnapshot(loc, key, dir = 1) {
    const arr = this.slotsOf(loc);
    const filled = arr.filter(Boolean);
    if (filled.length < 2) return;
    const cmp = SORTS[key];
    if (!cmp) throw new FactoryError(`unknown sort "${key}"`);
    const meta = filled.map((e) => ({ e, m: this.describe(decodeRecord(e.record, 0, false)) }));
    meta.sort((a, b) => (cmp(a.m, b.m) * dir)
      || (a.m.speciesId - b.m.speciesId) || (b.m.level - a.m.level));
    const next = new Array(arr.length).fill(null);
    meta.forEach((x, i) => { next[i] = x.e; });
    this.putSlots(loc, next);
  }

  /**
   * Heal the party: full HP, full PP, no status. A Pokemon Centre visit
   * without the walk.
   *
   * It only touches the PARTY, which is what a Centre heals. A boxed Pokemon
   * has no stored HP or status at all -- those live in the party extra block
   * -- so "healing" one would mean only its PP, and it comes out of the box
   * at full anyway.
   *
   * PP is stored already boosted: base + base*ppUps/5.
   */
  healParty() {
    const entries = [];
    const healed = [];
    for (let i = 0; i < PARTY_SLOTS; i++) {
      const f = this.save.readSlot('party', i);
      if (!f) continue;
      const raw = this.save.partySlotRaw(i);
      const body = new Uint8Array(f.body);

      let ppRestored = 0;
      f.move_ids.forEach((mid, k) => {
        if (!mid) { body[B.PP + k] = 0; body[B.PPUP + k] = 0; return; }
        const base = this.S.MOVES[this.S.MOVEBYID[String(mid)]]?.pp ?? 0;
        const ups = f.pp_ups[k] ?? 0;
        const max = base + Math.floor(base * ups / 5);
        if (body[B.PP + k] !== max) ppRestored += max - body[B.PP + k];
        body[B.PP + k] = max;
      });

      // The stored stats are the game's own numbers, so max HP comes from
      // there rather than being recomputed.
      const maxHp = f.stored_stats?.hp ?? 0;
      const hpRestored = Math.max(0, maxHp - (f.current_hp ?? maxHp));
      const extra = new Uint8Array(raw.extra);
      const dv = new DataView(extra.buffer);
      dv.setUint32(0x00, 0, true);                 // status: clear
      dv.setUint16(PB.CURHP, maxHp, true);

      entries.push({ record: encodeRecord(f.pid, f.sanity, body), extra });
      if (hpRestored || ppRestored) {
        healed.push({ name: this.describe(f).species, hp: hpRestored, pp: ppRestored });
      }
    }
    // Nothing to do: no write, no undo step, no dirty flag. A no-op that still
    // costs an undo is noise -- and it made "undo the heal" undo the wrong one.
    if (!entries.length || !healed.length) return { healed: [], count: entries.length };

    this.snapshot();
    try {
      this.save.writeParty(entries);
      this.dirty = true;
      return { healed, count: entries.length };
    } catch (err) {
      this.undo();
      throw err;
    }
  }

  /** Boxes the game actually shows, 0-indexed. */
  visibleBoxes() {
    return Array.from({ length: this.save.boxCapacity }, (_, n) => n);
  }

  /**
   * Sort every box, each one INDEPENDENTLY.
   *
   * Nothing moves between boxes, which is what makes this safe to run on a
   * save whose boxes mean something -- teams in their own boxes, a living dex
   * in a run of five, a box of Pokémon actually caught. Order inside a box is
   * not load-bearing for any of that; box MEMBERSHIP is.
   *
   * Returns the boxes it actually changed.
   */
  sortAllBoxes(key, dir = 1, { boxes = null } = {}) {
    const targets = (boxes ?? this.visibleBoxes())
      .filter((n) => this.read(n).filter((s) => s.mon).length > 1);
    if (!targets.length) return [];

    this.snapshot();
    try {
      for (const n of targets) this.sortOneNoSnapshot(n, key, dir);
      this.dirty = true;
      return targets;
    } catch (err) {
      this.undo();
      throw err;
    }
  }

  /**
   * Gather every Pokemon out of `boxes`, sort them as one pool, and lay them
   * back out in order, filling each box before starting the next.
   *
   * This DOES move Pokemon between boxes, so it will scatter anything whose
   * box membership means something. Callers must say so before running it --
   * see the confirm in tabs/factory.js.
   */
  regroupBoxes(key, dir = 1, { boxes = null } = {}) {
    const targets = (boxes ?? this.visibleBoxes()).slice().sort((a, b) => a - b);
    const pool = [];
    for (const n of targets) for (const e of this.slotsOf(n)) if (e) pool.push(e);
    if (pool.length > targets.length * BOX_SLOTS) {
      throw new FactoryError(
        `${pool.length} Pokémon will not fit in ${targets.length} boxes`);
    }
    if (pool.length < 2) return { moved: 0, boxes: targets };

    const cmp = SORTS[key];
    if (!cmp) throw new FactoryError(`unknown sort "${key}"`);
    const meta = pool.map((e) => ({ e, m: this.describe(decodeRecord(e.record, 0, false)) }));
    meta.sort((a, b) => (cmp(a.m, b.m) * dir)
      || (a.m.speciesId - b.m.speciesId) || (b.m.level - a.m.level));

    this.snapshot();
    try {
      let k = 0;
      for (const n of targets) {
        const next = new Array(BOX_SLOTS).fill(null);
        for (let i = 0; i < BOX_SLOTS && k < meta.length; i++, k++) next[i] = meta[k].e;
        this.putSlots(n, next);
      }
      this.dirty = true;
      return { moved: pool.length, boxes: targets };
    } catch (err) {
      this.undo();
      throw err;
    }
  }

  /** How many Pokemon a regroup would relocate, for the confirm dialog. */
  regroupPreview(key, dir = 1, { boxes = null } = {}) {
    const targets = (boxes ?? this.visibleBoxes()).slice().sort((a, b) => a - b);
    const before = [];
    for (const n of targets) for (const e of this.slotsOf(n)) if (e) before.push({ n, e });
    const cmp = SORTS[key];
    if (!cmp || before.length < 2) return { total: before.length, moving: 0, boxes: targets };
    const meta = before.map((x) => ({ ...x, m: this.describe(decodeRecord(x.e.record, 0, false)) }));
    const sorted = meta.slice().sort((a, b) => (cmp(a.m, b.m) * dir)
      || (a.m.speciesId - b.m.speciesId) || (b.m.level - a.m.level));
    let moving = 0, k = 0;
    for (const n of targets) {
      for (let i = 0; i < BOX_SLOTS && k < sorted.length; i++, k++) {
        if (sorted[k].n !== n) moving++;
      }
    }
    return { total: before.length, moving, boxes: targets };
  }

  /**
   * Change specific bytes of one record, leaving everything else alone.
   *
   * buildRecord() rewrites a record from a whole spec, which is right for the
   * editor and wrong for "hand this one a Life Orb" -- there, anything the
   * spec does not mention would be rebuilt from defaults. This decodes,
   * applies exactly what you asked for, and re-encodes.
   *
   * @param {function(Uint8Array, object): any} mutate  edits the 128-byte body
   */
  patchAt(at, mutate) {
    const f = this.save.readSlot(at.loc, at.index);
    if (!f) throw new FactoryError('there is nothing in that slot');
    const body = new Uint8Array(f.body);
    const result = mutate(body, f);
    const record = encodeRecord(f.pid, f.sanity, body);

    this.snapshot();
    try {
      if (at.loc === 'party') {
        const entries = this.partyEntries();
        // The party is contiguous, so slot index == position in the list.
        entries[at.index] = { record, extra: this.save.partySlotRaw(at.index).extra };
        this.writePartyEntries(entries);
      } else {
        this.putBox(at.loc, at.index, record);
      }
      this.dirty = true;
      return result;
    } catch (err) {
      this.undo();
      throw err;
    }
  }

  /**
   * Put a Pokemon in a different ball. Returns the ball it was in.
   *
   * Cosmetic in Gen 5 -- nothing reads the ball but the summary screen and the
   * flash when it is sent out -- which is exactly why it is worth having: it
   * is the one part of a record you would change purely because you want to.
   * The ball is a single byte, so this is patchAt's simplest possible use, and
   * `buildRecord` is deliberately NOT the route: it rebuilds from a whole spec
   * and would reset everything the spec does not mention.
   */
  /**
   * Rename, and nothing else.
   *
   * WHY THIS IS NOT JUST "OPEN THE EDITOR".
   * A nuzlocke's `nickname-all` rule REQUIRES a nickname, and `no-editing`
   * closes the editor -- so the only control that could set one was shut by a
   * rule that exists alongside the rule demanding it. The two contradicted
   * each other outright.
   *
   * Renaming is also the one edit that is unambiguously legal in a
   * playthrough: the game has a name rater. So it is its own operation, never
   * gated, and `patchAt` keeps it to the bytes it actually touches -- the name
   * field and the `is_nicknamed` bit -- rather than rebuilding the record.
   *
   * An EMPTY name clears the flag, which is how the game says "no nickname":
   * the species name is then shown, and writing the species name into the
   * field while leaving the flag set would be a different thing that merely
   * looks the same.
   */
  rename(at, name) {
    const clean = String(name ?? '').slice(0, 10);
    return this.patchAt(at, (body) => {
      const bv = new DataView(body.buffer, body.byteOffset, body.byteLength);
      const had = bv.getUint32(B.IVS, true);
      if (clean) {
        body.set(encodeString(clean, 10, B.NICKNAME_LEN * 2), B.NICKNAME);
        bv.setUint32(B.IVS, (had | 0x80000000) >>> 0, true);
      } else {
        const sp = this.S.SPECIES[String(this.save.readSlot(at.loc, at.index)?.species_id)];
        body.set(encodeString(sp?.name?.toUpperCase() ?? '', 10, B.NICKNAME_LEN * 2),
          B.NICKNAME);
        bv.setUint32(B.IVS, (had & 0x7fffffff) >>> 0, true);
      }
      return clean;
    });
  }

  setBall(at, ballId) {
    return this.patchAt(at, (body) => {
      const had = body[B.BALL];
      body[B.BALL] = ballId & 0xff;
      return had;
    });
  }

  /**
   * Hand a Pokemon a held item. Returns the item it was already holding, so
   * the caller can put that back in the bag -- swapping an item should not
   * quietly destroy the one being replaced.
   */
  giveItem(at, itemId) {
    return this.patchAt(at, (body) => {
      const dv = new DataView(body.buffer);
      const had = dv.getUint16(B.ITEM, true);
      dv.setUint16(B.ITEM, itemId, true);
      return had;
    });
  }

  /**
   * Teach a move into a slot, with the PP the game would give it.
   *
   * PP Ups do not survive the swap: they belong to the move that was there,
   * not the slot, so a fresh move starts at base PP with none applied.
   */
  teachMove(at, moveId, slot) {
    if (slot < 0 || slot > 3) throw new FactoryError('a move slot is 0..3');
    const name = this.S.MOVEBYID[String(moveId)];
    const base = this.S.MOVES[name]?.pp ?? 0;
    return this.patchAt(at, (body) => {
      const dv = new DataView(body.buffer);
      const had = dv.getUint16(B.MOVES + 2 * slot, true);
      dv.setUint16(B.MOVES + 2 * slot, moveId, true);
      body[B.PP + slot] = base;
      body[B.PPUP + slot] = 0;
      return had;
    });
  }

  /** Everyone who can legally learn this TM/HM label, with where they are. */
  canLearn(tmLabel) {
    const out = [];
    for (const l of this.locations()) {
      for (const s of this.read(l.loc)) {
        if (!s.mon) continue;
        const sp = this.S.SPECIES[String(s.mon.speciesId)];
        if ((sp?.tmhm ?? []).includes(tmLabel)) out.push({ loc: l.loc, index: s.index, mon: s.mon });
      }
    }
    return out;
  }

  /** Delete the Pokemon at a slot. Permanent in the working copy; undoable. */
  remove(at) {
    if (!this.recordAt(at.loc, at.index)) return;
    this.snapshot();
    try {
      if (at.loc === 'party') {
        const e = this.partyEntries();
        if (e.length <= 1) {
          throw new FactoryError('that is your last party Pokémon — the party cannot be empty');
        }
        e.splice(at.index, 1);
        this.writePartyEntries(e);
      } else {
        this.putBox(at.loc, at.index, null);
      }
      this.dirty = true;
    } catch (err) {
      this.undo();
      throw err;
    }
  }

  /**
   * Write a spec over a slot.
   *
   * `template` is the record being edited when there is one, so everything
   * the codec does not model -- origin game, language, ball, met location and
   * date, encounter type, ribbons -- survives the edit untouched. Creating
   * from empty has to borrow a template from elsewhere in the save, and the
   * UI says whose.
   */
  write(at, spec, { template = null } = {}) {
    const existing = this.recordAt(at.loc, at.index);
    const tmpl = template ?? existing ?? this.anyTemplate();
    const record = buildRecord(tmpl, spec, this.tables());

    this.snapshot();
    try {
      if (at.loc === 'party') {
        const e = this.partyEntries();
        const entry = this.toPartyEntry(record, at.index);
        if (at.index < e.length) e[at.index] = entry;
        else if (e.length < PARTY_SLOTS) e.push(entry);
        else throw new FactoryError('the party is full');
        this.writePartyEntries(e);
      } else {
        this.putBox(at.loc, at.index, record);
      }
      this.dirty = true;
    } catch (err) {
      this.undo();
      throw err;
    }
  }

  /** Any real record to clone when creating from an empty slot. */
  anyTemplate() {
    for (let i = 0; i < PARTY_SLOTS; i++) if (this.save.readSlot('party', i)) return this.save.recordBytes('party', i);
    for (let n = 0; n < BOX_COUNT; n++) {
      for (let s = 0; s < BOX_SLOTS; s++) if (this.save.readSlot(n, s)) return this.save.recordBytes(n, s);
    }
    throw new FactoryError('this save has no Pokémon to use as a template');
  }

  /** Where anyTemplate() would take its clone from, for the UI to name. */
  templateSource() {
    for (let i = 0; i < PARTY_SLOTS; i++) {
      const f = this.save.readSlot('party', i);
      if (f) return { loc: 'party', index: i, species: this.describe(f).species };
    }
    for (let n = 0; n < BOX_COUNT; n++) {
      for (let s = 0; s < BOX_SLOTS; s++) {
        const f = this.save.readSlot(n, s);
        if (f) return { loc: n, index: s, species: this.describe(f).species };
      }
    }
    return null;
  }

  duplicate(at) {
    const rec = this.recordAt(at.loc, at.index);
    if (!rec) throw new FactoryError('nothing to duplicate');
    const free = this.firstFree(at.loc);
    if (!free) throw new FactoryError(`${locLabel(at.loc)} is full`);
    this.snapshot();
    try {
      if (at.loc === 'party') {
        const e = this.partyEntries();
        if (e.length >= PARTY_SLOTS) throw new FactoryError('the party is full');
        e.push(this.toPartyEntry(rec, at.index));
        this.writePartyEntries(e);
      } else {
        this.putBox(free.loc, free.index, rec);
      }
      this.dirty = true;
      return free;
    } catch (err) {
      this.undo();
      throw err;
    }
  }

  firstFree(loc) {
    for (let i = 0; i < locCapacity(loc); i++) {
      if (!this.save.readSlot(loc, i)) return { loc, index: i };
    }
    return null;
  }

  /**
   * Raise how many boxes the game shows. Ships at 8, and anything written
   * above that passes every checksum while being completely invisible in
   * game -- which has happened here before.
   */
  setBoxCapacity(n) {
    this.snapshot();
    this.save.setBoxCapacity(n);
    this.dirty = true;
  }

  // ------------------------------------------------------------- output
  /** The tables shim js/mon.js's buildRecord expects, backed by static.json. */
  tables() {
    if (this._tables) return this._tables;
    const S = this.S;
    const byName = new Map();
    for (const [id, sp] of Object.entries(S.SPECIES)) byName.set(sp.name.toLowerCase(), Number(id));
    const moveByName = new Map();
    for (const [id, name] of Object.entries(S.MOVEBYID)) moveByName.set(String(name).toLowerCase(), Number(id));
    const itemByName = new Map();
    for (const [id, name] of Object.entries(S.ITEMS)) itemByName.set(String(name).toLowerCase(), Number(id));

    this._tables = {
      loaded: { species: true, moves: true, items: true },
      speciesData: (id) => {
        const sp = S.SPECIES[String(id)];
        if (!sp) return null;
        return { name: sp.name, growth_curve_id: sp.curve, gender_ratio: sp.ratio, base_stats: sp.base };
      },
      speciesId: (n) => byName.get(String(n).toLowerCase()) ?? null,
      moveId: (n) => moveByName.get(String(n).toLowerCase()) ?? null,
      moveData: (id) => {
        const name = S.MOVEBYID[String(id)];
        const m = name ? S.MOVES[name] : null;
        return m ? { pp: m.pp, name } : null;
      },
      itemId: (n) => itemByName.get(String(n).toLowerCase()) ?? null,
    };
    return this._tables;
  }

  /**
   * The edited save, or an explanation of why it is not safe to hand over.
   * Nothing downstream should offer a download without checking `ok`.
   */
  output() {
    const v = this.save.verify();
    if (!v.ok) return { ok: false, problems: v.problems, bytes: null };
    const rt = this.save.selfTestRoundTrip();
    if (!rt.ok) return { ok: false, problems: [`records do not re-encode: ${rt.failures.join(', ')}`], bytes: null };
    return { ok: true, problems: [], bytes: this.save.toBytes(), records: rt.checked };
  }
}
