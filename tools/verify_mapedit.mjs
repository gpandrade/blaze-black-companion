#!/usr/bin/env node
/*
 * verify_mapedit.mjs -- the map editor's model, against a stubbed store.
 *
 * Why this file asserts what it does: notes/adventure-and-map.md
 *
 * The editor writes to state/map_positions.json, which is COMMITTED and ships
 * to everyone who pulls. That makes its output other people's data, so the
 * checks here are about what leaves the browser: notes must never reach the
 * payload, an untouched map must not freeze a copy of the shipped links, and
 * every mutation must be undoable as one gesture.
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

// A real in-memory store: the model must survive a round trip through it.
const _s = new Map();
globalThis.localStorage = {
  getItem: (k) => (_s.has(k) ? _s.get(k) : null),
  setItem: (k, v) => { _s.set(k, String(v)); },
  removeItem: (k) => { _s.delete(k); },
};

const { MapEdit, loadEdits, loadNotes } = await import('../app/js/mapedit.js');

// Use the real shipped map when it has been built; a small fixture otherwise,
// so this runs on a fresh clone that has not run build_static.py yet.
let MAP; let AREAS;
const staticPath = path.join(ROOT, 'app/data/static.json');
if (fs.existsSync(staticPath)) {
  const S = JSON.parse(fs.readFileSync(staticPath, 'utf8'));
  MAP = S.MAP; AREAS = Object.keys(S.AREAINDEX ?? {});
  console.log(`  (using the built map: ${Object.keys(MAP.places).length} places, `
    + `${MAP.links.length} links, ${AREAS.length} areas)`);
} else {
  MAP = {
    places: { A: { x: 0.1, y: 0.1, kind: 'city' }, B: { x: 0.5, y: 0.5, kind: 'town' } },
    links: [{ a: 'A', b: 'B', areas: ['Route 1'], pts: [[0.1, 0.1], [0.3, 0.2], [0.5, 0.5]] }],
  };
  AREAS = ['A', 'B', 'C', 'Route 1'];
  console.log('  (app/data/static.json not built — using a fixture)');
}

const names = Object.keys(MAP.places);
const [n1, n2] = names;

console.log('\n── reading');
{
  const m = new MapEdit(MAP, AREAS);
  ok('places start as the shipped ones',
    Object.keys(m.places()).length === names.length, `${Object.keys(m.places()).length}`);
  ok('links start as the shipped ones', m.links().length === MAP.links.length);
  ok('endpoints are derived from the live positions, not frozen',
    m.links().every((l) => {
      const P = m.places();
      return l.pts[0][0] === P[l.a].x && l.pts[l.pts.length - 1][1] === P[l.b].y;
    }));
  // A ROUTE IS A LINE, NOT A PIN. The tray offers places you can drop; routes
  // are edges, set by drawing a link in Connect and saying which areas that
  // leg carries. Listing them together invited dropping Route 4 as a dot.
  const expectPlaces = AREAS.filter((a) => !names.includes(a) && !MapEdit.isRoute(a));
  ok('the tray offers places that have never been on the map',
    m.unplaced().length === expectPlaces.length, `${m.unplaced().length} unplaced`);
  ok('and offers no routes at all',
    !m.unplaced().some((a) => MapEdit.isRoute(a)),
    m.unplaced().filter((a) => MapEdit.isRoute(a)).join(', '));
  ok('routes with no leg yet are listed separately',
    m.unrouted().every((a) => MapEdit.isRoute(a)), `${m.unrouted().length} unrouted`);

  // A pin placed by hand takes its kind from its own name; everything used to
  // land as `landmark`, the smallest and most muted marker there is.
  ok('a city name places as a city', MapEdit.kindFor('Castelia City') === 'city');
  ok('a town name places as a town', MapEdit.kindFor('Nuvema Town') === 'town');
  ok('anything else places as a landmark', MapEdit.kindFor('Wellspring Cave') === 'landmark');
}

console.log('\n── moving and placing');
{
  const m = new MapEdit(MAP, AREAS);
  m.move(n1, 0.42, 0.77);
  ok('moving a marker moves it', m.places()[n1].x === 0.42 && m.places()[n1].y === 0.77);
  ok('and the links that touch it follow',
    m.links().filter((l) => l.a === n1).every((l) => l.pts[0][0] === 0.42));
  ok('a move keeps the marker kind', m.places()[n1].kind === MAP.places[n1].kind,
    m.places()[n1].kind);

  // Out-of-bounds coordinates are a dragged-off-the-edge pointer, not an error.
  m.move(n1, -3, 9);
  ok('coordinates are clamped to the image', m.places()[n1].x === 0 && m.places()[n1].y === 1);

  const fresh = m.unplaced()[0];
  if (fresh) {
    m.place(fresh, 0.2, 0.3, 'town');
    ok('an area that was never on the map can be placed', Boolean(m.places()[fresh]), fresh);
    ok('and leaves the tray', !m.unplaced().includes(fresh));
  }

  m.unplace(n2);
  ok('removing a marker takes it off the map', !m.places()[n2]);
  ok('but it is not destroyed — it goes back to the tray', m.unplaced().includes(n2));
  ok('and a link to a marker that is gone is not drawn',
    m.links().every((l) => l.a !== n2 && l.b !== n2));
}

console.log('\n── connecting');
{
  const m = new MapEdit(MAP, AREAS);
  const before = m.links().length;
  const a = names[0]; const b = names[names.length - 1];
  const already = m.links().some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  ok('a place cannot be linked to itself', m.connect(a, a) === false);
  ok('a link to a marker that is not on the map is refused',
    m.connect(a, 'Nowhere At All') === false);
  if (!already && a !== b) {
    ok('two places can be connected', m.connect(a, b) === true);
    ok('and the link appears', m.links().length === before + 1);
    ok('the same pair cannot be connected twice', m.connect(a, b) === false);
    ok('nor in the other direction', m.connect(b, a) === false,
      'a road drawn backwards is the same road');
    const i = m.linkEdits.findIndex((l) => l.a === a && l.b === b);
    m.setLinkAreas(i, ['Route 1', 'Route 1', '']);
    ok('a leg can carry areas, de-duplicated and without blanks',
      m.linkEdits[i].areas.length === 1, JSON.stringify(m.linkEdits[i].areas));
    m.setBend(i, 0, 0.4, 0.4);
    ok('a bend is inserted between the endpoints',
      m.links().find((l) => l.a === a && l.b === b).pts.length === 3);
    m.clearBends(i);
    ok('and can be straightened again',
      m.links().find((l) => l.a === a && l.b === b).pts.length === 2);
    m.removeLink(i);
    ok('a link can be removed', m.links().length === before);
  }
}

console.log('\n── undo');
{
  const m = new MapEdit(MAP, AREAS);
  const x0 = m.places()[n1].x;
  const links0 = m.links().length;
  m.move(n1, 0.9, 0.9);
  m.connect(names[0], names[names.length - 1]);
  m.addNote(0.5, 0.5, 'Audino here');
  ok('there is something to undo', m.undoStack.length === 3, `${m.undoStack.length}`);
  m.undo(); m.undo(); m.undo();
  ok('undo walks all the way back to the shipped map',
    m.places()[n1].x === x0 && m.links().length === links0 && m.notes.length === 0);
  ok('and the dirty flag clears with it', m.dirty === false);
  ok('undoing past the start is a no-op, not a throw', m.undo() === null);
}

console.log('\n── what leaves the browser');
{
  const m = new MapEdit(MAP, AREAS);
  ok('an untouched map writes no link override',
    m.toPayload().links === undefined,
    'otherwise it freezes a copy of the shipped links and stops tracking them');

  m.addNote(0.5, 0.5, 'Audino swarm');
  ok('notes are still not a link override', m.toPayload().links === undefined);
  ok('and notes never reach the payload at all',
    !JSON.stringify(m.toPayload()).includes('Audino'),
    'they are facts about your run, not about Unova');

  m.move(n1, 0.33, 0.44);
  const p = m.toPayload();
  ok('a moved marker does reach it', p.positions[n1].x === 0.33);
  ok('every position written is a fraction of the image',
    Object.values(p.positions).every((v) => v.hidden
      || (v.x >= 0 && v.x <= 1 && v.y >= 0 && v.y <= 1)),
    'pixels would break the moment the artwork is re-cropped');

  m.connect(names[0], names[names.length - 1]);
  ok('touching a link writes the whole set', Array.isArray(m.toPayload().links));
  ok('including the ones that shipped unchanged',
    m.toPayload().links.length >= MAP.links.length);
}

console.log('\n── persistence');
{
  const m = new MapEdit(MAP, AREAS);
  m.move(n1, 0.25, 0.35);
  m.addNote(0.1, 0.2, 'come back with Surf');
  m.persist();
  const back = new MapEdit(MAP, AREAS, loadEdits(), loadNotes());
  ok('edits survive a round trip through storage', back.places()[n1].x === 0.25);
  ok('so do notes', back.notes.length === 1 && back.notes[0].text === 'come back with Surf');
  ok('notes are stored apart from edits, under their own key',
    !String(_s.get('blazeblack.map.edits')).includes('Surf'),
    'one is committed, the other never leaves this browser');

  _s.set('blazeblack.map.edits', 'not json at all');
  ok('corrupt storage degrades to no edits rather than throwing',
    Object.keys(loadEdits().positions).length === 0);
  _s.delete('blazeblack.map.edits');
}

console.log('\n── clearing the map');
{
  const m = new MapEdit(MAP, AREAS);
  m.addNote(0.4, 0.4, 'Audino here');
  // Count what is there rather than assuming an empty store -- an earlier
  // block persisted a note, and the constructor picks those up.
  const notesBefore = m.notes.length;
  const trayBefore = m.unplaced().length;
  m.clearAll();
  ok('clearing takes every marker off', Object.keys(m.places()).length === 0);
  // links() already hides roads whose endpoints are gone, so asserting it is
  // empty passes even if clearAll never touched them. Check the stored set,
  // which is what actually gets written out.
  ok('and every road with them',
    m.links().length === 0 && Array.isArray(m.linkEdits) && m.linkEdits.length === 0,
    `${m.linkEdits?.length ?? 'null'} stored`);
  ok('everything lands in the tray, ready to place yourself',
    m.unplaced().length === trayBefore + names.length,
    `${m.unplaced().length} in the tray`);
  ok('your notes are left alone — they are a different layer',
    m.notes.length === notesBefore && m.notes.some((n) => n.text === 'Audino here'),
    `${notesBefore} before, ${m.notes.length} after`);
  ok('it is ONE undo step, not one per marker',
    m.undoStack.length === 2, `${m.undoStack.length} (add note, then clear)`);
  m.undo();
  ok('so undo brings the whole map back at once',
    Object.keys(m.places()).length === names.length && m.links().length === MAP.links.length);
  m.clearAll();
  ok('clearing an already-clear map does nothing', m.clearAll() === false,
    'and so cannot bury the undo you need under a no-op');
  // A cleared map is a deliberate state and has to survive being written out.
  ok('a cleared map writes an empty road list, not a missing one',
    Array.isArray(m.toPayload().links) && m.toPayload().links.length === 0,
    'absent would mean "still following the shipped roads"');
}

console.log('\n── reset');
{
  const m = new MapEdit(MAP, AREAS);
  m.move(n1, 0.9, 0.1);
  m.connect(names[0], names[names.length - 1]);
  m.reset();
  ok('reset returns to the shipped map',
    m.places()[n1].x === MAP.places[n1].x && m.links().length === MAP.links.length);
  ok('and is itself undoable', m.undo() !== null && m.places()[n1].x === 0.9,
    'a reset you cannot take back is a way to lose an evening');
}

console.log('\n── spurs: a landmark that opens off a road');
{
  // Routes are EDGES on this map, not nodes, so a landmark that opens onto one
  // -- Wellspring Cave onto Route 3 -- could not be attached at all: you could
  // only connect it to a town it does not touch. A spur ends at a POINT.
  const E = new MapEdit(MAP, AREAS);
  const names = Object.keys(E.places());
  const a = names[0];
  const before = E.links().length;
  ok('a place can be attached to a point on the map', E.spur(a, 0.42, 0.58));
  const links = E.links();
  ok('...which draws as one more link', links.length === before + 1);
  const sp = links.find((l) => l.spur);
  ok('...marked as a spur, so it can read as a branch not a road', Boolean(sp));
  ok('...ending exactly where it was clicked',
    sp && Math.abs(sp.pts[sp.pts.length - 1][0] - 0.42) < 1e-9
      && Math.abs(sp.pts[sp.pts.length - 1][1] - 0.58) < 1e-9,
    sp && JSON.stringify(sp.pts[sp.pts.length - 1]));
  ok('one spur per place, so a second click does not stack them', !E.spur(a, 0.1, 0.1));
  // A coordinate, never a link index: indices move when roads are added or
  // removed, and a spur that silently jumped to another route would be worse
  // than one you have to drag again.
  ok('the spur is stored as a coordinate, not a link index',
    E.toPayload().links.some((l) => Array.isArray(l.at) && l.b == null));
  // A place you can only reach by a spur is still reachable.
  ok('and a spurred place is not an orphan', !E.orphans().includes(a));
  ok('undo takes it back', E.undo() && !E.links().some((l) => l.spur));
}

console.log(failed ? `\n  ${failed} check(s) FAILED` : '\n  all checks passed');
process.exit(failed ? 1 : 0);
