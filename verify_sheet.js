#!/usr/bin/env node
/*
 * verify_sheet.js -- check state/team_sheet.html before publishing it.
 *
 * Why this file asserts what it does: notes/battle-sheet.md
 *
 *     node verify_sheet.js
 *
 * WHY THIS EXISTS
 * A stylesheet with one unclosed brace cost three rounds of "I added the
 * styling" / "it looks identical".  The CSS was present in the file the whole
 * time -- grep proved it -- but a duplicated `.glos{display:grid;` earlier in
 * the sheet meant every rule after it was parsed as part of that broken block
 * and thrown away.  Text-presence checks cannot see that; a brace count can.
 *
 * WHAT IT CHECKS
 *   1. CSS braces balance, and no rule is stranded inside an unclosed block
 *   2. The JS parses
 *   3. render() runs for every team against a stubbed DOM (catches the blank
 *      page a runtime error would otherwise ship)
 *   4. monBlock / encounterPanel produce balanced <div> trees
 *   5. Chart geometry has no NaN, nothing out of viewBox, no bar over 100%
 *
 * Exit code 1 if anything fails, so it can gate a publish.
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "state", "team_sheet.html");
const html = fs.readFileSync(FILE, "utf8");
let failed = 0;
const ok = (name, pass, detail = "") => {
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}${detail ? "  " + detail : ""}`);
  if (!pass) failed++;
};

// ---- 1. CSS
const css = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
const bal = (css.match(/{/g) || []).length - (css.match(/}/g) || []).length;
ok("CSS braces balance", bal === 0, `imbalance ${bal}`);

// Nesting is legal ONLY directly inside an at-rule (@media, @supports).  A rule
// nested inside a plain declaration block means an unclosed brace above it, and
// everything from there down is silently discarded by the browser.
const stack = [];
const stranded = [];
for (const m of css.matchAll(/([^{}]*)([{}])/g)) {
  const sel = m[1].trim().split("\n").pop().trim();
  if (m[2] === "{") {
    const insideAtRule = stack.length > 0 && stack[stack.length - 1];
    if (stack.length > 0 && !insideAtRule && sel) stranded.push(sel.slice(0, 40));
    stack.push(/^@/.test(sel));
  } else stack.pop();
}
ok("no rules stranded in an unclosed block", stranded.length === 0, stranded.slice(0, 3).join(" | "));

// A var(--token) that was never defined silently collapses: the declaration is
// dropped and the element renders unstyled.  This bit for real -- boost CSS was
// first written against --fx-go-bg / --line / --good, which are the APP's
// tokens, not this sheet's, so the active button would have had no background
// at all.  Same failure shape as the unclosed brace: present in the file,
// absent from the page.  Fallback forms, var(--x, fallback), are fine.
const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]));
const undef = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)\s*(\)|,)/g)]
  .filter(m => m[2] === ")").map(m => m[1]))].filter(t => !defined.has(t));
ok("every var(--token) used is actually defined", undef.length === 0, undef.join(" | "));

// The dark palette is written TWICE -- once under @media (prefers-color-scheme)
// and once under [data-theme="dark"], because a media query and a plain
// selector cannot share one rule.  They must stay byte-identical or the
// explicit toggle and the OS preference render as two different themes.  This
// is exactly the kind of drift nobody notices until someone flips the switch.
const darkBlocks = [...css.matchAll(/(?:prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)|:root\[data-theme="dark"\])\s*\{([\s\S]*?)\n\s*\}/g)]
  .map(m => m[1].replace(/\s+/g, " ").trim());
ok("the two dark palettes are identical", darkBlocks.length === 2 && darkBlocks[0] === darkBlocks[1],
  darkBlocks.length !== 2 ? `found ${darkBlocks.length} dark blocks, expected 2` : "");

// Surface separation.  Dark mode shipped with a card that measured 1.10:1
// against the page -- a card distinguished from the ground only by a 1px
// border that was itself low contrast.  Pin the ladder so it cannot drift
// back.  Values are read from the sheet's own tokens, not hardcoded twice.
const tokenOf = (block, name) => {
  const m = block.match(new RegExp(`${name}\\s*:\\s*(#[0-9A-Fa-f]{3,6})`));
  return m ? m[1] : null;
};
const lum = (hex) => {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map(c => c + c).join("");
  const v = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
if (darkBlocks.length === 2) {
  const d = darkBlocks[0];
  const g = tokenOf(d, "--ground"), c = tokenOf(d, "--card"), r = tokenOf(d, "--rule");
  const sep = g && c ? ratio(g, c) : 0;
  const bord = c && r ? ratio(c, r) : 0;
  ok("dark cards separate from the page", sep >= 1.25, `card/ground ${sep.toFixed(2)} (need 1.25)`);
  ok("dark card borders are visible", bord >= 1.3, `rule/card ${bord.toFixed(2)} (need 1.30)`);
}

// ---- 2 & 3. JS
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(m => m[1]).find(s => s.includes("function battleIndex"));
ok("main script found", !!script);

const mk = () => new Proxy({
  style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
  children: [], value: "", open: true, innerHTML: "",
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
global.requestAnimationFrame = f => f();

const tmp = path.join(require("os").tmpdir(), `sheet_probe_${process.pid}.js`);
fs.writeFileSync(tmp, script + "\n;module.exports={render,TEAMS,cur,monBlock,encounterPanel,statOf," +
  "levelCurve,speedLadder,threatBoard,bState,stagesOf,boostMoves,bMax,calcDamage,MOVES," +
  "OPPONENTS,boostBanner,bKey,stageMul,oppMon,boostRow,stageFx,battleIndex,TRFACE,D,abilMul,matchLine,mechOn,DEX,enemySpe," +
  "calcPanel,calcDefender,calc,turnGame,solveZeroSum,gameRead,gamePanel,calcIncoming,oppMon,spdOf,enemySpe,gDepth,stageMul,buildSim,stepTurn,leaf,applyStages,dmgMul,STAGE0,threatBoard," +
  "pairBoards,fmtOf,isRotation,depthPicker,eff,eKey,eFind,eLabel,calcDefender};");
let M;
try {
  M = require(tmp);
  ok("JS parses and top-level runs", true);
} catch (e) {
  ok("JS parses and top-level runs", false, e.message.split("\n")[0]);
  fs.unlinkSync(tmp);
  process.exit(1);
}

let rendered = 0;
try { M.TEAMS.forEach(t => { M.render(t); rendered++; }); } catch (e) {
  ok("render() for every team", false, e.message.split("\n")[0]);
}
if (rendered === M.TEAMS.length) ok("render() for every team", true, `${rendered} teams`);

// ---- 4. DOM balance
const bal2 = s => (s.match(/<div\b/g) || []).length - (s.match(/<\/div>/g) || []).length;
const team = M.cur(M.TEAMS[0]);
const KEYS = ["hp", "atk", "def", "spa", "spd", "spe"];
const g = Math.max(...team.flatMap(o => KEYS.map(k => M.statOf(o, k))), 1);
const tm = Math.max(...team.map(o => KEYS.reduce((a, k) => a + M.statOf(o, k), 0)), 1);
// THE SAME SIMPLE SELECTOR MUST NOT BE DEFINED TWICE WITH CONFLICTING VALUES.
// verify_app.mjs has had this for app/css since two .tb-note rules fought and
// the second won everywhere. The sheet needs it MORE, not less: its stylesheet
// is injected app-wide at boot, so a duplicate here reaches every tab. It
// caught a real one immediately -- a second `.oppline` added to "fix" an
// alignment that was already flex, which only clobbered its gap.
{
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const seen = new Map();
  const dupes = [];
  // Top-level rules only: a selector repeated inside a media query is how the
  // two dark palettes are written, and that is deliberate.
  let depth = 0, buf = "";
  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i];
    if (ch === "{") {
      depth++;
      if (depth === 1) {
        const sel = buf.trim();
        buf = "";
        const body = flat.slice(i + 1, flat.indexOf("}", i + 1));
        if (/^\.[A-Za-z][\w-]*$/.test(sel)) {
          // Compare VALUES, not just property names. Two rules that set the
          // same property to the same thing are dead weight, not a bug; the
          // failure is one rule quietly overriding another with a different
          // value, which is what made every .tb-note render as a boxed input.
          const props = new Map([...body.matchAll(/([a-z-]+)\s*:\s*([^;]+)/g)]
            .map((m) => [m[1], m[2].trim()]));
          const prev = seen.get(sel);
          if (prev) {
            const clash = [...props].filter(([k, v]) => prev.has(k) && prev.get(k) !== v);
            if (clash.length) dupes.push(`${sel} → ${clash.map(([k]) => k).join(", ")}`);
          }
          seen.set(sel, new Map([...(prev ?? []), ...props]));
        }
      }
    } else if (ch === "}") {
      depth--; if (depth === 0) buf = "";
    } else if (depth === 0) buf += ch;
  }
  ok("no simple class selector is defined twice with conflicting values",
    dupes.length === 0, dupes.slice(0, 4).join("; "));
}

// A FIXED-HEIGHT BAR MUST NOT CARRY VERTICAL PADDING OR A BORDER.
// `*{box-sizing:border-box}` is set sheet-wide, so `.bt{height:11px}` counts
// padding and border INSIDE that 11px. The TOT row's separator used to be
// `.bars .tot{padding-top:5px;border-top:1px}` -- applied to all three cells,
// including the bar -- which left the track content box 5px tall while the
// track still painted its full 11px pill, and `overflow:hidden` clipped the
// fill to the bottom 5px. The bar sat below its own colouring.
//
// A stub DOM does no layout, so this can only be caught as a CSS rule.
// Measured before the fix: fill 6px below the pill top, 0px below it.
{
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const bad = [];
  for (const m of flat.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].trim(), body = m[2];
    // Rules that reach the fixed-height track: `.bt` itself, or `.tot`, which
    // is set on the bar cell as well as on the two text cells beside it.
    if (!/\.(bt|tot)\b/.test(sel) || !/\.bars\b|\.bt\b/.test(sel)) continue;
    const offenders = [...body.matchAll(/(padding-top|padding-bottom|border-top|border-bottom|padding|border)\s*:\s*([^;]+)/g)]
      .filter(([, prop, val]) => !/^(0|none)\b/.test(val.trim()))
      .filter(([, prop]) => !/^border$/.test(prop) || !/^0/.test(body));
    if (offenders.length) bad.push(`${sel} → ${offenders.map((o) => o[1]).join(", ")}`);
  }
  ok("the stat bars carry no vertical padding or border",
    bad.length === 0,
    bad.length ? `${bad.join("; ")} — border-box makes these eat the 11px track`
      : "border-box would shrink the track inside its own pill");

  // The TOT divider is its own full-width grid row, which is also the only
  // way it draws as one continuous line: the three .tot cells are different
  // heights under `align-items:center`, so a per-cell border-top landed at
  // three different y positions (measured 8px apart).
  const rule = /\.bars\s+\.totrule\s*\{([^}]*)\}/.exec(flat);
  ok("the TOT divider is a full-width row, not padding on three cells",
    Boolean(rule) && /grid-column\s*:\s*1\s*\/\s*-1/.test(rule[1]),
    rule ? rule[1].trim() : "no .bars .totrule rule");
}

ok("monBlock div balance", bal2(M.monBlock(team[0], "why", g, tm)) === 0);
ok("encounterPanel div balance", bal2(M.encounterPanel(team, M.TEAMS[0])) === 0);

// THE TRAINER'S OWN PORTRAIT, not their Pokemon. Same failure shape the
// opponent sprites already have a check for: an edit that "adds" artwork can
// silently render nothing and leave a live-looking CSS rule behind, and a
// text-presence test on the template cannot see the difference.
{
  const idx = M.battleIndex();
  const faces = (idx.match(/class="bface/g) ?? []).length;
  const withFace = (M.OPPONENTS ?? []).filter((e) => e.face != null).length;
  ok("every documented fight resolves to a trainer portrait",
    withFace === (M.OPPONENTS ?? []).length,
    `${withFace} of ${(M.OPPONENTS ?? []).length}`);
  ok("...and the encounter cards actually render them",
    faces === withFace, `${faces} rendered vs ${withFace} resolved`);
  ok("...from real image data, not an empty src",
    (idx.match(/class="bface[^"]*"><img src="data:image\/png;base64,[A-Za-z0-9+/]{64}/g) ?? [])
      .length === faces);
  ok("the fight planner shows the portrait too",
    /class="bface/.test(M.encounterPanel(team, M.TEAMS[0])));
  // One portrait serves several classes, so the payload must key by sprite id
  // rather than embedding a copy per fight -- Cheren alone appears seven times.
  const trface = M.TRFACE ?? {};
  ok("and one portrait is embedded once however many fights use it",
    Object.keys(trface).length < (M.OPPONENTS ?? []).length,
    `${Object.keys(trface).length} portraits for ${(M.OPPONENTS ?? []).length} fights`);
}

// The what-if control belongs in the fight planner too, not only on the roster
// cards: "does Dragon Dance let me outspeed this" is the question Mock the
// battle exists to answer. It feeds the same bState, so damage, speed order
// and the matrices all move together.
{
  const src = script.slice(script.indexOf("function encounterPanel"));
  const mock = src.slice(0, src.indexOf("const lvTxt"));
  ok("the fight planner carries the what-if control", /boostRow\(me\)/.test(mock),
    "otherwise you can only apply a boost on the roster and scroll back down");
}

// ---- 5. chart geometry
const charts = { levelCurve: M.levelCurve(team), speedLadder: M.speedLadder(team, M.OPPONENTS?.[0] || { team: [] }) };
let geomBad = [];
for (const [name, out] of Object.entries(charts)) {
  if (!out) continue;
  if (/NaN|Infinity|undefined/.test(out)) geomBad.push(`${name}: NaN/undefined`);
  const nums = [...out.matchAll(/(?:cx|cy|x1|y1|x2|y2)="(-?[\d.]+)"/g)].map(z => +z[1]);
  if (nums.some(v => v < -20 || v > 900)) geomBad.push(`${name}: coord out of range`);
  if ([...out.matchAll(/width:([\d.]+)%/g)].some(z => +z[1] > 100)) geomBad.push(`${name}: bar over 100%`);
}
ok("chart geometry", geomBad.length === 0, geomBad.join(" | "));

// ---- 5b. the roster card header must FIT inside a roster column.
// This is the bug that shipped: a 96px sprite + a 22px name + a 174px coverage
// grid inside a 390px card does not fit, so the grid wrapped to its own row and
// pushed the entire card body down.  The arithmetic is checkable, so check it.
{
  const num = (re) => { const m = css.match(re); return m ? +m[1] : null; };
  const col = num(/\.roster\{[^}]*minmax\((\d+)px/);
  const grid = num(/\.tcov\{[^}]*?width:(\d+)px/s);
  const sprite = num(/\.idbar img\.sp\{width:(\d+)px/);
  const pad = num(/\.idbar\{[^}]*padding:\d+px (\d+)px/s);
  const gap = num(/\.idbar\{[^}]*column-gap:(\d+)px/s);
  if ([col, grid, sprite, pad, gap].every((v) => v !== null)) {
    const room = col - 2 * pad - sprite - 2 * gap - grid;
    // Whatever is left has to seat the longest name on the roster at .nm size.
    const size = num(/\.idbar \.nm\{font-size:(\d+)px/);
    // Ordinary species names top out at 10 characters (Cofagrigus, Conkeldurr).
    // Hyphenated forms like Giratina-Altered are outliers and are SUPPOSED to
    // wrap: .idtext has min-width:0 and .tcov is flex:none, so a long name wraps
    // inside its own column instead of shoving the grid off the row.
    const names = M.TEAMS.flatMap((t) => M.cur(t)).map((m) => m.name.length);
    const ordinary = Math.max(...names.filter((n) => n <= 11), 1);
    const est = Math.ceil(ordinary * size * 0.58);   // bold, tightened tracking
    ok("the card header fits the coverage grid beside the name",
      room >= 100, `${room}px left for the name in a ${col}px column`);
    ok("...with room for an ordinary species name on one line",
      room >= est, `needs ~${est}px for ${ordinary} chars at ${size}px, has ${room}px`);
    // And the grid must never be the thing that gives way.
    ok("a long name wraps instead of displacing the grid",
      /\.idbar \.idtext\{[^}]*min-width:0/.test(css) && /\.tcov\{[^}]*flex:none/s.test(css));
    // Three columns must still fit the page, or the fix costs a third of the roster.
    const wrapMax = num(/\.wrap\{max-width:(\d+)px/);
    const wrapPad = num(/\.wrap\{[^}]*padding:0 (\d+)px/s);
    const gutter = num(/\.roster\{[^}]*gap:(\d+)px/s);
    if (wrapMax && wrapPad !== null && gutter !== null) {
      const fits = Math.floor((wrapMax - 2 * wrapPad + gutter) / (col + gutter));
      ok("and three roster columns still fit at full width", fits >= 3, `${fits} columns`);
    }
  } else {
    console.log("  [SKIP] header geometry — could not read the sizes out of the CSS");
  }
}

// ---- 6. stat stages
// The boosts rewrite every number on the tab, so they get behavioural checks,
// not a grep for the markup.  A control that renders but multiplies nothing is
// exactly the failure this file exists to catch.
{
  const all = M.TEAMS.flatMap(t => M.cur(t));
  const withMove = all.find(m => M.boostMoves(m).some(n => {
    const d = M.MOVES[n]; return d.tg !== 'foe' && d.st.atk > 0;
  }));
  if (!withMove) {
    console.log("  [SKIP] stat stages — no team member knows an Attack-raising move");
  } else {
    const mv = M.boostMoves(withMove).find(n => M.MOVES[n].tg !== 'foe' && M.MOVES[n].st.atk > 0);
    const key = M.bKey(withMove);
    const before = M.statOf(withMove, "atk");
    M.bState[key] = { [mv]: 1 };
    const after = M.statOf(withMove, "atk");
    const want = Math.floor(before * M.stageMul(M.MOVES[mv].st.atk));
    ok(`applying ${mv} raises Attack`, after === want && after > before,
      `${before} → ${after} (expected ${want})`);
    ok("the banner names who is boosted", M.boostBanner().includes(withMove.name));

    // "I don't see the boosts" was the actual failure report, and nothing here
    // checked the control renders at all -- only that the maths behind it was
    // right.  A feature you cannot find is not shipped.
    const KEYS2 = ["hp", "atk", "def", "spa", "spd", "spe"];
    const gg = Math.max(...M.cur(M.TEAMS[0]).flatMap((o) => KEYS2.map((k) => M.statOf(o, k))), 1);
    const html2 = M.monBlock(withMove, "", gg, gg * 6);
    ok("the boost control is rendered on the card", /class="boostrow"/.test(html2));
    ok("with a button per stat move it knows",
      (html2.match(/data-bmv=/g) ?? []).length === M.boostMoves(withMove).length,
      `${(html2.match(/data-bmv=/g) ?? []).length} of ${M.boostMoves(withMove).length}`);
    ok("above the move list, not buried under it",
      html2.indexOf('class="boostrow"') < html2.indexOf('class="movelist"'));
    ok("and labelled, so a row of move names is not mistaken for more move data",
      /class="blab"/.test(html2));
    // A Pokemon with no stat move must get no empty control.
    const plain = M.TEAMS.flatMap((t) => M.cur(t)).find((m) => M.boostMoves(m).length === 0);
    if (plain) {
      ok("but nothing at all where there is no stat move to apply",
        !/class="boostrow"/.test(M.monBlock(plain, "", gg, gg * 6)), plain.name);
    }

    // Stacking must respect the +6 ceiling, and going past the cap must clear
    // rather than pin the control at maximum with no way down.
    const cap = M.bMax(M.MOVES[mv], withMove);
    M.bState[key] = { [mv]: cap };
    ok("stacking reaches +6 stages", M.stagesOf(withMove).self.atk === 6,
      `${cap} × ${M.MOVES[mv].st.atk} → ${M.stagesOf(withMove).self.atk}`);
    // The ceiling only earns its keep when something OVERSHOOTS it -- one move
    // at its own cap lands exactly on 6 and never exercises the clamp. Two
    // Attack-raising moves on the same Pokemon do.
    M.bState[key] = { [mv]: cap + 3 };
    ok("and is clamped there, not stacked past it",
      M.stagesOf(withMove).self.atk === 6,
      `${cap + 3} × ${M.MOVES[mv].st.atk} → ${M.stagesOf(withMove).self.atk}`);
    const atkStat = M.statOf(withMove, "atk");
    M.bState[key] = { [mv]: cap };
    ok("so an over-stacked boost hits no harder than a capped one",
      M.statOf(withMove, "atk") === atkStat, `${atkStat} vs ${M.statOf(withMove, "atk")}`);

    // Damage has to move with it, or the whole feature is decorative.
    // Opponents are stored raw; oppMon() is what turns one into something the
    // damage formula can defend with.
    const om = (M.OPPONENTS || []).flatMap(o => o.team || [])
      .map(M.oppMon).find(t => t && t.b);
    const atkMove = withMove.moves.find(n => M.MOVES[n] && M.MOVES[n].c === "physical"
      && M.MOVES[n].p > 1);
    if (om && atkMove) {
      M.bState[key] = {};
      const d0 = M.calcDamage(withMove, atkMove, om);
      M.bState[key] = { [mv]: cap };
      const d1 = M.calcDamage(withMove, atkMove, om);
      ok("boosted damage actually goes up", d0 && d1 && d1.hi > d0.hi,
        `${d0 && d0.hi} → ${d1 && d1.hi}`);
    } else {
      console.log("  [SKIP] boosted damage — no physical move / opponent pair to test");
    }

    // A foe-lowering move must hit the DEFENDER's stat, not the user's. Driven
    // off MOVES rather than off whatever this save happens to have learned, so
    // the branch is exercised on every save shape.
    const foeMv = Object.keys(M.MOVES).find((n) => M.MOVES[n].tg === "foe"
      && M.MOVES[n].st.def < 0);
    const pm = withMove.moves.find((n) => M.MOVES[n] && M.MOVES[n].c === "physical"
      && M.MOVES[n].p > 1);
    if (om && pm && foeMv) {
      M.bState[key] = {};
      const f0 = M.calcDamage(withMove, pm, om);
      const ownDef = M.statOf(withMove, "def");
      M.bState[key] = { [foeMv]: 1 };
      const f1 = M.calcDamage(withMove, pm, om);
      ok(`${foeMv} lowers the target's Defence, raising damage`,
        f0 && f1 && f1.hi > f0.hi, `${f0 && f0.hi} → ${f1 && f1.hi}`);
      ok("a foe-targeting move leaves the user's own stats alone",
        M.statOf(withMove, "def") === ownDef, `${ownDef} → ${M.statOf(withMove, "def")}`);
    } else {
      console.log("  [SKIP] foe debuff — no physical move / opponent pair to test");
    }
    Object.keys(M.bState).forEach(k => delete M.bState[k]);
    ok("clearing puts every number back", M.statOf(withMove, "atk") === before,
      `${M.statOf(withMove, "atk")} vs ${before}`);
    ok("and the banner goes away", M.boostBanner() === "");

    // ---------------------------------------------------------------------
    // CONTRARY MUST INVERT A SELF-LOWERING MOVE.
    //
    // The bug this pins: a Contrary Arcanine with V-create (ROM: Spe -1,
    // Def -1) had the drop applied literally, so stacking the boost UP made
    // it slower and the turn order flipped from "you first" to "them first"
    // between two clicks and three. The sheet named the ability in prose and
    // then ignored it everywhere a number was computed.
    //
    // Driven off MOVES rather than off whatever this save happens to hold, so
    // it runs on any save. The mon is a stub for the same reason.
    const drop = Object.keys(M.MOVES).find((n) => {
      const d = M.MOVES[n];
      return d.st && d.tg !== "foe" && Object.values(d.st).some((v) => v < 0)
        && Object.values(d.st).every((v) => v < 0);
    });
    if (drop) {
      const dst = M.MOVES[drop].st, k0 = Object.keys(dst)[0];
      const stub = (ab) => ({ name: "Stub", box: "Party", ab,
        moves: [drop], stats: [100, 100, 100, 100, 100, 100], lvl: 50, types: [] });
      const plainMon = stub(""), contrary = stub("Contrary"), simple = stub("Simple");
      M.bState[M.bKey(plainMon)] = { [drop]: 2 };
      ok("without Contrary the drop is applied as written",
        M.stagesOf(plainMon).self[k0] === dst[k0] * 2,
        `${drop} ×2 → ${k0} ${M.stagesOf(plainMon).self[k0]}`);
      ok("...and Contrary turns the same move into a boost",
        M.stagesOf(contrary).self[k0] === -dst[k0] * 2,
        `${drop} ×2 → ${k0} ${M.stagesOf(contrary).self[k0]}`);
      // The regression was non-monotonic speed, so monotonicity is the check.
      const spd = (n) => { M.bState[M.bKey(contrary)] = { [drop]: n };
        return M.statOf(contrary, k0); };
      ok("stacking a Contrary self-drop can only move the stat one way",
        spd(1) < spd(2) && spd(2) < spd(3),
        `${spd(1)} → ${spd(2)} → ${spd(3)}`);
      M.bState[M.bKey(simple)] = { [drop]: 1 };
      ok("Simple doubles the same change",
        M.stagesOf(simple).self[k0] === dst[k0] * 2,
        `${drop} ×1 → ${k0} ${M.stagesOf(simple).self[k0]}`);
      ok("...so its cap is reached in half the clicks",
        M.bMax(M.MOVES[drop], simple) * 2 <= M.bMax(M.MOVES[drop], plainMon) + 1,
        `${M.bMax(M.MOVES[drop], simple)} vs ${M.bMax(M.MOVES[drop], plainMon)}`);
      // A button whose tooltip contradicts what the click does is worse than
      // no tooltip, so the rendered row must quote the EFFECTIVE direction.
      const row = M.boostRow(contrary);
      ok("and the button quotes the direction it actually applies",
        row.includes(`${dst[k0] < 0 ? "+" : "-"}`) && /Contrary is applied/.test(row));
      Object.keys(M.bState).forEach((k) => delete M.bState[k]);
    } else {
      console.log("  [SKIP] Contrary — no self-lowering move in MOVES");
    }
  }
}

// ---------------------------------------------------------------------------
// RIVAL ROSTERS ARE EXACTLY SIX.
//
// The doc stacks the three per-starter variants inside single table cells, so
// five late-game rival blocks parsed as eight Pokemon. Anything over six is a
// roster that has not been resolved to the line he actually faces -- and the
// monkey is the part that was silently wrong even when the count was right.
{
  const over = (M.OPPONENTS || []).filter((o) => (o.team || []).length > 6);
  ok("no encounter fields more than six Pokémon",
    over.length === 0,
    over.map((o) => `${o.leader} has ${o.team.length}`).join("; "));
  const rivals = (M.OPPONENTS || []).filter((o) => o.kind === "rival");
  ok("every rival roster is exact rather than a documented pool",
    rivals.length > 0 && rivals.every((o) => !o.approx),
    rivals.filter((o) => o.approx).map((o) => o.leader).join("; "));
  // One starter line only. Two would mean the variants were never resolved.
  const LINES = { grass: ["Snivy", "Servine", "Serperior"],
                  fire: ["Tepig", "Pignite", "Emboar"],
                  water: ["Oshawott", "Dewott", "Samurott"] };
  const mixed = rivals.filter((o) => {
    const hit = Object.keys(LINES).filter((k) =>
      LINES[k].some((sp) => (o.team || []).some((m) => m.n === sp)));
    return hit.length > 1;
  });
  ok("and carries one starter line, not several",
    mixed.length === 0, mixed.map((o) => o.leader).join("; "));

  // VERSION-GATED FIGHTS ARE DROPPED, NOT GREYED -- the same call as the
  // rivals' per-starter variants. Opelucid has two leaders across the pair and
  // only one is in your cartridge; a permanently disabled card is a puzzle to
  // solve rather than a fight to plan against, and it makes every total on the
  // page wrong by one.
  const leaders = (M.OPPONENTS ?? []).filter((o) => o.kind === "gym").map((o) => o.leader);
  ok("only one Opelucid leader is on the page",
    leaders.filter((n) => /Drayden|Iris/.test(n)).length === 1,
    leaders.filter((n) => /Drayden|Iris/.test(n)).join(", "));
  ok("...so the gym count is eight", leaders.length === 8, `${leaders.length}`);
  ok("and nothing is left flagged as the other version",
    (M.OPPONENTS ?? []).every((o) => !o.other_version));
  // Dropping them silently would leave a reader wondering where Iris went, so
  // the Reference zone has to say what this playthrough is gated on.
  const gates = M.D?.GATES ?? [];
  ok("the Reference explains both gates",
    gates.length >= 2 && /Oshawott|starter/i.test(gates[0][0] + gates[0][1])
      && /Black|White|version/i.test(gates[1][0] + gates[1][1]),
    gates.map((g) => g[0]).join(" · "));
}

// ---------------------------------------------------------------------------
// BOTH SIDES GET THEIR ABILITIES. This tab exists to say how YOUR team does
// against THEM, which it cannot do while their abilities are ignored: the
// defender's Def/SpD was read straight off base stats and their Speed straight
// off theirs, so a Marvel Scale wall took full damage and a Swift Swim sweeper
// was listed as slower than you in the rain.
{
  const team = M.cur(M.TEAMS[0]);
  const me = team.find((m) => m.moves.some((n) => M.MOVES[n] && M.MOVES[n].c === 'physical'
    && M.MOVES[n].p > 1));
  const mv = me && me.moves.find((n) => M.MOVES[n] && M.MOVES[n].c === 'physical' && M.MOVES[n].p > 1);
  const base = (M.OPPONENTS ?? []).flatMap((o) => o.team ?? []).map(M.oppMon).find((t) => t && t.b);
  if (me && mv && base) {
    const plain = { ...base, ab: '' };
    const tough = { ...base, ab: 'Flower Gift' };   // +50% Sp. Def, sun-gated
    const d0 = M.calcDamage(me, mv, plain);
    // Not gated on: a mech-gated ability must do nothing while its weather is off.
    ok('a weather-gated defensive ability does nothing while that weather is off',
      M.calcDamage(me, mv, tough).hi === d0.hi);
    const hard = { ...base, ab: 'Marvel Scale' };   // status-gated, never applied
    ok('...and a status-gated one is never applied, as on your own side',
      M.calcDamage(me, mv, hard).hi === d0.hi);
    // An ungated one must reduce damage. Slow Start halves Attack, not defence,
    // so use the defence entry the sheet actually models.
    const soft = { ...base, ab: 'Defeatist' };
    ok('the defender\'s own ability is read from the roster, not assumed away',
      typeof M.abilMul === 'function' && M.abilMul(tough, 'spd') === 1,
      `${M.abilMul && M.abilMul(tough, 'spd')}`);
    ok('abilMul carries no stat stages -- those are your side\'s what-if only',
      M.abilMul({ ab: '' }, 'atk') === 1);
    // THE POSITIVE CASE. Every check above passes for a helper that always
    // returns 1, so turn the weather on and require the number to move.
    const spAtk = M.TEAMS.flatMap((t) => M.cur(t))
      .map((m) => [m, m.moves.find((n) => M.MOVES[n] && M.MOVES[n].c === 'special'
        && M.MOVES[n].p > 1)])
      .find(([, n]) => n);
    if (spAtk) {
      const [sm, smv] = spAtk;
      M.mechOn.sun = true;
      const sunny = M.calcDamage(sm, smv, { ...base, ab: 'Flower Gift' });
      const plainSun = M.calcDamage(sm, smv, plain);
      M.mechOn.sun = false;
      ok('...and in its weather it actually reduces the damage you deal',
        sunny.hi < plainSun.hi, `${plainSun.hi} -> ${sunny.hi} (${smv})`);
    }
    // Same for Speed, which is the half that decides turn order.
    const o2 = (M.OPPONENTS ?? []).flatMap((x) => x.team ?? []).find((x) => M.DEX[x.n]);
    if (o2) {
      const dry = M.enemySpe(o2);
      M.mechOn.rain = true;
      const wet = M.enemySpe({ ...o2, a: 'Swift Swim' });
      M.mechOn.rain = false;
      ok('...and a Swift Swim opponent is faster in the rain, not slower',
        wet === dry * 2, `${dry} -> ${wet}`);
    }
    void soft;
  }
}

// TRICK ROOM INVERTS THE TURN-ORDER VERDICT, and the one team the mechanic
// exists for was being told it moved second.
{
  const team = M.cur(M.TEAMS[0]);
  const o = (M.OPPONENTS ?? []).flatMap((x) => x.team ?? []).find((x) => M.DEX[x.n]);
  if (o) {
    const before = M.matchLine(team[0], o);
    M.mechOn.tr = true;
    const after = M.matchLine(team[0], o);
    M.mechOn.tr = false;
    const dir = (h) => /you first/.test(h) ? 'you' : /they first/.test(h) ? 'them' : '?';
    ok('Trick Room flips who moves first in the matchup line',
      dir(before) !== '?' && dir(after) !== '?' && dir(before) !== dir(after),
      `${dir(before)} -> ${dir(after)}`);
  }
}

fs.unlinkSync(tmp);

// ============================ the free-form calculator ======================
// EVERY DAMAGE NUMBER ON THIS PAGE IS AGAINST A DOCUMENTED FIGHT, which
// answers "am I ready for what is next" and nothing about the Pokemon you
// just met on a route. The calculator fills that in -- and it lives in this
// template rather than in a tab BECAUSE calcDamage does: the Gen 5 formula,
// the type chart, both sides' abilities, the item multipliers, the weather
// toggles. Anywhere else it would be a second implementation of all of it.
//
// So the assertion that matters is not that it renders: it is that it agrees
// with the page it sits on, to the exact number.
{
  // `cur(t)` returns the mons themselves, which the file already has as `team`.
  const mons = team;
  const me = mons[0];
  const name = Object.keys(M.DEX).find(n => M.DEX[n] && M.DEX[n].b && M.DEX[n].t.length);

  const om = M.calcDefender(name, 50, null);
  ok('a defender can be built from any species in the dex', !!om && om.b.length === 6,
    `${name} L${om && om.lvl}`);
  ok('...at any level', M.calcDefender(name, 87, null).lvl === 87);
  // Out-of-range levels are clamped rather than trusted: a level-0 defender
  // divides by zero further down the formula.
  ok('...with the level clamped, never trusted',
    M.calcDefender(name, 0, null).lvl === 1 && M.calcDefender(name, 999, null).lvl === 100);
  ok('...and an unknown species names nothing', M.calcDefender('Notamon', 50, null) === null);

  // THE NUMBER MUST BE THE PAGE'S NUMBER. If this ever diverges, the
  // calculator has grown maths of its own, which is the whole thing it exists
  // not to do.
  const mv = (me.moves || []).find(x => M.MOVES[x] && M.MOVES[x].c !== 'status'
    && M.MOVES[x].p > 1);
  if (mv) {
    const direct = M.calcDamage(me, mv, om);
    M.calc.atk = me.name; M.calc.def = name; M.calc.lvl = 50; M.calc.ab = '';
    const html = M.calcPanel(mons);
    // SCOPED TO THAT MOVE'S OWN ROW. A bare `includes` matched any row with
    // the same range -- four moves and a shared number is common -- so the
    // check passed against a calculator that had grown maths of its own.
    //
    // ...and scoped to the TABLE BODY, because splitting the whole panel on
    // `<tr` leaves the last chunk running past `</table>` into the footnote --
    // which says "Best is <b>Dragon Claw</b>" and so counts as a second row
    // for that move. It only showed once the lead's moves put a status move
    // last in the damage sort, which is a property of whichever team happens
    // to be first in the store.
    const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(html)?.[1] ?? '';
    const rows = tbody.split('<tr').filter((r) => r.includes(`>${mv}<`));
    ok('the move appears exactly once in the table', rows.length === 1,
      `${rows.length} rows for ${mv}`);
    // THE CELLS, not the row. hpBar() puts the same range in its own `title`,
    // so a row-wide `includes` passed against a damage column that had been
    // changed underneath it -- the mutation test is what showed that.
    const cells = rows.length === 1
      ? [...rows[0].matchAll(/<td class="num">([^<]*)<\/td>/g)].map((m2) => m2[1]) : [];
    ok('the damage column is the range calcDamage gives',
      cells[0] === `${direct.lo}\u2013${direct.hi}`,
      `${cells[0]} vs ${direct.lo}\u2013${direct.hi}`);
    ok('...and the percentage column matches too',
      cells[1] === `${direct.pctLo.toFixed(0)}\u2013${direct.pctHi.toFixed(0)}%`,
      `${cells[1]}`);
    ok('...and the same KO count', rows.length === 1 && rows[0].includes(direct.ko));
    ok('...and names both sides', html.includes(me.name) && html.includes(name));
    ok('...and states the defender assumption rather than hiding it',
      /31 IVs/.test(html) && /0 EVs/.test(html));
  } else {
    ok('the attacker has a damaging move to test with (skipped)', true);
  }

  // An ability on the DEFENDER has to reach the formula -- it is the whole
  // reason the field is there.
  const wg = M.calcDefender(name, 50, 'Wonder Guard');
  if (mv) {
    const plain = M.calcDamage(me, mv, om);
    const guarded = M.calcDamage(me, mv, wg);
    ok('the defender ability field actually reaches the maths',
      !guarded || guarded.e === 0 || guarded.e > 1,
      `plain x${plain && plain.e}, Wonder Guard x${guarded && guarded.e}`);
  }

  // ---- THE ABILITY LIST IS THE SPECIES', NOT THE GAME'S -------------------
  //
  // Naming a defender and then scrolling all 165 abilities to find one of its
  // two is a search through noise. DEX carries what the species can actually
  // have, out of this hack's own personal table -- which is also how Slowking
  // offers Drizzle, a Blaze Black change a vanilla-shaped list would bury.
  {
    const abilOf = (s) => {
      const i = s.indexOf('id="cAb"');
      return [...s.slice(i, s.indexOf('</select>', i))
        .matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
    };
    M.calc.def = 'Scolipede'; M.calc.ab = ''; M.calc.allAb = false;
    const nat = abilOf(M.calcPanel(mons));
    const dex = (M.DEX.Scolipede || {}).a || [];
    ok('the defender ability list is the species\' own', nat.length > 0
      && nat.length === dex.length && nat.every((a) => dex.includes(a)),
      nat.join(', '));
    ok('...and DEX actually carries them, from the ROM\'s personal table',
      dex.length >= 1 && dex.length <= 3, `${dex.length} for Scolipede`);
    // The hidden ability counts -- it is a legal thing to be facing.
    ok('...including the hidden one where a species has a third',
      Object.values(M.DEX).some((d) => (d.a || []).length === 3),
      `${Object.values(M.DEX).filter((d) => (d.a || []).length === 3).length} species with three`);
    // The full list is one click away, not gone: this page models rigged
    // Pokémon elsewhere and an illegal ability is a thing you might face.
    M.calc.allAb = true;
    ok('...with every ability still reachable', abilOf(M.calcPanel(mons)).length > 100,
      `${abilOf(M.calcPanel(mons)).length} when asked for all`);
    M.calc.allAb = false;
    // A choice that is not natural must survive the narrowing, or the field
    // resets under you the moment the list shrinks.
    M.calc.ab = 'Levitate';
    ok('...and a non-natural choice already made is kept and marked',
      abilOf(M.calcPanel(mons)).includes('Levitate')
      && /Levitate \(not natural\)/.test(M.calcPanel(mons)));
    M.calc.ab = ''; M.calc.def = '';
  }

  // With nothing named it must invite rather than show an empty table.
  M.calc.def = '';
  const empty = M.calcPanel(mons);
  ok('with no defender it says what it is for, not an empty table',
    !/<table/.test(empty) && /works out every move/.test(empty));
  M.calc.def = 'Notamon';
  ok('and a name that matches nothing says so',
    /No species called/.test(M.calcPanel(mons)));
  M.calc.def = '';
}


// ---------------------------------------------------------------------------
// THE TURN AS A MATRIX GAME
//
// Two things are being checked and they need very different tests.
//
// THE SOLVER is pure maths with a textbook answer, so it is checked against
// games whose solutions are known independently of this code -- rock-paper-
// scissors is (1/3,1/3,1/3) at value 0 whatever anybody's simplex says -- AND
// against the duality condition, which no wrong answer can satisfy by luck:
// the value must equal min_j (x·A[:,j]) and max_i (A[i,:]·y) simultaneously.
// A solver that returns a plausible-looking mix fails that instantly.
//
// THE BOARD is a modelling decision, so what is pinned is the decisions:
// priority beats speed, a speed tie goes to THEM, a knockout you land first
// costs you nothing, and every payoff stays inside [-1,+1] so the printed
// number means what the legend says it means.
// ---------------------------------------------------------------------------
{
  const dot = (p, v) => p.reduce((s, x, i) => s + x * v[i], 0);
  const col = (A, j) => A.map((r) => r[j]);
  const solved = (name, A, expect) => {
    const r = M.solveZeroSum(A);
    if (!r) { ok(`${name}: solves`, false, 'returned null'); return null; }
    const lo = Math.min(...A[0].map((_, j) => dot(r.x, col(A, j))));
    const hi = Math.max(...A.map((row) => dot(r.y, row)));
    const sx = r.x.reduce((a, b) => a + b, 0), sy = r.y.reduce((a, b) => a + b, 0);
    ok(`${name}: value is ${expect}`, Math.abs(r.value - expect) < 1e-6, `got ${r.value.toFixed(4)}`);
    // The one condition a wrong answer cannot fake.
    ok(`${name}: both strategies attain the value`,
      Math.abs(lo - r.value) < 1e-6 && Math.abs(hi - r.value) < 1e-6,
      `x guarantees ${lo.toFixed(4)}, y holds you to ${hi.toFixed(4)}`);
    ok(`${name}: both are probability distributions`,
      Math.abs(sx - 1) < 1e-6 && Math.abs(sy - 1) < 1e-6
      && r.x.every((v) => v >= -1e-9) && r.y.every((v) => v >= -1e-9),
      `sums ${sx.toFixed(4)} / ${sy.toFixed(4)}`);
    return r;
  };

  const rps = solved('rock-paper-scissors', [[0, -1, 1], [1, 0, -1], [-1, 1, 0]], 0);
  ok('rock-paper-scissors: the mix is uniform',
    !!rps && rps.x.every((p) => Math.abs(p - 1 / 3) < 1e-6),
    rps ? rps.x.map((p) => p.toFixed(3)).join(' ') : '');
  solved('matching pennies', [[1, -1], [-1, 1]], 0);
  const sad = solved('a game with a saddle point', [[3, 1], [2, 0]], 1);
  ok('a saddle point solves PURE, not mixed',
    !!sad && Math.max(...sad.x) > 0.999, sad ? sad.x.map((p) => p.toFixed(3)).join(' ') : '');
  solved('a dominated row', [[4, 4, 4], [1, 1, 1]], 4);
  solved('every payoff negative', [[-1, -2], [-3, -1]], -5 / 3);
  solved('one row only', [[0.4, -0.2, 0.9]], -0.2);
  solved('one column only', [[0.4], [-0.2]], 0.4);

  // gameRead's own reading of a board has to agree with the solver on the one
  // number they both produce. A saddle point is where they must coincide
  // exactly: the pure maximin IS the value.
  const read = (A) => M.gameRead({ rows: A.map(() => ({ kind: 'move', mv: 'x' })),
    cols: A[0].map((_, j) => `c${j}`), A });
  const rSad = read([[3, 1], [2, 0]]);
  ok('gameRead finds the saddle point', rSad.saddle && Math.abs(rSad.secure - 1) < 1e-9,
    `secure ${rSad.secure}, minimax ${rSad.minimax}`);
  ok('...and the solver agrees with it', Math.abs(rSad.sol.value - rSad.secure) < 1e-6);
  ok('...and names the row that achieves it', rSad.best === 0);
  // Every row that TIES for the best worst case is ringed, because the verdict
  // names them all and ringing one of three identical rows contradicts it.
  {
    const A = [[4, 4], [4, 4], [1, 1]];
    const r = read(A);
    const ringed = A.map((_, i) => Math.abs(r.mins[i] - r.secure) < 1e-9);
    ok('every row tying for the best worst case is marked',
      JSON.stringify(ringed) === '[true,true,false]', JSON.stringify(ringed));
  }
  const rMix = read([[0, -1, 1], [1, 0, -1], [-1, 1, 0]]);
  ok('gameRead reports no saddle where there is none', !rMix.saddle);
  ok('...and finds no dominant row either', rMix.dominant === -1);
  ok('a dominant row IS found when one exists', read([[4, 4, 4], [1, 1, 1]]).dominant === 0);
  // Three moves that all one-shot are all equally safe. Naming one of them
  // would read as a claim that the other two are worse.
  ok('...and ALL the rows that tie for it are collected',
    JSON.stringify(read([[4, 4], [4, 4], [1, 1]]).dom) === '[0,1]',
    JSON.stringify(read([[4, 4], [4, 4], [1, 1]]).dom));
  // Weak dominance counts: a row that ties everywhere and wins once still
  // means you never have to think about the alternative.
  ok('...including a row that only WEAKLY dominates',
    read([[2, 2, 3], [2, 2, 1]]).dominant === 0);
  ok('a row that wins in one column and loses in another dominates nothing',
    read([[3, 0], [0, 3]]).dominant === -1);
}

// ---- section order, and the shape of the threat grid ----------------------
{
  const src = html.slice(html.indexOf('<script>'));
  // WHAT YOU BRING, THEN WHAT YOU ARE FACING, THEN THE TURN. "Most useful in
  // this fight" answers a question the threat board raises, so it reads before
  // it; the turn planner is what you do once both are settled.
  const at = (s) => src.indexOf(`<h4 class="subhead">${s}`);
  const order = ['Your six', 'Most useful in this fight', 'Threat board',
    'Your move', 'Speed ladder', 'Their team in detail'];
  const found = order.map(at);
  ok('the battle tab reads in the order the fight does',
    found.every((i, k) => i > 0 && (k === 0 || i > found[k - 1])),
    order.filter((_, k) => found[k] < 0).join(' ') || order.join(' → '));
}

// ---- THE THREAT BOARD ----------------------------------------------------
//
// The most-used reference in the tab, and it used to compute a `worstIn`
// type multiplier against the whole team and then throw it away -- so a threat
// board said nothing about the threat, only about your answer. It is a DUEL
// now: what you bring, what it does back TO THAT POKEMON, and who moves first.
{
  const mons = M.cur(M.TEAMS[0]);
  const fight = M.OPPONENTS.find((e) => e.team.some((o) => (o.m || []).filter((mv) => M.MOVES[mv]).length));
  ok('a documented fight exists to build a threat board from', !!fight, fight && fight.leader);
  if (fight) {
    const board = M.threatBoard(mons, fight);
    // FOUR ON ONE ROW AND TWO ON THE NEXT is the worst split a team of six can
    // have, and it is what `auto-fill` gives you. The column count divides the
    // roster instead, so six reads 3+3 and four reads 2+2.
    {
      const bad = [];
      for (const f of M.OPPONENTS) {
        const c = /--tcols:(\d+)/.exec(M.threatBoard(mons, f));
        if (!c) { bad.push(`${f.leader}: no column count`); continue; }
        const n = f.team.length, cols = +c[1];
        if (cols < 1 || cols > 3) bad.push(`${f.leader}: ${cols} columns`);
        // A remainder is only allowed where no divisor above 1 exists.
        else if (n % cols !== 0 && n > 3 && [3, 2].some((k) => n % k === 0)) {
          bad.push(`${f.leader}: ${n} cards in ${cols} columns leaves ${n % cols}`);
        }
      }
      ok('no fight leaves an orphan row of threat cards',
        bad.length === 0, bad.slice(0, 3).join(' | ') || `${M.OPPONENTS.length} fights`);
      ok('...and a team of six reads three and three',
        (() => {
          const six = M.OPPONENTS.find((f) => f.team.length === 6);
          return !six || /--tcols:3/.test(M.threatBoard(mons, six));
        })());
    }
    ok('one card per Pokémon they have',
      (board.match(/class="tcard2/g) ?? []).length === fight.team.length,
      `${(board.match(/class="tcard2/g) ?? []).length} of ${fight.team.length}`);
    ok('...each naming what you bring AND what it answers with',
      (board.match(/you bring/g) ?? []).length === fight.team.length
      && (board.match(/it answers/g) ?? []).length >= 1);
    // The half that did not exist before. Without it this is a list of your
    // options wearing the word "threat".
    ok('...and the answer is priced in DAMAGE, not just a type multiplier',
      /it answers[\s\S]{0,400}?hpbar/.test(board));
    ok('...against the very Pokémon the card told you to bring',
      /it answers[\s\S]{0,300}?into /.test(board));
    // "speed ?" is what an unknown renders as, so accepting it makes the check
    // pass with turn order ripped out entirely. At least one card must state a
    // real direction.
    ok('...and states who moves first between those two',
      /tord/.test(board) && /(you move first|it moves first)/.test(board),
      (board.match(/(you move first|it moves first|speed \?)/g) ?? []).join(' · '));

    // COLOUR NEVER TRAVELS ALONE, and the words have to distinguish the two
    // very different bad outcomes: it kills you, versus you are simply slow.
    const src = html.slice(html.indexOf('<script>'));
    ok('every verdict ships with a word, not just a colour',
      ["it kills you first", "it can kill back", "slow to kill",
        "takes two turns", "OHKO, but second", "OHKO, and first"]
        .every((w) => src.includes(w)));

    // Worst first. The whole point of the ordering is that the card you have
    // to think about is the one you see -- so it has to be checked on a fight
    // that actually MIXES. Against an early gym this team sweeps, every card
    // reads `ok`, and any ordering passes.
    {
      const weight = { bad: 0, warn: 1, ok: 2 };
      const states = (e) => [...M.threatBoard(mons, e).matchAll(/class="tcard2 t-(\w+)"/g)]
        .map((m) => m[1]);
      let mixed = null;
      for (const e of M.OPPONENTS) {
        const s = states(e);
        if (new Set(s).size > 1) { mixed = [e.leader, s]; break; }
      }
      ok('a fight exists whose cards are not all the same verdict', !!mixed,
        mixed ? `${mixed[0]}: ${mixed[1].join(' ')}` : 'every fight is uniform — ordering untested');
      if (mixed) {
        ok('...and it is sorted worst first',
          mixed[1].every((s, i) => i === 0 || weight[mixed[1][i - 1]] <= weight[s]),
          mixed[1].join(' '));
      }
    }

    // A roster with no documented moves must say the number is a type read,
    // not invent one. Rivals and N are the real case.
    const bare = M.OPPONENTS.find((e) => e.team.every((o) => !(o.m || []).length));
    if (bare) {
      const b2 = M.threatBoard(mons, bare);
      ok('an undocumented roster falls back to the type read, and says so',
        /type read only/.test(b2) && !/hpbar[\s\S]{0,80}?it answers/.test(b2), bare.leader);
    }
  }
}

// ---- the board built from a REAL fight -----------------------------------
{
  const mons = M.cur(M.TEAMS[0]);
  const me = mons[0];
  // Gym leaders, the Elite Four and the champion all carry documented moves;
  // most route rivals do not. Find a fight that has them.
  const fight = M.OPPONENTS.find((e) => e.team.filter((o) => (o.m || []).length >= 2).length >= 2);
  ok('some fight documents its opponents\' moves', !!fight, fight && fight.leader);
  if (fight && me) {
    const o = fight.team.find((x) => (x.m || []).length >= 2);
    const rest = fight.team.filter((x) => x !== o);
    const others = mons.filter((m) => m.name !== me.name);
    const g = M.turnGame(me, o, others, rest, 1);
    ok('the board is built', !!g, g && `${g.rows.length} x ${g.cols.length}`);
    if (g) {
      ok('every one of your moves is a row, and every switch too',
        g.rows.filter((r) => r.kind === 'move').length
          === me.moves.filter((mv) => M.MOVES[mv]).length
        && g.rows.filter((r) => r.kind === 'switch').length === others.length);
      // THEIR SWITCHES ARE COLUMNS NOW. Without them the board could not
      // answer "who would they send in", and a switch of theirs would be
      // silently priced as if they had stood still.
      ok('their moves AND their switches are columns',
        g.cols.filter((c) => c.kind === 'move').length
          === o.m.filter((mv) => M.MOVES[mv]).length
        && g.cols.some((c) => c.kind === 'switch'),
        `${g.cols.filter((c) => c.kind === 'switch').length} switch column(s)`);
      // A teammate with no documented moves must be LEFT OUT rather than
      // treated as harmless -- including it would price a switch to it at zero
      // damage, which understates their threat.
      const bareMates = rest.filter((x) => !(x.m || []).filter((mv) => M.MOVES[mv]).length).length;
      ok('...and undocumented teammates are excluded, and counted',
        g.undocumented === bareMates
        && g.cols.filter((c) => c.kind === 'switch').length === rest.length - bareMates,
        `${bareMates} excluded`);
      // Every gym leader documents its whole team, so the assertion above is
      // vacuous on real data and a build that included moveless teammates
      // would sail past it. One is fabricated so the rule is actually tested:
      // a Pokemon whose moves we do not know must be LEFT OUT of their
      // switches, never priced at zero damage -- an error in the one direction
      // this board must never make.
      {
        const ghost = { ...o, n: o.n, m: [] };
        const gg = M.turnGame(me, o, others, rest.concat([ghost]), 1);
        ok('...even one the roster genuinely cannot describe',
          gg.undocumented === bareMates + 1
          && gg.cols.filter((c) => c.kind === 'switch').length
             === g.cols.filter((c) => c.kind === 'switch').length,
          `${gg.undocumented} excluded once a moveless teammate is added`);
      }

      const flat = g.A.flat();
      ok('the matrix is complete and finite',
        g.A.length === g.rows.length && g.A.every((r) => r.length === g.cols.length)
        && flat.every(Number.isFinite));
      // The unit is WHOLE POKEMON, so a cell cannot exceed the size of a team.
      ok('every payoff is inside one team either way',
        flat.every((v) => Math.abs(v) <= Math.max(g.myTeam.length, g.theirTeam.length) + 1),
        `min ${Math.min(...flat).toFixed(2)} max ${Math.max(...flat).toFixed(2)}`);
      // AT ONE TURN a switch still cannot gain MATERIAL -- it deals nothing.
      // What it may now gain is position, which is exactly the thing the
      // one-turn board could not see. So the old assertion ("never a gain")
      // was pinning the limitation; this pins the mechanism instead.
      const swRows = g.rows.map((r, i) => [r, i]).filter(([r]) => r.kind === 'switch');
      ok('at one turn, no switch beats the best attack',
        swRows.every(([, i]) => Math.max(...g.A[i]) <= Math.max(...g.A[0]) + 1e-9),
        `${swRows.length} switch row(s)`);
      // ...but it CAN be worth more than nothing, and that is the leaf's
      // positional term doing its job: a switch deals no material, so with
      // material alone every switch cell would be <= 0 and the horizon would
      // be back where it started. Swept, because it depends on the matchup.
      {
        let positive = null;
        sweep:
        for (const e2 of M.OPPONENTS) {
          for (const o2 of e2.team) {
            if (!(o2.m || []).filter((mv) => M.MOVES[mv]).length) continue;
            for (const m2 of mons) {
              const gg = M.turnGame(m2, o2, mons.filter((x) => x.name !== m2.name),
                e2.team.filter((x) => x !== o2), 1);
              if (!gg) continue;
              for (let i = 0; i < gg.rows.length; i++) {
                if (gg.rows[i].kind !== 'switch') continue;
                if (Math.max(...gg.A[i]) > 1e-6) {
                  positive = `${gg.rows[i].label} vs ${o2.n} scores `
                    + `+${(Math.max(...gg.A[i]) * 100).toFixed(0)}`;
                  break sweep;
                }
              }
            }
          }
        }
        ok('...yet a switch into a good matchup can still beat standing still',
          !!positive, positive || 'no switch scored above zero anywhere — the leaf is material only');
      }

      // ---- the format comes from the fight, and rotation is not doubles ----
      // 16 of 36 story fights are multi-Pokemon formats and the page used to
      // default every one of them to Singles. Rotation is the correction to
      // the correction: only one Pokemon per side is ever ON the field, so the
      // one-on-one board is exactly right and lumping it with doubles cost
      // four fights a usable board.
      // The rotation warning is a WARNING, not a label. It has to say the thing
      // that changes your decision -- they rotate for free -- rather than just
      // naming the format, which the toggle row already does.
      {
        const rot = M.OPPONENTS.find((x) => M.isRotation(x) && x.team.length);
        if (rot) {
          const idx = M.OPPONENTS.indexOf(rot);
          const panel = M.encounterPanel(mons, M.TEAMS[0], idx);
          // BOTH the warning surface and the words in it. Checking only for
          // the class let a mutant that cut the text to "Rotation." pass --
          // which is precisely the bare label this replaced.
          ok('a rotation battle warns, not just labels',
            /rotnote/.test(panel) && /This is a Rotation Battle/i.test(panel),
            rot.leader);
          ok('...and says the thing that changes your lead',
            /no turn at all|costs? them\s*<b>no turn/i.test(panel),
            'rotating is free and switching is not — that is the whole trap');
          ok('...while still saying the board itself is right',
            /exactly right/i.test(panel));
        }
      }
      // ---- THEIR ABILITY IS A DAMAGE NUMBER, NOT A LABEL --------------------
      // N 4's six Rotom are all Levitate and all arrived with an empty ability,
      // so the board offered Earthquake at ~50% against a Pokemon that cannot be
      // hit by it at all. oppMon feeds `a` to eff(); blank means no ability.
      {
        const withAb = M.OPPONENTS.flatMap((f) => f.team).filter((o) => o.a);
        ok('opponents carry abilities at all', withAb.length > 100, `${withAb.length}`);
        const lev = M.OPPONENTS.flatMap((f) => f.team)
          .filter((o) => (M.DEX[o.n] || {}).t && !o.forme
            && ['Levitate'].includes(o.a));
        if (lev.length) {
          const bad = lev.filter((o) => M.eff('ground', M.oppMon(o)) !== 0);
          ok('a Levitate opponent is ground-immune in the maths', bad.length === 0,
            bad.length ? `${bad[0].n} reads x${M.eff('ground', M.oppMon(bad[0]))}` : `${lev.length} checked`);
        }
        // The species whose slots are identical cannot be ambiguous, and Rotom
        // is the case that cost a real fight its board.
        const rot = M.OPPONENTS.flatMap((f) => f.team).filter((o) => o.n === 'Rotom');
        if (rot.length) {
          ok('every Rotom on the page knows it has Levitate',
            rot.every((o) => o.a === 'Levitate'), rot.map((o) => o.a || '(blank)').join(','));
          ok('...so ground does nothing to it',
            rot.every((o) => M.eff('ground', M.oppMon(o)) === 0));
        }
        // An ability field holding an ITEM name is worse than a blank one: it
        // silently means "no ability" to eff(). Five doc rows did exactly that.
        const suspect = M.OPPONENTS.flatMap((f) => f.team)
          .filter((o) => /Berry$|Gem$|Balloon$|Orb$|Herb$|Sash$|Scarf$|Band$/.test(o.a || ''));
        ok('no opponent has an ITEM in its ability field', suspect.length === 0,
          suspect.length ? `${suspect[0].n}: ${suspect[0].a}` : 'the doc wraps its Full/Clean rows');
      }

      // ---- a repeated species is SIX Pokemon, not one ----------------------
      // Their side was keyed by species name everywhere, so N 4's six Rotom
      // were six buttons all reading data-fe="Rotom", a fielded list that could
      // hold "Rotom" once, and every lookup resolving to team[0]. Five of six
      // unreachable -- and they are formes with different movesets, so the
      // second one has to give you the second one's moves.
      {
        const dup = M.OPPONENTS.find((f) => {
          const n = f.team.map((o) => o.n);
          return new Set(n).size < n.length;
        });
        if (dup) {
          const keys = dup.team.map((o, i) => M.eKey(o, i));
          ok('a roster that repeats a species gives each slot its own key',
            new Set(keys).size === keys.length, `${keys.length} slots, ${new Set(keys).size} keys`);
          const labels = dup.team.map((o, i) => M.eLabel(dup.team, o, i));
          ok('...and each is labelled distinguishably',
            new Set(labels).size === labels.length, labels.join(' / '));
          // The point of all of it: the key must reach the RIGHT record.
          const distinct = dup.team.filter((o, i) => {
            const got = M.eFind(dup.team, M.eKey(o, i));
            return got === o;
          });
          ok('...and a key resolves to that exact slot, not the first match',
            distinct.length === dup.team.length,
            `${distinct.length}/${dup.team.length}`);
          const movesets = new Set(dup.team.map((o) => (o.m || []).join(',')));
          ok('...which matters because their movesets differ',
            movesets.size > 1, `${movesets.size} distinct movesets`);
          // A fielded list saved before keys existed must still work.
          ok('...while a bare species name still resolves, for an older saved state',
            M.eFind(dup.team, dup.team[0].n) === dup.team[0]);
        }
      }

      // ---- the calculator must not default a defender to "no ability" -------
      // Pick Rotom, leave the ability alone, and Earthquake read a confident
      // ~50% against a Pokemon with no legal ability that Ground can touch.
      {
        const one = M.calcDefender('Rotom', 50, '');
        ok('an unambiguous species gets its ability by default',
          one && one.ab === 'Levitate', one ? String(one.ab) : 'no DEX entry');
        ok('...so the calculator agrees with the battle board',
          one && M.eff('ground', one) === 0);
        const two = M.calcDefender('Slowking', 50, '');
        ok('...but a two-ability species is still left to you',
          two && two.ab === null, two ? String(two.ab) : '-');
      }

      // ---- and the board admits the forme typing it does not model ---------
      {
        const f4 = M.OPPONENTS.find((x) => x.team.some((o) => o.forme));
        if (f4) {
          const o = f4.team.find((x) => x.forme);
          const me = mons[0];
          const panel = M.gamePanel(me, o, mons, f4.team.filter((x) => x !== o));
          ok('a forme\'d opponent says its typing is not modelled',
            /alternate\s+forme/i.test(panel), `${o.n} forme ${o.forme}`);
          ok('...and says the moves and ability ARE real',
            /real ones/i.test(panel) && /immunity/i.test(panel),
            'half a caveat reads as "ignore this board"');
        }
      }

      ok('a double battle opens as doubles', M.fmtOf({ type: 'Double Battle' }) === 'doubles');
      ok('...a triple battle too', M.fmtOf({ type: 'Triple Battle' }) === 'doubles');
      ok('...but a rotation battle is singles',
        M.fmtOf({ type: 'Rotation Battle' }) === 'singles', 'one active per side');
      ok('...and is flagged so it can say why', M.isRotation({ type: 'Rotation Battle' }) === true);
      // The compound strings name the fight you walk into FIRST.
      ok('a compound type reads the fight you are in, not the rematch',
        M.fmtOf({ type: 'Double Battle (Initial) / Single Battle (Rematch)' }) === 'doubles'
        && M.fmtOf({ type: 'Rotation Battle (First Fight) / Triple Battle (Rematch)' }) === 'singles');
      ok('...and an undocumented type falls back to singles',
        M.fmtOf({}) === 'singles' && M.fmtOf({ type: '' }) === 'singles');

      // ---- doubles renders one board per pairing --------------------------
      const dbl = M.OPPONENTS.find((x) => /double/i.test(x.type || '') && x.team.length >= 2);
      if (dbl && mons.length >= 2) {
        const before = M.gDepth;
        const made = M.pairBoards(mons.slice(0, 2), dbl,
          mons.slice(0, 2).map((m) => m.name), dbl.team.slice(0, 2).map((x) => x.n));
        // A PICKER ABOVE THE BOARD, not folds below it. Four <details> meant
        // three matchups sat under a full grid, off screen, present but
        // unfindable -- so the count that matters is buttons, and where they
        // are relative to the board.
        const btns = (made.match(/class="pairbtn/g) || []).length;
        const boards = (made.match(/class="pairgame"/g) || []).length;
        ok('doubles offers one button per pairing', btns === 4, `${btns} buttons`);
        ok('...and renders exactly one board at a time', boards === 1, `${boards} boards`);
        ok('...with exactly one pairing selected',
          (made.match(/class="pairbtn on"/g) || []).length === 1);
        // The whole point of the change: reachable without scrolling past a grid.
        ok('...and the picker comes BEFORE the board it drives',
          made.indexOf('pairbtn') < made.indexOf('class="pairgame"'),
          'a choice below a solved grid is a choice nobody finds');
        ok('...laid out to mirror the fight, not wrapped arbitrarily',
          /--pcols:2/.test(made), 'two of theirs fielded means two columns');
        ok('...one depth control above them, not four',
          (made.match(/data-gd="1"/g) || []).length <= 1);
        ok('...and it names what the decomposition drops',
          /redirection/i.test(made) && /spread/i.test(made) && /not a doubles solver/i.test(made),
          'a simplification that does not say what it simplifies is a lie');
        ok('...without claiming to solve the turn', !/value of the turn is/i.test(made));
        M.gDepth = before;
      }

      const panel = M.gamePanel(me, o, mons, rest);
      ok('the panel renders', /gtab/.test(panel) && /gverdict/.test(panel));
      ok('...and a board can omit the hoisted depth control',
        !/data-gd="1"/.test(M.gamePanel(me, o, mons, rest, false)),
        'the doubles view renders one picker above four boards');
      ok('...and offers the depth control', /data-gd="1"/.test(panel) && /data-gd="2"/.test(panel));
      // Three turns was offered and withdrawn: the search handles it, but three
      // turns of equilibrium play is a much stronger claim than two and the
      // numbers stop reading as Pokemon you can picture. The control must not
      // offer a depth whose answer nobody can interpret.
      ok('...and does not offer a third turn', !/data-gd="3"/.test(panel));
      ok('...and states its assumptions rather than hiding them',
        /average roll/.test(panel) && /speed tie/i.test(panel) && /accuracy/i.test(panel));
      ok('...and says stat stages ARE modelled, now that they are',
        /Stat stages are modelled/.test(panel) && /Dragon Dance/.test(panel)
        && /Draco Meteor/.test(panel));
      ok('...and still names what is left out',
        /Not modelled:<\/b> status conditions/.test(panel));
      ok('...and answers the nuzlocke question separately from the payoff',
        /gsurv/.test(panel) && /takes you out|Nothing they have/.test(panel));
      ok('...and names what they would answer with',
        /Their best answer to it is/.test(panel));
      ok('...and carries a visible colour key, not just tooltips',
        /gscale/.test(panel) && /you lose one/.test(panel) && /you take one/.test(panel));
      {
        const rows = [...panel.matchAll(/<div class="gscale[^"]*">([\s\S]*?)<\/div>/g)]
          .map((m) => (m[1].match(/<span/g) ?? []).length);
        ok('...whose two rows have one cell each, in the same grid',
          rows.length === 2 && rows[0] === 5 && rows[1] === 5, rows.join(' vs '));
      }
      // The board is wide enough to scroll once their switches are columns, and
      // the first thing off the right edge is the column the reading guide
      // points at. Both anchors have to stay put.
      ok('...with the row labels and the `worst` column pinned against the scroll',
        (() => {
          const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
          return /\.gtab th\[scope="row"\][^{]*\{[^}]*position:sticky/.test(css)
            && /\.gtab \.gmin\{position:sticky/.test(css);
        })());
      ok('...and says how to read the grid, in both directions',
        /Reading it/.test(panel) && /across<\/b> a row/.test(panel)
        && /<b>worst<\/b> column/.test(panel));
      ok('...with the framing and the caveats folded away',
        /<details class="gwhy">/.test(panel) && /simultaneous/.test(panel));
      ok('...and its footnotes are not wearing the kicker class',
        !/class="gnote lbl"/.test(panel));
    }
  }
  // A fight whose moves are not documented must SAY SO. Inventing a board from
  // an empty move list would be the worst failure this feature could have.
  const bare = M.OPPONENTS.flatMap((e) => e.team).find((o) => !(o.m || []).length);
  if (bare && me) {
    ok('no moves documented means no board, and it says why',
      M.turnGame(me, bare, [], [], 1) === null
      && /does not\s+document/.test(M.gamePanel(me, bare, mons, [])), bare.n);
  }

  // BOTH VERDICTS HAVE TO RENDER. The dominant case is the common one; a board
  // with no safe move takes a different branch and builds a mix from the
  // solver.
  {
    // AT THE DEPTH THE PANEL ACTUALLY DRAWS AT. Searching for a mixed case at
    // depth 1 and then rendering at the panel's default found a board that had
    // a safe move by the time it was drawn, and the assertion failed on a
    // difference of depth rather than of behaviour.
    const D = M.gDepth;
    let mixed = null;
    outer:
    for (const e of M.OPPONENTS) {
      for (const o of e.team) {
        if (!(o.m || []).length) continue;
        const rest = e.team.filter((x) => x !== o);
        for (const m of mons) {
          const g = M.turnGame(m, o, mons.filter((x) => x.name !== m.name), rest, D);
          if (!g) continue;
          const r = M.gameRead(g);
          if (r.dominant < 0 && !r.saddle) { mixed = [m, o, rest]; break outer; }
        }
      }
    }
    ok('a fight with no safe move exists to test the other branch', !!mixed,
      mixed ? `${mixed[0].name} into ${mixed[1].n}` : 'none found in any fight');
    if (mixed) {
      const p = M.gamePanel(mixed[0], mixed[1], mons, mixed[2]);
      ok('...and it renders the mix rather than naming a move',
        /No safe move/.test(p) && /equilibrium is a mix/.test(p) && /%/.test(p));
      ok('...with the mix summing to one hundred percent',
        (() => {
          const g = M.turnGame(mixed[0], mixed[1],
            mons.filter((m) => m.name !== mixed[0].name), mixed[2], D);
          const s = M.gameRead(g).sol;
          return s && Math.abs(s.x.reduce((a, b) => a + b, 0) - 1) < 1e-6;
        })());
    }
  }
}

// ---- what the planner remembers ------------------------------------------
//
// The fight was remembered across a reload and so was the look-ahead, but the
// PAIRING was not -- so every reload emptied the one thing you have to click
// twice to set, and the board you were reading went with it.
{
  const src = html.slice(html.indexOf('<script>'));
  ok('the planner saves who is on the field, by name',
    /fe:fieldE,fm:fieldM/.test(src.replace(/\s/g, '')),
    'stored in bb_enc beside the fight and the filter');
  ok('...and restores both sides',
    /Array\.isArray\(st\.fe\)/.test(src) && /Array\.isArray\(st\.fm\)/.test(src));
  // Names, not positions -- the same rule the fight key already follows,
  // because rosters differ by cartridge and by starter.
  ok('...as names rather than positions',
    /st\.fe\.filter\(x=>\s*typeof x==='string'\)/.test(src));
  // Changing fight still clears their side: a lead from another roster is not
  // a lead here.
  ok('...but changing the fight still clears their side',
    (src.match(/fieldE=\[\];\s*saveEnc\(\)/g) ?? []).length >= 3,
    'the selector, the prev/next stepper and the index cards');
}

// ---- DEPTH: the whole point of the search --------------------------------
//
// The one-turn board could not price a switch, and that was not a bug, it was
// the horizon. These assert that looking further actually changes the answer
// in the direction the recursion was built for -- and that it terminates.
{
  const mons = M.cur(M.TEAMS[0]);
  const fight = M.OPPONENTS.find((e) => e.team.filter((o) => (o.m || []).length >= 2).length >= 3);
  if (fight && mons.length >= 3) {
    const o = fight.team.find((x) => (x.m || []).length >= 2);
    const rest = fight.team.filter((x) => x !== o);
    const me = mons[0];
    const others = mons.filter((m) => m.name !== me.name);
    const at = (d) => M.turnGame(me, o, others, rest, d);
    const g1 = at(1), g2 = at(2);
    ok('the board is the same SHAPE at any depth',
      g1 && g2 && g1.rows.length === g2.rows.length && g1.cols.length === g2.cols.length,
      g1 && g2 ? `${g2.rows.length}x${g2.cols.length}` : '');
    ok('...and depth is recorded on it', g1.depth === 1 && g2.depth === 2);
    // Looking further has to CHANGE something, or the control is a lie.
    ok('looking two turns ahead changes the board',
      JSON.stringify(g1.A) !== JSON.stringify(g2.A));
    // ...and so does a THIRD. Without this, a recursion that quietly evaluated
    // its children at the leaf instead of recursing would still pass every
    // check above -- it degrades depth 3 to depth 2 and nothing else notices.
    ok('...and a third turn changes it again',
      JSON.stringify(at(3).A) !== JSON.stringify(g2.A));

    // THE HEADLINE PROPERTY. Over one turn a switch is pure cost. Over two, a
    // switch into something that walls them can come out ahead of standing
    // still and taking the hit -- which is the reason the recursion exists.
    const sw = (g) => g.rows.map((r, i) => [r, i]).filter(([r]) => r.kind === 'switch')
      .map(([, i]) => Math.max(...g.A[i]));
    const best1 = Math.max(...sw(g1)), best2 = Math.max(...sw(g2));
    ok('a switch scores better with a turn of foresight than without',
      best2 > best1 + 1e-9, `best switch ${best1.toFixed(3)} -> ${best2.toFixed(3)}`);

    // ...and it must actually terminate, on a real 6v6, well inside budget.
    const t0 = Date.now();
    const g3 = at(3);
    const ms = Date.now() - t0;
    ok('depth 3 finishes on a real fight', !!g3 && g3.A.flat().every(Number.isFinite),
      `${ms} ms, ${g3 ? g3.nodes.toLocaleString() : '?'} nodes${g3 && g3.capped ? ' (BUDGET HIT)' : ''}`);
    ok('...within the node budget, so nothing was estimated away',
      !!g3 && !g3.capped);
    ok('...and quickly enough to sit behind a button', ms < 4000, `${ms} ms`);
    // Depth 4 spends the budget and degrades. The control offers 1-3, so the
    // function must agree rather than accepting a number it cannot honour.
    ok('...and a deeper request is clamped to what the control offers',
      at(4).depth === 3 && at(9).depth === 3);
  }

  // DOES IT EVER CHANGE THE ANSWER? A depth control that always recommends the
  // same move is a slower way to be told the same thing. Swept across every
  // documented fight rather than asserted on one, because the interesting case
  // is exactly the one you would not have picked by hand.
  {
    let flips = 0, tried = 0;
    const flipped = [];
    for (const e of M.OPPONENTS) {
      const doc = e.team.filter((o) => (o.m || []).filter(Boolean).length >= 2);
      if (doc.length < 2) continue;
      for (const o of doc.slice(0, 3)) {
        const rest = e.team.filter((x) => x !== o);
        for (const me of mons.slice(0, 3)) {
          const others = mons.filter((m) => m.name !== me.name);
          const g1 = M.turnGame(me, o, others, rest, 1);
          const g2 = M.turnGame(me, o, others, rest, 2);
          if (!g1 || !g2) continue;
          tried++;
          const a = g1.rows[M.gameRead(g1).best].label;
          const b = g2.rows[M.gameRead(g2).best].label;
          if (a !== b) { flips++; if (flipped.length < 2) flipped.push(`${a} -> ${b}`); }
        }
      }
    }
    ok('one turn of foresight changes the recommendation somewhere',
      flips > 0 && tried > 50, `${flips} of ${tried} matchups · e.g. ${flipped.join(' · ')}`);
    // ...but not everywhere, or the two depths disagree about everything and
    // one of them is simply wrong.
    ok('...and leaves most of them alone', flips < tried / 2, `${flips}/${tried}`);
  }
}

// ---- STAT STAGES ---------------------------------------------------------
//
// The gap depth made WORSE. Looking further is exactly what should reveal what
// a Dragon Dance buys, and while stages went unmodelled a setup move was
// scored on the damage it does this turn -- none -- at every depth. It also
// made Draco Meteor's -2 Sp. Atk and Close Combat's defence drop free, which
// flatters precisely the moves the search likes most.
//
// TESTED AT THE MECHANISM, NOT THROUGH THE BOARD. The first version of this
// asserted that a setup move scores higher at depth 2 than at depth 1 -- which
// it does, and would do with stages ripped out entirely, because depth 2 hands
// you a second turn in which to attack. It passed against all five mutants.
// What follows drives stepTurn and leaf directly, where the answer cannot come
// from somewhere else.
{
  const mons = M.cur(M.TEAMS[0]);
  const fight = M.OPPONENTS.find((e) => e.team.some((o) => (o.m || []).filter((mv) => M.MOVES[mv]).length));
  const foe = fight && fight.team.find((o) => (o.m || []).filter((mv) => M.MOVES[mv]).length);
  const boostMon = mons.find((m) => (m.moves || []).some((mv) => {
    const d = M.MOVES[mv];
    return d && d.c === 'status' && d.tg === 'self' && d.st
      && Object.values(d.st).some((v) => v > 0);
  }));
  ok('the team carries a self-boosting move to test with', !!boostMon && !!foe,
    boostMon ? boostMon.name : 'none');

  if (boostMon && foe) {
    const partner = mons.find((m) => m.name !== boostMon.name);
    const sim = M.buildSim([boostMon, partner], [foe]);
    const usable = (boostMon.moves || []).filter((mv) => M.MOVES[mv]);
    const bi = usable.findIndex((mv) => {
      const d = M.MOVES[mv];
      return d && d.c === 'status' && d.tg === 'self' && d.st
        && Object.values(d.st).some((v) => v > 0);
    });
    const boostMv = usable[bi];
    const raised = Object.keys(M.MOVES[boostMv].st).find((k) => M.MOVES[boostMv].st[k] > 0);
    const S0 = { mi: 0, ti: 0, mh: [1, 1], th: [1], ms: M.STAGE0, ts: M.STAGE0 };
    const theirs = { kind: 'move', mv: sim.mvT[0][0], k: 0, pri: sim.priT[0][0] };

    // 1. The stage is actually set, and by the amount the move says.
    const after = M.stepTurn(sim, S0, { kind: 'move', mv: boostMv, k: bi, pri: 0 }, theirs);
    ok('using a self-boosting move leaves the stage on the board',
      after.ms[raised] === M.MOVES[boostMv].st[raised],
      `${boostMon.name} ${boostMv}: ${raised} ${after.ms[raised]}`);

    // 2. It is lost on the way out, which is the real rule and also what keeps
    //    the state space from compounding.
    const out = M.stepTurn(sim, after, { kind: 'switch', i: 1 }, theirs);
    ok('...and lost the moment it switches out', out.ms[raised] === 0);

    // 3. The horizon can SEE it. Without this the search values a boost at
    //    nothing however deep it looks.
    const boosted = { ...S0, ms: { ...M.STAGE0, [raised]: 2 } };
    ok('a boosted position evaluates higher than a neutral one',
      M.leaf(sim, boosted) > M.leaf(sim, S0) + 1e-9,
      `${M.leaf(sim, S0).toFixed(3)} -> ${M.leaf(sim, boosted).toFixed(3)}`);

    // 4. And it reaches the damage itself, not only the heuristic.
    //    THE TARGET HAS TO SURVIVE THE NEUTRAL HIT or there is nothing to
    //    measure: the first version picked the fight's lead, which this team
    //    one-shots either way, so both sides of the comparison read 0% left.
    {
      let cmp = null;
      sweepDmg:
      for (const e2 of M.OPPONENTS) {
        for (const o2 of e2.team) {
          if (!(o2.m || []).filter((mv) => M.MOVES[mv]).length) continue;
          const s3 = M.buildSim([boostMon, partner], [o2]);
          const k = s3.mvM[0].findIndex((mv, idx) => s3.out[0][0][idx] > 0.03
            && s3.out[0][0][idx] < 0.45
            && (M.MOVES[mv].c === 'physical' ? 'atk' : 'spa') === raised);
          if (k < 0) continue;
          const act = { kind: 'move', mv: s3.mvM[0][k], k, pri: s3.priM[0][k] };
          const th2 = { kind: 'move', mv: s3.mvT[0][0], k: 0, pri: s3.priT[0][0] };
          const base = { mi: 0, ti: 0, mh: [1, 1], th: [1], ms: M.STAGE0, ts: M.STAGE0 };
          const plain = M.stepTurn(s3, base, act, th2);
          const buffed = M.stepTurn(s3, { ...base, ms: { ...M.STAGE0, [raised]: 2 } }, act, th2);
          cmp = [o2.n, act.mv, plain.th[0], buffed.th[0]];
          break sweepDmg;
        }
      }
      ok('...and a boosted attack actually takes more HP off',
        !!cmp && cmp[3] < cmp[2] - 1e-9,
        cmp ? `${cmp[1]} into ${cmp[0]}: ${(cmp[2] * 100).toFixed(0)}% left vs `
          + `${(cmp[3] * 100).toFixed(0)}%` : 'no survivable target found');
    }

    // 5. Speed stages decide who moves first. This has to be measured as a
    //    STRICT difference, and the only way one turn's HP differs on order
    //    alone is a knockout: move first and land it, and they never act.
    //    Comparing "no worse than" passed with speed stages ripped out, since
    //    ignoring them makes both sides identical.
    {
      // The slab's Speed is set FROM the opponent's: slower than them at +0, and
      // comfortably faster once a +6 stage multiplies it by four. A fixed
      // Speed of 1 is slower even at +6, which is how this first passed
      // against a mutant that ignored speed stages entirely.
      const mkSlab = (spe) => ({ name: 'Slab', lvl: 100, types: ['normal'], ab: '',
        item: null, moves: ['Giga Impact'], stats: [300, 400, 200, 200, 200, spe] });
      let res = null;
      sweepSpe:
      for (const e2 of M.OPPONENTS) {
        for (const o2 of e2.team) {
          if (!(o2.m || []).filter((mv) => M.MOVES[mv]).length) continue;
          const es = M.enemySpe(o2);
          if (!es || es < 4) continue;
          const slab = mkSlab(Math.floor(es * 0.6));         // slower now, faster at +6
          const s2 = M.buildSim([slab, partner], [o2]);
          if (!(s2.out[0][0][0] >= 1)) continue;             // the slab must one-shot
          if (!(s2.inc[0][0][0] > 0.01)) continue;           // and they must be able to hurt it
          const act = { kind: 'move', mv: 'Giga Impact', k: 0, pri: s2.priM[0][0] };
          const th2 = { kind: 'move', mv: s2.mvT[0][0], k: 0, pri: s2.priT[0][0] };
          const base = { mi: 0, ti: 0, mh: [1, 1], th: [1], ms: M.STAGE0, ts: M.STAGE0 };
          const slow = M.stepTurn(s2, base, act, th2);
          const fast = M.stepTurn(s2, { ...base, ms: { ...M.STAGE0, spe: 6 } }, act, th2);
          res = [o2.n, slow.mh[0], fast.mh[0]];
          break sweepSpe;
        }
      }
      ok('speed stages decide who moves first',
        !!res && res[2] > res[1] + 1e-9,
        res ? `vs ${res[0]}: at +0 you end on ${(res[1] * 100).toFixed(0)}% HP, `
          + `at +6 on ${(res[2] * 100).toFixed(0)}%` : 'no pairing found to test with');
    }

    // 6. The arithmetic itself, so a wrong multiplier cannot hide behind a
    //    board that happens to agree.
    ok('a stage of +2 doubles the attacking stat',
      Math.abs(M.dmgMul({ ...M.STAGE0, atk: 2 }, M.STAGE0, true) - 2) < 1e-9);
    ok('...and a defensive stage divides instead of multiplying',
      Math.abs(M.dmgMul(M.STAGE0, { ...M.STAGE0, def: 2 }, true) - 0.5) < 1e-9);
    ok('stages clamp at six, in both directions',
      M.applyStages({ ...M.STAGE0, atk: 5 }, { atk: 3 }).atk === 6
      && M.applyStages({ ...M.STAGE0, spa: -5 }, { spa: -3 }).spa === -6);
    ok('a self-lowering attack lowers the stat it names',
      (() => {
        const dm = M.MOVES['Draco Meteor'];
        return dm && dm.st && dm.st.spa < 0
          && M.applyStages(M.STAGE0, dm.st).spa === dm.st.spa;
      })(), 'Draco Meteor -2 Sp. Atk');
  }
}

// ---- the modelling decisions, pinned -------------------------------------
{
  // Synthetic sides, so turn order is the only thing under test. Stats are the
  // save's own layout: hp, atk, def, spa, spd, spe.
  const fast = { name: 'F', lvl: 50, types: ['normal'], ab: '', moves: ['Tackle'],
    stats: [200, 120, 100, 100, 100, 300] };
  const slow = { ...fast, name: 'S', stats: [200, 120, 100, 100, 100, 10] };
  const foe = M.OPPONENTS.flatMap((e) => e.team).find((o) => (o.m || []).some((mv) => M.MOVES[mv]
    && M.MOVES[mv].c !== 'status' && !M.MOVES[mv].pri));
  if (foe) {
    const mv = foe.m.find((x) => M.MOVES[x] && !M.MOVES[x].pri && M.MOVES[x].c !== 'status');
    const one = (me) => M.turnGame(me, { ...foe, m: [mv] }, []);
    const gF = one(fast), gS = one(slow);
    ok('being faster is worth more than being slower, all else equal',
      !!gF && !!gS && gF.A[0][0] >= gS.A[0][0],
      gF && gS ? `${gF.A[0][0].toFixed(3)} vs ${gS.A[0][0].toFixed(3)}` : '');
    // A SPEED TIE GOES TO THEM. Pessimism is the point: this board's job is to
    // report a worst case, and a coin flip resolved your way is not one.
    const tie = { ...fast, name: 'T', stats: [200, 120, 100, 100, 100, M.enemySpe(foe)] };
    const gT = one(tie);
    ok('a speed tie is resolved against you', !!gT && !!gS
      && Math.abs(gT.A[0][0] - gS.A[0][0]) < 1e-9,
      'the tie must score like moving second, not like moving first');
  }

  // A FAINTED ATTACKER DOES NOT ATTACK, and the clean way to test it is that
  // the outcome must not depend on a move that never happens: if you move
  // first and knock it out, every one of their MOVE columns has to score
  // identically, because none of them ever lands.
  //
  // CONSTRUCTED, not searched for. No Pokemon in the real save is both faster
  // than its opponent and able to one-shot it in the fights that document
  // moves, so an opportunistic search finds nothing and the check passes by
  // being vacuous. A level-100 slab with 400 Speed and Giga Impact against an
  // early gym is decisive, and the last clause is what makes it test anything:
  // their moves must be able to hurt it, and must not get the chance.
  {
    const slab = { name: 'Slab', lvl: 100, types: ['normal'], ab: '', item: null,
      moves: ['Giga Impact'], stats: [300, 400, 200, 200, 200, 400] };
    const early = M.OPPONENTS.find((e) => e.kind === 'gym'
      && e.team.some((o) => (o.m || []).filter((mv) => M.MOVES[mv]).length >= 2));
    const foe = early && early.team.find((o) => (o.m || []).filter((mv) => M.MOVES[mv]).length >= 2);
    const g = foe && M.turnGame(slab, foe, [], [], 1);
    if (g) {
      const cols = g.cols.map((c, j) => [c, j]).filter(([c]) => c.kind === 'move');
      const vals = cols.map(([, j]) => g.A[0][j]);
      const spread = Math.max(...vals) - Math.min(...vals);
      const couldHurt = cols.filter(([c]) => {
        const d = M.calcIncoming(foe, c.mv, slab);
        return d && d.pctHi > 0;
      }).length;
      ok('a knockout you land first is unaffected by what they picked',
        spread < 1e-9 && vals[0] > 0.5 && couldHurt > 0,
        `${foe.n}: spread ${spread.toFixed(4)} across ${vals.length} moves, `
        + `${couldHurt} of which could have hurt it`);
    } else {
      ok('a knockout you land first is unaffected by what they picked', false,
        'could not build the constructed case');
    }
  }

  // Damage the other way round is a new calculation and has to behave like the
  // one that already existed.
  const mons = M.cur(M.TEAMS[0]);
  const anyFoe = M.OPPONENTS.flatMap((e) => e.team).find((o) => (o.m || [])
    .some((mv) => M.MOVES[mv] && M.MOVES[mv].c !== 'status' && M.MOVES[mv].p > 1));
  if (anyFoe && mons[0]) {
    const mv = anyFoe.m.find((x) => M.MOVES[x] && M.MOVES[x].c !== 'status' && M.MOVES[x].p > 1);
    const d = M.calcIncoming(anyFoe, mv, mons[0]);
    ok('incoming damage is computed against YOUR real HP, not an estimate',
      !!d && d.hp === mons[0].stats[0], d ? `${d.hp} vs ${mons[0].stats[0]}` : '');
    ok('...with the low roll below the high one, both at least 1',
      !!d && (d.e === 0 || (d.lo >= 1 && d.lo <= d.hi)));
    ok('a status move deals no damage in either direction',
      M.calcIncoming(anyFoe, 'Growl', mons[0]) === null);
  }
}

console.log(failed ? `\n  ${failed} check(s) FAILED — do not publish` : "\n  all checks passed");
process.exit(failed ? 1 : 0);
