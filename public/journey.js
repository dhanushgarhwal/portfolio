// Journey page. Loaded by script.js the first time the page opens (import(), so visitors who never open it download nothing).
//
//   export mount(view)   called when the page opens; view is <main data-page="journey">
//   export warm(view)    optional: called while the site is idle, before the page is ever opened (see script.js)
//   export unmount()     called when it is left: everything started in mount() stops and is released here
//
// How it works:
//   - the road is a route of straight stretches (down, sideways, or tilted to some angle so it zig-zags) joined by corners (journey/core.js
//     buildRoute); every road has all three kinds. Scrolling is distance travelled along it, and the camera follows the road. Milestones sit at HALF the
//     distance at which one card leaves as the next arrives, so one or two cards are on the screen at every point of the road (this newer rule replaces the
//     old "exactly one card"). The card heights are measured here (a card's height depends on its text and the screen) and handed to buildRoute.
//   - one <canvas> draws ground, road, props, plinths and markers for the visible part only; milestone cards are DOM
//     (a pool of at most ~12 nodes, moved with translate3d). The server-rendered list stays as the screen-reader / no-script copy.
//   - the road is generated once per seed, config, screen size and set of card heights (the hand-off rule needs the exact screen); on a touch screen a small
//     height change (the browser toolbar sliding away) keeps the road. Same seed + size = same road.
//   - scrolling is our own: wheel, drag (mouse + touch), keys; inertia, rubber-band at both ends, hard finite bounds, no scrollbar.
//   - it shares the page-changing input with script.js: wheel, swipe and arrow keys move the road, except at the very top / very end when the gesture
//     points out of the road and began there: then they change the page exactly as on every other page (view[data-hold] is switched off for that event).
//     A gesture that began inside the road and runs into an end only rubber-bands; it never carries on into a page change. The wheel is listened to on
//     the window, so it works wherever the pointer rests (the menu, say) and needs no pointer movement first.
//   - one requestAnimationFrame loop, running only while the page is open and the tab is visible; it drops to ~30 fps when idle and
//     stops completely under prefers-reduced-motion (a static frame is drawn on demand).
//   - focus: a soft dark vignette on all four screen edges (css, equal on every side) plus a small canvas ellipse keeps attention in the middle.
//   - the white dot marks where you are on the road, and behind it a bright line runs back along the road to the start marker (the trail); the road beyond
//     the dot keeps its dim dashes. Nothing glows round the dot or ahead of it.
//   - a first-time visitor starts ON the start marker (the one labelled startLabel) and travels the story from its beginning; someone who has opened the page
//     before (cookie jy-seen, with a localStorage copy; written when the page opens) starts on the current card as always.
//   - every milestone sits on a corner of the road, with its card on the side that keeps it clear of the road.
//   - gestures: only the tail of the swipe (or the held key) that carried you here is ignored, using the page-change wheel's own rules for where a swipe ends;
//     the next gesture, wheel notch or key press works at once.
//   - every listener hangs on one AbortController; unmount() aborts it, stops the loop and removes everything mount() created.
// The data is a <script type="application/json" id="journey-data"> written by the build (scripts/render.mjs, journeyData()).
// Nothing in it is trusted: every number is clamped into the range the build also enforces (the build sends the table as data.ranges).

import { buildProps, buildRoute, cardIndex, cardWidth, clamp, legSpan, clampScroll, dateLabel, edgeFor, friction, fromProgress, nextQuality, openingPos, pointAt, trailOrigin, progress, rubber, splitMarks, swipeTracker, trailSegs, visibleRange, wheelDelta } from "./journey/core.js";

const DEFAULTS = {
  seed: 1,
  path: { spacing: 340, amplitude: 0.62, curviness: 0.55, jitter: 0.35, width: 46 },
  highlight: { breathing: true, speed: 0.5, color: "#c1c5ce" },
};
// Used only when the data carries no table of its own.
const RANGES = {
  seed: [0, 2_147_483_647, true],
  path: { spacing: [160, 800, true], amplitude: [0.2, 0.9, false], curviness: [0, 1, false], jitter: [0, 1, false], width: [20, 120, true] },
  highlight: { speed: [0.1, 1, false] },
};
const DIRECTIONS = ["latest-top", "latest-bottom"];
const MAX_ENTRIES = 60;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v, max, fallback = "") => (typeof v === "string" && v.length <= max ? v : fallback);

/** Clamps a value into [min, max]; anything that is not a finite number becomes the fallback first. */
export function clampTo(value, [min, max, whole], fallback) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const c = Math.min(max, Math.max(min, n));
  return whole ? Math.round(c) : c;
}

const group = (src, defaults, ranges) => {
  const out = {};
  for (const k of Object.keys(defaults)) {
    if (typeof defaults[k] === "boolean") out[k] = typeof src?.[k] === "boolean" ? src[k] : defaults[k];
    else if (typeof defaults[k] === "number") out[k] = clampTo(src?.[k], ranges?.[k] ?? [-Infinity, Infinity, false], defaults[k]);
    else out[k] = defaults[k];
  }
  return out;
};

/**
 * Turns the raw page data into a safe config. Never throws: anything unusable falls back to a default or is dropped.
 * Returns null when there is nothing to show (no data, or the page is switched off).
 */
export function readConfig(raw) {
  if (!isObj(raw) || raw.enabled === false) return null;
  const ranges = isObj(raw.ranges) ? raw.ranges : RANGES;
  const entries = (Array.isArray(raw.entries) ? raw.entries : []).slice(0, MAX_ENTRIES).flatMap((e) => {
    if (!isObj(e) || typeof e.id !== "string" || typeof e.date !== "string" || typeof e.title !== "string") return [];
    return [{
      id: text(e.id, 40), date: text(e.date, 10), title: text(e.title, 60), text: text(e.text, 280), tag: text(e.tag, 20),
      icon: text(e.icon, 30), image: typeof e.image === "string" && /^\/image\/[\w./-]+$/.test(e.image) && !e.image.includes("..") ? e.image : "",
      link: isObj(e.link) && typeof e.link.url === "string" && /^https?:\/\//i.test(e.link.url) ? { label: text(e.link.label, 30, "open"), url: e.link.url.slice(0, 500) } : null,
      side: e.side === "left" || e.side === "right" ? e.side : "auto", pinned: e.pinned === true,
    }];
  });
  const color = typeof raw.highlight?.color === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.highlight.color) ? raw.highlight.color : DEFAULTS.highlight.color;
  const latest = entries.some((e) => e.id === raw.latest) ? raw.latest : entries[0]?.id ?? null;
  return {
    title: text(raw.title, 80, "journey"),
    subtitle: text(raw.subtitle, 40),
    direction: DIRECTIONS.includes(raw.direction) ? raw.direction : "latest-top",
    startLabel: text(raw.startLabel, 24), endLabel: text(raw.endLabel, 24),
    seed: clampTo(raw.seed, ranges.seed ?? RANGES.seed, DEFAULTS.seed),
    path: group(raw.path, DEFAULTS.path, ranges.path),
    highlight: { ...group(raw.highlight, DEFAULTS.highlight, ranges.highlight), color },
    entries, latest,
  };
}

/* ---------------------------------------------------------------- the world ---------------------------------------------------------------- */

const SVG_NS = "http://www.w3.org/2000/svg";
const NOISE = 160;           // size of the repeating ground grain
const CARD_POOL = 12;        // hard cap on live card nodes (a normal screen uses 4 to 6)
const SPOT_SCALE = 0.25;     // the vignette canvas is a quarter of the screen in each direction
// [radius share, darkness]: clear in the middle, then a long smooth fall into near-black. The ellipse is sized to the screen in drawSpot().
const CAM_MS = 55;           // the camera trails the road point by about this long, so a corner is turned smoothly instead of in one frame
const SPOT_STOPS = [[0, 0], [0.62, 0], [0.82, 0.16], [1, 0.46]];
const SCROLL_KEYS = new Set(["ArrowDown", "ArrowUp", "s", "S", "w", "W", "PageDown", "PageUp", " ", "Home", "End"]);
const IDLE_MS = 1500;        // after this long without motion the loop drops to ~30 fps
const SESSION_SEED = (() => { try { return crypto.getRandomValues(new Uint32Array(1))[0] % 2_147_483_647; } catch { return Math.floor(Math.random() * 2_147_483_647); } })(); // a new road on every page load
const saved = { key: "", p: 0 }; // where the visitor stopped, so coming back resumes there

let loadSeen = null; // whether this browser had opened the Journey before THIS page load began: decided once, so leaving and coming back in the same load keeps the same trail
let session = null; // what mount() started; unmount() releases exactly this

// ---- the Journey visit, remembered the way the intro is (script.js INTRO_KEY): a cookie, plus a localStorage copy. Every read and write is guarded: with both blocked
// the visitor counts as new every time and nothing throws. ----
const SEEN_KEY = "jy-seen", SEEN_TTL_S = 31536000; // one year
/** True when this browser has opened the Journey page before. `env` is the window (injected so Node can test it). */
export function readSeen(env = globalThis) {
  try { if (env.localStorage?.getItem(SEEN_KEY) === "1") return true; } catch { /* storage blocked: the cookie may still know */ }
  try { if (new RegExp(`(?:^|;\\s*)${SEEN_KEY}=1(?:;|$)`).test(env.document?.cookie ?? "")) return true; } catch { /* cookies blocked */ }
  return false;
}
/** Remembers the visit: cookie (max-age one year, path=/, SameSite=Lax, Secure on https) and localStorage. */
export function markSeen(env = globalThis) {
  try { env.localStorage?.setItem(SEEN_KEY, "1"); } catch { /* storage blocked: the cookie below still remembers */ }
  try { env.document.cookie = `${SEEN_KEY}=1; max-age=${SEEN_TTL_S}; path=/; SameSite=Lax${env.location?.protocol === "https:" ? "; Secure" : ""}`; } catch { /* cookies blocked: the next visit starts at the start again */ }
}

const mk = (tag, cls, parent) => { const n = document.createElement(tag); if (cls) n.className = cls; parent?.append(n); return n; };

// small soft light, drawn once and stamped with drawImage (no gradients are built in the frame loop)
function glowSprite(rgb, size = 192) {
  const c = document.createElement("canvas"); c.width = c.height = size;
  const g = c.getContext("2d"), r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, `rgba(${rgb},1)`); grad.addColorStop(0.35, `rgba(${rgb},.35)`); grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad; g.fillRect(0, 0, size, size);
  return c;
}
// The ground grain and the glow sprites cost a few milliseconds to draw and are never changed afterwards, so they are made once per page load (warm() can
// make them in the background before anyone opens the page) and mount() just takes them.
const sprites = new Map();
const once = (key, make) => { let v = sprites.get(key); if (!v) sprites.set(key, v = make()); return v; };
const hexRgb = (hex) => `${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)}`;

// fine fixed grain so the ground is not a flat fill (seeded: the same on every visit)
function noiseTile(seed) {
  const c = document.createElement("canvas"); c.width = c.height = NOISE;
  const g = c.getContext("2d"), img = g.createImageData(NOISE, NOISE), d = img.data;
  let a = seed >>> 0;
  for (let i = 0; i < d.length; i += 4) {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    const v = 150 + ((a >>> 24) % 90);
    d[i] = v; d[i + 1] = v + 2; d[i + 2] = v + 6; d[i + 3] = (a >>> 16) % 11;
  }
  g.putImageData(img, 0, 0);
  return c;
}

const fillCard = (el, e, latest, pinned) => {
  el.dataset.id = e.id;
  el.classList.toggle("is-latest", latest);
  el.classList.toggle("is-pinned", pinned);
  el._date.textContent = dateLabel(e.date);
  el._tag.textContent = e.tag; el._tag.hidden = !e.tag;
  el._flag.hidden = !latest || e.tag === "latest"; // no second "latest" chip when the tag already says it
  el._h.textContent = e.title;
  el._p.textContent = "";
  for (const part of splitMarks(e.text)) {
    if (part.url) { const a = mk("a", "hi", el._p); a.textContent = part.t; a.href = part.url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.tabIndex = -1; }
    else if (part.hi) mk("span", "hi", el._p).textContent = part.t;
    else el._p.append(part.t);
  }
  el._p.hidden = !e.text;
  if (e.image) { if (el._img.getAttribute("src") !== e.image) el._img.src = e.image; el._img.hidden = false; } else { el._img.removeAttribute("src"); el._img.hidden = true; }
  if (e.link) { el._a.href = e.link.url; el._a.lastChild.textContent = e.link.label; el._foot.hidden = false; } else { el._a.removeAttribute("href"); el._foot.hidden = true; }
};

function makeCard(layer) {
  const el = mk("article", "card jy-card", layer);
  mk("i", "hl", el);
  const tags = mk("div", "jy-tags", el);
  el._date = mk("span", "chip", tags); el._tag = mk("span", "chip", tags); el._flag = mk("span", "chip jy-flag", tags); el._flag.textContent = "latest";
  el._h = mk("h2", "", el); el._p = mk("p", "", el);
  el._img = mk("img", "jy-img", el); el._img.alt = ""; el._img.loading = "lazy"; el._img.decoding = "async"; el._img.draggable = false;
  el._foot = mk("div", "foot", el); el._a = mk("a", "chip", el._foot); el._a.target = "_blank"; el._a.rel = "noopener noreferrer"; el._a.tabIndex = -1;
  const svg = document.createElementNS(SVG_NS, "svg"); svg.setAttribute("aria-hidden", "true");
  svg.append(document.createElementNS(SVG_NS, "use")); svg.firstChild.setAttribute("href", "#i-external");
  el._a.append(svg, document.createElement("span"));
  el.hidden = true;
  return el;
}

/** Called by script.js in the background while the site sits idle: draws what mount() will need so opening the page has less to do. Changes nothing on the page. */
export function warm(view) {
  try {
    const config = readConfig(JSON.parse(view.querySelector("#journey-data")?.textContent ?? ""));
    if (!config) return;
    once(`g${config.highlight.color}`, () => glowSprite(hexRgb(config.highlight.color)));
    once("g-silver", () => glowSprite("193,197,206"));
    once(`n${SESSION_SEED}`, () => noiseTile(SESSION_SEED));
  } catch { /* unreadable data: mount() copes with it as before */ }
}

export function mount(view, opened) {  // opened: what script.js saw last ({ wheel: { t, d, notch } | null, key }), so the gesture that opened the page is told from the next one
  if (session) unmount();
  const node = view.querySelector("#journey-data");
  let raw = null;
  try { raw = JSON.parse(node?.textContent ?? ""); } catch { /* unreadable data: the server-rendered list stays as it is */ }
  const config = readConfig(raw);
  if (config) config.seed = SESSION_SEED;
  const stage = view.querySelector("#jyStage");
  const list = view.querySelector("#jyList");
  const canvas = document.createElement("canvas");
  const ctx = config && stage ? canvas.getContext("2d", { alpha: false }) : null;
  if (!ctx) { view.removeAttribute("data-world"); view.removeAttribute("data-hold"); return; } // nothing to draw with: the plain list stays the page

  const ctl = new AbortController(), { signal } = ctl;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const coarse = matchMedia("(pointer: coarse)").matches;
  const { entries, path: P, highlight: H } = config;
  const total = entries.length;
  const latestRow = Math.max(0, entries.findIndex((e) => e.id === config.latest));
  const topIsLatest = config.direction === "latest-top";

  // ---- DOM: canvas + card layer + rail + count, all inside the stage; the list stays for assistive tech ----
  view.setAttribute("data-hold", "");
  view.dataset.world = "";
  stage.tabIndex = 0;
  stage.classList.add("is-ready");
  list?.classList.add("jy-sr");
  canvas.className = "jy-canvas"; canvas.setAttribute("aria-hidden", "true");
  const layer = mk("div", "jy-layer"); layer.setAttribute("aria-hidden", "true");
  const rail = mk("div", "jy-rail"), thumb = mk("i", "", rail); rail.setAttribute("aria-hidden", "true");
  const count = mk("p", "jy-count"); count.setAttribute("aria-hidden", "true");
  stage.prepend(canvas, layer);
  stage.append(rail, count);
  // ---- focus: the vignette. A small canvas (scaled up by css; a soft gradient does not need pixels) laid over the cards ----
  const spot = mk("canvas", "jy-spot"); spot.setAttribute("aria-hidden", "true");
  rail.before(spot);
  const sctx = spot.getContext("2d");
  let grad = null;
  if (sctx) { // one gradient on a unit circle, stretched into an ellipse at draw time: nothing is created per frame
    grad = sctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    for (const [at, a] of SPOT_STOPS) grad.addColorStop(at, `rgba(0,0,0,${a})`);
  }
  const empty = total ? null : mk("p", "jy-nothing", layer);
  if (empty) empty.textContent = "nothing here yet";
  const pool = []; // card nodes are made on demand and reused; a screen never needs more than a handful

  // ---- state ----
  const glowH = once(`g${H.color}`, () => glowSprite(hexRgb(H.color))), glowS = once("g-silver", () => glowSprite("193,197,206"));
  const grain = once(`n${config.seed}`, () => noiseTile(config.seed));
  const grainPat = ctx.createPattern(grain, "repeat");
  let route = null, nodeS = [0], points = [], max = 0, routeKey = "", pace = 1; // the road: built in layout(), once the screen size is known
  let routeW = 0, routeH = 0, heights = [], measuredW = -1;                       // the screen the road was built for, and each card's half height on it
  const pinnedRow = entries.map((e, i) => (i === latestRow || e.pinned ? 1 : 0));
  let W = 0, Hh = 0, dpr = 1, quality = 0, props = [], propY = [], plan = [], propKey = "";
  let pos = 0, vel = 0, glide = null, drag = null, dragged = false, dirty = true, running = false;
  let raf = 0, last = 0, lastDraw = 0, lastMove = 0, shown = -1, slow = 0, slowN = 0, slowT = 0, activeRow = -1;
  let cx = 0, cy = 0, camReady = false; // the camera: the world point at the middle of the screen, trailing the road point under the visitor
  const here = {}, dirAt = {}, headAt = {}, span = {}; // scratch points, reused so a frame allocates nothing
  let trailBuf = new Float64Array(5 * 64); const screenRect = [0, 0, 0, 0]; // the trail's pieces and the screen rectangle: reused, a frame allocates nothing
  let startPos = 0; // where the trail begins: the start marker for a new visitor, the "i am here" marker for a returning one (see trailOrigin in core.js)
  const seen = (loadSeen ??= readSeen()); // read once per page load, before anything is written
  markSeen();                             // remember this visit (written when the page opens, not on the first page load of the site)
  let px = 0, py = 0, railH = 60;       // pointer parallax, -1..1
  const root = document.documentElement;
  let holdT = 0;
  const live = new Map(); // row -> card element
  let frontId = "";       // the card whose list item has the keyboard focus
  const phaseAt = (now) => (reduced.matches || !H.breathing ? 0.5 : 0.5 + 0.5 * Math.sin((now / 1000) * ((Math.PI * 2) / (8 - 4 * H.speed))));
  const wake = () => { dirty = true; lastMove = performance.now(); if (!raf && running) raf = requestAnimationFrame(frame); };

  // ---- the vignette ----
  const drawSpot = () => { // fixed to the screen, so it is drawn once per size
    if (!sctx || !grad) return;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, spot.width, spot.height);
    sctx.setTransform(SPOT_SCALE * W * 0.62, 0, 0, SPOT_SCALE * Hh * 0.62, SPOT_SCALE * W / 2, SPOT_SCALE * Hh / 2);
    sctx.fillStyle = grad;
    sctx.fillRect(-60, -60, 120, 120); // far bigger than the screen in unit-circle space: the last stop fills the rest
  };

  const measure = () => { const r = stage.getBoundingClientRect(); return [Math.max(240, Math.round(r.width)), Math.max(240, Math.round(r.height))]; };
  const sizeCanvas = () => {
    [W, Hh] = measure();
    dpr = Math.min(window.devicePixelRatio || 1, quality >= 2 ? 1 : quality === 1 || (coarse && quality) ? 1.5 : 2);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(Hh * dpr);
    canvas.style.width = `${W}px`; canvas.style.height = `${Hh}px`;
    railH = Math.max(60, Math.min(220, Math.round(Hh * 0.3)));
    rail.style.height = `${railH}px`;
    spot.width = Math.max(1, Math.ceil(W * SPOT_SCALE)); spot.height = Math.max(1, Math.ceil(Hh * SPOT_SCALE));
    spot.style.width = `${W}px`; spot.style.height = `${Hh}px`;
    drawSpot();
  };

  // ---- cards: how each one is placed (from the screen width) and how tall it really is ----
  const baseOpts = (i) => {
    const o = W < 640 ? { gap: 22, max: 168, min: 116, edge: 14 } : { gap: 28, max: 210, min: 150, edge: 14 };
    return i === latestRow ? { ...o, grow: 1.14, edge: 6 } : o; // the latest card is a little bigger: wider (as far as the screen allows) and a little taller (css)
  };
  const measureCards = () => { // the hand-off between two cards is built on their real heights, so each is laid out once, unseen, at its width
    const probe = makeCard(layer);
    probe.hidden = false; probe.style.visibility = "hidden";
    const out = entries.map((e, i) => {
      probe.style.width = `${cardWidth(W, baseOpts(i))}px`;
      fillCard(probe, e, i === latestRow, e.pinned);
      const h = probe.offsetHeight;
      return Number.isFinite(h) && h > 0 ? h / 2 : 100;
    });
    probe.remove();
    return out;
  };

  // ---- scenery and card places: rebuilt only when what they depend on changes ----
  const layout = () => {
    if (measuredW !== W) { heights = measureCards(); measuredW = W; }
    // The road depends on the exact screen (that is what makes one card always the only one on it). On a touch screen the browser's toolbar slides away
    // while scrolling and changes the height by a few dozen px: the road keeps the height it was made for unless it changed a lot.
    const rh = coarse && route && W === routeW && Math.abs(Hh - routeH) < 80 ? routeH : Hh;
    const rk = `${W}|${rh}|${heights.join(",")}`;
    if (rk !== routeKey) {
      const at = route ? progress(pos, max) : 0;
      routeKey = rk; routeW = W; routeH = rh;
      route = buildRoute({ seed: config.seed, nodes: total, amplitude: P.amplitude, view: { w: W, h: rh }, cards: entries.map((e, i) => ({ ...baseOpts(i), viewW: W, hh: heights[i] })) });
      ({ nodeS, points } = route); max = route.total; startPos = trailOrigin(seen, config.direction, max);
      if (route.legs.length * 5 > trailBuf.length) trailBuf = new Float64Array(route.legs.length * 5 + 20);
      plan = route.plans;
      pace = clamp(max / (total + 1) / 325, 1, 2.2); // far-apart milestones: wheel and keys travel proportionally further per notch (325 = half the old 650, because the milestones are now half as far apart: the same number of cards per notch)
      if (at) pos = fromProgress(at, max);
      glide = null; camReady = false; shown = -1; propKey = "";
      for (const el of live.values()) el.hidden = true;
      live.clear();
    }
    const bucket = Math.ceil((Math.max(W, Hh) / 2 + 250) / 400) * 400; // scenery reaches this far past the road, enough to fill the screen at any point of it
    const pk = `${quality ? 1 : 0}|${bucket}|${routeKey}`;
    if (pk !== propKey) {
      propKey = pk;
      const b = route.bounds, area = (b.maxX - b.minX + bucket * 2) * (b.maxY - b.minY + bucket * 2);
      props = buildProps({ seed: config.seed, route, roadWidth: P.width, margin: bucket, count: Math.floor(Math.min(1800, area / 30000) * (quality ? 0.55 : 1)) });
      propY = props.map((p) => p.y);
    }
  };

  const rebuild = () => { sizeCanvas(); layout(); shown = -1; wake(); };

  // ---- drawing ----
  const DASH_LEN = 8, DASH_GAP = 10, DASH = [DASH_LEN, DASH_GAP], NODASH = [], PERIOD = DASH_LEN + DASH_GAP; // road paint: a short dash, then clear tarmac
  const stroke = (p, w, style, dy) => { // one stroke of the road's whole visible outline
    ctx.lineWidth = w; ctx.strokeStyle = style;
    if (dy) ctx.translate(0, dy);
    ctx.stroke(p);
    if (dy) ctx.translate(0, -dy);
  };
  const lightRGB = hexRgb(H.color);
  const DASH_STYLE = `rgba(${lightRGB},.42)`;
  const TRAIL_GLOW = `rgba(${lightRGB},.12)`; // a minimal glow along the whole trail (the highlight colour, low alpha)
  // the trail: one crisp bright line along the middle of the road from the start marker to the dot (nothing is lit beyond the dot)
  const drawTrail = (hs) => {
    const lo = Math.min(startPos, hs), hi = Math.max(startPos, hs);
    if (hi - lo < 0.5) return;
    screenRect[0] = cx - W / 2 - 80; screenRect[1] = cy - Hh / 2 - 80; screenRect[2] = cx + W / 2 + 80; screenRect[3] = cy + Hh / 2 + 80;
    const n = trailSegs(route, lo, hi, screenRect, trailBuf);
    if (!n) return;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (let pass = 0; pass < 2; pass++) {
      ctx.lineWidth = pass ? 2 : 7; ctx.strokeStyle = pass ? "#f1f3f7" : TRAIL_GLOW;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const o = i * 5;
        if (!trailBuf[o + 4]) ctx.moveTo(trailBuf[o], trailBuf[o + 1]);
        ctx.lineTo(trailBuf[o + 2], trailBuf[o + 3]);
      }
      ctx.stroke();
    }
  };

  // ---- scenery: one small drawing per prop kind (journey/core.js deals the kinds so neighbours differ; v is the prop's own 0..1 variation) ----
  const TAU = 6.2832, EDGE = "rgba(193,197,206,.16)", INK = "#101113";
  const oval = (x, y, rx, ry, rot = 0) => { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot, 0, TAU); };
  const PROPS = [
    (x, y, r, v) => { // 0 rock
      ctx.fillStyle = "rgba(0,0,0,.5)"; oval(x + 3, y + 5, r * 1.1, r * 0.8); ctx.fill();
      ctx.fillStyle = INK; oval(x, y, r, r * 0.82, v * 3); ctx.fill();
      ctx.strokeStyle = EDGE; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, r * 0.8, 3.5, 5.2); ctx.stroke();
    },
    (x, y, r) => { // 1 grass tuft
      ctx.strokeStyle = "rgba(193,197,206,.2)"; ctx.lineWidth = 1.2; ctx.beginPath();
      for (let k = -2; k <= 2; k++) { ctx.moveTo(x, y); ctx.lineTo(x + k * 2.6, y - r * (1 - Math.abs(k) * 0.14)); }
      ctx.stroke();
    },
    (x, y, r) => { // 2 pillar seen from above
      ctx.fillStyle = "rgba(0,0,0,.55)"; oval(x + 5, y + 7, r * 0.9, r * 0.6); ctx.fill();
      ctx.fillStyle = "#0e0f11"; ctx.beginPath(); ctx.arc(x, y, r * 0.75, 0, TAU); ctx.fill();
      ctx.fillStyle = "#141518"; ctx.beginPath(); ctx.arc(x, y - 2, r * 0.58, 0, TAU); ctx.fill();
      ctx.strokeStyle = "rgba(193,197,206,.2)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y - 2, r * 0.58, 3.4, 5.9); ctx.stroke();
    },
    (x, y, r) => { // 3 lantern: a small warm-white light
      ctx.globalAlpha = 0.28; ctx.drawImage(glowS, x - r * 4, y - r * 4, r * 8, r * 8); ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(241,243,247,.75)"; ctx.beginPath(); ctx.arc(x, y, 1.8, 0, TAU); ctx.fill();
    },
    (x, y, r, v) => { // 4 pebbles
      ctx.fillStyle = INK; ctx.strokeStyle = "rgba(193,197,206,.14)"; ctx.lineWidth = 1;
      for (let k = 0; k < 3; k++) { const rr = r * (0.3 + 0.1 * k); oval(x + (k - 1) * r * 0.9, y + (k % 2 ? 1 : -1) * r * 0.35, rr, rr * 0.75, v * 3 + k); ctx.fill(); ctx.stroke(); }
    },
    (x, y, r) => { // 5 crystal
      ctx.fillStyle = "rgba(0,0,0,.45)"; oval(x + 3, y + r * 0.9, r * 0.7, r * 0.3); ctx.fill();
      ctx.fillStyle = "#0f1114"; ctx.strokeStyle = "rgba(193,197,206,.3)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y - r * 1.1); ctx.lineTo(x + r * 0.6, y); ctx.lineTo(x, y + r * 0.8); ctx.lineTo(x - r * 0.6, y); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y - r * 1.1); ctx.lineTo(x, y + r * 0.8); ctx.strokeStyle = "rgba(193,197,206,.12)"; ctx.stroke();
    },
    (x, y, r, v) => { // 6 ring stone
      ctx.strokeStyle = "rgba(193,197,206,.13)"; ctx.lineWidth = 2; oval(x, y, r * 1.1, r * 0.8, v); ctx.stroke();
      ctx.strokeStyle = "rgba(0,0,0,.5)"; ctx.lineWidth = 1; oval(x, y + 1.5, r * 0.8, r * 0.55, v); ctx.stroke();
    },
    (x, y, r) => { // 7 star speck
      ctx.strokeStyle = "rgba(193,197,206,.3)"; ctx.lineWidth = 1; ctx.beginPath();
      ctx.moveTo(x - r * 0.45, y); ctx.lineTo(x + r * 0.45, y); ctx.moveTo(x, y - r * 0.45); ctx.lineTo(x, y + r * 0.45); ctx.stroke();
      ctx.fillStyle = "rgba(241,243,247,.55)"; ctx.beginPath(); ctx.arc(x, y, 1.2, 0, TAU); ctx.fill();
    },
    (x, y, r, v) => { // 8 fern: a bent stem with paired leaflets
      const bend = (v - 0.5) * r; ctx.strokeStyle = "rgba(193,197,206,.22)"; ctx.lineWidth = 1; ctx.beginPath();
      ctx.moveTo(x, y + r); ctx.quadraticCurveTo(x + bend, y, x + bend * 1.4, y - r * 1.5);
      for (let k = 0; k < 4; k++) { const t = 0.25 + k * 0.2, lx = x + bend * 1.4 * t, ly = y + r - r * 2.5 * t, l = r * (0.7 - k * 0.12); ctx.moveTo(lx, ly); ctx.lineTo(lx - l, ly - l * 0.6); ctx.moveTo(lx, ly); ctx.lineTo(lx + l, ly - l * 0.6); }
      ctx.stroke();
    },
    (x, y, r, v) => { // 9 cairn: stacked stones
      ctx.fillStyle = "rgba(0,0,0,.5)"; oval(x + 3, y + r * 0.8, r * 1.1, r * 0.45); ctx.fill();
      ctx.fillStyle = INK; ctx.strokeStyle = EDGE; ctx.lineWidth = 1;
      for (let k = 0; k < 3; k++) { oval(x + (v - 0.5) * k * 2, y + r * 0.45 - k * r * 0.5, r * (1 - k * 0.28), r * (0.45 - k * 0.07)); ctx.fill(); ctx.stroke(); }
    },
    (x, y, r, v) => { // 10 spiral shell
      ctx.strokeStyle = "rgba(193,197,206,.2)"; ctx.lineWidth = 1; ctx.beginPath();
      for (let k = 0; k <= 22; k++) { const a = k * 0.55 + v * 6, d = r * 0.05 * k; k ? ctx.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.8) : ctx.moveTo(x, y); }
      ctx.stroke();
    },
    (x, y, r, v) => { // 11 flower: five petals round a pale heart
      ctx.strokeStyle = "rgba(193,197,206,.24)"; ctx.lineWidth = 1;
      for (let k = 0; k < 5; k++) { const a = k * 1.2566 + v * 6; ctx.beginPath(); ctx.arc(x + Math.cos(a) * r * 0.45, y + Math.sin(a) * r * 0.45, r * 0.3, 0, TAU); ctx.stroke(); }
      ctx.fillStyle = "rgba(241,243,247,.5)"; ctx.beginPath(); ctx.arc(x, y, 1.4, 0, TAU); ctx.fill();
    },
    (x, y, r, v) => { // 12 crater: a dark dent with a lit lower rim
      ctx.fillStyle = "rgba(0,0,0,.45)"; oval(x, y, r * 1.3, r * 0.85, v); ctx.fill();
      ctx.strokeStyle = "rgba(193,197,206,.13)"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.ellipse(x, y, r * 1.3, r * 0.85, v, 0.3, 2.8); ctx.stroke();
    },
    (x, y, r, v) => { // 13 embers: a faint ring with a few warm sparks
      ctx.globalAlpha = 0.12; ctx.drawImage(glowS, x - r * 2.5, y - r * 2.5, r * 5, r * 5); ctx.globalAlpha = 1;
      ctx.strokeStyle = "rgba(193,197,206,.14)"; ctx.lineWidth = 1; oval(x, y, r * 0.7, r * 0.5); ctx.stroke();
      ctx.fillStyle = "rgba(241,243,247,.6)";
      for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.arc(x + (k - 1) * r * 0.35, y + ((k + v * 3) % 2 - 0.5) * r * 0.3, 0.9, 0, TAU); ctx.fill(); }
    },
  ];

  const draw = (now, dp) => {
    const ox = W / 2 - cx, oy = Hh / 2 - cy; // world -> screen
    const phase = phaseAt(now);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // ground: base + soft pools of light under the milestones + grain moving a little slower than the road (depth)
    ctx.fillStyle = "#040405"; ctx.fillRect(0, 0, W, Hh);
    for (let i = 1; i <= total; i++) {
      const x = points[i].x + ox, y = points[i].y + oy;
      if (x < -230 || x > W + 230 || y < -230 || y > Hh + 230) continue;
      ctx.globalAlpha = 0.07; ctx.drawImage(glowS, x - 230, y - 230, 460, 460);
    }
    ctx.globalAlpha = 1;
    if (!quality || quality === 1) {
      ctx.save(); ctx.translate(-(((cx * 0.92) % NOISE) + NOISE) % NOISE, -(((cy * 0.92) % NOISE) + NOISE) % NOISE);
      ctx.fillStyle = grainPat; ctx.fillRect(0, 0, W + NOISE, Hh + NOISE); ctx.restore();
    }
    // road: only the stretches on screen, cut to the screen, drawn in world space
    ctx.save(); ctx.translate(ox, oy);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    const x0 = cx - W / 2 - 80, x1 = cx + W / 2 + 80, y0 = cy - Hh / 2 - 80, y1 = cy + Hh / 2 + 80, w = P.width;
    const body = new Path2D(), paint = [];
    let chain = false; // the previous stretch ran on screen up to its corner: this one carries on from it
    for (const L of route.legs) {
      if (L.bx1 < x0 || L.bx0 > x1 || L.by1 < y0 || L.by0 > y1 || !legSpan(L, x0, y0, x1, y1, span)) { chain = false; continue; }
      const len = L.s1 - L.s0, t0 = span.a, t1 = span.b;
      const ax = L.x0 + L.dx * t0, ay = L.y0 + L.dy * t0, bx = L.x0 + L.dx * t1, by = L.y0 + L.dy * t1;
      if (!(chain && t0 === 0)) body.moveTo(ax, ay);
      body.lineTo(bx, by);
      chain = t1 === len;
      paint.push(ax, ay, bx, by, (L.s0 + t0) % PERIOD); // the paint starts at its own distance along the road, so it never crawls or flickers
    }
    stroke(body, w + 16, "rgba(0,0,0,.35)", 10);                 // wide soft shadow
    stroke(body, w + 8, "rgba(0,0,0,.55)", 5);                   // tight shadow
    stroke(body, w + 3, "rgba(193,197,206,.17)", -1);            // lit edge
    stroke(body, w, "#0a0a0c", 0);                               // road body
    stroke(body, Math.max(4, w - 10), "rgba(0,0,0,.5)", 2);      // inner shadow
    stroke(body, Math.max(2, w - 14), "#0c0c0e", 0);             // worn middle
    // centre line: dim dashes along the whole road (the part beyond the dot stays like this) ...
    ctx.lineCap = "butt"; ctx.lineWidth = 2; ctx.strokeStyle = DASH_STYLE; ctx.setLineDash(DASH);
    for (let k = 0; k < paint.length; k += 5) {
      ctx.lineDashOffset = paint[k + 4];
      ctx.beginPath(); ctx.moveTo(paint[k], paint[k + 1]); ctx.lineTo(paint[k + 2], paint[k + 3]); ctx.stroke();
    }
    // ... and the bright trail on top, from the start marker to the dot (it grows and shrinks with the dot, whichever way the visitor travels)
    const hs = clamp(dp, 0, max);
    ctx.setLineDash(NODASH); ctx.lineDashOffset = 0;
    drawTrail(hs);
    ctx.lineCap = "round";
    // the dot itself: the head of the trail, with a steady, decent glow (no breathing, nothing ahead of it)
    pointAt(route, hs, headAt);
    ctx.globalAlpha = 0.65; ctx.drawImage(glowH, headAt.x - 24, headAt.y - 24, 48, 48); ctx.globalAlpha = 1;
    ctx.fillStyle = "#f1f3f7"; ctx.beginPath(); ctx.arc(headAt.x, headAt.y, 2.6, 0, TAU); ctx.fill();
    ctx.restore();

    // props: scaled a hair about the view centre (1.06x) so they sit "above" the road and slide against it; tiny pointer parallax
    const [pl, ph] = visibleRange(propY, cy - Hh / 2, Hh, 60);
    if (pl >= 0) for (let i = pl; i <= ph; i++) {
      const p = props[i], sx = p.x + ox, sy = p.y + oy;
      if (sx < -60 || sx > W + 60) continue;
      PROPS[p.kind](sx + (sx - W / 2) * 0.06 + px * 3, sy + (sy - Hh / 2) * 0.06 + py * 2, p.r, p.v);
    }

    // start and end markers
    ctx.font = '400 11px Poppins, system-ui, sans-serif'; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const [pt, label, above] of [[points[0], topIsLatest ? config.endLabel : config.startLabel, true], [points[points.length - 1], topIsLatest ? config.startLabel : config.endLabel, false]]) {
      const x = pt.x + ox, y = pt.y + oy;
      if (x < -80 || x > W + 80 || y < -80 || y > Hh + 80) continue;
      ctx.fillStyle = "rgba(0,0,0,.5)"; ctx.beginPath(); ctx.arc(x + 2, y + 5, 15, 0, TAU); ctx.fill();
      ctx.strokeStyle = "rgba(193,197,206,.3)"; ctx.lineWidth = 1.2; ctx.fillStyle = "#0b0b0d"; ctx.beginPath(); ctx.arc(x, y, 13, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "rgba(193,197,206,.55)"; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, TAU); ctx.fill();
      if (label) { ctx.fillStyle = "rgba(193,197,206,.55)"; ctx.fillText(label, x, y + (above ? -34 : 38)); }
    }

    // plinths; the latest and pinned milestones get the breathing glow (slow sine on glow radius and alpha, same silver light language as the nav ring)
    for (let i = 1; i <= total; i++) {
      const x = points[i].x + ox, y = points[i].y + oy;
      if (x < -100 || x > W + 100 || y < -100 || y > Hh + 100) continue;
      const hot = pinnedRow[i - 1] === 1, isLatest = i - 1 === latestRow, r = hot ? 20 : 15;
      if (hot) {
        const gr = r * (3.2 + 1.6 * phase);
        ctx.globalAlpha = (isLatest ? 0.35 : 0.2) + 0.4 * phase * (isLatest ? 1 : 0.6);
        ctx.drawImage(glowH, x - gr, y - gr, gr * 2, gr * 2); ctx.globalAlpha = 1;
      }
      ctx.fillStyle = "rgba(0,0,0,.6)"; ctx.beginPath(); ctx.ellipse(x + 4, y + 9, r * 1.05, r * 0.85, 0, 0, TAU); ctx.fill(); // offset shadow
      ctx.fillStyle = "#070708"; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();                                       // side wall
      ctx.fillStyle = "#0f1012"; ctx.beginPath(); ctx.arc(x, y - 4, r, 0, TAU); ctx.fill();                                   // raised top
      ctx.strokeStyle = hot ? "rgba(193,197,206,.5)" : "rgba(193,197,206,.24)"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(x, y - 4, r - 0.6, 3.4, 6.0); ctx.stroke();
      ctx.fillStyle = hot ? "#f1f3f7" : "rgba(193,197,206,.55)"; ctx.beginPath(); ctx.arc(x, y - 4, hot ? 4.5 : 3.2, 0, TAU); ctx.fill();
    }
  };

  // ---- cards (virtualised) ----
  const placeCards = (ox, oy) => {
    for (const [row, el] of live) {
      const a = plan[row], x = a.x + ox, y = a.y + oy;
      if (x < -260 || x > W + 260 || y < -300 || y > Hh + 300) { el.hidden = true; live.delete(row); }
    }
    for (let row = 0; row < total; row++) {
      const a = plan[row], x = a.x + ox, y = a.y + oy;
      if (x < -260 || x > W + 260 || y < -300 || y > Hh + 300) continue;
      let el = live.get(row);
      if (!el) {
        el = pool.find((c) => c.hidden) ?? (pool.length < CARD_POOL ? (pool[pool.push(makeCard(layer)) - 1]) : null);
        if (!el) continue;
        live.set(row, el);
        fillCard(el, entries[row], row === latestRow, entries[row].pinned);
        el.style.width = `${a.w}px`; el.dataset.side = a.side;
        el.classList.toggle("is-front", el.dataset.id === frontId);
        el.hidden = false;
      }
      el.style.transform = `translate3d(${Math.round(x)}px,${Math.round(y)}px,0)`;
    }
    if (empty) empty.style.transform = `translate3d(0,${Math.round(Hh / 2)}px,0)`;
  };

  // the milestone nearest the visitor: feeds the "n / total" label and Enter
  const hud = (dp) => {
    const best = total ? clamp(cardIndex(route.cuts, dp, total), 0, total - 1) : -1; // the card that is on the screen (the hand-off points are in route.cuts)
    activeRow = best;
    if (best !== shown) { shown = best; count.textContent = total ? `${topIsLatest ? total - best : best + 1} / ${total}` : ""; }
    thumb.style.transform = `translate3d(0,${Math.round(progress(dp, max) * (railH - 8))}px,0)`;
  };

  // ---- the loop ----
  const frame = (now) => {
    raf = 0;
    if (!running) return;
    const dt = clamp(now - (last || now - 16), 0, 64);
    last = now;
    let moving = false;
    if (glide) {
      const t = (now - glide.t0) / glide.dur;
      if (t >= 1) { pos = glide.to; glide = null; } else { pos = glide.from + (glide.to - glide.from) * (1 - Math.pow(1 - t, 3)); moving = true; }
    } else if (!drag) {
      if (pos < 0 || pos > max) { // past an end: spring back
        const to = pos < 0 ? 0 : max;
        pos += (to - pos) * (1 - Math.exp(-dt / 90)); vel = 0;
        if (Math.abs(pos - to) < 0.2) pos = to; else moving = true;
      } else if (Math.abs(vel) > 0.004) {
        pos += vel * dt; vel = friction(vel, dt); moving = true;
        if (pos < 0 || pos > max) { vel *= 0.4; pos = clamp(pos, -160, max + 160); }
      } else vel = 0;
    }
    const dp = rubber(pos, max);
    pointAt(route, dp, here);
    if (!camReady || reduced.matches) { cx = here.x; cy = here.y; camReady = true; }
    else if (Math.abs(here.x - cx) + Math.abs(here.y - cy) < 0.25) { cx = here.x; cy = here.y; }
    else { const k = 1 - Math.exp(-dt / CAM_MS); cx += (here.x - cx) * k; cy += (here.y - cy) * k; moving = true; }
    const idle = !moving && !drag && !dirty && now - lastMove > IDLE_MS;
    const breath = H.breathing && !reduced.matches && total > 0; // only the milestone plinths breathe now (the latest card is always one): with no cards nothing does, and the loop goes idle
    if (moving || drag || dirty || (breath && (!idle || now - lastDraw >= 33))) {
      draw(now, dp); placeCards(W / 2 - cx, Hh / 2 - cy); hud(dp);
      lastDraw = now; dirty = false;
      // quality guard: if full-rate frames average over budget for ~1 s, step down once (never below a still-good look)
      if (moving || drag) {
        slow += now - (slowT || now) || 0; slowN++; slowT = now;
        if (slowN >= 45) { const nq = nextQuality(quality, slow / slowN); slow = 0; slowN = 0; if (nq !== quality) { quality = nq; rebuild(); } }
      } else { slowT = 0; slow = 0; slowN = 0; }
    }
    if (moving || drag || dirty || breath) raf = requestAnimationFrame(frame);
    else last = 0;
  };
  const start = () => { const was = running; running = !document.hidden && view.classList.contains("on"); if (running && !was) { last = 0; slowT = 0; wake(); } else if (!running && raf) { cancelAnimationFrame(raf); raf = 0; } };

  // ---- movement (pos is the distance travelled along the road) ----
  const goTo = (to, dur) => {
    to = clampScroll(to, max); vel = 0;
    if (reduced.matches || dur <= 0) { glide = null; pos = to; wake(); return; }
    glide = { from: pos, to, t0: performance.now(), dur }; wake();
  };
  const push = (px_) => { // wheel / key impulse
    glide = null;
    if (reduced.matches) { pos = clampScroll(pos + px_ * pace, max); wake(); return; }
    if (px_ * vel < 0) vel = 0; // reversing: drop the old momentum so the road turns around at once
    vel = clamp(vel + (px_ * pace) / 260, -4 * pace, 4 * pace);
    wake();
  };

  // ---- input shared with the page change (script.js): the road keeps wheel, swipe and arrow keys, except at an end that the gesture points out of ----
  // view[data-hold] is what tells script.js "the road has this one". For a gesture that belongs to the page change it is switched off for the length of that
  // one event (passOn), so the page-changing code runs exactly as it does on every other page.
  const hold = (on) => (on ? view.setAttribute("data-hold", "") : view.removeAttribute("data-hold"));
  const passOn = () => { hold(false); clearTimeout(holdT); holdT = setTimeout(() => hold(true), 0); };
  const blocked = () => root.classList.contains("src-open") || root.classList.contains("is-intro") || document.getElementById?.("offline")?.hidden === false;
  const swipe = swipeTracker();
  let wmode = "road";            // what the wheel gesture in progress does: "road" moves it, "page" changes the page, "skip" is the tail of the swipe that opened the page
  let skipKey = opened?.key ?? "";  // the key that opened the page, while it is still held down (its repeats are not scrolling)
  let keyMode = "road";          // the same for the key press in progress
  if (opened?.wheel && !opened.wheel.notch && performance.now() - opened.wheel.t < 140) { swipe.seed(opened.wheel.t, opened.wheel.d); wmode = "skip"; } // a swipe is still arriving: only its tail waits

  // On the window, in the capture phase: the wheel works wherever the pointer rests (over the menu, say) with no pointer movement first.
  addEventListener("wheel", (e) => {
    if (e.ctrlKey || !view.classList.contains("on") || blocked() || e.target?.closest?.("textarea")) return; // browser zoom, or the page is not ours right now
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 300 : 1, dy = e.deltaY * unit;
    if (Math.abs(e.deltaX * unit) > Math.abs(dy) || Math.abs(dy) < 1) return; // a sideways swipe is not a scroll
    // a gesture is decided by its first event: at an end of the road and pointing out of it, it belongs to the page change; otherwise to the road
    if (swipe.feed(e.timeStamp, dy)) wmode = edgeFor(pos, max, Math.sign(dy)) ? "page" : "road";
    if (wmode === "page") { passOn(); return; }
    if (wmode === "road") push(wheelDelta(e.deltaY, e.deltaMode, Hh));
  }, { passive: false, capture: true, signal });

  stage.addEventListener("pointerdown", (e) => {
    if (e.button > 0 || drag) return;
    glide = null; vel = 0; dragged = false;
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t: e.timeStamp, v: 0, on: false };
  }, { signal });
  stage.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "touch") { const r = stage.getBoundingClientRect(); px = (e.clientX - r.left) / r.width * 2 - 1; py = (e.clientY - r.top) / r.height * 2 - 1; if (!reduced.matches) wake(); }
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.on && !drag.pass) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
      // a finger that starts at an end and moves out of the road is a page swipe (script.js), not a drag; a mouse can still pull the road past its end
      // (a mostly vertical move counts the way the page change counts it, up = on, whichever way the last stretch runs; a sideways one follows the road)
      pointAt(route, pos, dirAt);
      const mx = e.clientX - drag.x0, my = e.clientY - drag.y0;
      const out = Math.abs(my) > Math.abs(mx) ? (my < 0 ? 1 : -1) : Math.sign(-(mx * dirAt.dx + my * dirAt.dy));
      if (e.pointerType !== "mouse" && edgeFor(pos, max, out)) drag.pass = true;
    }
    if (drag.pass) { passOn(); return; }
    if (!drag.on) {
      drag.on = true; dragged = true;
      try { stage.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
      stage.classList.add("drag");
    }
    // the road moves with the finger: along the stretch under the visitor, whichever way it runs (down or sideways)
    pointAt(route, pos, dirAt);
    const fx = e.clientX - drag.x, fy = e.clientY - drag.y, dtm = Math.max(1, e.timeStamp - drag.t);
    const ds = -(fx * dirAt.dx + fy * dirAt.dy);
    drag.v = drag.v * 0.7 + (ds / dtm) * 0.3;
    drag.x = e.clientX; drag.y = e.clientY; drag.t = e.timeStamp;
    pos = clamp(pos + ds * (pos < 0 || pos > max ? 0.5 : 1), -200, max + 200);
    wake();
  }, { signal });
  const release = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (d.pass) passOn(); // the swipe may end right here: script.js decides on this event too
    stage.classList.remove("drag");
    try { stage.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (d.on && !reduced.matches && e.timeStamp - d.t < 80) vel = clamp(d.v, -3, 3);
    if (pos < 0 || pos > max) pos = clamp(pos, -200, max + 200);
    wake();
  };
  stage.addEventListener("pointerup", release, { signal });
  stage.addEventListener("pointercancel", release, { signal });
  stage.addEventListener("lostpointercapture", release, { signal });
  // a drag that ends on a link must not follow it
  stage.addEventListener("click", (e) => { if (dragged) { e.preventDefault(); e.stopPropagation(); dragged = false; } }, { capture: true, signal });

  addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !view.classList.contains("on") || blocked()) return;
    const t = e.target;
    if (t instanceof Element && (t.closest("input,textarea,select,[contenteditable]") || (t.closest("button,a") && (e.key === "Enter" || e.key === " ")))) return;
    const k = e.key, low = k.toLowerCase();
    if (SCROLL_KEYS.has(k)) {
      if (e.repeat && skipKey === low) { e.preventDefault(); return; } // the key that opened the page is still held: its repeats are not scrolling
      if (!e.repeat) skipKey = "";
      const dir = k === "ArrowDown" || low === "s" ? 1 : k === "ArrowUp" || low === "w" ? -1 : 0;
      // a fresh press at an end, pointing out of the road, belongs to the page change (a held key that began inside the road only rubber-bands)
      if (dir && !e.repeat) keyMode = edgeFor(pos, max, dir) ? "page" : "road";
      if (dir && keyMode === "page") { passOn(); return; }
    }
    let used = true;
    if (k === "ArrowDown" || k === "s" || k === "S") push(90);
    else if (k === "ArrowUp" || k === "w" || k === "W") push(-90);
    else if (k === "PageDown" || (k === " " && !e.shiftKey)) goTo(pos + Hh * 0.85, 450);
    else if (k === "PageUp" || (k === " " && e.shiftKey)) goTo(pos - Hh * 0.85, 450);
    else if (k === "Home") goTo(0, 700);
    else if (k === "End") goTo(max, 700);
    else if (k === "Enter" && activeRow >= 0 && entries[activeRow].link) window.open(entries[activeRow].link.url, "_blank", "noopener,noreferrer");
    else used = false;
    if (used) e.preventDefault();
  }, { capture: true, signal }); // before script.js's own key handler, which looks at view[data-hold] that this one has just set

  // Tab walks the list in timeline order; the road follows the focus and that card comes forward
  list?.addEventListener("focusin", (e) => {
    const id = e.target.closest?.("[data-id]")?.dataset.id;
    const row = entries.findIndex((x) => x.id === id);
    if (row < 0) return;
    goTo(nodeS[row + 1], 500);
    frontId = id;
    for (const el of live.values()) el.classList.toggle("is-front", el.dataset.id === id);
  }, { signal });
  list?.addEventListener("focusout", () => { frontId = ""; for (const el of live.values()) el.classList.remove("is-front"); }, { signal });

  // ---- lifecycle: resize, tab hidden, reduced motion ----
  let rz = 0;
  const ro = new ResizeObserver(() => { // the first call comes right after observe(): nothing changed then, so nothing is rebuilt mid-animation
    clearTimeout(rz);
    rz = setTimeout(() => { const [w, h] = measure(); if (w !== W || h !== Hh) rebuild(); }, 100);
  });
  ro.observe(stage);
  document.addEventListener("visibilitychange", start, { signal });
  reduced.addEventListener("change", () => { glide = null; vel = 0; wake(); }, { signal });

  // ---- open: size, build, resume where the visitor left off or glide in to the latest milestone ----
  sizeCanvas(); layout();
  const key = `${config.seed}|${total}|${config.direction}`;
  const target = total ? nodeS[latestRow + 1] : 0;
  // Read once, here: has this browser opened the Journey page before? Then remember the visit (so someone who never opens the page is still new later).
  // Which end is the start: with direction "latest-top" the latest card is near pos = 0 and the marker labelled startLabel is at the far end (pos = max);
  // with "latest-bottom" the start marker is at the top (pos = 0). startS() says which; the visitor starts on THAT marker, not on the "i am here" end.
  if (saved.key === key) { pos = fromProgress(saved.p, max); }   // left and came back during this page load: resume where they stopped
  else if (!seen) pos = openingPos(false, config.direction, max, target); // first visit: on the start marker, no glide; the story is travelled from its beginning
  else {
    pos = target; // a return visit: start on the current card at once (no opening glide, no fade-in)
  }
  stage.classList.add("is-in"); // no opening effect: the page is shown as it is
  session = { view, stage, list, canvas, layer, rail, count, spot, ctl, ro, key, get p() { return progress(pos, max); }, stop: () => { running = false; cancelAnimationFrame(raf); raf = 0; clearTimeout(rz); clearTimeout(holdT); } };
  start();
}

export function unmount() {
  if (!session) return;
  const { view, stage, list, canvas, layer, rail, count, spot, ctl, ro, key } = session;
  saved.key = key; saved.p = session.p;
  session.stop();
  session = null;
  ctl.abort();
  ro.disconnect();
  canvas.remove(); layer.remove(); rail.remove(); count.remove();
  spot.remove();
  stage.classList.remove("is-ready", "is-in", "drag");
  stage.removeAttribute("tabindex");
  list?.classList.remove("jy-sr");
  view.removeAttribute("data-hold");
  delete view.dataset.world;
}
