// Admin app: login, session, shell, Feedback, the draft editors (Texts, Images, Buttons, Projects, Stack) and Push (push.js).
import "./guard.js";
import { ApiError, api, chip, confirmDialog, draft, explain, h, hideNativeTooltips, icon, iconButton, isHeld, loadMe, onSignedOut, panel, stars, textButton, toast } from "./ui.js";
import * as engine from "./draft.js";
import { textsView } from "./texts.js";
import { buttonsView } from "./buttons.js";
import { imagesView } from "./images.js";
import { projectsView } from "./projects.js";
import { stackView } from "./stack.js";
import { journeyView } from "./journey.js";
import { pushView } from "./push.js";
import { mountPreview, unmountPreview } from "./preview.js";

const app = document.getElementById("app");
hideNativeTooltips(); // no browser-default hover text anywhere in the admin
const SECTIONS = [
  { id: "texts", label: "Texts", icon: "text" },
  { id: "images", label: "Images", icon: "image" },
  { id: "buttons", label: "Buttons", icon: "button" },
  { id: "projects", label: "Projects", icon: "work" },
  { id: "stack", label: "Stack", icon: "code" },
  { id: "journey", label: "Journey", icon: "route" },
  { id: "feedback", label: "Feedback", icon: "feedback" },
  { id: "push", label: "Push", icon: "push" },
];
const DEFAULT = "feedback";
const EDITORS = { texts: textsView, images: imagesView, buttons: buttonsView, projects: projectsView, stack: stackView, journey: journeyView, push: pushView };

let me = null;
let expiryTimer = 0;
let active = DEFAULT; // the open section lives in memory only: the address stays /admin
let current = null; // the open section, so it can clean up when another one opens

/* ---------- login / denied ---------- */
function gate(kind) {
  clearTimeout(expiryTimer);
  unmountPreview();
  me = null;
  engine.store.set({ status: "idle" }); // the saved draft stays in IndexedDB and is picked up again after sign-in
  const messages = { denied: ["alert", "Access denied"], failed: ["alert", "Sign-in failed"], ended: ["lock", "Session ended"], closed: ["alert", "Not set up"], offline: ["alert", "No connection"] };
  const [ico, text] = messages[kind] ?? ["lock", "Admin"];
  const action = kind === "offline"
    ? textButton("Retry", () => boot(), { lead: "refresh" })
    : kind === "closed" ? null
    : h("button", { class: "btn", type: "button", onclick: () => location.assign("/api/admin/login") }, icon("github", "lead"), kind === "denied" || kind === "failed" ? "Try again" : "Sign in");
  app.replaceChildren(
    h("main", { class: "gate" },
      h("section", { class: "card gate-card" },
        h("i", { class: "hl" }),
        icon(ico, "gate-ico"),
        h("h1", {}, text),
        action)));
}

/* ---------- shell ---------- */
function shell() {
  const ind = h("li", { class: "ind", "aria-hidden": "true" }, h("i", { class: "r1" }), h("i", { class: "r2" }));
  const links = SECTIONS.map((s) => h("li", {}, h("a", { role: "button", tabindex: "0", "data-tip": s.label, "aria-label": s.label, "data-id": s.id, onclick: () => go(s.id), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(s.id); } } }, icon(s.icon), s.id === "push" ? h("i", { class: "pip", hidden: true, id: "pip" }) : null)));
  const out = h("li", { class: "sep" }, h("button", { type: "button", "data-tip": "Sign out", "aria-label": "Sign out", onclick: signOut }, icon("logout")));
  const nav = h("nav", { class: "nav fx", "aria-label": "Admin" }, h("ul", {}, ind, ...links, out));
  const main = h("main", { class: "main", id: "main", tabindex: "-1" });
  app.replaceChildren(h("div", { class: "shell" }, nav, main));

  const place = () => {
    const a = nav.querySelector("a[aria-current]");
    if (!a) return;
    const li = a.parentElement;
    ind.style.transform = `translate(${li.offsetLeft}px,${li.offsetTop}px)`;
  };
  addEventListener("resize", place);
  shell.place = () => { place(); requestAnimationFrame(() => nav.classList.add("run")); };
  draft.subscribe((s) => { if (!isHeld()) document.getElementById("pip").hidden = s.changes.length === 0; });
}

async function signOut() {
  if (!(await confirmDialog({ title: "Sign out?", text: "You will need to sign in again.", ok: "Sign out", danger: true }))) return;
  try {
    await api("/api/admin/logout", { method: "POST" });
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) return toast(explain(e));
  }
  active = DEFAULT;
  gate("ended");
}

/* ---------- routing (in memory: no hash, no history entries, no reload) ---------- */
function go(id) {
  if (!SECTIONS.some((s) => s.id === id) || id === active) return;
  active = id;
  route();
}
function route() {
  if (!me) return;
  const id = active;
  const section = SECTIONS.find((s) => s.id === id);
  for (const a of document.querySelectorAll(".nav a")) {
    if (a.dataset.id === id) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  shell.place();
  scrollTo(0, 0);
  const main = document.getElementById("main");
  current?.stop?.();
  const ready = engine.store.get().status === "ready";
  const view = current = id === "feedback" ? feedbackView() : ready ? EDITORS[id]() : loadView();
  main.replaceChildren(h("header", { class: "bar" }, h("h1", {}, section.label), view.bar ?? null), view.el);
  view.start?.();
}

/* ---------- up / down: the previous / next section ----------
   Every input moves exactly ONE section, however hard or fast it is made:
   - keys: arrow up / down or W / S (a held key does not repeat)
   - touch: a vertical swipe
   - wheel / trackpad: one scroll gesture, momentum included, is one step (a gesture ends after a short pause)
   Touch and wheel act only when the page cannot scroll any further that way, so scrolling a long list is never hijacked. */
const stepSection = (dir) => {
  const next = SECTIONS[SECTIONS.findIndex((s) => s.id === active) + dir];
  if (next) go(next.id);
};
const sectionKeysBlocked = (e) => !me || document.querySelector("dialog[open]") || document.documentElement.classList.contains("pv-on")
  || e.target.closest?.("input, textarea, select, [contenteditable], [role=slider], .grip, .pv");
const pageEdge = () => ({ top: scrollY <= 1, bottom: scrollY + innerHeight >= document.documentElement.scrollHeight - 1 });
// true when an element around the pointer (a scrollable panel, say) can still scroll that way by itself
const innerCanScroll = (el, dir) => {
  for (let n = el instanceof Element ? el : null; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    if (n.scrollHeight <= n.clientHeight + 1 || !/(auto|scroll)/.test(getComputedStyle(n).overflowY)) continue;
    if (dir > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0) return true;
  }
  return false;
};
addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const k = e.key.toLowerCase();
  const dir = k === "arrowup" || k === "w" ? -1 : k === "arrowdown" || k === "s" ? 1 : 0;
  if (!dir || sectionKeysBlocked(e)) return;
  e.preventDefault();
  stepSection(dir);
});
{
  let t0 = null;
  addEventListener("touchstart", (e) => {
    t0 = e.touches.length === 1 && me && !sectionKeysBlocked(e) && !e.target.closest?.(".bpv, .nav")
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: performance.now(), y0: scrollY, el: e.target, ...pageEdge() } : null;
  }, { passive: true });
  addEventListener("touchcancel", () => { t0 = null; }, { passive: true });
  addEventListener("touchend", (e) => {
    const s = t0; t0 = null;
    if (!s || e.touches.length) return;
    const c = e.changedTouches[0], dx = c.clientX - s.x, dy = c.clientY - s.y;
    if (Math.abs(dy) < 60 || Math.abs(dx) > Math.abs(dy) * .6 || performance.now() - s.t > 900 || Math.abs(scrollY - s.y0) > 2) return;
    const dir = dy < 0 ? 1 : -1;
    if ((dir > 0 ? s.bottom : s.top) && !innerCanScroll(s.el, dir)) stepSection(dir);
  }, { passive: true });
}
{
  // One wheel / trackpad gesture = one section. A gesture is a run of wheel events with no pause longer than GAP_MS;
  // the momentum tail of a trackpad swipe belongs to the same gesture, so it can never add a second step.
  // A new swipe started on top of the old momentum is told apart by a clear rise in speed after the tail had died down.
  const GAP_MS = 140, NEED_PX = 3, FLIP_PX = 12, DECAYED = .5, RISE = 2.5, RISE_PX = 12;
  let lastT = 0, sign = 0, armed = false, acc = 0, peak = 0, low = 0;
  addEventListener("wheel", (e) => {
    if (e.ctrlKey || !me) return; // ctrl + wheel is the browser zoom
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 300 : 1;
    const d = e.deltaY * unit, ad = Math.abs(d);
    if (ad < 1 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // sideways scrolling is not for this
    const sg = d < 0 ? -1 : 1, now = e.timeStamp, gap = now - lastT;
    lastT = now;
    const fresh = gap > GAP_MS || (sg !== sign && ad >= FLIP_PX) || (!armed && low <= peak * DECAYED && ad >= low * RISE && ad - low >= RISE_PX);
    if (fresh) {
      peak = low = ad; acc = 0;
      const edge = pageEdge();
      armed = !sectionKeysBlocked(e) && (sg > 0 ? edge.bottom : edge.top) && !innerCanScroll(e.target, sg);
    } else if (ad >= peak) { peak = low = ad; }
    else if (ad < low) low = ad;
    sign = sg;
    if (!armed) return;
    acc += d;
    if (Math.abs(acc) < NEED_PX) return;
    armed = false; // this gesture has used its one step
    stepSection(acc < 0 ? -1 : 1);
  }, { passive: true });
}

/* ---------- editors need the draft: load it first, then open the section ---------- */
function loadView() {
  const body = h("div", { class: "empty" });
  let off = () => {};
  const draw = (s) => {
    const messages = { norepo: "Repo not set up", offline: "No connection", failed: "Could not load" };
    body.replaceChildren(...(s.status === "error"
      ? [icon("alert", "empty-ico"), h("p", {}, messages[s.error] ?? messages.failed), textButton("Retry", () => engine.load(), { lead: "refresh" })]
      : [icon("refresh", "empty-ico spin"), h("p", {}, "Loading")]));
  };
  return {
    el: panel({ body: [body] }),
    start() {
      off = engine.store.subscribe((s) => { if (s.status === "ready") route(); else draw(s); });
      draw(engine.store.get());
      if (engine.store.get().status === "idle") engine.load();
    },
    stop: () => off(),
  };
}

/* ---------- feedback ---------- */
const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const SIZE = 20;

const PIN_MAX = 3;
let doneOpen = false; // the "Done" section stays as you left it while you stay in the admin

function feedbackView() {
  const state = { page: 1, busy: false };
  const meta = h("div", { class: "meta" });
  const list = h("div", { class: "fb-list sel", id: "fbList", tabindex: "-1" });
  const pager = h("nav", { class: "pager", "aria-label": "Pages", hidden: true });
  const refresh = iconButton("refresh", "Refresh", () => load());
  const reset = textButton("Reset limit", async () => {
    const yes = await confirmDialog({ title: "Reset feedback limit?", text: "Every visitor can send feedback again right away, including you.", ok: "Reset", danger: true });
    if (!yes) return;
    reset.disabled = true;
    try {
      await api("/api/admin/reset-limits", { method: "POST" });
      toast("Limit reset", "ok", 2600);
    } catch (e) {
      fail(e);
    } finally {
      reset.disabled = false;
    }
  }, { lead: "unlock" });
  const el = h("div", { class: "stack" }, panel({ cls: "fb-panel", body: [list] }), pager);

  async function load() {
    if (state.busy) return;
    state.busy = true;
    refresh.disabled = true;
    list.setAttribute("aria-busy", "true");
    let again = false;
    try {
      const data = await api(`/api/admin/feedback?page=${state.page}&size=${SIZE}`);
      if (data.page > data.pages) { state.page = data.pages; again = true; } // the last page was just emptied
      else draw(data);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) drawError(e);
    } finally {
      state.busy = false;
      refresh.disabled = false;
      list.removeAttribute("aria-busy");
    }
    if (again) return load();
  }

  function drawError(e) {
    meta.replaceChildren();
    pager.hidden = true;
    list.replaceChildren(h("div", { class: "empty" }, icon("alert", "empty-ico"), h("p", {}, explain(e)), textButton("Retry", () => load(), { lead: "refresh" })));
  }

  /** A small heading for the Pinned section. */
  const heading = (text, count) => h("div", { class: "fb-sec fb-sec-static" }, h("span", {}, text), h("b", {}, count));

  function draw(data) {
    meta.replaceChildren(
      chip("avg", { lead: "feedback", strong: data.avg === null ? "–" : (Math.round(data.avg * 10) / 10).toFixed(1) }),
      chip("total", { strong: data.total }),
      chip("unread", { strong: data.unread }));

    const pinned = [...(data.pinned ?? [])].sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
    const pinnedIds = new Set(pinned.map((x) => x.id));
    const rest = data.items.filter((x) => !pinnedIds.has(x.id)); // already newest first
    const open = rest.filter((x) => !x.read);
    const done = rest.filter((x) => x.read);
    const full = pinned.length >= PIN_MAX;

    const nodes = [];
    if (pinned.length) nodes.push(h("section", { class: "fb-group", "aria-label": "Pinned" }, heading("Pinned", `${pinned.length}/${PIN_MAX}`), ...pinned.map((x) => row(x, full))));
    nodes.push(...open.map((x) => row(x, full)));
    if (done.length) {
      const body = h("div", { class: "fb-group", hidden: !doneOpen }, ...done.map((x) => row(x, full)));
      const head = h("button", { class: "fb-sec", type: "button", "aria-expanded": String(doneOpen) }, h("span", {}, "Done"), h("b", {}, done.length));
      head.addEventListener("click", () => { doneOpen = !doneOpen; body.hidden = !doneOpen; head.setAttribute("aria-expanded", String(doneOpen)); });
      nodes.push(h("section", { class: "fb-group", "aria-label": "Done" }, head, body));
    }
    if (!nodes.length) nodes.push(h("div", { class: "empty" }, icon("inbox", "empty-ico"), h("p", {}, "No feedback")));
    list.replaceChildren(...nodes);

    pager.hidden = data.pages <= 1;
    pager.replaceChildren(
      iconButton("prev", "Previous", () => go(state.page - 1), { disabled: data.page <= 1 }),
      h("span", { class: "pg", "aria-live": "polite" }, `${data.page} / ${data.pages}`),
      iconButton("next", "Next", () => go(state.page + 1), { disabled: data.page >= data.pages }));
  }

  function go(page) { state.page = page; load().then(() => list.focus({ preventScroll: true })); }

  const fail = (e) => { if (!(e instanceof ApiError && e.status === 401)) toast(explain(e)); };

  function row(item, pinsFull) {
    const star = iconButton(item.pinned ? "starfill" : "star", item.pinned ? "Unpin" : "Pin", async () => {
      star.disabled = true;
      try {
        await api(`/api/admin/feedback/${item.id}`, { method: "PATCH", body: { pinned: !item.pinned } });
      } catch (e) {
        star.disabled = false;
        return fail(e);
      }
      load();
    }, { disabled: !item.pinned && pinsFull });
    star.classList.toggle("on", Boolean(item.pinned));
    if (!item.pinned && pinsFull) star.setAttribute("aria-label", "Pin (3 already pinned)");
    const done = iconButton(item.read ? "squarecheck" : "square", item.read ? "Mark as not done" : "Mark as done", async () => {
      done.disabled = true;
      try {
        await api(`/api/admin/feedback/${item.id}`, { method: "PATCH", body: { read: !item.read } });
      } catch (e) {
        done.disabled = false;
        return fail(e);
      }
      load(); // moves the card between the list and the Done section, and keeps the unread counter honest
    });
    done.classList.toggle("on", Boolean(item.read));
    done.setAttribute("aria-pressed", String(Boolean(item.read)));
    const el = h("article", { class: `fb-row${item.read ? "" : " unread"}${item.pinned ? " pinned" : ""}`, "data-id": item.id },
      h("div", { class: "fb-top" },
        h("i", { class: "udot", "aria-hidden": "true" }),
        stars(item.rating),
        h("time", { datetime: item.createdAt ?? "" }, item.createdAt ? when.format(new Date(item.createdAt)) : ""),
        h("div", { class: "fb-act" },
          star,
          done,
          iconButton("trash", "Delete", async () => {
            const yes = await confirmDialog({ title: "Delete feedback?", text: "This cannot be undone.", ok: "Delete", danger: true });
            if (!yes) return;
            try {
              await api(`/api/admin/feedback/${item.id}`, { method: "DELETE" });
              toast("Deleted", "ok", 2200);
            } catch (e) {
              if (e instanceof ApiError && e.status === 404) { toast("Already gone", "ok", 2200); }
              else { fail(e); return; }
            }
            load();
          }, { danger: true }))),
      item.message ? h("p", { class: "msg" }, item.message) : h("p", { class: "msg none" }, "No message"));
    return el;
  }

  return { bar: h("div", { class: "bar-end" }, meta, reset, refresh), el, start: load };
}

/* ---------- boot ---------- */
function expiry() {
  clearTimeout(expiryTimer);
  const wait = Math.min(me.exp - Date.now(), 2 ** 31 - 1);
  expiryTimer = setTimeout(() => gate("ended"), Math.max(0, wait));
}

async function boot() {
  const e = new URLSearchParams(location.search).get("e");
  if (location.pathname !== "/admin" || location.search || location.hash) history.replaceState(null, "", "/admin"); // the address is always plain /admin
  if (e === "denied" || e === "failed") return gate(e);
  try {
    me = await loadMe();
  } catch (err) {
    return gate(err instanceof ApiError && err.status === 0 ? "offline" : err instanceof ApiError && err.status === 501 ? "closed" : "login");
  }
  expiry();
  shell();
  mountPreview();
  route();
}

onSignedOut(() => { if (me) gate("ended"); });
addEventListener("hashchange", () => { if (location.hash) history.replaceState(null, "", "/admin"); });
boot();
