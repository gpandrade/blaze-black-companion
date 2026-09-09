/**
 * tutor.js -- Slowking: the first run, and the help that stays.
 *
 * =========================================================================
 * WHY A CHARACTER AND NOT A CHECKLIST
 * =========================================================================
 * Every Pokémon game opens with a professor telling you what the world is and
 * handing you something. This app has the opposite problem to most software:
 * it is not hard to use, it is hard to KNOW ABOUT. The Pokédex's best feature
 * is reachable only by typing a move name into a box captioned for species;
 * the tab dial answers a key nobody would guess; "Suggest one" sits on a card
 * you have to have already made. Every one of those is a thing somebody has
 * to be TOLD, once, by something that is already on screen.
 *
 * So: a tour that runs once, and then the same character stays in the corner
 * with one sentence about wherever you are. Clippy's sin was interrupting; the
 * rule here is that it never speaks unless the tour is running or you click it,
 * and it can be sent away for good in one click.
 *
 * =========================================================================
 * WHY IT IS A SLOWKING
 * =========================================================================
 * This block used to argue the opposite -- that the character should be DRAWN,
 * because professors are not battle trainers and so have no portrait in the
 * NARC extract_trainers.py reads, and because a drawing can blink and point
 * and a sprite cannot. Both halves were true and the conclusion was still
 * wrong; see the drawing note below for what two hand-drawn mascots cost.
 *
 * A Slowking is the pick and the joke is the reason: it is the one Pokémon
 * that has talked like a person on screen, so a Slowking explaining the app
 * is funny in a way a stock mascot is not. It/they -- a Slowking here is a
 * character, not a specific one from anything, and needs no gender.
 */

const KEY = 'blazeblack.tutor';

export function tutorState() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { seen: false, hidden: false, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch { return { seen: false, hidden: false }; }
}
function save(patch) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...tutorState(), ...patch })); }
  catch { /* private mode: the tour simply runs again */ }
}

// ---------------------------------------------------------------- the drawing
/**
 * The mascot is the GAME'S OWN ART, and getting here took two wrong turns that were
 * the same wrong turn.
 *
 * First a smooth vector drawing, which read as a corporate illustration
 * standing next to 649 pieces of cartridge art. Then a hand-authored 24x30
 * pixel grid, which read as creepy on review -- the accent-coloured spectacle
 * frames landed as deep red rings around the eyes -- and that was right.
 *
 * `notes/pokeball.md` had already written the answer down, about the easter
 * egg's guests: *"The first Snorlax was a hand-drawn 18x16 pixel map and read
 * as a blob. THE OUTLINE IS WHAT MAKES A POKEMON RECOGNISABLE and sixteen rows
 * cannot carry it. The guests are the game's own sprites now."* A face is
 * harder than a Snorlax, not easier, and I hand-drew one anyway.
 *
 * So the mascot is a **Slowking** -- a deliberate pick, and the joke is the
 * reason: it is the one Pokemon that has talked like a person on screen. The
 * fallback,
 * for a tree with no wiki clone, is trainer sprite 51, the ROM's own
 * Scientist; there is no professor in the trainer table (Juniper never battles
 * you, so she has no battle sprite, and the overworld set is not decoded).
 * The URL is PASSED IN rather than imported, exactly as pokeball.js takes its
 * guests, so this module still depends on nothing and stays deletable in one
 * move -- swapping the mascot is one line in app.js and none here.
 *
 * WHAT THAT COSTS: a still cannot wave. An emote is a whole-pixel translation
 * of the badge -- rest, lean, hop -- and never a rotation or a scale, both of
 * which resample a pixel sprite into mush. Three honest gestures beat five
 * poses drawn by someone who cannot draw.
 */

/** The sprite, or a drawn Poké Ball when there is no art to show. */
function figure(doc, face) {
  const img = doc.createElement('img');
  img.className = 'tu-fig';
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  /* NO ART IS A REAL STATE, not a hypothetical: `./setup` extracts the
     portraits from the player's own ROM, so anyone who has not run it -- and
     every test -- has none. A broken-image glyph in the corner would be the
     same "looks bad" failure by another route, so the badge falls back to a
     Poké Ball drawn in CSS. */
  if (face) {
    img.src = face;
    img.onerror = () => { img.remove(); };
  } else {
    return null;
  }
  return img;
}

/* The five names the steps use, mapped onto the three things a still can
   actually do. Kept as five so a step still reads as prose. */
const EMOTES = ['idle', 'talk', 'point', 'think', 'cheer'];

// ---------------------------------------------------------------- the tour
/**
 * The steps.
 *
 * Each names a TAB and finds a real element to ring. A step whose target is
 * gone is skipped rather than pointed at nothing -- the app changes and a tour
 * that insists on a button that moved is worse than one that quietly moves on.
 *
 * `need` gates a step on having a save: someone opening this for the first time
 * has none, and being shown the Factory before they have anything in it teaches
 * nothing.
 */
export function steps(doc) {
  const q = (sel) => () => doc.querySelector(sel);
  const plate = (label) => () => [...doc.querySelectorAll('.sh-plate')]
    .find((b) => b.textContent.includes(label)) ?? null;
  return [
    {
      id: 'hello', emote: 'talk', tab: null, target: () => null,
      title: 'Hello. I am a Slowking.',
      body: 'This is a companion for <b>Blaze Black</b>, and it exists because the hack '
        + 'changed <b>487 abilities</b>, 138 base-stat lines and 18 typings — so every '
        + 'guide, wiki and calculator on the internet is confidently wrong about your '
        + 'game. Everything here is read out of your own cartridge instead. '
        + 'I will be sitting in the <b>bottom-left corner</b> from now on. Click me on '
        + 'any tab and I will tell you the one thing about it people miss.',
    },
    {
      id: 'save', emote: 'point', tab: null, target: q('#shell-save'),
      title: 'It reads your save file.',
      body: 'Load one and every number becomes yours — your levels, your spreads, your '
        + 'boxes. Nothing is uploaded anywhere; the file is decoded in this tab and stays '
        + 'on your machine.',
    },
    {
      id: 'dial', emote: 'point', tab: null, target: q('.sh-hub'),
      title: 'Seven tools, and a dial.',
      body: 'The plates are the tabs. This ring opens all seven at once — and it answers '
        + 'the <b>`</b> key, which you would never have guessed and which is exactly why '
        + 'I am telling you.',
    },
    {
      id: 'adventure', emote: 'talk', tab: 'adventure', need: true, target: plate('Adventure'),
      title: 'Where you are, and what is here.',
      body: 'Your position comes out of the save, so this never asks you where you got to. '
        + 'Water you cannot reach yet is <b>marked, not hidden</b> — knowing there is a '
        + 'Basculin you need Surf for beats an empty table.',
    },
    {
      id: 'battle', emote: 'point', tab: 'battle', need: true, target: plate('Battle'),
      title: 'The fight you are about to have.',
      body: 'The <b>threat board</b> is the quick read: every Pokémon they have, worst '
        + 'first, what you bring and what it does back. Below it, pick one on each side '
        + 'and <b>Your move</b> works out what is actually safe — a turn is simultaneous, '
        + 'so the honest answer is a grid, not a number.',
    },
    {
      id: 'builder', emote: 'think', tab: 'builder', need: true, target: plate('Team Builder'),
      title: 'Plan a team, then make it real.',
      body: 'Every slot has a <b>Suggest</b> button, and so does the empty card. It works '
        + 'out what your team is <i>for</i> from the slots you have filled — mono-Dark, a '
        + 'weather, nothing legendary — and only then ranks what fits, with what each one '
        + 'would cost you.',
    },
    {
      id: 'dex', emote: 'cheer', tab: 'dex', target: plate('Pokédex'),
      title: 'And the thing nobody finds.',
      body: 'The Pokédex search takes a <b>move name</b>, not just a species. Type '
        + '<b>Drain Punch</b> and it lists everything that learns it, counting TMs — which '
        + 'is most of what you actually teach. It is the one tool here that needs no save '
        + 'at all.',
    },
    {
      id: 'ball', emote: 'point', tab: null, target: q('.pb-stack'),
      title: 'One last thing.',
      body: 'There are some Poké Balls down in that corner. They do nothing useful '
        + 'whatsoever. You should press one.',
    },
  ];
}

/** One line about wherever you are, for when Slowking is clicked rather than touring. */
export const TAB_TIPS = {
  adventure: 'Species already in your Pokédex are dimmed, so what is <b>new</b> on a route '
    + 'stands out. Field items keep their vanilla name too — the map you remember still '
    + 'marks the spot.',
  battle: 'The threat board reads worst-first. For one exact turn, pick a Pokémon on each '
    + 'side under <b>Your move</b> — and try <b>2 turns</b>, which is the only setting under '
    + 'which switching can ever look right.',
  builder: 'Press <b>Suggest</b> on any slot. The chips at the top are what I think your '
    + 'team is <i>for</i> — click one to tell me I am wrong.',
  factory: 'Everything you do here is a working copy. Nothing touches your save until you '
    + 'press Install, and that backs the file up first and tells you what it called it.',
  items: 'A TM row says how many of your Pokémon can actually learn it, so "you have TM25" '
    + 'becomes "TM25, which only Ampharos can use".',
  dex: 'Type a <b>move</b> into the search, not just a species. It counts TMs as well as '
    + 'level-up, which is most of what you really teach.',
  run: 'A nuzlocke rule here is a real switch, not a promise: turning one on closes the '
    + 'buttons it names, wherever they are.',
};

// ---------------------------------------------------------------- mounting
/**
 * Put Slowking in the corner. Returns the handle the shell keeps.
 *
 * Bottom LEFT, deliberately: the Poké Balls are bottom right and a mascot
 * standing on the easter egg would be the first bug reported.
 */
export function mountTutor(doc, { onNav = () => {}, activeTab = () => null, face = null } = {}) {
  const root = doc.createElement('div');
  root.className = 'tu-root';

  const me = doc.createElement('button');
  me.className = 'tu-me';
  me.type = 'button';
  me.setAttribute('aria-label', 'Slowking — help');
  const fig = figure(doc, face);
  if (fig) me.append(fig);
  else me.classList.add('tu-noface');   // the CSS draws a Poké Ball instead

  const bubble = doc.createElement('div');
  bubble.className = 'tu-bubble';
  bubble.hidden = true;
  bubble.setAttribute('role', 'dialog');
  bubble.setAttribute('aria-label', 'Slowking');

  const spot = doc.createElement('div');
  spot.className = 'tu-spot';
  spot.hidden = true;

  /* Slowking first, then the bubble: the speech has to come OUT of the character.
     With the bubble first, opening it shoved Slowking bodily across the screen. */
  root.append(spot, me, bubble);

  let tour = null;          // {list, i} while the tour is running

  /* An emote is a CLASS on the badge and a whole-pixel translation in the CSS.
     The sprite is a bitmap: rotating or scaling it resamples it into mush, and
     redrawing it is not on offer -- it is the cartridge's own art, not a grid
     this file owns. Three gestures, honestly. */
  const setEmote = (e) => {
    const on = EMOTES.includes(e) ? e : 'idle';
    for (const x of EMOTES) me.classList.toggle(`tu-${x}`, x === on);
  };
  setEmote('idle');

  const calm = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

  const el = (tag, cls, html) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

  function ring(target) {
    if (!target || !target.getBoundingClientRect) { spot.hidden = true; return; }
    const r = target.getBoundingClientRect();
    if (!r.width && !r.height) { spot.hidden = true; return; }
    spot.hidden = false;
    spot.style.left = `${r.left - 6}px`;
    spot.style.top = `${r.top - 6}px`;
    spot.style.width = `${r.width + 12}px`;
    spot.style.height = `${r.height + 12}px`;
  }

  /* ---------------------------------------------------------------- placing
     PUT HAZEL NEXT TO WHAT IS BEING POINTED AT.
     The first tour parked the pair in the bottom-left corner and rang an
     element anywhere on screen, so you read a sentence in one place and then
     went hunting for the thing it described in another -- with the dimmed page
     in between. The bubble travels to the target now, and picks the first side
     of it that both fits on screen and does not cover the ring itself. */
  let boxW = 0;
  let boxH = 0;
  function measure() {
    const b = root.getBoundingClientRect?.();
    if (b && (b.width || b.height)) { boxW = b.width; boxH = b.height; }
  }
  function place(r) {
    const win = doc.defaultView;
    if (!r || !win || !boxW) return;
    const PAD = 12;
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    const mid = r.left + r.width / 2 - boxW / 2;
    // Below, above, right, left -- in that order of preference.
    const tries = [[mid, r.bottom + PAD], [mid, r.top - PAD - boxH],
      [r.right + PAD, r.top], [r.left - PAD - boxW, r.top]];
    let best = null;
    for (const [x0, y0] of tries) {
      const x = Math.max(PAD, Math.min(vw - boxW - PAD, x0));
      const y = Math.max(PAD, Math.min(vh - boxH - PAD, y0));
      // How much of the ringed element this position would cover.
      const over = Math.max(0, Math.min(x + boxW, r.right) - Math.max(x, r.left))
        * Math.max(0, Math.min(y + boxH, r.bottom) - Math.max(y, r.top));
      if (!over) { best = [x, y]; break; }
      if (!best || over < best[2]) best = [x, y, over];
    }
    root.classList.add('tu-anchored');
    root.style.left = `${Math.round(best[0])}px`;
    root.style.top = `${Math.round(best[1])}px`;
  }
  function unplace() {
    root.classList.remove('tu-anchored');
    root.style.left = '';
    root.style.top = '';
  }

  function close() {
    unplace();
    bubble.hidden = true;
    spot.hidden = true;
    bubble.replaceChildren();
    tour = null;
    setEmote('idle');
    root.classList.remove('tu-touring');
  }

  /** Draw the bubble. `actions` is [[label, cls, fn], …]. */
  function say(title, body, actions, emote = 'talk') {
    setEmote(emote);
    bubble.replaceChildren();
    bubble.hidden = false;
    if (title) bubble.append(el('h4', 'tu-title', title));
    bubble.append(el('p', 'tu-text', body));
    const row = el('div', 'tu-acts');
    for (const [label, cls, fn] of actions) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = `tu-btn${cls ? ` ${cls}` : ''}`;
      b.textContent = label;
      b.onclick = fn;
      row.append(b);
    }
    bubble.append(row);
    measure();
  }

  function show(i) {
    const list = tour.list;
    if (i >= list.length) {
      save({ seen: true });
      unplace();
      say('That is everything.',
        'I will be down here if you want me. Click me on any tab and I will tell you the '
        + 'one thing about it people miss.',
        [['Back', '', () => show(list.length - 1)], ['Thanks', 'go', close]], 'cheer');
      root.classList.remove('tu-touring');
      return;
    }
    tour.i = i;
    const s = list[i];
    const go = () => {
      const t = s.target?.();
      t?.scrollIntoView?.({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
      ring(t);
      /* BACK, because the tour is read at reading speed and Next is one
         click away from a step you had not finished. It is offered on the end
         card too -- that is exactly where you notice you went one too far. */
      say(s.title, s.body, [
        ['Skip the tour', '', () => { save({ seen: true }); close(); }],
        ...(i > 0 ? [['Back', '', () => show(i - 1)]] : []),
        [i === list.length - 1 ? 'Done' : 'Next', 'go', () => show(i + 1)],
      ], s.emote);
      // say() measured the bubble; only now is there a box to position.
      if (spot.hidden) unplace(); else place(t.getBoundingClientRect());
    };
    if (s.tab && s.tab !== activeTab()) { onNav(s.tab); setTimeout(go, 220); } else go();
  }

  function start() {
    const all = steps(doc);
    const hasSave = !!doc.querySelector('.sh-dot.ok');
    // A step that needs a save is dropped rather than shown broken.
    tour = { list: all.filter((s) => !s.need || hasSave), i: 0 };
    root.classList.add('tu-touring');
    show(0);
  }

  /** The click-me help: one line about this tab, and the way back to the tour. */
  function helpHere() {
    unplace();
    const tab = activeTab();
    const tip = TAB_TIPS[tab] ?? 'Pick a tab and I will tell you what it is for.';
    say('Slowking', tip, [
      ['Show me around', '', () => { close(); start(); }],
      ['Hide me', '', () => { save({ hidden: true }); root.remove(); }],
      ['Close', 'go', close],
    ], 'talk');
  }

  me.onclick = () => (bubble.hidden ? helpHere() : close());
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !bubble.hidden) close();
  });
  // The ring is anchored to a live element, so it has to follow the page.
  /* The ring is anchored to a live element, so both it and the bubble have to
     follow the page -- a smooth scrollIntoView is still moving when show()
     returns, and the pair would otherwise land where the target used to be. */
  const reflow = () => {
    if (!tour || spot.hidden) return;
    const t = tour.list[tour.i]?.target?.();
    ring(t);
    if (!spot.hidden) place(t.getBoundingClientRect());
  };
  doc.defaultView?.addEventListener('resize', reflow);
  doc.defaultView?.addEventListener('scroll', reflow, true);

  doc.body.append(root);
  return { start, close, say, helpHere, root, el: me };
}
