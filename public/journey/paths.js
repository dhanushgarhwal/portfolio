// Journey side roads: the paths that were never taken. Pure geometry (no DOM, no canvas) so Node can test it; journey.js draws it.
//
//   buildBranches   from the main road, picks stretches long enough for a junction and grows side roads out of them:
//                   a T (one side road) or a four-way crossing (one on each side). Side roads run to the edge of the world,
//                   zig-zag on the way (a kink up or down), or turn and run along the right-hand edge to a dead end.
//   ALT_PATHS       placeholder labels for those roads. They are the text that will later tell what would have happened on that path.
//
// Everything is seeded (same seed = same side roads) from its own random stream, so the main road and its scenery never move.

import { clamp, mulberry32 } from "./core.js";

/** Placeholder "what if" lines, shown in a seeded order. Replace with the real stories later. */
export const ALT_PATHS = [
  "not taken: art school", "not taken: a year abroad", "not taken: a band", "not taken: game dev only",
  "not taken: a gap year", "not taken: the family shop", "not taken: a startup at 19", "not taken: sleeping in",
  "not taken: a mountain village", "not taken: endless scrolling", "not taken: film school", "not taken: a pilot licence",
  "not taken: a chess career", "not taken: a quiet job", "not taken: moving cities", "not taken: giving up",
];

const PER = 10; // samples per stretch of a side road

/** Catmull-Rom through pts [{x,y}]; t 0 = straight lines with hard corners .. 1 = full spline. Returns a flat [x0,y0,x1,y1..]. */
function spline(pts, t) {
  const n = pts.length, out = new Float32Array(((n - 1) * PER + 1) * 2);
  const P = (i) => pts[clamp(i, 0, n - 1)];
  let k = 0;
  for (let i = 0; i < n - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let s = 0; s < PER; s++) {
      const u = s / PER, u2 = u * u, u3 = u2 * u;
      const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
      const lx = p1.x + (p2.x - p1.x) * u, ly = p1.y + (p2.y - p1.y) * u;
      out[k++] = lx + (cr(p0.x, p1.x, p2.x, p3.x) - lx) * t;
      out[k++] = ly + (cr(p0.y, p1.y, p2.y, p3.y) - ly) * t;
    }
  }
  out[k++] = pts[n - 1].x; out[k] = pts[n - 1].y;
  return out;
}

/**
 * Side roads for a main road built by buildPath.
 * Returns { junctions: [{x, y, cross}], arms: [{ x, y, d, pts, top, bottom, dead, label, lx, ly, align }] }:
 *   (x, y)   the junction on the main road; d = -1 (left) or 1 (right); pts = flat samples starting exactly at (x, y)
 *   top/bottom   the arm's y extent (for culling); dead = {x, y} when the arm ends in a dead end, otherwise null (it runs off the screen)
 *   label    text for the road (or null when there is no room for it); lx, ly, align = where to write it
 */
export function buildBranches({ seed, path, spacing, roadWidth }) {
  const rnd = mulberry32((seed ^ 0x7f4a7c15) >>> 0);
  const { points, samples, width: W, height: H, per } = path;
  const labels = ALT_PATHS.slice();
  for (let i = labels.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [labels[i], labels[j]] = [labels[j], labels[i]]; }
  let next = 0;
  const arms = [], junctions = [];

  for (let i = 0; i < points.length - 1; i++) {
    const dy = points[i + 1].y - points[i].y;
    const chance = rnd(), cross = rnd() < 0.4, flip = rnd() < 0.5; // the same three draws for every stretch, used or not
    if (dy < spacing * 0.85 || chance > 0.6) continue;             // short stretches stay plain: a junction needs room for the cards around it
    const at = i * per + (per >> 1), jx = samples[at * 2], jy = samples[at * 2 + 1];
    junctions.push({ x: jx, y: jy, cross });

    for (const d of cross ? [-1, 1] : [flip ? -1 : 1]) {
      const edgeX = d > 0 ? W + 80 : -80, room = Math.abs(edgeX - jx), lim = Math.min(120, dy * 0.3);
      const lead = { x: jx + d * (roadWidth + 14), y: jy };         // leaves the main road straight before it bends
      const shape = rnd(), v1 = rnd(), v2 = rnd(), v3 = rnd();
      const deadX = clamp(W / 2 + 300 + v1 * 110, lead.x + 40, W - 22);
      let pts, t, dead = null;
      if (d > 0 && shape < 0.4 && deadX - lead.x > 40) {            // turns and runs along the right-hand side to a dead end
        const endY = clamp(jy + (v2 < 0.5 ? -1 : 1) * (220 + v3 * 200), 60, H - 60);
        dead = { x: deadX, y: endY };
        pts = [{ x: jx, y: jy }, lead, { x: deadX, y: jy }, dead]; t = 0.12;
      } else if (shape < 0.7) {                                     // kink: out, a sharp turn up or down, on to the edge
        const xt = jx + d * room * (0.3 + 0.25 * v1), D = (v2 < 0.5 ? -1 : 1) * lim * (0.6 + 0.4 * v3);
        pts = [{ x: jx, y: jy }, lead, { x: xt, y: jy }, { x: xt + d * 46, y: jy + D }, { x: edgeX, y: jy + D * 0.8 }]; t = 0.15;
      } else {                                                      // run: a long soft curve to the edge
        pts = [{ x: jx, y: jy }, lead, { x: jx + d * room * 0.5, y: jy + (v1 - 0.5) * 1.2 * lim }, { x: edgeX, y: jy + (v2 - 0.5) * 2 * lim }]; t = 0.9;
      }
      const flat = spline(pts, t);
      let top = Infinity, bottom = -Infinity;
      for (let k = 1; k < flat.length; k += 2) { if (flat[k] < top) top = flat[k]; if (flat[k] > bottom) bottom = flat[k]; }
      const label = W >= 640 && (dead || room - roadWidth > 150) ? labels[next++ % labels.length] : null;
      arms.push({
        x: jx, y: jy, d, pts: flat, top, bottom, dead, label,
        lx: dead ? dead.x - 14 : jx + d * (roadWidth * 0.5 + 18), ly: dead ? dead.y : jy - 14, align: dead || d < 0 ? "right" : "left",
      });
    }
  }
  return { junctions, arms };
}
