// Shared admin building blocks: DOM helper, icon, panel, chip, toggle, input, confirm dialog, toast, draft store, fetch wrapper.
// Everything is built with DOM calls and text nodes (never markup strings), so nothing typed by a visitor can run as markup.
const SVG = "http://www.w3.org/2000/svg";

/** h("div", { class: "x", onclick: fn, "aria-label": "y" }, "text", childNode, ...) */
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "value" || key === "checked" || key === "disabled" || key === "hidden") el[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  el.append(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
  return el;
}

export function icon(name, cls = "") {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("aria-hidden", "true");
  if (cls) svg.setAttribute("class", cls);
  const use = document.createElementNS(SVG, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

/** Five stars, `rating` of them filled. */
export function stars(rating) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "stars");
  svg.setAttribute("viewBox", "0 0 120 24");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${rating} of 5`);
  for (let i = 0; i < 5; i++) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", "M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z");
    path.setAttribute("transform", `translate(${i * 24} 0)`);
    path.setAttribute("fill", i < rating ? "currentColor" : "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("class", i < rating ? "on" : "off");
    svg.append(path);
  }
  return svg;
}

/** The site's card with its top highlight. */
export const panel = ({ title, actions = [], body = [], cls = "" } = {}) =>
  h("section", { class: `card pnl ${cls}`.trim() },
    h("i", { class: "hl" }),
    title || actions.length ? h("header", { class: "pnl-head" }, h("h2", {}, title ?? ""), h("div", { class: "pnl-act" }, ...actions)) : null,
    ...[].concat(body));

/** Small label, like the site's buttons but static. `lead` is an icon name. */
export const chip = (text, { lead, strong } = {}) =>
  h("span", { class: "chip" }, lead ? icon(lead) : null, strong !== undefined ? h("b", {}, String(strong)) : null, text);

/** Round icon button: label is required (it is the only text). */
export const iconButton = (name, label, onclick, { disabled = false, danger = false } = {}) =>
  h("button", { class: `btn ibtn${danger ? " danger" : ""}`, type: "button", "aria-label": label, disabled, onclick }, icon(name));

export const textButton = (label, onclick, { lead, disabled = false } = {}) =>
  h("button", { class: "btn", type: "button", disabled, onclick }, lead ? icon(lead, "lead") : null, label);

/** On/off switch. onChange(next) may return a promise; the switch waits for it and goes back if it throws. */
export function toggle({ label, checked = false, onChange, disabled = false }) {
  const el = h("button", { class: "tg", type: "button", role: "switch", "aria-checked": String(checked), "aria-label": label, disabled });
  el.addEventListener("click", async () => {
    const next = el.getAttribute("aria-checked") !== "true";
    el.disabled = true;
    el.setAttribute("aria-checked", String(next));
    try { await onChange?.(next); } catch { el.setAttribute("aria-checked", String(!next)); } finally { el.disabled = disabled; }
  });
  return el;
}

/** Labelled single or multi line input with an optional live character counter. */
export function input({ label, value = "", max, multiline = false, disabled = false, onInput, id }) {
  const uid = id ?? `f-${Math.random().toString(36).slice(2, 8)}`;
  const field = h(multiline ? "textarea" : "input", { id: uid, class: "inp", value, disabled, maxlength: max, rows: multiline ? 4 : null, type: multiline ? null : "text", autocomplete: "off", spellcheck: "false" });
  const count = max ? h("span", { class: "cnt" }) : null;
  const sync = () => { if (count) count.textContent = `${[...field.value].length}/${max}`; };
  field.addEventListener("input", () => { sync(); onInput?.(field.value); });
  sync();
  return h("div", { class: "fld" }, h("label", { for: uid }, label), field, count);
}

/** Counters (unsaved, errors, nav dot) stay as they were while an editor dialog is open and catch up when the last one closes.
 *  hold() returns a release function; calling it twice is harmless. */
let holds = 0;
export const isHeld = () => holds > 0;
export function hold() {
  holds++;
  let on = true;
  return () => { if (on) { on = false; holds--; } };
}

/** Resolves true (confirmed) or false (cancelled or Esc; clicking outside does nothing). Cancel has the focus, so Enter never confirms by accident. */
export function confirmDialog({ title, text = "", ok = "OK", danger = false }) {
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: "dlg", "aria-labelledby": "dlgT" });
    const done = (value) => { dlg.close(); dlg.remove(); resolve(value); };
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); done(false); });
    dlg.append(
      h("h2", { id: "dlgT" }, title),
      text ? h("p", {}, text) : null,
      h("div", { class: "dlg-row" },
        h("button", { class: "btn", type: "button", autofocus: true, onclick: () => done(false) }, "Cancel"),
        h("button", { class: `btn${danger ? " danger" : ""}`, type: "button", onclick: () => done(true) }, ok)),
    );
    document.body.append(dlg);
    dlg.showModal();
  });
}

/** One short message at the bottom. tone: "err" | "ok". */
export function toast(message, tone = "err", ms = 4200) {
  const host = document.getElementById("toasts");
  const el = h("div", { class: `toast ${tone}` }, h("i", { class: "dot" }), message);
  host.append(el);
  while (host.children.length > 3) host.firstChild.remove();
  setTimeout(() => el.remove(), ms);
}

/** Tiny observable store. The editors keep their draft in one of these (and in IndexedDB). */
export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(patch) { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; subs.forEach((fn) => fn(state)); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}
// Unsaved changes: the editors fill `changes`, Push sends them.
export const draft = createStore({ changes: [] });

/* ---- fetch wrapper: same-origin JSON, CSRF header, 401 / 403 / 429 handling ---- */
export class ApiError extends Error {
  constructor(status, code, wait = 0) { super(code); this.status = status; this.code = code; this.wait = wait; }
}
let csrf = "";
const bus = new EventTarget();
export const onSignedOut = (fn) => bus.addEventListener("signedout", fn);

export async function api(path, { method = "GET", body, retry = true } = {}) {
  const headers = { Accept: "application/json" };
  if (method !== "GET") { headers["Content-Type"] = "application/json"; headers["X-CSRF-Token"] = csrf; }
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin", cache: "no-store", redirect: "error" });
  } catch { throw new ApiError(0, "network"); }
  const data = await res.json().catch(() => null);
  if (res.ok) return data;
  const code = typeof data?.error === "string" ? data.error : "server";
  if (res.status === 401) { bus.dispatchEvent(new Event("signedout")); throw new ApiError(401, code); }
  if (res.status === 403 && code === "csrf" && retry) { await loadMe(); return api(path, { method, body, retry: false }); } // token is session-bound: fetch a fresh one once
  if (res.status === 429) throw new ApiError(429, "limit", Number(res.headers.get("Retry-After")) || 0);
  const failure = new ApiError(res.status, code);
  if (Array.isArray(data?.errors)) failure.errors = data.errors.slice(0, 20).map(String); // the validator's own messages (push)
  throw failure;
}

/** The current CSRF token (for the preview form, which cannot send headers). */
export const csrfToken = () => csrf;

/** Who is signed in, and the CSRF token for this session. */
export async function loadMe() {
  const me = await api("/api/admin/me");
  csrf = me.csrf;
  return me;
}

/** One short sentence for any error. */
const CODES = { pinlimit: "Max 3 pinned", moved: "Repo changed", dup: "Already sent", readonly: "Token cannot write", github: "GitHub error", nochange: "No changes", norepo: "Repo not set up" };
export function explain(err) {
  if (!(err instanceof ApiError)) return "Something went wrong";
  if (err.status !== 429 && CODES[err.code]) return CODES[err.code];
  if (err.status === 422) return "Fix the errors first";
  if (err.status === 0) return "No connection";
  if (err.status === 401) return "Signed out";
  if (err.status === 429) return err.wait ? `Too many requests. Wait ${err.wait < 90 ? `${err.wait}s` : `${Math.ceil(err.wait / 60)} min`}` : "Too many requests";
  if (err.status === 403) return "Blocked";
  if (err.status === 404) return "Not found";
  if (err.status === 501) return "Not set up";
  if (err.status === 400 || err.status === 413 || err.status === 415) return "Invalid request";
  return "Server error";
}

/** The browser's own hover tooltip (the `title` attribute) never shows in the admin: labels live in aria-label, and the nav draws its own tip.
 *  Strips any title attribute that appears, now or later, so no element can bring it back. */
export function hideNativeTooltips(root = document.body) {
  const strip = (el) => { if (el.nodeType === 1 && el.hasAttribute("title")) el.removeAttribute("title"); };
  const sweep = (node) => { strip(node); if (node.nodeType === 1) node.querySelectorAll("[title]").forEach(strip); };
  sweep(root);
  let queue = [], frame = 0;
  const run = () => { frame = 0; const todo = queue; queue = []; for (const n of todo) if (n.isConnected) sweep(n); };
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === "attributes") strip(m.target); // a title set on an element is removed at once
      else m.addedNodes.forEach((n) => { if (n.nodeType === 1) queue.push(n); }); // new nodes are swept together, once per frame
    }
    if (queue.length && !frame) frame = requestAnimationFrame(run);
  }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["title"] });
}
