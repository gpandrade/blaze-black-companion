/**
 * tabs/battle.js -- the battle companion, hosted rather than rewritten.
 *
 * sheet_template.html stays the single source of truth for this tool. This
 * module fetches it, pulls out its markup and its script, and runs the script
 * with `D` supplied from the loaded save instead of baked in by Python.
 *
 * =========================================================================
 * WHY HOST THE TEMPLATE INSTEAD OF PORTING IT
 * =========================================================================
 * That script is ~900 lines of damage maths, type-chart work, turn ordering,
 * matchup planning and chart geometry that have been shaken out over many
 * sessions. Retyping it into a module would be a rewrite wearing a port's
 * clothes, and every bug introduced would look like it had always been there.
 *
 * Hosting it means build_sheet.py and this app render byte-identical logic
 * from ONE file. `python3 build_sheet.py` keeps working and keeps producing
 * the artifact; this tab is a second consumer of the same template.
 *
 * The only edit made to the script is the first line:
 *     const D=__DATA__;   ->   const D=window.__BATTLE_D__;
 * and the whole thing is wrapped in an IIFE so its top-level consts are
 * function-scoped. Without that wrapper, re-injecting after a save reload
 * would throw on redeclaration.
 */

import { battleTeams, buildIndex, loadRepo, merge, loadLocal, saveLocal, saveRepo,
  normalizeTeam, partyTeam, NATURE_NAMES } from '../teams.js';
import { teamToPaste, header } from '../showdown.js';
import { openTeamEditor, activeTeamId } from '../teamedit.js';

const TEMPLATE_URL = '/sheet_template.html';
const SCRIPT_ID = 'battle-tab-script';
const DATA_ANCHOR = 'const D=__DATA__;';

let cached = null;      // { markup, script }

async function loadTemplate() {
  if (cached) return cached;
  const res = await fetch(TEMPLATE_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`could not fetch ${TEMPLATE_URL}: HTTP ${res.status}`);
  const html = await res.text();

  // Assert every anchor matched. The template mixes indented and unindented
  // lines, and a silently-missed anchor here would render a blank tab with no
  // error at all -- which is exactly the failure mode that once made three
  // rounds of styling work appear to land and do nothing.
  const styleEnd = html.indexOf('</style>');
  const scriptOpen = html.indexOf('<script>');
  const scriptClose = html.lastIndexOf('</script>');
  if (styleEnd < 0) throw new Error('template has no </style> — cannot find where the markup starts');
  if (scriptOpen < 0 || scriptClose < 0) throw new Error('template has no <script> block');

  const markup = html.slice(styleEnd + '</style>'.length, scriptOpen).trim();
  const raw = html.slice(scriptOpen + '<script>'.length, scriptClose);
  if (!markup.includes('id="view"')) throw new Error('template markup is missing #view');
  if (!raw.includes(DATA_ANCHOR)) {
    throw new Error(`template no longer starts with "${DATA_ANCHOR}" — the data injection point moved`);
  }

  const script = `(function(){\n${raw.replace(DATA_ANCHOR, 'const D=window.__BATTLE_D__;')}\n})();`;
  cached = { markup, script };
  return cached;
}

export default {
  id: 'battle',
  label: 'Battle',
  needsSave: true,

  async mount(panel, ctx) {
    panel.textContent = 'Loading the battle companion…';
    const { markup, script } = await loadTemplate();

    // Hand the script its data the same way the generated page does, just at
    // runtime. buildBlob() has already been verified field-for-field against
    // build_sheet.py by tools/verify_blob.py.
    //
    // Teams saved in the Team Builder are appended here rather than baked into
    // buildBlob, so switching to this tab always picks up whatever the Builder
    // last saved without the two having to coordinate. They are converted into
    // exactly the shape TEAM_LAYOUT produces, so the sheet cannot tell the
    // difference and every calculation applies to them unchanged.
    let blob = ctx.blob;
    try {
      // Both stores. Reading only localStorage meant a team saved to the repo
      // -- on another machine, or in a browser whose site data was cleared --
      // silently never appeared here.
      let repo = [];
      if (ctx.config) {
        try { repo = await loadRepo(); } catch { /* no server, or no teams yet */ }
      }
      // The live party goes first among the added tabs: it needs no setup and
      // is the one someone who never touches the Builder still wants.
      const idx = ctx.factory ? buildIndex(ctx.factory) : [];
      const live = ctx.factory ? partyTeam(idx, ctx.S) : null;
      const mine = ctx.factory
        ? battleTeams(ctx.trainer?.trainer_id, idx, ctx.S, repo)
        : [];
      const added = [live, ...mine].filter(Boolean);
      if (added.length) blob = { ...blob, TEAMS: [...blob.TEAMS, ...added] };
    } catch (e) {
      console.warn('Team Builder teams could not be added:', e.message);
    }
    window.__BATTLE_D__ = blob;

    // A hook the app can style through. The template's own masthead is a
    // 42px <h1> over a row of big tab buttons, which is right for a standalone
    // page and wrong beside four tabs whose header is a compact toolbar. The
    // markup is NOT edited -- sheet_template.html is still the artifact that
    // gets published -- so the app restyles it from outside instead.
    panel.classList.add('bt-host');
    panel.innerHTML = markup;

    // The template's <h1> is the standalone page's identity -- it names the
    // teams the sheet shipped with ("Kaiju, Rain, Trick Room"), which is both
    // stale (there are eight now) and the odd one out beside "Pokémon
    // Factory", "Team Builder" and "Bag". In the app it says what the tab IS.
    // The template is not edited: build_sheet.py still renders the artifact
    // with its own masthead.
    const h1 = panel.querySelector('header.mast h1');
    if (h1) h1.textContent = 'Battle companion';

    // EDIT THE PROSE FROM HERE. A roster carries a tagline, labelled pilot
    // cards and a per-slot reason; a Builder team had none of that, so your own
    // cores never read like Kaiju. The control is added from outside
    // the template for the same reason the masthead is restyled from outside:
    // sheet_template.html is also the published artifact, which is static and
    // has no team store to write to.
    mountEditControl(panel, ctx, blob);
    mountFieldControl(panel, ctx, blob);
    mountExportControl(panel, ctx, blob);

    // ARRIVING FROM ADVENTURE. `bb_enc.jump` is set by planFight() there; it is
    // read and cleared BEFORE the script runs, because the template's own
    // saveEnc() rewrites that key during render and would drop it first.
    let jump = false;
    try {
      const st = JSON.parse(localStorage.getItem('bb_enc') ?? '{}');
      if (st.jump) {
        jump = true;
        delete st.jump;
        localStorage.setItem('bb_enc', JSON.stringify(st));
      }
    } catch { /* private mode */ }

    // A fresh element every mount: re-running the IIFE rebinds every handler
    // against the markup that is in the DOM right now.
    document.getElementById(SCRIPT_ID)?.remove();
    const el = document.createElement('script');
    el.id = SCRIPT_ID;
    el.textContent = script;
    document.body.append(el);

    // Landing at the top of a long page is what made "Plan this fight" feel
    // like it had done nothing.
    //
    // The target is the battle INDEX, not its enclosing zone: zone 03 opens
    // with the level curve, so scrolling to the section put a chart on screen
    // and the fight you asked for below the fold. #bidxwrap is the card grid
    // itself, with the fight you picked already selected and the planner
    // directly under it. Found by id rather than given one, so the template --
    // which is also the published artifact -- stays untouched, and only after
    // a frame, because none of it exists until the injected script renders.
    if (jump) {
      requestAnimationFrame(() => {
        panel.querySelector('#bidxwrap')?.scrollIntoView({ block: 'start' });
      });
    }
  },

  unmount() {
    document.getElementById(SCRIPT_ID)?.remove();
    delete window.__BATTLE_D__;
    document.getElementById('shell-panel')?.classList.remove('bt-host');
  },
};

/**
 * Add "Edit this team" to the app's copy of the masthead.
 *
 * EVERY TAB HERE IS EDITABLE NOW BUT ONE. The shipped rosters used to be
 * defined in Python and rendered as tabs the store knew nothing about, so the
 * only honest offer for Kaiju was a copy. They are adopted as cores on first
 * run instead, which leaves exactly one tab the store does not own: your live
 * party, synthesised from the save every mount. That one still gets the copy,
 * because there is no record behind it to write to.
 */
function mountEditControl(panel, ctx, blob) {
  const mast = panel.querySelector('header.mast');
  if (!mast || !ctx.factory) return;

  const btn = document.createElement('button');
  btn.className = 'bt-edit';
  btn.type = 'button';
  btn.textContent = 'Edit this team';
  mast.append(btn);

  const tid = ctx.trainer?.trainer_id;
  const ids = (blob.TEAMS ?? []).map((t) => t.id);

  const stored = async () => {
    let repo = [];
    if (ctx.config) { try { repo = await loadRepo(); } catch { /* offline */ } }
    return merge(loadLocal(tid), repo);
  };

  const persist = async (teams) => {
    saveLocal(tid, teams);
    if (ctx.config) { try { await saveRepo(teams); } catch { /* offline: local still wins */ } }
  };

  btn.onclick = async () => {
    const activeId = activeTeamId(ids);
    const shown = (blob.TEAMS ?? []).find((t) => t.id === activeId);
    if (!shown) return;

    // builder-<id> and core-<id> are the two the store owns. `live-party` is
    // synthesised from the save every mount and the rest ship in Python.
    const m = /^(?:builder|core)-(.+)$/.exec(activeId);
    const teams = await stored();
    const rec = m ? teams.find((t) => t.id === m[1]) : null;

    if (!rec) {
      // YOUR LIVE PARTY HAS NO RECORD. It is read from the save at mount, so
      // there is nothing in the store to edit -- copying it means reading the
      // party, exactly as the Builder's "from your party" seeding does.
      notEditable(panel, shown, async () => {
        const { teamFromMons, nextTeamName } = await import('../teams.js');
        const idx = buildIndex(ctx.factory);
        const mons = idx.filter((x) => x.loc === 'party').map((x) => x.mon);
        if (!mons.length) { window.alert('Your party is empty.'); return; }
        const copy = teamFromMons('My party', mons);
        if (!copy.slots.length) { window.alert(`${shown.name} copied as empty.`); return; }
        const all = await stored();
        copy.name = all.some((t) => t.name === 'My party') ? nextTeamName(all) : 'My party';
        await persist([...all, copy]);
        ctx.goTo?.('builder');
      });
      return;
    }

    openTeamEditor(normalizeTeam(rec), {
      speciesName: (id) => ctx.S.SPECIES?.[String(id)]?.name,
      onSave: async (next) => {
        const all = await stored();
        await persist(all.map((t) => (t.id === next.id ? next : t)));
        // Re-mount rather than patch: the sheet recomputes a team's warning,
        // its pilot row and every slot card from the blob it was handed, and
        // there is no partial redraw to reach for. goTo forces a re-select
        // even though this tab is already the active one.
        ctx.goTo?.('battle');
      },
    });
  };
}

/**
 * "Field it" on the team you are looking at.
 *
 * The last step of the loop this app is for: read the fight, pick the roster,
 * put it in your party, install, reboot. Without this you go back to the Team
 * Builder to find the same team and press the same button there.
 *
 * App-side, like the editor: the published artifact has no save to write into.
 * It renders into `#fieldslot`, an empty span the template leaves in the team
 * header -- the template itself stays unaware, so build_sheet.py is unchanged.
 *
 * Only shown when it would DO something: hidden for the team already in your
 * party, and for one whose members are not in the save at all.
 */
/**
 * Export the team you are LOOKING AT.
 *
 * The Team Builder has this on a team's own header, which is right when you
 * are designing one -- and wrong for the moment you actually want it, which is
 * here: you have just run a line-up against a gym leader, it worked, and you
 * want to send it to somebody. Making you switch tabs to a builder to export
 * the thing already on screen is the kind of small friction that means it
 * never gets used.
 *
 * Added from OUTSIDE the template, like the edit and field controls, because
 * `sheet_template.html` is also the published artifact: it is static, has no
 * team store, and cannot reach a clipboard on a page it does not control.
 *
 * It exports the SPECS from the store, not the rendered mons on screen, so the
 * paste carries IVs, EVs and natures. The sheet's own mon shape has final
 * stats and no spread -- a paste built from it would be missing exactly the
 * lines a recipient needs.
 */
function mountExportControl(panel, ctx, blob) {
  const mast = panel.querySelector('header.mast');
  if (!mast) return;
  const btn = document.createElement('button');
  btn.className = 'bt-edit bt-export';
  btn.type = 'button';
  btn.textContent = 'Export';
  btn.title = 'This team as a Pokémon Showdown paste';
  mast.append(btn);

  const ids = (blob.TEAMS ?? []).map((t) => t.id);
  btn.onclick = async () => {
    const shown = (blob.TEAMS ?? []).find((t) => t.id === activeTeamId(ids));
    if (!shown) return;
    let repo = [];
    if (ctx.config) { try { repo = await loadRepo(); } catch { /* no server */ } }
    const store = merge(loadLocal(ctx.trainer?.trainer_id), repo);
    // The battle tab prefixes a core's id with `core-` and a builder team's
    // with `builder-`; the store knows neither prefix.
    const bare = String(shown.id).replace(/^(core-|builder-)/, '');
    const team = store.find((t) => t.id === bare);
    openBattleExport(shown, team, ctx);
  };
}

/**
 * The paste, shown rather than silently copied -- the same call the Builder
 * makes, for the same reason: this text names the hack, and you would want to
 * read that before pasting it somewhere public.
 */
function openBattleExport(shown, team, ctx) {
  const S = ctx.S;
  let text;
  if (team) {
    text = teamToPaste(normalizeTeam(team), S,
      { natureNames: NATURE_NAMES, version: ctx.version ?? 'black' });
  } else {
    // The live party, or a tab with no stored team behind it. The rendered
    // mons carry no spread, so this says so rather than quietly emitting a
    // paste that looks complete and is missing its EV and IV lines.
    const specs = (shown.slots ?? [])
      .map((sl) => sl.options?.[sl.defaultIdx ?? 0]?.mon).filter(Boolean);
    text = `${header(shown.name, ctx.version ?? 'black')}`
      + '# Built from what is on screen, so it carries no EVs, IVs or natures —\n'
      + '# save this line-up in the Team Builder to export those too.\n\n'
      + specs.map((m) => {
        const lines = [`${m.nick ? `${m.nick} (${m.name})` : m.name}`
          + `${m.item ? ` @ ${m.item}` : ''}`];
        if (m.ab && m.ab !== '—') lines.push(`Ability: ${m.ab}`);
        if (m.lvl && m.lvl !== 100) lines.push(`Level: ${m.lvl}`);
        if (m.shiny) lines.push('Shiny: Yes');
        if (m.nat) lines.push(`${m.nat} Nature`);
        for (const mv of m.moves ?? []) lines.push(`- ${mv}`);
        return lines.join('\n');
      }).join('\n\n') + '\n';
  }

  const overlay = document.createElement('div');
  overlay.className = 'bt-modal';
  const sheet = document.createElement('div');
  sheet.className = 'bt-sheet';
  overlay.append(sheet);
  const close = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  const h = document.createElement('h3');
  h.textContent = `Export “${shown.name}”`;
  const box = document.createElement('textarea');
  box.className = 'bt-exporttext';
  box.rows = 18;
  box.readOnly = true;
  box.value = text;
  const status = document.createElement('span');
  status.className = 'bt-exportnote';
  status.textContent = team ? 'Full sets, from the Team Builder store.'
    : 'From what is on screen — no spread.';
  const copy = document.createElement('button');
  copy.className = 'bt-field';
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = 'Copied.';
    } catch {
      box.focus(); box.select?.();
      status.textContent = 'Could not reach the clipboard — the text is selected.';
    }
  };
  const done = document.createElement('button');
  done.className = 'bt-edit';
  done.type = 'button';
  done.textContent = 'Close';
  done.onclick = close;
  const bar = document.createElement('div');
  bar.className = 'bt-exportbar';
  bar.append(status, copy, done);
  sheet.append(h, box, bar);
  document.body.append(overlay);
  box.focus();
  return overlay;
}

function mountFieldControl(panel, ctx, blob) {
  if (!ctx.factory) return;
  const draw = () => {
    const host = panel.querySelector('#fieldslot');
    if (!host) return;                       // render() has not run yet
    host.textContent = '';
    const ids = (blob.TEAMS ?? []).map((t) => t.id);
    const team = (blob.TEAMS ?? []).find((t) => t.id === activeTeamId(ids));
    if (!team || team.state === 'fielded' || team.id === 'live-party') return;

    const idx = buildIndex(ctx.factory);
    const want = [];
    const taken = new Set();
    for (const sl of team.slots) {
      const name = sl.options[sl.defaultIdx ?? 0]?.mon?.name;
      const hit = idx.find((x) => x.mon.species === name && !taken.has(`${x.loc}:${x.index}`));
      if (hit) { taken.add(`${hit.loc}:${hit.index}`); want.push({ loc: hit.loc, index: hit.index }); }
    }
    if (!want.length) return;

    const b = document.createElement('button');
    b.className = 'bt-field';
    b.type = 'button';
    b.textContent = want.length === team.slots.length
      ? 'Field it' : `Field the ${want.length} you have`;
    b.title = 'Put this line-up in your party. Whoever is there now goes back to a box. '
      + 'Staged only — install or download to write it.';
    b.onclick = () => {
      try {
        const r = ctx.factory.fieldParty(want);
        ctx.refreshActions?.();
        draw();
        window.alert(`Fielded ${r.fielded}.`
          + (r.displaced ? ` ${r.displaced} went back to a box.` : '')
          + '\n\nInstall or download, then reboot with Continue — a savestate '
          + 'carries its own copy of cartridge RAM and would undo it.');
      } catch (e) { window.alert(`Could not field it: ${e.message}`); }
    };
    host.append(b);
  };
  // The template renders asynchronously relative to us, and re-renders on every
  // tab and swap click, so the slot has to be refilled rather than filled once.
  requestAnimationFrame(draw);
  panel.addEventListener('click', () => requestAnimationFrame(draw));
}

/** The live party has no stored record; offer the copy instead of a dead end. */
function notEditable(panel, team, onCopy) {
  const overlay = document.createElement('div');
  overlay.className = 'te-overlay';
  const box = document.createElement('div');
  box.className = 'te-box te-narrow';
  box.onclick = (e) => e.stopPropagation();
  overlay.onclick = () => overlay.remove();
  const h = document.createElement('h2');
  h.textContent = 'Your party is read from the save';
  const p = document.createElement('p');
  p.className = 'te-sub';
  p.textContent = 'This tab is rebuilt from whatever you are carrying every time '
    + 'it opens, so there is nothing stored here to edit. Copy it and the copy is '
    + 'yours — a team in the Builder you can name, write on and swap around.';
  const foot = document.createElement('div');
  foot.className = 'te-foot';
  const cancel = document.createElement('button');
  cancel.className = 'te-btn'; cancel.type = 'button'; cancel.textContent = 'Close';
  cancel.onclick = () => overlay.remove();
  const copy = document.createElement('button');
  copy.className = 'te-btn te-go'; copy.type = 'button';
  copy.textContent = 'Copy my party into the Team Builder';
  copy.onclick = async () => { copy.disabled = true; overlay.remove(); await onCopy(); };
  foot.append(cancel, copy);
  box.append(h, p, foot);
  overlay.append(box);
  document.body.append(overlay);
}
