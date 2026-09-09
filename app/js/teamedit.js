/**
 * teamedit.js -- edit the PROSE of a team from the battle tab.
 *
 * WHY THIS EXISTS
 * The shipped rosters carry writing the Builder's teams never could: a
 * tagline, a row of labelled pilot cards (LEAD / SPEED / WIN CON / SETUP /
 * PANIC on Kaiju), a per-slot line saying what the slot is FOR, and a warning
 * naming what the team actually loses to. A Builder team got a computed
 * warning and, at best, its free-text notes split into cards labelled
 * "Note 1", "Note 2". They are all cores in one store now, so the writing has
 * to be editable rather than something only Python could produce.
 *
 * WHY IT IS NOT IN THE TEMPLATE
 * sheet_template.html is the published artifact as well as the battle tab, and
 * the artifact is static: it has no team store, no server and no reason to
 * offer an editor. So the control is added from OUTSIDE, the same way
 * battle.js already restyles the masthead and retitles the <h1>. The template
 * is never edited, and `build_sheet.py` still renders the artifact unchanged.
 *
 * WHAT IT DOES NOT EDIT
 * Species, moves, abilities, natures, items -- the whole spec. Those belong to
 * the Team Builder and the Factory, which already do it properly against the
 * save. Trying to do it here would be a second, worse editor for a job that is
 * already done. This edits what the battle tab alone knows how to show.
 */

const LABEL_HINTS = ['Lead', 'Speed', 'Win con', 'Setup', 'Panic', 'Turn 1', 'Wincon'];

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
};

const field = (labelText, control, hint) =>
  el('label', { class: 'te-field' },
    el('span', { class: 'te-lab' }, labelText),
    control,
    hint ? el('span', { class: 'te-hint' }, hint) : null);

/**
 * The prose fields, as a block that can be used on its own.
 *
 * ONE IMPLEMENTATION, TWO PLACEMENTS. The battle tab wraps it in a modal with
 * Save and Cancel, because you are not in an editing context there and a
 * dialog says "this is a detour". The Team Builder embeds it inline under the
 * team's own name and tagline, because you ARE editing there and its other
 * fields already save as you type -- a button that opened a dialog read as an
 * unrelated tool rather than as more of the same form.
 *
 * `draft` is mutated in place and `onInput` fires after every change.
 */
export function proseFields(draft, { speciesName, slots = [], onInput } = {}) {
  const changed = () => onInput?.();

  const cards = el('div', { class: 'te-cards' });
  const drawCards = () => {
    cards.textContent = '';
    draft.pilot.forEach((c, i) => {
      const k = el('input', { class: 'te-in te-key', type: 'text', value: c.k, maxlength: '18',
        placeholder: 'LEAD', list: 'te-labels' });
      k.oninput = () => { c.k = k.value; changed(); };
      const v = el('textarea', { class: 'te-in te-val', rows: '2',
        placeholder: 'What you do with it, in a sentence.' });
      v.value = c.v;
      v.oninput = () => { c.v = v.value; changed(); };
      const up = el('button', { class: 'te-mini', type: 'button', title: 'Move up',
        disabled: i === 0 ? '' : null }, '↑');
      up.onclick = () => {
        [draft.pilot[i - 1], draft.pilot[i]] = [draft.pilot[i], draft.pilot[i - 1]];
        drawCards(); changed();
      };
      const del = el('button', { class: 'te-mini te-del', type: 'button', title: 'Remove' }, '×');
      del.onclick = () => { draft.pilot.splice(i, 1); drawCards(); changed(); };
      cards.append(el('div', { class: 'te-card' },
        el('div', { class: 'te-cardhead' }, k, up, del), v));
    });
    if (!draft.pilot.length) {
      cards.append(el('p', { class: 'te-empty' },
        'No pilot cards yet. These are the short labelled notes across the top of '
        + 'the team — “LEAD: Slowking sets permanent rain” — and they are the part '
        + 'that makes a roster readable to someone who did not build it.'));
    }
  };
  drawCards();

  const add = el('button', { class: 'te-btn', type: 'button' }, '+ Add a card');
  add.onclick = () => {
    draft.pilot.push({ k: LABEL_HINTS[draft.pilot.length] ?? '', v: '' });
    drawCards(); changed();
  };

  const warnIn = el('textarea', { class: 'te-in', rows: '2',
    placeholder: 'Leave blank to keep the computed one.' });
  warnIn.value = draft.warnNote;
  warnIn.oninput = () => { draft.warnNote = warnIn.value; changed(); };

  const slotWrap = el('div', { class: 'te-slots' });
  slots.forEach((sl, i) => {
    const id = sl.options?.[0]?.speciesId;
    const label = (id && speciesName?.(id)) || `Slot ${i + 1}`;
    const inp = el('input', { class: 'te-in', type: 'text', value: draft.slots[i].why,
      maxlength: '160', placeholder: 'What this slot is for' });
    inp.oninput = () => { draft.slots[i].why = inp.value; changed(); };
    slotWrap.append(el('div', { class: 'te-slot' },
      el('span', { class: 'te-slotname' }, `${i + 1}. ${label}`), inp));
  });

  return el('div', { class: 'te-fields' },
    el('datalist', { id: 'te-labels' }, LABEL_HINTS.map((h) => el('option', { value: h }))),
    el('div', { class: 'te-sec' },
      el('span', { class: 'te-lab' }, 'Pilot cards'),
      el('span', { class: 'te-hint' },
        'How to actually run it. Kaiju has five: Lead, Speed, Win con, Setup, Panic.'),
      cards, add),
    field('What it loses to', warnIn,
      'Every team gets a warning. Yours replaces the computed one.'),
    slots.length
      ? el('div', { class: 'te-sec' },
        el('span', { class: 'te-lab' }, 'What each slot is for'),
        el('span', { class: 'te-hint' }, 'Shown under the role chip on each slot.'),
        slotWrap)
      : null);
}

/** A draft of just the prose, for proseFields to mutate. */
export const proseDraft = (team) => ({
  warnNote: team.warnNote ?? '',
  pilot: (team.pilot ?? []).map((c) => ({ k: c.k ?? '', v: c.v ?? '' })),
  slots: (team.slots ?? []).map((sl) => ({ why: sl.why ?? '' })),
});

/**
 * Open the editor for one team.
 *
 * `team` is the RAW Builder/core record, not the converted battle team --
 * writing back into the converted shape would mean reversing a lossy
 * transform. `onSave(next)` gets a new record and is responsible for
 * persisting and re-rendering.
 */
export function openTeamEditor(team, { onSave, onCancel, speciesName } = {}) {
  // A COPY: cancelling has to leave the stored team untouched, and these are
  // the objects the form mutates in place.
  const draft = { name: team.name ?? '', notes: team.notes ?? '', ...proseDraft(team) };

  const overlay = el('div', { class: 'te-overlay', role: 'dialog', 'aria-modal': 'true',
    'aria-label': `Edit ${draft.name}` });
  const box = el('div', { class: 'te-box' });

  // ---- identity -----------------------------------------------------------
  const nameIn = el('input', { class: 'te-in', type: 'text', value: draft.name, maxlength: '40' });
  nameIn.oninput = () => { draft.name = nameIn.value; };

  const tagIn = el('input', { class: 'te-in', type: 'text', value: draft.notes.split('\n')[0] ?? '',
    maxlength: '140', placeholder: 'One line: what this team is' });
  tagIn.oninput = () => { draft.notes = tagIn.value; };

  const fields = proseFields(draft, { speciesName, slots: team.slots ?? [] });

  const close = (fn) => { overlay.remove(); document.removeEventListener('keydown', onKey); fn?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(onCancel); };
  document.addEventListener('keydown', onKey);

  const save = el('button', { class: 'te-btn te-go', type: 'button' }, 'Save');
  save.onclick = () => {
    // Written back onto the ORIGINAL record so nothing else on it is lost --
    // slots, specs, tag, kind, id all survive untouched.
    const next = {
      ...team,
      name: draft.name.trim() || team.name,
      notes: draft.notes,
      warnNote: draft.warnNote.trim(),
      pilot: draft.pilot.filter((c) => c.k.trim() || c.v.trim()),
      slots: (team.slots ?? []).map((sl, i) => ({ ...sl, why: draft.slots[i].why.trim() })),
      updated: Date.now(),
    };
    close(() => onSave?.(next));
  };
  const cancel = el('button', { class: 'te-btn', type: 'button' }, 'Cancel');
  cancel.onclick = () => close(onCancel);

  // A click on the backdrop closes; a click inside must not. Without the
  // stopPropagation the first click on any field would dismiss the dialog.
  box.onclick = (e) => e.stopPropagation();
  overlay.onclick = () => close(onCancel);

  box.append(
    el('div', { class: 'te-head' },
      el('h2', {}, 'Edit ', el('b', {}, team.name ?? 'team')),
      el('p', { class: 'te-sub' },
        'The writing, not the Pokémon. Species, moves and abilities are the '
        + 'Team Builder’s job — this is what the battle tab shows around them.')),
    field('Name', nameIn),
    field('Tagline', tagIn, 'The line under the team name.'),
    fields,
    el('div', { class: 'te-foot' }, cancel, save),
  );
  overlay.append(box);
  document.body.append(overlay);
  nameIn.focus();
  return overlay;
}

/**
 * The team the battle sheet currently has open.
 *
 * The template rebuilds its tab strip on every selection and puts no id on the
 * buttons, so there is nothing to read back out of the DOM. It does persist
 * the order under `bb_taborder` with the active team FIRST, which is the same
 * thing -- `orderedTeams()` in the template resolves the active tab exactly
 * this way, so mirroring it here cannot drift from what is on screen.
 */
export function activeTeamId(teamIds) {
  let order = [];
  try { order = JSON.parse(localStorage.getItem('bb_taborder') ?? '[]'); } catch { /* ignore */ }
  const hit = (Array.isArray(order) ? order : []).find((id) => teamIds.includes(id));
  return hit ?? teamIds[0] ?? null;
}
