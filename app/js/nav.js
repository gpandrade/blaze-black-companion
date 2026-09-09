/**
 * nav.js -- the tab bar, as a rail and as a dial.
 *
 * =========================================================================
 * WHY THERE ARE TWO OF THEM
 * =========================================================================
 * The tabs were seven pill buttons on a row of their own, and they read as a
 * row of pill buttons: correct, findable, and saying nothing about a project
 * whose whole surface language is cut corners, neon hairlines and wagara.
 * Navigation is the one control every single session touches, so it is the
 * cheapest place in the app to spend character and the most expensive place
 * to spend a CLICK.
 *
 * Hence two, sharing one model:
 *
 *   THE RAIL is the everyday one and stays ONE CLICK. Skewed plates, an index
 *   numeral, a glyph, the active one filled and lifted. Persona's menus are
 *   built out of exactly this -- slanted plates, a numbered list, one item
 *   that breaks the grid -- and none of it costs an interaction.
 *
 *   THE DIAL is summoned. Seven spokes on a ring around a hub that names what
 *   you are pointing at. This is the Metaphor half: a thing you open, turn,
 *   and commit to. It is never the only way to reach a tab on a wide screen,
 *   so it is allowed to be theatrical.
 *
 * ...except on a narrow screen, where the rail does not fit and the dial IS
 * the navigation. That is the honest reason it earns its place rather than
 * being a toy: seven plates cannot sit on a phone, and a horizontal scroller
 * hides half of them behind a gesture nobody performs. A dial is the same
 * seven targets, bigger, in a space that is round instead of long.
 *
 * =========================================================================
 * ONE TABLE, NOT SEVEN EDITS
 * =========================================================================
 * A tab module exports { id, label, needsSave, mount }. Everything the
 * chrome needs on top of that -- the numeral, the glyph, the one-line blurb
 * the dial's hub reads out -- lives in META here, keyed by id, so adding a
 * tab is one entry in one file rather than a new field in seven modules.
 * tools/verify_nav.mjs fails if the two lists ever disagree.
 *
 * =========================================================================
 * RULES IT PLAYS BY
 * =========================================================================
 *   - The active plate is a FILLED ACCENT, so it uses the measured
 *     --fx-go-bg / --fx-go-ink pair. Never --ember with a hardcoded white:
 *     that pair measures 2.41:1 in dark mode. See notes/design-system.md.
 *   - Disabled is a COLOUR (--fx-off-*), never an opacity.
 *   - Every stretched decorative layer is pointer-events: none. The dial's
 *     backdrop is NOT decoration -- clicking it closes the dial -- so it is
 *     a real element, not a pseudo-element.
 *   - prefers-reduced-motion gets the dial with no fan-out and no stagger.
 *     It still opens, it just does not perform.
 */

/**
 * What the chrome knows about each tab beyond its own module.
 *
 * `blurb` is written to be read aloud by the hub while you are pointing at a
 * spoke, so it says what the tab is FOR rather than what it contains.
 */
export const META = {
  adventure: { n: '01', blurb: 'Where you are, and what is here' },
  battle: { n: '02', blurb: 'The fight you are about to have' },
  builder: { n: '03', blurb: 'Design a team, then make it real' },
  factory: { n: '04', blurb: 'Your party and every box, editable' },
  items: { n: '05', blurb: 'What you are carrying, cross-referenced' },
  dex: { n: '06', blurb: 'What Drayano changed, species by species' },
  run: { n: '07', blurb: 'Your rules, and how the run is going' },
};

/**
 * The glyphs, as raw path data on a 24x24 grid.
 *
 * Inline SVG rather than an icon font or emoji: emoji are a different colour
 * on every platform and would be the only thing in this app that does not
 * follow the theme, and a font is a network request the app does not make.
 * These stroke in currentColor, so they invert with the plate.
 */
export const GLYPH = {
  // A pin: the tab answers "where am I".
  adventure: 'M12 21.5s6.2-6 6.2-10.3a6.2 6.2 0 1 0-12.4 0C5.8 15.5 12 21.5 12 21.5z'
    + '|M12 11.2m-2.3 0a2.3 2.3 0 1 0 4.6 0a2.3 2.3 0 1 0-4.6 0',
  // Crossed blades.
  battle: 'M4.5 3.5h3l10 10-3 3-10-10z|M19.5 3.5h-3l-10 10 3 3 10-10z'
    + '|M15.5 15.5l4 4|M8.5 15.5l-4 4',
  // Three nodes, joined: a team is a shape, not a list.
  builder: 'M12 5.2m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0'
    + '|M6 17.5m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0'
    + '|M18 17.5m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0'
    + '|M10.6 6.9L7.4 15.8|M13.4 6.9l3.2 8.9|M8 17.5h8',
  // A Poke Ball, because the tab makes Pokemon.
  factory: 'M12 12m-8.5 0a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0'
    + '|M3.5 12h5|M15.5 12h5|M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  // A pouch with a handle.
  items: 'M4.8 8.8h14.4l-1.2 11a2 2 0 0 1-2 1.7H8a2 2 0 0 1-2-1.7z'
    + '|M8.6 8.8V6.4a3.4 3.4 0 0 1 6.8 0v2.4',
  // The device: a screen with the big lens.
  dex: 'M4.5 3.5h15a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z'
    + '|M8.6 8m-2.6 0a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0-5.2 0'
    + '|M15 6.5h3|M15 9.5h3|M7 14.5h10|M7 17.5h6',
  // A flag planted: this is your run.
  run: 'M6 21.5V3|M6 3.8h11.5l-2.6 3.8 2.6 3.8H6z',
};

const svgNS = 'http://www.w3.org/2000/svg';

/** One glyph as an <svg>. `paths` is pipe-separated `d` data. */
function glyph(id) {
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'sh-ico');
  for (const d of (GLYPH[id] ?? '').split('|')) {
    if (!d) continue;
    const p = document.createElementNS(svgNS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') { if (v != null) n.className = v; }
    else if (k.startsWith('aria-') || k === 'role' || k === 'type' || k === 'title'
      || k === 'style') n.setAttribute(k, v);
    else n[k] = v;
  }
  n.append(...kids.filter((x) => x != null));
  return n;
};

/** Is the user typing? The dial's hotkey must not steal a letter. */
export function isTyping(target) {
  const t = target ?? document.activeElement;
  if (!t) return false;
  const tag = (t.tagName ?? '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable === true;
}

// ===========================================================================
// THE RAIL
// ===========================================================================
/**
 * Render the plates into `nav`.
 *
 * `tabs` is the shell's TABS array; `state` carries { active, enabled(id) };
 * `onPick` is handed a tab id. The hub button is rendered here too, because
 * it is part of the rail's layout on a wide screen and IS the rail on a
 * narrow one.
 */
export function renderRail(nav, tabs, { active, enabled, onPick, onDial }) {
  nav.replaceChildren();

  const hub = el('button', {
    class: 'sh-hub', type: 'button',
    title: 'All tabs  (`)',
    'aria-label': 'Open the tab dial',
    'aria-haspopup': 'dialog',
    onclick: onDial,
  }, el('span', { class: 'sh-hub-ring' }),
     el('span', { class: 'sh-hub-now' }, tabs.find((t) => t.id === active)?.label ?? 'Tabs'),
     el('span', { class: 'sh-hub-key' }, '`'));
  nav.append(hub);

  tabs.forEach((t, i) => {
    const on = active === t.id;
    const live = enabled(t);
    const b = el('button', {
      class: `sh-plate${on ? ' is-on' : ''}`,
      type: 'button',
      role: 'tab',
      style: `--i:${i}`,
      'aria-selected': String(on),
      disabled: !live,
      title: live ? META[t.id]?.blurb ?? t.label : 'Load a save first',
      onclick: () => onPick(t.id),
    },
    el('span', { class: 'sh-pnum' }, META[t.id]?.n ?? String(i + 1).padStart(2, '0')),
    glyph(t.id),
    el('span', { class: 'sh-plabel' }, t.label));
    nav.append(b);
  });
}

// ===========================================================================
// THE DIAL
// ===========================================================================
let open = null;          // the live overlay, or null
let restoreFocus = null;

export const dialOpen = () => open != null;

/**
 * Open the dial. Returns immediately; the overlay owns the keyboard until it
 * closes.
 *
 * Selection is a TWO-STEP: moving around the ring only points at a tab and
 * updates the hub, and committing is a separate press. That is what makes it
 * a dial rather than a menu with round edges -- you can look at all seven
 * without going anywhere, which is the thing the rail cannot do.
 */
export function openDial(tabs, { active, enabled, onPick }) {
  if (open) return;
  restoreFocus = document.activeElement;

  const items = tabs.slice();
  let at = Math.max(0, items.findIndex((t) => t.id === active));

  const back = el('div', { class: 'sh-dial-back' });
  const face = el('div', { class: 'sh-dial-face' });
  const hubName = el('div', { class: 'sh-dhub-name' });
  const hubBlurb = el('div', { class: 'sh-dhub-blurb' });
  const hub = el('div', { class: 'sh-dhub' },
    el('div', { class: 'sh-dhub-kick' }, 'GO TO'), hubName, hubBlurb,
    el('div', { class: 'sh-dhub-hint' }, 'arrows to turn · enter to go · esc to close'));

  const spokes = items.map((t, i) => {
    const live = enabled(t);
    return el('button', {
      class: `sh-spoke${live ? '' : ' is-off'}`,
      type: 'button',
      style: `--i:${i}; --n:${items.length}`,
      'aria-label': `${t.label}. ${live ? META[t.id]?.blurb ?? '' : 'Needs a save.'}`,
      disabled: !live,
      onclick: () => { if (live) commit(i); },
      onmouseenter: () => point(i),
      onfocus: () => point(i),
    }, el('span', { class: 'sh-spoke-in' },
      el('span', { class: 'sh-snum' }, META[t.id]?.n ?? ''),
      glyph(t.id),
      el('span', { class: 'sh-slabel' }, t.label)));
  });

  face.append(hub, ...spokes);
  const wrap = el('div', {
    class: 'sh-dial', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Tabs',
  }, back, face);

  function point(i) {
    at = i;
    spokes.forEach((s, k) => s.classList.toggle('is-at', k === i));
    const t = items[i];
    hubName.textContent = t.label;
    hubBlurb.textContent = enabled(t) ? (META[t.id]?.blurb ?? '') : 'Load a save to open this one.';
    hub.classList.toggle('is-off', !enabled(t));
  }

  function commit(i) {
    const t = items[i];
    if (!enabled(t)) return;
    close();
    onPick(t.id);
  }

  function step(d) {
    // Wrap around the ring, and skip nothing: a tab you cannot open is still
    // a tab you should be able to look at and be told why.
    at = (at + d + items.length) % items.length;
    point(at);
    spokes[at].focus();
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); step(1); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); return; }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); commit(at); return; }
    if (e.key === '`') { e.preventDefault(); close(); return; }
    // Persona menus answer to numbers, and so does this.
    const d = Number(e.key);
    if (Number.isInteger(d) && d >= 1 && d <= items.length) { e.preventDefault(); commit(d - 1); }
  }

  function close() {
    if (!open) return;
    document.removeEventListener('keydown', onKey, true);
    wrap.remove();
    open = null;
    if (restoreFocus && restoreFocus.isConnected) restoreFocus.focus();
    restoreFocus = null;
  }

  back.onclick = close;
  document.addEventListener('keydown', onKey, true);
  document.body.append(wrap);
  open = { close };
  point(at);
  spokes[at].focus({ preventScroll: true });
  return open;
}

export function closeDial() {
  if (open) open.close();
}
