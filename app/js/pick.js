/**
 * pick.js -- the "which Pokemon?" chooser, shared by the Bag and the Factory.
 *
 * Handing an item to somebody and teaching a TM are the same gesture with a
 * different filter, and they are reachable from two tabs. One implementation
 * means the two tabs cannot drift into behaving differently, and a fix to the
 * awkward part is a fix everywhere.
 */

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'value') n.value = v;
    else if (k.startsWith('aria-') || k === 'role' || k === 'type' || k === 'title'
      || k === 'placeholder') n.setAttribute(k, v);
    else n[k] = v;
  }
  n.append(...kids.filter((x) => x != null));
  return n;
};

const locLabel = (loc) =>
  (loc === 'party' ? 'Party' : loc === 'battleBox' ? 'Battle Box' : `Box ${loc + 1}`);

/**
 * Open a chooser.
 *
 * @param {object}   o
 * @param {string}   o.title
 * @param {string}   o.sub          one line explaining the consequence
 * @param {Array}    o.candidates   [{loc, index, mon}]
 * @param {object}   o.S            static data, for sprites
 * @param {string}   [o.empty]      what to say when nothing qualifies
 * @param {function} [o.detail]     (candidate) -> extra line under the name
 * @param {object}   [o.alt]        {label, sub, list, mark} -- a second, wider
 *                                  list behind a toggle. Used for "show every
 *                                  Pokemon, legality be damned": the default
 *                                  stays the legal answer, and the wider one
 *                                  is one click away and marked.
 * @param {function} o.onPick       (candidate) -> void
 */
export function pickMon({ title, sub, candidates, S, empty, detail, alt, onPick }) {
  let wide = false;
  const overlay = el('div', { class: 'pk-modal', role: 'dialog', 'aria-modal': 'true' });
  const sheet = el('div', { class: 'pk-sheet' });
  overlay.append(sheet);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() { document.removeEventListener('keydown', onKey); overlay.remove(); }

  let q = '';
  const draw = () => {
    sheet.replaceChildren();
    sheet.append(el('h3', {}, title),
      el('p', { class: 'pk-sub' }, wide && alt ? alt.sub : sub));

    const search = el('input', { class: 'pk-search', type: 'text', value: q,
      placeholder: 'Search by name…' });
    search.oninput = () => { q = search.value; draw(); search.focus(); };

    // A segmented control on its own line, not a pill tucked beside the
    // search box -- as a pill it was easy to miss, and the whole point of it
    // is that you can find it when the legal list does not have what you want.
    if (alt) {
      const seg = el('div', { class: 'pk-seg', role: 'group' });
      const opt = (on, label, count, tip) => {
        const b = el('button', {
          class: `pk-segbtn${wide === on ? ' on' : ''}`,
          'aria-pressed': String(wide === on), title: tip,
        }, label, el('i', {}, String(count)));
        b.onclick = () => { wide = on; draw(); };
        return b;
      };
      seg.append(
        opt(false, 'Can learn it', candidates.length,
          'Only the Pokémon this move is legal on'),
        opt(true, alt.label, alt.list.length,
          'Every Pokémon you own. The game honours an illegal move anyway — '
          + 'I’m not your mother, do it if you want.'));
      sheet.append(seg, search);
    } else {
      sheet.append(search);
    }

    const term = q.trim().toLowerCase();
    // Party first: it is nearly always the answer, and scrolling past 24 boxes
    // to reach it would be the whole friction this is meant to remove.
    const rank = (c) => (c.loc === 'party' ? -2 : c.loc === 'battleBox' ? -1 : c.loc);
    const pool = wide && alt ? alt.list : candidates;
    const shown = pool
      .filter((c) => !term || c.mon.species.toLowerCase().includes(term)
        || (c.mon.nickname ?? '').toLowerCase().includes(term))
      .sort((a, b) => rank(a) - rank(b) || a.index - b.index);
    const illegal = wide && alt?.mark ? alt.mark : () => false;

    const list = el('div', { class: 'pk-list' });
    for (const c of shown) {
      const b = el('button', { class: `pk-row${c.loc === 'party' ? ' party' : ''}` },
        S.SPRITE[c.mon.species]
          ? el('img', { src: S.SPRITE[c.mon.species], alt: '', loading: 'lazy' })
          : el('span', { class: 'pk-noicon' }, c.mon.species.slice(0, 2)),
        el('span', { class: 'pk-body' },
          el('span', { class: 'pk-name' },
            c.mon.isNicknamed ? `${c.mon.nickname} (${c.mon.species})` : c.mon.species),
          el('span', { class: 'pk-sub2' },
            `${locLabel(c.loc)} ${c.index + 1} · L${c.mon.level ?? '?'}`
            + (detail ? ` · ${detail(c)}` : ''))),
        illegal(c) ? el('span', { class: 'pk-illegal', title:
          'This species cannot legally learn it. Gen 5 reads the move straight out of the '
          + 'record, so it will work in battle regardless.' }, 'illegal') : null);
      b.onclick = () => { close(); onPick(c); };
      list.append(b);
    }
    if (!shown.length) {
      list.append(el('p', { class: 'pk-empty' },
        term ? 'Nothing matches that name.' : (empty ?? 'Nothing qualifies.')));
    }
    sheet.append(list);

    const cancel = el('button', { class: 'pk-btn' }, 'Cancel');
    cancel.onclick = close;
    sheet.append(el('div', { class: 'pk-foot' }, cancel));
  };
  draw();
  document.body.append(overlay);
  return close;
}

/** Choose which of a Pokemon's four move slots to overwrite. */
export function pickMoveSlot({ mon, moveName, S, onPick }) {
  const overlay = el('div', { class: 'pk-modal', role: 'dialog', 'aria-modal': 'true' });
  const sheet = el('div', { class: 'pk-sheet pk-narrow' });
  overlay.append(sheet);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() { document.removeEventListener('keydown', onKey); overlay.remove(); }

  sheet.append(el('h3', {}, `Teach ${moveName} to ${mon.species}`),
    el('p', { class: 'pk-sub' },
      'Pick the slot it replaces. In Gen 5 a TM is reusable, so this does not use it up.'));

  const list = el('div', { class: 'pk-list' });
  for (let i = 0; i < 4; i++) {
    const cur = mon.moves.find((m) => m.slot === i);
    const mv = cur ? S.MOVES[cur.name] : null;
    const b = el('button', { class: 'pk-row' },
      el('span', { class: 'pk-slotnum' }, String(i + 1)),
      el('span', { class: 'pk-body' },
        el('span', { class: 'pk-name' }, cur ? cur.name : 'empty slot'),
        el('span', { class: 'pk-sub2' }, cur && mv
          ? `${mv.t} ${mv.c}${mv.p ? ` · ${mv.p} BP` : ''} · ${cur.pp} PP`
          : 'nothing here')));
    b.onclick = () => { close(); onPick(i); };
    list.append(b);
  }
  sheet.append(list);
  const cancel = el('button', { class: 'pk-btn' }, 'Cancel');
  cancel.onclick = close;
  sheet.append(el('div', { class: 'pk-foot' }, cancel));
  document.body.append(overlay);
}
