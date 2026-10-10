// Journey clouds (STEP 3). One half-resolution canvas laid over the world and its cards, in screen space ("on the glass").
//
//   - a dark veil + pre-rendered cloud sprites in 3 depths drifting at different speeds (a plan from core.js cloudPlan, seeded: same sky every visit)
//   - a second, invisible "holes" canvas remembers where the pointer has been; the fog canvas erases it each frame (destination-out)
//   - holes slowly fade (regrowth) so the clouds close back; when the page scrolls the memory is shifted with it so it never smears
//   - nothing here allocates inside the frame: sprites, canvases, the stamp buffer and the regrowth state are made once (or on resize)
//
// journey.js owns the loop and the listeners and feeds this module: pointer(), lift(), frame(), setReveal(), hint(), resize(), destroy().
// Created only when clouds are enabled; with clouds off none of these canvases exist.

import { cloudPlan, closeSeconds, driftSpeed, fogLayers, fogScale, holeStops, regrow, revealRadius, stampPoints, wrapX } from "./core.js";

const VEIL = "rgba(5,6,8,.975)";
const SPRITE_W = 256, SPRITE_H = 160;
// one cool silver-grey per depth (back = darkest): volume comes from layering, like cloud seen from above. All of them sit on the site's #c1c5ce, none is white.
const TINTS = [[58, 64, 76], [86, 92, 106], [122, 128, 142]];

const canvasOf = (w, h) => { const c = document.createElement("canvas"); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; };
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// one soft cloud: a cluster of radial-gradient puffs. The gradients are the blur, so no filter is needed (older Safari has none for canvas).
// Every puff stays inside the sprite, so no straight clipped edge can show. The alpha only ever falls from the centre outward (no rings).
function cloudSprite(rnd, tint) {
  const c = canvasOf(SPRITE_W, SPRITE_H), g = c.getContext("2d");
  const edge = tint.map((v) => Math.min(255, Math.round(v * 1.06 + 4))); // nearly the same colour as the core: a lighter rim would read as rings
  const puff = (x, y, r, a) => {
    r = Math.min(r, x, SPRITE_W - x, y, SPRITE_H - y);
    if (r < 4) return;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, rgba(tint, 0.7 * a)); gr.addColorStop(0.3, rgba(tint, 0.55 * a)); gr.addColorStop(0.62, rgba(edge, 0.24 * a)); gr.addColorStop(0.86, rgba(edge, 0.06 * a)); gr.addColorStop(1, rgba(edge, 0));
    g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
  };
  puff(SPRITE_W / 2, SPRITE_H / 2, SPRITE_H * 0.5, 0.6); // faint halo first
  for (let i = 0; i < 12; i++) puff(SPRITE_W * (0.24 + rnd() * 0.52), SPRITE_H * (0.34 + rnd() * 0.32), SPRITE_H * (0.22 + rnd() * 0.22), 1);
  return c;
}

function whiteSprite(stops, size) {
  const c = canvasOf(size, size), g = c.getContext("2d"), r = size / 2, gr = g.createRadialGradient(r, r, 0, r, r, r);
  for (const [p, a] of stops) gr.addColorStop(p, `rgba(255,255,255,${a})`);
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  return c;
}

// small deterministic generator for the sprites (same shapes every visit)
const rng = (seed) => { let a = seed >>> 0; return () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; }; };

export function createFog({ stage, before, clouds, seed, coarse }) {
  const canvas = canvasOf(2, 2); canvas.className = "jy-fog"; canvas.setAttribute("aria-hidden", "true");
  stage.insertBefore(canvas, before ?? null);
  const ctx = canvas.getContext("2d");
  if (!ctx) { canvas.remove(); return null; }
  let holesA = canvasOf(2, 2), holesB = canvasOf(2, 2), hA = holesA.getContext("2d"), hB = holesB.getContext("2d");
  const sprites = TINTS.flatMap((t, i) => [cloudSprite(rng(seed + i * 977 + 1), t), cloudSprite(rng(seed + i * 977 + 2), t)]); // 2 shapes per depth: index = layer * 2 + shape
  const stamp = whiteSprite(holeStops(clouds.softness), 128), glow = whiteSprite([[0, 1], [0.4, 0.4], [1, 0]], 128);
  const buf = new Float32Array(64); // stamp positions between two pointer samples (reused)
  const rg = { acc: 0 };
  const off = [0, 0, 0];

  let profile = coarse ? "touch" : "mouse", quality = 0;
  let W = 0, H = 0, S = 0.5, cw = 2, ch = 2, plan = [];
  let tx = 0, ty = 0, hx = 0, hy = 0, lx = 0, ly = 0, have = false, stamped = false;
  let holesLive = false, lastStamp = 0, lastDp = 0, shiftAcc = 0, dirty = true, tmpC = null, tmpG = null;
  let active = true, revealAll = false, timer = 0;
  let hintX = 0, hintY = 0, hintA = 0, hintOn = false;

  const radius = () => revealRadius(clouds, profile);

  const resize = (w, h, q) => {
    W = w; H = h; quality = q; S = fogScale(q, coarse);
    cw = Math.ceil(W * S); ch = Math.ceil(H * S);
    for (const c of [canvas, holesA, holesB]) { c.width = cw; c.height = ch; }
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    plan = cloudPlan({ w: W, h: H, density: clouds.density, touch: profile === "touch", scatter: clouds.scatterTouch, seed, layers: fogLayers(q), sprites: sprites.length });
    holesLive = false; stamped = false; shiftAcc = 0; dirty = true;
  };

  /** The profile can change when a finger touches a page that began as a mouse page: the sky is re-planned once, with bigger gaps. */
  const setProfile = (p) => {
    if (p === profile) return;
    profile = p;
    if (W) resize(W, H, quality);
  };

  const put = (x, y) => {
    const r = radius() * S;
    hA.setTransform(1, 0, 0, 1, 0, 0);
    hA.drawImage(stamp, x * S - r, y * S - r, r * 2, r * 2);
  };

  /** x, y in stage px. A finger's hole sits a little above it, so the finger does not hide what it opens. */
  const pointer = (x, y, touch) => {
    tx = x; ty = y - (touch ? radius() * 0.35 : 0);
    if (!have) { hx = tx; hy = ty; lx = hx; ly = hy; have = true; stamped = false; }
  };

  const setReveal = (on) => {
    if (on === revealAll) return;
    revealAll = on; clearTimeout(timer);
    if (on) { canvas.style.opacity = "0"; timer = setTimeout(() => { active = false; }, 750); } // fade out first, then stop all fog work
    else { active = true; dirty = true; canvas.style.opacity = "1"; }
  };

  const revealedAt = (x, y) => {
    if (revealAll || !active) return 1;
    try { return hA.getImageData(Math.min(cw - 1, Math.max(0, Math.round(x * S))), Math.min(ch - 1, Math.max(0, Math.round(y * S))), 1, 1).data[3] / 255; } catch { return 0; }
  };

  /**
   * One step. now/dt in ms, dp = the drawn scroll position, reduced = prefers-reduced-motion.
   * Returns true while something is still moving (the caller keeps its loop alive).
   */
  const frame = (now, dt, dp, reduced) => {
    if (!active || !W) return false;
    const t = Math.min(dt, 64);
    // scrolled: revealed ground moves with the world, clouds stay on the glass
    const dy = dp - lastDp; lastDp = dp;
    if (holesLive && dy) {
      shiftAcc -= dy * S;
      const sh = Math.round(shiftAcc);
      if (sh) { shiftAcc -= sh; hB.setTransform(1, 0, 0, 1, 0, 0); hB.clearRect(0, 0, cw, ch); hB.drawImage(holesA, 0, sh); tmpC = holesA; holesA = holesB; holesB = tmpC; tmpG = hA; hA = hB; hB = tmpG; dirty = true; }
    }
    // the hole follows the pointer with a little lag; a fast move is filled in with stamps along the way
    const following = have && (!stamped || hx !== tx || hy !== ty);
    if (following) {
      const k = reduced ? 1 : 1 - Math.exp(-t / 55);
      hx += (tx - hx) * k; hy += (ty - hy) * k;
      if (Math.abs(tx - hx) < 0.4 && Math.abs(ty - hy) < 0.4) { hx = tx; hy = ty; }
      if (!stamped || Math.hypot(hx - lx, hy - ly) >= 1 || (hx === tx && hy === ty && (lx !== hx || ly !== hy))) {
        const n = stamped ? stampPoints(lx, ly, hx, hy, radius() * 0.3, buf) : (buf[0] = hx, buf[1] = hy, 1);
        for (let i = 0; i < n; i++) put(buf[i * 2], buf[i * 2 + 1]);
        lx = hx; ly = hy; stamped = true; holesLive = true; lastStamp = now; dirty = true;
      }
    }
    // regrowth: the holes slowly lose alpha, so the clouds come back over revealed ground (never in reduced motion: the calm frame keeps what was opened)
    if (holesLive && !reduced) {
      const step = regrow(rg, t, clouds.closeSpeed);
      if (step) { hA.setTransform(1, 0, 0, 1, 0, 0); hA.globalCompositeOperation = "destination-out"; hA.fillStyle = `rgba(0,0,0,${step})`; hA.fillRect(0, 0, cw, ch); hA.globalCompositeOperation = "source-over"; dirty = true; }
      if (!following && now - lastStamp > closeSeconds(clouds.closeSpeed) * 1000) { hA.clearRect(0, 0, cw, ch); holesLive = false; dirty = true; }
    }
    // ambient drift
    const drifting = !reduced && clouds.drift > 0;
    if (drifting) { for (let l = 0; l < 3; l++) off[l] += (driftSpeed(l, clouds.drift) * t) / 1000; dirty = true; }
    if (!dirty) return holesLive || following;
    dirty = false;

    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, cw, ch);
    ctx.setTransform(S, 0, 0, S, 0, 0);
    ctx.fillStyle = VEIL; ctx.fillRect(0, 0, W, H);
    const bob = reduced ? 0 : Math.sin(now / 9000) * 5;
    for (let i = 0; i < plan.length; i++) {
      const c = plan[i], x = wrapX(c.x, off[c.layer], W, c.s * 0.6), y = c.y + bob * (c.layer + 1) * Math.sin(c.ph);
      if (x < -c.s || x > W + c.s || y < -c.s || y > H + c.s) continue;
      ctx.globalAlpha = c.a;
      ctx.drawImage(sprites[c.layer * 2 + (c.k & 1)], x - c.s / 2, y - c.s * 0.31, c.s, c.s * (SPRITE_H / SPRITE_W));
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (holesLive) { ctx.globalCompositeOperation = "destination-out"; ctx.drawImage(holesA, 0, 0); }
    // the latest milestone's glow bleeds faintly through the fog (suspense), with a tiny spark at its centre
    if (hintOn && hintX > -80 && hintX < W + 80 && hintY > -80 && hintY < H + 80) {
      const r = 96 * S;
      ctx.globalCompositeOperation = "destination-out"; ctx.globalAlpha = 0.12 + 0.2 * hintA;
      ctx.drawImage(glow, hintX * S - r, hintY * S - r, r * 2, r * 2);
      ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 0.18 + 0.4 * hintA; ctx.fillStyle = "#f1f3f7";
      ctx.beginPath(); ctx.arc(hintX * S, hintY * S, Math.max(0.8, 1.6 * S), 0, 6.2832); ctx.fill();
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    return drifting || holesLive || following;
  };

  /** Where the latest milestone is on screen and how bright its breath is (0..1). */
  const hint = (x, y, a, on) => {
    if (on !== hintOn || Math.abs(x - hintX) > 0.5 || Math.abs(y - hintY) > 0.5 || Math.abs(a - hintA) > 0.02) dirty = true;
    hintX = x; hintY = y; hintA = a; hintOn = on;
  };

  const destroy = () => {
    clearTimeout(timer);
    canvas.remove();
    for (const c of [canvas, holesA, holesB]) { c.width = c.height = 0; }
    plan = []; active = false;
  };

  return {
    canvas, resize, setProfile, pointer, frame, hint, setReveal, revealedAt, destroy,
    get profile() { return profile; }, get revealAll() { return revealAll; }, get active() { return active; },
    get radius() { return radius(); }, dirty: () => { dirty = true; },
  };
}
