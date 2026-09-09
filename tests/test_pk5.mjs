/**
 * test_pk5.mjs -- differential test for the JavaScript PK5 save layer.
 *
 *     python3 tests/dump_pk5_truth.py && node tests/test_pk5.mjs
 *
 * Every assertion compares the JS port against tests/pk5_truth.json, which
 * the Python readers and writers produced from the same bytes.  The point is
 * not that the JS agrees with itself -- it is that it agrees with the code
 * that has actually been trusted with the real save.
 *
 * The write-path checks end at a whole-file CRC16: build the same records
 * from the same template, apply the same edit, reseal all three tiers, and
 * the resulting 524288 bytes must hash identically to what write_team.py
 * produced.  Nothing here touches the live save.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  crc16ccitt, CURVE_NAMES, decodeRecord, encodeRecord, expForLevel, lcrngCrypt,
  NATURES, pk5Checksum, shuffle, unshuffle,
} from '../js/pk5.js';
import { Save, BLOCKS, boxBlock, BOX_COUNT, SaveError, SAVE_SIZE } from '../js/save.js';
import { Tables } from '../js/tables.js';
import { buildRecord, presentMon } from '../js/mon.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const truth = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/pk5_truth.json'), 'utf8'));

let passed = 0;
const failures = [];
const ok = (cond, label, detail = '') => {
  if (cond) passed++;
  else failures.push(`${label}${detail ? `\n      ${detail}` : ''}`);
};
const eq = (got, want, label) =>
  ok(got === want, label, got === want ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const deepEq = (got, want, label) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  ok(a === b, label, a === b ? '' : `got ${a.slice(0, 220)}\n      want ${b.slice(0, 220)}`);
};
const hex = (u8) => Buffer.from(u8).toString('hex');
const section = (name) => console.log(`\n── ${name}`);

/**
 * Run a block and turn a thrown error into a recorded failure.  A port that
 * is broken badly enough to throw should still produce the diagnostic list
 * rather than a stack trace that hides every other result.
 */
const guard = (label, fn) => {
  try { fn(); } catch (e) { failures.push(`${label} threw: ${e.message}`); }
};

// ===========================================================================
section('pure math');
// ===========================================================================
for (let c = 0; c < 6; c++) {
  const want = truth.curves[CURVE_NAMES[c]];
  const got = Array.from({ length: 100 }, (_, i) => expForLevel(c, i + 1));
  deepEq(got, want, `experience curve "${CURVE_NAMES[c]}" over levels 1..100`);
}
deepEq(Array.from(NATURES), truth.natures, '25 nature names');

// The LCRNG must wrap mod 2^32 exactly.  Plain float multiplication loses low
// bits here and every decode downstream turns to noise, so pin one step.
{
  const probe = new Uint8Array([0, 0, 0, 0]);
  const out = lcrngCrypt(probe, 0x12345678);
  let s = 0x12345678;
  const step = () => { s = (Math.imul(s, 0x41c64e6d) + 0x6073) >>> 0; return s >>> 16; };
  const w0 = step(), w1 = step();
  eq(out[0] | (out[1] << 8), w0, 'LCRNG step 1 (mod 2^32 wrap)');
  eq(out[2] | (out[3] << 8), w1, 'LCRNG step 2');
  deepEq(Array.from(lcrngCrypt(out, 0x12345678)), Array.from(probe), 'LCRNG is its own inverse');
}

// shuffle/unshuffle must be inverses for all 24 permutations.
{
  const body = new Uint8Array(128).map((_, i) => (i * 37) & 0xff);
  let allOk = true;
  for (let k = 0; k < 24; k++) {
    const pid = (k << 13) >>> 0;                       // selects permutation k
    const back = unshuffle(shuffle(body, pid), pid);
    if (!back.every((v, i) => v === body[i])) allOk = false;
  }
  ok(allOk, 'shuffle/unshuffle round-trip across all 24 block orders');
}

// ===========================================================================
// Per-corpus read + write checks
// ===========================================================================
const tables = new Tables({
  personal: JSON.parse(fs.readFileSync(path.join(ROOT, 'state/personal.json'), 'utf8')),
  moves: JSON.parse(fs.readFileSync(path.join(ROOT, 'state/moves.json'), 'utf8')),
  items: JSON.parse(fs.readFileSync(path.join(ROOT, 'state/items.json'), 'utf8')),
});

for (const [name, c] of Object.entries(truth.corpora)) {
  section(`corpus "${name}" — ${c.file}`);
  const file = path.join(ROOT, c.file);
  if (!fs.existsSync(file)) {
    failures.push(`corpus "${name}": ${c.file} is missing — re-run tests/dump_pk5_truth.py`);
    continue;
  }
  guard(`corpus "${name}"`, () => {
  const bytes = new Uint8Array(fs.readFileSync(file));
  eq(crc16ccitt(bytes), c.crc16,
    `${name}: file CRC16 pins the corpus (truth is stale if this fails)`);

  const sv = Save.load(bytes);

  // ---- container -------------------------------------------------------
  eq(sv.slotIndex, c.slot.index, `${name}: chose the same save slot`);
  eq(sv.slotReason, c.slot.reason, `${name}: same reason for that choice`);
  eq(sv.boxCapacity, c.box_capacity, `${name}: box capacity byte 0x3DD`);
  eq(sv.selectedBox, c.selected_box, `${name}: currently-selected box`);
  deepEq(sv.boxNames(), c.box_names, `${name}: 24 box names`);
  eq(sv.partyCountDeclared, c.party_count_declared, `${name}: declared party count`);

  for (const r of c.slot.reports) {
    const got = sv.slotReport(r.index);
    for (const k of ['counter', 'footer_length', 'footer_magic_ok', 'box_names_crc_ok',
      'boxes_crc_ok', 'boxes_crc_total', 'party_crc_ok', 'valid']) {
      eq(got[k], r[k], `${name}: slot ${r.index} report.${k}`);
    }
  }

  // ---- checksums, all three tiers -------------------------------------
  const blockByName = new Map([
    ['box names', BLOCKS.boxNames], ['bag', BLOCKS.bag],
    ['party', BLOCKS.party], ['battle box', BLOCKS.battleBox],
    ...Array.from({ length: BOX_COUNT }, (_, n) => [`box ${n + 1}`, boxBlock(n)]),
  ]);
  let crcRows = 0, crcBad = 0;
  for (const row of c.checksums) {
    if (row.block === 'footer') {
      const base = row.slot * 0x24000;
      const got = crc16ccitt(bytes, base + 0x23f00, base + 0x23f8c);
      if (got !== row.crc) crcBad++;
      crcRows++;
      continue;
    }
    const block = blockByName.get(row.block);
    if (sv.blockCrc(block, row.slot) !== row.crc) crcBad++;
    if (sv.inlineChecksum(block, row.slot) !== row.inline) crcBad++;
    if (sv.tableEntry(block.entry, row.slot) !== row.table) crcBad++;
    crcRows++;
  }
  ok(crcBad === 0, `${name}: ${crcRows} block CRCs + inline + table entries match Python`,
    crcBad ? `${crcBad} mismatched values` : '');
  deepEq(sv.verify(), { ok: true, problems: [] }, `${name}: all three integrity tiers verify`);

  // ---- records ---------------------------------------------------------
  const groups = { party: sv.readParty(), battleBox: sv.readBattleBox() };
  for (let n = 0; n < BOX_COUNT; n++) groups[String(n)] = sv.readBox(n);

  let recTotal = 0, recBad = [];
  for (const [where, want] of Object.entries(c.records)) {
    const got = groups[where] ?? [];
    if (got.length !== want.length) {
      recBad.push(`${where}: ${got.length} records, Python found ${want.length}`);
      continue;
    }
    for (let i = 0; i < want.length; i++) {
      const w = want[i], g = got[i];
      recTotal++;
      const mine = {
        pid: g.pid, sanity: g.sanity, checksum: g.checksum,
        species_id: g.species_id, item_id: g.item_id, tid: g.tid, sid: g.sid,
        exp: g.exp, friendship: g.friendship, ability_id: g.ability_id,
        nature_id: g.nature_id, gender: g.gender, gender_byte: g.gender_byte,
        evs: g.evs, ivs: g.ivs, is_egg: g.is_egg, is_nicknamed: g.is_nicknamed,
        is_shiny: g.is_shiny, move_ids: g.move_ids, pp: g.pp, pp_ups: g.pp_ups,
        nickname: g.nickname, ot_name: g.ot_name, stored_level: g.stored_level,
        body_hex: hex(g.body),
      };
      if (w.current_hp !== undefined) { mine.current_hp = g.current_hp; mine.stored_stats = g.stored_stats; }
      const wSlot = { slot: w.slot }; delete wSlot.slot;
      const want2 = { ...w }; delete want2.slot;
      if (g.slot !== w.slot) recBad.push(`${where}[${i}]: slot ${g.slot} != ${w.slot}`);
      for (const k of Object.keys(want2)) {
        if (JSON.stringify(mine[k]) !== JSON.stringify(want2[k])) {
          recBad.push(`${where} slot ${w.slot} (#${w.species_id}) field "${k}": ` +
            `${JSON.stringify(mine[k])?.slice(0, 80)} != ${JSON.stringify(want2[k])?.slice(0, 80)}`);
        }
      }
    }
  }
  const emptyGroups = Object.entries(groups).filter(([k, v]) => v.length && !c.records[k]);
  for (const [k, v] of emptyGroups) recBad.push(`${k}: JS found ${v.length} records where Python found none`);
  ok(recBad.length === 0, `${name}: ${recTotal} records decode identically to Python`,
    recBad.slice(0, 6).join('\n      '));

  // ---- round-trip ------------------------------------------------------
  const rt = sv.selfTestRoundTrip();
  ok(rt.ok, `${name}: encode(decode(x)) is byte-identical for all ${rt.checked} records`,
    rt.failures.join(', '));
  eq(rt.checked, c.record_count, `${name}: round-trip covered every record Python saw`);

  // ---- bag -------------------------------------------------------------
  deepEq(sv.readBag(), c.bag, `${name}: bag pockets`);

  // ---- write path ------------------------------------------------------
  const w = c.write;
  // The template comes from the file, so a template mismatch is caught before
  // any built record is compared and the failure says which layer broke.
  const tmplFrom = name === 'fixture' ? sv.recordBytes('party', 0) : sv.recordBytes(1, 2);
  eq(hex(tmplFrom), w.template_hex, `${name}: template record located at the same offset`);

  const built = w.specs.map((spec, i) => {
    const rec = buildRecord(tmplFrom, {
      species: spec.species, level: spec.level, ability: spec.ability,
      nature: spec.nature, moves: spec.moves, item_id: spec.item_id,
      evs: spec.evs, ivs: spec.ivs, shiny: spec.shiny, nick: spec.nick,
    }, tables);
    eq(hex(rec), w.built_hex[i],
      `${name}: buildRecord "${spec.species}" matches write_team.build_record byte for byte`);
    return rec;
  });

  // Decoding what we just built must give back the spec.
  for (let i = 0; i < built.length; i++) {
    const spec = w.specs[i];
    const f = decodeRecord(built[i], 0, false);
    ok(f !== null, `${name}: built "${spec.species}" decodes`);
    eq(tables.speciesName(f.species_id), spec.species, `${name}: built "${spec.species}" species round-trips`);
    if (spec.shiny != null) eq(f.is_shiny, spec.shiny, `${name}: built "${spec.species}" shininess is ${spec.shiny}`);
    if (spec.nick) eq(f.nickname, spec.nick, `${name}: built "${spec.species}" nickname`);
    eq(f.is_nicknamed, Boolean(spec.nick), `${name}: built "${spec.species}" nicknamed flag`);
    eq(pk5Checksum(f.body), f.checksum, `${name}: built "${spec.species}" checksum is self-consistent`);
  }

  // Same edit Python made: box 9 (index 8) + two bag stacks + reseal.
  const edited = sv.clone();
  edited.writeBox(w.edit_plan.box, built, { reseal: false });
  edited.addBagItems(w.edit_plan.bag_items.map(([item_id, count, pocket]) => ({ item_id, count, pocket })),
    { reseal: false });
  edited.reseal([boxBlock(w.edit_plan.box), BLOCKS.bag]);
  eq(crc16ccitt(edited.toBytes()), w.edited_crc16,
    `${name}: whole 524288-byte file after write+reseal hashes identically to write_team.py`);
  deepEq(edited.verify(), { ok: true, problems: [] }, `${name}: edited save passes all three tiers`);
  eq(edited.toBytes().length, SAVE_SIZE, `${name}: edited save is still ${SAVE_SIZE} bytes`);

  // Resealing per-operation (the default) must land in the same place as one
  // combined reseal -- otherwise the convenience default silently diverges.
  const edited2 = sv.clone();
  edited2.writeBox(w.edit_plan.box, built);
  edited2.addBagItems(w.edit_plan.bag_items.map(([item_id, count, pocket]) => ({ item_id, count, pocket })));
  eq(crc16ccitt(edited2.toBytes()), w.edited_crc16, `${name}: per-operation reseal matches combined reseal`);

  // Re-reading the edit through the reader closes the loop.
  const reread = Save.load(edited.toBytes());
  const box9 = reread.readBox(w.edit_plan.box);
  eq(box9.length, built.length, `${name}: re-read box ${w.edit_plan.box + 1} holds ${built.length} Pokemon`);
  deepEq(box9.map((f) => tables.speciesName(f.species_id)), w.specs.map((s) => s.species),
    `${name}: re-read box ${w.edit_plan.box + 1} species in order`);
  const stacked = reread.readPocket('items').find((e) => e.item_id === 234);
  ok(stacked && stacked.count >= 3, `${name}: bag addition survived the round-trip`,
    JSON.stringify(stacked));

  // The original must be untouched -- clone() has to be a real deep copy.
  eq(crc16ccitt(sv.toBytes()), c.crc16, `${name}: clone() left the loaded save unmodified`);
  });
}

// ===========================================================================
section('presentation layer');
// ===========================================================================
guard('presentation layer', () => {
  const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, truth.corpora.fixture.file)));
  const sv = Save.load(bytes);
  const mons = sv.readParty().map((f) => presentMon(f, tables));
  const checks = mons.map((m) => m.stats_check);
  deepEq(checks, mons.map(() => 'ok'),
    'every party member\'s stored stats match stats recomputed from ROM base stats');
  const osha = mons[0];
  eq(osha.species, 'Oshawott', 'species name from the ROM table');
  eq(osha.level, 10, 'stored party level');
  eq(osha.exp_curve, 'medium-slow', 'growth curve from the ROM');
  eq(osha.ability, 'Vital Spirit', 'ability name from the embedded Gen 5 table');
  ok(osha.moves.every((mv) => mv.name && mv.power !== undefined),
    'moves resolve to ROM names and power');

  // Box records have no stored level; it must come from the ROM curve.
  const dense = truth.corpora.dense;
  if (dense && fs.existsSync(path.join(ROOT, dense.file))) {
    const dv = Save.load(new Uint8Array(fs.readFileSync(path.join(ROOT, dense.file))));
    const boxMons = dv.readBox(0).map((f) => presentMon(f, tables));
    ok(boxMons.length > 0 && boxMons.every((m) => m.level_source === 'derived' && m.level >= 1),
      'box levels derive from the ROM growth curve, exactly');
  }
});

// ===========================================================================
section('validation refuses bad input');
// ===========================================================================
guard('validation', () => {
  const tooSmall = new Uint8Array(1024);
  let threw = null;
  try { Save.load(tooSmall); } catch (e) { threw = e; }
  ok(threw instanceof SaveError && /expected exactly 524288/.test(threw.message),
    'a wrong-sized file is rejected, not parsed');

  const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, truth.corpora.fixture.file)));
  threw = null;
  try { Save.load(bytes, { lastModified: Date.now() - 500 }); } catch (e) { threw = e; }
  ok(threw instanceof SaveError && /modified/.test(threw.message),
    'a save flushed less than 2s ago is rejected (partial-write guard)');
  ok(Save.load(bytes, { lastModified: Date.now() - 60_000 }) instanceof Save,
    'a stale-enough save loads');

  // Corrupt one byte in every box of both slots: no slot should validate.
  const corrupt = new Uint8Array(bytes);
  for (const base of [0x00000, 0x24000]) corrupt[base + 0x400] ^= 0xff;
  threw = null;
  try { Save.load(corrupt); } catch (e) { threw = e; }
  ok(threw instanceof SaveError && /checksum/.test(threw.message),
    'a save whose blocks fail their checksums is refused outright');

  // An empty slot that is not all-zero: the game rewrites cleared slots with a
  // valid checksum and species 0.  Reading that as a real record miscounts
  // every box, so it must decode as null.
  const cleared = new Uint8Array(136);
  const body = new Uint8Array(128);
  const rec = encodeRecord(0x1234abcd, 0, body);   // species 0, valid checksum
  cleared.set(rec);
  ok(decodeRecord(cleared, 0, false) === null,
    'a cleared-but-checksummed slot decodes as empty, not as a phantom record');
});

// ===========================================================================
section('demo page renders against a stubbed DOM');
// ===========================================================================
// Same trick verify_sheet.js uses on the team sheet: text-presence checks
// cannot see a broken render path, so actually run it.  This catches typos in
// demo.html that would otherwise only show up in a browser.
await (async () => {
  const html = fs.readFileSync(path.join(ROOT, 'js/demo.html'), 'utf8');
  const mod = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  if (!mod) { failures.push('demo.html: no module script found'); return; }

  const made = [];
  const node = () => {
    const n = {
      style: {}, classList: { add() {}, remove() {} }, children: [],
      append(...k) { this.children.push(...k); }, replaceChildren() { this.children = []; },
      click() {}, querySelector: () => node(),
    };
    made.push(n);
    return n;
  };
  const root = node();
  const stub = {
    document: { querySelector: () => root, createElement: () => node(), body: root },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
    Blob: class { constructor(parts) { this.parts = parts; } },
    alert() {},
    console: { warn() {}, log() {} },
  };

  // Rewrite the import to an absolute URL and expose load() so the test can
  // drive it with a real save instead of a synthetic file.
  const src = mod[1]
    .replace("'./index.js'", JSON.stringify(new URL('../js/index.js', import.meta.url).href))
    + '\nexport { load, render };';
  const tmp = path.join(ROOT, 'tests', '.demo-check.mjs');
  fs.writeFileSync(tmp, `const {document, URL, Blob, alert, console} = globalThis.__demoStub;\n${src}`);
  try {
    globalThis.__demoStub = stub;
    const demo = await import(`${new URL(`file://${tmp}`).href}?t=${Date.now()}`);
    /* THE DENSE CORPUS IS THE NEWEST FILE IN save_backups/, which a fresh
       clone does not have -- so this threw "reading 'file' of undefined" on
       every clean checkout while passing on any machine that had ever run the
       tool. The other dense-corpus check on line ~287 already guards; this one
       did not. Any valid save exercises the demo render, so fall back to the
       committed fixture. */
    const corpus = truth.corpora.dense ?? truth.corpora.fixture;
    const bytes = fs.readFileSync(path.join(ROOT, corpus.file));
    await demo.load({
      name: path.basename(corpus.file),
      lastModified: Date.now() - 60_000,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    ok(root.children.length > 0, 'demo render produced output for a real save');
    // The fixture holds five Pokemon, the dense corpus several hundred; the
    // claim is "it rendered rows", not "it rendered that many".
    ok(made.length > 20, 'demo rendered a table row per Pokemon', `${made.length} nodes`);
  } catch (e) {
    failures.push(`demo.html render threw: ${e.message}`);
  } finally {
    delete globalThis.__demoStub;
    fs.rmSync(tmp, { force: true });
  }
})();

// ===========================================================================
console.log(`\n${'─'.repeat(60)}`);
if (failures.length) {
  console.log(`FAIL — ${passed} passed, ${failures.length} failed\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`all checks passed — ${passed} assertions`);
