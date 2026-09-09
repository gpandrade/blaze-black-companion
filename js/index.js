/**
 * index.js -- the public surface of the JS save layer.
 *
 * The bridge that makes the browser half possible: with it, a .sav can be
 * dropped into a page and read, edited and downloaded entirely client-side,
 * with no server.
 *
 *     import { Save, Tables, presentAll, buildRecord } from './js/index.js';
 *
 *     const save = Save.load(await file.arrayBuffer(), { lastModified: file.lastModified });
 *     const tables = await Tables.fetch('./state/');
 *     const team = presentAll(save.readAll(), tables);
 *
 *     const rec = buildRecord(save.recordBytes(1, 2), {
 *       species: 'Metagross', level: 50, ability: 'Iron Fist', nature: 'Adamant',
 *       moves: ['Meteor Mash', 'Earthquake', 'Bullet Punch', 'Zen Headbutt'],
 *     }, tables);
 *     const edited = save.clone().writeBox(8, [rec]);   // reseals all three tiers
 *     if (edited.verify().ok) download(edited.toBytes());
 *
 * WHAT IS AND IS NOT PORTED
 *   ported      PK5 record decode/encode, the LCRNG cipher, the block
 *               shuffle, CRC16, slot validation and selection, party, all 24
 *               boxes, the Battle Box, box names and the box-capacity byte,
 *               bag pockets, the three-tier reseal, and clone-and-patch
 *               record construction.
 *   NOT ported  parse_bag.py's position / Pokedex / trainer-card blocks, and
 *               parse_save.py's experience-curve inference.  The curve
 *               inference is deliberately dropped, not missing: it exists to
 *               survive without the ROM tables, and this layer reads the
 *               curve straight out of state/personal.json, which is exact.
 *   CANNOT be   anything in the ROM rather than the save -- typing above all.
 *               A record stores species, ability, moves, nature, IVs, EVs and
 *               gender; type comes from the ROM's personal table, so changing
 *               it means patching the .nds.
 */

export {
  B, PB, BLOCK_ORDERS, CURVE_NAMES, MAX_LEVEL, NATURES,
  PK5_BOX_SIZE, PK5_PARTY_SIZE, SAVE_STAT_ORDER, STAT_ORDER,
  computeStats, crc16ccitt, curvesConsistentWith, decodeRecord, decodeString,
  encodeRecord, encodeString, expForLevel, isShiny, lcrngCrypt, levelForExp,
  namedStats, natureMultiplier, pk5Checksum, reencode, shuffle, unshuffle,
} from './pk5.js';

export {
  BAG_BLOCK, BATTLE_BOX, BLOCKS, BOX_BASE, BOX_COUNT, BOX_SLOTS, BOX_STRIDE,
  CHK, CHECKSUM_TABLE, FOOTER, FOOTER_MAGIC, PARTY_BLOCK, POCKETS,
  SAVE_SIZE, SLOT_OFFSETS, SLOT_SIZE, Save, SaveError, boxBlock,
} from './save.js';

export { ABILITIES, Tables, abilityId, abilityName, natureId, natureName } from './tables.js';

export { blankRecord, buildRecord, presentAll, presentMon } from './mon.js';
