/**
 * pokeball.js -- the easter egg.
 *
 * Four balls stacked in the corner. Each opens differently and lets something
 * different out. None of it is useful and none of it is supposed to be: it
 * exists to make someone laugh the first time they find it, and later to be
 * the thing a first-run tutorial nudges you into pressing.
 *
 *   Poké Ball    aurora  -- the neon triad, five emission flavours  + a school of fish
 *   Great Ball   ripple  -- cyan, concentric rings, water-like      + Snorlax, bouncing
 *   Ultra Ball   mandala -- gold, eight-fold mirrored, heavy spin   + Gengar, phasing
 *   Master Ball  spiral  -- violet, a logarithmic spiral of streaks + Mewtwo and Mew
 *
 * =========================================================================
 * THE GUESTS ARE THE REAL SPRITES, MASKED AND HUE-CYCLED
 * =========================================================================
 * The first Snorlax was a hand-drawn 18x16 pixel map and read as a blob --
 * the outline is what makes a Pokémon recognisable and sixteen rows cannot
 * carry it. These are the game's own sprites, scaled up with
 * `image-rendering: pixelated` so they stay chunky, under an animated
 * hue-rotate.
 *
 * NOTE ON HUE-ROTATE. There is a standing rule against it: shininess must not
 * be faked with a filter, because that invents colours the game does not use
 * and the Factory would be *claiming* something false about your Pokémon.
 * That rule is about data integrity. Nothing here claims anything -- a
 * strobing rainbow Gengar bouncing off a wall is not going to be mistaken for
 * a shiny -- so the filter is fine in exactly this one place.
 *
 * Sprite URLs are PASSED IN, not imported, so this file still depends on
 * nothing and deleting it plus its two call sites removes the whole thing.
 *
 * =========================================================================
 * RULES IT PLAYS BY, BECAUSE A TOY MUST NOT COST THE APP ANYTHING
 * =========================================================================
 *   - The burst layer is `position: fixed; inset: 0` and therefore MUST be
 *     `pointer-events: none`. A full-area layer taking clicks has broken this
 *     app twice; verify_pokeball.mjs asserts it by name.
 *   - It imports nothing and reads no save data.
 *   - Every particle removes itself when its animation finishes, so nothing
 *     accumulates however many times you press.
 *   - Anything driven by requestAnimationFrame has to TERMINATE. An unbounded
 *     rAF loop is a pinned CPU core for as long as the tab is open, so the
 *     physics is a pure function that is tested to come to rest.
 *   - `prefers-reduced-motion` gets a short, calm bloom and no guests.
 */

const PATTERNS = ['asanoha', 'seigaiha', 'sayagata', 'kikko'];
const FLAVOURS = ['bloom', 'spiral', 'fountain', 'kaleido', 'vortex'];

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const chance = (p) => Math.random() < p;

/** The neon triad plus two on-theme extras, read live so it follows the theme. */
function palette() {
  const cs = getComputedStyle(document.documentElement);
  const tok = (n, f) => (cs.getPropertyValue(n).trim() || f);
  return [tok('--neon-1', '#FF8552'), tok('--neon-2', '#5FD3BC'), tok('--neon-3', '#A6A3F5'),
    tok('--ember', '#FF8552'), tok('--pat-ink', '#9FD7FF')];
}

/** A band of a single hue, for the balls that have a colour of their own. */
const band = (h, spread) => Array.from({ length: 5 },
  () => `hsl(${Math.round(h + rand(-spread, spread))} ${Math.round(rand(70, 96))}% ${Math.round(rand(52, 70))}%)`);

/**
 * THE FOUR BURSTS. Each ball has to look like itself, so a style fixes the
 * palette, the emission flavours, how many rings it throws and how hard the
 * shards spin. Everything else stays randomised inside those bounds.
 */
const STYLES = {
  aurora:  { colours: palette,                    flavours: FLAVOURS,          n: [90, 170],  waves: [2, 5],   size: [90, 260], spin: [180, 1400], rings: 0.26 },
  ripple:  { colours: () => band(198, 26),        flavours: ['bloom'],         n: [50, 90],   waves: [8, 14],  size: [70, 190], spin: [60, 320],   rings: 0.62 },
  mandala: { colours: () => band(44, 18),         flavours: ['kaleido'],       n: [130, 210], waves: [1, 3],   size: [80, 230], spin: [700, 2000], rings: 0.16, mirror: 8 },
  spiral:  { colours: () => band(295, 34),        flavours: ['spiral', 'vortex'], n: [110, 190], waves: [2, 4], size: [60, 300], spin: [300, 1100], rings: 0.2, streak: true },
};

function isDark() {
  const set = document.documentElement.getAttribute('data-theme');
  if (set === 'dark') return true;
  if (set === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

function originOf(btn) {
  const r = btn.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// --------------------------------------------------------------- particles
function shard(layer, o, colours, opts) {
  const el = document.createElement('i');
  el.className = 'pb-bit';
  const size = rand(opts.minSize, opts.maxSize);
  const kind = Math.random();
  const c = pick(colours);
  el.style.filter = `drop-shadow(0 0 ${rand(4, 14).toFixed(1)}px ${c})`;

  if (kind < opts.ringP) {
    el.style.border = `${rand(2, 5).toFixed(1)}px solid ${c}`;
    el.style.borderRadius = '50%';
  } else if (kind < opts.ringP + 0.42) {
    const pat = pick(PATTERNS);
    const zoom = rand(1.4, 3.6).toFixed(2);
    el.style.webkitMaskImage = `var(--pat-${pat})`;
    el.style.maskImage = `var(--pat-${pat})`;
    el.style.webkitMaskSize = `calc(var(--pat-${pat}-size) * ${zoom})`;
    el.style.maskSize = `calc(var(--pat-${pat}-size) * ${zoom})`;
    el.style.background = c;
    el.style.borderRadius = chance(0.5) ? '50%' : `${rand(2, 14)}px`;
  } else {
    el.style.background = c;
    el.style.clipPath = pick([
      'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)',
      'polygon(50% 0%, 100% 100%, 0% 100%)',
      'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
    ]);
    el.style.opacity = String(rand(0.55, 0.9));
  }

  // A streak is the same shard stretched along its own direction of travel.
  const w = opts.streak ? size * rand(1.6, 3.4) : size;
  el.style.width = `${w}px`;
  el.style.height = `${size}px`;
  el.style.left = `${o.x}px`;
  el.style.top = `${o.y}px`;
  layer.append(el);

  const spin = rand(-opts.spin, opts.spin);
  const dur = rand(opts.minDur, opts.maxDur);
  const anim = el.animate([
    { transform: 'translate(-50%,-50%) rotate(0deg) scale(.2)', opacity: 0 },
    { transform: `translate(calc(-50% + ${opts.dx * 0.35}px), calc(-50% + ${opts.dy * 0.35}px))`
        + ` rotate(${spin * 0.35}deg) scale(1)`, opacity: opts.peak, offset: 0.25 },
    { transform: `translate(calc(-50% + ${opts.dx}px), calc(-50% + ${opts.dy}px))`
        + ` rotate(${spin}deg) scale(${rand(0.3, 1.1).toFixed(2)})`, opacity: 0 },
  ], { duration: dur, easing: opts.easing, fill: 'forwards' });
  anim.onfinish = () => el.remove();
  anim.oncancel = () => el.remove();
}

function shockwave(layer, o, colour, diag = 900) {
  const el = document.createElement('i');
  el.className = 'pb-bit pb-wave';
  el.style.left = `${o.x}px`;
  el.style.top = `${o.y}px`;
  el.style.border = `${rand(2, 5).toFixed(1)}px solid ${colour}`;
  layer.append(el);
  const to = diag * rand(0.9, 1.7);
  const a = el.animate([
    { width: '8px', height: '8px', opacity: .9 },
    { width: `${to}px`, height: `${to}px`, opacity: 0 },
  ], { duration: rand(900, 1700), easing: 'cubic-bezier(.15,.7,.3,1)', fill: 'forwards' });
  a.onfinish = () => el.remove();
}

function flash(layer, colour) {
  const el = document.createElement('i');
  el.className = 'pb-bit pb-flash';
  el.style.background = colour;
  layer.append(el);
  const a = el.animate([{ opacity: 0 }, { opacity: .5, offset: .08 }, { opacity: 0 }],
    { duration: 620, easing: 'ease-out', fill: 'forwards' });
  a.onfinish = () => el.remove();
}

// ----------------------------------------------------------------- flavours
function vector(flavour, i, n, spread, mirror = 0) {
  const t = i / n;
  switch (flavour) {
    case 'spiral': {
      const a = t * Math.PI * rand(4, 8);
      const r = spread * (0.25 + t * 0.85);
      return [Math.cos(a) * r, Math.sin(a) * r];
    }
    case 'fountain': {
      const a = -Math.PI / 2 + rand(-0.7, 0.7);
      const r = spread * rand(0.5, 1.1);
      return [Math.cos(a) * r, Math.sin(a) * r + spread * 0.45];
    }
    case 'kaleido': {
      const arms = mirror || 6;
      const a = (Math.floor(t * arms) / arms) * Math.PI * 2 + rand(-0.1, 0.1);
      const r = spread * rand(0.35, 1.1);
      return [Math.cos(a) * r, Math.sin(a) * r];
    }
    case 'vortex': {
      const a = t * Math.PI * 2 + rand(-0.3, 0.3);
      const r = spread * rand(0.8, 1.15);
      return [Math.cos(a) * r * 1.35, Math.sin(a) * r * 0.55];
    }
    default: {
      const a = t * Math.PI * 2 + rand(-0.25, 0.25);
      const r = spread * rand(0.4, 1.15);
      return [Math.cos(a) * r, Math.sin(a) * r];
    }
  }
}

/** Scaled to the VIEWPORT, so it fills whatever window it is in. */
function burst(layer, o, styleName) {
  const st = STYLES[styleName] ?? STYLES.aurora;
  const colours = st.colours();
  const calm = reduced();
  const flavour = calm ? 'bloom' : pick(st.flavours);
  const vw = window.innerWidth || 1200;
  const vh = window.innerHeight || 800;
  const diag = Math.hypot(vw, vh);

  const n = calm ? 10 : Math.round(rand(st.n[0], st.n[1]));
  const spread = calm ? 90 : diag * rand(0.55, 0.95);

  layer.style.mixBlendMode = isDark() ? 'screen' : 'multiply';
  if (!calm) {
    flash(layer, pick(colours));
    const waves = Math.round(rand(st.waves[0], st.waves[1]));
    for (let i = 0; i < waves; i++) {
      setTimeout(() => shockwave(layer, o, pick(colours), diag), i * rand(70, 170));
    }
  }

  for (let i = 0; i < n; i++) {
    const [dx, dy] = vector(flavour, i, n, spread, st.mirror);
    shard(layer, o, colours, {
      dx, dy,
      minSize: calm ? 14 : rand(16, 40),
      maxSize: calm ? 34 : rand(st.size[0], st.size[1]),
      spin: calm ? 40 : rand(st.spin[0], st.spin[1]),
      minDur: calm ? 500 : rand(900, 1300),
      maxDur: calm ? 900 : rand(1900, 3200),
      peak: rand(0.75, 1),
      ringP: st.rings,
      streak: Boolean(st.streak),
      easing: pick(['cubic-bezier(.12,.7,.25,1)', 'cubic-bezier(.2,.9,.3,1)',
        'cubic-bezier(.08,.85,.2,1)', 'ease-out']),
    });
  }
  return flavour;
}

// ==================================================================== guests
/** A guest is the game's own sprite, scaled up and hue-cycled. */
function sprite(layer, url, px, cls = '') {
  const el = document.createElement('i');
  el.className = `pb-mon ${cls}`.trim();
  el.style.width = `${px}px`;
  el.style.height = `${px}px`;
  el.style.backgroundImage = `url("${url}")`;
  el.style.animationDuration = `${rand(1.1, 2.6).toFixed(2)}s`;
  el.style.animationDelay = `${(-rand(0, 3)).toFixed(2)}s`;
  layer.append(el);
  return el;
}

const done = (el) => (a) => { a.onfinish = () => el.remove(); a.oncancel = () => el.remove(); return a; };

// ------------------------------------------------------------------ fish
const FISH = [
  '.....xxxx.......', '...xxxxxxxx...x.', '..xxxxxxxxxx.xx.', '.xxxxxxxxxxxxxx.',
  'xxoxxxxxxxxxxxxx', 'xxoxxxxxxxxxxxxx', '.xxxxxxxxxxxxxx.', '..xxxxxxxxxx.xx.',
  '...xxxxxxxx...x.', '.....xxxx.......',
];
let FISH_SVG = null;
function fishSvg() {
  if (FISH_SVG) return FISH_SVG;
  const w = FISH[0].length, h = FISH.length;
  let cells = '';
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = FISH[y][x];
    if (c === '.') continue;
    cells += `<rect x="${x}" y="${y}" width="1" height="1" fill="${c === 'o' ? 'var(--pb-line)' : 'currentColor'}"/>`;
  }
  FISH_SVG = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${cells}</svg>`;
  return FISH_SVG;
}

const FISH_CHANCE = 1;          // the Poké Ball always brings them
const SCHOOL_MIN = 3, SCHOOL_CAP = 48;

/** Heavy-tailed: median about six, one in a hundred fills the screen. */
function schoolSize() {
  const u = Math.random();
  return Math.min(SCHOOL_CAP, Math.max(SCHOOL_MIN, Math.ceil(SCHOOL_MIN * Math.pow(1 - u, -0.75))));
}

/**
 * One fish.
 *
 * It is a MAGIKARP when the sprite is available -- which is the whole joke,
 * and the same trick the other guests use: the game's own art, scaled up
 * pixelated and hue-cycled, because an outline is what makes it recognisable.
 * The hand-drawn 16x10 map stays as the fallback for a build whose
 * static.json does not carry the name.
 */
function fish(layer, i = 0, of = 1, url = null) {
  const vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
  const crowd = Math.min(1, 6 / Math.max(6, of));
  const w = (url ? 150 : 132) * rand(0.7, 1.5) * (0.45 + 0.55 * crowd);
  let el;
  if (url) {
    el = sprite(layer, url, w, 'pb-karp');
    el.style.height = `${w}px`;
  } else {
    el = document.createElement('i');
    el.className = 'pb-fish';
    el.innerHTML = fishSvg();
    el.style.width = `${w}px`;
    el.style.height = `${w * (FISH.length / FISH[0].length)}px`;
    el.style.animationDuration = `${rand(1.1, 2.6).toFixed(2)}s`;
    el.style.animationDelay = `${(-rand(0, 3)).toFixed(2)}s`;
    layer.append(el);
  }

  const legs = Math.round(rand(2, 5));
  // The hand-drawn fish faces left and the Magikarp sprite faces right, so
  // "which way is forwards" differs between them.
  const forward = url ? -1 : 1;
  let facing = (chance(0.5) ? 1 : -1) * forward;
  const frames = [];
  let y = rand(vh * 0.12, vh * 0.85);
  let x = facing > 0 ? -w - 40 : vw + 40;
  const TURN = 0.02;
  frames.push({ transform: `translate(${x}px, ${y}px) scaleX(${facing})`, offset: 0 });
  for (let k = 1; k <= legs; k++) {
    x = facing > 0 ? vw + 40 : -w - 40;
    y = Math.max(10, Math.min(vh - 60, y + rand(-vh * 0.3, vh * 0.3)));
    const at = k / legs;
    frames.push({ transform: `translate(${x}px, ${y}px) scaleX(${facing})`, offset: at });
    if (k < legs) {
      facing = -facing;
      frames.push({ transform: `translate(${x}px, ${y}px) scaleX(${facing})`, offset: Math.min(1, at + TURN) });
    }
  }
  done(el)(el.animate(frames, { duration: rand(900, 1700) * legs, delay: i * rand(60, 220), easing: 'linear', fill: 'forwards' }));
}
function school(layer, n, url = null) { for (let i = 0; i < n; i++) fish(layer, i, n, url); }

// --------------------------------------------------------------- snorlax
const GRAVITY = 0.62;
const BOUNCE = 0.93;      // he is SUPPOSED to keep crossing the screen
const WALL = 0.99;

/**
 * One frame. PURE, so the physics can be checked without a browser: that it
 * settles rather than running forever, that each bounce is smaller, and that
 * he never leaves the screen.
 */
function stepBounce(st, b) {
  const n = { ...st, hits: [] };
  n.vy += GRAVITY;
  n.x += n.vx; n.y += n.vy;
  n.spin += n.vx * 0.5;

  if (n.x <= 0) { n.x = 0; n.vx = Math.abs(n.vx) * WALL; n.hits.push({ x: 0, y: n.y + b.h / 2, nx: 1, ny: 0 }); }
  else if (n.x + b.w >= b.vw) { n.x = b.vw - b.w; n.vx = -Math.abs(n.vx) * WALL; n.hits.push({ x: b.vw, y: n.y + b.h / 2, nx: -1, ny: 0 }); }

  if (n.y <= 0 && n.vy < 0) { n.y = 0; n.vy = Math.abs(n.vy) * BOUNCE; n.hits.push({ x: n.x + b.w / 2, y: 0, nx: 0, ny: 1 }); }

  if (n.y + b.h >= b.vh) {
    n.y = b.vh - b.h;
    if (Math.abs(n.vy) > 2.6) { n.vy = -Math.abs(n.vy) * BOUNCE; n.hits.push({ x: n.x + b.w / 2, y: b.vh, nx: 0, ny: -1 }); }
    else { n.vy = 0; n.vx *= 0.86; n.resting = Math.abs(n.vx) < 0.5; }
  }
  return n;
}

function dust(layer, at, colours) {
  const n = Math.round(rand(10, 22));
  for (let i = 0; i < n; i++) {
    const a = rand(-1.1, 1.1), speed = rand(60, 230);
    shard(layer, { x: at.x, y: at.y }, colours, {
      dx: (at.nx * Math.cos(a) - at.ny * Math.sin(a)) * speed,
      dy: (at.ny * Math.cos(a) + at.nx * Math.sin(a)) * speed,
      minSize: rand(10, 22), maxSize: rand(34, 90),
      spin: rand(90, 500), minDur: rand(380, 520), maxDur: rand(700, 1200),
      peak: rand(0.5, 0.9), ringP: 0.2, streak: false,
      easing: 'cubic-bezier(.1,.75,.25,1)',
    });
  }
}

/**
 * How many Snorlax. Mostly two or three; every so often the screen fills.
 * Same shape of joke as the school, a much smaller cap -- each one is a rAF
 * loop of its own and eight is already ridiculous.
 */
const LAX_CAP = 8;
function laxCount() {
  const u = Math.random();
  return Math.min(LAX_CAP, Math.max(2, Math.ceil(1.7 * Math.pow(1 - u, -0.4))));
}
function snorlaxes(layer, url, n = laxCount()) {
  for (let i = 0; i < n; i++) setTimeout(() => snorlax(layer, url), i * rand(90, 260));
  return n;
}

function snorlax(layer, url) {
  const raf = globalThis.requestAnimationFrame;
  const vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
  const colours = palette();
  // BIG. The first one was small enough that the silhouette carried nothing,
  // and the silhouette is the entire reason you know it is a Snorlax.
  const px = Math.min(340, Math.max(190, Math.min(vw, vh) * rand(0.28, 0.42)));
  const el = sprite(layer, url, px, 'pb-lax');

  let st = { x: rand(0, Math.max(1, vw - px)), y: -px - 20, vx: rand(-17, 17), vy: rand(2, 6), spin: 0, resting: false };
  const bounds = { vw, vh, w: px, h: px };
  const until = Date.now() + rand(6000, 9500);
  const draw = () => {
    el.style.transform = `translate(${st.x.toFixed(1)}px, ${st.y.toFixed(1)}px) rotate(${(st.spin * 0.2).toFixed(1)}deg)`;
  };
  // Place him before the first frame; until draw() runs he sits wherever the
  // stylesheet put him.
  draw();
  if (!raf) { el.remove(); return; }
  const tick = () => {
    st = stepBounce(st, bounds);
    for (const hit of st.hits) dust(layer, hit, colours);
    draw();
    if (Date.now() < until && !st.resting) { raf(tick); return; }
    done(el)(el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 500, easing: 'ease-in', fill: 'forwards' }));
  };
  raf(tick);
}

// ---------------------------------------------------------------- gengar
/**
 * A ghost should behave like one: Gengar fades in somewhere, throws a couple
 * of after-images that drift off, and sinks away again. Six or seven times,
 * all over the screen.
 */
function gengar(layer, url) {
  const vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
  const colours = band(285, 40);
  const appearances = Math.round(rand(5, 8));
  for (let k = 0; k < appearances; k++) {
    const px = rand(130, 260);
    const x = rand(20, Math.max(21, vw - px - 20));
    const y = rand(20, Math.max(21, vh - px - 20));
    const delay = k * rand(230, 430);

    const el = sprite(layer, url, px, 'pb-ghost');
    el.style.transform = `translate(${x}px, ${y}px)`;
    done(el)(el.animate([
      { opacity: 0, transform: `translate(${x}px, ${y + 40}px) scale(.7)` },
      { opacity: .95, transform: `translate(${x}px, ${y}px) scale(1)`, offset: .35 },
      { opacity: .95, transform: `translate(${x}px, ${y}px) scale(1)`, offset: .7 },
      { opacity: 0, transform: `translate(${x}px, ${y - 50}px) scale(1.25)` },
    ], { duration: rand(900, 1500), delay, easing: 'ease-in-out', fill: 'forwards' }));

    // after-images, drifting away from where he stood
    for (let i = 0; i < 3; i++) {
      const g = sprite(layer, url, px, 'pb-ghost pb-echo');
      const dx = rand(-110, 110), dy = rand(-80, 80);
      done(g)(g.animate([
        { opacity: .5, transform: `translate(${x}px, ${y}px) scale(1)` },
        { opacity: 0, transform: `translate(${x + dx}px, ${y + dy}px) scale(${rand(1.2, 1.8).toFixed(2)})` },
      ], { duration: rand(700, 1200), delay: delay + 180 + i * 90, easing: 'ease-out', fill: 'forwards' }));
    }
    setTimeout(() => shockwave(layer, { x: x + px / 2, y: y + px / 2 }, pick(colours), 420), delay + 300);
  }
}

// ------------------------------------------------------------ mewtwo + mew
/**
 * The Master Ball gets the pair the whole plot is about. Mew zips around and
 * teleports -- vanishing and reappearing somewhere else with a ring, rather
 * than travelling there -- and Mewtwo arrives once, in the middle, with a
 * psychic pulse.
 */
function mewduo(layer, mewUrl, mewtwoUrl) {
  const vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
  const colours = band(295, 40);

  if (mewUrl) {
    const hops = Math.round(rand(6, 10));
    for (let k = 0; k < hops; k++) {
      const px = rand(90, 150);
      const x = rand(20, Math.max(21, vw - px - 20));
      const y = rand(20, Math.max(21, vh - px - 20));
      const delay = k * rand(260, 420);
      const el = sprite(layer, mewUrl, px, 'pb-mew');
      const drift = rand(-70, 70);
      done(el)(el.animate([
        { opacity: 0, transform: `translate(${x}px, ${y}px) scale(.2)` },
        { opacity: 1, transform: `translate(${x + drift * 0.3}px, ${y - 18}px) scale(1)`, offset: .25 },
        { opacity: 1, transform: `translate(${x + drift}px, ${y + 14}px) scale(1)`, offset: .72 },
        { opacity: 0, transform: `translate(${x + drift * 1.2}px, ${y}px) scale(.2)` },
      ], { duration: rand(700, 1100), delay, easing: 'ease-in-out', fill: 'forwards' }));
      setTimeout(() => shockwave(layer, { x: x + px / 2, y: y + px / 2 }, pick(colours), 300), delay);
    }
  }

  if (mewtwoUrl) {
    const px = Math.min(420, Math.max(240, Math.min(vw, vh) * 0.42));
    const x = (vw - px) / 2, y = (vh - px) / 2;
    const el = sprite(layer, mewtwoUrl, px, 'pb-mewtwo');
    const delay = rand(600, 1100);
    done(el)(el.animate([
      { opacity: 0, transform: `translate(${x}px, ${y + 60}px) scale(.6)` },
      { opacity: 1, transform: `translate(${x}px, ${y}px) scale(1)`, offset: .3 },
      { opacity: 1, transform: `translate(${x}px, ${y}px) scale(1.04)`, offset: .72 },
      { opacity: 0, transform: `translate(${x}px, ${y - 30}px) scale(1.3)` },
    ], { duration: rand(1600, 2300), delay, easing: 'ease-out', fill: 'forwards' }));
    // the pulse
    const o = { x: vw / 2, y: vh / 2 };
    for (let i = 0; i < 4; i++) {
      setTimeout(() => shockwave(layer, o, pick(colours), Math.hypot(vw, vh)), delay + 420 + i * 150);
    }
  }
}

// ===================================================================== balls
/** Top-half fill and a decoration, which is the whole difference between them. */
const ballSvg = (top, deco = '') => `
<svg viewBox="0 0 40 40" aria-hidden="true">
  <g class="pb-top">
    <path d="M2 20a18 18 0 0 1 36 0Z" fill="${top}"/>
    <path d="M2 20a18 18 0 0 1 36 0" fill="none" stroke="var(--pb-line)" stroke-width="2"/>
    ${deco}
  </g>
  <g class="pb-bot">
    <path d="M38 20a18 18 0 0 1-36 0Z" fill="var(--pb-white)"/>
    <path d="M38 20a18 18 0 0 1-36 0" fill="none" stroke="var(--pb-line)" stroke-width="2"/>
  </g>
  <rect x="2" y="18" width="36" height="4" fill="var(--pb-line)"/>
  <circle cx="20" cy="20" r="6" fill="var(--pb-white)" stroke="var(--pb-line)" stroke-width="2"/>
  <circle cx="20" cy="20" r="2.6" class="pb-core" fill="${top}"/>
</svg>`;

const BALLS = [
  { id: 'master', name: 'Master Ball', style: 'spiral', guest: 'mewduo',
    key: 'ArrowUp', keycap: '↑', say: 'Absolutely not',
    top: 'var(--pb-master)',
    deco: '<path d="M9 12h4l-2 4Z" fill="var(--pb-white)"/><circle cx="27" cy="11" r="2.4" fill="var(--pb-pink)"/><circle cx="32" cy="14" r="1.8" fill="var(--pb-pink)"/>' },
  { id: 'ultra', name: 'Ultra Ball', style: 'mandala', guest: 'gengar',
    key: 'ArrowRight', keycap: '→', say: 'Seriously, no',
    top: 'var(--pb-ultra)',
    deco: '<path d="M13 7v8M27 7v8M13 11h14" stroke="var(--pb-gold)" stroke-width="3" fill="none"/>' },
  { id: 'great', name: 'Great Ball', style: 'ripple', guest: 'snorlax',
    key: 'ArrowLeft', keycap: '←', say: 'Definitely do not press this',
    top: 'var(--pb-great)',
    deco: '<path d="M6 15q6-9 14-9t14 9" stroke="var(--pb-red)" stroke-width="2.6" fill="none"/>' },
  { id: 'poke', name: 'Poké Ball', style: 'aurora', guest: 'fish',
    key: 'ArrowDown', keycap: '↓', say: 'Do not press this',
    top: 'var(--pb-red)', deco: '' },
];

/**
 * Mount the stack. Returns a teardown so a test can mount and unmount cleanly.
 * Everything lives on document.body: it is chrome, not part of any tab, and
 * tabs unmount whenever you switch.
 *
 * `sprites` is a plain { name: url } map, PASSED IN rather than imported, so
 * this file still depends on nothing.
 */
/**
 * OFF IS A REAL STATE, AND IT HAS TO BE.
 *
 * The arrow keys are the fun part and also the risk: someone scrolling a long
 * box list with the keyboard does not want a Snorlax every time. So the whole
 * thing collapses to a single faint ball, the key listener stands down with
 * it, and the choice is remembered.
 *
 * It collapses rather than disappearing, because hiding something with no
 * route back is just losing it -- the same reason the map editor's calibration
 * strip was never allowed to vanish outright.
 */
const ON_KEY = 'blazeblack.balls';
function ballsOn() {
  try { return localStorage.getItem(ON_KEY) !== 'off'; } catch { return true; }
}
function setBallsOn(v) {
  try { localStorage.setItem(ON_KEY, v ? 'on' : 'off'); } catch { /* private mode */ }
}

export function mountPokeball(doc = document, { sprites = {} } = {}) {
  const layer = doc.createElement('div');
  layer.className = 'pb-layer';
  layer.setAttribute('aria-hidden', 'true');

  const stack = doc.createElement('div');
  stack.className = 'pb-stack';

  const timers = [];
  const byKey = new Map();
  let on = ballsOn();

  const toggle = doc.createElement('button');
  toggle.className = 'pb-toggle';
  toggle.type = 'button';
  const paint = () => {
    stack.className = `pb-stack${on ? '' : ' off'}`;
    toggle.textContent = on ? '×' : '●';
    toggle.title = on
      ? 'Put the balls away (the arrow keys stop firing them)'
      : 'Bring the balls back';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.setAttribute('aria-pressed', String(!on));
  };
  toggle.onclick = () => { on = !on; setBallsOn(on); paint(); };

  for (const b of BALLS) {
    const row = doc.createElement('div');
    row.className = 'pb-row';

    const btn = doc.createElement('button');
    btn.className = `pb-ball pb-${b.id}`;
    btn.type = 'button';
    btn.title = `${b.say}  (${b.keycap})`;
    btn.setAttribute('aria-label', `${b.name}. Nothing useful happens.`);
    btn.innerHTML = ballSvg(b.top, b.deco);

    const say = doc.createElement('span');
    say.className = 'pb-say';
    say.setAttribute('aria-hidden', 'true');
    say.textContent = b.say;
    const cap = doc.createElement('kbd');
    cap.textContent = b.keycap;
    say.append(cap);

    let busy = null;
    btn.onclick = () => {
      btn.classList.add('open');
      burst(layer, originOf(btn), b.style);
      if (!reduced()) {
        if (b.guest === 'fish') school(layer, schoolSize(), sprites.Magikarp);
        else if (b.guest === 'snorlax' && sprites.Snorlax) snorlaxes(layer, sprites.Snorlax);
        else if (b.guest === 'gengar' && sprites.Gengar) gengar(layer, sprites.Gengar);
        else if (b.guest === 'mewduo') mewduo(layer, sprites.Mew, sprites.Mewtwo);
      }
      clearTimeout(busy);
      busy = setTimeout(() => btn.classList.remove('open'), reduced() ? 400 : 1400);
      timers.push(busy);
    };

    row.append(btn, say);
    stack.append(row);
    byKey.set(b.key, btn);
  }
  stack.append(toggle);
  paint();

  doc.body.append(layer, stack);

  /**
   * ARROW KEYS FIRE THE BALLS -- something to fidget with while thinking.
   *
   * Deliberately NOT preventDefault: arrow keys scroll, and stealing that to
   * throw confetti would be a genuinely bad trade. The page still scrolls;
   * a ball goes off as well.
   *
   * It stands down whenever the keys mean something else -- any text field or
   * contenteditable, any modifier held, any open modal or <select> -- because
   * an easter egg that fires while you are editing a Pokémon's moves is not a
   * joke, it is a bug.
   */
  const onKey = (e) => {
    if (!on) return;
    if (!byKey.has(e.key)) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target;
    const tag = t?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
    if (doc.querySelector('.tb-modal, .fx-modal, .it-modal, .pk-modal')) return;
    byKey.get(e.key).click();
  };
  doc.addEventListener('keydown', onKey);

  return () => {
    doc.removeEventListener('keydown', onKey);
    for (const t of timers) clearTimeout(t);
    layer.remove(); stack.remove();
  };
}

export const _internals = {
  vector, FLAVOURS, PATTERNS, palette, band, STYLES, BALLS,
  FISH, school, schoolSize, FISH_CHANCE, SCHOOL_MIN, SCHOOL_CAP,
  stepBounce, snorlax, snorlaxes, laxCount, LAX_CAP, gengar, mewduo, fish,
  ON_KEY, ballsOn, setBallsOn,
};
