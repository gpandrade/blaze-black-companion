/**
 * tabs/items.js -- the Bag.
 *
 * The game's own five pockets, in the game's own order, but sortable,
 * filterable and cross-referenced against what you own -- which is the part
 * the in-game bag cannot do.
 *
 * Two cross-references earn their place:
 *
 *   A TM is only interesting if somebody can learn it. state/personal.json
 *   carries each species' real tmhm list, so a TM row can say "14 of yours
 *   can learn this, two of them in your party" instead of leaving you to
 *   check 274 Pokémon by hand.
 *
 *   A held item sitting in the bag is doing nothing. Comparing the bag
 *   against what your party is actually holding surfaces the Life Orb you
 *   forgot to equip.
 *
 * Edits stage into the same working copy the Factory and Builder share, so
 * Install and Download behave identically here.
 */

import { POCKETS } from '../../../js/save.js';
import { pickMon, pickMoveSlot } from '../pick.js';
import { gate } from '../nuzlocke.js';
import * as NUZMOD from '../nuzlocke.js';
import { shackle, shackleBanner } from '../shackle.js';

const POCKET_ORDER = ['items', 'medicine', 'tms_hms', 'berries', 'key_items'];
const POCKET_LABEL = {
  items: 'Items', medicine: 'Medicine', tms_hms: 'TMs & HMs',
  berries: 'Berries', key_items: 'Key Items',
};
const PREF = 'blazeblack.items.view';
const MAX_STACK = 999;

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'checked' || k === 'value') n[k] = v;
    else if (k.startsWith('aria-') || k === 'role' || k === 'type' || k === 'min'
      || k === 'max' || k === 'title' || k === 'placeholder') n.setAttribute(k, v);
    else n[k] = v;
  }
  n.append(...kids.filter((x) => x != null));
  return n;
};

let S = null, F = null, CONFIG = null, root = null, NUZ = null;
const may = (action) => gate(NUZ, action);
let CTX = null;            // the shell, for refreshActions()
let view = { pocket: 'items', q: '', sort: 'slot', usable: false, sel: null };

const info = (id) => S.ITEMINFO?.[String(id)] ?? null;
const label = (id) => S.ITEMS[String(id)] ?? `#${id}`;

// ==========================================================================
function render() {
  CTX?.refreshActions?.();
  const rows = currentRows();
  root.replaceChildren(
    ...[shackleBanner(document, NUZ,
      ['bag.edit', 'bag.give', 'bag.teach'], NUZMOD)].filter(Boolean),
    toolbar(),
    el('div', { class: 'it-main' },
      el('div', {}, pocketBar(), controls(rows), summaryLine(), list(rows)),
      detail()));
}

function toolbar() {
  // Install and Download live in the shell bar: they act on the one working
  // copy every tab shares, and drawing a pair per tab implied three separate
  // piles of pending changes.
  const undo = el('button', { class: 'it-btn', disabled: !F.canUndo }, 'Undo');
  undo.onclick = () => { F.undo(); render(); };

  return el('div', { class: 'it-bar' },
    el('h2', {}, 'Bag'),
    el('span', { class: 'it-spacer' }), undo);
}

function summaryLine() {
  const t = summary();
  return t ? el('p', { class: 'it-summary' }, t) : null;
}

function pocketBar() {
  const bag = F.save.readBag();
  const bar = el('div', { class: 'it-pockets' });
  for (const p of POCKET_ORDER) {
    const n = bag[p]?.length ?? 0;
    const cap = POCKETS[p][1];
    const b = el('button', {
      class: 'it-pocket', 'aria-current': String(view.pocket === p),
      title: `${n} of ${cap} slots used`,
    }, el('span', {}, POCKET_LABEL[p]), el('i', {}, String(n)));
    b.onclick = () => { view.pocket = p; view.sel = null; render(); };
    bar.append(b);
  }
  return bar;
}

/** Rows for the current pocket, after search, filter and sort. */
function currentRows() {
  const raw = F.save.readPocket(view.pocket);
  let rows = raw.map((e, i) => {
    const d = info(e.item_id) ?? {};
    const learners = d.move_id ? tmLearners(d.tm) : null;
    return {
      ...e, slot: i, name: label(e.item_id), desc: d.desc ?? '',
      price: d.price ?? null, tm: d.tm ?? null, move: d.move ?? null,
      icon: S.ITEMICON?.[String(e.item_id)] ?? null,
      learners,
      // "Usable now" means something different per pocket, so it is computed
      // per row rather than being one blunt filter.
      usable: learners ? learners.total > 0 : heldBy(e.item_id).unequipped,
    };
  });

  const q = view.q.trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) => r.name.toLowerCase().includes(q)
      || (r.move ?? '').toLowerCase().includes(q)
      || r.desc.toLowerCase().includes(q));
  }
  if (view.usable) rows = rows.filter((r) => r.usable);

  const by = {
    slot: (a, b) => a.slot - b.slot,
    name: (a, b) => a.name.localeCompare(b.name),
    count: (a, b) => b.count - a.count,
    price: (a, b) => (b.price ?? -1) - (a.price ?? -1),
    learners: (a, b) => (b.learners?.total ?? -1) - (a.learners?.total ?? -1),
  };
  return rows.sort(by[view.sort] ?? by.slot);
}

function controls(rows) {
  const q = el('input', { class: 'it-search', type: 'text', value: view.q,
    placeholder: `Search ${POCKET_LABEL[view.pocket].toLowerCase()}…` });
  q.oninput = () => { view.q = q.value; render(); q.focus(); };

  const sorts = [['slot', 'Bag order'], ['name', 'Name'], ['count', 'Quantity']];
  if (view.pocket === 'tms_hms') sorts.push(['learners', 'Who can learn it']);
  else sorts.push(['price', 'Value']);
  const sort = el('select', { class: 'it-sort', title: 'Sort this pocket' });
  for (const [v, t] of sorts) {
    const o = el('option', { value: v }, t);
    if (v === view.sort) o.selected = true;
    sort.append(o);
  }
  sort.onchange = () => { view.sort = sort.value; savePref(); render(); };

  // "Unequipped only" was a lie: it shows HELD ITEMS nobody is holding, so a
  // Leaf Stone vanished when you turned it on -- an evolution stone is not an
  // equippable item at all, so it was never a candidate. Say what it does.
  const filt = el('button', {
    class: `it-btn it-filter${view.usable ? ' on' : ''}`,
    title: view.pocket === 'tms_hms'
      ? 'Only TMs at least one of your Pokémon can legally learn'
      : 'Held items — Life Orb, Leftovers, Choice Band and the like — that nothing in '
        + 'your party is holding. Evolution stones, medicine and consumables are not '
        + 'held items, so they are not what this filters for.',
  }, view.pocket === 'tms_hms' ? 'Learnable only' : 'Spare held items');
  filt.onclick = () => { view.usable = !view.usable; savePref(); render(); };

  const add = el('button', { class: 'it-btn it-add', title: 'Put a new item in this pocket' },
    '+ Add item');
  add.onclick = () => openAdd();

  return el('div', { class: 'it-controls' }, q, sort, filt,
    el('span', { class: 'it-count' }, `${rows.length} shown`),
    el('span', { class: 'it-spacer' }), add);
}

/**
 * The one-line summary above the list: the thing worth noticing about this
 * pocket right now, rather than a count you can already see.
 */
function summary() {
  const rows = F.save.readPocket(view.pocket);
  if (!rows.length) return null;

  if (view.pocket === 'tms_hms') {
    const dead = rows.filter((e) => {
      const d = info(e.item_id);
      return d?.tm && tmLearners(d.tm).total === 0;
    }).length;
    const partyUsable = rows.filter((e) => {
      const d = info(e.item_id);
      return d?.tm && tmLearners(d.tm).party.length > 0;
    }).length;
    return `${partyUsable} of ${rows.length} can be taught to something in your party`
      + (dead ? ` · ${dead} nothing you own can learn` : '');
  }

  const spare = rows.filter((e) => heldBy(e.item_id).unequipped);
  if (spare.length) {
    const names = spare.slice(0, 3).map((e) => label(e.item_id));
    return `${spare.length} held item${spare.length === 1 ? '' : 's'} nobody in your party `
      + `is holding — ${names.join(', ')}${spare.length > 3 ? '…' : ''}`;
  }
  return null;
}

function list(rows) {
  const wrap = el('div', { class: 'it-list' });
  if (!rows.length) {
    wrap.append(el('p', { class: 'it-empty' },
      view.q || view.usable ? 'Nothing here matches.' : 'This pocket is empty.'));
    return wrap;
  }
  for (const r of rows) {
    const row = el('button', {
      class: `it-row${view.sel === r.item_id ? ' on' : ''}`,
      'aria-current': String(view.sel === r.item_id),
    },
      r.icon ? el('img', { src: r.icon, alt: '', loading: 'lazy' })
        : el('span', { class: 'it-noicon' }, r.name.slice(0, 2)),
      el('span', { class: 'it-rowbody' },
        el('span', { class: 'it-name' }, r.name),
        el('span', { class: 'it-sub' }, rowSub(r))),
      el('span', { class: 'it-qty' }, `×${r.count}`));
    row.onclick = () => { view.sel = r.item_id; render(); };
    wrap.append(row);
  }
  return wrap;
}

function rowSub(r) {
  if (r.learners) {
    return r.learners.total
      ? `${r.learners.total} of yours can learn it`
        + (r.learners.party.length ? ` · party: ${r.learners.party.join(', ')}` : '')
      : 'nothing you own can learn it';
  }
  const held = heldBy(r.item_id);
  if (held.holders.length) return `held by ${held.holders.join(', ')}`;
  // No character-count truncation: .it-sub already clips to the width it has
  // with an ellipsis, and slicing at 72 cut mid-word well short of the edge.
  return r.desc ?? '';
}

// ------------------------------------------------------------ cross-refs
let _learnCache = null;
/** Which of YOUR Pokemon can legally learn a given TM. */
function tmLearners(tmLabel) {
  if (!tmLabel) return null;
  if (!_learnCache) {
    _learnCache = new Map();
    for (const l of F.locations()) {
      for (const s of F.read(l.loc)) {
        if (!s.mon) continue;
        const sp = S.SPECIES[String(s.mon.speciesId)];
        for (const tm of sp?.tmhm ?? []) {
          if (!_learnCache.has(tm)) _learnCache.set(tm, { names: new Set(), party: new Set() });
          const e = _learnCache.get(tm);
          e.names.add(s.mon.species);
          if (l.loc === 'party') e.party.add(s.mon.species);
        }
      }
    }
  }
  const e = _learnCache.get(tmLabel);
  return { total: e ? e.names.size : 0, party: e ? [...e.party].sort() : [] };
}

let _heldCache = null;
/** Who in the party is holding this, and is it going spare? */
function heldBy(itemId) {
  if (!_heldCache) {
    _heldCache = new Map();
    for (const s of F.read('party')) {
      if (!s.mon?.itemId) continue;
      if (!_heldCache.has(s.mon.itemId)) _heldCache.set(s.mon.itemId, []);
      _heldCache.get(s.mon.itemId).push(s.mon.species);
    }
  }
  const holders = _heldCache.get(itemId) ?? [];
  const d = info(itemId);
  // Category 0 is the general pocket, which is where held items live.
  const holdable = d && d.cat === 0 && !d.tm;
  return { holders, unequipped: Boolean(holdable) && holders.length === 0 };
}

// -------------------------------------------------------------- details
function detail() {
  const wrap = el('div', { class: 'it-detail' });
  if (view.sel == null) {
    // An empty reserved rail should still earn its width. This one used to say
    // "Select an item." and nothing else.
    const bag = F.save.readBag();
    const pockets = POCKET_ORDER.map((p) => [POCKET_LABEL[p], bag[p]?.length ?? 0]);
    const total = pockets.reduce((n, [, c]) => n + c, 0);
    wrap.append(el('h3', {}, 'Your bag'));
    const kv = el('dl', { class: 'it-kv' });
    for (const [label, count] of pockets) {
      kv.append(el('dt', {}, label), el('dd', {}, `${count}`));
    }
    kv.append(el('dt', {}, 'In all'), el('dd', {}, `${total}`));
    wrap.append(kv);
    wrap.append(el('p', { class: 'it-hint' },
      'Click an item to see what it does and who can use it. Descriptions are the '
      + 'game’s own text, so they describe what this hack actually does rather than '
      + 'what vanilla Black did.'));
    return wrap;
  }
  const id = view.sel;
  const d = info(id) ?? {};
  const entry = F.save.readPocket(view.pocket).find((e) => e.item_id === id);
  const count = entry?.count ?? 0;

  wrap.append(el('div', { class: 'it-hero' },
    S.ITEMICON?.[String(id)] ? el('img', { src: S.ITEMICON[String(id)], alt: '' }) : null,
    el('div', {}, el('h3', {}, label(id)),
      el('div', { class: 'it-sub' }, `${POCKET_LABEL[view.pocket]} · #${id}`))));

  if (d.desc) wrap.append(el('p', { class: 'it-desc' }, d.desc));

  const kv = el('dl', { class: 'it-kv' });
  const row = (k, ...v) => { kv.append(el('dt', {}, k), el('dd', {}, ...v)); };
  row('Quantity', String(count));
  if (d.price) row('Value', `${d.price}`);
  if (d.tm) {
    const mv = S.MOVES[d.move];
    row('Teaches', `${d.move}${mv ? ` · ${mv.t} ${mv.c}${mv.p ? ` ${mv.p} BP` : ''}` : ''}`);
    const l = tmLearners(d.tm);
    row('Can learn it', l.total ? `${l.total} of yours` : 'nothing you own');
    // THE PARTY, AS ICONS. This was a comma-separated list of names, which is
    // the shape of the answer but not the speed of it -- you read six words to
    // learn something you could have seen. The game's own 32x32 party icons
    // are exactly the size for a picture used as an identifier beside text; a
    // 96x96 sprite here would be four lines tall.
    if (l.party.length) {
      const strip = el('div', { class: 'it-icons' });
      for (const name of l.party) {
        const src = (S.ICON ?? {})[name];
        strip.append(src
          ? el('img', { src, alt: name, title: name, loading: 'lazy' })
          : el('span', { class: 'it-iconname' }, name));
      }
      kv.append(el('dt', {}, 'In your party'), el('dd', {}, strip));
    }
  } else {
    const held = heldBy(id);
    if (held.holders.length) row('Held by', held.holders.join(', '));
    else if (held.unequipped) row('Held by', 'nobody in your party');
  }
  wrap.append(kv);

  // quantity controls
  const num = el('input', { class: 'it-num', type: 'number', min: 0, max: MAX_STACK,
    value: String(count) });
  const apply = el('button', { class: 'it-btn primary' }, 'Set');
  apply.onclick = () => setCount(id, Number(num.value));
  const bump = (n, t) => {
    const b = el('button', { class: 'it-btn', title: t }, n > 0 ? `+${n}` : `${n}`);
    b.onclick = () => setCount(id, count + n);
    return b;
  };
  // Changing a count is a bag EDIT, and the whole row closes together: an
  // enabled +10 beside a locked Apply would read as a bug rather than a rule.
  const qty = el('div', { class: 'it-qtyrow' }, num, apply, bump(1), bump(10), bump(-1));
  for (const b of qty.children ?? []) shackle(b, may('bag.edit'));
  wrap.append(qty);

  // Give it to somebody, or teach it -- the two things you actually open the
  // bag to do, and both of which otherwise meant a trip to another tab.
  if (d.tm && d.move_id) {
    const learners = F.canLearn(d.tm);
    const teach = el('button', {
      class: 'it-btn primary',
      title: learners.length
        ? `Teach ${d.move} to one of the ${learners.length} that can learn it`
        : 'Nothing you own can learn this legally — but you can still force it',
    }, 'Teach it to…');
    shackle(teach, may('bag.teach'));
    const everyone = [];
    for (const l of F.locations()) {
      for (const x of F.read(l.loc)) if (x.mon) everyone.push({ loc: l.loc, index: x.index, mon: x.mon });
    }
    const legalIds = new Set(learners.map((c) => `${c.loc}:${c.index}`));
    teach.onclick = () => pickMon({
      title: `Teach ${d.move}`,
      sub: `${learners.length} of your Pokémon can legally learn it. In Gen 5 a TM is `
        + 'reusable, so this does not use it up.',
      candidates: learners, S,
      // The default is the legal answer, because that is what you want almost
      // every time. The wider list is one click away and marks what it is.
      alt: {
        label: 'Show everything',
        sub: `All ${everyone.length} of your Pokémon. The ones that cannot legally learn `
          + `${d.move} are marked — the game will honour it anyway.`,
        list: everyone,
        mark: (c) => !legalIds.has(`${c.loc}:${c.index}`),
      },
      detail: (c) => (c.mon.moves.length >= 4 ? 'knows 4 already' : 'has a free slot'),
      onPick: (c) => pickMoveSlot({
        mon: c.mon, moveName: d.move, S,
        onPick: (slot) => {
          try {
            F.teachMove({ loc: c.loc, index: c.index }, d.move_id, slot);
            invalidate();
            render();
            alert(`${c.mon.species} learned ${d.move}.\n\nStaged — install or download to keep it.`);
          } catch (e) { alert(e.message); }
        },
      }),
    });
    wrap.append(el('div', { class: 'it-acts' }, teach));
  } else if (d.cat !== 0) {
    // Being explicit beats an action that is simply absent: "why can't I give
    // my Leaf Stone to somebody" is the exact confusion this prevents.
    wrap.append(el('p', { class: 'it-hint' },
      'Not a held item — nothing can carry this, so there is nobody to give it to.'));
  } else {
    const give = el('button', { class: 'it-btn primary', disabled: count < 1 },
      'Give it to…');
    shackle(give, may('bag.give'));
    give.onclick = () => {
      const all = [];
      for (const l of F.locations()) {
        for (const x of F.read(l.loc)) if (x.mon) all.push({ loc: l.loc, index: x.index, mon: x.mon });
      }
      pickMon({
        title: `Give ${label(id)}`,
        sub: 'Takes one out of the bag. Whatever they were already holding goes back in.',
        candidates: all, S,
        detail: (c) => (c.mon.item ? `holding ${c.mon.item}` : 'holding nothing'),
        onPick: (c) => {
          try {
            const had = F.giveItem({ loc: c.loc, index: c.index }, id);
            // One out of the bag; anything displaced goes back in, or it would
            // simply cease to exist.
            const now = F.save.readPocket(view.pocket).find((e) => e.item_id === id)?.count ?? 0;
            F.save.setBagItem(view.pocket, id, now - 1);
            if (had) {
              const dp = pocketOf(had, info(had) ?? {});
              const cur = F.save.readPocket(dp).find((e) => e.item_id === had)?.count ?? 0;
              F.save.setBagItem(dp, had, cur + 1);
            }
            invalidate();
            if (now - 1 <= 0) view.sel = null;
            render();
            alert(`${c.mon.species} is now holding ${label(id)}.`
              + (had ? `\n\n${label(had)} went back into your bag.` : '')
              + '\n\nStaged — install or download to keep it.');
          } catch (e) { alert(e.message); }
        },
      });
    };
    wrap.append(el('div', { class: 'it-acts' }, give));
  }

  const drop = el('button', { class: 'it-btn danger' }, 'Remove from bag');
  drop.onclick = () => {
    if (!confirm(`Remove ${label(id)} from your ${POCKET_LABEL[view.pocket]}?\n\n`
      + 'Staged in the working copy — undo is available.')) return;
    setCount(id, 0);
  };
  wrap.append(el('div', { class: 'it-acts' }, drop));

  if (count >= MAX_STACK) {
    wrap.append(el('p', { class: 'it-note' },
      el('b', {}, 'Heads up: '), `${MAX_STACK} is the most one slot can hold — the count is `
      + 'two bytes wide, so anything larger would wrap. Clamped, not refused.'));
  }
  return wrap;
}

function setCount(id, n) {
  try {
    F.snapshot();
    F.save.setBagItem(view.pocket, id, Math.max(0, Math.min(MAX_STACK, n)));
    F.dirty = true;
    if (n <= 0) view.sel = null;
    invalidate();
    render();
  } catch (e) {
    F.undo();
    alert(e.message);
  }
}

// ------------------------------------------------------------------ add
function openAdd() {
  const overlay = el('div', { class: 'it-modal', role: 'dialog', 'aria-modal': 'true' });
  const sheet = el('div', { class: 'it-sheet' });
  overlay.append(sheet);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() { document.removeEventListener('keydown', onKey); overlay.remove(); }

  let q = '';
  const draw = () => {
    sheet.replaceChildren();
    sheet.append(el('h3', {}, `Add to ${POCKET_LABEL[view.pocket]}`),
      el('div', { class: 'it-sub' },
        'Anything can go in any pocket as far as the save is concerned, but the game '
        + 'looks for each item in its own pocket — so this lists what belongs here.'));

    const search = el('input', { class: 'it-search', type: 'text', value: q,
      placeholder: 'Search all items…' });
    search.oninput = () => { q = search.value; draw(); search.focus(); };
    sheet.append(search);

    const have = new Set(F.save.readPocket(view.pocket).map((e) => e.item_id));
    const term = q.trim().toLowerCase();
    const hits = Object.entries(S.ITEMINFO ?? {})
      .filter(([id, d]) => Number(id) > 0 && d.name && d.name !== 'None'
        && pocketOf(Number(id), d) === view.pocket
        && !have.has(Number(id))
        && (!term || label(id).toLowerCase().includes(term)
          || (d.move ?? '').toLowerCase().includes(term)))
      .slice(0, 80);

    const box = el('div', { class: 'it-addlist' });
    for (const [id, d] of hits) {
      const b = el('button', { class: 'it-row' },
        S.ITEMICON?.[id] ? el('img', { src: S.ITEMICON[id], alt: '', loading: 'lazy' })
          : el('span', { class: 'it-noicon' }, d.name.slice(0, 2)),
        el('span', { class: 'it-rowbody' },
          el('span', { class: 'it-name' }, label(id)),
          el('span', { class: 'it-sub' }, (d.desc ?? '').slice(0, 64))));
      b.onclick = () => {
        setCount(Number(id), 1);
        view.sel = Number(id);
        close();
        render();
      };
      box.append(b);
    }
    if (!hits.length) box.append(el('p', { class: 'it-empty' }, 'Nothing matches, or you have it already.'));
    sheet.append(box);

    const cancel = el('button', { class: 'it-btn' }, 'Cancel');
    cancel.onclick = close;
    sheet.append(el('div', { class: 'it-foot' }, cancel));
  };
  draw();
  document.body.append(overlay);
}

/**
 * Which pocket an item belongs in.
 *
 * The ROM's category byte does not map one-to-one onto the five pockets, so
 * the id ranges settle the ones that matter: TMs and HMs are three separate
 * runs (328-419, 420-425, 618-620) and berries are contiguous.
 */
function pocketOf(id, d) {
  if (d.tm) return 'tms_hms';
  if (id >= 149 && id <= 212) return 'berries';
  if (d.cat === 1 || d.cat === 4) return 'medicine';
  if (d.cat === 2) return 'key_items';
  return 'items';
}

function invalidate() { _learnCache = null; _heldCache = null; }

function savePref() {
  try { localStorage.setItem(PREF, JSON.stringify({ sort: view.sort, usable: view.usable })); }
  catch { /* private mode */ }
}

// -------------------------------------------------------------------- tab
export default {
  id: 'items',
  label: 'Bag',
  needsSave: true,

  mount(panel, ctx) {
    S = ctx.S;
    F = ctx.factory;
    CONFIG = ctx.config ?? null;
    CTX = ctx;
    NUZ = ctx.nuz ?? null;
    invalidate();
    let pref = {};
    try { pref = JSON.parse(localStorage.getItem(PREF) ?? '{}'); } catch { /* ignore */ }
    view = { pocket: 'items', q: '', sort: pref.sort ?? 'slot', usable: Boolean(pref.usable), sel: null };
    root = el('div', { class: 'it' });
    panel.append(root);
    render();
  },

  unmount() {
    document.querySelector?.('.it-modal')?.remove();
    document.querySelector?.('.pk-modal')?.remove();
    root?.remove?.();
    root = null;
    invalidate();
  },
};
