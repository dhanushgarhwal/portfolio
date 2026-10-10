// Journey core: pure functions only (no DOM, no canvas), so Node can test them. journey.js draws with them.
//   mulberry32      seeded random numbers: same seed, same road, forever
//   buildRoute      the road: straight stretches (straight down, sideways, or tilted so it zig-zags) joined by corners; every milestone sits on a
//                   corner. A stretch between two milestones is HALF the length at which one card leaves as the next arrives, so at least one and
//                   at most two cards are on the screen at every point of the road
//                   (DECISION: this newer rule replaces the earlier "exactly one card on the screen at all times"; the half distance is never
//                   lengthened back, a card that cannot be kept apart from its neighbour goes to the other side or steps out)
//   pointAt         where the road is after s pixels of travel (the camera follows this point)
//   cardPlan        which side of its corner a card sits on: whichever side keeps it clear of the road
//   exitAlong       how far the camera can travel before a card leaves the screen for good (the hand-off between two cards is built on it)
//   cardIndex       which card is nearest the dot at a distance s (the "n / total" label and the Enter key)
//   trailSegs       the bright trail: the part of the road between the start marker and the dot, as pieces of the legs cut to the screen
//   legSpan etc.    small geometry helpers (clip a stretch to a rectangle, distance to a stretch) shared by drawing, props and cards
//   clampScroll     hard finite bounds; rubber           soft stop past the bounds
//   visibleRange    which props are near the viewport (virtualisation)
//   wheelDelta      wheel units normalised (pixels, lines, pages)
//   swipeTracker    tells where one wheel / trackpad gesture ends and the next begins (same rules as the page-changing wheel in script.js)

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Safety floor for an inner stretch. The half hand-off length below is always longer on any real screen; it must never be cut short, or a card-less gap appears. */
export const MIN_GAP = 60;
/** A card's height when the page has not measured it: the half height the planner assumes is CARD_H / 2. */
export const CARD_H = 200;
const MIN_TURN = 22, MAX_TURN = 125; // degrees a corner must turn by: a real corner, but never a near U-turn back over the road
const RAD = Math.PI / 180;
const OVERLAP = 3;  // px by which the full hand-off length is shortened (never a moment with no card on the screen)
const KINDS = ["side", "tilt", "tilt", "down"]; // every bag of four stretches holds one sideways, two tilted and one straight-down stretch

const leg = (x, y, s, dx, dy, len) => {
  const x1 = x + dx * len, y1 = y + dy * len;
  return { s0: s, s1: s + len, x0: x, y0: y, dx, dy, bx0: Math.min(x, x1), bx1: Math.max(x, x1), by0: Math.min(y, y1), by1: Math.max(y, y1) };
};
const dirOf = (a) => (Math.abs(a) === 90 ? [Math.sign(a), 0] : [Math.sin(a * RAD), Math.cos(a * RAD)]);

/**
 * How far a screen of w x h, moving from (cx, cy) in the direction (dx, dy), still shows some of `box` ([x0, y0, x1, y1]) before it has left it
 * for good. The screen is centred on the camera, so the box is on it exactly while the camera is inside the box grown by half a screen each way.
 */
export function exitAlong(cx, cy, dx, dy, box, w, h) {
  let t = Infinity;
  if (dx > 1e-9) t = Math.min(t, (box[2] + w / 2 - cx) / dx); else if (dx < -1e-9) t = Math.min(t, (box[0] - w / 2 - cx) / dx);
  if (dy > 1e-9) t = Math.min(t, (box[3] + h / 2 - cy) / dy); else if (dy < -1e-9) t = Math.min(t, (box[1] - h / 2 - cy) / dy);
  return Math.max(0, t);
}

/**
 * The road, in world pixels (y grows downward), measured by distance travelled: s = 0 is the start marker, s = total the end marker.
 * It is a list of legs, each a straight line: straight down, sideways, or tilted to some angle (so with the next leg it zig-zags). Every
 * milestone sits on a corner, so a leg is simply the stretch between two milestones. The road never runs upward, and the first stretch runs
 * straight down. The stretches are dealt from bags (one sideways, two tilted, one straight down, in a seeded order) so every road has all
 * three kinds, whatever its seed, and the kinds follow the corner rules (a corner turns by a real amount, tilts alternate).
 *
 * One or two cards on the screen, always. The camera sits on the road point under the visitor, so a card is on the screen while the camera is
 * inside the card's box grown by half a screen each way. The full hand-off length of a stretch is what the first card needs to leave the screen
 * (measured from its corner, along the stretch) plus what the second needs to arrive (measured back from its corner): at that length one card
 * leaves exactly as the next arrives. A stretch between two milestones is HALF of that, so the two cards share the screen for about half of every
 * stretch and there is never a stretch with no card. The clash check refuses a heading that would put a third card (or an old one) on the screen.
 * Neighbouring cards go on opposite sides of the road where the geometry allows. The first stretch ends with the first card already in view, the
 * last one keeps the last card in view.
 *   view   the screen size the road is made for           cards[i]   how card i + 1 is placed and how tall it is: { viewW, gap, max, min, edge, grow, hh }
 *   amplitude   how far the road may wander from the middle
 * (content.json also carries "spacing", "jitter" and "curviness". The gaps now come from the screen and the cards, so they are accepted and ignored.)
 * Returns { legs, nodeS, total, bounds, points, plans, cuts }: points[i] is the position of node i (0 = start marker, last = end marker),
 * plans[i] the card of node i + 1 ({ side, w, x, y, hh }), cuts[i] the distance halfway between card i + 1 and card i + 2 (where the nearest card changes).
 * Same seed + same screen + same cards = same road, and adding milestones never moves earlier ones.
 */
export function buildRoute({ seed, nodes, amplitude, view = { w: 1280, h: 800 }, cards }) {
  const N = Math.max(0, nodes), W = view.w, H = view.h;
  const rl = mulberry32((seed ^ 0x51ed270b) >>> 0), rk = mulberry32((seed ^ 0x2545f491) >>> 0);
  const reach = 560 + 380 * clamp(amplitude, 0, 1);
  const optsOf = (row) => ({ viewW: W, gap: 28, max: 210, min: 150, edge: 14, grow: 1, hh: CARD_H / 2, ...(cards?.[row - 1] ?? {}) });

  // ---- the order of the stretches: a seeded bag of kinds at a time, so the start of a road never depends on how long it is ----
  const kinds = ["down"];
  let owe = false; // a planned sideways (or the only tilted) stretch could not be laid (it would have put a third card on the screen): the next bag brings that kind forward
  // a sideways stretch always follows a straight-down one (arriving on a tilt, it would double back under the road it has just run, which on a narrow screen puts
  // an earlier card on the screen again); two straight-down or two sideways stretches in a row are not a corner
  const dealt = (last, bag) => (!owe || bag.slice(0, 2).includes(owe)) && bag.every((kind, i) => { const p = i ? bag[i - 1] : last; return (kind !== "side" || p === "down") && !(kind === "down" && p === "down") && !(kind === "side" && p === "side"); });
  const kindAt = (k) => {
    while (kinds.length <= k) {
      const last = kinds[kinds.length - 1];
      let bag = [];
      for (let t = 0; t < 48; t++) {
        bag = KINDS.slice();
        for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(rk() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
        if (dealt(last, bag)) break;
      }
      kinds.push(...bag);
      owe = false;
    }
    return kinds[k];
  };
  const draws = [];
  const drawOf = (k) => { while (draws.length <= k) draws.push([rl(), rl()]); return draws[k]; }; // a fixed number of draws per stretch

  // ---- the headings stretch k may take, best first (degrees from straight down, + = to the right), from where the road is and how it ran last ----
  const options = (k, x, prev, lean0) => {
    const [v, w] = drawOf(k);
    const lean = x > reach ? -1 : x < -reach ? 1 : w < 0.68 ? -lean0 : lean0; // back towards the middle when far out, otherwise mostly the other way
    if (k === 0) return { list: [0], lean };
    const kind = kindAt(k), small = kindAt(k - 1) === "side" || kindAt(k + 1) === "side"; // a tilt beside a sideways stretch must be gentle
    const turn = (t) => Math.abs(t - prev);
    // a corner must turn by a real amount, and a bend never keeps leaning the same way (that would put the road on both sides of the card)
    const bend = (t) => turn(t) >= MIN_TURN && turn(t) <= MAX_TURN && t * prev <= 0;
    const ok = (t) => bend(t) && !(x > reach && t > 0) && !(x < -reach && t < 0); // and, when far out, not further out
    const mag = small ? 24 + 10 * v : 24 + 38 * v;
    const want = kind === "down" ? [0] : kind === "side" ? [lean * 90, -lean * 90] : [lean * mag, -lean * mag];
    const alts = [lean * 40, -lean * 40, 0, lean * 30, -lean * 30, lean * 65, -lean * 65, lean * 90, -lean * 90, lean * 52, -lean * 52, lean * 24, -lean * 24];
    const list = [];
    for (const group of [want.filter(ok), want.filter(bend), alts.filter(ok), alts.filter(bend)]) for (const t of group) if (!list.includes(t)) list.push(t);
    return { list: list.length ? list : [0], lean };
  };
  const decide = (k, x, prev, lean0) => { const o = options(k, x, prev, lean0); return { a: o.list[0], lean: o.lean }; };

  // ---- the card at a corner, seen from the corner itself (so it can be worked out before the corner's place is known) ----
  const boxOf = (c, hh) => [c.x, c.y - hh, c.x + c.w, c.y + hh];
  const other = (side) => (side === "left" ? "right" : side === "right" ? "left" : null);
  const cardAfter = (row, din, lin, dout, prefer) => { // din: the way the road arrives (length lin), dout: the way it leaves, if there is a next stretch
    const o = optsOf(row), near = [leg(-din[0] * lin, -din[1] * lin, 0, din[0], din[1], lin)];
    if (dout) near.push(leg(0, 0, 0, dout[0], dout[1], 1200));
    const c = cardPlanAt({ x: 0, y: 0 }, near, { ...o, prefer });
    const b = boxOf(c, o.hh); b.side = c.side;
    return b;
  };
  const region = (b, ox = 0, oy = 0) => [b[0] + ox - W / 2, b[1] + oy - H / 2, b[2] + ox + W / 2, b[3] + oy + H / 2]; // camera positions that show a box
  const span = {};
  const inside = (L, q) => (legSpan(L, q[0], q[1], q[2], q[3], span) ? Math.max(0, span.b - span.a - 2) : 0); // px of a stretch inside a region (the first 2 are forgiven)

  const legs = [], nodeS = [0], cuts = [], points = [{ x: 0, y: 0 }], seen = [], sides = []; // seen[j]: the region in which card j is on the screen
  let x = 0, y = 0, s = 0, prevA = 0, leanK = rl() < 0.5 ? -1 : 1;

  // stretch k heading a: how long it must be, and what that does to the corner it ends at
  const solve = (k, a, lean, scale = 1) => {
    const [dx, dy] = dirOf(a);
    let nxt = k < N ? decide(k + 1, x + dx * 1100, a, lean) : null; // the next heading is needed for the card at the end of this stretch ...
    let r = null;
    for (let pass = 0; pass < 4; pass++) {                           // ... and it depends on where this stretch ends: settle both together
      const dn = nxt ? dirOf(nxt.a) : null;
      let L = 1200, len = 0, exit = 0, entry = 0, mine = null, next = null;
      for (let i = 0; i < 3; i++) {
        if (N === 0) { len = H + 200; break; }
        if (k === 0) { // the start: the first card is already in view (about halfway to the point where it would arrive)
          next = cardAfter(1, [dx, dy], L, dn, null);
          entry = exitAlong(0, 0, -dx, -dy, next, W, H);
          len = clamp(entry * 0.5, 90, Math.max(90, entry - 40));
        } else {
          const here = optsOf(k);
          const pl = cardPlanAt({ x, y }, [legs[k - 1], leg(x, y, s, dx, dy, L)], { ...here, prefer: other(sides[k - 1]) });
          mine = boxOf(pl, here.hh); mine.side = pl.side;
          exit = exitAlong(x, y, dx, dy, mine, W, H);
          if (k === N) len = clamp(exit * 0.5, 90, Math.max(90, exit - 40)); // the end: the last card is still in view
          else {
            next = cardAfter(k + 1, [dx, dy], L, dn, other(mine.side));
            entry = exitAlong(0, 0, -dx, -dy, next, W, H);
            len = Math.max(MIN_GAP, (exit + entry - OVERLAP) / 2 * scale); // half the hand-off length: two cards share the screen for about half the stretch
            // A sideways stretch keeps the camera level with its corner for its whole length, so the stretch before it must be just long enough for its own card to be gone by
            // that corner, and the one after it long enough for the next card not to be on the screen yet (otherwise a third card would share the sideways stretch).
            // This adds a few px at most (the card heights differ a little), never anything near the old length.
            // The sideways stretch itself is as long as the longer of the two: its own card is gone at its far end and the next card is not yet on the screen at its start, so
            // the stretch holds exactly the two cards of its corners (here the exits differ by the card widths, so it is the one place that is more than half the hand-off).
            if (Math.abs(a) === 90) len = Math.max(len, exit + 3, entry + 3);
            if (kindAt(k + 1) === "side") len = Math.max(len, exit + 3);
            if (kinds[k - 1] === "side") len = Math.max(len, entry + 3);
          }
        }
        if (Math.abs(len - L) < 0.5) break;
        L = len;
      }
      r = { a, dx, dy, len, exit, entry, mine, next, lean };
      if (!nxt) break;
      const again = decide(k + 1, x + dx * len, a, lean);
      if (again.a === nxt.a) break;
      nxt = again;
    }
    return r;
  };
  // px of a stretch where more than two of the given card regions are on the screen together (the 4 px at each end are forgiven)
  const ev = [];
  const crowd = (L, regs) => {
    ev.length = 0;
    for (const q of regs) if (legSpan(L, q[0], q[1], q[2], q[3], span) && span.b - span.a > 8) ev.push([span.a + 4, 1], [span.b - 4, -1]);
    ev.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    let c = 0, bad = 0, at = 0;
    for (const [p, d] of ev) { if (c > 2) bad += p - at; c += d; at = p; }
    return bad;
  };
  // where the screen of card k + 2 would be if stretch k were laid this way and the road went on with its best next heading (a look ahead of one stretch)
  const ahead = (k, t) => {
    if (k + 2 > N || !t.next) return null;
    const sx = x, sy = y, ss = s;
    legs.push(leg(x, y, s, t.dx, t.dy, t.len)); x += t.dx * t.len; y += t.dy * t.len; s += t.len;
    const nd = decide(k + 1, x, t.a, t.lean), u = solve(k + 1, nd.a, nd.lean);
    const q = u.next ? region(u.next, x + u.dx * u.len, y + u.dy * u.len) : null;
    legs.pop(); x = sx; y = sy; s = ss;
    return q;
  };
  // how much of the road this stretch would put on the screens of cards it must not meet: never three cards at once, and a card that is not a
  // neighbour never comes back on the screen
  const clash = (k, t) => {
    const L = leg(x, y, s, t.dx, t.dy, t.len);
    const regs = seen.slice(1, k);
    if (k >= 1) regs.push(region(t.mine));
    const q = k < N && t.next ? region(t.next, x + t.dx * t.len, y + t.dy * t.len) : null;
    if (q) regs.push(q);
    const q2 = ahead(k, t); // the card after the next one, if the road went on the way it most likely will
    if (q2) regs.push(q2);
    let bad = crowd(L, regs);
    if (q) for (let i = 0; i < k - 1; i++) bad += inside(legs[i], q); // legs far behind never meet the next card
    for (let j = 1; j < k - 1; j++) bad += inside(L, seen[j]);
    if (q) for (let i = Math.max(0, k - 3); i < k; i++) bad += crowd(legs[i], regs);
    return bad;
  };

  for (let k = 0; k <= N; k++) {
    const o = options(k, x, prevA, leanK);
    let pick = null;
    // each heading is tried at the half length first; only where that would put a third card on the screen is the stretch lengthened (never past 1.5 x half)
    // The one exception: the first tilted stretch of a road on a very narrow screen, where a tilt always brings a third card with it at half length (every road must hold all three kinds).
    const first = kinds[k] === "tilt" && !kinds.slice(0, k).includes("tilt");
    const scales = k >= 1 && k < N ? (first ? [1, 1.12, 1.25, 1.4, 1.5, 1.7, 2, 2.4] : [1, 1.12, 1.25, 1.4, 1.5]) : [1];
    search: for (const a of o.list) for (const f of scales) {
      const t = solve(k, a, o.lean, f);
      t.bad = clash(k, t);
      if (!pick || t.bad < pick.bad) pick = t;
      if (!t.bad) break search;
    }
    const { dx, dy, len, mine } = pick;
    if (kinds[k] === "side" && Math.abs(pick.a) !== 90) { kinds.length = k; kinds.push(pick.a === 0 ? "down" : "tilt"); owe = "side"; } // plan it again, soon
    else if (kinds[k] === "tilt" && (pick.a === 0 || Math.abs(pick.a) === 90) && !kinds.slice(0, k).includes("tilt")) { kinds.length = k; kinds.push(pick.a === 0 ? "down" : "side"); owe = "tilt"; }
    if (k >= 1) { seen[k] = region(mine); sides[k] = mine.side; }
    legs.push(leg(x, y, s, dx, dy, len));
    x += dx * len; y += dy * len; s += len; prevA = pick.a; leanK = pick.lean;
    points.push({ x, y }); nodeS.push(s);
  }
  const bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  for (const p of points) { bounds.minX = Math.min(bounds.minX, p.x); bounds.maxX = Math.max(bounds.maxX, p.x); bounds.maxY = Math.max(bounds.maxY, p.y); }
  for (let r = 1; r < N; r++) cuts.push((nodeS[r] + nodeS[r + 1]) / 2); // the nearest card changes halfway between two milestones
  const route = { legs, nodeS, total: s, bounds, points, plans: [], cuts };
  for (let row = 1; row <= N; row++) route.plans.push({ ...cardPlan(route, row, { ...optsOf(row), prefer: other(route.plans[row - 2]?.side) }), hh: optsOf(row).hh });
  return route;
}

/** Which card (0-based row) is nearest the dot at distance s (cuts lie halfway between two milestones). -1 when there are no cards. */
export function cardIndex(cuts, s, total) {
  if (total < 1) return -1;
  let a = 0, b = cuts.length;
  while (a < b) { const m = (a + b) >> 1; if (cuts[m] <= s) a = m + 1; else b = m; }
  return a;
}

/**
 * The part of a leg inside a rectangle, as distances along the leg: out.a .. out.b. Returns false when the leg misses the rectangle.
 * (Slab clipping: works for any direction, so drawing, collision tests and cards all share it.)
 */
export function legSpan(L, rx0, ry0, rx1, ry1, out = {}) {
  let a = 0, b = L.s1 - L.s0;
  if (L.dx) { const t0 = (rx0 - L.x0) / L.dx, t1 = (rx1 - L.x0) / L.dx; a = Math.max(a, Math.min(t0, t1)); b = Math.min(b, Math.max(t0, t1)); }
  else if (L.x0 < rx0 || L.x0 > rx1) return false;
  if (L.dy) { const t0 = (ry0 - L.y0) / L.dy, t1 = (ry1 - L.y0) / L.dy; a = Math.max(a, Math.min(t0, t1)); b = Math.min(b, Math.max(t0, t1)); }
  else if (L.y0 < ry0 || L.y0 > ry1) return false;
  out.a = a; out.b = b;
  return b > a;
}

/** Distance from a point to a leg (the line segment between its two corners). */
export function distToLeg(L, x, y) {
  const t = clamp((x - L.x0) * L.dx + (y - L.y0) * L.dy, 0, L.s1 - L.s0);
  return Math.hypot(x - (L.x0 + L.dx * t), y - (L.y0 + L.dy * t));
}

const _span = {};
/** Distance from a rectangle to a leg: 0 when they touch. */
export function boxToLeg(L, x0, y0, x1, y1) {
  if (legSpan(L, x0, y0, x1, y1, _span)) return 0;
  const len = L.s1 - L.s0, ax = L.x0, ay = L.y0, bx = ax + L.dx * len, by = ay + L.dy * len;
  return Math.min(
    distToLeg(L, x0, y0), distToLeg(L, x1, y0), distToLeg(L, x0, y1), distToLeg(L, x1, y1),
    Math.hypot(Math.max(x0 - ax, 0, ax - x1), Math.max(y0 - ay, 0, ay - y1)), Math.hypot(Math.max(x0 - bx, 0, bx - x1), Math.max(y0 - by, 0, by - y1)),
  );
}

/** Position on the road after s pixels of travel, with the direction of its leg. Before the start and past the end it carries straight on. */
export function pointAt(route, s, out = {}) {
  const legs = route.legs;
  let a = 0, b = legs.length - 1;
  while (a < b) { const m = (a + b + 1) >> 1; if (legs[m].s0 <= s) a = m; else b = m - 1; }
  const L = legs[a], d = s - L.s0;
  out.x = L.x0 + L.dx * d; out.y = L.y0 + L.dy * d; out.dx = L.dx; out.dy = L.dy; out.leg = a;
  return out;
}

/** Fractional milestone index of a travelled distance: 3.5 = halfway between node 3 and node 4. */
export function routeIndex(nodeS, s) {
  const last = nodeS.length - 1;
  if (s <= 0 || last < 1) return 0;
  if (s >= nodeS[last]) return last;
  let a = 0, b = last;
  while (a < b - 1) { const m = (a + b) >> 1; if (nodeS[m] <= s) a = m; else b = m; }
  return a + (s - nodeS[a]) / (nodeS[b] - nodeS[a]);
}

/**
 * Where the card of route.points[row] (a corner) goes: left or right of the milestone, centred on it vertically, on whichever side keeps
 * its box (hh = half its height) at least `clear` from the road. Both stretches that meet at the corner are checked, so a tilted road
 * is handled as well as a straight one; when a side needs a little more room the card steps out (up to 28px) rather than touch the road.
 * Returns { side, x, y, w }: (x, y) is the left edge and vertical middle the page positions the card by. The width fits half the screen,
 * like the road, which is always in the middle. grow makes the card wider (the latest one), still within the screen.
 */
export function cardPlan(route, row, opts) {
  return cardPlanAt(route.points[row], [route.legs[row - 1], route.legs[row]].filter(Boolean), opts);
}

/** The same for a corner given by its point and the (one or two) stretches that meet there. */
export function cardPlanAt(p, near, { viewW, gap = 28, max = 210, min = 150, edge = 14, grow = 1, hh = 100, clear = 26, prefer = null }) {
  let best = null;
  for (const side of ["left", "right"]) for (const step of [0, 14, 28]) {
    const g = gap + step, w = Math.max(min, Math.min(max * grow, viewW / 2 - g - edge));
    const x = side === "right" ? p.x + g : p.x - g - w;
    const d = Math.min(...near.map((L) => boxToLeg(L, x, p.y - hh, x + w, p.y + hh)));
    const c = { side, w, x, y: p.y, d, ok: d >= clear, step, pref: side === prefer ? 0 : 1 };
    // a side that clears the road wins: the preferred side (opposite to the previous card) first, then nearest, then the roomier one; if none clears, the roomiest
    const better = (a, b) => a.pref < b.pref || (a.pref === b.pref && (a.step < b.step || (a.step === b.step && a.d > b.d)));
    if (!best || (c.ok && (!best.ok || better(c, best))) || (!best.ok && !c.ok && d > best.d)) best = c;
  }
  return { side: best.side, w: best.w, x: best.x, y: best.y };
}

/** The widest a card can be (the plan can only make it narrower by stepping out), so a card can be measured before it is placed. */
export const cardWidth = (viewW, { gap = 28, max = 210, min = 150, edge = 14, grow = 1 } = {}) => Math.max(min, Math.min(max * grow, viewW / 2 - gap - edge));

/** How many different prop drawings journey.js has (kinds 0 .. PROP_KINDS - 1). */
export const PROP_KINDS = 14;

/**
 * Seeded props kept clear of the road, spread over the road's bounding box plus `margin` on every side. Returns a flat array of
 * {x,y,r,kind,v}, sorted by y. Kinds are dealt from shuffled bags going down the world: every kind once per PROP_KINDS props, and never
 * the same kind within three props of itself, so the scenery keeps changing instead of repeating.
 */
export function buildProps({ seed, route, roadWidth, count, margin = 900 }) {
  const rnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const out = [];
  const { minX, maxX, minY, maxY } = route.bounds;
  const w = maxX - minX + margin * 2, h = maxY - minY + margin * 2;
  const clear = roadWidth * 0.5 + 34;
  let tries = 0;
  while (out.length < count && tries++ < count * 12) {
    const x = minX - margin + rnd() * w, y = minY - margin + rnd() * h, r = 5 + rnd() * 9, v = rnd();
    const c = clear + r; // the box test is only a quick way out: a tilted leg's box is mostly empty, so the real distance decides
    const ok = route.legs.every((L) => x < L.bx0 - c || x > L.bx1 + c || y < L.by0 - c || y > L.by1 + c || distToLeg(L, x, y) >= c);
    if (ok) out.push({ x, y, r, kind: 0, v });
  }
  out.sort((a, b) => a.y - b.y);
  const shuffled = () => {
    const bag = Array.from({ length: PROP_KINDS }, (_, i) => i);
    for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
    return bag;
  };
  let bag = [], recent = [];
  for (const p of out) {
    if (!bag.length) { // a fresh bag whose next three (taken from the end) differ from the last three dealt; a few tries are always enough
      bag = shuffled();
      for (let tries2 = 0; tries2 < 12 && bag.slice(-3).some((k) => recent.includes(k)); tries2++) bag = shuffled();
    }
    p.kind = bag.pop();
    recent = [...recent.slice(-2), p.kind];
  }
  return out;
}

/**
 * The bright trail: the road between distances `a` and `b` (a <= b; one of them is the start marker, the other the dot), as pieces of the road's legs cut to
 * the rectangle rect = [x0, y0, x1, y1] (the screen, in world pixels). Each piece is written into `out` (a reused Float64Array holding 5 numbers per leg:
 * ax, ay, bx, by, chain) and the number of pieces is returned. chain is 1 when the piece carries straight on from the end of the one before, so the caller
 * can draw one continuous polyline (corners joined) with moveTo / lineTo. Nothing is allocated here. The pieces run in road order (a to b), so the trail
 * begins exactly at distance a and ends exactly at distance b, whatever the rectangle.
 */
const _tspan = {}, _piece = { s0: 0, s1: 0, x0: 0, y0: 0, dx: 0, dy: 0 };
export function trailSegs(route, a, b, rect, out) {
  const lo = clamp(Math.min(a, b), 0, route.total), hi = clamp(Math.max(a, b), 0, route.total);
  if (hi - lo < 1e-6) return 0;
  const legs = route.legs;
  let first = 0, last = legs.length - 1;
  while (first < last) { const m = (first + last + 1) >> 1; if (legs[m].s0 <= lo) first = m; else last = m - 1; }
  let n = 0, prevEnd = -1; // prevEnd: the distance at which the previous piece ended, when it ended on screen
  for (let i = first; i < legs.length; i++) {
    const L = legs[i];
    if (L.s0 >= hi) break;
    const s0 = Math.max(L.s0, lo), s1 = Math.min(L.s1, hi);
    if (s1 <= s0) continue;
    const ax0 = L.x0 + L.dx * (s0 - L.s0), ay0 = L.y0 + L.dy * (s0 - L.s0);
    // clip the piece to the screen: it is a segment starting at (ax0, ay0) heading (dx, dy) for s1 - s0
    _piece.s1 = s1 - s0; _piece.x0 = ax0; _piece.y0 = ay0; _piece.dx = L.dx; _piece.dy = L.dy;
    if (!legSpan(_piece, rect[0], rect[1], rect[2], rect[3], _tspan)) { prevEnd = -1; continue; }
    const t0 = _tspan.a, t1 = _tspan.b, o = n * 5;
    out[o] = ax0 + L.dx * t0; out[o + 1] = ay0 + L.dy * t0; out[o + 2] = ax0 + L.dx * t1; out[o + 3] = ay0 + L.dy * t1;
    out[o + 4] = prevEnd === s0 && t0 === 0 ? 1 : 0;
    prevEnd = t1 === s1 - s0 ? s1 : -1;
    n++;
  }
  return n;
}

/**
 * Where the visitor starts, and which part of the road is the trail. `start` is the distance of the marker labelled startLabel:
 * with direction "latest-top" the latest card is at the top (near s = 0) and the start marker is at the far end (s = total);
 * with "latest-bottom" the start marker is at the top (s = 0).
 */
export const startS = (direction, total) => (direction === "latest-top" ? total : 0);

/**
 * Where the bright trail begins. A new visitor's trail begins at the start marker; a returning visitor's begins at the "i am here" marker, the other
 * end of the road (the end where the latest card is: s = 0 with \"latest-top\", s = total with \"latest-bottom\").
 */
export const trailOrigin = (seen, direction, total) => (seen ? total - startS(direction, total) : startS(direction, total));

/**
 * The first position of a visit. A new visitor starts ON the start marker; a returning one on the current card.
 * `seen` is the decision read from the cookie (true = has opened the Journey page before).
 */
export const openingPos = (seen, direction, total, latestS) => (seen ? latestS : startS(direction, total));

/** Hard clamp: the distance travelled is always inside [0, max]. */
export const clampScroll = (pos, max) => (Number.isFinite(pos) ? clamp(pos, 0, max) : 0);

/** Soft stop: past an edge the overshoot is compressed (never more than `limit` px), inside it is unchanged. */
export function rubber(pos, max, limit = 90) {
  if (pos < 0) return -limit * (1 - 1 / (1 + -pos / limit));
  if (pos > max) return max + limit * (1 - 1 / (1 + (pos - max) / limit));
  return pos;
}

/** Pixels from a wheel event: deltaMode 0 pixels, 1 lines, 2 pages. */
export const wheelDelta = (dy, mode, viewH) => (mode === 1 ? dy * 32 : mode === 2 ? dy * viewH : dy);

/** Index range [from, to] of sorted-by-y items intersecting [top - margin, top + viewH + margin]. -1,-1 when none. */
export function visibleRange(ys, top, viewH, margin) {
  const lo = top - margin, hi = top + viewH + margin;
  let a = 0, b = ys.length;
  while (a < b) { const m = (a + b) >> 1; if (ys[m] < lo) a = m + 1; else b = m; }
  let e = a;
  while (e < ys.length && ys[e] <= hi) e++;
  return a === e ? [-1, -1] : [a, e - 1];
}

/** Progress 0..1 of a position; and back. Used to keep the place when the width changes. */
export const progress = (pos, max) => (max > 0 ? clamp(pos / max, 0, 1) : 0);
export const fromProgress = (p, max) => clamp(p, 0, 1) * max;

/** Momentum step: returns new velocity (px/ms) after dt ms of friction. */
export const friction = (v, dt) => v * Math.exp(-dt / 325);

/** Frame-time based quality step: 0 best .. 2 lowest. Moves one step at a time. */
export const nextQuality = (q, avgMs, budget = 14) => (avgMs > budget * 1.4 && q < 2 ? q + 1 : q);

/** "[[bold]]" and "[[label|https://..]]" markers -> [{ t, url? , hi }]. Only http(s) links survive; anything else stays plain text. */
export function splitMarks(text) {
  const out = [];
  const re = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  let i = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > i) out.push({ t: text.slice(i, m.index), hi: false });
    const url = m[2] && /^https?:\/\//i.test(m[2]) ? m[2] : "";
    out.push(m[2] && !url ? { t: m[1], hi: true } : url ? { t: m[1], hi: true, url } : { t: m[1], hi: true });
    i = m.index + m[0].length;
  }
  if (i < text.length) out.push({ t: text.slice(i), hi: false });
  return out;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** "2024-05" -> "may 2024" (same wording as the server-rendered list). */
export function dateLabel(date) {
  const [y, m, d] = String(date).split("-");
  return [d ? String(+d) : "", m && MONTHS[+m - 1] ? MONTHS[+m - 1] : "", y].filter(Boolean).join(" ");
}

/**
 * Where one wheel / trackpad gesture ends and the next begins: the same rules the page-changing wheel in script.js uses. An event starts a new
 * gesture after a pause (more than GAP ms), when the direction changes, or when the speed climbs again after the old swipe had died down (a new swipe
 * made on top of the previous swipe's momentum tail). feed(now, delta) returns true for the event that starts a gesture. seed(now, delta) loads the
 * last event seen before the tracker existed (the swipe that opened the page), so its tail is not mistaken for a new gesture.
 */
export function swipeTracker({ gap = 140, rise = 2.5, risePx = 12, decayed = 0.5 } = {}) {
  let last = -Infinity, sign = 0, peak = 0, low = 0;
  const feed = (now, d) => {
    const ad = Math.abs(d), sg = Math.sign(d), pause = now - last;
    last = now;
    const fresh = sg !== sign || pause > gap || (low <= peak * decayed && ad >= low * rise && ad - low >= risePx);
    if (fresh) { peak = ad; low = ad; } else if (ad >= peak) { peak = ad; low = ad; } else if (ad < low) low = ad;
    sign = sg;
    return fresh;
  };
  return { feed, seed: feed, get last() { return last; } };
}

/** How the page treats a wheel gesture that starts now: it moves the road, or (road already at that end) it changes the page. */
export const edgeFor = (pos, max, dir) => (dir > 0 && pos >= max - 0.5) || (dir < 0 && pos <= 0.5);
