/**
 * tabs/adventure.js -- where you are, and what is there.
 *
 * Three sources have to be joined before any of this is sayable, and none of
 * them agree on what an area is called: the save gives a ZONE ID,
 * state/maps.json turns that into a location name, the wiki keeps encounter
 * tables under its own directory names, and Drayano's item doc uses a third
 * set. build_static.py does the joining and reports what it could not join --
 * AREAINDEX here is the result.
 *
 * Everything it shows is filtered through what you can actually reach and
 * what you already have:
 *
 *   Surf and fishing rows are MARKED, not hidden. Without HM03 or the rod
 *   they are real encounters you simply cannot get at yet, and saying so is
 *   more use than pretending the water is empty.
 *
 *   Species you have already caught are dimmed, so what is NEW here stands
 *   out. That is the actual question when you walk into a route.
 *
 *   Field items you already hold are marked, because the doc lists what is
 *   on the ground, not what is still on it.
 */

import { MapEdit, loadEdits, loadNotes, saveEdits } from '../mapedit.js';
import { opponentsFor } from '../roster.js';
import * as N from '../nuzlocke.js';
import { buildIndex } from '../teams.js';
import { rich } from '../rich.js';

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    // `class: null` means NO class. Assigning it sets className to the string
    // "null" in a real browser -- which shipped as `class="null"` on every
    // trainer-card row -- and to a genuine null in a stub, where the next
    // `.split(' ')` throws. Neither is what the caller meant.
    if (k === 'class') { if (v != null) n.className = v; }
    else if (k === 'value') n.value = v;
    else if (k.startsWith('aria-') || k === 'role' || k === 'type' || k === 'title'
      || k === 'placeholder') n.setAttribute(k, v);
    else n[k] = v;
  }
  n.append(...kids.filter((x) => x != null));
  return n;
};

const METHOD_LABEL = {
  'grass-normal': 'Tall grass', 'grass-doubles': 'Doubles grass',
  'grass-special': 'Shaking grass', 'surf-normal': 'Surfing',
  'surf-special': 'Rippling water', 'fishing-normal': 'Fishing',
  'fishing-special': 'Rippling water (rod)', 'cave-normal': 'Cave',
  'cave-special': 'Dust cloud', 'bridge-special': 'Bridge shadow',
  'puddle-normal': 'Puddles', 'rocky-grass': 'Rocky grass',
  'sand-normal': 'Sand', 'tower-normal': 'Tower',
};

let S = null, F = null, GOTO = null, CONFIG = null, root = null;
// Which cartridge. Only the Opelucid leader differs, but showing you a
// fight that is not in your game is the same defect as showing a rival's
// other-starter variant.
let VERSION = 'black';
// The documented fights for YOUR starter, unfiltered by version. Everything
// here keys on POSITION in this list -- AREAINDEX[].opponents and the sheet's
// saved encounter both do -- so the version filter is applied at the point of
// display and never by re-indexing. The three starter rosters are index-aligned
// by construction (build_static.py asserts it), so a stored position survives
// changing starter as well.
let OPPS = [];
// What the last "Save to repo" did, and what is still outstanding. Cleared on
// unmount: it describes an action, not a state of the map.
let savedMsg = null;
// The nuzlocke rules and a flat index of what you own, for the duplicates
// clause. Both come from the shell; with the mode off nothing here renders.
let NUZ = null, N_INDEX = [], CTXREF = null;

// The eight gyms in the order the badge bits run -- bit 0 is the first gym.
// Named here rather than derived from OPPONENTS because the roster is filtered
// by version and starter and the badge bits are not: bit 7 is Opelucid whether
// you fought Drayden or Iris.
const GYM_ORDER = ['Striaton', 'Nacrene', 'Castelia', 'Nimbasa',
  'Driftveil', 'Mistralton', 'Icirrus', 'Opelucid'];
// The badges, in bit order. THE ART IS THE GAME'S OWN -- extracted by
// `python3 tools/ncgr.py badges` out of a/0/4/0, whose cell bank says each is
// a single 32x64 OAM object with its own palette bank. See notes/rom-graphics.md.
// The file is missing until setup has run, and the card copes: a badge with no
// image falls back to its initial on a plate.
const BADGES = [
  { name: 'Trio', gym: 'Striaton', img: '0-trio' },
  { name: 'Basic', gym: 'Nacrene', img: '1-basic' },
  { name: 'Insect', gym: 'Castelia', img: '2-insect' },
  { name: 'Bolt', gym: 'Nimbasa', img: '3-bolt' },
  { name: 'Quake', gym: 'Driftveil', img: '4-quake' },
  { name: 'Jet', gym: 'Mistralton', img: '5-jet' },
  { name: 'Freeze', gym: 'Icirrus', img: '6-freeze' },
  { name: 'Legend', gym: 'Opelucid', img: '7-legend' },
];
// Read straight off the save for the trainer card; the shell hands us the
// Save so this needs no extra plumbing.
let TRAINER = null, POKEDEX = null;
let view = { area: null, showCaught: true };
let here = null, dex = null, bagNames = null;
let ED = null;                 // the map editor's model, built on first use
let drag = null;               // {kind, name, i, k} while a pointer is down
let armed = null;              // tray area waiting to be placed, or link end A
let sel = null;                // {kind:'place'|'link'|'note', ...} selection

/**
 * The editor is the single source for where things are, in BOTH modes -- so a
 * correction you made shows up while you browse, not only while you edit.
 *
 * It also absorbs the old calibration nudges on first run. That key was the
 * only place earlier corrections lived, and a format change must never quietly
 * lose somebody's work.
 */
function editor() {
  if (ED) return ED;
  const stored = loadEdits();
  if (!Object.keys(stored.positions).length) {
    try {
      const old = JSON.parse(localStorage.getItem(NUDGE_KEY) ?? '{}');
      for (const [n, v] of Object.entries(old)) {
        if (v && typeof v.x === 'number') stored.positions[n] = { x: v.x, y: v.y };
      }
      if (Object.keys(stored.positions).length) saveEdits(stored);
    } catch { /* no nudges to carry over */ }
  }
  ED = new MapEdit(S.MAP, Object.keys(S.AREAINDEX ?? {}), stored, loadNotes());
  return ED;
}

// ==========================================================================
function render() {
  const area = view.area ?? here?.area ?? null;
  // Editing takes the whole tab. Nudging a marker while encounter tables,
  // trainers and a progress bar competed for the screen was the actual
  // complaint -- the map needs the room, and nothing else is being used.
  if (view.editing) {
    view.mapOpen = true;          // editing a map you folded away is not a state
    root.replaceChildren(mapPanel(area), editorPanel());
    return;
  }
  root.replaceChildren(
    header(area),
    mapPanel(area),
    area
      ? el('div', { class: 'ad-panels' },
        ...[nuzPanel(area)].filter(Boolean),
        encounterPanel(area), trainerPanel(area), itemPanel(area), farmPanel(area))
      : el('p', { class: 'ad-empty' },
        'No area data for wherever you are. Pick one above to browse.'),
    trainerCard(),
    progressPanel());
}

function header(area) {
  const loc = here?.location ?? 'unknown';
  const bar = el('div', { class: 'ad-bar' });

  bar.append(el('div', { class: 'ad-here' },
    el('span', { class: 'ad-label' }, 'You are in'),
    el('b', {}, loc),
    el('span', { class: 'ad-tile' },
      here ? `zone ${here.zone_id} · tile ${here.tile.x}, ${here.tile.z}` : '')));

  // Browsing anywhere matters as much as the live readout: most of the time
  // you are planning where to go, not checking where you stand.
  const sel = el('select', { class: 'ad-pick', title: 'Look at any area' });
  const named = Object.values(S.AREAINDEX ?? {})
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.name.localeCompare(b.name));
  for (const a of named) {
    const has = a.wiki.length || a.items.length;
    const o = el('option', { value: a.name },
      `${a.name}${has ? '' : ' — nothing recorded'}`);
    if (area && a.name === area.name) o.selected = true;
    sel.append(o);
  }
  sel.onchange = () => { view.area = S.AREAINDEX[sel.value]; render(); };

  const back = el('button', { class: 'ad-btn', disabled: !here?.area || view.area === null,
    title: 'Jump back to where you actually are' }, 'Back to me');
  back.onclick = () => { view.area = null; render(); };



  bar.append(el('span', { class: 'ad-spacer' }), sel, back);
  return bar;
}

/**
 * The region map: the game's own artwork, with places on it and ROUTES
 * BETWEEN THEM.
 *
 * The routes being the lines is the whole idea, and it is how the in-game map
 * reads. You do not look up "Route 4"; you notice it is the thing between
 * Castelia and Nimbasa. So a line is hoverable and clickable in its own right
 * -- it is a place you walk through, with its own encounters and items.
 *
 * Places carry three weights, because forty identical dots is unreadable
 * however nice each dot is: cities are labelled always, towns and landmarks
 * on hover, landmarks muted.
 *
 * The image is fetched by ./setup. Positions are fractions of it, placed by
 * eye; the map editor moves them, and Save to repo shares the fix.
 */
function mapPanel(area) {
  const M = S.MAP;
  if (!M?.places) return null;
  const E = editor();
  const PL = E.places();
  const LK = E.links();
  const at = (n) => PL[n] ?? M.places[n];
  const hereName = here?.area?.name ?? null;
  const shownName = area?.name ?? null;
  const editing = Boolean(view.editing);

  const wrap = el('div', { class: `ad-map${view.cityNames ? ' citynames' : ''}`
    + `${view.miscNames ? ' miscnames' : ''}${view.showNotes === false ? ' nonotes' : ''}`
    + `${editing ? ' editing' : ''}${editing && view.editTool === 'connect' ? ' connecting' : ''}` });
  const img = el('img', { class: 'ad-mapimg', src: M.image, alt: 'Map of Unova' });
  img.onerror = () => wrap.replaceChildren(el('p', { class: 'ad-empty' },
    'No map image yet. Run ', el('code', {}, './setup'), ' to fetch it, or drop one at ',
    el('code', {}, 'app/img/unova.jpg'), '.'));

  // --- the routes, drawn first so places sit on top of them ---------------
  const V = 1000;
  const seg = [];
  LK.forEach((l, i) => {
    const pts = l.pts;
    const d = pts.map(([x, y], k) => `${k ? 'L' : 'M'}${(x * V).toFixed(1)},${(y * V).toFixed(1)}`).join(' ');
    const isHere = l.areas?.includes(hereName);
    const isShown = !isHere && l.areas?.includes(shownName);
    const cls = ['ad-link', l.areas?.length ? 'named' : 'plain', isHere ? 'here' : '',
      isShown ? 'shown' : '', l.spur ? 'spur' : '',
      editing && sel?.kind === 'link' && sel.i === i ? 'sel' : ''].filter(Boolean).join(' ');
    // A fat transparent stroke underneath gives the line a hit area you can
    // actually land on; 2px of visible line is not a click target.
    seg.push(`<g class="${cls}" data-link="${i}"`
      + `${l.areas?.length ? ` data-area="${esc(l.areas[0])}"` : ''}>`
      + `<path d="${d}" class="ad-hit"/>`
      + `<path d="${d}" class="ad-under"/><path d="${d}" class="ad-line"/>`
      + (l.areas?.length
        ? `<title>${esc(l.areas.join(' · '))} — ${esc(l.a)} to ${esc(l.b)}</title>` : '')
      + '</g>');
  });
  const lines = el('div', { class: 'ad-links' });
  lines.innerHTML = `<svg viewBox="0 0 ${V} ${V}" preserveAspectRatio="none">${seg.join('')}</svg>`;

  // --- route badges, in their own layer so they are not stretched ---------
  // A leg can pass through several areas -- Route 5 then the Driftveil
  // Drawbridge -- so badges are spaced along it rather than dumped on the
  // midpoint. Without that, every bridge but Skyarrow was simply missing.
  const tags = el('div', { class: `ad-routetags${view.routeNames ? ' show' : ''}` });
  LK.forEach((l, i) => {
    if (!l.areas?.length) return;
    const pts = l.pts;
    l.areas.forEach((areaName, k) => {
      const [x, y] = alongPath(pts, (k + 1) / (l.areas.length + 1));
      const isHere = areaName === hereName;
      const isShown = areaName === shownName && !isHere;
      const num = /^Route (\d+)$/.exec(areaName);
      const t = el('button', {
        // Prefixed. A bare `num` collided with the global sheet's own
        // .num{color:var(--ink-faint)} -- which is injected app-wide at boot --
        // and quietly repainted every route shield's number in faint grey on a
        // near-white pill. That is what made them unreadable at rest.
        class: `ad-routetag ${num ? 'ad-num' : 'ad-named'}`
          + `${isHere ? ' here' : ''}${isShown ? ' shown' : ''}`,
        style: `left:${x * 100}%; top:${y * 100}%`,
        title: `${areaName} — between ${l.a} and ${l.b}. Click to see what is there.`,
        'data-link': String(i),
      }, num ? num[1] : areaName);
      t.onclick = () => { view.area = S.AREAINDEX[areaName]; render(); };
      tags.append(t);
    });
  });

  // --- places -------------------------------------------------------------
  const layer = el('div', { class: `ad-markers${editing ? ' editing' : ''}` });
  for (const [name, base] of Object.entries(PL)) {
    if (!S.AREAINDEX[name]) continue;
    const p = base;
    const isHere = name === hereName;
    const isShown = name === shownName && !isHere;
    const m = el('button', {
      class: `ad-pin k-${base.kind}${isHere ? ' here' : ''}${isShown ? ' shown' : ''}`
        + `${editing && sel?.kind === 'place' && sel.name === name ? ' sel' : ''}`
        + `${editing && armed?.kind === 'from' && armed.name === name ? ' from' : ''}`,
      style: `left:${p.x * 100}%; top:${p.y * 100}%`,
      title: editing ? `${name} — drag to move, click to select`
        : (isHere ? `${name} — you are here` : name),
    }, el('span', { class: 'ad-pindot' }), el('span', { class: 'ad-pinlab' }, name));
    if (editing) {
      m.onpointerdown = (e) => {
        if (view.editTool === 'connect') return;   // connect is click, not drag
        drag = { kind: 'place', name, moved: false, el: m };
        m.setPointerCapture?.(e.pointerId);
        e.preventDefault();
      };
      m.onclick = () => {
        if (drag?.moved) return;
        if (view.editTool === 'connect') {
          if (!armed || armed.kind !== 'from') { armed = { kind: 'from', name }; render(); return; }
          if (armed.name !== name) E.connect(armed.name, name);
          armed = null; render(); return;
        }
        sel = { kind: 'place', name }; render();
      };
    } else {
      m.onclick = (e) => {
        if (e.shiftKey) return;
        view.area = S.AREAINDEX[name];
        render();
      };
    }
    layer.append(m);
  }

  // --- your own notes, in both modes: the point of marking the map is
  // --- seeing the mark later, not only while you are placing it.
  const notes = el('div', { class: `ad-notes${editing ? ' editing' : ''}` });
  E.notes.forEach((n) => {
    const b = el('button', {
      class: `ad-note${editing && sel?.kind === 'note' && sel.id === n.id ? ' sel' : ''}`,
      style: `left:${n.x * 100}%; top:${n.y * 100}%`,
      title: n.text || 'Empty note',
    }, el('span', { class: 'ad-notedot' }, '\u270e'),
       el('span', { class: 'ad-notelab' }, n.text || 'note'));
    if (editing) {
      b.onpointerdown = (e) => {
        drag = { kind: 'note', id: n.id, moved: false, el: b };
        b.setPointerCapture?.(e.pointerId); e.preventDefault();
      };
      b.onclick = () => { if (!drag?.moved) { sel = { kind: 'note', id: n.id }; render(); } };
    }
    notes.append(b);
  });

  // --- bend handles, only for the link you are actually editing ----------
  const handles = el('div', { class: 'ad-handles' });
  if (editing && sel?.kind === 'link' && LK[sel.i]) {
    (E.linkEdits?.[sel.i]?.bends ?? []).forEach(([x, y], k) => {
      const h = el('button', { class: 'ad-handle', style: `left:${x * 100}%; top:${y * 100}%`,
        title: 'Drag to bend the road' });
      h.onpointerdown = (e) => {
        drag = { kind: 'bend', i: sel.i, k, moved: false, el: h };
        h.setPointerCapture?.(e.pointerId); e.preventDefault();
      };
      handles.append(h);
    });
  }

  wrap.append(img, lines, tags, layer, notes, handles);

  // --- dragging. One pointer gesture is ONE undo step, so the model is only
  // --- told once the drag ends, not on every mousemove.
  if (editing) {
    const frac = (e) => {
      const r = wrap.getBoundingClientRect?.();
      if (!r || !r.width) return null;
      return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
    };
    wrap.onpointermove = (e) => {
      if (!drag) return;
      const f = frac(e);
      if (!f) return;
      drag.moved = true;
      drag.at = f;
      // Move the captured element directly for live feedback; the MODEL is
      // told once, on pointerup, so a drag is one undo step and not one per
      // pixel of mouse travel.
      if (drag.el) {
        drag.el.style.left = `${f[0] * 100}%`;
        drag.el.style.top = `${f[1] * 100}%`;
      }
    };
    wrap.onpointerup = () => {
      if (!drag) return;
      const d = drag; drag = null;
      // A plain click still has to become a SELECTION, and click fires after
      // pointerup. Re-rendering here detached the element before the click
      // could reach it, so no marker could ever be selected -- which also made
      // "Take off the map" unreachable, since it only exists for a selection.
      // Nothing moved, so there is nothing to redraw anyway.
      if (!d.moved || !d.at) return;
      if (d.kind === 'place') E.move(d.name, d.at[0], d.at[1]);
      else if (d.kind === 'note') E.moveNote(d.id, d.at[0], d.at[1]);
      else if (d.kind === 'bend') E.setBend(d.i, d.k, d.at[0], d.at[1]);
      E.persist();
      render();
    };
    // Clicking bare map either drops the armed tray area or adds a note.
    wrap.onclick = (e) => {
      if (drag?.moved) return;
      // NOT `e.target === img`: .ad-links covers the whole map and its <svg>
      // is the hit target over empty ground, so the image is rarely what you
      // actually clicked. Ask the useful question instead -- did this land on
      // something interactive? -- which holds however the layers are stacked.
      if (e.target?.closest?.('.ad-pin, .ad-note, .ad-handle, g.ad-link')) return;
      const f = frac(e);
      if (!f) return;
      if (armed?.kind === 'tray') {
        const name = armed.name;
        // Inferred from the name, not always `landmark` -- placing a dozen
        // pins by hand and finding every one of them the smallest, most muted
        // marker is not a default anyone wants.
        E.place(name, f[0], f[1], armed.kindWanted ?? MapEdit.kindFor(name));
        armed = null;
        sel = { kind: 'place', name };      // select it, so you can set its kind
        E.persist(); render(); return;
      }
      // A SPUR: place armed, then a click on bare map -- which in practice is a
      // click ON a road. Landmarks hang off routes far more often than they
      // sit between two towns, and a route is an edge here, so there was
      // otherwise no way to say "Wellspring Cave opens onto Route 3" at all.
      if (view.editTool === 'connect' && armed?.kind === 'from') {
        if (E.spur(armed.name, f[0], f[1])) { armed = null; E.persist(); render(); return; }
        armed = null; render(); return;
      }
      if (view.editTool === 'note') {
        E.addNote(f[0], f[1], '');
        sel = { kind: 'note', id: E.notes[E.notes.length - 1].id };
        E.persist(); render();
      }
    };
  }

  // Hovering a line lights it and its label together, which is what makes the
  // two read as one thing rather than a line and a floating badge.
  const setHot = (i, on) => {
    lines.querySelectorAll?.(`g[data-link="${i}"]`)?.forEach?.(
      (g) => g.classList.toggle('hot', on));
    tags.querySelectorAll?.(`[data-link="${i}"]`)?.forEach?.(
      (b) => b.classList.toggle('hot', on));
  };
  lines.onmouseover = (e) => {
    const g = e.target?.closest?.('g.ad-link');
    if (g) setHot(g.getAttribute('data-link'), true);
  };
  lines.onmouseout = (e) => {
    const g = e.target?.closest?.('g.ad-link');
    if (g) setHot(g.getAttribute('data-link'), false);
  };
  lines.onclick = (e) => {
    const g = e.target?.closest?.('g.ad-link');
    if (!g) return;
    if (editing) { sel = { kind: 'link', i: +g.getAttribute('data-link') }; render(); return; }
    const a = g.getAttribute('data-area');
    if (a && S.AREAINDEX[a]) { view.area = S.AREAINDEX[a]; render(); }
  };
  tags.onmouseover = (e) => {
    const b = e.target?.closest?.('[data-link]');
    if (b) setHot(b.getAttribute('data-link'), true);
  };
  tags.onmouseout = (e) => {
    const b = e.target?.closest?.('[data-link]');
    if (b) setHot(b.getAttribute('data-link'), false);
  };

  const head = el('h3', {}, 'Unova',
    el('span', {}, hereName ? `you are in ${hereName}` : 'your area is not on the map'));

  const tools = el('div', { class: 'ad-tools' });
  // Two display toggles. Both follow the same rule: everything else labels
  // itself only when you hover it, when it is where you are, or when it is
  // what you have selected.
  // The label NAMES the thing; the pressed state says whether it is on. A
  // label that changed to "City names off" left you unable to tell whether it
  // was reporting the current state or describing what clicking would do --
  // and the two readings are exact opposites.
  const toggle = (key, label, tip) => {
    const on = Boolean(view[key]);
    const b = el('button', {
      class: `ad-btn${on ? ' on' : ''}`, 'aria-pressed': String(on),
      title: `${tip} — currently ${on ? 'shown' : 'hidden'}`,
    }, label);
    b.onclick = () => { view[key] = !view[key]; savePrefs(); render(); };
    return b;
  };
  tools.append(
    // Towns are settlements: they belong with cities, not with the gates,
    // caves and towers that "Misc." covers.
    toggle('cityNames', 'City / town names',
      'Keep the names of cities and towns on the map permanently'),
    toggle('routeNames', 'Route labels',
      'Keep the route badges on the map permanently. They still appear when you '
      + 'hover a line either way.'),
    // Everything that is neither a city nor a route: gates, forests, towers,
    // the small muted markers. Off by default, because they are the ones that
    // made the map unreadable when every label was permanent.
    toggle('miscNames', 'Landmark names',
      'Label caves, towers, forests and gates permanently — everything that is '
      + 'neither a settlement nor a route. They still appear when you hover '
      + 'them either way.'));

  // Notes are yours, so the toggle is meaningless until you have made one.
  const notesOn = view.showNotes !== false;
  const nb = el('button', {
    class: `ad-btn${notesOn ? ' on' : ''}`, 'aria-pressed': String(notesOn),
    title: E.notes.length
      ? `Show or hide the notes you have left on the map — currently ${notesOn ? 'shown' : 'hidden'}`
      : 'You have not left any notes yet. Add one with the Note tool in the map editor.',
  }, 'Notes');
  nb.disabled = !E.notes.length;
  nb.onclick = () => { view.showNotes = view.showNotes === false; savePrefs(); render(); };
  tools.append(nb);

  const fold = el('button', { class: 'ad-fold', 'aria-expanded': String(view.mapOpen),
    title: view.mapOpen ? 'Hide the map' : 'Show the map' }, view.mapOpen ? '▾' : '▸');
  fold.onclick = () => { view.mapOpen = !view.mapOpen; savePrefs(); render(); };
  head.prepend(fold);

  if (!view.mapOpen) {
    return el('section', { class: 'ad-panel ad-mapwrap folded' }, head);
  }

  if (editing) {
    // In edit mode the map IS the tab: no display toggles, no footnote, all room.
    return el('section', { class: 'ad-panel ad-mapwrap editing' }, head, wrap);
  }
  tools.append(editEntry(E));
  return el('section', { class: 'ad-panel ad-mapwrap' }, head, wrap, tools, mapHint(M, E));
}

/**
 * The editor's own surface. It only exists in edit mode, and in edit mode it
 * is the only thing on the tab besides the map -- which is the point: the
 * markers were hard to place because everything else was competing for room.
 */
function editorPanel() {
  const E = editor();
  const sum = E.summary();
  const box = el('section', { class: 'ad-panel ad-editor' });

  // --- what you are doing ------------------------------------------------
  const tools = el('div', { class: 'ad-etools' });
  const tool = (id, label, tip) => {
    const b = el('button', { class: `ad-btn${(view.editTool ?? 'move') === id ? ' on' : ''}`,
      title: tip }, label);
    b.onclick = () => { view.editTool = id; armed = null; sel = null; savePrefs(); render(); };
    return b;
  };
  tools.append(
    el('span', { class: 'ad-elabel' }, 'Editing the map'),
    tool('move', 'Move', 'Drag any marker to move it. Click one to select it.'),
    tool('connect', 'Connect', 'Click one place, then another to draw the road between them — or click the road itself to attach a landmark that opens off it.'),
    tool('note', 'Note', 'Click anywhere on the map to leave yourself a note.'),
    el('span', { class: 'ad-spacer' }));

  // What this tool does, in one line, next to the tool itself -- not in a
  // paragraph further down that you have to go looking for.
  const HOWTO = {
    move: 'Drag a marker to move it. Click one to select it — then you can change '
      + 'what kind of place it is, or take it off the map.',
    connect: 'Click one place, then another to draw the road between them — or click a road to attach a landmark that opens off it. '
      + 'Then say which areas that road passes through.',
    note: 'Click anywhere on the map to leave yourself a note. Notes stay in this '
      + 'browser — they are never saved to the repo.',
  };

  const undo = el('button', { class: 'ad-btn', title: 'Undo the last change' },
    E.undoStack.length ? `Undo ${E.undoStack[E.undoStack.length - 1].label}` : 'Undo');
  undo.disabled = !E.undoStack.length;
  undo.onclick = () => { E.undo(); E.persist(); render(); };

  const done = el('button', { class: 'ad-btn on', title: 'Stop editing and go back to browsing' },
    'Done');
  done.onclick = () => { view.editing = false; armed = null; sel = null; savePrefs(); render(); };
  const clear = el('button', { class: 'ad-btn danger',
    title: 'Take every marker and road off the map, so you can place them yourself. '
      + 'Your notes are left alone, and Undo brings the whole map back in one step.' },
    'Clear the map');
  clear.onclick = () => {
    if (E.clearAll()) { sel = null; armed = null; E.persist(); }
    render();
  };
  tools.append(clear, undo, saveButton(E), done);
  box.append(tools, el('p', { class: 'ad-howto' }, HOWTO[view.editTool ?? 'move']));
  const saved = savedNote();
  if (saved) box.append(saved);

  box.append(el('p', { class: 'ad-hint' },
    `${sum.moved} marker${sum.moved === 1 ? '' : 's'} placed or moved · `
    + `${sum.links} road${sum.links === 1 ? '' : 's'} drawn · `
    + `${sum.unplaced} area${sum.unplaced === 1 ? '' : 's'} still off the map`
    + (sum.orphans ? ` · ${sum.orphans} with no road to them` : '')
    + (sum.notes ? ` · ${sum.notes} note${sum.notes === 1 ? '' : 's'} (yours only)` : '')));

  box.append(selectionBox(E), trayBox(E));
  return box;
}

/**
 * Save writes to the repo, so it says what it is about to do.
 *
 * AND WHAT IS LEFT TO DO, WHICH IS THE HALF THAT WAS MISSING. Writing the
 * file is one hop of four: the position only reaches the map after
 * build_static.py merges it, and only reaches ANOTHER PERSON after the file
 * is committed. The button used to say "Saved" and stop there, so the honest
 * reading of it was "this worked" when in fact nothing on the map had changed
 * yet and nothing had left this machine. Two silent steps is exactly how a
 * collaborative fix quietly stays personal.
 *
 * The whole pipeline is pinned by tools/verify_maproute.py.
 */
function saveButton(E) {
  const b = el('button', { class: 'ad-btn go',
    title: 'Write these positions to state/map_positions.json. Commit that file and '
      + 'everyone who pulls gets them — your notes are NOT included.' }, 'Save to repo');
  b.onclick = async () => {
    b.disabled = true; b.textContent = 'Saving…';
    savedMsg = null;
    E.persist();
    try {
      const r = await fetch('/api/map', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(E.toPayload()),
      });
      const j = await r.json().catch(() => ({}));
      b.textContent = r.ok ? 'Saved' : (j.error ? `Failed: ${j.error}` : 'Failed');
      if (r.ok) {
        savedMsg = { ok: true, path: j.path ?? 'state/map_positions.json',
          rebuild: j.rebuild ?? 'python3 build_static.py' };
      }
    } catch {
      // No server is the normal case for anyone using the page from a file.
      b.textContent = 'Saved in this browser only';
      savedMsg = { ok: false };
    }
    setTimeout(() => { b.disabled = false; render(); }, 1800);
  };
  return b;
}

/** What still has to happen before anybody else sees this correction. */
function savedNote() {
  if (!savedMsg) return null;
  if (!savedMsg.ok) {
    return el('p', { class: 'ad-hint ad-saved' },
      'Saved in this browser only — there is no server to write to. These positions '
      + 'will follow you on this machine, but they cannot reach anyone else. Run '
      + './serve and press Save again to write them to the repo.');
  }
  const file = savedMsg.path.split('/').slice(-2).join('/');
  return el('p', { class: 'ad-hint ad-saved' },
    el('b', {}, 'Written to '), el('code', {}, file), '. Two steps left before anyone '
    + 'else has it: run ', el('code', {}, savedMsg.rebuild), ' to fold it into the map, '
    + 'then commit that file. It is deliberately not gitignored — committing it is '
    + 'the whole mechanism by which a correction travels.');
}

/** What is selected, and the things you can do to it. */
function selectionBox(E) {
  if (!sel) {
    return el('p', { class: 'ad-hint ad-esel' },
      (view.editTool ?? 'move') === 'connect'
        ? (armed?.kind === 'from'
          ? `Now click the place ${armed.name} connects to — or the road it opens off.`
          : 'Click the first of the two places you want to connect.')
        : (view.editTool === 'note'
          ? 'Click anywhere on the map to drop a note.'
          : 'Nothing selected. Click a marker to change its kind or take it off the '
            + 'map, or click a road to set which areas it covers.'));
  }
  const wrap = el('div', { class: 'ad-esel' });

  if (sel.kind === 'place') {
    const p = E.places()[sel.name];
    if (!p) { sel = null; return el('span'); }
    wrap.append(el('b', {}, sel.name));
    ['city', 'town', 'landmark'].forEach((k) => {
      const b = el('button', { class: `ad-btn sm${p.kind === k ? ' on' : ''}`,
        title: k === 'city' ? 'Always labelled'
          : k === 'town' ? 'Labelled on hover' : 'Small and muted' }, k);
      b.onclick = () => { E.setKind(sel.name, k); E.persist(); render(); };
      wrap.append(b);
    });
    const rm = el('button', { class: 'ad-btn sm',
      title: 'Take it off the map. It goes back to the tray below — nothing is lost.' },
      'Take off the map');
    rm.onclick = () => { E.unplace(sel.name); sel = null; E.persist(); render(); };
    wrap.append(rm);
  }

  if (sel.kind === 'link') {
    const L = E.links()[sel.i];
    if (!L) { sel = null; return el('span'); }
    wrap.append(el('b', {}, `${L.a} – ${L.b}`));
    // A leg can carry several areas: you walk Route 5 and then the drawbridge.
    const pick = el('select', { class: 'ad-esel-sel',
      title: 'Which area you travel through on this road. Pick one to add it.' });
    pick.append(el('option', { value: '' }, 'add an area…'));
    Object.keys(S.AREAINDEX).sort().forEach((a) => pick.append(el('option', { value: a }, a)));
    pick.onchange = () => {
      if (!pick.value) return;
      E.setLinkAreas(sel.i, [...L.areas, pick.value]);
      E.persist(); render();
    };
    wrap.append(pick);
    L.areas.forEach((a) => {
      const c = el('button', { class: 'ad-btn sm on', title: `Remove ${a} from this road` },
        `${a} ×`);
      c.onclick = () => {
        E.setLinkAreas(sel.i, L.areas.filter((v) => v !== a)); E.persist(); render();
      };
      wrap.append(c);
    });
    const bend = el('button', { class: 'ad-btn sm',
      title: 'Add a bend so the road follows the terrain, then drag it' }, 'Add bend');
    bend.onclick = () => {
      const b = E.linkEdits?.[sel.i]?.bends ?? [];
      const mid = alongPath(L.pts, 0.5);
      E.setBend(sel.i, b.length, mid[0], mid[1]); E.persist(); render();
    };
    const straight = el('button', { class: 'ad-btn sm', title: 'Remove every bend' },
      'Straighten');
    straight.onclick = () => { E.clearBends(sel.i); E.persist(); render(); };
    const del = el('button', { class: 'ad-btn sm', title: 'Remove this road' }, 'Delete road');
    del.onclick = () => { E.removeLink(sel.i); sel = null; E.persist(); render(); };
    wrap.append(bend, straight, del);
  }

  if (sel.kind === 'note') {
    const n = E.notes.find((v) => v.id === sel.id);
    if (!n) { sel = null; return el('span'); }
    wrap.append(el('b', {}, 'Note'));
    const t = el('input', { class: 'ad-esel-in', value: n.text,
      placeholder: 'Audino swarm here · come back with Surf' });
    t.oninput = () => { n.text = t.value; E.persist(); };
    const del = el('button', { class: 'ad-btn sm', title: 'Delete this note' }, 'Delete');
    del.onclick = () => { E.removeNote(sel.id); sel = null; E.persist(); render(); };
    wrap.append(t, del);
    setTimeout(() => t.focus?.(), 0);
  }
  return wrap;
}

/** Every area not yet on the map. Click one, then click where it goes. */
/**
 * The tray: places you can still pin, and separately the routes you cannot.
 *
 * Routes used to be listed here with the towns, which invited you to drop
 * Route 4 somewhere as a dot. A route is an EDGE on this map -- it is set by
 * drawing a link in Connect and saying which areas that leg carries -- so it
 * is listed apart, as a to-do list for the other tool rather than a button
 * that does the wrong thing.
 */
function trayBox(E) {
  const un = E.unplaced();
  const routes = E.unrouted();
  const box = el('div', { class: 'ad-tray' });

  box.append(el('span', { class: 'ad-elabel' },
    un.length ? `Not on the map yet (${un.length})` : 'Every place is on the map'));
  if (un.length) {
    box.append(el('span', { class: 'ad-hint' },
      armed?.kind === 'tray' ? `Click the map to put ${armed.name} there.`
        : 'Click one, then click where it belongs.'));
    un.forEach((name) => {
      const b = el('button', {
        class: `ad-btn sm${armed?.kind === 'tray' && armed.name === name ? ' on' : ''}`,
        title: `Place it as a ${MapEdit.kindFor(name)} — you can change that after`,
      }, name);
      b.onclick = () => {
        armed = armed?.kind === 'tray' && armed.name === name ? null : { kind: 'tray', name };
        view.editTool = 'move';
        render();
      };
      box.append(b);
    });
  }

  if (routes.length) {
    box.append(el('span', { class: 'ad-elabel ad-traysplit' },
      `Routes with no road yet (${routes.length})`));
    box.append(el('span', { class: 'ad-hint' },
      'A route is a line, not a pin. Draw the road it runs along with '
      + '“Connect”, then add the route to that leg.'));
    const list = el('div', { class: 'ad-trayroutes' });
    routes.forEach((name) => list.append(el('span', { class: 'ad-traychip' }, name)));
    box.append(list);
  }
  if (!un.length && !routes.length) {
    box.append(el('span', { class: 'ad-hint' }, 'Nothing left to place.'));
  }
  return box;
}

/**
 * The one-line footnote under the map: what is on it, and how to change it.
 */
function mapHint(M, E) {
  const sum = E.summary();
  const p = el('p', { class: 'ad-hint' },
    `${Object.keys(E.places()).length} places and ${E.links().length} roads. `
    + 'Click a road or a marker to see what is there.');
  if (sum.moved || sum.linksChanged) {
    p.append(` ${sum.moved} marker${sum.moved === 1 ? '' : 's'} and `
      + `${Math.abs(sum.linksChanged)} road${Math.abs(sum.linksChanged) === 1 ? '' : 's'} `
      + 'differ from what shipped — Save to repo in the editor to share them.');
  }
  return p;
}

function editEntry(E) {
  const b = el('button', { class: 'ad-btn',
    title: 'Move markers, put missing places on the map, and draw the roads between them' },
    'Edit map');
  b.onclick = () => { view.editing = true; sel = null; armed = null; savePrefs(); render(); };
  return b;
}

function alongPath(pts, t) {
  const segs = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    segs.push(d); total += d;
  }
  if (!total) return pts[0];
  let want = t * total;
  for (let i = 0; i < segs.length; i++) {
    if (want <= segs[i] || i === segs.length - 1) {
      const f = segs[i] ? want / segs[i] : 0;
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f,
        pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
    }
    want -= segs[i];
  }
  return pts[pts.length - 1];
}

/**
 * "Route 4" -> "4". Everything else keeps its full name.
 *
 * Bridges used to be truncated to fit ("Skyarrow Bridge" -> "Skyarrow"),
 * which read as a stray word dropped on the map rather than a label for the
 * line under it. A numbered route is unambiguous as a bare number; a named
 * one is not.
 */
function shortRoute(name) {
  const m = /^Route (\d+)$/.exec(name);
  return m ? m[1] : name;
}

const PREF_KEY = 'blazeblack.adventure.view';
function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({
      mapOpen: view.mapOpen, cityNames: view.cityNames,
      routeNames: view.routeNames, progress: view.progress,
      miscNames: view.miscNames, showNotes: view.showNotes,
      editTool: view.editTool, progKind: view.progKind,
      playerFace: view.playerFace, cardOpen: view.cardOpen,
    }));
  } catch { /* private mode */ }
}
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}'); } catch { return {}; }
}

const NUDGE_KEY = 'blazeblack.map.nudges';
function loadNudges() {
  try { return JSON.parse(localStorage.getItem(NUDGE_KEY) ?? '{}'); } catch { return {}; }
}
const esc = (x) => String(x).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function panel(title, hint, body) {
  return el('section', { class: 'ad-panel' },
    el('h3', {}, title, hint ? el('span', {}, hint) : null), body);
}

// ---------------------------------------------------------- encounters
/**
 * YOUR ONE ENCOUNTER HERE -- only when the nuzlocke is on.
 *
 * It belongs on this tab and not only in the Run tab, because this is where
 * you are standing when you meet something. Logging it three clicks away in
 * another tab is how a log stops being kept.
 *
 * The panel is absent entirely when the mode is off. A player who is not
 * nuzlocking must see no difference anywhere, and an empty "Encounter" box
 * would be a difference.
 */
function nuzPanel(area) {
  if (!NUZ?.enabled || !N.active(NUZ, 'one-per-area')) return null;
  const name = area.name;
  const logged = NUZ.encounters?.[name] ?? null;
  const spent = N.areaSpent(NUZ, name);

  const body = el('div', {});
  if (logged) {
    const spName = S.SPECIES?.[String(logged.speciesId)]?.name ?? '—';
    body.append(el('p', { class: 'ad-nuzhas' },
      el('b', {}, logged.nickname || spName),
      spName && logged.nickname ? ` the ${spName}` : '',
      ` — ${logged.status}.`,
      spent ? ' This area is spent.' : ' The duplicates clause lets you try again.'));
    const clear = el('button', { class: 'ad-btn', title: 'Remove this entry and log another' },
      'Clear it');
    clear.onclick = () => { N.clearEncounter(NUZ, name); persistNuz(); render(); };
    body.append(el('div', { class: 'ad-tools' }, clear));
    return panel('Your encounter here', spent ? 'spent' : 'clause applies', body);
  }

  // What is catchable here, so logging is a pick rather than a search.
  const ids = new Set();
  for (const w of area.wiki ?? []) {
    for (const r of S.AREAS?.[w] ?? []) for (const m of r.mons ?? []) ids.add(m.id);
  }
  const ownedIds = (F ? [...new Set(N_INDEX.map((e) => e.mon.speciesId))] : []);
  const pick = el('select', { class: 'ad-esel-sel', 'aria-label': 'What did you meet?' },
    el('option', { value: '' }, 'What did you meet?'),
    ...[...ids].sort((a, b) => a - b).map((id) => {
      const sp = S.SPECIES?.[String(id)];
      const dupe = N.isDuplicate(NUZ, id, ownedIds, S);
      return el('option', { value: String(id) },
        `${sp?.name ?? `#${id}`}${dupe ? ' — duplicate' : ''}`);
    }));
  const log = (status) => {
    const id = Number(pick.value);
    if (!Number.isInteger(id) || !id) return;
    N.recordEncounter(NUZ, name, { speciesId: id, status });
    persistNuz(); render();
  };
  const caught = el('button', { class: 'ad-btn primary' }, 'Caught it');
  caught.onclick = () => {
    const id = Number(pick.value);
    // The clause is applied HERE rather than left to the player to remember:
    // that is the difference between a rule the app keeps and a note.
    const dupe = N.isDuplicate(NUZ, id, ownedIds, S);
    log(dupe ? 'dupe' : 'caught');
  };
  const fled = el('button', { class: 'ad-btn' }, 'Lost it');
  fled.onclick = () => log('fled');
  body.append(el('p', { class: 'ad-hint' },
    'One encounter per area. Log what you met — a duplicate does not spend the area '
    + 'while the duplicates clause is on.'));
  body.append(el('div', { class: 'ad-tools' }, pick, caught, fled));
  return panel('Your encounter here', 'not logged yet', body);
}

function persistNuz() {
  N.save(TRAINER?.trainer_id ?? 0, NUZ);
  CTXREF?.onNuzlockeChange?.(NUZ);
}

function encounterPanel(area) {
  const rows = (area.wiki ?? []).flatMap((w) => (S.AREAS[w] ?? [])
    .map((r) => ({ ...r, from: w })));
  if (!rows.length) {
    return panel('Wild Pokémon', 'nothing recorded for this area',
      el('p', { class: 'ad-empty' },
        'The wiki has no encounter table here. That usually means a town, a gate '
        + 'or an indoor area rather than an omission.'));
  }

  const hasSurf = bagNames.tms.some((n) => n.startsWith('HM03'));
  const hasRod = bagNames.key.some((n) => /Rod/.test(n));

  const wrap = el('div', {});
  const newHere = new Set();
  for (const r of rows) {
    const gated = (r.method.includes('surf') && !hasSurf)
      || (r.method.includes('fishing') && !hasRod);
    const head = el('div', { class: `ad-method${gated ? ' gated' : ''}` },
      el('b', {}, METHOD_LABEL[r.method] ?? r.method),
      r.from && area.wiki.length > 1 ? el('i', {}, r.from) : null,
      gated ? el('span', { class: 'ad-gate' },
        r.method.includes('surf') ? 'needs Surf' : 'needs the rod') : null,
      // Eight rows in the wiki merged a legendary's LEVEL into the rate table.
      r.suspect ? el('span', { class: 'ad-warn', title:
        `This row totals ${r.total}%. Drayano lists legendaries and specials separately `
        + 'with a LEVEL; the wiki flattened them in, so one of these numbers is a level '
        + 'rather than a rate.' }, 'rates suspect') : null);

    const grid = el('div', { class: 'ad-mons' });
    for (const m of r.mons) {
      const name = S.SPNAME?.[m.id] ?? `#${m.id}`;
      const caught = dex.caughtSet.has(m.id);
      if (!caught) newHere.add(name);
      if (caught && !view.showCaught) continue;
      grid.append(el('div', {
        class: `ad-mon${caught ? ' caught' : ' new'}`,
        title: `${name} · ${m.pct}%${caught ? ' · already caught' : ' · not in your Pokédex'}`,
      },
        S.SPRITE[name] ? el('img', { src: S.SPRITE[name], alt: '', loading: 'lazy' }) : null,
        el('span', { class: 'ad-mname' }, name),
        el('span', { class: 'ad-pct' }, `${m.pct}%`)));
    }
    wrap.append(head, grid);
  }

  const tog = el('button', { class: `ad-btn${view.showCaught ? '' : ' on'}` },
    view.showCaught ? 'Hide ones I have' : 'Show everything');
  tog.onclick = () => { view.showCaught = !view.showCaught; render(); };
  wrap.append(el('div', { class: 'ad-tools' }, tog));

  return panel('Wild Pokémon',
    newHere.size ? `${newHere.size} here you have not caught` : 'nothing new here for you',
    wrap);
}

// The battle companion's own encounter-index vocabulary, kept identical so a
// filter chip means the same thing on both tabs. KIND_ORDER is game shape
// rather than alphabetical: the gyms are the spine, the rest hang off it.
const KIND_LABEL = { gym: 'gym', elite: 'elite four', rival: 'rival', n: 'N',
  plasma: 'plasma', champion: 'champion', story: 'story' };
const KIND_ORDER = ['gym', 'rival', 'n', 'plasma', 'elite', 'champion', 'story'];

// ----------------------------------------------------------- trainer card
/**
 * The game's own trainer card, as far as the save actually tells us.
 *
 * EVERYTHING ON IT IS NOW VERIFIED, badges included. The OT name, both ids and
 * the money were checked against the in-game card; the Pokedex counts come out
 * of their own block; and badges were settled on 2026-08-29 by the one
 * experiment that could settle them -- a save kept immediately before the
 * fourth gym leader, the leader beaten, a save taken again. `0x21204` went
 * 0b0111 -> 0b1111, one bit per badge, low bits first.
 *
 * This card carried a row of eight "?" for weeks rather than eight guessed
 * circles, because a trainer card that quietly invents your badge count is
 * worse than one that admits it cannot read it. The placeholder was right to
 * exist and is right to be gone.
 */
function trainerCard() {
  const t = TRAINER;
  if (!t) return null;
  const body = el('div', { class: 'ad-card' });

  // Trainer sprite 0 is the male player, 1 the female.
  //
  // `t.gender` is READ, not guessed, from the OT-gender bit on a Pokemon you
  // caught yourself -- see Save.playerGender(). When it is null the save has
  // no record with real met data to read it off (every record in a save built
  // by these tools has its met data zeroed), and then it falls back to a
  // remembered choice rather than assuming male.
  const known = t.gender === 0 || t.gender === 1;
  const which = known ? t.gender : (view.playerFace ?? 0);
  const face = (S.TRFACE ?? {})[String(which)];
  const port = el('button', { class: 'ad-cardface' + (known ? '' : ' guess'),
    title: known
      ? `Read from your own Pokémon: their original trainer is ${which ? 'female' : 'male'}.`
      : 'Your gender is not readable from this save — every record in it has '
        + 'blank met data, which is what a Pokémon written by a tool looks '
        + 'like. This is your choice; click to switch.' },
    face ? el('img', { src: face, alt: '' }) : el('span', {}, '?'));
  port.onclick = () => {
    if (known) return;
    view.playerFace = (view.playerFace ?? 0) === 0 ? 1 : 0;
    savePrefs(); render();
  };

  const kv = el('dl', { class: 'ad-cardkv' });
  const row = (k, v, cls) => { kv.append(el('dt', {}, k), el('dd', { class: cls ?? null }, v)); };
  row('Name', t.ot_name || '—');
  row('ID', String(t.trainer_id ?? '—').padStart(5, '0'));
  row('Money', t.money == null ? '—' : `¥${t.money.toLocaleString()}`);
  const dex = POKEDEX;
  if (dex) row('Pokédex', `${dex.caught_count ?? dex.caught?.length ?? 0} caught · `
    + `${dex.seen_count ?? dex.seen?.length ?? 0} seen`);
  if (here?.area?.name) row('Location', here.area.name);

  // Read, not guessed. One bit per badge at 0x21204, low bits first.
  //
  // EACH BADGE IS ITS OWN THING, so each gets its own shape and colour rather
  // than eight identical circles differing only in fill. A row of eight
  // interchangeable dots says "3 of 8" and nothing else; this says WHICH, and
  // the case you actually care about -- which one is next -- is legible
  // without a tooltip.
  const got = new Set(t.badges?.list ?? []);
  const badges = el('div', { class: 'ad-badges' });
  for (let i = 0; i < 8; i++) {
    const have = got.has(i);
    const b = BADGES[i];
    const next = !have && got.size === i;
    const cell = el('span', {
      class: `ad-badge${have ? ' on' : ''}${next ? ' next' : ''}`,
      title: `${b.name} Badge — ${b.gym} Gym — ${have ? 'earned' : next ? 'next' : 'not yet'}`,
    },
    el('img', { class: 'ad-badgeimg', src: `/app/img/badges/${b.img}.png`,
      alt: `${b.name} Badge`, loading: 'lazy' }),
    el('u', {}, b.name));
    badges.append(cell);
  }
  const last = [...got].sort((x, y) => y - x)[0];
  row('Badges', el('div', { class: 'ad-badgewrap' }, badges,
    el('span', { class: 'ad-hint' },
      `${got.size} of 8`
      + (last != null ? ` · latest ${BADGES[last].name}, from ${BADGES[last].gym}` : '')
      + (got.size < 8 ? ` · next ${BADGES[got.size].name} at ${BADGES[got.size].gym}` : ''))));

  body.append(port, kv);

  // FOLDABLE, like the map and the progress panel. It sits between "worth
  // farming here" and story progress, and it is reference rather than
  // something you act on -- most sessions you set it once and never look
  // again. Built even when folded so the header and its control are always
  // reachable; a collapsed panel that vanishes cannot be re-opened.
  const head = el('h3', {}, 'Trainer card',
    el('span', {}, t.ot_name ? `${t.ot_name} · ${String(t.trainer_id ?? '').padStart(5, '0')}` : ''));
  const fold = el('button', { class: 'ad-fold', 'aria-expanded': String(view.cardOpen),
    title: view.cardOpen ? 'Hide the trainer card' : 'Show the trainer card' },
    view.cardOpen ? '▾' : '▸');
  fold.onclick = () => { view.cardOpen = !view.cardOpen; savePrefs(); render(); };
  head.prepend(fold);
  return el('section', { class: 'ad-panel ad-cardpanel' + (view.cardOpen ? '' : ' folded') },
    head, view.cardOpen ? body : null);
}

// -------------------------------------------------------- story progress
/**
 * How far along you are.
 *
 * Badges ARE readable now (0x21204), but they are only eight points on a
 * 36-fight curve, so this still measures what it always measured: the
 * documented fights in game order, which of them you have ticked off in the
 * battle companion (shared through its own `bb_cleared` key), where you are
 * standing in the route order, and how your party's level compares to what is
 * next. The badge count is the spine those hang off, and it is stated rather
 * than inferred.
 */
/**
 * Open a documented fight in the battle companion.
 *
 * `bb_enc` is the battle sheet's own key: `i` is the encounter it selects on
 * load. `jump` is ours, and transient -- battle.js reads it once, clears it,
 * and scrolls to Known opponents instead of leaving you at the top of a long
 * page wondering what the click did.
 */
/**
 * Open one fight in the battle companion.
 *
 * BY KEY, NEVER BY INDEX. This tab holds the COMPLETE roster -- both Opelucid
 * leaders, because AREAINDEX stores positions in it -- while the battle tab
 * has already dropped the one that is not in your cartridge. Handing an index
 * across two lists of different lengths opened the wrong fight for everything
 * after Opelucid: "Plan this fight" on Cheren 7 landed on Shauntal. The slug
 * is stable across both the version filter and the starter fork, which is the
 * same reason bb_cleared uses it.
 */
function planFight(i) {
  const opp = OPPS[i];
  try {
    const st = JSON.parse(localStorage.getItem('bb_enc') ?? '{}');
    localStorage.setItem('bb_enc',
      JSON.stringify({ ...st, key: opp?.key ?? null, i, jump: 1 }));
  } catch { /* private mode: the battle tab just opens where it was */ }
  if (GOTO) GOTO('battle');
}

function progressPanel() {
  // The full list is filtered to your cartridge, but each fight keeps its
  // ORIGINAL index: AREAINDEX and bb_enc both key on position in the complete
  // list, so re-indexing here would open the wrong fight for everything after
  // Opelucid. `opps` is therefore sparse-by-omission, and every loop over it
  // carries the real index with it.
  const all = OPPS;
  const opps = all.map((o, i) => ({ o, i }))
    .filter(({ o }) => !o.ver || o.ver === VERSION);
  if (!opps.length) return null;
  // Built even when folded, so the header and its fold control are always
  // reachable -- a collapsed panel that vanishes cannot be re-opened.
  let cleared = {};
  try { cleared = JSON.parse(localStorage.getItem('bb_cleared') ?? '{}'); } catch { /* ignore */ }

  // ONE STORE, TWO TABS. The battle companion owns `bb_cleared`; ticking a
  // fight off here has to land in the same object under the same key or the
  // two views disagree about how far you are, which is worse than only one of
  // them offering the control.
  // KEYED ON THE FIGHT, NOT ITS POSITION. The battle companion switched to a
  // stable slug for the same reason: the roster changes shape when you switch
  // cartridge, and a position key would silently re-attribute every mark
  // after Opelucid to the wrong trainer.
  const ck = (o) => o.key ?? o.leader ?? '';
  const setCleared = (o, on) => {
    if (on) cleared[ck(o)] = 1; else delete cleared[ck(o)];
    try { localStorage.setItem('bb_cleared', JSON.stringify(cleared)); } catch { /* ignore */ }
    render();
  };

  const done = opps.filter(({ o }) => cleared[ck(o)]).length;
  const nextAt = opps.find(({ o }) => !cleared[ck(o)]) ?? null;
  const next = nextAt?.o ?? null;
  const lv = yourLevels();

  const stateOf = (o) => (cleared[ck(o)] ? 'done'
    : (next && ck(o) === ck(next)) ? 'next' : 'todo');

  const track = el('div', { class: 'ad-track' });
  opps.forEach(({ o, i }) => {
    const state = stateOf(o);
    const seg = el('button', {
      class: `ad-seg s-${state} k-${o.kind}`,
      title: `${o.leader ?? o.kind}${o.loc ? ` · ${o.loc}` : ''}`
        + `${o.lvmax ? ` · up to Lv ${o.lvmax}` : ''}`
        + ` — ${state === 'done' ? 'cleared' : state === 'next' ? 'next up' : 'ahead of you'}`,
    });
    seg.onclick = () => planFight(i);
    track.append(seg);
  });

  const body = el('div', {});

  // NEXT UP LEADS THE PANEL.
  //
  // It was the last thing on it, tucked under the tiles as a one-line strip,
  // which made the single most actionable fact here -- who you fight next and
  // whether you are ready -- read as an afterthought appended to a progress
  // report. It is the headline: portrait, name, place, level gap, and a
  // button straight into the fight.
  if (next) {
    const gap = lv && next.lvmax ? next.lvmax - lv.max : null;
    const cls = gap == null ? 'level' : gap > 3 ? 'behind' : gap < -5 ? 'ahead' : 'level';
    const verdict = gap == null ? 'level unrecorded'
      : gap > 3 ? `${gap} levels above your best (${lv.max})`
        : gap < -5 ? `you are ${-gap} levels above it`
          : `level with you (${lv.max})`;
    const go = el('button', { class: 'ad-btn primary',
      title: 'Open this fight in the battle companion' }, 'Plan this fight →');
    go.onclick = () => planFight(nextAt.i);
    body.append(el('div', { class: `ad-next g-${cls}` },
      faceOf(next.face, next.leader),
      el('div', { class: 'ad-nextid' },
        el('span', { class: 'ad-nextlab' }, 'Next up'),
        el('b', {}, next.leader ?? next.kind),
        el('span', { class: 'ad-tsub' },
          [next.loc, next.lvmax ? `up to Lv ${next.lvmax}` : null]
            .filter(Boolean).join(' · ')),
        el('span', { class: `ad-nextgap g-${cls}` }, verdict)),
      go));
  } else {
    body.append(el('div', { class: 'ad-next g-ahead' },
      el('div', { class: 'ad-nextid' },
        el('b', {}, 'Every documented fight is ticked off.'))));
  }

  body.append(track);

  const gyms = opps.filter((x) => x.o.kind === 'gym');
  const gymsDone = gyms.filter((x) => cleared[ck(x.o)]).length;
  body.append(el('p', { class: 'ad-verdict' },
    el('b', {}, `${done} of ${opps.length}`), ' documented fights cleared',
    gyms.length ? ` · ${gymsDone} of ${gyms.length} gym leaders` : ''));

  // EVERY MAJOR FIGHT, not only the gyms.
  //
  // The first version showed the eight leaders and nothing else, which said
  // the gyms were the story and N, Ghetsis, the Elite Four and both rivals
  // were not. They are all documented fights with portraits, and which of
  // them you care to track is a preference -- so it is a filter, the same one
  // the battle companion's encounter index uses, sharing its `kind` values so
  // the two read the same way.
  const counts = {};
  opps.forEach(({ o }) => { counts[o.kind] = (counts[o.kind] ?? 0) + 1; });
  const kinds = ['all', ...KIND_ORDER.filter((k) => counts[k])];
  const bar = el('div', { class: 'ad-progfilter' });
  for (const k of kinds) {
    const b = el('button', {
      class: `ad-chip${view.progKind === k ? ' on' : ''}`,
      'aria-pressed': String(view.progKind === k),
    }, k === 'all' ? `all ${opps.length}` : `${KIND_LABEL[k] ?? k} ${counts[k]}`);
    b.onclick = () => { view.progKind = k; savePrefs(); render(); };
    bar.append(b);
  }
  body.append(bar);

  const shown = opps.filter(({ o }) => view.progKind === 'all' || o.kind === view.progKind);
  if (shown.some(({ o }) => o.face != null)) {
    const row = el('div', { class: 'ad-gymrow' });
    for (const { o, i } of shown) {
      const state = stateOf(o);
      const tile = el('div', { class: `ad-gym s-${state} k-${o.kind}` });
      const open = el('button', {
        class: 'ad-gymopen',
        title: `${o.leader ?? 'Trainer'}${o.loc ? ` · ${o.loc}` : ''}`
          + `${o.lvmax ? ` · up to Lv ${o.lvmax}` : ''}`
          + ` — ${state === 'done' ? 'cleared'
            : state === 'next' ? 'next up' : 'ahead of you'}`
          + '. Opens this fight in the battle companion.',
      }, faceOf(o.face, o.leader),
        el('span', { class: 'ad-gymname' },
          (o.leader ?? '').replace(/^(Gym Leader|Elite Four|PKMN Trainer|Team Plasma|Rival)\s+/, '')
          || o.kind));
      open.onclick = () => planFight(i);
      // The tick is its own control, so opening a fight and marking it off are
      // different gestures. Clicking the portrait to "clear" it would make the
      // commonest action -- go look at this fight -- the risky one.
      const tick = el('button', {
        class: 'ad-gymtick',
        'aria-pressed': String(Boolean(cleared[ck(o)])),
        title: cleared[ck(o)] ? 'Cleared — click to un-mark' : 'Mark this fight cleared',
      }, cleared[ck(o)] ? '✓' : '');
      tick.onclick = (e) => { e.stopPropagation(); setCleared(o, !cleared[ck(o)]); };
      tile.append(open, tick);
      row.append(tile);
    }
    body.append(row);
  }

  // Where you are along the route order the item doc gives us.
  const ordered = Object.values(S.AREAINDEX).filter((a) => a.order != null)
    .sort((a, b) => a.order - b.order);
  const hereIdx = ordered.findIndex((a) => a.name === here?.area?.name);
  if (hereIdx >= 0) {
    body.append(el('p', { class: 'ad-hint' },
      `You are at ${here.area.name}, stop ${hereIdx + 1} of ${ordered.length} in route order.`));
  }
  const bc = TRAINER?.badges?.count;
  body.append(el('p', { class: 'ad-hint' },
    (bc == null ? '' : `${bc} of 8 badges, read from the save. `)
    + 'Badges are only eight points on a 36-fight curve, so this counts the fights you '
    + 'have ticked off as well. The tick marks are shared with the battle companion, so '
    + 'marking one here marks it there too.'));

  const head = el('h3', {}, 'Story progress',
    el('span', {}, next ? `next: ${next.leader ?? next.kind}` : 'all documented fights cleared'));
  const fold = el('button', { class: 'ad-fold', 'aria-expanded': String(view.progress),
    title: view.progress ? 'Hide story progress' : 'Show story progress' },
    view.progress ? '▾' : '▸');
  fold.onclick = () => { view.progress = !view.progress; savePrefs(); render(); };
  head.prepend(fold);

  return el('section', { class: 'ad-panel ad-progress' + (view.progress ? '' : ' folded') },
    head, view.progress ? body : null);
}

// ----------------------------------------------------------- trainers
/**
 * Trainers, under the spoiler policy: a VERDICT by default, the roster only
 * if you ask.
 *
 * "Eleven trainers, levels 25-28, biggest team of six" is what you need to
 * decide whether to heal first. Listing what is on them is a different
 * question, and one you should have to opt into.
 */
/**
 * A trainer's own portrait, out of the ROM (see extract_trainers.py).
 *
 * Keyed by portrait number, which build_static.py resolves per trainer: by
 * NAME where the ROM knows them, falling back to their class. A route trainer
 * that resolves to nothing renders nothing -- showing the wrong person is
 * worse than showing none.
 */
function faceOf(face, label) {
  const src = face == null ? null : (S.TRFACE ?? {})[String(face)];
  if (!src) return null;
  return el('span', { class: 'ad-face' },
    el('img', { src, alt: '', title: label ?? '', loading: 'lazy' }));
}

function trainerPanel(area) {
  const rt = area.trainers;
  const important = (area.opponents ?? []).map((i) => OPPS[i]).filter(Boolean);
  if (!rt && !important.length) return null;

  const body = el('div', {});

  if (rt) {
    const band = rt.lo != null ? `levels ${rt.lo}–${rt.hi}` : 'levels unrecorded';
    body.append(el('p', { class: 'ad-verdict' },
      el('b', {}, `${rt.count} trainer${rt.count === 1 ? '' : 's'}`),
      ` · ${band} · ${rt.mons} Pokémon between them · biggest team ${rt.biggest}`));

    const lvls = yourLevels();
    if (lvls && rt.hi != null) {
      const gap = rt.hi - lvls.max;
      body.append(el('p', { class: `ad-gap ${gap > 3 ? 'behind' : gap < -5 ? 'ahead' : 'level'}` },
        gap > 3 ? `Their best is ${gap} levels above your highest (${lvls.max}).`
          : gap < -5 ? `You are ${-gap} levels above their best — this will be quick.`
            : `Roughly level with your party (${lvls.min}–${lvls.max}).`));
    }

    const show = el('button', { class: 'ad-btn' }, `Show the ${rt.count} rosters`);
    show.onclick = () => {
      show.remove();
      const t = el('div', { class: 'ad-trainers' });
      for (const x of rt.list) {
        t.append(el('div', { class: 'ad-trow' },
          faceOf(x.face, x.name),
          el('div', {},
            el('span', { class: 'ad-tname' }, x.name),
            el('span', { class: 'ad-tsub' },
              `${x.n} Pokémon${x.lo != null ? ` · Lv ${x.lo}${x.hi !== x.lo ? `–${x.hi}` : ''}` : ''}`))));
      }
      body.append(t);
    };
    body.append(el('div', { class: 'ad-tools' }, show));
  }

  for (const opp of important) {
    const wrap = el('div', { class: 'ad-boss' });
    // The trainer, not just their team. This panel has always shown the six
    // and never the person, which is the thing you recognise walking in.
    // Two lines beside the portrait, not one wrapping row. A single flex row
    // put the name, three chips and the count on one baseline, so the text
    // sat against the middle of a 64px portrait and lined up with nothing.
    wrap.append(el('div', { class: 'ad-bosshead' },
      faceOf(opp.face, opp.leader),
      el('div', { class: 'ad-bossid' },
        el('div', { class: 'ad-bossline' },
          el('b', {}, opp.leader ?? opp.kind),
          el('span', { class: 'ad-kind' }, opp.kind),
          opp.cls ? el('span', { class: 'ad-tsub' }, opp.cls) : null,
          opp.type ? el('span', { class: `ad-ttype t-${opp.type}` }, opp.type) : null),
        el('div', { class: 'ad-bossline' },
          el('span', { class: 'ad-tsub' },
            `${opp.team.length} Pokémon${opp.lvmax ? ` · up to Lv ${opp.lvmax}` : ''}`)))));
    // THEIR TEAM, NAMED AND LEVELLED, UP FRONT.
    //
    // This used to be a bare sprite strip with "Levels, abilities and moves"
    // behind a click. The button was doing almost nothing: it swapped the
    // strip for a nearly identical grid whose only new information was the
    // level, while the ability, item and moves stayed in a tooltip either way.
    // A control that reveals a number you could have just shown is friction
    // pretending to be a spoiler policy -- and the real spoiler line moved
    // long ago, when the sprites came up front. So the grid IS the strip now.
    const g = el('div', { class: 'ad-mons ad-oppmons' });
    for (const mon of opp.team) {
      const name = mon.n ?? '?';
      // Drayano's roster rows are terse: n name, l level, i item, a ability,
      // m moves. The tooltip carries the rest so the grid stays readable.
      const bits = [mon.a && mon.a !== '-' ? mon.a : null,
        mon.i && mon.i !== '-' ? `@${mon.i}` : null,
        (mon.m ?? []).filter((x) => x && x !== '-').join(', ')].filter(Boolean);
      g.append(el('div', { class: 'ad-mon', title: `${name}${mon.l ? ` Lv ${mon.l}` : ''}`
        + (bits.length ? `\n${bits.join('\n')}` : '') },
        S.SPRITE[name] ? el('img', { src: S.SPRITE[name], alt: '', loading: 'lazy' }) : null,
        el('span', { class: 'ad-mname' }, name),
        el('span', { class: 'ad-pct' }, mon.l ? `Lv ${mon.l}` : '')));
    }
    if (opp.team.length) wrap.append(g);

    if (opp.note) wrap.append(el('p', { class: 'ad-hint' }, rich(opp.note)));

    // Straight to that fight in the battle companion, which has the damage
    // calc, the speed ladder and the matchup planner for it.
    const idx = OPPS.indexOf(opp);
    if (GOTO && idx >= 0) {
      const jump = el('button', { class: 'ad-btn primary',
        title: 'Open this fight in the battle companion: damage numbers, speed order '
          + 'and the matchup planner against your team' }, 'Plan this fight →');
      jump.onclick = () => planFight(idx);
      wrap.append(el('div', { class: 'ad-tools' }, jump));
    }
    body.append(wrap);
  }

  return panel('Who is here',
    important.length ? `${important.length} documented · rosters hidden until you ask`
      : 'counts only — rosters hidden until you ask',
    body);
}

/** Your party's level band, for the "are you ready" line. */
function yourLevels() {
  const lv = F.read('party').filter((s) => s.mon).map((s) => s.mon.level).filter((x) => x != null);
  return lv.length ? { min: Math.min(...lv), max: Math.max(...lv) } : null;
}

// -------------------------------------------------------------- items
function itemPanel(area) {
  const items = area.items ?? [];
  if (!items.length) {
    return panel('On the ground', 'nothing documented',
      el('p', { class: 'ad-hint' },
        'Drayano documents only the items he CHANGED, so an area with no entry here '
        + 'still has whatever vanilla Black had. Hidden items and shop stock are not '
        + 'extracted at all — this tool does not know about them.'));
  }
  const list = el('div', { class: 'ad-items' });
  for (const it of items) {
    const owned = bagNames.all.has(it.now);
    list.append(el('div', { class: `ad-item${owned ? ' owned' : ''}` },
      el('span', { class: 'ad-iname' }, it.now + (it.count > 1 ? ` ×${it.count}` : '')),
      el('span', { class: 'ad-was', title:
        'Placement never moved — only what is in the ball. A vanilla Black map still '
        + 'marks the exact spot, under this name.' }, `was ${it.was}`),
      owned ? el('span', { class: 'ad-have' }, 'in your bag') : null));
  }
  return panel('On the ground', `${items.length} changed from vanilla`,
    el('div', {}, list,
      el('p', { class: 'ad-hint' },
        'Only items Drayano changed are listed. Placement never moved, so a vanilla '
        + 'Black map still marks the spot — look for the old item’s name.')));
}

// ------------------------------------------------------- held-item farming
function farmPanel(area) {
  const rows = (area.wiki ?? []).flatMap((w) => S.AREAS[w] ?? []);
  const seen = new Map();
  for (const r of rows) {
    for (const m of r.mons) {
      const sp = S.SPECIES[String(m.id)];
      const held = sp?.wild_held_items;
      if (!held) continue;
      for (const [slot, item] of Object.entries(held)) {
        if (!item) continue;
        const key = `${m.id}:${item}`;
        const rate = slot === 'common' ? 50 : slot === 'rare' ? 5 : 1;
        const prev = seen.get(key);
        if (!prev || m.pct > prev.pct) {
          seen.set(key, { name: sp.name, item, rate, pct: m.pct, id: m.id });
        }
      }
    }
  }
  const list = [...seen.values()].sort((a, b) => (b.pct * b.rate) - (a.pct * a.rate));
  if (!list.length) return null;

  const box = el('div', { class: 'ad-farm' });
  for (const f of list.slice(0, 12)) {
    box.append(el('div', { class: 'ad-farmrow' },
      S.SPRITE[f.name] ? el('img', { src: S.SPRITE[f.name], alt: '', loading: 'lazy' }) : null,
      el('span', { class: 'ad-fitem' }, f.item),
      el('span', { class: 'ad-fsub' },
        `${f.name} · ${f.pct}% encounter · ${f.rate}% hold`)));
  }
  return panel('Worth farming here',
    'wild held items, cheapest source of good gear',
    el('div', {}, box,
      el('p', { class: 'ad-hint' },
        'Hold rates are 50% common, 5% rare, 1% dark grass. Sorted by how often you '
        + 'would actually see one.')));
}

// -------------------------------------------------------------------- tab
export default {
  id: 'adventure',
  label: 'Adventure',
  needsSave: true,

  mount(panel, ctx) {
    S = ctx.S;
    VERSION = ctx.version ?? 'black';
    OPPS = opponentsFor(S, ctx.starter ?? null, null);
    NUZ = ctx.nuz ?? null;
    CTXREF = ctx;
    try { N_INDEX = ctx.factory ? buildIndex(ctx.factory) : []; } catch { N_INDEX = []; }
    // `ctx.factory.save` is the same file as `ctx.save` -- the Factory clones
    // the loaded save -- so falling back to it means the card renders for any
    // caller that passed one of the two rather than both. The shell passes
    // both; a harness mounting the tab standalone naturally passes the Factory.
    const sv = ctx.save ?? ctx.factory?.save ?? null;
    try { TRAINER = sv ? { ...sv.readTrainer(), money: sv.money } : null; }
    catch { TRAINER = null; }
    try { POKEDEX = ctx.save?.readPokedex?.() ?? null; } catch { POKEDEX = null; }
    F = ctx.factory;
    GOTO = ctx.goTo ?? null;
    CONFIG = ctx.config ?? null;

    const pos = F.save.readPosition();
    const loc = S.ZONES?.[String(pos.zone_id)] ?? null;
    here = { ...pos, location: loc ?? `zone ${pos.zone_id}`,
      area: loc ? (S.AREAINDEX?.[loc] ?? null) : null };
    dex = F.save.readPokedex();

    const bag = F.save.readBag();
    const nameOf = (e) => S.ITEMS[String(e.item_id)] ?? '';
    bagNames = {
      tms: bag.tms_hms.map(nameOf),
      key: bag.key_items.map(nameOf),
      all: new Set(Object.values(bag).flat().map(nameOf)),
    };

    const pref = loadPrefs();
    view = { area: null, showCaught: true, editing: false,
      editTool: pref.editTool ?? 'move',
      mapOpen: pref.mapOpen !== false, cityNames: pref.cityNames !== false,
      routeNames: pref.routeNames !== false, progress: pref.progress !== false,
      miscNames: pref.miscNames === true, showNotes: pref.showNotes !== false,
      progKind: pref.progKind ?? 'gym', playerFace: pref.playerFace ?? 0,
      cardOpen: pref.cardOpen !== false,
    };
    root = el('div', { class: 'ad' });
    panel.append(root);
    render();
  },

  unmount() { root?.remove?.(); root = null; savedMsg = null; },
};
