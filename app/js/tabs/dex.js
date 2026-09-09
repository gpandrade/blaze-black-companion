/**
 * tabs/dex.js -- the Pokédex, and what Drayano changed.
 *
 * =========================================================================
 * WHY THIS IS ITS OWN TAB AND NOT PART OF THE FACTORY
 * =========================================================================
 * The Factory's whole mental model is "this is my save": every operation in
 * it mutates a record. A reference to 649 species you mostly do not own makes
 * that model false, and the change data -- the most useful thing here -- is a
 * fact about the GAME, with no home in an editor at all. They are wired
 * together instead: a species card can start a build in the Factory, which is
 * the one direction that actually connects them.
 *
 * =========================================================================
 * IT WORKS WITH NO SAVE
 * =========================================================================
 * `needsSave: false`, and it is the only tab like that. Someone who wants to
 * know what this hack did to Farfetch'd should not have to load a save first.
 * Everything about YOUR copies -- how many you own, where they are -- is
 * additive, and simply absent until a save is loaded.
 *
 * =========================================================================
 * THE CHANGE DATA IS THE POINT
 * =========================================================================
 * Every other source for this hack is a wiki generated from a modern Pokémon
 * dataset, and it is wrong wherever the games changed after Gen 5 -- 63 moves
 * with the wrong power, every Steel-type's defences computed on the Gen 6
 * chart, 22 species typed Fairy in a game with no Fairy type. This tab reads
 * `state/personal.json`, extracted from the cartridge, and `DIFF`, which is
 * that table diffed against an unmodified Black ROM. So it can say what
 * changed, exactly, with both numbers side by side.
 *
 * `DIFF` is OPTIONAL. `extract_personal.py` refuses to emit a diff without a
 * vanilla ROM to compare against, and someone who extracted that way should
 * see a Pokédex with no change badges rather than one quietly claiming
 * nothing changed.
 */

import { buildIndex } from '../teams.js';
import { rich } from '../rich.js';
import { gate } from '../nuzlocke.js';
import { shackle } from '../shackle.js';

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const STAT_LABEL = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
// The highest single base stat in Gen 5 is Blissey's 255 HP; Shuckle's 230
// defences are the next. A fixed ceiling keeps the bars comparable BETWEEN
// species, which is the whole reason to draw them.
const STAT_MAX = 255;
const PREF = 'blazeblack.dex.view';
const HANDOFF = 'bb_dexcreate';

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'checked' || k === 'value') n[k] = v;
    else if (k.startsWith('aria-') || k === 'role' || k === 'type' || k === 'title'
      || k === 'placeholder' || k === 'loading' || k === 'alt' || k === 'src'
      || k === 'tabindex' || k === 'style') n.setAttribute(k, v);
    else n[k] = v;
  }
  n.append(...kids.filter((x) => x != null));
  return n;
};

let S = null, F = null, CTX = null, root = null, NUZ = null;
let searchEl = null;            // the live box, so a hint chip can fill it
let owned = new Map();          // speciesId -> [{loc, index, mon}]
let view = {
  q: '', type: '', sort: 'dex', changedOnly: false, ownedOnly: false,
  sel: null, mode: 'browse',
};

const sp = (id) => S.SPECIES[String(id)] ?? null;

/**
 * MOVE-FIRST SEARCH: who learns this, and how.
 *
 * "Which of mine can learn Trick Room" is a question the game itself cannot
 * answer and the wiki answers 649 pages at a time. Everything needed is
 * already in the blob -- the level-up list per species, the TM/HM list, and
 * the TM-to-move map -- so this is a join, not new data.
 *
 * IT MUST COUNT TMs. The level-up list alone answers a different and much less
 * useful question: most of what you actually teach comes from a Machine, and a
 * search that said "nothing you own learns Ice Beam" while TM13 sat in your
 * bag would be worse than no search at all.
 *
 * Returns null when the query is not a move, so the caller can fall back to
 * an ordinary name search.
 *
 * IT USED TO REQUIRE THE WHOLE NAME, EXACTLY, and that was wrong. The stated
 * reason was that a substring makes "ice" mean Ice Beam, Ice Punch, Ice Fang
 * and three others at once -- true, and it does not follow that the answer is
 * to match nothing until the final letter. Reported as "too stiff: I had to
 * type the full move name".
 *
 * So it RESOLVES PROGRESSIVELY instead. Names are compared with punctuation
 * and spaces stripped from both sides, so `vcre`, `V-create` and `v create`
 * are the same query, and the search fires the moment a prefix is unambiguous:
 * `trick r` is Trick Room, `earthq` is Earthquake, `dragon d` is Dragon Dance.
 * While several still match, none is chosen -- they are offered as chips and
 * the species search underneath is left alone.
 *
 * An exact match always wins over a longer name that merely starts the same
 * way, or typing `Trick` could never mean Trick: Trick Room would be equally
 * eligible and the shorter, exactly-named move would be unreachable.
 *
 * Safe because there are ZERO species/move name collisions in this ROM --
 * checked across all 649 and all 559 -- so a forgiving move match can never
 * hijack somebody looking for a Pokemon.
 */
const normMove = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Every move the query could mean: the exact hit, and the rest by prefix then
 * substring. Under three characters nothing is offered -- "ic" is a keystroke,
 * not a question.
 */
function moveCandidates(q) {
  const t = normMove(q ?? '');
  if (t.length < 3) return { exact: null, others: [] };
  let exact = null;
  const pre = [], sub = [];
  for (const [id, name] of Object.entries(S.MOVEBYID ?? {})) {
    if (!name || name === '--') continue;
    const n = normMove(name);
    if (n === t) exact = [id, name];
    else if (n.startsWith(t)) pre.push([id, name]);
    else if (n.includes(t)) sub.push([id, name]);
  }
  // Prefix before substring: "beam" should offer Ice Beam, but "beam" as the
  // START of a name is the stronger reading wherever one exists.
  return { exact, others: [...pre, ...sub] };
}

/** The one move a candidate set resolves to, or null while it is ambiguous. */
function resolveMove(cands) {
  const hit = cands.exact ?? (cands.others.length === 1 ? cands.others[0] : null);
  if (!hit) return null;
  const [idStr, name] = hit;
  const id = Number(idStr);
  // Which TM or HM teaches it, if any. TMMOVE is label -> move id.
  const tm = Object.entries(S.TMMOVE ?? {}).find(([, m]) => Number(m) === id)?.[0] ?? null;
  return { id, name, tm, data: S.MOVES?.[name] ?? null };
}

function moveQuery(q) { return resolveMove(moveCandidates(q)); }

/** How a given species learns it: a level, a TM label, or null. */
function learnsHow(species, mq) {
  if (!mq) return null;
  const lv = (species.lvl ?? []).find(([, m]) => Number(m) === mq.id);
  if (lv) return { how: 'level', at: lv[0] };
  if (mq.tm && (species.tmhm ?? []).includes(mq.tm)) return { how: 'tm', at: mq.tm };
  return null;
}
const diffOf = (id) => S.DIFF?.species?.[String(id)] ?? null;
const hasDiff = () => Boolean(S.DIFF?.species);

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREF) ?? '{}');
    if (p && typeof p === 'object') view = { ...view, ...p, sel: p.sel ?? null };
  } catch { /* private mode */ }
}
function savePrefs() {
  try {
    localStorage.setItem(PREF, JSON.stringify({
      type: view.type, sort: view.sort, changedOnly: view.changedOnly,
      ownedOnly: view.ownedOnly, sel: view.sel, mode: view.mode,
    }));
  } catch { /* private mode */ }
}

// ==========================================================================
function render() {
  root.replaceChildren(
    toolbar(),
    view.mode === 'changes'
      ? changesView()
      : el('div', { class: 'dx-main' }, listPane(), detailPane()));
}

function toolbar() {
  const bar = el('div', { class: 'dx-bar' });

  // THE LABEL HAS TO SAY WHAT IT IS COMPARED TO.
  // It read "What changed", which is only meaningful if you already know this
  // is a ROM hack and that the app has the vanilla ROM to diff against --
  // changed from what, since when, by whom? Naming vanilla in the label
  // answers all three, and the count carries the scale, which is the fact that
  // makes the tab worth opening at all.
  const changed = Object.keys(S.DIFF?.species ?? {}).length;
  const modes = el('div', { class: 'dx-modes', role: 'tablist' });
  for (const [id, label, sub, tip] of [
    ['browse', 'All Pokémon', '649',
      'Every species, exactly as your ROM has it'],
    ['changes', 'Changed from the base game', String(changed),
      `What this hack altered against an unmodified Pokémon Black — ${changed} species`],
  ]) {
    if (id === 'changes' && !hasDiff()) continue;
    const b = el('button', {
      class: `dx-mode${view.mode === id ? ' on' : ''}`, type: 'button', title: tip,
      role: 'tab', 'aria-selected': String(view.mode === id),
    }, label, el('i', {}, sub));
    b.onclick = () => { view.mode = id; savePrefs(); render(); };
    modes.append(b);
  }
  bar.append(modes);

  if (view.mode !== 'browse') return bar;


  const q = el('input', { class: 'dx-search', type: 'search', value: view.q,
    // "or a move" was the LAST clause of a list, which is where a reader stops
    // reading. Naming the move case as a second sentence is the only part of
    // the placeholder anyone was going to notice.
    placeholder: 'A species or dex number — or a move, to see who learns it',
    'aria-label': 'Search species, or a move to see which species learn it' });
  q.oninput = () => { view.q = q.value; redrawList(); };
  searchEl = q;
  bar.append(q);

  const types = el('select', { class: 'dx-sel', 'aria-label': 'Filter by type' },
    el('option', { value: '' }, 'Any type'),
    ...S.TYPES.map((t) => el('option', { value: t }, cap(t))));
  types.value = view.type;
  types.onchange = () => { view.type = types.value; savePrefs(); redrawList(); };
  bar.append(types);

  const sort = el('select', { class: 'dx-sel', 'aria-label': 'Sort' },
    el('option', { value: 'dex' }, 'Dex number'),
    el('option', { value: 'name' }, 'Name'),
    el('option', { value: 'bst' }, 'Total stats'),
    ...(hasDiff() ? [el('option', { value: 'buff' }, 'Biggest buff')] : []));
  sort.value = view.sort;
  sort.onchange = () => { view.sort = sort.value; savePrefs(); redrawList(); };
  bar.append(sort);

  if (hasDiff()) bar.append(toggle('changedOnly', 'Changed only',
    'Only species this hack altered'));
  if (F) bar.append(toggle('ownedOnly', 'Mine only', 'Only species in your save'));
  return bar;
}

function toggle(key, label, tip) {
  const b = el('button', { class: `dx-chip${view[key] ? ' on' : ''}`, type: 'button',
    title: tip, 'aria-pressed': String(Boolean(view[key])) }, label);
  b.onclick = () => { view[key] = !view[key]; savePrefs(); render(); };
  return b;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ---------------------------------------------------------------- the list
function rows() {
  const q = view.q.trim().toLowerCase();
  let out = Object.entries(S.SPECIES).map(([id, v]) => ({ id: Number(id), ...v }));
  const mq = moveQuery(q);
  if (mq) {
    // A move name is a DIFFERENT QUESTION from a species name, so it gets a
    // different answer: everything that learns it, by level-up or by a Machine.
    out = out.filter((r) => Boolean(learnsHow(r, mq)));
  } else if (q) {
    const asNum = Number(q);
    out = out.filter((r) => r.name.toLowerCase().includes(q)
      || (Number.isFinite(asNum) && asNum > 0 && r.id === asNum));
  }
  if (view.type) out = out.filter((r) => (r.types ?? []).includes(view.type));
  if (view.changedOnly) out = out.filter((r) => diffOf(r.id));
  if (view.ownedOnly) out = out.filter((r) => owned.has(r.id));
  const buff = (r) => {
    const d = diffOf(r.id);
    return d?.bst ? d.bst[1] - d.bst[0] : 0;
  };
  const cmp = {
    dex: (a, b) => a.id - b.id,
    name: (a, b) => a.name.localeCompare(b.name),
    bst: (a, b) => (b.bst ?? 0) - (a.bst ?? 0) || a.id - b.id,
    buff: (a, b) => buff(b) - buff(a) || a.id - b.id,
  }[view.sort] ?? ((a, b) => a.id - b.id);
  return out.sort(cmp);
}

function listPane() {
  const wrap = el('div', { class: 'dx-listwrap' });
  wrap.append(el('div', { class: 'dx-list', id: 'dx-list' }));
  redrawList(wrap);
  return wrap;
}

/** Redraw only the list. Retyping in the search box must not rebuild the
 *  toolbar, or the input loses focus on every keystroke. */
function redrawList(scope = root) {
  const host = scope.querySelector?.('#dx-list') ?? root.querySelector('#dx-list');
  if (!host) return;
  const rs = rows();
  const cands = moveCandidates(view.q);
  const mq = resolveMove(cands);
  // What else the query could have meant. With a move resolved these are the
  // roads not taken; without one they are the whole offer.
  // NAMES, not [id, name] pairs -- moveChips renders what it is handed, and a
  // pair renders as an empty button.
  const alts = cands.others.map(([, n]) => n).filter((n) => n !== mq?.name);
  // THE DOT NEEDED A LEGEND. A coloured dot on a row is a symbol nobody can
  // read without being told, and "dig in to find out" is exactly the failure
  // being fixed here.
  host.replaceChildren(
    // A MOVE SEARCH SAYS SO. Without a banner the list looks like a name
    // search that matched a surprising set, and the column showing "L37" or
    // "TM13" where the stat total normally sits has nothing explaining it.
    // NOBODY FOUND IT. The move search was reachable only by typing a move
    // name into a box captioned for species, which is a feature you have to
    // already know about to use. So it advertises itself with the thing it is
    // good at, and you get there by PRESSING a chip rather than by reading a
    // sentence -- the same route the rest of this app teaches by.
    //
    // The examples are deliberately STRATEGY moves and deliberately mixed:
    // Trick Room is 85 species by TM and one by level-up, Dragon Dance is 30
    // by level-up and no TM at all. Between them they show both answers the
    // column can give.
    // AMBIGUOUS IS NOT NOTHING. While "ice" could be six moves the search
    // stays out of the way -- the species list below is untouched -- but the
    // six are offered, so the way forward is a click rather than another
    // guess at spelling. This is the case the old exact-match rule handled by
    // showing no sign that a move search existed at all.
    ...(mq || !alts.length ? [] : [moveChips(`"${view.q.trim()}" could be a move:`, alts)]),
    ...(mq || alts.length ? [] : [moveHint()]),
    ...(mq ? [el('div', { class: 'dx-movehit' },
      el('b', {}, mq.name),
      mq.data ? el('span', { class: `dx-t t-${mq.data.t}` }, mq.data.t) : null,
      mq.data ? el('span', { class: 'dx-mvmeta' },
        `${mq.data.c ?? ''} · ${mq.data.p || '—'} power · ${mq.data.acc || '—'}% accurate`) : null,
      el('span', { class: 'dx-mvmeta' },
        mq.tm ? `taught by ${mq.tm}` : 'no TM teaches it'))] : []),
    // A PREFIX THAT RESOLVED MAY STILL HAVE MEANT SOMETHING ELSE. Typing
    // "trick" lands on Trick, and Trick Room has to stay one click away rather
    // than requiring you to know it was competing.
    ...(mq && alts.length ? [moveChips('Or:', alts)] : []),
    el('p', { class: 'dx-count' },
      mq ? `${rs.length} learn ${mq.name}`
        : `${rs.length} species${rs.length === 649 ? '' : ' of 649'}`,
      hasDiff()
        ? el('span', { class: 'dx-legend' },
          el('span', { class: 'dx-dot' }), ' changed from the base game')
        : null),
    // NOBODY LEARNS IT IS NOT THE SAME AS NOBODY CAN GET IT. Exactly two moves
    // in the game have neither a level-up learner nor a TM: Struggle, which is
    // a mechanic, and Draco Meteor, which is the Opelucid TUTOR move -- and
    // move tutors are not extracted. A bare "0 learn Draco Meteor" would tell
    // a dragon team it is unobtainable, which is false. Say what we don't know.
    ...(mq && !rs.length ? [el('p', { class: 'dx-nolearn' },
      'Nothing learns this by level-up or TM. It may be a ',
      el('b', {}, 'move tutor'),
      " move — this app has no tutor data, so it cannot say where.")] : []),
    ...rs.slice(0, 400).map((r) => listRow(r, mq)),
    rs.length > 400
      ? el('p', { class: 'dx-count' }, `…and ${rs.length - 400} more — narrow the search`)
      : null);
}

/**
 * "You can search by move" -- as three buttons that do it.
 *
 * Absent once a move search is running: it has done its job, and the banner
 * above the list is already saying which move is in force.
 */
function moveChips(label, names) {
  const row = el('div', { class: 'dx-hint' }, el('span', { class: 'dx-hintlab' }, label));
  // Capped: "a" would otherwise put 559 buttons on the page. Past a handful
  // the list has stopped being a suggestion and become a second problem.
  for (const name of names.slice(0, 8)) {
    const c = el('button', { class: 'dx-chip', type: 'button' }, name);
    c.onclick = () => {
      view.q = name;
      // Fill the LIVE box rather than rebuilding the toolbar -- rebuilding is
      // what made every other search in this app lose focus after a letter.
      if (searchEl) { searchEl.value = name; searchEl.focus(); }
      redrawList();
    };
    row.append(c);
  }
  if (names.length > 8) row.append(el('span', { class: 'dx-hintlab' },
    `+${names.length - 8} more`));
  return row;
}

function moveHint() {
  // Only offer an example the ROM actually has. A chip that searches for
  // nothing would teach the opposite lesson.
  const have = ['Trick Room', 'Dragon Dance', 'Stealth Rock']
    .filter((n) => Object.values(S.MOVEBYID ?? {}).includes(n));
  return moveChips('Search a move to see who learns it:', have);
}

function listRow(r, mq = null) {
  const d = diffOf(r.id);
  const mine = owned.get(r.id);
  const how = learnsHow(r, mq);
  const b = el('button', {
    class: `dx-row${view.sel === r.id ? ' on' : ''}`, type: 'button',
    'aria-selected': String(view.sel === r.id),
  },
  el('span', { class: 'dx-num' }, String(r.id).padStart(3, '0')),
  S.SPRITE[r.name]
    ? el('img', { class: 'dx-sp', src: S.SPRITE[r.name], alt: '', loading: 'lazy' })
    : el('span', { class: 'dx-sp' }),
  el('span', { class: 'dx-rname' }, r.name),
  el('span', { class: 'dx-rtypes' }, ...(r.types ?? []).map(typePill)),
  how
    ? el('span', { class: `dx-how ${how.how}` },
      how.how === 'tm' ? how.at : (how.at <= 1 ? 'start' : `L${how.at}`))
    : el('span', { class: 'dx-rbst' }, String(r.bst ?? '—')),
  d ? el('span', { class: 'dx-dot', title: 'Changed by this hack' }) : null,
  mine ? el('span', { class: 'dx-own', title: `You have ${mine.length}` },
    mine.length > 1 ? `×${mine.length}` : '✓') : null);
  b.onclick = () => { view.sel = r.id; savePrefs(); render(); };
  return b;
}

const typePill = (t) => el('span', { class: `dx-t t-${t}` }, cap(t));

const METHOD_LABEL = {
  'grass-normal': 'tall grass', 'grass-doubles': 'doubles grass',
  'grass-special': 'shaking grass', 'surf-normal': 'surfing',
  'surf-special': 'rippling water', 'fishing-normal': 'fishing',
  'fishing-special': 'rippling water (rod)', 'cave-normal': 'cave',
  'cave-special': 'dust cloud', 'bridge-special': 'bridge shadow',
  'puddle-normal': 'puddles', 'rocky-grass': 'rocky grass',
  'sand-normal': 'sand', 'tower-normal': 'tower',
};

// -------------------------------------------------------------- the detail
function detailPane() {
  const wrap = el('div', { class: 'dx-detail' });
  const r = view.sel ? sp(view.sel) : null;
  if (!r) {
    wrap.append(el('p', { class: 'dx-empty' },
      'Pick a species. Everything here comes from the ROM you extracted — base '
      + 'stats, both types, all three abilities, the level-up moveset, TM '
      + 'compatibility and evolution methods'
      + (hasDiff() ? ', with everything this hack changed from the base game marked.' : '.')));
    // THE SUMMARY, WHERE THE DEAD SPACE WAS. The comparison used to be
    // reachable only by switching modes, which is a thing you do once you
    // already know it exists. This puts the headline in the pane that is
    // otherwise a single paragraph, so the scale of the hack is the first
    // thing you see on the tab -- and the mode switch becomes somewhere you go
    // for the detail rather than somewhere you have to find.
    if (hasDiff()) {
      const c = S.DIFF.counts ?? {};
      const total = Object.keys(S.SPECIES).length;
      const n = Object.keys(S.DIFF.species).length;
      const box = el('div', { class: 'dx-block' },
        el('h4', {}, 'How much this hack changed'),
        el('p', { class: 'dx-lede' },
          el('b', {}, `${n} of ${total} species`), ' differ from the base game — '
          + `${c.base_stats ?? 0} with new base stats, ${c.abilities ?? 0} with new `
          + `abilities, ${c.types ?? 0} retyped, and ${c.moves ?? 0} moves rebalanced.`));
      const go = el('button', { class: 'dx-go', type: 'button' }, 'See what changed');
      go.onclick = () => { view.mode = 'changes'; savePrefs(); render(); };
      box.append(go);
      wrap.append(box);
    }
    return wrap;
  }
  const id = view.sel;
  const d = diffOf(id);
  wrap.append(detailHead(id, r, d), statBlock(r, d), abilityBlock(r, d));
  if (d) wrap.append(changeBlock(id, r, d));
  wrap.append(evoBlock(r), whereBlock(r), learnBlock(r, d), tmBlock(r, d),
    heldBlock(r), breedBlock(r));
  return wrap;
}

function detailHead(id, r, d) {
  const mine = owned.get(id) ?? [];
  const head = el('div', { class: 'dx-head' },
    el('div', { class: 'dx-art' },
      S.SPRITE[r.name] ? el('img', { src: S.SPRITE[r.name], alt: r.name }) : el('span', {}, '?')),
    el('div', { class: 'dx-hmeta' },
      el('h3', {}, r.name, el('span', { class: 'dx-hnum' }, `#${String(id).padStart(3, '0')}`)),
      el('div', { class: 'dx-htypes' }, ...(r.types ?? []).map(typePill)),
      d ? el('p', { class: 'dx-hchanged' },
        `Changed by this hack: ${changeSummary(d)}.`) : null,
      mine.length
        ? el('p', { class: 'dx-hown' },
          `You have ${mine.length} — ${[...new Set(mine.map((m) => locLabel(m.loc)))].join(', ')}.`)
        : el('p', { class: 'dx-hown dim' },
          F ? 'None in your save.' : 'Load a save to see whether you have one.')));

  if (F) {
    const b = el('button', { class: 'dx-go', type: 'button',
      title: 'Open the Factory’s builder with this species already chosen' },
    'Build one in the Factory');
    b.onclick = () => {
      try { localStorage.setItem(HANDOFF, JSON.stringify({ speciesId: id })); }
      catch { /* private mode: the Factory just opens where it was */ }
      CTX?.goTo?.('factory');
    };
    // A nuzlocke that forbids creating forbids it from here too. Naming the
    // action rather than the tab is what makes one rule close both doors.
    shackle(b, gate(NUZ, 'dex.build'));
    head.append(b);
  }
  return head;
}

function locLabel(loc) {
  if (loc === 'party') return 'your party';
  if (loc === 'battleBox') return 'the Battle Box';
  return `Box ${loc + 1}`;
}

function changeSummary(d) {
  const bits = [];
  if (d.stats) {
    const delta = d.bst ? d.bst[1] - d.bst[0] : 0;
    bits.push(`base stats${delta ? ` (${delta > 0 ? '+' : ''}${delta} BST)` : ''}`);
  }
  if (d.types) bits.push('typing');
  if (d.abilities) bits.push('abilities');
  if (d.hidden) bits.push('hidden ability');
  if (d.learn) bits.push('level-up moves');
  if (d.tmhm) bits.push('TM compatibility');
  if (d.evo) bits.push('evolution');
  if (d.base_exp) bits.push('EXP yield');
  if (d.curve) bits.push('growth curve');
  return bits.join(', ');
}

function statBlock(r, d) {
  const box = el('div', { class: 'dx-block' },
    el('h4', {}, 'Base stats',
      el('span', { class: 'dx-bst' }, `${r.bst ?? '—'} total`,
        d?.bst ? el('i', { class: d.bst[1] > d.bst[0] ? 'up' : 'down' },
          ` ${d.bst[1] > d.bst[0] ? '+' : ''}${d.bst[1] - d.bst[0]}`) : null)));
  const grid = el('div', { class: 'dx-stats' });
  for (const k of STAT_KEYS) {
    const v = r.base?.[k] ?? 0;
    const ch = d?.stats?.[k] ?? null;
    grid.append(
      el('span', { class: 'dx-sk' }, STAT_LABEL[k]),
      el('span', { class: 'dx-sv' }, String(v),
        ch ? el('i', { class: ch[1] > ch[0] ? 'up' : 'down' },
          ` was ${ch[0]}`) : null),
      // The bar is a fixed-ceiling scale (255) so two species can be compared
      // by eye; a per-species max would make every Pokemon look the same shape.
      // `dx-sbar`, not `dx-bar` -- the toolbar owns that name.
      el('span', { class: `dx-sbar${ch ? (ch[1] > ch[0] ? ' up' : ' down') : ''}` },
        el('i', { style: `width:${Math.max(1, Math.round((v / STAT_MAX) * 100))}%` })));
  }
  box.append(grid);
  return box;
}

function abilityBlock(r, d) {
  const box = el('div', { class: 'dx-block' }, el('h4', {}, 'Abilities'));
  const list = el('ul', { class: 'dx-abils' });
  for (const a of r.abilities ?? []) {
    list.append(el('li', {}, el('b', {}, a),
      S.ABIL?.[a] ? el('span', {}, rich(S.ABIL[a])) : null));
  }
  if (r.hidden) {
    list.append(el('li', { class: 'hidden' }, el('b', {}, r.hidden),
      el('em', {}, 'hidden'),
      S.ABIL?.[r.hidden] ? el('span', {}, rich(S.ABIL[r.hidden])) : null));
  }
  box.append(list);
  if (d?.abilities) {
    box.append(el('p', { class: 'dx-was' },
      `Vanilla: ${(d.abilities[0] ?? []).join(', ') || '—'}`));
  }
  if (d?.hidden) {
    box.append(el('p', { class: 'dx-was' },
      `Vanilla hidden ability: ${d.hidden[0] ?? '—'}`));
  }
  return box;
}

/** The headline block: vanilla beside hack, for everything that moved. */
function changeBlock(id, r, d) {
  const box = el('div', { class: 'dx-block dx-changed' },
    el('h4', {}, 'Changed from the base game'));
  const rows2 = [];
  const add = (what, was, now) => rows2.push(
    el('span', { class: 'dx-cw' }, what),
    el('span', { class: 'dx-co' }, was),
    el('span', { class: 'dx-cn' }, now));

  if (d.types) {
    add('Typing', d.types[0].map(cap).join(' / '), d.types[1].map(cap).join(' / '));
  }
  if (d.stats) {
    for (const k of STAT_KEYS) {
      if (d.stats[k]) add(STAT_LABEL[k], String(d.stats[k][0]), String(d.stats[k][1]));
    }
    if (d.bst) add('Total', String(d.bst[0]), String(d.bst[1]));
  }
  if (d.abilities) {
    add('Abilities', (d.abilities[0] ?? []).join(', ') || '—',
      (d.abilities[1] ?? []).join(', ') || '—');
  }
  if (d.hidden) add('Hidden ability', d.hidden[0] ?? '—', d.hidden[1] ?? '—');
  if (d.base_exp) add('EXP yield', String(d.base_exp[0]), String(d.base_exp[1]));
  if (d.curve) add('Growth curve', d.curve[0], d.curve[1]);
  for (const e of d.evo ?? []) add(`Evolves into ${e.into}`, e.was || '—', e.now || '—');
  if (rows2.length) box.append(el('div', { class: 'dx-ctable' }, ...rows2));

  const moveNames = (ids) => ids.map((m) => S.MOVEBYID[String(m)] ?? `#${m}`);
  if (d.learn) {
    const [lost, gained] = d.learn;
    if (gained?.length) {
      box.append(el('p', { class: 'dx-gain' },
        el('b', {}, 'Level-up moves gained: '), moveNames(gained).join(', ')));
    }
    if (lost?.length) {
      box.append(el('p', { class: 'dx-lose' },
        el('b', {}, 'No longer learns: '), moveNames(lost).join(', ')));
    }
  }
  if (d.tmhm) {
    const [lost, gained] = d.tmhm;
    if (gained?.length) {
      box.append(el('p', { class: 'dx-gain' },
        el('b', {}, 'TMs gained: '), gained.join(', ')));
    }
    if (lost?.length) {
      box.append(el('p', { class: 'dx-lose' },
        el('b', {}, 'TMs lost: '), lost.join(', ')));
    }
  }
  return box;
}

const EVO_METHOD = {
  'level-up': (p) => `at level ${p}`,
  'level-up-item-day': (p) => `level up during the day holding ${itemName(p)}`,
  'level-up-item-night': (p) => `level up at night holding ${itemName(p)}`,
  'use-item': (p) => `use ${itemName(p)}`,
  trade: () => 'trade',
  'trade-with-item': (p) => `trade holding ${itemName(p)}`,
  'level-up-friendship': () => 'level up with high friendship',
  'level-up-know-move': (p) => `level up knowing ${S.MOVEBYID?.[String(p)] ?? `move ${p}`}`,
};
const itemName = (p) => S.ITEMS?.[String(p)] ?? `item ${p}`;

function evoBlock(r) {
  const evos = r.evoFull ?? [];
  const box = el('div', { class: 'dx-block' }, el('h4', {}, 'Evolution'));
  if (!evos.length) {
    box.append(el('p', { class: 'dx-none' }, 'Does not evolve.'));
    return box;
  }
  const list = el('ul', { class: 'dx-evos' });
  for (const e of evos) {
    const how = EVO_METHOD[e.method]?.(e.param) ?? `${e.method} ${e.param}`.trim();
    const li = el('li', {}, el('b', {}, e.into), ` — ${how}`);
    // THE FOUR DISPUTED ONES. The ROM stores method 20 (level-up-know-move)
    // with an ITEM id as the parameter, which is unambiguously a typo for
    // method 19; but if the game honours what is written it will check "knows
    // move 221" and the evolution will never fire. Neither reading is
    // established, so it says so instead of picking one.
    if (e.method === 'level-up-know-move' && (S.ITEMS?.[String(e.param)])
      && !(S.MOVEBYID?.[String(e.param)])) {
      li.append(el('p', { class: 'dx-dispute' },
        'Disputed. The ROM stores this as "knows move '
        + `${e.param}", but ${e.param} is an item id (${itemName(e.param)}) — so the `
        + 'intent is plainly "level up at night holding it", and Drayano’s docs say '
        + 'so. Whether the game honours the intent or the bytes is untested.'));
    }
    list.append(li);
  }
  box.append(list);
  return box;
}

/** Where you can catch it, from the same area index the Adventure tab uses. */
function whereBlock(r) {
  const box = el('div', { class: 'dx-block' }, el('h4', {}, 'Where it appears'));
  // AREAS rows carry species IDS and a percentage, so match on the id rather
  // than the name -- names in an encounter table are the one thing that is not
  // guaranteed to be spelled the way the species table spells them.
  const want = view.sel;
  const hits = [];
  for (const [area, rowsFor] of Object.entries(S.AREAS ?? {})) {
    for (const row of rowsFor) {
      for (const m of row.mons ?? []) {
        if (m.id === want) {
          hits.push({ area, method: row.method, pct: m.pct, suspect: row.suspect });
        }
      }
    }
  }
  if (!hits.length) {
    box.append(el('p', { class: 'dx-none' },
      'Not in any wild encounter table — evolve, trade or receive it. '
      + 'Hidden and event Pokémon are not extracted.'));
    return box;
  }
  const byArea = new Map();
  for (const h of hits) byArea.set(h.area, [...(byArea.get(h.area) ?? []), h]);
  const list = el('ul', { class: 'dx-where' });
  for (const [area, hs] of [...byArea].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.append(el('li', {}, el('b', {}, area), ' — ',
      hs.map((h) => `${METHOD_LABEL[h.method] ?? h.method}`
        // A row that totals well over 100% has a legendary or special
        // encounter merged into it by the wiki's generator, and the inflated
        // number is a LEVEL rather than a rate. Saying the percentage there
        // would be repeating the defect.
        + (h.pct && !h.suspect ? ` ${h.pct}%` : '')).join(', '),
      hs.some((h) => h.suspect)
        ? el('em', { class: 'dx-suspect' },
          ' — rate not shown: this row has a static encounter merged into it')
        : null));
  }
  box.append(list);
  return box;
}

function learnBlock(r, d) {
  const box = el('div', { class: 'dx-block' },
    el('h4', {}, 'Level-up moves',
      el('span', { class: 'dx-sub' }, `${(r.lvl ?? []).length}`)));
  const gained = new Set(d?.learn?.[1] ?? []);
  const tbl = el('div', { class: 'dx-moves' });
  for (const [level, mid] of r.lvl ?? []) {
    // MOVES is keyed by NAME, with short field names (t/c/p/acc/pp/pri) --
    // the shape the battle sheet's damage maths already consumes.
    const name = S.MOVEBYID?.[String(mid)] ?? `#${mid}`;
    const m = S.MOVES?.[name] ?? null;
    tbl.append(
      el('span', { class: 'dx-mlv' }, level <= 1 ? '—' : String(level)),
      el('span', { class: `dx-mn${gained.has(mid) ? ' new' : ''}` }, name,
        gained.has(mid) ? el('i', { title: 'Added by this hack' }, 'new') : null),
      el('span', { class: `dx-t t-${m?.t ?? ''}` }, m?.t ? cap(m.t) : '—'),
      el('span', { class: 'dx-mp' }, m?.p ? String(m.p) : '—'),
      el('span', { class: 'dx-mp' }, m?.acc ? String(m.acc) : '—'));
  }
  box.append(tbl);
  return box;
}

function tmBlock(r, d) {
  const list = r.tmhm ?? [];
  const box = el('div', { class: 'dx-block' },
    el('h4', {}, 'TMs & HMs', el('span', { class: 'dx-sub' }, String(list.length))));
  if (!list.length) {
    box.append(el('p', { class: 'dx-none' }, 'Learns no TM or HM.'));
    return box;
  }
  const gained = new Set(d?.tmhm?.[1] ?? []);
  const wrap = el('div', { class: 'dx-tms' });
  for (const label of list) {
    const move = S.TMMOVE?.[label] ? (S.MOVEBYID?.[String(S.TMMOVE[label])] ?? '') : '';
    wrap.append(el('span', { class: `dx-tm${gained.has(label) ? ' new' : ''}`,
      title: move }, label, move ? el('i', {}, move) : null));
  }
  box.append(wrap);
  return box;
}

function heldBlock(r) {
  const h = r.wild_held_items ?? {};
  const any = ['common', 'rare', 'dark_grass'].some((k) => h[k]);
  if (!any) return null;
  return el('div', { class: 'dx-block' },
    el('h4', {}, 'Carries in the wild'),
    el('ul', { class: 'dx-held' },
      h.common ? el('li', {}, el('b', {}, h.common), ' — 50% of wild ones') : null,
      h.rare ? el('li', {}, el('b', {}, h.rare), ' — 5%') : null,
      h.dark_grass ? el('li', {}, el('b', {}, h.dark_grass), ' — 1%, dark grass only') : null));
}

function breedBlock(r) {
  const eg = (r.eggs ?? []).map((g) => S.EGGGROUP?.[String(g)] ?? `#${g}`);
  const ratio = genderText(r.ratio);
  const ev = Object.entries(r.ev ?? {}).filter(([, v]) => v)
    .map(([k, v]) => `${v} ${STAT_LABEL[k]}`).join(', ');
  const pair = (k, v) => [el('span', { class: 'dx-fk' }, k), el('span', { class: 'dx-fv' }, v)];
  return el('div', { class: 'dx-block' },
    el('h4', {}, 'Everything else'),
    el('div', { class: 'dx-facts' },
      ...pair('Catch rate', String(r.catch ?? '—')),
      ...pair('EXP yield', String(r.exp ?? '—')),
      ...pair('Growth curve', r.curveName ?? '—'),
      ...pair('EV yield', ev || 'none'),
      ...pair('Gender', ratio),
      ...pair('Egg groups', [...new Set(eg)].join(', ') || '—'),
      ...pair('Hatch cycles', String(r.hatch ?? '—')),
      ...pair('Base friendship', String(r.friend ?? '—'))));
}

/** The ROM stores a female-chance byte, plus three sentinel values. */
function genderText(ratio) {
  if (ratio === 255) return 'Genderless';
  if (ratio === 0) return 'Always male';
  if (ratio === 254) return 'Always female';
  if (ratio == null) return '—';
  const f = Math.round((ratio / 255) * 1000) / 10;
  return `${(100 - f).toFixed(1)}% male / ${f.toFixed(1)}% female`;
}

// ------------------------------------------------------- what changed, all
function changesView() {
  const c = S.DIFF?.counts ?? {};
  const wrap = el('div', { class: 'dx-changes' });
  wrap.append(el('p', { class: 'dx-lede' },
    'This hack against the base game it was built from, read from both ROMs '
    + 'side by side. It is why nothing in this app is answered from memory or '
    + 'from a wiki: almost everything moved.'));

  // NOT BUTTONS. They were, and clicking one only ever filtered the browse
  // list to "changed" -- the same destination whichever tile you pressed. A
  // control that looks like it leads somewhere and always leads to the same
  // place is worse than no control: you click all eight before believing it.
  //
  // So the space does the job the number was reaching for instead: a
  // PROPORTION. "487 abilities" is a figure you have to hold against 649 to
  // understand; a bar filled nine-tenths of the way says "almost everything"
  // before you have read the label, which is the actual finding.
  const total = Object.keys(S.SPECIES).length;
  const rows = el('div', { class: 'dx-props' });
  for (const [k, label, of] of [
    ['base_stats', 'base stats changed', total],
    ['abilities', 'abilities changed', total],
    ['learnset', 'level-up moves changed', total],
    ['tmhm', 'TM compatibility changed', total],
    ['types', 'retyped', total],
    ['evolutions', 'evolution changed', total],
    ['base_exp', 'EXP yield raised', total],
    ['moves', 'moves rebalanced', Object.keys(S.MOVES ?? {}).length],
  ]) {
    if (!c[k]) continue;
    const pct = Math.round((c[k] / of) * 100);
    rows.append(
      el('span', { class: 'dx-plab' }, label),
      el('span', { class: 'dx-pbar' },
        el('i', { style: `width:${Math.max(1, pct)}%` })),
      el('span', { class: 'dx-pnum' }, `${c[k]} of ${of}`),
      el('span', { class: 'dx-ppct' }, `${pct}%`));
  }
  wrap.append(rows);

  // The biggest buffs, which is the list people actually want to read.
  const buffs = Object.entries(S.DIFF.species)
    .filter(([, d]) => d.bst)
    .map(([id, d]) => ({ id: Number(id), name: sp(id)?.name ?? `#${id}`,
      from: d.bst[0], to: d.bst[1], delta: d.bst[1] - d.bst[0] }))
    .sort((a, b) => b.delta - a.delta);
  if (buffs.length) {
    wrap.append(el('h4', {}, 'Biggest stat changes'));
    const list = el('div', { class: 'dx-blist' });
    for (const b of buffs.slice(0, 40)) {
      const row = el('button', { class: 'dx-brow', type: 'button' },
        S.SPRITE[b.name]
          ? el('img', { class: 'dx-sp', src: S.SPRITE[b.name], alt: '', loading: 'lazy' })
          : el('span', { class: 'dx-sp' }),
        el('span', { class: 'dx-rname' }, b.name),
        el('span', { class: 'dx-bnum' }, `${b.from} → ${b.to}`),
        el('span', { class: `dx-bdelta ${b.delta > 0 ? 'up' : 'down'}` },
          `${b.delta > 0 ? '+' : ''}${b.delta}`));
      row.onclick = () => { view.mode = 'browse'; view.sel = b.id; savePrefs(); render(); };
      list.append(row);
    }
    wrap.append(list);
  }

  const retyped = Object.entries(S.DIFF.species).filter(([, d]) => d.types);
  if (retyped.length) {
    wrap.append(el('h4', {}, `Retyped — all ${retyped.length}`));
    const list = el('ul', { class: 'dx-retypes' });
    for (const [id, d] of retyped) {
      const b = el('button', { class: 'dx-link', type: 'button' }, sp(id)?.name ?? `#${id}`);
      b.onclick = () => { view.mode = 'browse'; view.sel = Number(id); savePrefs(); render(); };
      // No literal arrow: `.dx-cn::before` supplies it, so writing one here
      // too renders "normal/flying → → fighting/flying".
      list.append(el('li', {}, b, ' — ',
        el('span', { class: 'dx-co' }, d.types[0].map(cap).join('/')),
        el('span', { class: 'dx-cn' }, d.types[1].map(cap).join('/'))));
    }
    wrap.append(list);
  }

  const moves = Object.entries(S.DIFF.moves ?? {});
  if (moves.length) {
    wrap.append(el('h4', {}, `Moves rebalanced — all ${moves.length}`));
    const tbl = el('div', { class: 'dx-mchange' });
    for (const [name, ch] of moves.sort((a, b) => a[0].localeCompare(b[0]))) {
      tbl.append(el('span', { class: 'dx-mn' }, name),
        el('span', {}, Object.entries(ch)
          .map(([k, [was, now]]) => `${k} ${was} → ${now}`).join(' · ')));
    }
    wrap.append(tbl);
  }
  return wrap;
}

// ==========================================================================
export default {
  id: 'dex',
  label: 'Pokédex',
  // THE ONLY SAVE-FREE TAB. Looking up what this hack did to a Pokémon should
  // not require loading anything.
  needsSave: false,

  mount(panel, ctx) {
    S = ctx?.S ?? null;
    CTX = ctx ?? null;
    F = ctx?.factory ?? null;
    NUZ = ctx?.nuz ?? null;
    owned = new Map();
    if (F) {
      for (const e of buildIndex(F)) {
        owned.set(e.mon.speciesId, [...(owned.get(e.mon.speciesId) ?? []), e]);
      }
    }
    loadPrefs();
    if (!F) view.ownedOnly = false;
    if (!hasDiff()) { view.changedOnly = false; if (view.mode === 'changes') view.mode = 'browse'; }
    root = el('div', { class: 'dx' });
    panel.append(root);
    render();
  },

  unmount() { root?.remove?.(); root = null; },
};
