#!/usr/bin/env node
/**
 * adopt_layout.mjs -- put the shipped rosters into the team store, from the CLI.
 *
 * WHY THIS EXISTS
 * `TEAM_LAYOUT` in build_sheet.py holds eight hand-written rosters -- Kaiju,
 * Rain, Trick Room, Edgelord, Mewtwo, Contrary Engine, Sun King, My Uncle
 * Works at Nintendo. They used to be rendered directly as battle tabs, which
 * made them a second class of team: visible everywhere, editable nowhere. They
 * are adopted into the team store as ordinary cores instead, after which they
 * can be edited, retired and fielded like anything else.
 *
 * The app does this itself on first run. This exists for the path that never
 * opens a browser: `./setup` and `./refresh` both run headless, and
 * build_sheet.py reads state/teams.json, so without a CLI seeder someone who
 * generated the sheet before opening the app would get a sheet with no teams
 * on it and nothing saying why.
 *
 * IT SHARES THE APP'S IMPLEMENTATION. `seedBuiltins()` in app/js/teams.js is
 * the whole of it -- two seeders would be two ways to resolve a roster against
 * a save, and the one that decides WHICH of your four Arcanines a slot means
 * is not a thing to write twice. Its once-only guard is a localStorage marker
 * plus a name check against the store; node has no localStorage, so it is the
 * name check that makes repeated runs here a no-op.
 *
 *     node tools/adopt_layout.mjs            # seed
 *     node tools/adopt_layout.mjs --dry-run  # say what it would do
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dry = process.argv.includes('--dry-run');

const { Save } = await import('../js/save.js');
const { Factory } = await import('../app/js/factory.js');
const T = await import('../app/js/teams.js');

const S = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/data/static.json'), 'utf8'));
const cfgPath = path.join(ROOT, 'companion.config.json');
const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
const savePath = process.env.SAVE ?? cfg.save;
if (!savePath || !fs.existsSync(savePath)) {
  console.error('adopt_layout: no save configured. Set `save` in companion.config.json.');
  process.exit(1);
}

const save = Save.load(new Uint8Array(fs.readFileSync(savePath)));
const index = T.buildIndex(new Factory(save, S));
const teamsFile = path.join(ROOT, 'state/teams.json');
const store = fs.existsSync(teamsFile)
  ? (JSON.parse(fs.readFileSync(teamsFile, 'utf8')).teams ?? []) : [];

const { teams, added } = T.seedBuiltins(store, index, S,
  { tid: save.readTrainer().trainer_id });

for (const c of added) {
  const owned = c.slots.filter((sl) =>
    T.matchSlot(sl.options[0], index, S).state === 'owned').length;
  const options = c.slots.reduce((a, sl) => a + sl.options.length, 0);
  console.log(`  + ${c.name} — ${c.slots.length} slots, ${options} options, `
    + `${(c.pilot ?? []).length} pilot cards, ${owned} owned`);
}

if (!added.length) {
  console.log('nothing to do — every shipped roster is already in the team store');
  process.exit(0);
}
if (dry) {
  console.log(`\n${added.length} would be adopted (dry run, nothing written)`);
  process.exit(0);
}

fs.writeFileSync(teamsFile, JSON.stringify({ teams }, null, 1));
console.log(`\nadopted ${added.length} rosters into ${path.relative(ROOT, teamsFile)}`);
