/**
 * verify_adventure.mjs -- the Adventure tab, data join and UI.
 *
 * Why this file asserts what it does: notes/adventure-and-map.md
 *
 *     node tools/verify_adventure.mjs [path/to/save.sav]
 *
 * The join is the risky part. Three sources name areas differently -- the save
 * via maps.json, the wiki's route directories, and Drayano's item doc -- and a
 * name that fails to match does not error, it just produces an area that looks
 * empty. So the join is checked by counting, and by pinning areas whose names
 * are known to differ across sources.
 *
 * READ-ONLY.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { opponentsFor } from '../app/js/roster.js';

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
    this.children = []; this.attrs = {}; this.style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } }; this.className = '';
    this.textContent = ''; this.value = ''; this.disabled = false; this.selected = false;
    this.parentNode = null;
    this.classList = {
      add: (c) => { if (!this.className.split(' ').includes(c)) this.className = (this.className + ' ' + c).trim(); },
      remove: (c) => { this.className = this.className.split(' ').filter((x) => x && x !== c).join(' '); },
      toggle: (c, on) => ((on ?? !this.className.split(' ').includes(c)) ? this.classList.add(c) : this.classList.remove(c)),
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
  prepend(...kids) { const old = this.children; this.children = []; this.append(...kids); this.children.push(...old); }
  querySelectorAll() { return []; }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  closest() { return null; }
  addEventListener() {} removeEventListener() {} focus() {} blur() {}
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
}
global.document = {
  body: new N('body'), createElement: (t) => new N(t),
  // rich() returns a DocumentFragment, so the stub needs one. N.append
  // flattens it the way the real DOM does, keeping .text assertions honest.
  createDocumentFragment: () => new N('#fragment'),
  createTextNode: (t) => Object.assign(new N('#text'), { textContent: t }),
  addEventListener() {}, removeEventListener() {}, querySelector: () => null,
};
const _ls = new Map();
global.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem(k, v) { _ls.set(k, String(v)); },
  removeItem(k) { _ls.delete(k); },
};
const hasClass = (c) => (n) => n.classList.contains(c);

const { Save } = await import('../js/save.js');
const { Factory } = await import('../app/js/factory.js');
const advTab = (await import('../app/js/tabs/adventure.js')).default;

let savePath = process.argv[2];
if (!savePath) {
  const dir = path.join(ROOT, 'save_backups');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sav'))
    .map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs) : [];
  // Fall back to the committed fixture, the way verify_run and verify_dex
  // already do: a fresh clone has no save_backups/, and ./test-all exiting 2
  // there is the suite that proves the checkout works refusing to run.
  savePath = files[files.length - 1] ?? path.join(ROOT, 'tests/fixture.sav');
}
if (!savePath || !fs.existsSync(savePath)) {
  console.error('verify_adventure: no save given and none found'); process.exit(2);
}
console.log(`  save: ${path.relative(ROOT, savePath)}\n`);
const S = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/data/static.json'), 'utf8'));
// OPPONENTS IS KEYED BY STARTER NOW. Each starter gets its own full roster,
// because the fork changes what is INSIDE a fight rather than whether it
// happens -- a different Striaton leader and a different six on every rival.
// The three are index-aligned, which is what lets AREAINDEX keep storing a
// position; that is asserted below rather than assumed.
const OPPS = opponentsFor(S, null, null);
const original = new Uint8Array(fs.readFileSync(savePath));

// ================================================================ THE JOIN
console.log('── the area join');
{
  const idx = S.AREAINDEX ?? {};
  ok('there is an area index', Object.keys(idx).length > 50, `${Object.keys(idx).length} areas`);
  ok('every area names at least one zone',
    Object.values(idx).every((a) => a.zones.length > 0));
  ok('a zone belongs to exactly one area', (() => {
    const seen = new Set();
    for (const a of Object.values(idx)) for (const z of a.zones) {
      if (seen.has(z)) return false;
      seen.add(z);
    }
    return true;
  })());

  const withWiki = Object.values(idx).filter((a) => a.wiki.length);
  const withItems = Object.values(idx).filter((a) => a.items.length);
  ok('most areas with encounters joined to the wiki', withWiki.length >= 40, `${withWiki.length}`);
  ok('field items attached to areas', withItems.length >= 30, `${withItems.length}`);

  // Names that differ between the sources -- the whole reason this join exists.
  for (const [area, mustHave] of [
    ['Pinwheel Forest', ['Pinwheel Forest - Inside', 'Pinwheel Forest - Outside']],
    ['Desert Resort', ['Desert Resort - Main']],
  ]) {
    const a = idx[area];
    ok(`"${area}" joined its differently-named wiki pages`,
      Boolean(a) && mustHave.every((w) => a.wiki.includes(w)),
      a ? a.wiki.join(', ') : 'missing');
  }
  ok('every wiki page an area claims actually exists',
    Object.values(idx).every((a) => a.wiki.every((w) => S.AREAS[w])));

  // The item doc's order is the progression spine.
  const ordered = Object.values(idx).filter((a) => a.order != null)
    .sort((a, b) => a.order - b.order);
  ok('the item doc supplies a game-order spine', ordered.length > 20, `${ordered.length} ordered`);
  ok('it starts where the game does', /Nuvema/.test(ordered[0]?.name ?? ''), ordered[0]?.name);

  // Field items must keep BOTH names: placement never moved, so the old name
  // is how you find the spot on a vanilla map.
  const anyItem = Object.values(idx).find((a) => a.items.length)?.items[0];
  ok('a field item records what it WAS and what it is now',
    Boolean(anyItem?.was) && Boolean(anyItem?.now) && anyItem.count >= 1,
    anyItem ? `${anyItem.was} -> ${anyItem.now} ×${anyItem.count}` : '');
}

console.log('\n── the save side');
{
  const sv = Save.load(new Uint8Array(original));
  const pos = sv.readPosition();
  ok('position decodes to a real zone', pos.zone_id >= 0 && Boolean(S.ZONES[String(pos.zone_id)]),
    `${pos.zone_id} = ${S.ZONES[String(pos.zone_id)]}`);
  const dex = sv.readPokedex();
  ok('the Pokédex decodes', dex.caught.length >= 0 && dex.seen.length >= dex.caught.length,
    `${dex.caught.length} caught / ${dex.seen.length} seen`);
  ok('caught implies seen', dex.caught.every((d) => dex.seenSet.has(d)));
  ok('nothing outside 1..649', [...dex.seen, ...dex.caught].every((d) => d >= 1 && d <= 649));
}

// ====================================================================== UI
console.log('\n── ui');
{
  const panel = new N('div');
  const F = new Factory(Save.load(new Uint8Array(original)), S);
  advTab.mount(panel, { S, factory: F });
  const R = () => panel.children[0];

  ok('it says where you are', /You are in/.test(R().text));
  const loc = S.ZONES[String(F.save.readPosition().zone_id)];
  ok('and names the actual location', R().text.includes(loc), loc);
  ok('there is an area picker', Boolean(R().find((n) => n.tagName === 'SELECT')));

  // Browse to an area that definitely has encounters and items.
  const sel = R().find((n) => n.tagName === 'SELECT');
  ok('the picker lists every area', sel.children.length === Object.keys(S.AREAINDEX).length,
    `${sel.children.length}`);
  sel.value = 'Pinwheel Forest'; sel.onchange();

  const panels = () => panel.children[0].findAll(hasClass('ad-panel'));
  ok('browsing renders panels', panels().length >= 2, `${panels().length}`);
  const text = panel.children[0].text;
  ok('wild Pokémon are listed', /Wild Pokémon/.test(text));
  ok('field items are listed', /On the ground/.test(text));
  ok('the sprites are rendered', panel.children[0].findAll(hasClass('ad-mon')).length > 5,
    `${panel.children[0].findAll(hasClass('ad-mon')).length} entries`);

  // Gating: surf rows must be MARKED when you cannot surf, not hidden.
  const bag = F.save.readBag();
  const hasSurf = bag.tms_hms.some((e) => (S.ITEMS[String(e.item_id)] ?? '').startsWith('HM03'));
  const surfRow = panel.children[0].findAll(hasClass('ad-method'))
    .find((m) => /Surf|Rippling/.test(m.text));
  if (surfRow) {
    ok(`surf rows are ${hasSurf ? 'not gated (you have HM03)' : 'marked as gated'}`,
      surfRow.classList.contains('gated') === !hasSurf, surfRow.text.slice(0, 50));
  } else {
    console.log('  [SKIP] surf gating — no water encounters in this area');
  }

  // The level-as-percentage defect must be surfaced, not silently passed on.
  const anySuspect = Object.values(S.AREAS).flat().some((r) => r.suspect);
  ok('the static data still flags level-as-percentage rows', anySuspect);
  sel.value = 'Dreamyard'; sel.onchange();
  ok('and the tab shows that flag where it applies',
    /rates suspect/.test(panel.children[0].text), 'Dreamyard grass-special totals 171%');

  // An area with no encounter page must explain itself, not look broken.
  const bare = Object.values(S.AREAINDEX).find((a) => !a.wiki.length);
  if (bare) {
    const s2 = panel.children[0].find((n) => n.tagName === 'SELECT');
    s2.value = bare.name; s2.onchange();
    ok('an area with no encounter table says why', /nothing recorded/.test(panel.children[0].text),
      bare.name);
  }

  // "Hide ones I have" must actually remove rows.
  const s3 = panel.children[0].find((n) => n.tagName === 'SELECT');
  s3.value = 'Pinwheel Forest'; s3.onchange();
  const before = panel.children[0].findAll(hasClass('ad-mon')).length;
  const caught = panel.children[0].findAll(hasClass('ad-mon'))
    .filter((m) => m.classList.contains('caught')).length;
  const tog = panel.children[0].find((n) => n.tagName === 'BUTTON' && /Hide ones I have/.test(n.text));
  if (tog && caught) {
    tog.click();
    ok('hiding what you own removes exactly those',
      panel.children[0].findAll(hasClass('ad-mon')).length === before - caught,
      `${before} -> ${panel.children[0].findAll(hasClass('ad-mon')).length}, ${caught} caught`);
  } else {
    console.log('  [SKIP] hide-caught — nothing here is caught in this save');
  }

  // ---- the region map ------------------------------------------------------
  {
    const M = S.MAP;
    ok('there is a map', Boolean(M?.places) && Object.keys(M.places).length > 20,
      `${Object.keys(M?.places ?? {}).length} places, ${M?.links?.length ?? 0} links`);
    ok('every place is a real area', Object.keys(M.places).every((n) => S.AREAINDEX[n]));
    ok('every route on a leg is a real area',
      M.links.every((l) => (l.areas ?? []).every((n) => S.AREAINDEX[n])));
    ok('build flagged nothing unknown', (M.unknown ?? []).length === 0, (M.unknown ?? []).join(', '));
    ok('nothing is stranded off the graph', (M.orphans ?? []).length === 0,
      (M.orphans ?? []).join(', '));
    ok('positions are fractions of the image',
      Object.values(M.places).every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1));
    ok('no two places share a marker', (() => {
      const seen = new Set();
      for (const p of Object.values(M.places)) {
        const k = `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
        if (seen.has(k)) return false;
        seen.add(k);
      }
      return true;
    })());

    // ROUTES ARE THE LINES. That is the whole design, so it is asserted.
    ok('routes are edges, not markers',
      M.routes.length > 10 && M.routes.every((r) => !M.places[r]),
      `${M.routes.length} routes, none of them a marker`);
    // A leg can pass through several areas -- Route 5 then the drawbridge --
    // and without that, every bridge but Skyarrow was simply missing.
    ok('a leg can carry more than one area',
      M.links.some((l) => (l.areas ?? []).length > 1),
      M.links.filter((l) => (l.areas ?? []).length > 1).length + ' multi-area legs');
    const bridges = Object.keys(S.AREAINDEX).filter((n) => /bridge/i.test(n) && n !== 'Bridge Gate');
    const onMap = bridges.filter((b) => M.routes.includes(b));
    ok('every bridge in the game is on the map', onMap.length === bridges.length,
      `${onMap.length} of ${bridges.length}: ${bridges.filter((b) => !onMap.includes(b)).join(', ') || 'all'}`);
    ok('every link has at least two points',
      M.links.every((l) => Array.isArray(l.pts) && l.pts.length >= 2));
    ok('link endpoints match their places', M.links.every((l) => {
      const a = M.places[l.a], b = M.places[l.b];
      const [p0, pN] = [l.pts[0], l.pts[l.pts.length - 1]];
      return a && b && p0[0] === a.x && p0[1] === a.y && pN[0] === b.x && pN[1] === b.y;
    }));

    // Three weights, or the map is forty identical dots again.
    const kinds = new Set(Object.values(M.places).map((p) => p.kind));
    ok('places carry a visual hierarchy',
      kinds.has('city') && kinds.has('town') && kinds.has('landmark'),
      [...kinds].join(', '));

    // Geography, as relationships rather than numbers -- a mirrored table
    // would otherwise look entirely plausible.
    const at = (n) => M.places[n];
    ok('the starting town is south-east of Castelia',
      at('Nuvema Town').x > at('Castelia City').x && at('Nuvema Town').y > 0.7);
    ok('the first towns run in order away from the bridge',
      at('Nuvema Town').x > at('Accumula Town').x && at('Accumula Town').x > at('Striaton City').x);
    ok('Driftveil and Mistralton are west of Castelia',
      at('Driftveil City').x < at('Castelia City').x
      && at('Mistralton City').x < at('Driftveil City').x);
    ok('the league is at the top', at('Pokémon League').y < 0.15);
    ok('only Black City is placed, not its White counterpart',
      Boolean(at('Black City')) && !M.places['White Forest']);

    // The path you actually walk must be connected end to end.
    ok('you can walk from Nuvema to the League', (() => {
      const adj = new Map();
      for (const l of M.links) {
        if (!adj.has(l.a)) adj.set(l.a, []);
        if (!adj.has(l.b)) adj.set(l.b, []);
        adj.get(l.a).push(l.b); adj.get(l.b).push(l.a);
      }
      const seen = new Set(['Nuvema Town']); const q = ['Nuvema Town'];
      while (q.length) for (const n of adj.get(q.pop()) ?? []) {
        if (!seen.has(n)) { seen.add(n); q.push(n); }
      }
      return seen.has('Pokémon League');
    })());

    const img = path.join(ROOT, 'app/img/unova.jpg');
    if (fs.existsSync(img)) {
      ok('the map image is present', fs.statSync(img).size > 100000,
        `${(fs.statSync(img).size / 1048576).toFixed(1)} MB`);
    } else {
      console.log('  [SKIP] map image — not fetched yet; ./setup gets it');
    }

    ok('the map renders', Boolean(panel.children[0].find(hasClass('ad-map'))));
    ok('markers are drawn', panel.children[0].findAll(hasClass('ad-pin')).length > 20,
      `${panel.children[0].findAll(hasClass('ad-pin')).length}`);
    const linkLayer = panel.children[0].find(hasClass('ad-links'));
    ok('route lines are drawn', Boolean(linkLayer) && /<path/.test(linkLayer.innerHTML ?? ''));
    ok('each line carries a hit area you can actually click',
      (linkLayer.innerHTML.match(/ad-hit/g) ?? []).length === M.links.length,
      `${(linkLayer.innerHTML.match(/ad-hit/g) ?? []).length} of ${M.links.length}`);
    const tags = panel.children[0].findAll(hasClass('ad-routetag'));
    ok('named routes get a clickable badge', tags.length === M.routes.length,
      `${tags.length} badges for ${M.routes.length} routes`);
    ok('clicking a route badge browses that route', (() => {
      const before = panel.children[0].text;
      tags[0].click();
      return panel.children[0].text !== before;
    })());
    // TOP-LEVEL PANELS ARE SPACED BY THE CONTAINER, not by each one bringing
    // its own margin. The trainer card and the story-progress panel ended up
    // exactly flush -- 0px between two bordered, shadowed cards, which reads
    // as one broken box -- because the progress panel had never needed a
    // margin while nothing followed it. A stub DOM does no layout, so this can
    // only be asserted as a rule: `.ad` must lay its children out with a gap.
    {
      const css0 = fs.readFileSync(path.join(ROOT, 'app/css/adventure.css'), 'utf8');
      const root = /(^|\})\s*\.ad\s*\{([^}]*)\}/m.exec(css0)?.[2] ?? '';
      ok('the Adventure root spaces its panels itself',
        /display:\s*flex/.test(root) && /gap:\s*\d/.test(root),
        root.replace(/\s+/g, ' ').trim().slice(0, 80));
      // And no panel may re-introduce the old per-panel margin, which is how
      // the spacing drifted apart in the first place.
      const strays = ['.ad-mapwrap', '.ad-cardpanel', '.ad-progress', '.ad-panels']
        .filter((sel) => {
          const r = new RegExp(`(^|\\})\\s*\\${sel}\\s*\\{([^}]*)\\}`, 'm').exec(css0)?.[2] ?? '';
          return /margin-(top|bottom):\s*[1-9]/.test(r);
        });
      ok('...and no panel brings its own vertical margin', strays.length === 0, strays.join(', '));
    }

    // The marker layer once covered the whole map with no pointer-events
    // rule, so it swallowed every click before the route lines saw one. CSS,
    // but a functional bug -- so it is asserted here rather than trusted.
    const css = fs.readFileSync(path.join(ROOT, 'app/css/adventure.css'), 'utf8');
    const rule = /\.ad-markers\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    ok('the marker layer does not swallow clicks meant for the routes',
      /pointer-events:\s*none/.test(rule), rule.replace(/\s+/g, ' ').slice(0, 70));
    ok('markers themselves still take clicks',
      /\.ad-pin\s*\{[^}]*pointer-events:\s*auto/.test(css));
    // This test used to assert the OPPOSITE, and so pinned the bug in place:
    // .ad-markers.editing{pointer-events:auto} made a full-map layer swallow
    // every click in edit mode, and .ad-notes.editing did it again on top.
    // Nothing on the map was clickable at all.
    //
    // The invariant is the one already documented for browsing: a layer that
    // covers the whole map with inset:0 must NEVER take pointer events. Only
    // its interactive children may. A stubbed DOM calls handlers directly and
    // does no hit-testing, so this can only be checked as a CSS rule.
    const layers = ['ad-markers', 'ad-notes', 'ad-handles', 'ad-routetags'];
    const greedy = layers.filter((c) => new RegExp(
      `\\.${c}[^{]*\\{[^}]*pointer-events:\\s*auto`).test(css));
    ok('no full-map layer swallows clicks meant for what is under it',
      greedy.length === 0, greedy.join(', ') || 'markers, notes, handles, routetags all none');
    for (const child of ['ad-pin', 'ad-note', 'ad-handle']) {
      ok(`...but ${child} itself is clickable`,
        new RegExp(`\\.${child}[^{]*\\{[^}]*pointer-events:\\s*auto`).test(css));
    }

    // The editor replaced calibration outright. Calibration could only nudge a
    // marker that was already on the map, one at a time, from a permanent strip
    // that most people never used.
    const editBtn = panel.children[0].find((n) => n.tagName === 'BUTTON' && /Edit map/.test(n.text));
    ok('there is a way into the map editor', Boolean(editBtn));
    ok('and no calibration strip left behind',
      !panel.children[0].find(hasClass('ad-cal')));

    editBtn.click();
    const E = () => panel.children[0];
    ok('editing renders the editor', Boolean(E().find(hasClass('ad-editor'))));
    // This is the actual complaint being fixed: the map had to share the tab
    // with encounter tables, trainers, items and a progress bar.
    // Under the map, where he wants it -- but stuck to the bottom of the
    // viewport, which is what putting it on top was solving. Both halves
    // matter: below AND still on screen.
    ok('the toolbar sits under the map',
      E().children.findIndex((n) => n.classList.contains('ad-editor'))
        > E().children.findIndex((n) => n.classList.contains('ad-mapwrap')));
    ok('...but sticks to the bottom of the viewport so it is never below the fold',
      /\.ad-editor\{[^}]*position:sticky[^}]*bottom:0/.test(css),
      'the map has no max-height in edit mode');
    ok('the active tool explains itself right there',
      /Drag a marker to move it/.test(E().find(hasClass('ad-howto'))?.text ?? ''));
    ok('and takes over the tab, so nothing competes with the map',
      E().findAll(hasClass('ad-panel')).length === 2
      && !E().find(hasClass('ad-encounters')),
      `${E().findAll(hasClass('ad-panel')).length} panels`);
    for (const t of ['Move', 'Connect', 'Note']) {
      ok(`there is a ${t} tool`,
        Boolean(E().find((n) => n.tagName === 'BUTTON' && n.text.trim() === t)));
    }
    // Clicking bare ground must be judged by what you did NOT hit. Testing for
    // the image is wrong: .ad-links covers the map and its <svg> is the target
    // over empty ground, so an image test silently disables placing and notes.
    const src = fs.readFileSync(path.join(ROOT, 'app/js/tabs/adventure.js'), 'utf8');
    ok('a click on bare map is judged by what it missed, not by hitting the image',
      /closest\?\.\('\.ad-pin, \.ad-note, \.ad-handle, g\.ad-link'\)/.test(src)
      && !/e\.target !== img/.test(src));

    ok('the tray lists areas that are not on the map yet',
      Boolean(E().find(hasClass('ad-tray'))));
    ok('undo starts disabled, because nothing has been changed',
      E().find((n) => n.tagName === 'BUTTON' && /^Undo/.test(n.text))?.disabled === true);

    // Selecting a marker offers the things you can do to it.
    // Select a marker the way a mouse does: pointerdown, pointerup, THEN click.
    // Calling onclick directly hid a real bug -- pointerup re-rendered on a
    // plain click, detaching the element before the click could reach it, so
    // no marker could ever be selected and "Take off the map" was unreachable.
    const pin = E().findAll(hasClass('ad-pin'))[0];
    const mapNode = E().find(hasClass('ad-map'));
    pin.onpointerdown?.({ pointerId: 1, preventDefault() {}, shiftKey: false });
    mapNode.onpointerup?.({ pointerId: 1 });
    ok('a click that did not drag does not redraw the map',
      E().find(hasClass('ad-map')) === mapNode,
      'redrawing here detaches the pin before its click handler can run');
    pin.onclick?.();
    const selBox = E().find(hasClass('ad-esel'));
    ok('clicking a marker selects it and offers its kind', Boolean(selBox)
      && ['city', 'town', 'landmark'].every((k) =>
        selBox.findAll((n) => n.tagName === 'BUTTON' && n.text.trim() === k).length === 1));
    const rm = selBox.find((n) => n.tagName === 'BUTTON'
      && /Take off the map/.test(n.text));
    ok('and offers to take it off the map', Boolean(rm));

    // End to end on a DEFAULT marker: gone from the map, back in the tray,
    // and restorable. This is the whole "remove one so I can replace it" loop.
    const pinName = pin.text.trim();
    const pinsBefore = E().findAll(hasClass('ad-pin')).length;
    rm.onclick();
    ok('taking a default marker off removes it from the map',
      E().findAll(hasClass('ad-pin')).length === pinsBefore - 1,
      `${pinsBefore} → ${E().findAll(hasClass('ad-pin')).length}`);
    const tray = E().find(hasClass('ad-tray'));
    ok('and it comes back in the tray, ready to be put somewhere else',
      Boolean(tray.find((n) => n.tagName === 'BUTTON' && n.text.trim() === pinName)),
      pinName);
    E().find((n) => n.tagName === 'BUTTON' && /^Undo/.test(n.text)).onclick();
    ok('and undo puts it back on the map',
      E().findAll(hasClass('ad-pin')).length === pinsBefore);

    // Connect is click-then-click, not drag.
    E().find((n) => n.tagName === 'BUTTON' && n.text.trim() === 'Connect').click();
    const before = E().findAll(hasClass('ad-pin')).length;
    ok('connect mode still shows every marker', before > 2, `${before}`);
    const say = E().find(hasClass('ad-esel'))?.text ?? '';
    ok('and says what to do next', /Click the first of the two places/.test(say), say.slice(0, 50));

    // Clear the map: the "I would rather place these myself" path.
    const clearBtn = E().find((n) => n.tagName === 'BUTTON' && /Clear the map/.test(n.text));
    ok('there is a way to wipe the map', Boolean(clearBtn));
    const trayBefore = E().find(hasClass('ad-tray')).findAll((n) => n.tagName === 'BUTTON').length;
    clearBtn.onclick();
    ok('clearing takes every marker off the map',
      E().findAll(hasClass('ad-pin')).length === 0);
    ok('and every road with them', E().findAll(hasClass('ad-routetag')).length === 0);
    ok('and fills the tray so you can place them yourself',
      E().find(hasClass('ad-tray')).findAll((n) => n.tagName === 'BUTTON').length > trayBefore,
      `${trayBefore} → ${E().find(hasClass('ad-tray')).findAll((n) => n.tagName === 'BUTTON').length}`);
    const undoBtn = E().find((n) => n.tagName === 'BUTTON' && /^Undo/.test(n.text));
    ok('and undo names what it will put back', /clear the map/.test(undoBtn.text), undoBtn.text);
    undoBtn.onclick();
    ok('which it does, in one step', E().findAll(hasClass('ad-pin')).length > 0);

    E().find((n) => n.tagName === 'BUTTON' && n.text.trim() === 'Done').click();
    ok('Done goes back to browsing', !panel.children[0].find(hasClass('ad-editor')));
    ok('and the rest of the tab comes back',
      panel.children[0].findAll(hasClass('ad-panel')).length > 2);

    // Three label toggles, all behaving the same way. Towns are settlements
    // and label with the cities; "Landmark names" is the caves, towers and
    // gates -- the bulk of the 41 markers that made the map unreadable when
    // every label was permanent, so that one is off by default.
    for (const label of [/City \/ town names/, /Route labels/, /Landmark names/]) {
      const b = panel.children[0].find((n) => n.tagName === 'BUTTON' && label.test(n.text));
      ok(`there is a ${label.source.replace(/\\/g, '')} toggle`, Boolean(b));
    }
    ok('landmark labels are off by default',
      !panel.children[0].find(hasClass('ad-map'))?.classList.contains('miscnames'),
      '41 permanent labels is what made the first version unreadable');
    const misc = panel.children[0].find((n) => n.tagName === 'BUTTON' && /Landmark names/.test(n.text));
    misc.onclick();
    ok('and turning it on labels the landmarks',
      panel.children[0].find(hasClass('ad-map')).classList.contains('miscnames'));
    // Towns follow the CITY toggle, not the landmark one: they are settlements.
    const flat = css.replace(/\s+/g, ' ');
    ok('towns label with the cities',
      /\.ad-map\.citynames[^{]*\.k-town \.ad-pinlab[^{]*\{[^}]*opacity: 1/.test(flat));
    ok('and not with the landmarks',
      !/\.ad-map\.miscnames[^{]*\.k-town/.test(flat));
    panel.children[0].find((n) => n.tagName === 'BUTTON' && /Landmark names/.test(n.text)).onclick();

    // The notes toggle is meaningless until there is a note, and says so.
    // The label names the control; aria-pressed carries the state. "Notes off"
    // could be read as either the current state or what clicking would do.
    const notesBtn = () => panel.children[0]
      .find((n) => n.tagName === 'BUTTON' && /^Notes$/.test(n.text.trim()));
    ok('there is a notes toggle', Boolean(notesBtn()));
    ok('the toggles say their state in aria-pressed, not in the label',
      ['City / town names', 'Route labels', 'Landmark names', 'Notes'].every((label) => {
        const b = panel.children[0].find((n) => n.tagName === 'BUTTON'
          && n.text.trim() === label);
        return b && /^(true|false)$/.test(b.getAttribute('aria-pressed') ?? '');
      }));
    ok('it is unavailable until a note exists', notesBtn().disabled === true,
      'a toggle for something you have none of is a dead control');
    ok('and says why', /have not left any notes/.test(notesBtn().getAttribute('title') ?? ''));
    ok('notes are never hidden while editing, where you look at them on purpose',
      /\.ad-map\.nonotes:not\(\.editing\) \.ad-notes/.test(css));
    // A numbered route reads fine as a bare number; a named one does not, and
    // "Skyarrow" alone read as a stray word dropped on the map.
    const badges = panel.children[0].findAll(hasClass('ad-routetag'));
    ok('there is a badge per route on the map', badges.length === M.routes.length,
      `${badges.length} badges for ${M.routes.length} routes`);
    // Prefixed: a bare `num` collided with the global sheet's own .num rule,
    // which is injected app-wide, and repainted every route number in faint
    // grey on a near-white pill. verify_app.mjs now fails on any such clash.
    ok('numbered routes use the round shield, named ones a plate',
      badges.some((t) => t.classList.contains('ad-num'))
      && badges.some((t) => t.classList.contains('ad-named')));
    ok('the shield modifiers are prefixed, so the global sheet cannot claim them',
      !badges.some((t) => t.classList.contains('num') || t.classList.contains('named')));
    ok('named routes keep their full name', badges.some((t) => /Bridge$/.test(t.text)),
      badges.filter((t) => t.classList.contains('named')).map((t) => t.text).join(', '));

    // A route badge must not wear a city label's clothes, and the highlight
    // must stay readable -- --ember plus white is 2.41:1 in dark mode.
    const css2 = fs.readFileSync(path.join(ROOT, 'app/css/adventure.css'), 'utf8');
    const hot = /\.ad-routetag:hover, \.ad-routetag\.hot \{[^}]*\}/.exec(css2)?.[0] ?? '';
    ok('the badge highlight uses the measured contrast pair, not --ember + white',
      /--fx-go-bg/.test(hot) && /--fx-go-ink/.test(hot) && !/#fff/.test(hot),
      hot.replace(/\s+/g, ' ').slice(0, 80));
    // WHAT MAKES A BADGE NOT A LABEL IS THAT IT IS PALE AND A LABEL IS DARK.
    // This used to pin the literal string `rgba(233,238,244` -- which fails
    // when the same colour is written as a hex, and passes if someone swaps in
    // a different pale colour that reads as a town. Compare the two surfaces
    // by luminance instead, which is the property the rule is actually about.
    const lum = (css, sel) => {
      const rule = new RegExp(`\\${sel} \\{[^}]*\\}`).exec(css)?.[0] ?? '';
      const m = /background: *(#[0-9a-f]{6}|rgba?\(([^)]+)\))/i.exec(rule);
      if (!m) return null;
      const [r, g, b] = m[1].startsWith('#')
        ? [1, 3, 5].map((i) => parseInt(m[1].slice(i, i + 2), 16))
        : m[2].split(',').slice(0, 3).map((x) => Number(x.trim()));
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    const badgeL = lum(css2, '.ad-routetag');
    const labelL = lum(css2, '.ad-pinlab');
    ok('a resting badge does not look like a place label',
      badgeL != null && labelL != null && badgeL > 0.6 && labelL < 0.3,
      `badge ${badgeL?.toFixed(2)} vs label ${labelL?.toFixed(2)}`);
  }

  // ---- trainers, under the spoiler policy ---------------------------------
  {
    const withT = Object.values(S.AREAINDEX).find((a) => a.trainers?.count > 0);
    ok('some area has a trainer summary', Boolean(withT), withT?.name);
    if (withT) {
      const sel4 = panel.children[0].find((n) => n.tagName === 'SELECT');
      sel4.value = withT.name; sel4.onchange();
      const txt = () => panel.children[0].text;
      ok('it shows a count and a level band', /\d+ trainers? · levels/.test(txt()), withT.name);
      // The whole point: no roster until asked.
      const names = withT.trainers.list.map((t) => t.name);
      ok('no roster is shown yet', !names.some((n) => txt().includes(n)),
        'spoiler policy: verdicts first');
      const show = panel.children[0].find((n) => n.tagName === 'BUTTON' && /Show the \d+ roster/.test(n.text));
      ok('there is a way to ask for it', Boolean(show));
      show.click();
      ok('and asking reveals them', names.some((n) => panel.children[0].text.includes(n)));
    }

    const withBoss = Object.values(S.AREAINDEX).find((a) => (a.opponents ?? []).length);
    ok('important trainers attached to areas', Boolean(withBoss), withBoss?.name);
    if (withBoss) {
      const sel5 = panel.children[0].find((n) => n.tagName === 'SELECT');
      sel5.value = withBoss.name; sel5.onchange();
      const opp = OPPS[withBoss.opponents[0]];
      ok('the leader is named', panel.children[0].text.includes(opp.leader), opp.leader);
      const species = opp.team.map((m) => m.n).filter(Boolean);
      const bossCard = () => panel.children[0].findAll(hasClass('ad-boss'))
        .find((c) => c.text.includes(opp.leader));
      // The spoiler line moved twice, both on review. First WHAT they
      // have came up front as sprites, because you are about to fight them.
      // Then the "Levels, abilities and moves" reveal went too: it swapped the
      // strip for a nearly identical grid whose only new information was the
      // level, while ability, item and moves stayed in a tooltip either way.
      // A control that hides a number you could just show is friction wearing
      // a spoiler policy's clothes.
      ok('their team is shown up front, named and levelled',
        Boolean(bossCard()) && bossCard().findAll(hasClass('ad-mon')).length === opp.team.length,
        `${bossCard()?.findAll(hasClass('ad-mon')).length} of ${opp.team.length}`);
      ok('...with the species names',
        species.every((n) => bossCard().text.includes(n)), species.slice(0, 3).join(', '));
      ok('...and the levels, not behind a click',
        opp.team.filter((m) => m.l).every((m) => bossCard().text.includes(`Lv ${m.l}`)));
      ok('so there is no reveal button left to press',
        !bossCard().find((n) => n.tagName === 'BUTTON' && /Levels, abilities/.test(n.text)));
      // The planning material that IS worth a second look stays in the title.
      // Drayano documents abilities and moves for the important trainers and
      // not for the early rivals, so this follows the data rather than
      // assuming it: asserting unconditionally would pass or fail on which
      // fight the area picker happened to land on.
      const detailed = opp.team.filter((m) => (m.a && m.a !== '-')
        || (m.i && m.i !== '-') || (m.m ?? []).some((x) => x && x !== '-')).length;
      const withDetail = bossCard().findAll(hasClass('ad-mon'))
        .filter((c) => (c.getAttribute('title') ?? '').includes('\n')).length;
      ok('...while abilities, items and moves stay in the tooltip',
        withDetail === detailed, `${withDetail} carry detail, ${detailed} have any`);
      ok('the trainer\'s own portrait is on the card',
        bossCard().findAll(hasClass('ad-face')).length >= 1,
        `face=${opp.face}`);
    }
  }

  // ---- every gym hangs on its own city -------------------------------------
  // Drayano writes "Driftveil Gym"; the zone table has "Driftveil City". The
  // fuzzy fallback that bridged them took the LONGEST name starting with the
  // same word, which sent Clay to "Driftveil DRAWBRIDGE" -- and it went
  // unnoticed for weeks because every other gym had exactly one candidate.
  // The longer name is always the compound; the place itself is the short one.
  {
    const place = new Map();
    for (const [name, a] of Object.entries(S.AREAINDEX)) {
      for (const i of a.opponents ?? []) place.set(i, name);
    }
    const gyms = OPPS.map((o, i) => ({ o, i })).filter(({ o }) => o.kind === 'gym');
    ok('every gym leader is attached to an area', gyms.every(({ i }) => place.has(i)),
      gyms.filter(({ i }) => !place.has(i)).map(({ o }) => o.leader).join(', '));
    // The city's name is the gym's name with "Gym" swapped for "City"/"Town",
    // so this is checkable rather than a list of eight expected pairs.
    const wrong = gyms.filter(({ o, i }) => {
      // Strip the version tag first: Opelucid's two entries are written
      // "Opelucid Gym, Black" / ", White".
      const stem = (o.loc ?? '').replace(/,\s*(black|white)\s*$/i, '')
        .replace(/\s*gyms?$/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const at = (place.get(i) ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
      // Striation is Drayano's own typo for Striaton and is fixed by name.
      return !(at === `${stem}city` || at === `${stem}town` || at === stem
        || at === 'striatoncity');
    });
    ok('...and to its own CITY, not to a bridge or gate that shares the name',
      wrong.length === 0,
      wrong.map(({ o, i }) => `${o.leader}: ${o.loc} -> ${place.get(i)}`).join('; '));
  }

  // ---- badges --------------------------------------------------------------
  // Located 2026-08-29 at 0x21204, one bit per badge, low bits first, settled
  // by a controlled before/after diff across the fourth gym leader. Three
  // earlier candidates each fitted a window of history and each was wrong, so
  // what is asserted here is the SHAPE that made this one a fact: the set bits
  // are always exactly the low N, never with a gap. A byte that merely
  // correlates does not stay gap-free.
  {
    const t = F.save.readTrainer();
    ok('the trainer card reads badges from the save', Number.isInteger(t.badges?.count)
      && t.badges.count >= 0 && t.badges.count <= 8, `${t.badges?.count} of 8`);
    ok('...as the low N bits with no gap, which is what makes it a fact',
      t.badges.mask === (1 << t.badges.count) - 1,
      `mask ${t.badges.mask.toString(2)}`);
    ok('...and the list agrees with the mask',
      t.badges.list.every((i) => (t.badges.mask >> i) & 1)
      && t.badges.list.length === t.badges.count, t.badges.list.join(','));
    const card = panel.children[0].findAll(hasClass('ad-badge'));
    ok('the card draws eight badge slots, not a row of question marks',
      card.length === 8 && !card.some((c) => c.text === '?'), `${card.length} slots`);
    ok('...with exactly the earned ones lit',
      card.filter((c) => c.classList.contains('on')).length === t.badges.count,
      `${card.filter((c) => c.classList.contains('on')).length} lit`);
    // THE GAME'S OWN ART, not eight identical shapes. The arrangement came out
    // of the ROM's cell bank (a/0/4/0 file 45), which is the only reason it is
    // right -- two guesses at the stride each produced plausible fragments.
    // The tab's `el` helper assigns `src` as a PROPERTY, which a real <img>
    // mirrors into the attribute and this stub does not. Read both rather than
    // teaching the stub a mirror it would then have to keep for every
    // attribute that behaves that way.
    const srcOf = (n) => n.src ?? n.getAttribute('src') ?? '';
    const imgs = panel.children[0].findAll(hasClass('ad-badgeimg'));
    ok('...drawn with the badge art extracted from the ROM',
      imgs.length === 8 && imgs.every((n) => /\/app\/img\/badges\//.test(srcOf(n))),
      srcOf(imgs[0] ?? {}));
    ok('...and each is a DIFFERENT badge, in gym order',
      new Set(imgs.map(srcOf)).size === 8,
      imgs.map((n) => srcOf(n).split('/').pop()).join(' '));
    // If setup has run, the files must actually exist -- a card full of broken
    // images is worse than the plates it replaced.
    const dir = path.join(ROOT, 'app/img/badges');
    if (fs.existsSync(dir)) {
      const missing = imgs.map((n) => srcOf(n).split('/').pop())
        .filter((f) => f && !fs.existsSync(path.join(dir, f)));
      ok('...and every one of those files is on disk', missing.length === 0,
        missing.join(', '));
    }
  }

  // ---- portraits -----------------------------------------------------------
  // Resolution happens at build time, so a break here is silent: the panel
  // still renders, just without anybody's face on it.
  {
    const withFace = OPPS.filter((o) => o.face != null).length;
    ok('every documented fight resolved to a portrait',
      withFace === OPPS.length, `${withFace} of ${OPPS.length}`);
    ok('and every portrait it names is actually on disk',
      OPPS.every((o) => (S.TRFACE ?? {})[String(o.face)]),
      OPPS.filter((o) => !(S.TRFACE ?? {})[String(o.face)])
        .map((o) => o.leader).join(', '));
    // Five classes are called "Leader" and four "Elite Four", so resolving on
    // the class alone gave every gym leader Chili's face and all four of the
    // Elite Four Shauntal's. Distinctness is what pins the name-first join.
    const gymFaces = OPPS.filter((o) => o.kind === 'gym').map((o) => o.face);
    ok('gym leaders get distinct portraits, not their class\'s first member',
      new Set(gymFaces).size === gymFaces.length, `${new Set(gymFaces).size} of ${gymFaces.length}`);
    const e4 = OPPS.filter((o) => o.kind === 'elite').map((o) => o.face);
    ok('...and so does each of the Elite Four',
      new Set(e4).size === e4.length, `${new Set(e4).size} of ${e4.length}`);
    // Route trainers resolve by class where the ROM does not know the name.
    const areas = Object.values(S.AREAINDEX).filter((a) => a.trainers);
    const rows = areas.flatMap((a) => a.trainers.list);
    ok('route trainers resolve to a portrait too',
      rows.length > 0 && rows.filter((t) => t.face != null).length >= rows.length - 2,
      `${rows.filter((t) => t.face != null).length} of ${rows.length}`);
    // A gym file holds a second, TRANSPOSED table -- one row per Pokemon --
    // and counting those rows made Nacrene Gym report ten trainers when it
    // has four. A trainer row is a person, so its name is never an image.
    ok('and no Pokémon row is counted as a trainer',
      rows.every((t) => !t.name.startsWith('![')),
      rows.filter((t) => t.name.startsWith('![')).length + ' image rows');
  }

  // ---- story progress ------------------------------------------------------
  {
    // It belongs at the BOTTOM: it is context for the whole run, not the
    // first thing you need when you open the tab.
    const secs = panel.children[0].findAll(hasClass('ad-panel'));
    ok('story progress is the last panel',
      secs[secs.length - 1]?.classList.contains('ad-progress'),
      secs.map((x) => x.className.replace('ad-panel ', '')).join(' | ').slice(0, 70));
    const pFold = panel.children[0].find(hasClass('ad-progress'))
      ?.find((n) => n.classList.contains('ad-fold'));
    ok('it can be collapsed', Boolean(pFold));
    pFold.click();
    ok('folding hides the track', panel.children[0].findAll(hasClass('ad-seg')).length === 0);
    panel.children[0].find(hasClass('ad-progress')).find((n) => n.classList.contains('ad-fold')).click();
    ok('and it comes back', panel.children[0].findAll(hasClass('ad-seg')).length > 0);

    const seg = panel.children[0].findAll(hasClass('ad-seg'));
    // Per fight IN YOUR CARTRIDGE. static.json carries every documented fight
    // tagged with the version that has it, and the tab filters at render time
    // -- so this is 35 of 36, with the Opelucid leader you will never meet
    // left out.
    const forMe = OPPS.filter((o) => !o.ver || o.ver === 'black');
    ok('the progress track has a segment per fight in your version',
      seg.length === forMe.length, `${seg.length} of ${forMe.length} (${OPPS.length} documented)`);
    ok('...and the other version\'s leader is absent, not greyed',
      !panel.children[0].text.includes('Iris'),
      OPPS.filter((o) => o.ver).map((o) => `${o.leader}=${o.ver}`).join(', '));
    // Switching cartridge swaps exactly one fight, and does it without a
    // rebuild -- the point of tagging both rather than filtering in Python.
    {
      const pw = new N('div');
      advTab.unmount();
      advTab.mount(pw, { S, factory: F, version: 'white' });
      const wseg = pw.children[0].findAll(hasClass('ad-seg'));
      ok('switching to Volt White keeps the same number of fights',
        wseg.length === seg.length, `${wseg.length} vs ${seg.length}`);
      ok('...but swaps the Opelucid leader',
        pw.children[0].text.includes('Iris') && !pw.children[0].text.includes('Drayden'));
      advTab.unmount();
      advTab.mount(panel, { S, factory: F });
      // Progress is keyed on a stable slug, so a mark survives the switch.
      ok('and progress is not keyed on position, so a switch cannot move it',
        OPPS.every((o) => o.key) && new Set(OPPS.map((o) => o.key)).size
          === OPPS.length);
    }

    // ---- the STARTER fork ------------------------------------------------
    // It used to be `STARTER = 'Oshawott'` in build_sheet.py, so two players
    // in three were planning against a gym leader they will never meet and
    // rival teams they will never see. It is a setting now, and these pin the
    // three properties the whole design rests on.
    {
      const ids = (S.STARTERS ?? []).map((x) => x.id);
      ok('every starter has its own roster', ids.length === 3
        && ids.every((id) => Array.isArray(S.OPPONENTS?.[id])), ids.join(', '));
      const lists = ids.map((id) => S.OPPONENTS[id]);
      // INDEX ALIGNMENT IS LOAD-BEARING: AREAINDEX[].opponents stores a
      // position into this list, so if the three ever stopped lining up every
      // area would point at the wrong trainer -- silently, because every
      // neighbour is also a plausible fight.
      //
      // `loc` is NOT the field to check it on: Drayano's own file spells
      // Cilan's block "Striation Gym" and the other two "Striaton Gym", so a
      // string compare there fails on a typo rather than on drift. `kind` is
      // the stable one, and the sharper test is that the slugs agree
      // EVERYWHERE EXCEPT the one slot that genuinely forks.
      const differs = lists[0]
        .map((_, i) => i)
        .filter((i) => new Set(lists.map((l) => l[i].key)).size > 1);
      ok('...and the three are index-aligned, which AREAINDEX depends on',
        new Set(lists.map((l) => l.length)).size === 1
        && lists[0].every((_, i) => new Set(lists.map((l) => l[i].kind)).size === 1),
        lists.map((l) => l.length).join('/'));
      ok('...with exactly one slot naming a different fight: Striaton',
        differs.length === 1
        && lists.every((l) => /Striat/i.test(l[differs[0]].loc ?? '')),
        differs.map((i) => `[${i}] ` + lists.map((l) => l[i].key).join('/')).join(' · '));
      // The fork has to CHANGE something, or the setting is decoration. The
      // Striaton leader is the visible half.
      const striaton = ids.map((id) => S.OPPONENTS[id]
        .find((o) => /Striat/i.test(o.loc ?? '') && o.kind === 'gym')?.leader);
      ok('...and picking a different starter changes who you fight at Striaton',
        new Set(striaton).size === 3, striaton.join(' / '));
      // The other half is invisible from a name: the rivals bring a different
      // six. Cheren's late fights are where the doc could not settle it.
      const cheren = ids.map((id) => (S.OPPONENTS[id]
        .find((o) => /Cheren Final/i.test(o.leader ?? ''))?.team ?? [])
        .map((m) => m.n).join(','));
      // The evidence has to show the part that DIFFERS. Their first three are
      // fixed and only the last three fork, so printing the head of the list
      // showed three identical strings beside a passing assertion -- which
      // reads like the check is vacuous when it is not.
      ok('...and the rivals bring a different team, not just a different name',
        new Set(cheren).size === 3,
        cheren.map((c) => c.split(',').slice(-3).join(',')).join(' | '));
      // And it must actually reach the tab.
      const ps = new N('div');
      advTab.unmount();
      advTab.mount(ps, { S, factory: F, starter: 'snivy' });
      const snivyLeader = S.OPPONENTS.snivy
        .find((o) => /Striat/i.test(o.loc ?? '') && o.kind === 'gym')?.leader ?? '';
      ok('the tab renders the roster for the starter it is given',
        ps.children[0].text.includes(snivyLeader.replace('Gym Leader ', '')),
        snivyLeader);
      advTab.unmount();
      advTab.mount(panel, { S, factory: F });
    }
    ok('gyms are called out as milestones',
      seg.filter((x) => x.classList.contains('k-gym')).length > 0,
      `${seg.filter((x) => x.classList.contains('k-gym')).length} gyms`);
    ok('exactly one segment is "next up"',
      seg.filter((x) => x.classList.contains('s-next')).length <= 1);
    ok('it says what it is measuring rather than implying badges are the whole story',
      /badges, read from the save/.test(panel.children[0].text)
      && /eight points on a 36-fight curve/.test(panel.children[0].text));
    // Clicking a milestone should open that fight, same as a trainer card.
    let went = null;
    advTab.unmount();
    const p2 = new N('div');
    advTab.mount(p2, { S, factory: F, goTo: (id) => { went = id; } });
    p2.children[0].findAll(hasClass('ad-seg'))[0].click();
    ok('clicking a milestone opens it in the battle companion', went === 'battle', String(went));
    // ARRIVING SOMEWHERE USEFUL. Switching tabs and landing at the top of a
    // very long page is what made this feel like it had done nothing. `jump`
    // is the transient flag battle.js reads once and clears to scroll to the
    // encounter cards; `i` is the sheet's own selected-fight key.
    const enc = JSON.parse(localStorage.getItem('bb_enc') ?? '{}');
    ok('...naming the fight it should open', enc.i === 0, JSON.stringify(enc));
    // BY KEY, NOT BY INDEX. This tab holds the complete roster; the battle tab
    // has already dropped the Opelucid leader who is not in your cartridge, so
    // the two lists differ in length and an index handed across opened the
    // wrong fight for everything after Opelucid. Cheren 7 landed on Shauntal.
    ok('...as a stable key, because the two tabs hold different-length lists',
      typeof enc.key === 'string' && enc.key === OPPS[0].key, String(enc.key));
    {
      const tmpl = fs.readFileSync(path.join(ROOT, 'sheet_template.html'), 'utf8');
      ok('and the battle sheet resolves that key rather than trusting the index',
        /st\.key==='string'/.test(tmpl) && /findIndex\(e=>cKey\(e\)===st\.key\)/.test(tmpl));
    }
    ok('...and asking it to scroll to Known opponents rather than the top',
      enc.jump === 1, JSON.stringify(enc));
    // Every route into the battle tab has to carry it, or one of them lands
    // at the top and the two behave differently for no visible reason.
    const tile = p2.children[0].findAll(hasClass('ad-gymopen'))[0];
    if (tile) {
      localStorage.setItem('bb_enc', '{}');
      tile.click();
      ok('a progress tile does the same', (JSON.parse(localStorage.getItem('bb_enc')).jump) === 1);
    }
    const plan = p2.children[0].find((n) => n.tagName === 'BUTTON' && /Plan this fight/.test(n.text));
    if (plan) {
      localStorage.setItem('bb_enc', '{}');
      plan.click();
      ok('and so does "Plan this fight"', (JSON.parse(localStorage.getItem('bb_enc')).jump) === 1);
    }
    advTab.unmount();
    advTab.mount(panel, { S, factory: F });
  }

  // ---- the map folds away --------------------------------------------------
  {
    const fold = panel.children[0].find((n) => n.classList.contains('ad-fold'));
    ok('the map can be collapsed', Boolean(fold));
    ok('it starts open', panel.children[0].findAll(hasClass('ad-map')).length === 1);
    fold.click();
    ok('folding hides the map', panel.children[0].findAll(hasClass('ad-map')).length === 0);
    panel.children[0].find((n) => n.classList.contains('ad-fold')).click();
    ok('and it comes back', panel.children[0].findAll(hasClass('ad-map')).length === 1);
  }

  advTab.unmount();
  ok('unmount removes its root', panel.children.length === 0);
}

// ---- wild held items survive a CLEAN setup --------------------------------
// extract_items.py REQUIRES state/moves.json, so it must run after
// extract_personal.py -- which means on a first run extract_personal has no
// item table to name the wild held items with, and emitted {} for all 649.
// "Worth farming here" then came out empty for anyone starting clean, while
// every machine that had run setup before looked fine. build_static.py
// resolves the names from the ids now, so run order cannot matter.
{
  const sp = Object.values(S.SPECIES ?? {});
  const named = sp.filter((v) => Object.values(v.wild_held_items ?? {}).some(Boolean));
  ok('wild held items are named, not left as bare ids',
    named.length > 100, `${named.length} of ${sp.length} species carry one`);
  // Names, never ids: a number in that panel is the resolution having failed.
  const bad = named.filter((v) => Object.values(v.wild_held_items)
    .some((x) => x != null && typeof x !== 'string'));
  ok('...and every one of them is a name', bad.length === 0, `${bad.length} unresolved`);
}

console.log(failed ? `\n  ${failed} check(s) FAILED` : '\n  all checks passed');
process.exit(failed ? 1 : 0);
