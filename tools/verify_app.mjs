/**
 * verify_app.mjs -- prove the app renders a real save end to end, headlessly.
 *
 * Why this file asserts what it does: notes/design-system.md
 *
 *     node tools/verify_app.mjs [path/to/save.sav]
 *
 * verify_sheet.js does this for the GENERATED page. This does it for the LIVE
 * path: load a save, decode it, build the data blob in the browser code, and
 * run the battle companion's own script against it with a stubbed DOM.
 *
 * The coupling it exists to protect is narrow and sharp: app/js/tabs/battle.js
 * finds the template's markup and script by string anchors. If the template
 * moves its data injection point or drops #view, the tab renders BLANK with no
 * error in the console -- the same silent-failure shape that once made three
 * rounds of styling work appear to land and do nothing. So the anchors are
 * asserted here rather than discovered in a browser.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { Save } from '../js/save.js';
import { buildBlob } from '../app/js/roster.js';
import { Factory } from '../app/js/factory.js';
import { battleTeams, buildIndex, partyTeam, seedBuiltins } from '../app/js/teams.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let failed = 0;
const ok = (name, pass, detail = '') => {
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? '  ' + detail : ''}`);
  if (!pass) failed++;
};

// ---- pick a save ---------------------------------------------------------
let savePath = process.argv[2];
if (!savePath) {
  const dir = path.join(ROOT, 'save_backups');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.sav'))
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
    : [];
  savePath = files[files.length - 1];
  /* THE COMMITTED FIXTURE IS THE FALLBACK, and that matters for first
     impressions: a fresh clone has no save_backups/ at all, so ./setup's
     final "checking it works" step failed for every new user and told them
     to go and debug it. tests/fixture.sav ships, is anonymised, and exercises
     the same code paths -- a real save is better, but the absence of one is
     not a failure. */
  if (!savePath || !fs.existsSync(savePath)) {
    savePath = path.join(ROOT, 'tests', 'fixture.sav');
  }
}
if (!savePath || !fs.existsSync(savePath)) {
  console.error('verify_app: no save given, none in save_backups/, no test fixture');
  process.exit(2);
}
console.log(`  save: ${path.relative(ROOT, savePath)}\n`);

// ---- static data ---------------------------------------------------------
const staticPath = path.join(ROOT, 'app/data/static.json');
ok('app/data/static.json exists', fs.existsSync(staticPath),
  fs.existsSync(staticPath) ? '' : 'run  python3 build_static.py');
if (!fs.existsSync(staticPath)) process.exit(1);
const S = JSON.parse(fs.readFileSync(staticPath, 'utf8'));
for (const k of ['TYPES', 'CHART', 'MOVES', 'ABIL', 'DEX', 'SPRITE', 'OPPONENTS',
  'LAYOUT', 'SPECIES', 'ITEMS', 'MOVEBYID', 'ZONES', 'AREAS']) {
  ok(`static.json has ${k}`, S[k] != null && Object.keys(S[k]).length > 0,
    S[k] == null ? 'missing' : '');
}

// ---- decode + build the blob --------------------------------------------
const save = Save.load(new Uint8Array(fs.readFileSync(savePath)));
ok('save passes all three integrity tiers', save.verify().ok, save.verify().problems.join('; '));
const rt = save.selfTestRoundTrip();
ok('every record re-encodes byte-identically', rt.ok, `${rt.checked} records`);

const { blob, live, missing, skipped } = buildBlob(save, S, { ot: save.readTrainer().ot_name });

// TEAMS DOES NOT COME OUT OF buildBlob() ANY MORE. Every team the battle tab
// shows -- your live party, your teams, your cores, and the shipped rosters
// that were adopted as cores on first run -- is read from the team store at
// mount. So the harness does what tabs/battle.js does, or it would be running
// the template against a blob with no teams in it and proving nothing.
{
  const idx = buildIndex(new Factory(save, S));
  let store = [];
  try {
    store = JSON.parse(fs.readFileSync(path.join(ROOT, 'state/teams.json'), 'utf8')).teams ?? [];
  } catch { /* no store yet: the empty-TEAMS path below is then the one tested */ }
  const party = partyTeam(idx, S);
  blob.TEAMS = [party, ...battleTeams(save.readTrainer().trainer_id, idx, S, store)]
    .filter(Boolean);
}
{
  const tpl = fs.readFileSync(path.join(ROOT, 'sheet_template.html'), 'utf8');
  const line = /const\s*\{([^}]*)\}\s*=\s*D;/.exec(tpl)?.[1] ?? '';
  const keys = line.split(',').map((k) => k.trim()).filter(Boolean);
  const missingKeys = keys.filter((k) => blob[k] == null);
  ok('blob has every section the template destructures',
    keys.length > 10 && missingKeys.length === 0,
    missingKeys.length ? `missing: ${missingKeys.join(', ')}` : `${keys.length} sections`);
  // Anything the template reads off D directly rather than destructuring --
  // D.FIELD, D.GATES, D.TRFACE -- is optional by design (an older blob simply
  // has none), but it must be present in the one the app actually builds.
  const direct = [...tpl.matchAll(/\bD\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]);
  const lateMissing = [...new Set(direct)].filter((k) => blob[k] == null);
  ok('...and every section it reads off D directly', lateMissing.length === 0,
    lateMissing.join(', '));
}
ok('teams resolved against the save', blob.TEAMS.length > 0,
  blob.TEAMS.map((t) => `${t.id}:${t.where}`).join(' '));
ok('your live party is always a tab, with no setup at all',
  blob.TEAMS.some((t) => t.id === 'live-party'));
ok('no team member missing from the save', missing.length === 0,
  [...new Set(missing)].slice(0, 5).join(', '));
ok('no team skipped', skipped.length === 0, skipped.map((s) => s.name).join(', '));
ok('live index populated', live.length > 0, `${live.length} Pokémon`);

// ---- the template anchors app/js/tabs/battle.js depends on ---------------
const tplPath = path.join(ROOT, 'sheet_template.html');
const html = fs.readFileSync(tplPath, 'utf8');
const tabSrc = fs.readFileSync(path.join(ROOT, 'app/js/tabs/battle.js'), 'utf8');
const anchor = tabSrc.match(/const DATA_ANCHOR = '([^']+)'/)?.[1];
ok('battle.js declares a DATA_ANCHOR', Boolean(anchor), anchor ?? '');
ok('the template still contains that anchor', Boolean(anchor) && html.includes(anchor),
  anchor ? `looking for ${anchor}` : '');

const styleEnd = html.indexOf('</style>');
const scriptOpen = html.indexOf('<script>');
const scriptClose = html.lastIndexOf('</script>');
ok('template splits into style / markup / script',
  styleEnd > 0 && scriptOpen > styleEnd && scriptClose > scriptOpen);
const markup = html.slice(styleEnd + 8, scriptOpen).trim();
ok('markup carries the ids the script drives', ['id="view"', 'id="foot"', 'id="tabs"',
  'id="kick"', 'id="built"'].every((id) => markup.includes(id)));

// ---- run the script with the LIVE blob ----------------------------------
const raw = html.slice(scriptOpen + 8, scriptClose);
const mk = () => new Proxy({
  style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
  children: [], value: '', open: true, innerHTML: '',
  appendChild() {}, setAttribute() {}, removeAttribute() {}, addEventListener() {},
  scrollIntoView() {}, focus() {}, closest: () => null,
  querySelector: () => mk(), querySelectorAll: () => [],
}, { get: (t, k) => (k in t ? t[k] : undefined), set: (t, k, v) => ((t[k] = v), true) });

global.localStorage = { getItem: () => null, setItem: () => {} };
global.document = {
  querySelectorAll: () => [], querySelector: () => mk(), getElementById: () => mk(),
  addEventListener() {}, createElement: () => mk(), body: mk(), documentElement: mk(),
};
global.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
global.requestAnimationFrame = (f) => f();
global.__LIVE_D__ = blob;

const tmp = path.join(os.tmpdir(), `app_probe_${process.pid}.cjs`);
fs.writeFileSync(tmp, raw.replace(anchor, 'const D=global.__LIVE_D__;')
  + '\n;module.exports={render,TEAMS,cur,monBlock,encounterPanel,statOf};');
let M = null;
try {
  M = require(tmp);
  ok('battle script runs with a blob built from the save', true);
} catch (e) {
  ok('battle script runs with a blob built from the save', false, e.message.split('\n')[0]);
}

if (M) {
  let rendered = 0;
  try {
    for (const t of M.TEAMS) { M.render(t); rendered++; }
  } catch (e) {
    ok('render() for every team', false, e.message.split('\n')[0]);
  }
  if (rendered === M.TEAMS.length) ok('render() for every team', true, `${rendered} teams`);

  const bal = (s) => (s.match(/<div\b/g) || []).length - (s.match(/<\/div>/g) || []).length;
  const team = M.cur(M.TEAMS[0]);
  const KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
  const g = Math.max(...team.flatMap((o) => KEYS.map((k) => M.statOf(o, k))), 1);
  const tm = Math.max(...team.map((o) => KEYS.reduce((a, k) => a + M.statOf(o, k), 0)), 1);
  ok('monBlock div balance', bal(M.monBlock(team[0], 'why', g, tm)) === 0);
  ok('encounterPanel div balance', bal(M.encounterPanel(team, M.TEAMS[0])) === 0);
}
fs.rmSync(tmp, { force: true });

// ---- no teams at all is a real state, not a crash -----------------------
// Teams come from the team store now, so a fresh checkout, or someone who has
// retired everything, hands the template an empty TEAMS. It used to read
// orderedTeams()[0].id straight off and take the ENTIRE page down -- encounter
// data, reference tables and all -- for the one section that needs a team.
{
  const tmp2 = path.join(os.tmpdir(), `app_probe_empty_${process.pid}.cjs`);
  global.__EMPTY_D__ = { ...blob, TEAMS: [] };
  fs.writeFileSync(tmp2, raw.replace(anchor, 'const D=global.__EMPTY_D__;')
    + '\n;module.exports={TEAMS,myLevel};');
  try {
    const E = require(tmp2);
    ok('the battle script survives an empty team store', E.TEAMS.length === 0);
    ok('...and myLevel() returns null rather than throwing', E.myLevel() === null);
  } catch (e) {
    ok('the battle script survives an empty team store', false, e.message.split('\n')[0]);
  }
  fs.rmSync(tmp2, { force: true });
}

// ---- roster slot width budget -------------------------------------------
// A fixed-width flex sibling squeezing a flex child until its contents spill
// across it is not visible to a brace count or a render() call -- the page
// renders "fine" and just looks broken. So the arithmetic is asserted.
//
// The bug this guards: .idtext had `flex:1`, i.e. a ZERO basis, so in the
// narrowest roster column it got 60px while the 24px name and two 60px type
// icons needed ~126px, and both overflowed across the .tcov grid.
{
  const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));
  const num = (re, label) => {
    const m = css.match(re);
    ok(`css: found ${label}`, Boolean(m), m ? '' : String(re));
    return m ? parseFloat(m[1]) : NaN;
  };
  const cardMin = num(/\.roster\{[^}]*minmax\((\d+)px/, '.roster column minimum');
  const sprite = num(/\.idbar img\.sp\{width:(\d+)px/, '.idbar sprite width');
  const tcov = num(/\.tcov\{[^}]*width:(\d+)px/, '.tcov width');
  const pad = num(/\.idbar\{[^}]*padding:(\d+)px/, '.idbar padding');
  const gap = num(/\.idbar\{[^}]*column-gap:(\d+)px/, '.idbar column gap');
  const basis = num(/\.idbar \.idtext\{flex:[\d.]+ [\d.]+ (\d+)px/, '.idtext flex-basis');
  const wraps = /\.idbar\{[^}]*flex-wrap:wrap/.test(css);

  ok('.idbar is allowed to wrap', wraps,
    wraps ? '' : 'without this a squeezed .idtext overflows across .tcov instead of the grid moving');
  ok('.idtext has a real flex-basis, not flex:1', basis > 0,
    `basis ${basis}px -- flex:1 means basis 0, which is the bug`);

  // Two type icons are 96x32 native, rendered at height:20px -> 60px each,
  // plus the 6px .tline gap.
  const TYPE_ICONS = 60 * 2 + 6;
  ok('.idtext basis fits two type icons', basis >= TYPE_ICONS,
    `basis ${basis}px vs ${TYPE_ICONS}px needed`);

  const inner = cardMin - 2 * pad;
  const inlineNeed = sprite + gap + basis + gap + tcov;
  const idtextWhenWrapped = inner - sprite - gap;
  const idtextWhenInline = inner - sprite - gap - gap - tcov;
  const got = inlineNeed > inner ? idtextWhenWrapped : idtextWhenInline;
  ok(`narrowest roster column (${cardMin}px) leaves .idtext room for its contents`,
    got >= TYPE_ICONS,
    `${got}px available, ${TYPE_ICONS}px needed` + (inlineNeed > inner ? ' (grid wraps to its own row)' : ' (grid inline)'));
}

// ---- a Team Builder team must survive the battle sheet's own script -------
// This is the join that can break silently: teams.js builds a shape by hand
// that build_sheet.py builds from TEAM_LAYOUT, and if a single field is
// missing the sheet renders a blank tab with nothing in the console. So a
// designed team is pushed through the real script and rendered.
{
  const { Factory } = await import('../app/js/factory.js');
  const T = await import('../app/js/teams.js');
  const store = {};
  global.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };

  const fac = new Factory(save, S);
  const idx = T.buildIndex(fac);

  // Six real Pokémon, so stats and typings are all genuine.
  const picks = idx.slice(0, 6).map((x) => T.monToSpec(x.mon));
  const team = { ...T.blankTeam('Verifier'), notes: 'Line one.\nLine two.', slots: picks };
  T.saveLocal(4242, [team]);

  const converted = T.battleTeams(4242, idx, S);
  ok('a saved team converts to a battle team', converted.length === 1, `${converted.length}`);
  const bt = converted[0];

  // Every field build_sheet.py's teams carry, since the script destructures
  // them without guards.
  const shape = ['id', 'name', 'where', 'state', 'tag', 'coreBoxes', 'inParty', 'coreN',
    'swapBoxes', 'tr', 'mech', 'tagline', 'warn', 'pilot', 'slots'];
  const missingF = shape.filter((k) => bt[k] === undefined);
  ok('it carries every field a TEAM_LAYOUT team does', missingF.length === 0, missingF.join(', '));
  ok('slots carry role, why, options and defaultIdx',
    bt.slots.every((sl) => sl.role && sl.why !== undefined && Array.isArray(sl.options)
      && typeof sl.defaultIdx === 'number'));
  const monShape = ['name', 'lvl', 'nat', 'ab', 'item', 'types', 'moves', 'shiny', 'nick', 'box', 'stats'];
  ok('each option mon carries every field the sheet reads',
    bt.slots.every((sl) => sl.options.every((o) => monShape.every((k) => o.mon[k] !== undefined))));
  ok('stats are six numbers in hp/atk/def/spa/spd/spe order',
    bt.slots.every((sl) => sl.options[0].mon.stats.length === 6
      && sl.options[0].mon.stats.every((n) => Number.isInteger(n) && n > 0)));
  ok('the team gets a real warning line', typeof bt.warn === 'string' && bt.warn.length > 10,
    bt.warn.slice(0, 70));
  ok('notes become the tagline and pilot lines',
    bt.tagline === 'Line one.' && bt.pilot.length === 1 && bt.pilot[0].v === 'Line two.');

  // Now the real test: render it through the template.
  const withMine = { ...blob, TEAMS: [...blob.TEAMS, bt] };
  const tmp2 = path.join(os.tmpdir(), `app_probe2_${process.pid}.cjs`);
  fs.writeFileSync(tmp2, raw.replace(anchor, 'const D=global.__LIVE_D2__;')
    + '\n;module.exports={render,TEAMS,cur,monBlock,statOf,battleIndex};');
  global.__LIVE_D2__ = withMine;
  let M2 = null;
  try {
    M2 = require(tmp2);
    ok('the sheet accepts a blob containing a Builder team', true);
  } catch (e) {
    ok('the sheet accepts a blob containing a Builder team', false, e.message.split('\n')[0]);
  }
  if (M2) {
    ok('the Builder team is in the sheet\'s team list',
      M2.TEAMS.some((t) => t.id === bt.id), `${M2.TEAMS.length} teams`);
    let threw = null;
    try { M2.render(M2.TEAMS.find((t) => t.id === bt.id)); } catch (e) { threw = e; }
    ok('render() succeeds on the Builder team', !threw, threw?.message.split('\n')[0]);
    const bal = (x) => (x.match(/<div\b/g) || []).length - (x.match(/<\/div>/g) || []).length;
    const t0 = M2.cur(M2.TEAMS.find((t) => t.id === bt.id));
    ok('its monBlock renders balanced markup', bal(M2.monBlock(t0[0], 'why', 400, 2000)) === 0);
    ok('statOf reads its stats', M2.statOf(t0[0], 'spe') > 0, `${M2.statOf(t0[0], 'spe')}`);
  }
  // The encounter cards carry opponent sprites, and have all along -- an
  // edit that "added" them silently failed and left only a dead CSS rule
  // behind, which nothing caught because nothing checked they render.
  if (M2?.battleIndex) {
    const idx = M2.battleIndex();
    const perCard = [...idx.matchAll(/<div class="bteam">(.*?)<\/div>/gs)]
      .map((m) => (m[1].match(/<img/g) ?? []).length);
    ok('the encounter index renders a card per documented fight',
      perCard.length === blob.OPPONENTS.length, `${perCard.length}`);
    ok('each card shows that trainer\'s team as sprites',
      perCard.filter((n) => n > 0).length >= perCard.length - 2,
      `${perCard.reduce((a, b) => a + b, 0)} sprites across ${perCard.length} cards`);
    // AND THE TRAINER THEMSELVES. roster.js hands the template an explicit
    // allow-list of blob keys, and leaving a key off it fails silently: the
    // template defaults TRFACE to {} and face() renders nothing, with no
    // error anywhere. That is exactly how this shipped blank the first time.
    ok('the battle blob carries the trainer portraits',
      Object.keys(blob.TRFACE ?? {}).length > 0,
      `${Object.keys(blob.TRFACE ?? {}).length} portraits`);
    const faces = (idx.match(/class="bface/g) ?? []).length;
    ok('and the encounter cards render one per fight',
      faces === blob.OPPONENTS.filter((o) => o.face != null).length,
      `${faces} rendered`);
  }

  fs.rmSync(tmp2, { force: true });
}

// ---- shell wiring --------------------------------------------------------
const idx = fs.readFileSync(path.join(ROOT, 'app/index.html'), 'utf8');
for (const id of ['shell-tabs', 'shell-save', 'shell-panel', 'shell-warn', 'shell-file']) {
  ok(`index.html has #${id}`, idx.includes(`id="${id}"`));
}
const appSrc = fs.readFileSync(path.join(ROOT, 'app/js/app.js'), 'utf8');
for (const id of ['shell-tabs', 'shell-save', 'shell-panel', 'shell-warn', 'shell-file']) {
  ok(`app.js only reaches for ids that exist: #${id}`, idx.includes(`id="${id}"`) && appSrc.includes(id));
}

// ---- CSS custom properties must actually resolve.
// The app has NO token definitions of its own beyond --fx-go-*: the palette
// comes from sheet_template.html, injected at boot. So a rule written against
// the sheet's token names works and one written against invented names is
// dropped silently, leaving the element unstyled. That is the same failure
// verify_sheet.js catches on the other side of the same system.
{
  const tpl = fs.readFileSync(path.join(ROOT, 'sheet_template.html'), 'utf8');
  const tplCss = tpl.slice(tpl.indexOf('<style>'), tpl.indexOf('</style>'));
  const defined = new Set([...tplCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const files = fs.readdirSync(path.join(ROOT, 'app/css'))
    .filter((f) => f.endsWith('.css')).map((f) => path.join(ROOT, 'app/css', f));
  files.push(path.join(ROOT, 'app/index.html'));
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
  }
  // Tokens the JS sets inline on an element are scoped there and legitimate.
  const jsDir = path.join(ROOT, 'app/js');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name))
      : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
  for (const f of walk(jsDir)) {
    const txt = fs.readFileSync(f, 'utf8');
    for (const m of txt.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
    // ...and the ones set through the API rather than in a style string.
    // `setProperty('--fx-wall-h', …)` has no colon, so the pattern above
    // misses it and the token reads as undefined.
    for (const m of txt.matchAll(/setProperty\(\s*['"`](--[a-z0-9-]+)['"`]/g)) defined.add(m[1]);
  }
  const undef = [];
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8');
    for (const m of txt.matchAll(/var\((--[a-z0-9-]+)\s*(\)|,)/g)) {
      if (m[2] === ')' && !defined.has(m[1])) undef.push(`${path.basename(f)}:${m[1]}`);
    }
  }
  ok('every var(--token) in the app resolves to a definition',
    undef.length === 0, [...new Set(undef)].join(' | '));
}

// ---------------------------------------------------------------------------
// UNPREFIXED CLASS NAMES ARE A LIVE HAZARD, NOT A STYLE PREFERENCE
//
// sheet_template.html's stylesheet is injected app-wide at boot -- it IS the
// design system -- and it owns a pile of short, generic class names. The
// Adventure tab put a bare `num` on its route shields; the sheet's own
// `.num{color:var(--ink-faint)}` then repainted every route number faint grey
// on a near-white pill, which is exactly why they were unreadable at rest and
// why "raise the contrast" would have been the wrong fix.
//
// A collision only bites when the sheet's rule can match WITHOUT one of its own
// ancestors in the selector, so that is what is tested: a bare `.foo{...}` or
// `tag.foo{...}` is dangerous, `.encrow.gated{...}` is not.
// ---------------------------------------------------------------------------
{
  const tpl = fs.readFileSync(path.join(ROOT, 'sheet_template.html'), 'utf8');
  const tplCss = tpl.slice(tpl.indexOf('<style>'), tpl.indexOf('</style>'));

  // Selectors from the global sheet that need no ancestor and no sibling class:
  // ".num", "details.mv", "button.x" -- but not ".opt .on" or ".mline.bad".
  const loose = new Set();
  for (const m of tplCss.matchAll(/(^|[},])\s*([^{}]+?)\s*\{/g)) {
    for (const sel of m[2].split(',')) {
      const t = sel.trim();
      if (!t || t.startsWith('@') || /[ >+~]/.test(t)) continue;   // needs an ancestor
      const classes = [...t.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((c) => c[1]);
      if (classes.length === 1 && !/:/.test(t.split('.')[0])) loose.add(classes[0]);
    }
  }

  const jsRoot = path.join(ROOT, 'app/js');
  const walkJs = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walkJs(path.join(d, e.name))
      : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);

  // A class value is often a template literal: `ad-routetag ${num ? 'ad-num'
  // : 'ad-named'}`. The literal class names are the bare words OUTSIDE the
  // ${...} plus any quoted strings INSIDE it -- tokenising the raw text
  // instead reports `num`, `mv` and `normal` as classes, which they are not.
  const classesIn = (value) => {
    const out = [];
    let rest = value;
    for (const m of value.matchAll(/\$\{([^}]*)\}/g)) {
      // Only a ternary RESULT is a class. `sel.kind === 'note' ? ' sel' : ''`
      // contributes " sel"; the 'note' it compares against is a value, and
      // treating it as a class name reported a collision that does not exist.
      for (const q of m[1].matchAll(/[?:]\s*['"]([\w -]*)['"]/g)) {
        for (const c of q[1].split(/\s+/)) if (c) out.push(c);
      }
      rest = rest.replace(m[0], ' ');
    }
    for (const c of rest.matchAll(/[a-zA-Z][\w-]*/g)) out.push(c[0]);
    return out;
  };

  const emitted = new Set();
  for (const f of walkJs(jsRoot)) {
    const txt = fs.readFileSync(f, 'utf8');
    // Template literals and plain strings are matched separately: one regex
    // with a shared character class stops at the first quote INSIDE a
    // `...${x ? 'a' : 'b'}` and hands back a truncated, unbalanced value.
    for (const m of txt.matchAll(/class:\s*`([^`]*)`/g)) {
      for (const c of classesIn(m[1])) emitted.add(c);
    }
    for (const m of txt.matchAll(/class:\s*'([^']*)'|class:\s*"([^"]*)"/g)) {
      for (const c of classesIn(m[1] ?? m[2] ?? '')) emitted.add(c);
    }
    for (const m of txt.matchAll(/classList\.(?:add|toggle)\(\s*['"]([\w-]+)['"]/g)) emitted.add(m[1]);
  }

  const clash = [...emitted].filter((c) => loose.has(c)).sort();
  ok('no app class collides with a global sheet rule that needs no ancestor',
    clash.length === 0,
    clash.length ? `${clash.map((c) => '.' + c).join(' ')} — prefix these` : `${loose.size} loose sheet classes checked`);
}

// ---------------------------------------------------------------------------
// ONE SELECTOR, DEFINED TWICE, OUTSIDE A MEDIA QUERY
//
// builder.css carried two unrelated `.tb-note` rules: a plain one for the text
// under a slot card, and a boxed, grid-spanning one written for the editor
// modal. The second won everywhere, so every card's "Party, slot 3" line
// rendered inside what looked like a disabled input -- present in the file,
// wrong on the page, and invisible to grep because both rules were "there".
//
// Overrides inside @media are how responsive CSS works and are left alone.
// ---------------------------------------------------------------------------
{
  const dupes = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'app/css')).filter((x) => x.endsWith('.css'))) {
    const txt = fs.readFileSync(path.join(ROOT, 'app/css', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    // Drop the body of every at-rule block, so responsive overrides do not count.
    // The regex splits on braces, so the text BEFORE a closing brace is that
    // rule's declaration block -- slicing by index instead returns '' , which
    // made an earlier version of this check pass on everything.
    const flat = [];
    let depth = 0, atDepth = -1, pending = null;
    for (const m of txt.matchAll(/([^{}]*)([{}])/g)) {
      if (m[2] === '{') {
        const sel = m[1].trim();
        if (atDepth < 0 && /^@/.test(sel)) atDepth = depth;
        else if (atDepth < 0) pending = sel;
        depth += 1;
      } else {
        depth -= 1;
        if (pending != null) { flat.push([pending, m[1]]); pending = null; }
        if (atDepth >= 0 && depth === atDepth) atDepth = -1;
      }
    }
    const seen = new Map();
    for (const [sel, decls] of flat) {
      // Only simple single-class selectors: `.foo`. Anything with a combinator,
      // a second class or a pseudo is a deliberate variant.
      if (!/^\.[a-zA-Z][\w-]*$/.test(sel)) continue;
      const props = new Map();
      for (const d of decls.split(';')) {
        const i = d.indexOf(':');
        if (i < 0) continue;
        props.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
      }
      if (!seen.has(sel)) { seen.set(sel, props); continue; }
      // Layering EXTRA properties onto a rule is a normal way to organise a
      // stylesheet. Setting the SAME property to a different value from two
      // places is the failure: one silently wins, wherever it happens to sit.
      const first = seen.get(sel);
      const fights = [...props].filter(([k, v]) => first.has(k) && first.get(k) !== v)
        .map(([k]) => k);
      if (fights.length) dupes.push(`${f}${sel} → ${fights.join(', ')}`);
      for (const [k, v] of props) first.set(k, v);
    }
  }
  ok('no simple class selector is defined twice in one stylesheet',
    dupes.length === 0, dupes.join(' | '));
}

// ---------------------------------------------------------------------------
// EVERY PREFIXED CLASS THE JS EMITS MUST HAVE A RULE
//
// The PC box wallpapers were deleted by a rewrite that spliced a section by
// string index and ran to the END OF THE FILE, taking everything appended
// after it. Nothing failed: the JS still added .fx-wall to every box, the
// class simply meant nothing any more, and the boxes quietly went grey.
//
// Scoped to the app's own prefixes, since those are the ones a stylesheet in
// this repo is responsible for. Interpolated fragments are resolved the same
// way the collision check does it.
// ---------------------------------------------------------------------------
{
  const css = fs.readdirSync(path.join(ROOT, 'app/css'))
    .filter((f) => f.endsWith('.css'))
    .map((f) => fs.readFileSync(path.join(ROOT, 'app/css', f), 'utf8')).join('\n')
    + fs.readFileSync(path.join(ROOT, 'app/index.html'), 'utf8');
  const styled = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));

  const jsRoot2 = path.join(ROOT, 'app/js');
  const walk2 = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk2(path.join(d, e.name))
      : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
  const emitted = new Set();
  const grab = (v) => {
    let rest = v;
    for (const m of v.matchAll(/\$\{([^}]*)\}/g)) {
      for (const q of m[1].matchAll(/[?:]\s*['"]([\w -]*)['"]/g)) {
        for (const c of q[1].split(/\s+/)) if (c) emitted.add(c);
      }
      rest = rest.replace(m[0], ' ');
    }
    for (const c of rest.matchAll(/[a-zA-Z][\w-]*/g)) emitted.add(c[0]);
  };
  for (const f of walk2(jsRoot2)) {
    const txt = fs.readFileSync(f, 'utf8');
    for (const m of txt.matchAll(/class:\s*`([^`]*)`/g)) grab(m[1]);
    for (const m of txt.matchAll(/class:\s*'([^']*)'|class:\s*"([^"]*)"/g)) grab(m[1] ?? m[2] ?? '');
    for (const m of txt.matchAll(/classList\.(?:add|toggle)\(\s*['"]([\w-]+)['"]/g)) emitted.add(m[1]);
    for (const m of txt.matchAll(/className\s*=\s*['"`]([^'"`]*)['"`]/g)) grab(m[1]);
  }
  // A token ending in `-` is the static half of `tb-role-${role}`, not a class.
  const dead = [...emitted]
    .filter((c) => /^(tb|fx|ad|it|pk|sh|pb|dx)-/.test(c) && !c.endsWith('-') && !styled.has(c))
    .sort();
  // EVERY TAB'S TOOLBAR MUST BE IN THE SHARED SURFACE FAMILY.
  //
  // theme.css owns the toolbar look -- the card, the seigaiha band, the neon
  // hairline, the cut corner -- and lists the bars it applies to BY NAME. A
  // new tab whose `xx-bar` is not on that list gets none of it, and the
  // symptom is not an error: its controls sit straight on the patterned page
  // ground and read as half-hidden under something. The Pokédex shipped that
  // way, and the same omission also let a second `.dx-bar` rule (the stat bar)
  // apply `height: 8px; overflow: hidden` to the toolbar and clip its buttons
  // to a strip.
  {
    const themeCss = fs.readFileSync(path.join(ROOT, 'app/css/theme.css'), 'utf8');
    // Two marks, both required: the decorative band is painted by a ::before,
    // and the bar's own children have to be lifted above it. A bar with the
    // band and no lift is worse than one with neither -- the pattern paints
    // over its controls.
    const bars = [...emitted].filter((c) => /^[a-z]{2}-bar$/.test(c) && c !== 'sh-bar');
    const orphans = bars.filter((b) =>
      !themeCss.includes(`.${b}::before`) || !themeCss.includes(`.${b} > *`));
    ok('every tab toolbar is registered in theme.css\'s surface family',
      bars.length >= 4 && orphans.length === 0,
      orphans.length ? `not in it: ${orphans.join(', ')}` : bars.sort().join(', '));
  }

  ok('every prefixed class the JS emits is styled somewhere',
    dead.length === 0,
    dead.length ? `${dead.map((c) => '.' + c).join(' ')} — emitted, never styled` : `${emitted.size} classes seen`);
}

// ---------------------------------------------------------------------------
// EVERY FULL-AREA DECORATIVE LAYER MUST BE pointer-events: none
//
// This has now bitten three times. `.ad-markers` and `.ad-notes` cover the map
// with `inset: 0`, and setting either to `auto` swallowed every click meant for
// anything beneath -- the map editor once shipped with NOTHING on the map
// clickable. theme.css adds a new family of the same shape: every wagara
// pattern is a `::before` stretched over its parent with `inset: 0`.
//
// A stubbed DOM does no hit-testing, so this can only ever be caught as a CSS
// rule. Scoped to ::before / ::after: a stretched PSEUDO-element is always
// decoration and must never take clicks. Stretched real elements are a
// judgement call -- `.ad-links` carries the clickable route lines and the
// modal overlays close on a click outside -- and the four map layers that
// caused the original bug are pinned by name in verify_adventure.mjs.
// ---------------------------------------------------------------------------
{
  const offenders = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'app/css')).filter((x) => x.endsWith('.css'))) {
    const txt = fs.readFileSync(path.join(ROOT, 'app/css', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of txt.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const sel = m[1].trim().split('\n').pop().trim();
      const body = m[2];
      if (!/::(before|after)\b/.test(sel)) continue;
      if (!/position:\s*(absolute|fixed)/.test(body)) continue;
      if (!/\binset:\s*0/.test(body)) continue;
      if (/pointer-events:\s*none/.test(body)) continue;
      offenders.push(`${f} ${sel.slice(0, 46)}`);
    }
  }
  // The shell's inline stylesheet plays by the same rules.
  const shell = fs.readFileSync(path.join(ROOT, 'app/index.html'), 'utf8');
  const shellCss = shell.slice(shell.indexOf('<style>'), shell.indexOf('</style>'));
  for (const m of shellCss.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().split('\n').pop().trim();
    const body = m[2];
    if (!/::(before|after)\b/.test(sel)) continue;
    if (!/position:\s*(absolute|fixed)/.test(body)) continue;
    if (/pointer-events:\s*none/.test(body)) continue;
    offenders.push(`index.html ${sel.slice(0, 46)}`);
  }
  ok('every full-area decorative layer is pointer-events: none',
    offenders.length === 0, offenders.join(' | '));
}

// ---------------------------------------------------------------------------
// ONE WAY OUT IS THE MAIN ONE, AND WHICH ONE DEPENDS ON WHAT IS ON OFFER
//
// Install writes the save in place, backing it up first, and it is how this is
// actually used. Download and Install shipped as a matched pair -- same size,
// same two-line shape -- which read as two equal choices and made you decide
// between them every time.
//
// But with no save path configured (drag-and-drop, or ./serve --no-write)
// Download is the ONLY way out, and demoting it there would leave the bar with
// no primary action at all. So the rule is about what else is on offer, not
// about the button, and both halves are asserted -- the second is the one a
// later tidy-up would quietly drop.
// ---------------------------------------------------------------------------
{
  const appjs = fs.readFileSync(path.join(ROOT, 'app/js/app.js'), 'utf8');
  const i = appjs.indexOf('function saveActions()');
  const body = appjs.slice(i, appjs.indexOf('\n}', i));
  ok('Install is the filled primary action', /go\('sh-install'/.test(body));
  ok('...and Download is quiet beside it', /sh-btn sh-dl/.test(body),
    'the same chip as Reload save and Choose file');
  ok('...but primary when it is the only way out',
    /const alone = !state\.config\?\.writes_enabled/.test(body)
    && /if \(alone\)/.test(body) && /sh-download sh-only/.test(body));
  ok('...and both routes are still reachable',
    /installSave\(/.test(body) && (body.match(/downloadSave\(/g) ?? []).length === 2,
    'one call in each branch');
  const shell = fs.readFileSync(path.join(ROOT, 'app/index.html'), 'utf8');
  const rule = /\.sh-dl:disabled \{([^}]*)\}/.exec(shell)?.[1] ?? '';
  ok('...and the demoted button greys by colour, not by opacity',
    /--fx-off-/.test(rule) && !/opacity/.test(rule), rule.replace(/\s+/g, ' ').trim());
}

// ---------------------------------------------------------------------------
// A DARK SURFACE MUST BE DARK, AND A DARK INK MUST BE LIGHT
//
// tools/recolour.py used to measure its L* ladder off the files it writes -- a
// generator whose source of truth is its own output. One misclassified block
// wrote a LIGHT lightness into the dark palette, the next run read that back as
// truth, and the mistake became permanent. What shipped was two near-white
// buttons glowing in the dark-mode masthead: "Install to save" and "Download
// .sav" in their DISABLED state, which is the one state that should recede.
//
// Nothing caught it, and CONTRAST COULD NOT HAVE: ink and background moved
// together, so the pair still measured well. It was the wrong end of the ramp,
// not a bad pair.
//
// The first version of this check compared dark against light and passed the
// mutant, because the corrupted value had the SAME L* as its light
// counterpart -- a relative test is knife-edge exactly where the bug puts you.
// So the thresholds are ABSOLUTE, with margins wide enough that no legitimate
// retune trips them: the tightest real values are --rule at L*26 in dark and
// --axis at L*54 in light.
// ---------------------------------------------------------------------------
{
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const src = ['sheet_template.html', 'app/css/factory.css', 'app/css/theme.css']
    .map(read).join('\n');
  // Comments carry example colours and past measurements; not declarations.
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, ' ');

  const lstar = (hex) => {
    let h = hex.replace('#', '');
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    const v = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const y = 0.2126729 * v[0] + 0.7151522 * v[1] + 0.0721750 * v[2];
    return y > (6 / 29) ** 3 ? 116 * Math.cbrt(y) - 16 : y * (29 / 3) ** 3;
  };

  /* THE SCOPE OF EVERY DECLARATION, from one pass with a brace stack.
     Two windowed-lookback versions of this were wrong before this one: taking
     "everything after the last brace" returns the DECLARATIONS above a
     declaration rather than its selector, and any fixed lookback window is
     shorter than sheet_template.html's palette blocks, which run past 1300
     characters. A stack has neither problem and is shorter. */
  const blocks = [];
  {
    const stack = [];
    let last = 0;
    for (let i = 0; i < clean.length; i++) {
      const c = clean[i];
      if (c === '{') {
        stack.push({ sel: clean.slice(last, i).trim(), from: i });
        last = i + 1;
      } else if (c === '}') {
        const b = stack.pop();
        if (b) blocks.push({ from: b.from, to: i, sel: stack.map((s) => s.sel).concat(b.sel).join(' ') });
        last = i + 1;
      } else if (c === ';') last = i + 1;
    }
  }
  const scopeAt = (i) => {
    let best = null;
    for (const b of blocks) if (b.from < i && i < b.to && (!best || b.from > best.from)) best = b;
    return best ? best.sel : '';
  };

  const values = (name, wantDark) => {
    const out = [];
    for (const m of clean.matchAll(new RegExp(`${name}\\s*:\\s*(#[0-9A-Fa-f]{3,6})`, 'g'))) {
      const sel = scopeAt(m.index);
      if (/data-version/.test(sel)) continue;      // the Volt White overrides
      if (/dark/.test(sel) === wantDark) out.push(m[1]);
    }
    return out;
  };

  const SURFACES = ['--ground', '--card', '--card-2', '--card-3', '--zone', '--rule',
    '--rule-soft', '--grid', '--bartrack', '--x1b', '--fx-off-bg', '--fx-off-rule'];
  const INKS = ['--ink', '--ink-soft', '--ink-faint', '--axis', '--x1',
    '--fx-off-ink', '--pat-ink'];
  const LIMIT = { darkSurface: 40, darkInk: 55, lightSurface: 70, lightInk: 60 };
  const wrong = [];
  let seen = 0;
  const check = (names, dark, test, what) => {
    for (const n of names) {
      for (const v of values(n, dark)) {
        seen += 1;
        if (!test(lstar(v))) wrong.push(`${n} ${v} is L*${lstar(v).toFixed(0)}, ${what}`);
      }
    }
  };
  check(SURFACES, true, (L) => L < LIMIT.darkSurface, 'too light for a dark surface');
  check(INKS, true, (L) => L > LIMIT.darkInk, 'too dark for a dark ink');
  check(SURFACES, false, (L) => L > LIMIT.lightSurface, 'too dark for a light surface');
  check(INKS, false, (L) => L < LIMIT.lightInk, 'too light for a light ink');
  ok('every surface and ink is on the right end of its theme\'s ramp',
    wrong.length === 0, wrong.slice(0, 4).join(' | ') || `${seen} declarations`);
}

// ---------------------------------------------------------------------------
// FOUR PALETTES, AND THE TWO THAT ARE WRITTEN TWICE
//
// data-theme (light/dark) and data-version (black/white) are independent, so
// there are four surface palettes. Two of them -- Volt White's dark -- have to
// be spelled out twice, once for the media query and once for the explicit
// toggle, exactly like the base palette in sheet_template.html. They must stay
// byte-identical or the OS preference and the theme button render as two
// different apps, and this is the kind of drift nobody notices until someone
// flips the switch.
//
// The generated block is owned by tools/recolour.py; this asserts the shape it
// has to keep, not the colours it happens to contain. Pinning a colour string
// would fail the next time the palette is legitimately retuned.
// ---------------------------------------------------------------------------
{
  const css = fs.readFileSync(path.join(ROOT, 'app/css/theme.css'), 'utf8');
  const gen = /BEGIN generated by tools\/recolour\.py[\s\S]*?END generated by tools\/recolour\.py/
    .exec(css)?.[0] ?? '';
  ok('the Volt White surface block is present and generated', gen.length > 400,
    `${gen.length} bytes`);

  const body = (re) => (re.exec(gen)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const light = body(/:root\[data-version="white"\] \{([^}]*)\}/);
  const mq = body(/:root\[data-version="white"\]:not\(\[data-theme="light"\]\) \{([^}]*)\}/);
  const explicit = body(/:root\[data-version="white"\]\[data-theme="dark"\] \{([^}]*)\}/);
  ok('...and its two dark palettes are identical', !!mq && mq === explicit,
    mq === explicit ? `${mq.split(';').length - 1} declarations` : 'the media query and the toggle differ');
  ok('...and its light palette is NOT the same as its dark one',
    !!light && light !== mq, 'a version that renders one palette in both themes is a bug');

  // THE LADDER IS THE CONTRACT. Both versions must define the same set of
  // surface tokens: a token tinted for Blaze Black and forgotten for Volt
  // White inherits the wrong hue and reads as a stain on one surface.
  const tokensOf = (s) => new Set([...s.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  ok('...and light and dark cover the same tokens',
    [...tokensOf(light)].every((k) => tokensOf(mq).has(k))
    && [...tokensOf(mq)].every((k) => tokensOf(light).has(k)),
    `${tokensOf(light).size} vs ${tokensOf(mq).size}`);

  // Every surface token Blaze Black defines has to have a Volt White answer,
  // or that surface keeps the violet in the steel palette.
  const tpl = fs.readFileSync(path.join(ROOT, 'sheet_template.html'), 'utf8');
  const base = /:root\{([\s\S]*?)\n  \}/.exec(tpl)?.[1] ?? '';
  const SURFACES = ['--ground', '--card', '--card-2', '--card-3', '--zone',
    '--ink', '--ink-soft', '--ink-faint', '--rule', '--rule-soft'];
  const missing = SURFACES.filter((k) => base.includes(`${k}:`) && !tokensOf(light).has(k));
  ok('...and answers every surface the base palette defines',
    missing.length === 0, missing.join(' ') || `${SURFACES.length} surfaces`);
}

// ---------------------------------------------------------------------------
// THE THEME IS APPLIED BEFORE THE FIRST PAINT
//
// Blaze Black / Volt White / follow-the-OS. The stored choice has to be put on
// <html> AHEAD of the stylesheets: doing it from app.js after boot paints the
// page in the OS theme and then flips it, which is the flash everyone knows.
// Easy to "tidy" that inline script into a module later and not notice, since
// nothing else breaks -- so it is pinned here.
//
// "System" must stay the ABSENCE of the attribute, because every dark block in
// the project is guarded as :root:not([data-theme="light"]) and relies on the
// media query still applying when nothing is set.
// ---------------------------------------------------------------------------
{
  const shell = fs.readFileSync(path.join(ROOT, 'app/index.html'), 'utf8');
  const firstLink = shell.indexOf('<link rel="stylesheet"');
  const boot = shell.slice(0, firstLink);
  ok('the theme is set before the first stylesheet',
    /localStorage\.getItem\(['"]blazeblack\.theme['"]\)/.test(boot)
    && /setAttribute\(['"]data-theme['"]/.test(boot),
    'otherwise the page paints in the OS theme and then flips');
  ok('the pre-paint script survives private mode', /try\s*\{[\s\S]*?\}\s*catch/.test(boot));

  const appjs = fs.readFileSync(path.join(ROOT, 'app/js/app.js'), 'utf8');
  ok('"system" is the absence of data-theme, not a value',
    /removeAttribute\(['"]data-theme['"]\)/.test(appjs),
    'setting data-theme="system" would break every :root:not([data-theme="light"]) guard');
  // THE RUN SETTINGS LIVE IN THE MASTHEAD, all three of them. Version and
  // starter were there; the nuzlocke was only inside its own tab, so someone
  // looking for "how do I turn this on" scanned the bar, found nothing, and
  // concluded the feature did not exist.
  {
    ok('the masthead states whether a nuzlocke is live',
      /sh-nuz/.test(appjs) && /NUZLOCKE OFF/.test(appjs));
    // It must NOT be a toggle. A one-click switch beside the theme control is
    // the thing you hit by accident, and a nuzlocke has a rule set behind it.
    // To end of line, not to the first `;` -- the handler body contains one.
    const handler = /nz\.onclick =.*/.exec(appjs)?.[0] ?? '';
    ok('...and links to the Run tab rather than toggling in place',
      /selectTab\('run'/.test(handler) && !/enabled\s*=/.test(handler), handler.slice(0, 70));
    ok('...and every tab is reachable from the tab bar', /const TABS = \[/.test(appjs)
      && (appjs.match(/const TABS = \[([^\]]*)\]/)?.[1] ?? '').split(',').length >= 7,
      (appjs.match(/const TABS = \[([^\]]*)\]/)?.[1] ?? '').trim());
  }

  ok('all three themes are offered', /'system'/.test(appjs)
    && /Blaze Black/.test(appjs) && /Volt White/.test(appjs));
}

console.log(failed ? `\n  ${failed} check(s) FAILED` : '\n  all checks passed');
process.exit(failed ? 1 : 0);
