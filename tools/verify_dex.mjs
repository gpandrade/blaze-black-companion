/**
 * verify_dex.mjs -- the Pokédex tab, against a stubbed DOM.
 *
 * Why this file asserts what it does: notes/pokedex.md
 *
 *     node tools/verify_dex.mjs [path/to/save.sav]
 *
 * WHAT IS ACTUALLY AT RISK HERE
 * -----------------------------
 * The tab is a reader, so it cannot corrupt anything. What it CAN do is be
 * confidently wrong, which is worse for this project than a crash: the whole
 * claim of the app is that its numbers come from the cartridge and the wiki's
 * do not. Three ways that claim breaks silently, and all three are asserted:
 *
 *   1  A SHAPE MISMATCH renders an empty block, not an error. `S.MOVES` is
 *      keyed by NAME with short fields (t/p/acc), `S.AREAS` rows carry species
 *      IDS and `pct`, and `S.SPECIES[].lvl` is [level, moveId] pairs. Reading
 *      any of them the obvious-but-wrong way gives dashes all the way down and
 *      looks like a species with no moves.
 *   2  THE DIFF IS OPTIONAL. Someone who extracted without a vanilla ROM must
 *      get a Pokédex with no change badges, never one implying nothing
 *      changed.
 *   3  IT MUST WORK WITH NO SAVE. It is the only tab like that, so it is the
 *      only one where `ctx` can be missing a Factory.
 *
 * READ-ONLY. Defaults to a backup and never writes a file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const ok = (name, pass, detail = '') => {
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? '  ' + detail : ''}`);
  if (!pass) failed++;
};

// ---------------------------------------------------------------- DOM stub
class N {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.attrs = {}; this.className = '';
    this.style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } };
    this.textContent = ''; this.value = ''; this.disabled = false; this.parentNode = null;
    this.classList = {
      add: (c) => { if (!this.className.split(' ').includes(c)) this.className = (this.className + ' ' + c).trim(); },
      remove: (c) => { this.className = this.className.split(' ').filter((x) => x && x !== c).join(' '); },
      contains: (c) => String(this.className ?? '').split(' ').includes(c),
    };
  }
  append(...kids) {
    for (const k of kids) {
      if (k == null) continue;
      const n = typeof k === 'string' ? Object.assign(new N('#text'), { textContent: k }) : k;
      if (n.tagName === '#FRAGMENT') { this.append(...n.children); continue; }
      n.parentNode = this; this.children.push(n);
    }
  }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  replaceWith(...nodes) {
    const p = this.parentNode;
    if (!p) return;
    const i = p.children.indexOf(this);
    const list = nodes.filter((x) => x != null);
    for (const x of list) x.parentNode = p;
    p.children.splice(i, 1, ...list);
    this.parentNode = null;
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener() {} removeEventListener() {} focus() {}
  // A REAL CLICK EVENT CARRIES THESE. A stub whose event lacks
  // preventDefault/stopPropagation throws on handlers that work perfectly in a
  // browser -- the same faithfulness rule that got replaceWith() and focus().
  click(ev = {}) {
    this.onclick?.({ target: this, preventDefault() {}, stopPropagation() {}, ...ev });
  }
  get text() { return (this.textContent || '') + this.children.map((c) => c.text ?? '').join(''); }
  *walk() { yield this; for (const c of this.children) if (c.walk) yield* c.walk(); }
  find(p) { for (const n of this.walk()) if (p(n)) return n; return null; }
  findAll(p) { return [...this.walk()].filter(p); }
  // The tab redraws only its list on a keystroke, and finds it by id. A stub
  // that always returned null would silently make every search a no-op and
  // every search assertion vacuous.
  querySelector(sel) {
    if (typeof sel === 'string' && sel.startsWith('#')) {
      const id = sel.slice(1);
      return this.find((n) => n.attrs?.id === id || n.id === id);
    }
    return null;
  }
}
const body = new N('body');
global.document = {
  body, createElement: (t) => new N(t), addEventListener() {}, removeEventListener() {},
  createDocumentFragment: () => new N('#fragment'),
  createTextNode: (t) => Object.assign(new N('#text'), { textContent: t }),
  querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
};
const store = {};
global.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
global.alert = () => {};
const hasClass = (c) => (n) => n.classList.contains(c);
const btn = (r, re) => r.find((n) => n.tagName === 'BUTTON' && re.test(n.text));

// ------------------------------------------------------------------ set-up
const { Save } = await import('../js/save.js');
const { Factory } = await import('../app/js/factory.js');
const dexTab = (await import('../app/js/tabs/dex.js')).default;

const S = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/data/static.json'), 'utf8'));

let savePath = process.argv[2];
if (!savePath) {
  const dir = path.join(ROOT, 'save_backups');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sav'))
    .map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs) : [];
  savePath = files[files.length - 1] ?? path.join(ROOT, 'tests/fixture.sav');
}
const F = fs.existsSync(savePath)
  ? new Factory(Save.load(new Uint8Array(fs.readFileSync(savePath))), S) : null;
console.log(`  save: ${F ? path.relative(ROOT, savePath) : 'none — testing the save-free path only'}\n`);

const mount = (ctx) => {
  const panel = new N('div');
  dexTab.unmount();
  dexTab.mount(panel, ctx);
  return panel;
};
const reset = () => { for (const k of Object.keys(store)) delete store[k]; };

// ======================================================== the data it reads
console.log('── the blob carries what a Pokédex needs');
{
  const sp = Object.values(S.SPECIES);
  ok('every species has a level-up list with LEVELS',
    sp.every((v) => Array.isArray(v.lvl))
    && sp.some((v) => v.lvl.length && v.lvl.every((e) => Array.isArray(e) && e.length === 2)),
    `${sp.filter((v) => v.lvl?.length).length} of ${sp.length} have one`);
  // `learn` is a legality SET for the Factory and `lvl` is the readable list.
  // Conflating them is the obvious mistake and it loses every level.
  const one = S.SPECIES['6'];
  ok('...and it is not the same thing as the legality set `learn`',
    Array.isArray(one.learn) && typeof one.learn[0] === 'number'
    && Array.isArray(one.lvl[0]), `learn ${one.learn.length}, lvl ${one.lvl.length}`);
  ok('the dex fields are present', ['bst', 'catch', 'exp', 'eggs', 'curveName', 'evoFull']
    .every((k) => one[k] !== undefined), Object.keys(one).length + ' fields');
  ok('egg group ids resolve to names',
    (one.eggs ?? []).every((g) => S.EGGGROUP?.[String(g)]),
    (one.eggs ?? []).map((g) => S.EGGGROUP?.[String(g)]).join(', '));
  ok('evolution methods carry a parameter, not just a name',
    Object.values(S.SPECIES).some((v) => (v.evoFull ?? []).some((e) => e.method && e.param != null)));

  // The shape traps, asserted directly: if any of these change, the tab
  // renders dashes and nothing throws.
  ok('MOVES is keyed by NAME with short fields',
    S.MOVES?.Pound?.t === 'normal' && typeof S.MOVES.Pound.p === 'number',
    JSON.stringify({ t: S.MOVES?.Pound?.t, p: S.MOVES?.Pound?.p }));
  const anyArea = Object.values(S.AREAS ?? {})[0]?.[0];
  ok('AREAS rows carry species IDS and pct',
    Boolean(anyArea) && typeof anyArea.mons?.[0]?.id === 'number'
    && typeof anyArea.mons?.[0]?.pct === 'number',
    JSON.stringify(anyArea?.mons?.[0] ?? null));
}

console.log('\n── what Drayano changed');
{
  const d = S.DIFF ?? {};
  ok('the per-species diff is exported', Boolean(d.species),
    `${Object.keys(d.species ?? {}).length} species changed`);
  if (d.species) {
    const withStats = Object.values(d.species).filter((x) => x.stats);
    ok('...and it agrees with its own counts',
      withStats.length === d.counts.base_stats,
      `${withStats.length} vs ${d.counts.base_stats}`);
    // Only the fields that MOVED. A six-key dict with five unchanged entries
    // makes the reader do the diffing the file exists to do.
    ok('a stat diff lists only the stats that actually changed',
      withStats.every((x) => Object.values(x.stats).every(([a, b]) => a !== b)));
    ok('both sides of every change are present',
      Object.values(d.species).every((x) => (!x.types || x.types.length === 2)
        && (!x.bst || x.bst.length === 2)));
    // Farfetch'd is the loudest single change in the hack and a good canary
    // for the join being right end to end.
    const fd = d.species['83'];
    ok('Farfetch\'d reads as retyped and buffed',
      fd?.types?.[1]?.includes('fighting') && fd.bst[1] > fd.bst[0],
      fd ? `${fd.bst[0]} → ${fd.bst[1]}, ${fd.types[0].join('/')} → ${fd.types[1].join('/')}` : 'missing');
  }
}

// ============================================================== the tab
console.log('\n── the tab, with a save');
if (F) {
  reset();
  const panel = mount({ S, factory: F, goTo: () => {} });
  const root = () => panel.children[0];
  ok('it mounts', Boolean(root()), root()?.className);
  const rows = () => root().findAll(hasClass('dx-row'));
  ok('it lists species', rows().length > 0, `${rows().length} rows drawn`);
  ok('...capped, so 649 rows do not go into the DOM at once',
    rows().length <= 400, `${rows().length}`);

  // Selecting one must fill the detail pane with real numbers.
  const pick = rows().find((r) => /Charizard/.test(r.text)) ?? rows()[0];
  pick.click();
  const txt = () => root().text;
  ok('picking a species opens its card', Boolean(root().find(hasClass('dx-head'))));
  ok('...with its base stats', root().findAll(hasClass('dx-sk')).length === 6);
  ok('...with real numbers, not dashes',
    root().findAll(hasClass('dx-sv')).every((n) => /\d/.test(n.text)),
    root().findAll(hasClass('dx-sv')).map((n) => n.text).join(' '));
  ok('...with its abilities', root().findAll(hasClass('dx-abils')).length === 1);
  const moves = root().findAll(hasClass('dx-mn'));
  ok('...with a level-up moveset', moves.length > 0, `${moves.length} moves`);
  ok('...and the move rows resolve type and power, not dashes',
    root().findAll(hasClass('dx-mp')).filter((n) => /\d/.test(n.text)).length > 0);
  ok('...and everything else the ROM knows',
    /Catch rate/.test(txt()) && /Growth curve/.test(txt()) && /Egg groups/.test(txt()));

  // Search is the main way in, and it redraws only the list -- rebuilding the
  // toolbar would drop focus from the input on every keystroke.
  const search = root().find((n) => n.className === 'dx-search');
  search.value = 'zzzznope';
  search.oninput();
  ok('a search that matches nothing empties the list',
    root().findAll(hasClass('dx-row')).length === 0);
  ok('...without rebuilding the search box, which would drop focus',
    root().find((n) => n.className === 'dx-search') === search);
  // ---- MOVE-FIRST SEARCH -------------------------------------------------
  // "Which of mine can learn Trick Room" is a question the game cannot answer
  // and the wiki answers 649 pages at a time. Everything needed was already in
  // the blob; this is a join, not new data.
  {
    const count = () => root().find(hasClass('dx-count'))?.text ?? '';
    search.value = 'Ice Beam';
    search.oninput();
    ok('a move name searches for what LEARNS it, not for a species',
      /learn Ice Beam/.test(count()), count());
    ok('...and says which move, with its own numbers',
      /Ice Beam/.test(root().find(hasClass('dx-movehit'))?.text ?? ''),
      root().find(hasClass('dx-movehit'))?.text);
    // IT MUST COUNT TMs. The level-up list alone answers a much less useful
    // question -- most of what you teach comes from a Machine, and a search
    // saying "nothing learns Ice Beam" with TM13 in your bag is worse than no
    // search at all.
    const hows = root().findAll(hasClass('dx-how'));
    ok('...marking HOW each one learns it', hows.length > 0, `${hows.length} rows marked`);
    ok('...including by TM, not only by level-up',
      hows.some((n) => n.classList.contains('tm')),
      hows.slice(0, 6).map((n) => n.text).join(' '));
    ok('...and by level-up too', hows.some((n) => n.classList.contains('level')));
    // AMBIGUOUS DOES NOT HIJACK: "ice" is six moves, so none is chosen and the
    // species list is left alone. The six are offered as chips separately.
    search.value = 'ice';
    search.oninput();
    ok('a partial move name falls back to an ordinary species search',
      !root().find(hasClass('dx-movehit')), 'substring must not become a move query');
    // ...and the existing filters still apply ON TOP, which is the combination
    // that answers the real question: "which WATER type of mine learns this".
    search.value = 'Ice Beam';
    search.oninput();
    const all = Number(/^(\d+)/.exec(count())?.[1] ?? 0);
    const typeSel = root().findAll((n) => n.tagName === 'SELECT')
      .find((n) => n.children.some((o) => /Water/i.test(o.text ?? '')));
    typeSel.value = 'water';
    typeSel.onchange();
    const narrowed = Number(/^(\d+)/.exec(count())?.[1] ?? 0);
    ok('a type filter still applies on top of a move search',
      narrowed > 0 && narrowed < all, `${all} learners -> ${narrowed} Water`);
    typeSel.value = '';
    typeSel.onchange();

    // IT HAS TO ANNOUNCE ITSELF. The search box is captioned for species, so
    // the move mode was a feature you could only use if you already knew it
    // existed -- reported as exactly that. The hint offers example moves as
    // buttons, so it is discovered by PRESSING one.
    search.value = '';
    search.oninput();
    const hint = root().find(hasClass('dx-hint'));
    ok('browsing advertises the move search', !!hint, hint?.text ?? 'no dx-hint');
    const chips = hint?.findAll(hasClass('dx-chip')) ?? [];
    ok('...as example moves you can press', chips.length >= 2,
      chips.map((c) => c.text).join(', '));
    // PRESSING ONE MUST ACTUALLY SEARCH. A chip that only fills the box would
    // satisfy a text assertion and teach nothing -- and the box is in the
    // toolbar, which the list redraw does not rebuild, so this is exactly the
    // wiring that can silently be missing.
    // Guarded: without the hint this block would THROW, and a throw here skips
    // every assertion after it in the file -- a missing feature would mask
    // unrelated regressions rather than reporting itself.
    const before = Number(/^(\d+)/.exec(count())?.[1] ?? 0);
    chips[0]?.onclick?.();
    const after = Number(/^(\d+)/.exec(count())?.[1] ?? 0);
    ok('...and pressing one runs that move search', /learn /.test(count()), count());
    ok('...narrowing the list rather than merely captioning it',
      after > 0 && after < before, `${before} species -> ${after} learners`);
    ok('...having also filled the search box, so the state is visible',
      !!chips[0] && search.value === chips[0].text, `box reads "${search.value}"`);
    const advert = () => root().findAll(hasClass('dx-hintlab'))
      .some((n) => /Search a move/.test(n.text ?? ''));
    ok('...and the advert stands down once a move search is running',
      !advert(), 'advert must not persist into move mode');

    // IT MUST NOT MAKE YOU TYPE THE WHOLE NAME. Exact-match-only was reported
    // as "too stiff: I had to type the full move name" -- and it is a real
    // failure, not a preference: while the query matched nothing, the search
    // gave no sign it existed at all.
    search.value = 'Trick R';
    search.oninput();
    ok('an unambiguous PREFIX resolves without the full name',
      /learn Trick Room/.test(count()), count());
    // Punctuation and spacing on BOTH sides, or `V-create` is unreachable by
    // anyone who does not know where the hyphen goes.
    search.value = 'vcreate';
    search.oninput();
    ok('...and punctuation and spacing are forgiven', /learn V-create/.test(count()), count());
    // AMBIGUOUS MUST OFFER, NOT SWALLOW. This is the state the old rule left
    // looking identical to "there is no move search".
    search.value = 'Tri';
    search.oninput();
    // Scope to the hint ROW: `.dx-chip` is also worn by the toolbar's toggles.
    const chipsIn = (n) => (n?.findAll(hasClass('dx-chip')) ?? []).map((c) => c.text);
    const amb = chipsIn(root().find(hasClass('dx-hint')));
    ok('an ambiguous prefix offers the moves it could mean',
      amb.includes('Trick Room') && amb.length > 1, amb.join(', '));
    ok('...without hijacking the species list underneath',
      !/learn /.test(count()), count());
    ok('...and pressing one of THOSE resolves it',
      (() => {
        const chip = (root().find(hasClass('dx-hint'))?.findAll(hasClass('dx-chip')) ?? [])
          .find((c) => c.text === 'Trick Room');
        chip?.onclick?.();
        return /learn Trick Room/.test(count());
      })(), count());
    // EXACT BEATS LONGER. Otherwise "Trick" can only ever mean Trick Room and
    // the shorter, exactly-named move is unreachable.
    search.value = 'Trick';
    search.oninput();
    ok('an exact name wins over a longer one starting the same way',
      /learn Trick\b/.test(count()) && !/Trick Room/.test(count()), count());
    ok('...with the longer one still one click away',
      chipsIn(root().find(hasClass('dx-hint'))).includes('Trick Room'),
      chipsIn(root().find(hasClass('dx-hint'))).join(', '));
    // The species search must survive all of that -- there are zero
    // species/move name collisions, and this is what proves the claim holds.
    search.value = 'pikachu';
    search.oninput();
    ok('a species search is untouched by forgiving move matching',
      !/learn /.test(count()) && Number(/^(\d+)/.exec(count())?.[1] ?? 0) > 0, count());

        // ZERO LEARNERS IS AN ANSWER, AND "0" IS THE WRONG ONE. Draco Meteor has
    // no level-up learner and no TM in this ROM -- it is the Opelucid TUTOR
    // move, and tutors are not extracted. A bare count would tell a dragon
    // team it is unobtainable. Exactly two moves are in this state and the
    // other is Struggle.
    search.value = 'Draco Meteor';
    search.oninput();
    ok('a move nothing learns still resolves AS a move',
      /Draco Meteor/.test(root().find(hasClass('dx-movehit'))?.text ?? ''),
      count());
    const note = root().find(hasClass('dx-nolearn'));
    ok('...and says a tutor may teach it rather than implying nobody can',
      !!note && /tutor/i.test(note.text), note?.text ?? 'no dx-nolearn note');
    // The note must be ABSENT when there are learners, or it is decoration
    // rather than an answer.
    search.value = 'Ice Beam';
    search.oninput();
    ok('...and that note is absent when the move HAS learners',
      !root().find(hasClass('dx-nolearn')), 'note must not be unconditional');
  }

  search.value = 'pikachu';
  search.oninput();
  ok('searching by name finds it',
    root().findAll(hasClass('dx-row')).some((r) => /Pikachu/.test(r.text)));
  search.value = '';
  search.oninput();

  // Ownership is the one thing that needs the save.
  const anyOwned = root().findAll(hasClass('dx-own'));
  ok('species you own are marked', anyOwned.length > 0, `${anyOwned.length} marked`);

  // The handoff to the Factory: a one-shot message, not a persistent flag.
  const build = btn(root(), /Build one in the Factory/);
  ok('there is a way into the Factory from a species card', Boolean(build));
  build.click();
  const msg = JSON.parse(localStorage.getItem('bb_dexcreate') ?? 'null');
  ok('...and it hands over the species id', Number.isInteger(msg?.speciesId),
    JSON.stringify(msg));
}

console.log('\n── the tab, with NO save');
{
  reset();
  const panel = mount({ S });
  const root = panel.children[0];
  ok('it still mounts, because looking things up should not need a save',
    Boolean(root) && root.findAll(hasClass('dx-row')).length > 0);
  ok('...and offers no "mine only" filter it could not honour',
    !btn(root, /Mine only/));
  ok('...and no Factory handoff there is no Factory for',
    !btn(root, /Build one in the Factory/));
  ok('the tab declares it does not need a save', dexTab.needsSave === false);
}

console.log('\n── with no diff (extracted without a vanilla ROM)');
{
  reset();
  // The honest failure here is a Pokédex that silently implies nothing
  // changed, which is a lie about the hack rather than a missing feature.
  const S2 = { ...S };
  delete S2.DIFF;
  const panel = mount({ S: S2, factory: F ?? undefined });
  const root = panel.children[0];
  ok('it still renders', root.findAll(hasClass('dx-row')).length > 0);
  ok('...with no "changed from vanilla" mode offered', !btn(root, /Changed from the base game/));
  ok('...and no change dots claiming anything',
    root.findAll(hasClass('dx-dot')).length === 0);
  ok('...and no legend for a dot that is not there',
    !/changed from the base game/i.test(root.find(hasClass('dx-count'))?.text ?? ''));
  const first = root.findAll(hasClass('dx-row'))[0];
  first.click();
  ok('...and a species card has no change block',
    panel.children[0].findAll(hasClass('dx-changed')).length === 0);
}

if (S.DIFF?.species) {
  console.log('\n── the "what changed" view');
  reset();
  const panel = mount({ S, factory: F ?? undefined, goTo: () => {} });
  const root = () => panel.children[0];
  // The unfiltered total, read BEFORE switching modes -- the count line only
  // exists in the browse list, so reading it afterwards gets -1 and the
  // comparison below is meaningless.
  const total = () => Number(/^(\d+) species/.exec(
    root().find(hasClass('dx-count'))?.text ?? '')?.[1] ?? -1);
  const before = total();
  const mode = btn(root(), /Changed from the base game/);
  // THE LABEL MUST NAME WHAT IT COMPARES TO. "What changed" said nothing to
  // anyone who did not already know this app holds a vanilla ROM to diff
  // against, and the count is the fact that makes the mode worth opening.
  ok('the mode names what it compares against, in plain words', Boolean(mode));
  // `\b` is no good here: the stub concatenates label and count with no
  // separator ("Changed from vanilla610"), and letter-to-digit is not a word
  // boundary. The rendered page separates them with a pill; the assertion only
  // cares that the number is present.
  ok('...and carries the count, rather than hiding it in a tooltip',
    mode.text.includes(String(Object.keys(S.DIFF.species).length)), mode.text);
  ok('the change dot has a legend, so it is not a symbol you must decode',
    /changed from the base game/i.test(root().find(hasClass('dx-count'))?.text ?? ''));
  mode.click();
  const txt = root().text;
  // THEY ARE NOT BUTTONS ANY MORE, and that is the assertion. Eight controls
  // that all led to the same destination read as broken; the space carries a
  // proportion instead, which is the finding those numbers were reaching for.
  ok('it leads with the proportions', root().findAll(hasClass('dx-plab')).length >= 4,
    `${root().findAll(hasClass('dx-plab')).length} rows`);
  ok('...which are not clickable, because there is nowhere better to go',
    root().findAll(hasClass('dx-props')).every((n) => !n.onclick)
    && root().findAll((n) => n.tagName === 'BUTTON'
      && n.classList.contains('dx-plab')).length === 0);
  ok('...and each says what it is out of, not a bare count',
    root().findAll(hasClass('dx-pnum')).every((n) => / of /.test(n.text)),
    root().find(hasClass('dx-pnum'))?.text);
  ok('...and lists the biggest stat changes',
    root().findAll(hasClass('dx-brow')).length > 0);
  ok('...and every retyping', /Retyped/.test(txt)
    && root().findAll(hasClass('dx-retypes')).length === 1);
  ok('...and the rebalanced moves', /Moves rebalanced/.test(txt));
  // Getting to the filtered list is still possible -- through the browse
  // mode's own "Changed only" chip, which is a filter that looks like a
  // filter. That is the control the tiles were pretending to be.
  btn(root(), /^All Pokémon/).click();
  const chip = btn(root(), /Changed only/);
  ok('the filter people wanted lives in browse mode, looking like a filter',
    Boolean(chip));
  chip.click();
  const after = total();
  ok('...and it narrows the list to the changed species',
    after > 0 && after < before, `${before} → ${after} species`);
}

console.log(failed ? `\n  ${failed} check(s) FAILED` : '\n  all checks passed');
process.exit(failed ? 1 : 0);
