"use strict";

/* ---- settings ---- */
const { email: EMAIL, discord: DISCORD_ID } = document.body.dataset;   // address for the Email button, account behind the status dot (both come from content.json)
const INTRO = { minMs: 2200, maxMs: 4000 }; // entrance: shortest time it plays, longest wait for slow pictures
const INTRO_KEY = "intro-at"; // when the entrance last played in this browser (localStorage + a 1-hour cookie as backup); it stays off for 1 hour (the check is in the head of index.html)
const INTRO_TTL_S = 3600;

const GMAIL = `https://mail.google.com/mail/?extsrc=mailto&url=${encodeURIComponent(`mailto:${EMAIL}`)}`; // Gmail compose link
const root = document.documentElement;
const $ = (sel, scope = document) => scope.querySelector(sel);
const $$ = (sel, scope = document) => [...scope.querySelectorAll(sel)];
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = ms => new Promise(r => setTimeout(r, ms));
const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mod = (a, m) => ((a % m) + m) % m;
const put = (el, prop, v) => { if (el.style[prop] !== v) el.style[prop] = v; }; // write a style only when it changes
const isTyping = el => /^(input|textarea|select)$/i.test(el.tagName) || el.isContentEditable; // keys belong to the field, not to the page
// a resize fires many times per frame: measure once per frame, just before it is painted
const onResize = fn => { let f = 0; addEventListener("resize", () => { f ||= requestAnimationFrame(() => { f = 0; fn(); }); }); };


/* ---- 1. page width: as wide as the 6 buttons with their labels ---- */
function fitWidth() {
  const src = $("[data-page=home] .links");
  if (!src) return;
  const probe = src.cloneNode(true);
  probe.style.cssText = "position:absolute;visibility:hidden;left:-9999px;top:0;display:flex;flex-wrap:nowrap;width:max-content;margin:0;gap:10px";
  $$("span", probe).forEach(s => { s.style.display = "inline"; });
  document.body.appendChild(probe);
  const w = Math.ceil(probe.getBoundingClientRect().width);
  probe.remove();
  if (w > 200) root.style.setProperty("--w", `${w}px`);
}


/* ---- 2. email button ---- */
$$("[data-mail]").forEach(a => { a.href = GMAIL; a.target = "_blank"; a.rel = "noopener noreferrer"; });


/* What the visitor did last, for the Journey road: when it opens it must tell the tail of the swipe (or the held key) that brought the visitor there from the
   next gesture, which works at once. Only read, never acted on, so nothing here changes how a page is switched. */
const lastInput = { wheel: null, key: "" };
addEventListener("wheel", e => {
  const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 300 : 1, d = e.deltaY * unit;
  const round = Math.abs(d) >= 100 && Number.isInteger(d) && (d % 100 === 0 || d % 120 === 0);
  lastInput.wheel = { t: e.timeStamp, d, notch: e.deltaMode !== 0 || round };
}, { capture: true, passive: true });
addEventListener("keydown", e => { if (!e.repeat) lastInput.key = e.key.toLowerCase(); }, true);
addEventListener("keyup", () => { lastInput.key = ""; }, true);
addEventListener("blur", () => { lastInput.key = ""; });


/* ---- 3. pages: four pages stacked in the DOM, the "on" class cross-fades one in; the address never changes ---- */
const router = (() => {
  const views = $$("[data-page]");
  const nav = $("#nav"), indicator = $("#ind");
  const links = $$("a", nav);
  let current = null;

  // Journey: public/journey.js is fetched in the background once the browser is idle after the first paint (and at once when its icon is pointed at or touched, if that comes first).
  // It exports mount(view, lastInput) / unmount(): mounted while the page is open, torn down when it is left, so a closed Journey costs nothing.
  const journey = (() => {
    const view = $("[data-page=journey]");
    if (!view?.dataset.src) return null;
    let mod = null, pending = null, mounted = false, want = false;
    const load = () => (pending ??= import(view.dataset.src).then(m => (mod = m)).catch(e => { pending = null; console.warn("journey: could not load", e); return null; }));
    const apply = () => {
      if (!mod) return;
      if (want && !mounted) { mounted = true; try { mod.mount(view, lastInput); } catch (e) { mounted = false; view.removeAttribute("data-hold"); console.warn("journey: mount failed", e); } }
      else if (!want && mounted) { mounted = false; try { mod.unmount(); } catch (e) { console.warn("journey: unmount failed", e); } }
    };
    const opener = $("[data-go=journey]", nav);
    for (const type of ["pointerenter", "pointerdown", "focus"]) opener?.addEventListener(type, load, { once: true });
    // Fetched and parsed in the background as soon as the browser is idle after the site's first paint, so by the time anyone can click the icon it is
    // already here and opening is instant. Idle time means the site's own loading is never slowed; a data-saver visitor keeps the lazy behaviour.
    const idle = window.requestIdleCallback ?? ((f) => setTimeout(f, 200));
    if (!navigator.connection?.saveData) idle(() => load().then((m) => m && idle(() => m.warm?.(view), { timeout: 600 })), { timeout: 600 });
    return {
      sync(id) {
        want = id === "journey";
        // the page takes its final shape (title in place, list hidden) in the same moment it opens, so the plain list never flashes while journey.js loads
        // its wheel / swipe / arrow keys belong to it from this moment too (not only once journey.js has loaded), or a scroll during the first load would flip the page away
        if (want) { view.dataset.world = ""; view.setAttribute("data-hold", ""); load().then((m) => { if (!m) { view.removeAttribute("data-world"); view.removeAttribute("data-hold"); } apply(); }); } else { view.removeAttribute("data-hold"); apply(); }
      },
    };
  })();

  // the ring sits on the selected icon, in whole pixels
  const moveInd = () => {
    const li = links.find(l => l.hasAttribute("aria-current"))?.parentElement;
    if (li) indicator.style.transform = `translate3d(${li.offsetLeft}px, ${li.offsetTop}px, 0)`;
  };

  function show(id) {
    if (!views.some(v => v.dataset.page === id)) id = "home";
    if (id === current) return;
    current = id;
    for (const v of views) {
      const on = v.dataset.page === id;
      v.classList.toggle("on", on);
      v.inert = !on;
      v.setAttribute("aria-hidden", String(!on));
    }
    for (const a of links) { if (a.dataset.go === id) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); }
    moveInd();
    journey?.sync(id);
  }

  // the menu switches between a column and a row: put the ring back without sliding it
  addEventListener("resize", () => {
    nav.classList.remove("run");
    moveInd();
    nextFrame().then(nextFrame).then(() => nav.classList.add("run"));
  });

  // menu icons take no keyboard focus and show no focus circle
  for (const a of links) a.tabIndex = -1;
  nav.addEventListener("mousedown", e => e.preventDefault());
  nav.addEventListener("focusin", e => e.target.blur());
  nav.addEventListener("click", e => { const a = e.target.closest("a[data-go]"); if (a) show(a.dataset.go); });

  // previous / next page, looping round the ends; every input counts, even while the last change is still playing
  const order = links.map(a => a.dataset.go);
  // a page that moves by itself (the Journey road) sets data-hold on its view: wheel, swipe and arrow keys then belong to it, the menu icons still switch pages
  const held = () => !!$("[data-page].on")?.hasAttribute("data-hold");
  const canNav = () => !root.classList.contains("is-intro") && $("#offline").hidden && !root.classList.contains("src-open") && !held();
  const go = dir => { if (canNav()) show(order[mod(order.indexOf(current) + dir, order.length)]); };

  // up / W = previous page, down / S = next page; a held key repeats at a steady pace
  {
    const REPEAT_GAP_MS = 140;
    let lastKey = 0;
    addEventListener("keydown", e => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return; // defaultPrevented: the rating stars use the arrow keys themselves
      if (root.classList.contains("src-open")) return;
      if (isTyping(e.target) || held()) return;
      const k = e.key.toLowerCase();
      const dir = k === "arrowup" || k === "w" ? -1 : k === "arrowdown" || k === "s" ? 1 : 0;
      if (!dir) return;
      e.preventDefault();
      const now = performance.now();
      if (e.repeat && now - lastKey < REPEAT_GAP_MS) return;
      lastKey = now;
      go(dir);
    });
  }

  // trackpad / wheel: one vertical gesture = one page
  wheelStepper(canNav, go, "y");

  // touch / pen: a vertical swipe = one page (swipe up = next); it fires as soon as the finger has travelled far enough
  {
    const SWIPE_PX = 28;
    let sw = null;
    const fire = (e, final) => {
      if (!sw || e.pointerId !== sw.id) return;
      const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
      if (Math.abs(dy) < SWIPE_PX || Math.abs(dy) <= Math.abs(dx) || $(".drag")) return;
      sw = null;
      go(dy < 0 ? 1 : -1);
    };
    addEventListener("pointerdown", e => {
      sw = e.pointerType === "mouse" || !e.isPrimary || e.target.closest?.("textarea") ? null : { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    addEventListener("pointermove", fire);
    addEventListener("pointerup", e => { fire(e); sw = null; });
    addEventListener("pointercancel", () => { sw = null; });
  }

  initTip(nav);
  show("home");
  nextFrame().then(nextFrame).then(() => nav.classList.add("run")); // the ring slides only after its first position is set

  return { get current() { return current; } };
})();

/* one hover label for all icons: it follows the icon under the pointer with an exponential ease and cross-fades its text */
function initTip(nav) {
  const FOLLOW = 18; // higher = tighter follow
  const tip = $("#tip"), tipA = $(".tip-a", tip), tipB = $(".tip-b", tip), ruler = $(".tip-r", tip), column = matchMedia("(min-width:641px)");
  let label = "", front = tipA, shown = false, hideT = 0, resetT = 0, raf = 0, last = 0;
  let tx = 0, ty = 0, tw = 0, cx = 0, cy = 0, cw = 0;

  const apply = () => { tip.style.width = `${cw.toFixed(2)}px`; tip.style.transform = `translate3d(${cx.toFixed(2)}px, ${cy.toFixed(2)}px, 0)`; };
  function frame(now) {
    raf = 0;
    const dt = last ? Math.min(.05, (now - last) / 1000) : 1 / 60;
    last = now;
    const k = 1 - Math.exp(-FOLLOW * dt);
    cx += (tx - cx) * k; cy += (ty - cy) * k; cw += (tw - cw) * k;
    if (Math.abs(tx - cx) < .15 && Math.abs(ty - cy) < .15 && Math.abs(tw - cw) < .15) { [cx, cy, cw] = [tx, ty, tw]; apply(); last = 0; return; }
    apply();
    raf = requestAnimationFrame(frame);
  }
  function showFor(a) {
    clearTimeout(hideT); clearTimeout(resetT);
    const text = a.dataset.tip, first = !shown, changed = text !== label;
    if (changed) ruler.textContent = text;
    const w = ruler.offsetWidth, h = tip.offsetHeight, r = a.getBoundingClientRect();
    if (column.matches) { tx = r.right + 12; ty = r.top + r.height / 2 - h / 2; }
    else { tx = clamp(r.left + r.width / 2 - w / 2, 8, innerWidth - w - 8); ty = r.top - h - 8; }
    tx = Math.round(tx); ty = Math.round(ty); tw = w;
    if (first || reduceMotion) { [cx, cy, cw] = [tx, ty, tw]; apply(); }
    else if (!raf) { last = 0; raf = requestAnimationFrame(frame); }
    if (changed) {
      if (first) { front.textContent = text; front.classList.add("on"); }
      else {
        const back = front === tipA ? tipB : tipA;
        back.textContent = text;
        front.classList.remove("on"); back.classList.add("on");
        front = back;
      }
      label = text;
    }
    shown = true;
    tip.classList.add("on");
  }
  function hide() { // short grace period, so crossing the gap between icons does not close it
    clearTimeout(hideT);
    hideT = setTimeout(() => {
      tip.classList.remove("on");
      resetT = setTimeout(() => { shown = false; label = ""; tipA.classList.remove("on"); tipB.classList.remove("on"); }, 250);
    }, 50);
  }
  nav.addEventListener("pointerover", e => { const a = e.pointerType === "mouse" && e.target.closest("a[data-tip]"); if (a) showFor(a); });
  nav.addEventListener("pointerleave", hide);
  addEventListener("blur", hide);
}


/* ---- motion helpers shared by the projects deck and the skills strip ----
   makeGlide: a move with a known end. It runs from the current position and speed to the target with zero speed at the end,
   so it never overshoots; a farther target gets a slightly longer glide. */
function makeGlide() {
  let p0 = 0, p1 = 0, v0 = 0, t0 = 0, T = .4;
  const g = {
    pos: 0, vel: 0,
    start(pos, vel, target) {
      const dist = target - pos, a = Math.abs(dist), sg = dist < 0 ? -1 : 1;
      p0 = pos; p1 = target; t0 = performance.now(); g.pos = pos; g.vel = vel;
      if (a < 1e-4) { v0 = 0; T = .001; return; }
      T = Math.min(.9, .32 + .07 * Math.min(a, 8));
      // keep the current speed when already moving (no jump), else a quick ease-out start; never enough to overshoot
      const vd = vel * sg, base = vd > .3 ? vd : Math.max(vd, 2 * a / T);
      v0 = sg * Math.max(0, Math.min(base, 3 * a / T));
    },
    sample(now) { // true once the end is reached
      const s = clamp((now - t0) / (T * 1000), 0, 1);
      if (s >= 1) { g.pos = p1; g.vel = 0; return true; }
      const s2 = s * s, s3 = s2 * s;
      g.pos = (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * T * v0 + (3 * s2 - 2 * s3) * p1;
      g.vel = ((6 * s2 - 6 * s) * p0 + (3 * s2 - 4 * s + 1) * T * v0 + (6 * s - 6 * s2) * p1) / T;
      return false;
    },
  };
  return g;
}

/* Ring: an endless loop of cards driven by ONE position `pos` (2.0 = the 3rd card is centred). `draw` places every card from it each
   frame; everything that moves the ring only changes `target`. Too few cards are repeated behind the scenes (copies are aria-hidden). */
class Ring {
  constructor(el, items, { min, draw, settle, onGo, onRest }) {
    this.el = el;
    this.count = items.length;
    this.slides = [...items];
    if (this.count > 1) {
      for (let copy = 1; copy < Math.ceil(min / this.count); copy++) {
        for (const s of items) {
          const c = s.cloneNode(true);
          c.setAttribute("aria-hidden", "true");
          this.slides.push(c); el.append(c);
        }
      }
    }
    this.size = this.slides.length;
    this.half = this.size / 2;
    this.pos = 0; this.target = 0; this.vel = 0; this.raf = 0;
    this.dragging = false;
    this.glide = makeGlide();
    Object.assign(this, { draw, settle, onGo, onRest });
  }

  get busy() { return !!this.raf; }
  offset(i, p = this.pos) { return mod(i - p + this.half, this.size) - this.half; } // signed distance from the centre, shortest way round
  near(i) { const r = Math.round(this.pos); return r + this.offset(i, r); }           // card i, reached the shorter way round
  stepBy(d) { this.glideTo(Math.round(this.target) + d); }                            // presses add up, even mid-glide
  kick() { if (!this.raf) this.raf = requestAnimationFrame(this.#tick); }

  glideTo(t) {
    this.target = t;
    if (reduceMotion) { this.pos = t; this.vel = 0; this.draw(); this.settle(); return; }
    this.glide.start(this.pos, this.vel, t);
    this.onGo?.();
    this.kick();
  }

  #tick = now => {
    this.raf = 0;
    if (!this.dragging) {
      const done = this.glide.sample(now);
      this.pos = this.glide.pos; this.vel = this.glide.vel;
      if (done) {
        this.target -= Math.floor(this.target / this.size) * this.size; // keep numbers small; cards are placed modulo the ring
        this.pos = this.target; this.vel = 0;
        this.draw(); this.settle(); this.onRest?.();
        return;
      }
    }
    this.draw();
    this.raf = requestAnimationFrame(this.#tick);
  };
}

/* Wheel / trackpad: every push counts once, exactly like one key press. No cooldown and no limit: 1 push = 1 step, 2 = 2, 100 = 100.
   - mouse wheel: every notch is its own push, even when notches arrive a few ms apart
   - trackpad: one swipe = one push. A new swipe starts after a pause, on a change of direction, or when the speed climbs again
     after dying down (a new swipe made on top of the previous swipe's momentum). The momentum tail of a swipe adds nothing.
   The axis is fixed when a swipe starts, so a slightly crooked swipe never triggers the other direction.
   single = true: one whole gesture is ONE step, wheel notches included. A fast spin of the mouse wheel or a long trackpad swipe with
   momentum still moves exactly one place; the next step needs a new gesture (after a short pause, a direction change or a fresh swipe). */
const wheelLock = { stamp: -1, t: 0, axis: "x" };
function wheelStepper(canAct, stepFn, axis = "x", single = false) {
  const GAP_MS = 140, NEED_PX = 3, FLIP = 2.5, RISE = 2.5, RISE_PX = 12, DECAYED = .5;
  let armed = true, mine = false, lastNotch = false, lastT = 0, sign = 0, acc = 0, peak = 0, low = 0;
  addEventListener("wheel", e => {
    if (e.ctrlKey) return; // trackpad pinch = browser zoom
    if (e.target.closest?.("textarea")) return; // the feedback box scrolls itself
    if (!canAct()) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 300 : 1;
    const dx = e.deltaX * unit, dy = e.deltaY * unit, ax = Math.abs(dx), ay = Math.abs(dy), big = Math.max(ax, ay);
    if (big < 1) return;
    const now = e.timeStamp;
    if (now !== wheelLock.stamp) { // the first handler to see this event decides its axis for all of them
      const dom = ax > ay ? "x" : "y", other = dom === "x" ? ay : ax;
      if (now - wheelLock.t > GAP_MS || (dom !== wheelLock.axis && big >= 8 && big > other * FLIP)) wheelLock.axis = dom;
      wheelLock.stamp = now; wheelLock.t = now;
    }
    if (wheelLock.axis !== axis) { mine = false; return; }
    const d = axis === "x" ? dx : dy, ad = Math.abs(d), sg = Math.sign(d);
    if (!ad) return;
    // a real wheel notch (100 / 120 per click, or line mode): one event = one push
    // (a big touchpad value can look like a notch by chance, so a lone round number only counts after a pause or next to another notch)
    const gap = now - lastT;
    lastT = now;
    const round = ad >= 100 && Number.isInteger(ad) && (ad % 100 === 0 || ad % 120 === 0);
    const notch = !single && (e.deltaMode !== 0 || (round && (gap > 50 || lastNotch)));
    lastNotch = notch;
    if (notch) { mine = false; armed = true; acc = 0; stepFn(sg < 0 ? -1 : 1); return; }
    // a new swipe: after a pause, a change of direction, or a clear jump in speed after the old swipe had died down.
    // Small jitter inside one swipe (touchpads are noisy) never counts, only a real rise from the quiet tail.
    const newSwipe = !mine || gap > GAP_MS || sg !== sign || (!armed && low <= peak * DECAYED && ad >= low * RISE && ad - low >= RISE_PX);
    mine = true;
    if (newSwipe) { armed = true; acc = 0; peak = ad; low = ad; }
    else if (ad >= peak) { peak = ad; low = ad; } // still speeding up: the quiet point is measured after the top speed
    else if (ad < low) low = ad;
    sign = sg;
    if (!armed) return;
    acc += d;
    if (Math.abs(acc) < NEED_PX) return;
    armed = false;
    stepFn(acc < 0 ? -1 : 1);
  }, { passive: false });
}

/* wheel plus left / right arrows or A / D move a ring one step while its page is open: every gesture (press, swipe, wheel push, button) is exactly one step */
function bindStepInput(ring, page) {
  const active = () => router.current === page && !root.classList.contains("src-open");
  wheelStepper(active, d => ring.stepBy(d), "x", true);
  addEventListener("keydown", e => {
    if (!active() || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (isTyping(e.target)) return;
    const k = e.key.toLowerCase();
    const dir = k === "arrowleft" || k === "a" ? -1 : k === "arrowright" || k === "d" ? 1 : 0;
    if (!dir) return;
    if (k.startsWith("arrow")) e.preventDefault();
    if (e.repeat) return; // one press = one step; a held key never repeats
    ring.stepBy(dir);
  });
}


/* small previous / next buttons for a carousel: made only when there is more than one item, shown only while the pointer is over the stage */
function addNav(stage, ring, count) {
  if (!stage || count < 2) return;
  const mk = (dir, label, path) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = `nb ${dir < 0 ? "l" : "r"}`; b.tabIndex = -1; b.setAttribute("aria-label", label);
    b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
    b.addEventListener("mousedown", e => e.preventDefault()); // no focus ring, keys keep working
    b.addEventListener("click", () => ring.stepBy(dir));      // every click is one step, they add up
    stage.append(b);
  };
  mk(-1, "Previous", "m15 18-6-6 6-6");
  mk(1, "Next", "m9 18 6-6-6-6");
}

/* ---- 4. projects deck: scale, shift, dimming and stacking follow each card's distance from the centre ----
   Cards more than 2 places away fade out before they wrap round. Touch swipe = exactly 1 card; a click on a side card brings it forward. */
const deck = (() => {
  const el = $("#deck");
  const cards = el ? $$(":scope > .slide", el) : [];
  if (!cards.length) return null;

  const SWIPE_PX = 40;
  const sOf = d => d < 1 ? 1 - .1 * d : d < 2 ? .9 - .1 * (d - 1) : .8;
  let W = 0, pk2 = 12, centre = -1;

  const ring = new Ring(el, cards, {
    min: 7,
    draw() {
      const { slides, size } = ring, pk1 = pk2 * .56;
      for (let i = 0; i < size; i++) {
        const o = ring.offset(i), d = Math.abs(o), s = sOf(d);
        const pk = d < 1 ? pk1 * d : d < 2 ? pk1 + (pk2 - pk1) * (d - 1) : pk2;
        const dim = d < 1 ? .38 * d : d < 2 ? .38 + .22 * (d - 1) : .6;
        const show = d <= 2 ? 1 : clamp(3 - d, 0, 1);
        const t = slides[i];
        t.style.transform = `translate3d(${((o < 0 ? -1 : 1) * (pk + (1 - s) * W / 2)).toFixed(2)}px,0,0) scale(${s.toFixed(4)})`;
        put(dims[i], "opacity", dim.toFixed(3));
        put(t, "opacity", show < 1 ? show.toFixed(3) : "");
        put(t, "visibility", show ? "" : "hidden");
        put(t, "zIndex", String(100 - Math.round(d * 10)));
      }
    },
    // only at rest: corner radius, who can be clicked and read out (changing them mid-glide forces layer rebuilds)
    settle() {
      const c = mod(Math.round(ring.pos), ring.size);
      ring.slides.forEach((t, i) => {
        const o = ring.offset(i, c);
        t.style.borderRadius = `${(8 / sOf(Math.abs(o))).toFixed(2)}px`; // keeps the visible radius at 8px under scale
        if (c === centre) return;
        t.dataset.o = o === 0 ? "0" : o < 0 ? "-1" : "1";
        t.setAttribute("aria-hidden", String(o !== 0));
        $$(".shot, .info", t).forEach(n => { n.inert = o !== 0; });
      });
      centre = c;
    },
    onGo: () => el.classList.add("moving"),
    onRest: () => el.classList.remove("moving"),
  });

  // one dimming layer per card: its opacity is cheap for the GPU, a brightness filter is not
  const dims = ring.slides.map(s => { const d = document.createElement("i"); d.className = "dim"; s.append(d); return d; });
  const probe = document.createElement("i"); // reads the side-peek distance (--pk2) in pixels
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;width:var(--pk2)";
  el.append(probe);

  function measure() { W = el.clientWidth; pk2 = probe.offsetWidth; ring.draw(); if (!ring.busy) ring.settle(); }
  measure();
  onResize(measure);

  if (ring.size > 1) {
    ring.slides.forEach((s, i) => s.addEventListener("click", () => { if (s.dataset.o !== "0") ring.glideTo(ring.near(i)); }));
    bindStepInput(ring, "projects");
    addNav(el, ring, cards.length);

    let start = null; // touch / pen swipe
    el.addEventListener("pointerdown", e => { start = e.pointerType === "mouse" || !e.isPrimary ? null : [e.clientX, e.clientY]; });
    el.addEventListener("pointerup", e => {
      if (!start) return;
      const dx = e.clientX - start[0], dy = e.clientY - start[1];
      start = null;
      if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) ring.stepBy(dx < 0 ? 1 : -1); // a vertical swipe changes the page instead
    });
    el.addEventListener("pointercancel", () => { start = null; });
  }
  return { el, measure };
})();


/* ---- 4b. skills strip: an endless row of boxes drawn from the ring position; the first box is selected when the page opens ----
   The selected box is large, the others sit beside it smaller and dimmer. Drag follows the pointer, then lands on the box chosen from
   release speed (never more than 1 box from the start). Arrows, keys and a click on a side box move it too. */
const strip = (() => {
  const el = $("#strip");
  const tiles = el ? $$(":scope > .tile", el) : [];
  if (!tiles.length) return null;

  const DRAG_PX = 6;                    // a swipe moves exactly 1 box
  const FADE_FROM = 4, FADE_TO = 5;     // boxes dim from 4 places away and are gone at 5
  const COMMIT = .12, QUICK = 1;        // a swipe moves one box once it is dragged 12% of a box or flicked at 1 box / s
  const SIDE = .72;                     // size of every box that is not the selected one (1 = the selected box)
  const count = tiles.length;
  // the coloured glow behind the selected box lives in its own element, so it fades with a compositor-only opacity change
  // instead of repainting a large blurred shadow on every frame of the slide
  for (const t of tiles) { const g = document.createElement("i"); g.className = "glow"; g.setAttribute("aria-hidden", "true"); t.prepend(g); }
  let width = 210, near = 224, far = 163, trackW = 0, active = -1, suppressClick = false;
  // screen distance of a box from the centre: the first neighbour sits just clear of the big centre box, the rest are evenly spaced
  const xOf = o => { const d = Math.abs(o), x = d <= 1 ? d * near : near + (d - 1) * far; return o < 0 ? -x : x; };
  const sizeOf = d => 1 - (1 - SIDE) * Math.min(1, d);

  const ring = new Ring(el, tiles, {
    min: 11, // 5 boxes each side + the centre one
    draw() {
      const { slides, size } = ring;
      for (let i = 0; i < size; i++) {
        const o = ring.offset(i), d = Math.abs(o), x = xOf(o);
        const dim = d <= 1 ? 1 - .55 * d : d <= FADE_FROM ? .45 : .45 * clamp(FADE_TO - d, 0, 1);
        const ex = clamp((trackW / 2 - Math.abs(x)) / (trackW * .14), 0, 1); // soft fade towards the screen edges
        const vis = dim * ex * ex * (3 - 2 * ex);
        const t = slides[i];
        if (vis > .002) {
          put(t, "transform", `translate3d(${x.toFixed(2)}px,0,0) scale(${sizeOf(d).toFixed(4)})`);
          put(t, "opacity", vis.toFixed(3));
          put(t, "visibility", "");
        } else put(t, "visibility", "hidden"); // a hidden box is neither painted nor moved; it is placed again the moment it shows
      }
      const idx = mod(Math.round(ring.pos), count);
      if (idx !== active) { active = idx; announce(); }
    },
    // only at rest: corner radius, so a scaled box keeps the same visible radius
    settle() {
      const c = Math.round(ring.pos);
      ring.slides.forEach((t, i) => put(t, "borderRadius", `${(8 / sizeOf(Math.abs(ring.offset(i, c)))).toFixed(2)}px`));
    },
  });

  function announce() {
    const tile = tiles[active];
    const mid = Math.round(ring.pos);
    // attributes are written only when they change, so boxes that stay as they are cause no style work in the middle of a slide
    ring.slides.forEach((t, i) => {
      const on = mod(i, count) === active && Math.abs(ring.offset(i)) < .5, has = t.hasAttribute("aria-current");
      if (on && !has) t.setAttribute("aria-current", "true"); else if (!on && has) t.removeAttribute("aria-current");
      const n = String(clamp(Math.round(ring.offset(i, mid)), -2, 2));
      if (t.dataset.n !== n) t.dataset.n = n;
    });
    el.style.setProperty("--glow", tile.style.getPropertyValue("--c")); // colour that falls on the boxes beside the selected one
  }

  function measure() {
    const gap = parseFloat(getComputedStyle(el).getPropertyValue("--gap")) || 14;
    width = tiles[0].offsetWidth;
    near = width * (1 + SIDE) / 2 + gap;
    far = width * SIDE + gap;
    trackW = el.clientWidth;
    ring.draw(); if (!ring.busy) ring.settle();
  }
  measure();
  onResize(measure);

  if (ring.size > 1) {
    // a tap on a side box moves one place towards it (never more, so every input moves exactly one box)
    ring.slides.forEach((t, i) => t.addEventListener("click", () => {
      if (suppressClick) return;
      const away = ring.near(i) - Math.round(ring.pos);
      if (away) ring.stepBy(away < 0 ? -1 : 1);
    }));
    bindStepInput(ring, "skills");
    addNav(el.parentElement, ring, tiles.length);

    // drag / swipe the strip: it follows the pointer exactly, then release speed picks the landing box
    el.addEventListener("pointerdown", e => {
      if (e.button !== 0 || !e.isPrimary) return;
      const x0 = e.clientX, y0 = e.clientY, p0 = ring.pos, from = Math.round(ring.pos), trail = [[performance.now(), ring.pos]];
      let moved = false;
      const move = ev => {
        const dx = ev.clientX - x0, dy = ev.clientY - y0;
        if (!moved && Math.abs(dy) >= DRAG_PX && Math.abs(dy) > Math.abs(dx)) { up(); return; } // vertical swipe: leave it to the page change
        if (!moved) { if (Math.abs(dx) < DRAG_PX) return; moved = true; ring.dragging = true; ring.vel = 0; el.classList.add("drag"); }
        ring.pos = clamp(p0 - dx / near, from - 1, from + 1);
        const now = performance.now();
        trail.push([now, ring.pos]);
        while (trail.length > 2 && now - trail[0][0] > 100) trail.shift();
        ring.kick();
      };
      const up = () => {
        removeEventListener("pointermove", move); removeEventListener("pointerup", up); removeEventListener("pointercancel", up);
        if (!moved) return;
        ring.dragging = false; el.classList.remove("drag");
        suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); // the click after a drag must not also pick a box
        const [t0, q0] = trail[0], [t1, q1] = trail.at(-1);
        const v = clamp(t1 > t0 ? (q1 - q0) / ((t1 - t0) / 1000) : 0, -14, 14);
        ring.vel = v;
        // one swipe = exactly one box: far enough or fast enough moves to the next box that way, otherwise it settles back
        const shift = ring.pos - from, far = Math.abs(shift) >= COMMIT;
        const dir = far ? Math.sign(shift) : Math.abs(v) >= QUICK ? Math.sign(v) : 0;
        ring.glideTo(from + dir);
      };
      addEventListener("pointermove", move); addEventListener("pointerup", up); addEventListener("pointercancel", up);
    });
  }
  return { el, measure };
})();


/* ---- 5. discord status: one state machine feeds the loading-screen dot and the small dot top left ----
   The browser keeps one WebSocket to Lanyard, which pushes every change; one REST request runs beside it so the first value is as fast as possible.
     start         paint the saved value, open the socket and ask REST once; whichever answers first wins
     socket hello  subscribe to the account, send a heartbeat at the interval Lanyard names, stop REST polling
     socket push   INIT_STATE / PRESENCE_UPDATE -> apply the status at once (only when it changed) and save it
     socket lost   reconnect after 1, 2, 4 ... 15 s; poll REST every 5 s meanwhile
     tab hidden    close the socket, stop every timer
     tab visible / browser online   reconnect and ask REST once */
const LABEL = { online: "online", idle: "afk", dnd: "busy", offline: "offline" };
const status = (() => {
  const SOCKET_URL = "wss://api.lanyard.rest/socket";
  const REST_URL = `https://api.lanyard.rest/v1/users/${DISCORD_ID}`;
  const BACKOFF_MAX_MS = 15000, POLL_MS = 5000;
  const listeners = [];
  let current = null, ws = null, heartbeat = 0, retries = 0, retryTimer = 0, pollTimer = 0, pushes = 0;
  try { const saved = localStorage.getItem("dc-status"); if (LABEL[saved]) current = saved; } catch { /* private mode */ }

  const apply = raw => {
    const next = LABEL[raw] ? raw : "offline";
    if (next === current) return;
    current = next;
    try { localStorage.setItem("dc-status", next); } catch { /* private mode */ }
    listeners.forEach(fn => fn(next));
  };

  const fetchRest = async () => {
    const seen = pushes;
    try {
      const res = await fetch(REST_URL, { cache: "no-store", signal: AbortSignal.timeout(5000) });
      const json = await res.json();
      if (json.success && seen === pushes) apply(json.data.discord_status); // a newer socket push wins
    } catch { /* the next poll or push corrects it */ }
  };

  const stopPolling = () => { clearInterval(pollTimer); pollTimer = 0; };
  const closeSocket = () => {
    clearInterval(heartbeat);
    if (!ws) return;
    ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch { /* already closed */ }
    ws = null;
  };
  const stopAll = () => { closeSocket(); stopPolling(); clearTimeout(retryTimer); };

  const lost = () => {
    closeSocket();
    if (document.hidden) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, Math.min(BACKOFF_MAX_MS, 1000 * 2 ** retries++));
    pollTimer ||= setInterval(fetchRest, POLL_MS);
  };

  function connect() {
    if (ws || document.hidden) return;
    let socket;
    try { socket = new WebSocket(SOCKET_URL); } catch { lost(); return; }
    ws = socket;
    socket.onmessage = ({ data }) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.op === 1) {
        retries = 0;
        stopPolling();
        socket.send(JSON.stringify({ op: 2, d: { subscribe_to_id: DISCORD_ID } }));
        clearInterval(heartbeat);
        heartbeat = setInterval(() => { if (socket.readyState === 1) socket.send(JSON.stringify({ op: 3 })); }, msg.d?.heartbeat_interval || 30000);
      } else if (msg.op === 0 && (msg.t === "INIT_STATE" || msg.t === "PRESENCE_UPDATE")) {
        pushes++;
        apply(msg.d?.discord_status);
      }
    };
    socket.onclose = socket.onerror = lost;
  }

  const wake = () => { if (document.hidden) return; stopAll(); retries = 0; connect(); fetchRest(); };
  document.addEventListener("visibilitychange", () => (document.hidden ? stopAll() : wake()));
  addEventListener("online", wake);
  wake();

  return {
    on(fn) { listeners.push(fn); if (current) fn(current); },
    // resolves with the first known status, or null after `ms`
    ready: ms => current ? Promise.resolve(current) : new Promise(done => {
      const timer = setTimeout(() => done(null), ms);
      listeners.push(s => { clearTimeout(timer); done(s); });
    }),
  };
})();

{
  const st = $("#st"), dot = $("#dot"), text = $("#stt"), big = $("#introDot");
  status.on(s => {
    big.className = `intro-dot ${s}`;
    dot.className = `dot ${s}`;
    text.textContent = LABEL[s];
    st.classList.toggle("on", s === "online");
    st.hidden = false;
  });
}


/* ---- 6. view counter: one POST per page load. When the entrance ends and the number fades in, it counts up from 0 to the real total
   inside 1.8 s (VIEWS_MAX_MS), however large the number is. The last real total is remembered and shown while the server is slow or down;
   with nothing known the number stays "–" until the server answers. The counter never blocks the page. ---- */
{
  const VIEWS_MAX_MS = 1700; // leaves room for frame timing, so the count always ends inside 1.8 s
  const out = $("#vcount");
  let cached = null;
  try { const raw = localStorage.getItem("views"); if (raw !== null && Number.isFinite(+raw)) cached = Math.floor(+raw); } catch { /* private mode */ }

  let shown = null, live = null, started = false, raf = 0, countStart = 0;
  const paint = n => { out.textContent = n.toLocaleString("en-US"); };
  const tween = (from, to) => {
    cancelAnimationFrame(raf);
    if (reduceMotion || from === to) { shown = to; paint(to); countStart = 0; return; }
    const t0 = performance.now();
    countStart ||= t0; // the 0 -> total budget runs from the first count, even when the total arrives mid-count
    const dur = clamp(700 + 450 * Math.log10(Math.abs(to - from) + 1), 600, VIEWS_MAX_MS);
    const left = Math.max(250, VIEWS_MAX_MS - (t0 - countStart)), span = Math.min(dur, left);
    const step = now => {
      const t = clamp((now - t0) / span, 0, 1);
      shown = Math.round(from + (to - from) * (1 - (1 - t) ** 4)); // eases out, so the last digits settle gently
      paint(shown);
      if (t < 1) raf = requestAnimationFrame(step); else countStart = 0;
    };
    raf = requestAnimationFrame(step);
  };
  const arrive = v => { // the real total reached us
    live = v;
    try { localStorage.setItem("views", String(v)); } catch { /* private mode */ }
    if (started) tween(shown ?? 0, v);
  };

  const WARN = { 501: "database not configured", 404: "api not deployed" };
  // POST once (counts the visit); if it fails, ask again now and then with GET (counts nothing) until the server answers
  const ask = async (method, tries) => {
    try {
      const res = await fetch("/api/views", { method, cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!res.ok) { console.warn("views:", WARN[res.status] ?? "database error", `(${res.status})`); throw 0; }
      const { views } = await res.json();
      if (typeof views !== "number") throw 0;
      arrive(Math.max(0, Math.floor(views)));
      return true;
    } catch (e) {
      if (e) console.warn("views: request failed", e);
      if (tries > 0) setTimeout(() => ask("GET", tries - 1), 10000);
      return false;
    }
  };
  const answered = root.hasAttribute("data-preview") ? Promise.resolve(false) : ask("POST", 6); // the admin preview counts no visit and calls no API (its policy forbids it)

  const introOver = () => new Promise(done => {
    if (!root.classList.contains("is-intro")) { done(); return; }
    const mo = new MutationObserver(() => { if (!root.classList.contains("is-intro")) { mo.disconnect(); done(); } });
    mo.observe(root, { attributes: true, attributeFilter: ["class"] });
  });

  (async () => {
    await introOver();
    await wait(reduceMotion ? 0 : 600);                      // the number starts to fade in about now
    await Promise.race([answered, wait(800)]);               // normally the answer is here already; a slow server is not waited for
    started = true;
    const to = live ?? cached;
    if (to === null) return;                                 // nothing to show yet: stays "–" until the server answers
    paint(0); shown = 0;
    tween(0, to);
  })();
}


/* ---- 7. no selecting or dragging; only the link buttons can be dragged, with their own drag picture ---- */
{
  // the feedback box keeps selecting, copying and pasting, but only while it is usable (not locked) and has the focus
  const typing = () => { const t = document.activeElement; return t?.tagName === "TEXTAREA" && !t.disabled && !t.inert; };
  const stop = e => { if (!(e.target.closest?.("textarea") && typing())) e.preventDefault(); };
  for (const type of ["selectstart", "copy", "dragover", "drop"]) addEventListener(type, stop);
  // Ctrl/Cmd+A selects text only inside a usable box that has some; anywhere else (or in an empty box) it selects nothing
  addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "a" && !(typing() && document.activeElement.value)) e.preventDefault();
  });
  $$("a, img, svg").forEach(el => { el.draggable = el.matches("a.chip"); });

  addEventListener("dragstart", e => {
    const chip = e.target.closest?.("a.chip");
    if (!chip) { e.preventDefault(); return; }
    const label = chip.getAttribute("aria-label") || chip.textContent.trim();
    const icon = chip.querySelector("svg use");
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.innerHTML = `<div>${icon ? `<svg aria-hidden="true"><use href="${icon.getAttribute("href")}"/></svg>` : ""}<span></span></div>`;
    ghost.querySelector("span").textContent = label;
    document.body.append(ghost);
    const box = ghost.firstElementChild.getBoundingClientRect(), pad = 14;
    e.dataTransfer.setDragImage(ghost, pad + box.width / 2, pad + box.height / 2);
    e.dataTransfer.effectAllowed = "link";
    const u = chip.dataset.href || chip.href;
    e.dataTransfer.setData("text/uri-list", u);
    e.dataTransfer.setData("text/plain", u);
    chip.classList.add("is-dragging");
    setTimeout(() => ghost.remove(), 0);
  });
  addEventListener("dragend", () => $$("a.chip.is-dragging").forEach(c => c.classList.remove("is-dragging")));
}


/* ---- 8. entrance: the black cover plays while fonts, pictures (loaded and decoded) and sizes get ready, then the first page rises in ---- */
const imageArrived = img => img.complete
  ? (img.naturalWidth ? Promise.resolve() : Promise.reject())
  : new Promise((ok, fail) => { img.addEventListener("load", ok, { once: true }); img.addEventListener("error", fail, { once: true }); });

// own file first; when it is missing, the CDN copy named in data-cdn is tried once
function loadImage(img) {
  img.loading = "eager";
  return imageArrived(img)
    .catch(() => {
      const cdn = img.dataset.cdn;
      if (!cdn) throw 0;
      delete img.dataset.cdn;
      img.referrerPolicy = "no-referrer";
      img.src = cdn;
      return imageArrived(img);
    })
    .then(() => img.decode().catch(() => {}))
    .then(() => img.classList.add("is-loaded"), () => img.remove()); // a failed picture is dropped; its card keeps the letter / dark background
}

async function enter() {
  const intro = $("#intro");
  const minMs = reduceMotion ? 0 : INTRO.minMs;
  const playing = root.classList.contains("is-intro"); // the head script decides, before the first paint

  // the word slides out once Poppins is ready, so it never shows in a fallback font
  const fonts = window.fontsReady ?? Promise.resolve();
  Promise.race([fonts, wait(1200)])
    .then(nextFrame).then(() => intro.classList.add("go"));

  const imgs = $$("img").filter(i => !i.closest(".intro"));
  const loading = Promise.all([fonts, ...imgs.map(loadImage)]);
  if (!playing) { // already played in the last hour: no cover, the page is shown at once; sizes are still measured when fonts and pictures are ready
    intro.remove();
    await Promise.race([loading, wait(2500)]);
    fitWidth(); deck?.measure(); strip?.measure();
    await nextFrame();
    root.classList.add("lit"); // short fade from black (the page stayed hidden until fonts and pictures were ready)
    return;
  }
  await Promise.all([Promise.race([loading, wait(INTRO.maxMs)]), wait(minMs), status.ready(1500)]);

  fitWidth();
  deck?.measure();
  strip?.measure(); // sizes are final now
  await (reduceMotion ? nextFrame() : wait(250));

  root.classList.remove("is-intro");
  setTimeout(() => intro.remove(), 1600);
  if (root.hasAttribute("data-preview")) return; // admin preview: never remembered, so the real site's 1-hour rule is untouched and the entrance plays on every preview
  const stamp = String(Date.now());
  try { localStorage.setItem(INTRO_KEY, stamp); } catch { /* storage blocked: the cookie below still remembers */ }
  try { document.cookie = `${INTRO_KEY}=${stamp}; max-age=${INTRO_TTL_S}; path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`; } catch { /* cookies blocked: it just plays again next time */ }
}

enter().catch(() => root.classList.remove("is-intro"));


/* ---- 9. connection: the "No internet" layer opens only when a HEAD request to the site fails, and closes when it works again ---- */
{
  const box = $("#offline"), retry = $("#offlineRetry");
  let down = false, timer = 0;
  const preview = root.hasAttribute("data-preview"); // the admin preview may not make requests: it is never "offline"
  const reachable = () => preview ? Promise.resolve(true) : fetch("/", { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(6000) }).then(() => true, () => false);
  const check = async () => {
    const ok = await reachable();
    if (ok !== down) return;
    down = !ok;
    box.hidden = ok;
    clearInterval(timer);
    if (down) timer = setInterval(check, 3000);
  };
  retry.addEventListener("click", async () => { retry.disabled = true; await check(); retry.disabled = false; });
  addEventListener("offline", check);
  addEventListener("online", check);
  if (!navigator.onLine) check();
  if (!preview) navigator.serviceWorker?.register("/sw.js").catch(() => {});
}


/* ---- 10. links: the address sits in data-href, not href, so the browser shows no status bar on hover; clicks and Enter are handled here ---- */
{
  $$("a[href]").forEach(a => {
    a.dataset.href = a.getAttribute("href");
    a.removeAttribute("href");
    a.setAttribute("role", "link");
    a.tabIndex = 0;
  });
  const open = (a, newTab) => {
    const u = a.dataset.href;
    if (!u) return;
    if (newTab || a.target === "_blank") window.open(u, "_blank", "noopener,noreferrer"); else location.href = u;
  };
  const link = e => e.target.closest?.("a[data-href]");
  document.addEventListener("click", e => { const a = link(e); if (a) { e.preventDefault(); open(a, e.ctrlKey || e.metaKey); } });
  document.addEventListener("auxclick", e => { const a = link(e); if (a && e.button === 1) { e.preventDefault(); open(a, true); } });
  document.addEventListener("keydown", e => { const a = link(e); if (a && e.key === "Enter") { e.preventDefault(); open(a, false); } });
}


/* ---- 11. cursor: mouse and pen only. One dot that inverts what is under it; it grows over buttons, becomes a hand-sized
   grab dot over the skills strip and turns into the inverted "click" pill over a project picture ---- */
{
  const cur = $("#cur"), tag = $("#curTag"), stripEl = $("#strip"), roadEl = $("#jyStage"); // roadEl: the Journey road drags like the strip
  if (cur && tag && matchMedia("(hover:hover) and (pointer:fine)").matches) {
    const HALF = 32;   // half of the dot's 64px box
    const FOLLOW = 30; // follow speed: higher sticks closer to the pointer
    const POINTER = 'a, button, .chip, #ctx, .tile:not([aria-current]), .slide:not([data-o="0"])';
    let kind = "", shown = false;
    let tagImg = null; // picture under the "click" pill
    const tones = new WeakMap(); // picture -> "light" | "dark", measured once
    let tx = 0, ty = 0, x = 0, y = 0; // target and drawn position
    let snap = false, frame = 0, last = 0;

    // average brightness of a picture from a tiny copy; the pill turns light over a dark picture
    const toneOf = img => {
      if (tones.has(img)) return tones.get(img);
      if (!img.complete || !img.naturalWidth) return "light";
      let tone;
      try {
        const c = document.createElement("canvas"); c.width = c.height = 16;
        const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(img, 0, 0, 16, 16);
        const d = g.getImageData(0, 0, 16, 16).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        tone = sum / (d.length / 4) / 255 < 0.45 ? "dark" : "light";
      } catch { return "light"; }
      tones.set(img, tone);
      return tone;
    };

    const kindOf = (t, down) => {
      if (!(t instanceof Element)) return "dot";
      if (down && (stripEl?.classList.contains("drag") || roadEl?.classList.contains("drag"))) return "grabbing";
      const img = t.closest(".shot img");
      if (img && (img.closest(".slide")?.dataset.o ?? "0") === "0") { tagImg = img; return "tag"; }
      if (t.closest("#insp header") && !t.closest("button")) return down ? "moving" : "move";
      if (t.closest("button:disabled")) return "dot";
      if (t.closest(POINTER)) return "pointer";
      if (t.closest("#strip, #jyStage[data-ready], .jy-stage.is-ready")) return "grab";
      return "dot";
    };
    const apply = k => {
      if (k === kind) return;
      kind = k; cur.dataset.k = k;
      if (k === "tag" && tagImg) tag.dataset.t = toneOf(tagImg);
      tag.classList.toggle("on", shown && k === "tag");
    };
    const show = on => {
      if (on === shown) return;
      shown = on;
      cur.classList.toggle("on", on);
      tag.classList.toggle("on", on && kind === "tag");
      if (on) root.classList.add("cur-on");
    };
    const press = (e, down) => {
      if (e.pointerType === "touch") return;
      cur.classList.toggle("down", down); tag.classList.toggle("down", down);
      apply(kindOf(e.target, down));
    };

    // one loop moves the dot and the pill together; it sleeps once they reach the pointer
    const draw = now => {
      frame = 0;
      const dt = Math.min(now - (last || now - 16), 50) / 1000;
      last = now;
      if (snap) { x = tx; y = ty; snap = false; }
      const k = 1 - Math.exp(-dt * FOLLOW);
      x += (tx - x) * k; y += (ty - y) * k;
      const done = Math.abs(tx - x) < 0.1 && Math.abs(ty - y) < 0.1;
      if (done) { x = tx; y = ty; }
      cur.style.transform = `translate3d(${x - HALF}px,${y - HALF}px,0)`;
      tag.style.transform = `translate3d(${x}px,${y}px,0)`;
      if (done) last = 0; else frame = requestAnimationFrame(draw);
    };
    const wake = () => { if (!frame && !document.hidden) frame = requestAnimationFrame(draw); };

    addEventListener("pointermove", e => {
      if (e.pointerType === "touch") { show(false); return; }
      const p = e.getCoalescedEvents?.().at(-1) ?? e;
      tx = p.clientX; ty = p.clientY;
      if (!shown) snap = true; // appears at the pointer instead of sliding in
      show(true);
      if (kind === "grab" || kind === "grabbing") apply(e.buttons > 0 && (stripEl?.classList.contains("drag") || roadEl?.classList.contains("drag")) ? "grabbing" : "grab");
      wake();
    }, { passive: true });
    addEventListener("pointerover", e => { if (e.pointerType !== "touch") apply(kindOf(e.target, e.buttons > 0)); }, { passive: true });
    addEventListener("pointerout", e => { if (e.pointerType !== "touch") apply(kindOf(e.relatedTarget, e.buttons > 0)); }, { passive: true });
    addEventListener("pointerdown", e => { if (e.pointerType === "touch") show(false); else press(e, true); }, true);
    addEventListener("pointerup", e => press(e, false), true);
    addEventListener("pointercancel", e => press(e, false), true);
    document.addEventListener("mouseleave", () => show(false));
    document.addEventListener("load", e => { if (kind === "tag" && e.target === tagImg) tag.dataset.t = toneOf(tagImg); }, true); // picture finished loading under the pill
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { cancelAnimationFrame(frame); frame = 0; last = 0; snap = true; }
    });
    addEventListener("dragstart", () => show(false)); // the browser draws its own picture while a button is dragged
    addEventListener("dragend", () => show(true));
  }
}


/* ---- 12. right-click menu: "source" opens a source viewer in a new tab, "inspect" starts the in-page inspector.
   A page cannot open view-source: or the browser's developer tools, so both are built here ---- */
{
  const menu = $("#ctx");
  if (menu) {
    const items = $$("button", menu);
    const fine = matchMedia("(hover:hover) and (pointer:fine)");
    let open = false;

    // ---- source viewer: a hand-written tokenizer colours the page, its stylesheet and its script ----
    const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // one span per line, so every line can be cut out on its own
    const tok = (c, t) => t.split("\n").map(p => (p ? `<i class="${c}">${esc(p)}</i>` : "")).join("\n");
    
    // walks src with a regex whose groups map to colour classes; accept() can reject a match
    const lex = (src, re, classes, accept) => {
      let out = "", i = 0, m;
      re.lastIndex = 0;
      while ((m = re.exec(src))) {
        const g = m.findIndex((v, k) => k && v !== undefined);
        if (accept && !accept(g, m)) { re.lastIndex = m.index + 1; continue; }
        out += esc(src.slice(i, m.index)) + tok(classes[g], m[0]);
        i = m.index + m[0].length;
      }
      return out + esc(src.slice(i));
    };
    const JS_RE = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\[\s\S])*`)|(\/(?![*\/])(?:[^\/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[a-z]*)|(\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|this|null|undefined|true|false|void|delete|yield|static|get|set)\b)|(\b(?:0x[\da-fA-F]+|\d[\d_]*(?:\.\d+)?)\b)/g;
    const JS_CLS = [, "cm", "sv", "rx", "kw", "nu"];
    // a slash starts a regex only where a value can start, otherwise it is a division
    const regexOk = (g, m) => {
      if (g !== 3) return true;
      let k = m.index;
      while (k > 0 && /\s/.test(m.input[k - 1])) k--;
      const p = m.input[k - 1];
      return !p || "(,=:[!&|?{};+-*%<>~^".includes(p) || /\b(?:return|typeof|case|of|in)$/.test(m.input.slice(Math.max(0, k - 7), k));
    };
    const CSS_RE = /(\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(@[\w-]+)|(--[\w-]+|[\w-]+(?=\s*:(?!:)[^;{}]*[;}]))|(#[\da-fA-F]{3,8}\b|(?<![\w.#-])-?\d*\.?\d+(?:px|em|rem|%|s|ms|deg|vh|vw|fr)?\b)/g;
    const CSS_CLS = [, "cm", "sv", "kw", "at", "nu"];
    const hlJs = src => lex(src, JS_RE, JS_CLS, regexOk);
    const hlCss = src => lex(src, CSS_RE, CSS_CLS);

    const hlTag = s => {
      const m = /^(<\/?)([^\s>\/]+)([\s\S]*?)(\/?>)$/.exec(s);
      let out = tok("pn", m[1]) + tok("tg", m[2]), eq = false;
      for (const a of m[3].matchAll(/(\s+)|(=)|("[^"]*"|'[^']*')|([^\s="']+)/g)) {
        if (a[1]) out += a[1];
        else if (a[2]) { out += tok("pn", "="); eq = true; }
        else { out += tok(a[3] || eq ? "sv" : "at", a[0]); eq = false; }
      }
      return out + tok("pn", m[4]);
    };
    const hlHtml = src => {
      const re = /<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][^\s>\/]*(?:"[^"]*"|'[^']*'|[^>"'])*>/g;
      let out = "", i = 0, m;
      while ((m = re.exec(src))) {
        out += esc(src.slice(i, m.index));
        i = m.index + m[0].length;
        const s = m[0];
        if (s.startsWith("<!--")) out += tok("cm", s);
        else if (s.startsWith("<!")) out += tok("dt", s);
        else {
          out += hlTag(s);
          const raw = /^<(script|style)\b/i.exec(s);
          if (raw && !s.endsWith("/>")) { // the text inside script and style is code in its own language
            const rest = src.slice(i), k = rest.search(new RegExp(`</${raw[1]}`, "i"));
            const body = k < 0 ? rest : rest.slice(0, k);
            out += raw[1].toLowerCase() === "script" ? hlJs(body) : hlCss(body);
            i += body.length; re.lastIndex = i;
          }
        }
      }
      return out + esc(src.slice(i));
    };

    // ---- source popup: the page, its stylesheet and its script in the site's own look; highlighted lazily, one tab at a time ----
    const pop = $("#src"), tabsEl = $("#srcTabs"), codeEl = $("#srcCode"), copyBtn = $("#srcCopy");
    const FILES = [
      [() => location.href, hlHtml],
      [() => $('link[rel=stylesheet][href*="style.css"]')?.href ?? new URL("/style.css", location.href).href, hlCss],
      [() => $('script[src*="script.js"]')?.src ?? new URL("/script.js", location.href).href, hlJs],
    ];
    let texts = null, srcLoad = null, tab = 0, srcOpen = false, copyT = 0;
    const panes = [];
    const loadSource = () => srcLoad ??= Promise.all(FILES.map(([url]) => fetch(url()).then(r => (r.ok ? r.text() : null)).catch(() => null)))
      .then(t => { if (t.every(x => x === null)) srcLoad = null; return (texts = t); });

    // one row per line; leading spaces become an indent, so a wrapped line stays under its own indent
    const row = h => {
      const m = /^(<i class="\w+">)?([ \t]+)/.exec(h);
      if (!m) return `<div class="ln"><span class="t">${h}</span></div>`;
      return `<div class="ln" style="--i:${m[2].replace(/\t/g, "  ").length}"><span class="t">${(m[1] || "") + h.slice(m[0].length)}</span></div>`;
    };
    const render = n => {
      tab = n;
      $$("button", tabsEl).forEach((b, i) => b.classList.toggle("on", i === n));
      if (panes[n] === undefined) {
        const t = texts?.[n];
        if (t == null) panes[n] = `<p class="none">couldn't load</p>`;
        else {
          const lines = FILES[n][1](t).split("\n");
          if (lines.length > 1 && lines.at(-1) === "") lines.pop();
          panes[n] = lines.map(row).join("");
        }
      }
      codeEl.innerHTML = panes[n];
      codeEl.scrollTop = 0;
      copyBtn.classList.remove("done");
    };
    const openSource = async () => {
      if (srcOpen) return;
      srcOpen = true;
      pop.inert = false; pop.classList.add("on"); root.classList.add("src-open");
      await loadSource();
      if (!srcOpen) return;
      await nextFrame(); // the popup starts to fade in before the text is laid out
      render(tab);
      codeEl.focus({ preventScroll: true }); // arrow keys scroll the code, not the page
    };
    const closeSource = () => {
      if (!srcOpen) return;
      srcOpen = false;
      pop.classList.remove("on"); pop.inert = true; root.classList.remove("src-open");
    };
    tabsEl.addEventListener("click", e => { const b = e.target.closest("button"); if (b) render(+b.dataset.n); });
    $("#srcClose").addEventListener("click", closeSource);
    let downOnBackdrop = false;
    pop.addEventListener("pointerdown", e => { downOnBackdrop = e.target === pop; });
    pop.addEventListener("click", e => { if (e.target === pop && downOnBackdrop) closeSource(); }); // a click outside the box closes it
    addEventListener("keydown", e => { if (srcOpen && e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); closeSource(); } }, true);
    copyBtn.addEventListener("click", async () => {
      const t = texts?.[tab];
      if (t == null) return;
      try { await navigator.clipboard.writeText(t); } catch { return; }
      copyBtn.classList.add("done");
      clearTimeout(copyT); copyT = setTimeout(() => copyBtn.classList.remove("done"), 1400);
    });

    // ---- inspector: hover outlines an element, a click pins it. Styles and sizes are read once per pointerover ----
    const inspector = (() => {
      const box = $("#inspBox"), panel = $("#insp");
      if (!box || !panel) return { start() {} };
      const SIDES = ["Top", "Right", "Bottom", "Left"];
      const nameEl = $("#inspName"), sizeEl = $("#inspSize"), noteEl = $("#inspNote");
      const mk = (tag, cls, text = "") => Object.assign(document.createElement(tag), { className: cls, textContent: text });

      // box model: margin > border > padding > content, built once; each layer has four number cells (top, right, bottom, left)
      const cells = {};
      let inner = null;
      const model = $("#inspModel");
      for (const [key, label] of [["margin", "margin"], ["border", "border"], ["padding", "padding"]]) {
        const layer = mk("div", `bm ${key}`);
        layer.append(mk("u", "", label));
        cells[key] = ["t", "r", "b", "l"].map(c => layer.appendChild(mk("b", c)));
        (inner ?? model).append(layer);
        inner = layer;
      }
      const dim = inner.appendChild(mk("div", "cn"));

      // a short list of the styles a developer looks at first
      const vals = {};
      const list = $("#inspList");
      for (const k of ["color", "background", "font", "margin", "padding", "display", "position"]) {
        list.append(mk("dt", "", k));
        vals[k] = list.appendChild(mk("dd", ""));
      }

      let ac = null, target = null, pinned = false, t0 = 0;
      const num = v => { const n = Math.round(parseFloat(v) * 10) / 10; return Number.isFinite(n) && n ? String(n) : "-"; };

      // reads layout and styles once for the element under the pointer, then moves the one overlay with a transform
      const show = el => {
        target = el;
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        box.style.width = `${r.width}px`; box.style.height = `${r.height}px`;
        box.style.transform = `translate3d(${r.left}px,${r.top}px,0)`;
        const cls = (el.getAttribute("class") ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 3).join(".");
        nameEl.textContent = el.localName + (el.id ? `#${el.id}` : "") + (cls ? `.${cls}` : "");
        sizeEl.textContent = `${Math.round(r.width * 10) / 10} × ${Math.round(r.height * 10) / 10}`;
        for (const k of ["margin", "border", "padding"]) cells[k].forEach((c, i) => { c.textContent = num(cs[k === "border" ? `border${SIDES[i]}Width` : k + SIDES[i]]); });
        dim.textContent = `${num(cs.width)} × ${num(cs.height)}`;
        vals.color.textContent = cs.color; vals.color.style.setProperty("--sw", cs.color);
        vals.background.textContent = cs.backgroundColor; vals.background.style.setProperty("--sw", cs.backgroundColor);
        vals.font.textContent = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily.split(",")[0].replace(/["']/g, "")}`;
        vals.margin.textContent = cs.margin; vals.padding.textContent = cs.padding;
        vals.display.textContent = cs.display; vals.position.textContent = cs.position;
        box.classList.add("on");
      };
      const inside = t => t instanceof Node && (panel.contains(t) || menu.contains(t));
      const stop = () => {
        ac?.abort(); ac = null; pinned = false; target = null;
        box.classList.remove("on", "pinned"); panel.classList.remove("on", "pinned"); panel.inert = true;
        noteEl.textContent = "";
      };
      const start = (x, y) => {
        if (ac) return;
        ac = new AbortController();
        const opt = { capture: true, signal: ac.signal };
        t0 = performance.now(); pinned = false;
        panel.inert = false; panel.classList.add("on");
        noteEl.textContent = "hover to look, click to pin";
        addEventListener("pointerover", e => {
          if (e.pointerType === "touch" || inside(e.target) || !(e.target instanceof Element)) return;
          if (!pinned) show(e.target);
        }, { ...opt, passive: true });
        // the page is read-only while inspecting: a press does nothing, a click pins the element under the pointer or lets it go
        addEventListener("pointerdown", e => { if (!inside(e.target)) e.stopPropagation(); }, opt);
        addEventListener("click", e => {
          if (inside(e.target) || e.timeStamp < t0) return;
          e.preventDefault(); e.stopPropagation();
          pinned = !pinned;
          box.classList.toggle("pinned", pinned); panel.classList.toggle("pinned", pinned);
          noteEl.textContent = pinned ? "pinned, click to release" : "hover to look, click to pin";
          if (!pinned && e.target instanceof Element) show(e.target);
        }, opt);
        addEventListener("keydown", e => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); stop(); } }, opt);
        addEventListener("resize", () => { if (target?.isConnected) show(target); }, { signal: ac.signal, passive: true });
        // starts by itself: outline whatever is under the pointer right now
        const el = document.elementFromPoint(x, y);
        if (el && !inside(el)) show(el);
      };
      $("#inspClose")?.addEventListener("click", stop);
      // the panel stays exactly where it is put: drag it by its top strip, anywhere on the screen
      {
        const head = $("header", panel);
        let dx = 0, dy = 0, grab = null;
        const place = (nx, ny) => {
          const r = panel.getBoundingClientRect(), bx = r.left - dx, by = r.top - dy, M = 8;
          dx = clamp(nx, M - bx, innerWidth - M - r.width - bx);
          dy = clamp(ny, M - by, innerHeight - M - r.height - by);
          panel.style.setProperty("--dx", `${dx}px`); panel.style.setProperty("--dy", `${dy}px`);
        };
        head.addEventListener("pointerdown", e => {
          if (e.button !== 0 || e.target.closest("button")) return;
          grab = { id: e.pointerId, x: e.clientX - dx, y: e.clientY - dy };
          head.setPointerCapture(e.pointerId);
        });
        head.addEventListener("pointermove", e => { if (grab && e.pointerId === grab.id) place(e.clientX - grab.x, e.clientY - grab.y); });
        const drop = e => { if (grab && e.pointerId === grab.id) grab = null; };
        head.addEventListener("pointerup", drop); head.addEventListener("pointercancel", drop);
        addEventListener("resize", () => { if (panel.classList.contains("on")) place(dx, dy); });
      }
      return { start };
    })();

    const close = () => {
      if (!open) return;
      open = false;
      menu.classList.remove("on"); menu.inert = true;
    };

    addEventListener("contextmenu", e => {
      e.preventDefault();
      if (e.target.closest?.("textarea")) return; // the feedback box has no right-click menu at all, not the browser's and not ours
      if (!fine.matches || srcOpen) return;
      loadSource();
      menu.inert = false;
      const x = clamp(e.clientX, 8, innerWidth - menu.offsetWidth - 8), y = clamp(e.clientY, 8, innerHeight - menu.offsetHeight - 8);
      menu.style.translate = `${x}px ${y}px`;
      menu.classList.add("on"); open = true;
      items[0].focus({ preventScroll: true });
    });

    menu.addEventListener("click", e => {
      const b = e.target.closest("button");
      if (!b) return;
      close();
      if (b.dataset.act === "source") openSource(); else inspector.start(e.clientX, e.clientY);
    });

    addEventListener("pointerdown", e => { if (open && !menu.contains(e.target)) close(); }, true);
    addEventListener("wheel", close, { passive: true });
    addEventListener("resize", close);
    addEventListener("blur", close);
    // while the menu is open the arrow / W / S / Tab keys move inside it instead of changing the page
    addEventListener("keydown", e => {
      if (!open || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "escape") { e.preventDefault(); close(); return; }
      const dir = k === "arrowdown" || k === "s" || (k === "tab" && !e.shiftKey) ? 1 : k === "arrowup" || k === "w" || (k === "tab" && e.shiftKey) ? -1 : 0;
      if (!dir) return;
      e.preventDefault(); e.stopImmediatePropagation();
      items[mod(items.indexOf(document.activeElement) + dir, items.length)].focus();
    }, true);
  }
}
