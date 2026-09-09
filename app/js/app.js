/**
 * app.js -- the companion shell.
 *
 * Owns the design tokens, the tab bar, and the loaded save. Nothing else.
 * Every tool is a module under tabs/ that gets handed a decoded save and
 * renders into #shell-panel.
 *
 * =========================================================================
 * WHERE THE SAVE COMES FROM
 * =========================================================================
 * Two routes, and the app never prefers one silently:
 *
 *   /api/save   ./serve reads the path in companion.config.json. This is the
 *               one that makes the daily loop bearable -- save in game, click
 *               Reload, done. The server refuses a file written less than 2s
 *               ago, because the emulator flushes the .sav shortly after an
 *               in-game save and a read taken too soon catches a half-write.
 *
 *   drag/drop   Works with no server config at all, and is the route anyone
 *               else's copy will use first.
 *
 * Either way the bytes are decoded in this tab and go nowhere.
 *
 * =========================================================================
 * TABS MOUNT AND UNMOUNT, THEY DO NOT HIDE
 * =========================================================================
 * Only the active tab's markup is in the DOM. That is deliberate: the battle
 * companion's script uses document-wide `querySelectorAll('.opt')` and
 * friends, so a hidden second tab carrying the same class names would have
 * its buttons silently rewired by whichever tab rendered last.
 */

import { Save } from '../../js/save.js';
import { buildBlob } from './roster.js';
import { Factory } from './factory.js';
import { installSave, downloadSave, stagedAndValid } from './install.js';
import { mountPokeball } from './pokeball.js';
import { seedBuiltins, buildIndex, loadLocal, saveLocal, loadRepo, saveRepo, merge }
  from './teams.js';
import battleTab from './tabs/battle.js';
import factoryTab from './tabs/factory.js';
import builderTab from './tabs/builder.js';
import itemsTab from './tabs/items.js';
import adventureTab from './tabs/adventure.js';
import dexTab from './tabs/dex.js';
import runTab from './tabs/run.js';
import * as Nuz from './nuzlocke.js';
import * as Nav from './nav.js';
import { mountTutor, tutorState } from './tutor.js';

/**
 * TAB ORDER FOLLOWS THE LOOP, then reference, then meta.
 *
 *   Adventure  where you are and what is here -- the tab you open first
 *   Battle     the fight you are about to have, which is what "here" leads to
 *   Builder    planning a team
 *   Factory    building it. The Builder's own "Build it" hands off TO the
 *              Factory, so the Factory sitting BEFORE it read backwards.
 *   Bag        what you are carrying, in support of all of the above
 *   Pokédex    reference. Not about your run at all, and the only tab that
 *              works with no save loaded.
 *   Run        your rules and your summary -- meta, so it goes last, where
 *              settings go. It was second-to-last, which put the one
 *              non-per-run tab after it and read as an accident.
 */
const TABS = [adventureTab, battleTab, builderTab, factoryTab, itemsTab, dexTab, runTab];

const $ = (id) => document.getElementById(id);
const state = {
  S: null,            // app/data/static.json
  save: null,         // a Save, or null
  ctx: null,          // { save, S, blob, live, trainer, ... }
  active: null,
  config: null,
  // The nuzlocke rules, loaded once per save and handed to every tab. Tabs ask
  // `gate()` before offering an action and render a shackle when it is closed;
  // with the mode off every gate is open and nothing anywhere changes.
  nuz: Nuz.blankState(),
};

// ---------------------------------------------------------------- chrome
/** A tab is reachable when it either needs no save, or one is loaded. */
const tabEnabled = (t) => t.needsSave === false || !!state.save;

function renderTabs() {
  Nav.renderRail($('shell-tabs'), TABS, {
    active: state.active,
    enabled: tabEnabled,
    onPick: (id) => selectTab(id),
    onDial: showDial,
  });
}

/**
 * The dial: the same seven tabs on a ring, summoned rather than always on.
 *
 * On a narrow screen the rail is hidden and this IS the navigation, which is
 * why it is wired to a plain button as well as a key -- a hotkey nobody can
 * press is not a fallback.
 */
function showDial() {
  Nav.openDial(TABS, {
    active: state.active,
    enabled: tabEnabled,
    onPick: (id) => selectTab(id),
  });
}

// Backquote opens it. Deliberately not a letter: every tab has a search box,
// and a hotkey that eats a keystroke in one of them would be worse than no
// hotkey at all. `isTyping` guards the rest.
document.addEventListener('keydown', (e) => {
  if (e.key !== '`' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (Nav.dialOpen() || Nav.isTyping(e.target)) return;
  e.preventDefault();
  showDial();
});

function renderSaveBar() {
  const bar = $('shell-save');
  bar.replaceChildren();
  const dot = document.createElement('span');
  dot.className = `sh-dot ${state.save ? 'ok' : ''}`;
  const label = document.createElement('span');
  if (state.save) {
    const t = state.ctx?.trainer;
    label.textContent = `${t?.ot_name ?? '—'} · ${state.ctx?.live.length ?? 0} Pokémon`;
  } else {
    label.textContent = 'no save loaded';
  }
  bar.append(dot, label);

  if (state.config?.save?.readable && state.config?.save?.size_ok) {
    const b = document.createElement('button');
    b.className = 'sh-btn';
    b.textContent = state.save ? 'Reload save' : 'Load from disk';
    b.onclick = () => loadFromServer({ announce: true });
    bar.append(b);
  }
  const pick = document.createElement('button');
  pick.className = 'sh-btn';
  pick.textContent = state.save ? 'Choose file…' : 'Choose file';
  pick.onclick = () => $('shell-file').click();
  bar.append(pick);

  // The way OUT of the app. It belongs here, beside the save itself, because
  // there is one working copy shared by every tab -- Factory, Team Builder and
  // Bag each used to draw their own pair, which implied three separate piles
  // of pending changes when there has only ever been one.
  if (state.save) bar.append(saveActions());

}

/**
 * Blaze Black / Volt White, and the option to just follow the OS.
 *
 * Three states, cycled by one compact control rather than spread over a menu:
 * `system` is the default and is expressed as the ABSENCE of data-theme, so
 * the media query in every stylesheet keeps working untouched. The names are
 * the pair the ROM ships as; the masthead still reads Blaze Black in both,
 * because it names the hack that is loaded, not the palette.
 */
/**
 * WHICH GAME YOU ARE PLAYING -- a setting, not a build.
 *
 * Blaze Black and Volt White are one hack with a handful of forks, and the
 * only one this tool can see is Opelucid: Drayden in Black, Iris in White.
 * `build_static.py` therefore exports BOTH and tags them, and the app filters
 * at render time. That also means the indices AREAINDEX keys on never shift,
 * and switching version cannot re-attribute your progress -- which is keyed
 * on a stable slug rather than a position for the same reason.
 *
 * It is deliberately NOT the theme. The theme is a palette; this names the
 * cartridge, and the wordmark follows it because saying "Blaze Black" to
 * someone playing Volt White would be wrong about their game.
 */
const VERSIONS = [
  { id: 'black', label: 'Blaze Black', short: 'BLACK' },
  { id: 'white', label: 'Volt White', short: 'WHITE' },
];
const VERSION_KEY = 'bb_version';

/**
 * WHICH STARTER YOU PICKED -- the other fork, and the bigger one.
 *
 * It used to be `STARTER = 'Oshawott'` in build_sheet.py, which meant two
 * players in three had to edit Python and re-run a build script to see their
 * own game. It decides which of Striaton's three leaders you fight and which
 * six each rival brings, so getting it wrong is not cosmetic: the battle tab
 * plans you against a gym leader you will never meet.
 *
 * Unlike the version, this cannot be a tag on a fight -- it changes what is
 * INSIDE one. build_static.py emits the whole roster three times and the app
 * picks a list; see opponentsFor() in roster.js.
 *
 * It is NOT detected from the save. The met-location byte would name Nuvema
 * Town for a normal playthrough, but this app's own Factory can build a
 * starter that never came from there, and a wrong guess here is invisible and
 * wrong for the whole run. Asking once is cheap and the answer is certain.
 */
const STARTER_KEY = 'bb_starter';
const FALLBACK_STARTERS = [
  { id: 'snivy', label: 'Snivy', type: 'grass' },
  { id: 'tepig', label: 'Tepig', type: 'fire' },
  { id: 'oshawott', label: 'Oshawott', type: 'water' },
];
const starters = () => (Array.isArray(state.S?.STARTERS) && state.S.STARTERS.length
  ? state.S.STARTERS : FALLBACK_STARTERS);

function currentStarter() {
  try {
    const v = localStorage.getItem(STARTER_KEY);
    if (starters().some((x) => x.id === v)) return v;
  } catch { /* private mode */ }
  return state.S?.STARTER ?? 'oshawott';
}

function setStarter(id) {
  try { localStorage.setItem(STARTER_KEY, id); } catch { /* private mode */ }
  renderBrand();
  renderVersion();
  // Same reasoning as the version: the roster is baked into the blob, so the
  // battle sheet would still be holding another starter's rivals.
  if (state.save) {
    adopt(state.save.bytes, state.save.name ?? null, state.save.lastModified ?? null);
  } else if (state.active) {
    selectTab(state.active, { force: true });
  }
}

function currentVersion() {
  try {
    const v = localStorage.getItem(VERSION_KEY);
    if (VERSIONS.some((x) => x.id === v)) return v;
  } catch { /* private mode */ }
  return 'black';
}

function setVersion(id) {
  try { localStorage.setItem(VERSION_KEY, id); } catch { /* private mode */ }
  renderBrand();
  renderVersion();
  // The blob is built with one version's roster baked into it, so switching
  // has to rebuild it -- redrawing the tab alone would leave the battle sheet
  // still holding the other cartridge's fights.
  if (state.save) {
    adopt(state.save.bytes, state.save.name ?? null, state.save.lastModified ?? null);
  } else if (state.active) {
    selectTab(state.active, { force: true });
  }
}

const THEMES = [
  { id: 'system', glyph: '◐', label: 'Follow your system' },
  { id: 'dark', glyph: '☾', label: 'Blaze Black' },
  { id: 'light', glyph: '☀', label: 'Volt White' },
];
const THEME_KEY = 'blazeblack.theme';

function currentTheme() {
  const set = document.documentElement.getAttribute('data-theme');
  return THEMES.find((t) => t.id === set) ?? THEMES[0];
}

function applyTheme(id) {
  if (id === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', id);
  try {
    if (id === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, id);
  } catch { /* private mode: the choice lasts for this tab only */ }
}

/**
 * The masthead IS the theme control.
 *
 * It was a static wordmark with a separate theme button at the far right that
 * also said "Blaze Black" -- the same two words twice in one bar, and the
 * control dangling off the end with nothing near it. Folding them together
 * gives the wordmark a job and gets the bar's width back.
 *
 * "companion" is in the name because this is a companion TO the hack. A bare
 * "Blaze Black" reads like a claim on someone else's game.
 */
function renderBrand() {
  const b = $('shell-brand');
  if (!b) return;
  b.replaceChildren();
  const cur = currentTheme();
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  b.title = `Theme: ${cur.label} — click for ${next.label}`;
  b.setAttribute('aria-label', b.title);

  const g = document.createElement('span');
  g.className = 'sh-glyph';
  g.textContent = cur.glyph;
  const w = document.createElement('span');
  w.className = 'sh-word';
  // THE TWO WORDS ARE THE VERSION CONTROL. A separate chip beside the wordmark
  // was a second thing saying the same thing -- "BLAZE BLACK ... BLACK" -- and
  // it sat on its own with nothing near it. The name is what changes when you
  // switch, so the name is what you click. `sh-name` is the hit target; the
  // brand button around it still cycles the theme.
  const ver = VERSIONS.find((v) => v.id === currentVersion()) ?? VERSIONS[0];
  const nm = document.createElement('span');
  nm.className = 'sh-name';
  nm.textContent = ver.label.replace(' ', '\u00a0');
  w.append(nm, '\u00a0');
  const i = document.createElement('i');
  i.textContent = 'companion';
  w.append(i);
  const p = document.createElement('span');
  p.className = 'sh-patch';
  p.textContent = 'v3.1 · FULL PATCH';

  // The second fork. Small and quiet beside the patch label, because both are
  // one-time statements of fact about your run rather than controls you
  // operate -- but it is a real control, so it wears the same dotted
  // underline the version name does.
  const st = starters().find((x) => x.id === currentStarter()) ?? starters()[2];
  const sp = document.createElement('span');
  sp.className = 'sh-patch sh-starter';
  const sn = document.createElement('span');
  sn.className = 'sh-name';
  sn.textContent = st.label.toUpperCase();
  sp.append('STARTER\u00a0', sn);

  // THE NUZLOCKE HAS TO BE VISIBLE FROM ANYWHERE.
  // It lived only inside the Run tab, so someone looking for "how do I turn on
  // nuzlocke mode" scanned the masthead -- where the other two run settings
  // are -- found nothing, and concluded the feature was missing. It was.
  //
  // This chip does NOT toggle. Turning a nuzlocke on or off is a decision with
  // a rule set behind it, and a one-click toggle beside the theme control is
  // exactly the thing you hit by accident. It takes you to where the decision
  // is made, and it states the current answer on the way.
  const nz = document.createElement('button');
  const on = Boolean(state.nuz?.enabled);
  nz.className = `sh-nuz${on ? ' on' : ''}`;
  nz.type = 'button';
  nz.title = on
    ? `Nuzlocke on — ${Nuz.closedActions(state.nuz).length} actions locked. `
      + 'Open the Run tab to change your rules.'
    : 'No nuzlocke. Open the Run tab to configure one — nothing changes until you do.';
  nz.setAttribute('aria-label', nz.title);
  nz.textContent = on ? `⛓ ${state.nuz.rules.length} rules` : 'NUZLOCKE OFF';
  nz.onclick = (e) => { e.stopPropagation(); selectTab('run', { force: true }); };

  b.append(g, w, p, sp, nz);
  b.onclick = () => { applyTheme(next.id); renderBrand(); };

  // REBUILDING THE BRAND REWIRES WHAT IS INSIDE IT.
  //
  // `.sh-name` -- the version control, and the starter control beside it --
  // are created HERE and wired in renderVersion(). Every caller paired the two
  // by hand, and the one that did not was the theme click above: flipping
  // light/dark replaced both names with fresh, handler-less elements, so the
  // cartridge and the starter went dead until a reload. They looked exactly
  // the same, which is what made it read as "clicking does nothing".
  //
  // Same shape as the standing redraw trap -- a rebuild destroys the element
  // the handler was on -- so the fix is the same: the thing that
  // builds a control owns its wiring, rather than trusting every call site to
  // remember. renderVersion() only sets properties, so calling it twice is
  // harmless and the paired calls elsewhere are left alone.
  renderVersion();
}

/**
 * Make the wordmark's NAME the version control, and stamp the version on the
 * root so the palette can shift with it.
 *
 * Two controls in one bar, nested, which is only workable because they mean
 * different things and say so: the name is the cartridge, everything around
 * it is the theme. The name stops the click reaching the brand button so
 * switching version never also flips the palette.
 */
/**
 * How hard this run is, stamped on the root so the chrome can escalate.
 *
 * A pill reading "8 rules" is a fact you read once and stop seeing. Choosing a
 * hard run should be PRESENT, so the intensity drives the page ground's
 * pattern and weight, the bar's hairline, and at the top of the ladder the
 * chrome's own type -- see the `data-nuz` block in theme.css for the three
 * things it is not allowed to touch.
 *
 * Banded rather than continuous: three steps you can feel, instead of thirteen
 * you cannot. The bands are the presets' own shape -- the classic three or
 * four rules, the Strict set, and Hardcore.
 */
function renderNuzIntensity() {
  const st = state.nuz;
  const root = document.documentElement;
  if (!st?.enabled || !(st.rules?.length)) { root.removeAttribute('data-nuz'); return; }
  const n = st.rules.length;
  root.setAttribute('data-nuz', String(n >= 9 ? 3 : n >= 6 ? 2 : 1));
}

function renderVersion() {
  const cur = VERSIONS.find((v) => v.id === currentVersion()) ?? VERSIONS[0];
  const next = VERSIONS[(VERSIONS.indexOf(cur) + 1) % VERSIONS.length];
  document.documentElement.setAttribute('data-version', cur.id);
  const nm = document.querySelector('#shell-brand .sh-name');
  if (!nm) return;
  nm.title = `Playing ${cur.label} — click the name to switch to ${next.label}. `
    + 'Only the Opelucid gym leader differs: Drayden in Black, Iris in White.';
  nm.setAttribute('role', 'button');
  nm.setAttribute('tabindex', '0');
  nm.setAttribute('aria-label', nm.title);
  nm.onclick = (e) => { e.stopPropagation(); setVersion(next.id); };
  nm.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setVersion(next.id); }
  };

  const list = starters();
  const st = list.find((x) => x.id === currentStarter()) ?? list[list.length - 1];
  const nextSt = list[(list.indexOf(st) + 1) % list.length];
  const sn = document.querySelector('#shell-brand .sh-starter .sh-name');
  if (!sn) return;
  sn.title = `You picked ${st.label} — click to switch to ${nextSt.label}. `
    + 'It decides which of Striaton\u2019s three leaders you fight and which six '
    + 'Cheren and Bianca bring.';
  sn.setAttribute('role', 'button');
  sn.setAttribute('tabindex', '0');
  sn.setAttribute('aria-label', sn.title);
  sn.onclick = (e) => { e.stopPropagation(); setStarter(nextSt.id); };
  sn.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); e.stopPropagation(); setStarter(nextSt.id);
    }
  };
}

/**
 * Install / Download, rendered once.
 *
 * Disabled here is a COLOUR, not an opacity: an `opacity: .42` over the
 * measured --fx-go-* pair took the label to 2.27:1 and still read as an
 * enabled orange button. See the note in factory.css.
 */
function saveActions() {
  const F = state.ctx?.factory;
  const ready = stagedAndValid(F);
  const wrap = document.createElement('div');
  wrap.className = 'sh-actions';

  // The staged count rides in the sub-label rather than in a pill of its own.
  // A separate "unsaved edits" chip made the bar wider exactly when it changed
  // state, which pushed Install and Download onto a second line — the one
  // moment you least want the controls to move.
  const n = F?.undoStack?.length ?? 0;
  const staged = '';
  const go = (cls, main, sub, fn) => {
    const b = document.createElement('button');
    b.className = `sh-go ${cls}`;
    b.disabled = !ready;
    const m = document.createElement('span');
    m.className = 'sh-go-main';
    m.textContent = main;
    const s = document.createElement('span');
    s.className = 'sh-go-sub';
    s.textContent = ready ? staged + sub : 'nothing staged';
    b.append(m, s);
    b.onclick = fn;
    return b;
  };

  if (state.config?.writes_enabled) {
    const inst = go('sh-install', 'Install to save', 'backs up first', async () => {
      try {
        const msg = await installSave(F, state.config);
        if (msg) { note(msg); refreshActions(); selectTab(state.active, { force: true }); }
      } catch (e) { alert(`Install failed — ${e.message}\n\nYour save was not changed.`); }
    });
    inst.title = state.config?.backups
      ? `Backs your current save up to ${state.config.backups} first`
      : 'Backs your current save up first';
    wrap.append(inst);
  }
  /* DOWNLOAD IS THE SECOND WAY OUT WHEN THERE IS A FIRST.
     Install writes the save in place, backing it up first, and it is how this
     is actually used. The two shipped as a matched pair -- same size, same
     two-line shape -- which read as two equal choices and made you decide
     between them every time.
     But when the server has no save path (drag-and-drop, or ./serve --no-write)
     Download is the ONLY way out, and demoting it would leave the bar with no
     primary action at all. So the rule is about what else is on offer rather
     than about the button: it is quiet beside Install, and primary alone. */
  const alone = !state.config?.writes_enabled;
  if (alone) {
    wrap.append(go('sh-download sh-only', 'Download .sav', 'place it yourself', () => {
      try { note(downloadSave(F)); } catch (e) { alert(e.message); }
    }));
  } else {
    const dl = document.createElement('button');
    dl.className = 'sh-btn sh-dl';
    dl.type = 'button';
    dl.textContent = 'Download';
    dl.disabled = !ready;
    dl.title = ready
      ? 'Download the edited .sav and place it yourself, instead of installing it'
      : 'Nothing staged to download';
    dl.onclick = () => { try { note(downloadSave(F)); } catch (e) { alert(e.message); } };
    wrap.append(dl);
  }

  if (ready) {
    wrap.classList.add('is-staged');
    const pill = document.createElement('span');
    pill.className = 'sh-staged';
    pill.textContent = String(n || 1);
    pill.title = `${n || 1} staged edit${n === 1 ? '' : 's'} — not yet on disk`;
    wrap.prepend(pill);
  }
  return wrap;
}

/** Tabs call this after they mutate the working copy, so the bar keeps up. */
function refreshActions() {
  if (state.save) renderSaveBar();
}

/** A short-lived line under the bar: reassurance, not an alert. */
function note(text) {
  const box = $('shell-warn');
  const d = document.createElement('div');
  d.className = 'sh-note';
  d.textContent = text;
  box.prepend(d);
  setTimeout(() => d.remove(), 9000);
}

/**
 * Problems with the INSTALL rather than with your save.
 *
 * These outlive every warn() call, because warn() replaces its box each time a
 * save is loaded and a missing sprite set is not a fact about your save. See
 * setupWarnings().
 */
let SETUP_NOTES = [];

/**
 * WHAT ./setup COULD NOT FETCH, SAID OUT LOUD.
 *
 * The reference wiki is a 232 MB clone and is skippable -- `./setup --no-wiki`,
 * a failed clone, a metered connection, or someone who moved the directory.
 * Skipping it does not break the app, which is the problem: it comes up
 * looking finished, with every Pokemon rendered as a broken image and every
 * route reporting no encounters. That is indistinguishable from a bug in the
 * app, and the person who hits it has no reason to suspect a missing
 * dependency they were never told they had.
 *
 * So it is named here, in the app, where the symptom is -- not only in the
 * terminal output of a command that was run once, days ago, and scrolled past.
 */
function setupWarnings() {
  const out = [];
  const sprites = Object.keys(state.S?.SPRITE ?? {}).length;
  const areas = Object.keys(state.S?.AREAS ?? {}).length;
  if (sprites === 0) {
    out.push('No Pokémon sprites were found, so every Pokémon on every tab will render '
      + 'as a broken image. They come from the reference wiki clone, which ./setup '
      + 'fetches into wiki/. Run ./setup (without --no-wiki), then '
      + 'python3 build_static.py, then reload.');
  } else if (sprites < 600) {
    out.push(`Only ${sprites} of 649 Pokémon sprites resolved — the wiki clone in wiki/ `
      + 'looks incomplete. Re-run ./setup, then python3 build_static.py.');
  }
  if (areas === 0) {
    out.push('No wild encounter tables were found, so the Adventure tab cannot say what '
      + 'is catchable anywhere. These also come from the wiki clone in wiki/.');
  }
  SETUP_NOTES = out;
  if (out.length) warn([]);
}

function warn(messages) {
  const box = $('shell-warn');
  box.replaceChildren();
  for (const m of [...SETUP_NOTES, ...messages]) {
    const d = document.createElement('div');
    d.className = 'sh-warn';
    d.textContent = m;
    box.append(d);
  }
}

function message(title, lines, { drop = false, error = false } = {}) {
  const panel = $('shell-panel');
  panel.replaceChildren();
  const box = document.createElement('div');
  box.className = 'sh-msg';
  const h = document.createElement('h2');
  h.textContent = title;
  if (error) h.className = 'sh-err';
  box.append(h);
  for (const l of lines) {
    const p = document.createElement('p');
    p.innerHTML = l;
    box.append(p);
  }
  if (drop) {
    const z = document.createElement('div');
    z.className = 'sh-drop';
    z.textContent = 'Drop a .sav here, or click to choose one';
    z.onclick = () => $('shell-file').click();
    box.append(z);
    wireDrop(z);
  }
  panel.append(box);
}

// ------------------------------------------------------------ save loading
function wireDrop(el) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f) loadFile(f);
  });
}

/**
 * Re-read the save from disk.
 *
 * Strictly a GET, so it is safe to use mid-session -- but the emulator only
 * writes the .sav when you SAVE IN GAME, so re-reading while playing gives
 * the same bytes back and looks like a broken button. It now says which it
 * was, and when the file on disk was last written.
 */
async function loadFromServer({ announce = false } = {}) {
  try {
    // Re-fetch config too: freshness and readability are point-in-time facts
    // and the boot-time snapshot goes stale the moment you play.
    try { state.config = await (await fetch('/api/config', { cache: 'no-store' })).json(); }
    catch { /* keep what we had */ }

    if (state.save && state.ctx?.factory?.dirty
      && !confirm('You have staged changes in the Factory or Team Builder.\n\n'
        + 'Reloading from disk discards them. Continue?')) return;

    const res = await fetch('/api/save', { cache: 'no-store' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    const mtime = res.headers.get('X-Save-Mtime');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const same = state.save && bytes.length === state.save.bytes.length
      && bytes.every((v, i) => v === state.save.bytes[i]);
    adopt(bytes, 'disk');
    if (announce) {
      const when = mtime ? mtime.slice(0, 16).replace('T', ' ') + ' UTC' : 'unknown';
      note(same
        ? `Re-read the save — identical to what was already loaded. The emulator only `
          + `writes the file when you save in game; it was last written ${when}.`
        : `Reloaded from disk (written ${when}) — ${state.ctx.live.length} Pokémon.`);
    }
  } catch (e) {
    message('Could not read the save from disk', [
      escapeHtml(e.message),
      'The file may still be flushing after an in-game save — wait a moment and try again.',
      'You can always drop the file in directly instead.',
    ], { drop: true, error: true });
  }
}

async function loadFile(file) {
  try {
    // A dropped file is a snapshot the browser already read, so the staleness
    // guard is applied to its own lastModified rather than to "now".
    const bytes = new Uint8Array(await file.arrayBuffer());
    adopt(bytes, file.name, file.lastModified);
  } catch (e) {
    message('Could not read that file', [escapeHtml(e.message)], { drop: true, error: true });
  }
}

function adopt(bytes, name, lastModified = null) {
  let save;
  try {
    save = Save.load(bytes, { name, lastModified });
  } catch (e) {
    message('That file is not a usable save', [
      escapeHtml(e.message),
      'A Black/White save is exactly 524288 bytes. A savestate is not a save file.',
    ], { drop: true, error: true });
    return;
  }

  const trainer = save.readTrainer();
  const { blob, live, missing, duplicates, skipped } = buildBlob(save, state.S,
    { ot: trainer.ot_name, version: currentVersion(), starter: currentStarter() });

  state.save = save;
  // ONE working copy, shared by every tab. Two tabs each holding their own
  // Factory would diverge the moment you edited in one and looked in the
  // other, and there would be two undo stacks and two "unsaved changes"
  // flags for one file.
  state.ctx = { save, S: state.S, blob, live, trainer, missing, duplicates, skipped,
    version: currentVersion(),
    starter: currentStarter(),
    config: state.config, factory: new Factory(save, state.S),
    // Tabs sometimes need to hand off to another one -- Adventure links a
    // documented trainer straight to that fight in the battle companion.
    goTo: (id) => selectTab(id, { force: true }),
    // THE RULES, HANDED TO EVERY TAB. A tab asks `gate(ctx.nuz, action)` before
    // offering something and shackles the control when it is closed. With the
    // mode off every gate is open, so a player who is not nuzlocking sees no
    // difference anywhere -- which is the whole contract of the feature.
    nuz: state.nuz,
    // The Run tab is the only writer. Everything else has to be redrawn when
    // it writes, or a rule turned on there would not bite until you switched
    // tabs and back -- which reads as the switch not working.
    onNuzlockeChange: (next) => {
      state.nuz = next;
      if (state.ctx) state.ctx.nuz = next;
      renderTabs();
      // The masthead chip states whether a nuzlocke is live, so it has to be
      // redrawn when that changes -- otherwise the one indicator visible from
      // every tab is the one that goes stale.
      renderBrand();
      renderVersion();
      renderNuzIntensity();
    },
    // Tabs mutate the shared working copy; the shell owns the buttons that
    // act on it, so they have to be told when it changes.
    refreshActions };
  // Rules are per trainer, like teams: someone else's save is someone else's
  // run. Loaded before any tab mounts so the first render is already shackled.
  state.nuz = Nuz.load(trainer?.trainer_id ?? 0);
  state.ctx.nuz = state.nuz;
  renderNuzIntensity();

  const notes = [...(save.warnings ?? [])];
  if (missing.length) {
    const uniq = [...new Set(missing)];
    notes.push(`${uniq.length} species in TEAM_LAYOUT are not in this save: ${uniq.slice(0, 8).join(', ')}${uniq.length > 8 ? '…' : ''}`);
  }
  for (const s of skipped) {
    notes.push(`Team "${s.name}" was skipped — only ${s.have} of ${s.want} members are in this save.`);
  }
  const v = save.verify();
  if (!v.ok) notes.push(`This save does not pass its own checksums: ${v.problems.slice(0, 3).join('; ')}`);
  warn(notes);

  renderTabs();
  renderSaveBar();
  selectTab(state.active ?? TABS[0].id, { force: true });
  adoptShippedRosters();
}

/**
 * Turn the shipped rosters into cores the first time this trainer is seen.
 *
 * IT RUNS HERE, NOT IN A TAB. Both the Battle tab and the Team Builder read
 * the team store, and either one can be the first thing you open -- seeding
 * from whichever happened to mount would mean Kaiju existing or not depending
 * on where you clicked. It needs the save (a roster resolves against what you
 * actually own), so this is the first point where it can run at all.
 *
 * Deliberately not awaited: it writes teams, and nothing on screen is waiting
 * for them. A failure here must never keep the app from rendering.
 */
async function adoptShippedRosters() {
  const ctx = state.ctx;
  if (!ctx) return;
  try {
    const tid = ctx.trainer?.trainer_id;
    let repo = [];
    if (ctx.config) { try { repo = await loadRepo(); } catch { /* offline */ } }
    const have = merge(loadLocal(tid), repo);
    const { teams, added } = seedBuiltins(have, buildIndex(ctx.factory), ctx.S, { tid });
    if (!added.length) return;
    saveLocal(tid, teams);
    if (ctx.config) { try { await saveRepo(teams); } catch { /* local still wins */ } }
    // The Battle tab builds its tab strip at mount, so one that is already
    // open has an index that predates these.
    if (state.active === 'battle') selectTab('battle', { force: true });
  } catch { /* a seeding failure must not take the app down */ }
}

// ------------------------------------------------------------------ tabs
function selectTab(id, { force = false } = {}) {
  const tab = TABS.find((t) => t.id === id) ?? TABS[0];
  if (tab.needsSave !== false && !state.save) return;
  if (state.active === tab.id && !force) return;

  const prev = TABS.find((t) => t.id === state.active);
  if (prev?.unmount) { try { prev.unmount(); } catch (e) { console.warn('unmount failed', e); } }

  state.active = tab.id;
  // The page ground carries the active tab's wagara motif -- see "ONE MOTIF
  // PER TAB" in theme.css. This attribute is the whole mechanism: the CSS
  // does the rest, and with no attribute the ground is asanoha as before.
  document.body.dataset.tab = tab.id;
  renderTabs();
  const panel = $('shell-panel');
  panel.replaceChildren();
  try {
    // battle's mount is async (it fetches the template), factory's is not.
    // Awaiting the result covers both and routes a rejected promise into the
    // same error panel a throw would hit.
    // A save-free tab still needs the ROM tables. Without this it is handed
    // `null` before a save is loaded and throws on the first `ctx.S`, which
    // presents as "the tab is broken" rather than "there is no save yet".
    const ctx = state.ctx ?? { S: state.S, config: state.config };
    Promise.resolve(tab.mount(panel, ctx)).catch((e) => {
      console.error(e);
      message(`The ${tab.label} tab failed to render`, [
        escapeHtml(e.message),
        'The save loaded fine — this is a bug in the tab, not in your file.',
      ], { error: true });
    });
  } catch (e) {
    console.error(e);
    message(`The ${tab.label} tab failed to render`, [
      escapeHtml(e.message),
      'The save loaded fine — this is a bug in the tab, not in your file.',
    ], { error: true });
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------------ boot
async function boot() {
  // The battle companion's stylesheet IS the app's design system -- tokens,
  // light/dark, the lot. Injecting it at boot rather than at tab mount means
  // the shell is styled before any tab exists, and every future tab inherits
  // the same palette instead of inventing one.
  try {
    const tpl = await (await fetch('/sheet_template.html', { cache: 'no-cache' })).text();
    const m = tpl.match(/<style>([\s\S]*?)<\/style>/);
    if (m) {
      const el = document.createElement('style');
      el.id = 'design-tokens';
      el.textContent = m[1];
      document.head.append(el);
    }
  } catch (e) {
    console.warn('design tokens unavailable:', e.message);
  }

  try {
    const res = await fetch('./data/static.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.S = await res.json();
  } catch (e) {
    renderTabs();
    message('Game data is missing', [
      `Could not load <code>app/data/static.json</code> — ${escapeHtml(e.message)}.`,
      'Build it from your ROM with <code>python3 build_static.py</code>, then reload.',
    ], { error: true });
    return;
  }
  setupWarnings();

  try {
    state.config = await (await fetch('/api/config', { cache: 'no-store' })).json();
  } catch {
    state.config = null;      // opened without ./serve, or the server is older
  }

  renderBrand();
  renderVersion();
  renderTabs();
  renderSaveBar();

  /* PROFESSOR HAZEL. Mounted after the chrome so the tour has something to
     point AT, and skipped entirely once you have sent them away. The tour
     runs itself only on a first visit; after that Slowking is a button in the
     corner that says nothing until clicked. */
  const tut = tutorState();
  if (!tut.hidden) {
    const hazel = mountTutor(document, {
      onNav: (id) => selectTab(id),
      activeTab: () => state.active,
      /* THE SPRITE IS PASSED IN, like pokeball.js's guests, so tutor.js still
         imports nothing and stays deletable in one move.
         SLOWKING IS THE MASCOT, and it is a deliberate pick rather than a fallback:
         it has talked like a person on screen, which is the whole joke, and it
         beats the ROM's Scientist -- the nearest thing to a professor the
         cartridge holds, since Juniper never battles you and so has no battle
         sprite. The Scientist is the second choice for anyone whose wiki clone
         is missing, and a tree with no extracted art at all gets a Poké Ball
         drawn in CSS. */
      face: state.S?.SPRITE?.Slowking ?? state.S?.TRFACE?.['51'] ?? null,
    });
    if (!tut.seen) setTimeout(() => hazel.start(), 600);
  }
  // Chrome, not part of any tab -- tabs unmount whenever you switch, and this
  // is meant to sit there being ignorable until someone gives in.
  // Sprite URLs are PASSED IN rather than imported, so pokeball.js still
  // depends on nothing and stays deletable in one move.
  mountPokeball(document, {
    sprites: Object.fromEntries(['Snorlax', 'Gengar', 'Mew', 'Mewtwo', 'Magikarp']
      .map((n) => [n, state.S?.SPRITE?.[n]]).filter(([, u]) => u)),
  });
  $('shell-file').onchange = (e) => e.target.files[0] && loadFile(e.target.files[0]);
  wireDrop(document.body);

  if (state.config?.save?.readable && state.config.save.size_ok && state.config.save.fresh_enough) {
    await loadFromServer();
    return;
  }

  const why = state.config?.save?.reason;
  message('Load a save to begin', [
    why ? `Reading from disk is not available: ${escapeHtml(why)}` :
      'Point <code>companion.config.json</code> at your <code>.sav</code> to skip this step next time.',
    'Everything is decoded in this tab. Nothing is uploaded anywhere.',
  ], { drop: true });
}

boot();
