/**
 * mapedit.js -- the model behind the Adventure tab's map editor. No DOM.
 *
 * WHY THIS EXISTS
 * The pins were placed by eye and many are wrong. Calibration mode -- pick an
 * area, shift-click the map -- was a workaround: it could only move a marker
 * that already existed, one at a time, while the rest of the tab competed for
 * the screen. You could not put a place on the map that was not already there,
 * and you could not draw the road between two places at all.
 *
 * So this is an editor, not a nudger:
 *   - move a marker, or place one that has never been on the map
 *   - take a marker off again (it goes back to the tray, it is not destroyed)
 *   - draw a link between two places, say which areas you travel through on it,
 *     bend it so it follows the terrain, or remove it
 *   - annotate the map with your own notes
 *
 * THREE LAYERS, AND THEY ARE NOT THE SAME KIND OF THING.
 *   defaults  MAP_PLACES / MAP_LINKS in build_static.py -- what ships
 *   edits     positions + links, saved to state/*.json and COMMITTED, so a
 *             correction travels to everyone who pulls
 *   notes     yours, localStorage only, never written to the repo
 * Notes are deliberately excluded from the payload: "Audino here" is a fact
 * about your run, not about Unova, and shipping it to strangers would be odd.
 *
 * Every mutation goes on one undo stack. Undoing a drag halfway would be worse
 * than not offering undo at all.
 */

export const EDIT_KEY = 'blazeblack.map.edits';
export const NOTE_KEY = 'blazeblack.map.notes';

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
const KINDS = ['city', 'town', 'landmark'];

/** Read saved edits. Shape errors degrade to "no edits", never to a throw. */
export function loadEdits(store = globalThis.localStorage) {
  try {
    const o = JSON.parse(store?.getItem(EDIT_KEY) ?? '{}');
    return {
      positions: o && typeof o.positions === 'object' && o.positions ? o.positions : {},
      links: Array.isArray(o?.links) ? o.links : null,
    };
  } catch { return { positions: {}, links: null }; }
}

export function saveEdits(e, store = globalThis.localStorage) {
  try { store?.setItem(EDIT_KEY, JSON.stringify(e)); } catch { /* private mode */ }
}

export function loadNotes(store = globalThis.localStorage) {
  try {
    const n = JSON.parse(store?.getItem(NOTE_KEY) ?? '[]');
    return Array.isArray(n) ? n.filter((v) => v && typeof v.text === 'string') : [];
  } catch { return []; }
}

export function saveNotes(n, store = globalThis.localStorage) {
  try { store?.setItem(NOTE_KEY, JSON.stringify(n)); } catch { /* private mode */ }
}

export class MapEdit {
  /**
   * @param {object} map    S.MAP -- the shipped defaults
   * @param {string[]} areas every canonical area name, so the tray can offer
   *                         places that have never been on the map
   */
  constructor(map, areas = [], stored = null, notes = null) {
    this.map = map ?? { places: {}, links: [] };
    this.areas = areas.slice().sort();
    const e = stored ?? loadEdits();
    this.pos = { ...e.positions };
    // null means "no link edits yet", which is NOT the same as "no links" --
    // the difference is whether the shipped set still applies.
    this.linkEdits = e.links ? e.links.map((l) => ({ ...l, areas: [...(l.areas ?? [])],
      bends: (l.bends ?? []).map((b) => [...b]) })) : null;
    this.notes = notes ?? loadNotes();
    this.undoStack = [];
    this.dirty = false;
  }

  // ---- reading ----------------------------------------------------------

  /** name -> {x, y, kind}. Hidden entries are omitted; the tray finds them. */
  places() {
    const out = {};
    for (const [n, v] of Object.entries(this.map.places ?? {})) out[n] = { ...v };
    for (const [n, v] of Object.entries(this.pos)) {
      if (v?.hidden) { delete out[n]; continue; }
      out[n] = { kind: out[n]?.kind ?? v.kind ?? 'landmark', ...out[n],
        x: clamp01(v.x), y: clamp01(v.y) };
      if (v.kind) out[n].kind = v.kind;
    }
    return out;
  }

  /** Areas with no marker, so you can put them on the map. */
  /**
   * A ROUTE IS A LINE, NOT A PIN.
   *
   * Routes, bridges and the like are the EDGES of this map -- Route 4 is the
   * thing between Castelia and Nimbasa -- and you set them by drawing a link
   * in the Connect tool and saying which areas it carries. They were being
   * listed in the Move tool's tray of "not on the map yet" alongside the
   * towns, which invited you to drop Route 4 somewhere as a dot and then
   * wonder why it did not behave like a road.
   */
  static isRoute(name) {
    return /^route\s/i.test(name) || /\b(bridge|drawbridge|gate|path)\b/i.test(name);
  }

  /** Which areas a link already carries, so the tray can say what is spoken for. */
  routedAreas() {
    const out = new Set();
    for (const l of this.links()) for (const a of l.areas) out.add(a);
    return out;
  }

  unplaced() {
    const on = new Set(Object.keys(this.places()));
    return this.areas.filter((a) => !on.has(a) && !MapEdit.isRoute(a));
  }

  /** Routes with no leg carrying them yet -- the Connect tool's to-do list. */
  unrouted() {
    const carried = this.routedAreas();
    return this.areas.filter((a) => MapEdit.isRoute(a) && !carried.has(a));
  }

  /**
   * A sensible kind for a newly placed area, from its own name. Everything
   * used to land as a `landmark`, so a screen of pins you had just placed by
   * hand all came out as the smallest, most muted marker.
   */
  static kindFor(name) {
    if (/\bcity\b/i.test(name)) return 'city';
    if (/\btown\b/i.test(name)) return 'town';
    return 'landmark';
  }

  /** [{a, b, areas, bends, pts}] with endpoints following the live positions. */
  links() {
    const P = this.places();
    const base = this.linkEdits ?? (this.map.links ?? []).map((l) => ({
      a: l.a, b: l.b, areas: [...(l.areas ?? [])],
      // The shipped links carry absolute pts; the interior ones are the bends.
      bends: (l.pts ?? []).slice(1, -1).map((p) => [...p]),
    }));
    // A LINK MAY END AT A POINT, NOT ONLY AT ANOTHER PLACE.
    //
    // Roads run between towns, but a great many landmarks hang OFF a road --
    // Wellspring Cave opens onto Route 3, Chargestone Cave onto Route 6. A
    // route is an EDGE on this map, not a node, so there was no way to say
    // that at all: you could only connect Wellspring Cave to a town it does
    // not touch. A spur is a link whose far end is a coordinate you clicked,
    // which is how you attach one to the middle of a road.
    return base
      .filter((l) => P[l.a] && (l.at || P[l.b]))
      .map((l) => ({
        ...l,
        spur: Boolean(l.at),
        pts: [[P[l.a].x, P[l.a].y], ...l.bends.map(([x, y]) => [x, y]),
          l.at ? [l.at[0], l.at[1]] : [P[l.b].x, P[l.b].y]],
      }));
  }

  /** Areas not reachable by any drawn link -- a place you cannot walk to. */
  orphans() {
    const linked = new Set(this.links().flatMap((l) => [l.a, l.b]).filter(Boolean));
    return Object.keys(this.places()).filter((n) => !linked.has(n)).sort();
  }

  // ---- mutating ---------------------------------------------------------

  /** Snapshot before every change, so undo restores a whole gesture. */
  #push(label) {
    this.undoStack.push({
      label,
      pos: JSON.parse(JSON.stringify(this.pos)),
      links: this.linkEdits ? JSON.parse(JSON.stringify(this.linkEdits)) : null,
      notes: JSON.parse(JSON.stringify(this.notes)),
    });
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.dirty = true;
  }

  /** Materialise the shipped links before editing, so an edit is not lost. */
  #ownLinks() {
    if (!this.linkEdits) {
      this.linkEdits = (this.map.links ?? []).map((l) => ({
        a: l.a, b: l.b, areas: [...(l.areas ?? [])],
        bends: (l.pts ?? []).slice(1, -1).map((p) => [...p]),
      }));
    }
    return this.linkEdits;
  }

  move(name, x, y) {
    if (!name) return false;
    this.#push(`move ${name}`);
    const kind = this.places()[name]?.kind ?? this.pos[name]?.kind ?? 'landmark';
    this.pos[name] = { x: clamp01(x), y: clamp01(y), kind };
    return true;
  }

  /** Put an area on the map for the first time. */
  place(name, x, y, kind = 'landmark') {
    if (!name) return false;
    this.#push(`place ${name}`);
    this.pos[name] = { x: clamp01(x), y: clamp01(y),
      kind: KINDS.includes(kind) ? kind : 'landmark' };
    return true;
  }

  /** Take a marker off. Reversible: it returns to the tray, nothing is lost. */
  unplace(name) {
    if (!this.places()[name]) return false;
    this.#push(`remove ${name}`);
    this.pos[name] = { hidden: true };
    return true;
  }

  setKind(name, kind) {
    if (!this.places()[name] || !KINDS.includes(kind)) return false;
    this.#push(`${name} → ${kind}`);
    const p = this.places()[name];
    this.pos[name] = { x: p.x, y: p.y, kind };
    return true;
  }

  /** Draw a road. Refuses self-links and duplicates in either direction. */
  connect(a, b) {
    if (!a || !b || a === b) return false;
    const P = this.places();
    if (!P[a] || !P[b]) return false;
    const L = this.#ownLinks();
    if (L.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a))) return false;
    this.#push(`connect ${a}–${b}`);
    this.linkEdits.push({ a, b, areas: [], bends: [] });
    return true;
  }

  /**
   * Attach a place to a POINT -- a spur onto a road that passes nearby.
   *
   * Deliberately not "attach to link 4": link indices move when you add or
   * remove roads, and a spur that silently jumped to a different route would
   * be worse than one that needs re-dragging. A coordinate is stable, and the
   * point you clicked is on the road because you clicked the road.
   */
  spur(a, x, y) {
    const P = this.places();
    if (!P[a] || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    const L = this.#ownLinks();
    if (L.some((l) => l.a === a && l.at)) return false;   // one spur per place
    this.#push(`attach ${a}`);
    this.linkEdits.push({ a, b: null, at: [clamp01(x), clamp01(y)], areas: [], bends: [] });
    return true;
  }

  removeLink(i) {
    const L = this.#ownLinks();
    if (!L[i]) return false;
    this.#push(`remove link ${L[i].a}–${L[i].b ?? 'point'}`);
    this.linkEdits.splice(i, 1);
    return true;
  }

  /** Which areas you travel through on this leg. A leg can carry several. */
  setLinkAreas(i, areas) {
    const L = this.#ownLinks();
    if (!L[i]) return false;
    this.#push('set route');
    L[i].areas = [...new Set(areas.filter(Boolean))];
    return true;
  }

  /** Insert or move a bend so the line follows the terrain. */
  setBend(i, k, x, y) {
    const L = this.#ownLinks();
    if (!L[i]) return false;
    this.#push('bend');
    if (k >= L[i].bends.length) L[i].bends.push([clamp01(x), clamp01(y)]);
    else L[i].bends[k] = [clamp01(x), clamp01(y)];
    return true;
  }

  clearBends(i) {
    const L = this.#ownLinks();
    if (!L[i] || !L[i].bends.length) return false;
    this.#push('straighten');
    L[i].bends = [];
    return true;
  }

  // ---- notes: yours, and they stay yours --------------------------------

  addNote(x, y, text) {
    this.#push('add note');
    this.notes.push({ id: `n${Date.now()}${this.notes.length}`,
      x: clamp01(x), y: clamp01(y), text: String(text ?? '') });
    return true;
  }

  moveNote(id, x, y) {
    const n = this.notes.find((v) => v.id === id);
    if (!n) return false;
    this.#push('move note');
    n.x = clamp01(x); n.y = clamp01(y);
    return true;
  }

  editNote(id, text) {
    const n = this.notes.find((v) => v.id === id);
    if (!n) return false;
    this.#push('edit note');
    n.text = String(text ?? '');
    return true;
  }

  removeNote(id) {
    const k = this.notes.findIndex((v) => v.id === id);
    if (k < 0) return false;
    this.#push('remove note');
    this.notes.splice(k, 1);
    return true;
  }

  // ---- history and output -----------------------------------------------

  undo() {
    const s = this.undoStack.pop();
    if (!s) return null;
    this.pos = s.pos;
    this.linkEdits = s.links;
    this.notes = s.notes;
    this.dirty = this.undoStack.length > 0;
    return s.label;
  }

  /**
   * Wipe the map to a blank canvas: every marker off, every road gone.
   *
   * NOT the same as reset(), which goes back to what shipped. This is the
   * "I would rather place all of these myself" path, and it fills the tray
   * with everything so you can. Notes are left alone -- they are a separate
   * layer with their own toggle, and they are about your run, not the map.
   *
   * One undo step, like every other bulk operation here.
   */
  clearAll() {
    const on = Object.keys(this.places());
    if (!on.length && this.linkEdits && !this.linkEdits.length) return false;
    this.#push('clear the map');
    for (const n of on) this.pos[n] = { hidden: true };
    this.linkEdits = [];
    return true;
  }

  /** Back to what shipped. Undoable like anything else. */
  reset() {
    this.#push('reset to defaults');
    this.pos = {};
    this.linkEdits = null;
    return true;
  }

  /**
   * What gets written to the repo. Notes are NOT in here on purpose.
   * Links are omitted entirely when untouched, so an untouched map keeps
   * following the shipped set rather than freezing a copy of it.
   */
  toPayload() {
    const payload = { positions: this.pos };
    if (this.linkEdits) {
      payload.links = this.linkEdits.map((l) => ({
        a: l.a, b: l.b ?? null, areas: [...l.areas], bends: l.bends.map(([x, y]) => [x, y]),
        ...(l.at ? { at: [l.at[0], l.at[1]] } : {}),
      }));
    }
    return payload;
  }

  persist(store = globalThis.localStorage) {
    saveEdits({ positions: this.pos, links: this.linkEdits }, store);
    saveNotes(this.notes, store);
  }

  /** Counts for the toolbar, so "Save" can say what it is about to write. */
  summary() {
    const moved = Object.values(this.pos).filter((v) => !v?.hidden).length;
    const removed = Object.values(this.pos).filter((v) => v?.hidden).length;
    const base = (this.map.links ?? []).length;
    return {
      moved, removed,
      links: this.linkEdits ? this.linkEdits.length : base,
      linksChanged: this.linkEdits ? this.linkEdits.length - base : 0,
      notes: this.notes.length,
      unplaced: this.unplaced().length,
      orphans: this.orphans().length,
    };
  }
}
