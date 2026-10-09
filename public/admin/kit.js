// Editor building blocks shared by Texts, Buttons, Images, Projects and Stack. Built on ui.js; DOM calls only (no markup strings).
import { h, icon, iconButton, input, toast, toggle, confirmDialog, chip, draft as pending, hold, isHeld } from "./ui.js";
import { store, edit, errorsFor, discardAll, fileList, srcOf, addFile, settled, check, reorder } from "./draft.js";
import { safeName, EMAIL, webProblem } from "./logic.js";
import { processImage, processSvg, measure, MediaError } from "./media.js";

/** Calls the registered refresh functions whenever the draft changes (next frame), until stop(). */
export function live() {
  const fns = [];
  let off = null, frame = 0;
  const run = () => { frame = 0; fns.forEach((fn) => fn()); };
  return {
    form: null, // set by editorDialog: { fields, tried }
    add: (fn) => { fns.push(fn); fn(); return fn; },
    flush() { cancelAnimationFrame(frame); run(); }, // repaint right now
    start() { off ??= store.subscribe(() => { if (!frame) frame = requestAnimationFrame(run); }); },
    stop() { off?.(); off = null; cancelAnimationFrame(frame); frame = 0; },
  };
}

/** Marks an input as invalid (red ring + aria-invalid). Instant, no animation, and never a message under the input. */
function flag(target, bad) {
  target.classList.toggle("bad", bad);
  if (bad) target.setAttribute("aria-invalid", "true"); else target.removeAttribute("aria-invalid");
}
/** Marks a label as required (a small asterisk). */
const req = (root, on) => { if (on) root.querySelector("label")?.classList.add("req"); return root; };
const pathOf = (path) => (typeof path === "function" ? path() : path);
/** The server's complaint about a path, but only when it is about what is on screen right now. */
const serverSays = (path) => Boolean(path) && settled() && errorsFor(pathOf(path)).length > 0;
/** Lets a dialog know about a field: el to scroll to, focus(), bad() = cannot be confirmed, path() for the server's complaints. */
const enroll = (lv, entry) => { lv?.form?.fields.push(entry); };
/** A required field that is still empty only turns red after Done was pressed. */
const tried = (lv) => Boolean(lv?.form?.tried);
/** Ids of items that are open in an "Add" dialog and not confirmed yet; lists skip them. */
export const pendingIds = new Set();
export { EMAIL };

/** Text field with counter, per-field reset and the validator's message. get/orig read the draft and the loaded value. */
export function field({ label, path, get, orig, set, max, multiline = false, lv, plain = false, required = false, valid = null }) {
  let paint = () => {};
  let touched = false; // a format rule (valid) only speaks after the field was left once, or after Done
  const fld = input({ label, value: get(), max, multiline, onInput: (v) => { set(plain ? v : multiline ? v.replace(/[\r\n]+/g, " ") : v); paint(); } });
  req(fld, required);
  const inp = fld.querySelector(".inp");
  if (multiline && !plain) { // one line only: Enter does nothing, pasted line breaks become spaces (the field shows exactly what is saved)
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
    inp.addEventListener("input", () => { if (/[\r\n]/.test(inp.value)) { inp.value = inp.value.replace(/[\r\n]+/g, " "); inp.dispatchEvent(new Event("input")); } });
  }
  const reset = iconButton("undo", "Reset", () => { set(orig()); inp.value = orig(); inp.dispatchEvent(new Event("input")); });
  reset.classList.add("rst");
  const el = h("div", { class: "fe" }, fld, reset);
  const missing = () => required && !inp.value.trim();
  const wrong = () => Boolean(inp.value && valid && !valid(inp.value));
  paint = () => {
    const speak = touched || tried(lv);
    flag(inp, (inp.value !== "" && serverSays(path) && (!valid || speak)) || (speak && wrong()) || (tried(lv) && missing()));
  };
  inp.addEventListener("blur", () => { touched = true; paint(); });
  lv.add(() => {
    if (document.activeElement !== inp && inp.value !== get()) { inp.value = get(); inp.dispatchEvent(new Event("input")); }
    reset.hidden = orig() === undefined || get() === orig();
    paint();
  });
  enroll(lv, { el, focus: () => inp.focus({ preventScroll: true }), bad: () => missing() || wrong() || (inp.value !== "" && serverSays(path)), path });
  return el;
}

const PFX = { web: "https://", mail: "mailto:" };
/** Address that fits an icon: the mail icon takes an email address (mailto:), every other icon a web link (https://). */
export const urlForIcon = (url, iconName) => {
  const isMail = /^mailto:/i.test(url ?? "");
  if (iconName === "mail") return isMail ? url : PFX.mail;
  return isMail || !url ? PFX.web : url;
};
const splitUrl = (value, mail) => {
  const rest = String(value ?? "").replace(mail ? /^mailto:/i : /^https?:\/\//i, "");
  return mail ? rest : rest.replace(/^https?:\/\//i, "");
};

/** Link field with a permanent prefix: "https://" for web links; for the mail icon an email input (stored as mailto:, prefix hidden).
 *  kind() returns "web" or "mail" and is re-read on every refresh, so changing the icon converts the field in place. */
export function linkField({ label, mailLabel = label, path, get, orig, set, max = 300, kind = () => "web", lv, required = true }) {
  const uid = `l-${Math.random().toString(36).slice(2, 8)}`;
  const pre = h("span", { class: "pfx-t", "aria-hidden": "true" });
  const inp = h("input", { id: uid, class: "inp pfx-in", autocomplete: "off", spellcheck: "false", autocapitalize: "off" });
  const wrap = h("div", { class: "inp pfx", onmousedown: (e) => { if (e.target !== inp) { e.preventDefault(); inp.focus(); } } }, pre, inp);
  const count = h("span", { class: "cnt" });
  const mode = () => (kind() === "mail" ? "mail" : "web");
  let touched = false; // a wrong link or address only turns red after the field was left once (or after Done), then it follows every keystroke
  let paint = () => {};
  const full = (rest) => `${PFX[mode()]}${rest}`;
  const clean = (v) => splitUrl(v.replace(/\s+/g, ""), mode() === "mail");
  const lab = h("label", { for: uid, class: required ? "req" : null }, label);
  const draw = () => {
    const mail = mode() === "mail";
    if (lab.textContent !== (mail ? mailLabel : label)) lab.textContent = mail ? mailLabel : label;
    pre.textContent = mail ? "" : PFX.web;
    wrap.classList.toggle("nopfx", mail);
    if (inp.type !== (mail ? "email" : "text")) inp.type = mail ? "email" : "text";
    inp.setAttribute("inputmode", mail ? "email" : "url");
    inp.placeholder = mail ? "name@example.com" : "example.com";
    inp.maxLength = Math.max(1, max - PFX[mode()].length);
    count.textContent = `${[...get()].length}/${max}`;
  };
  inp.addEventListener("input", () => {
    const rest = clean(inp.value);
    if (rest !== inp.value) inp.value = rest; // typed or pasted prefixes and spaces never get in
    set(full(rest));
    paint();
  });
  inp.addEventListener("blur", () => { touched = true; paint(); });
  inp.addEventListener("keydown", (e) => { if (e.key === "Backspace" && !inp.value) e.preventDefault(); });
  const reset = iconButton("undo", "Reset", () => { set(orig()); inp.value = splitUrl(orig(), mode() === "mail"); });
  reset.classList.add("rst");
  const el = h("div", { class: "fe" }, h("div", { class: "fld" }, lab, wrap, count), reset);
  lv.add(() => {
    draw();
    const want = splitUrl(get(), mode() === "mail");
    if (document.activeElement !== inp && inp.value !== want) inp.value = want;
    reset.hidden = orig() === undefined || get() === orig();
    paint();
  });
  const missing = () => required && !inp.value;
  const wrong = () => Boolean(inp.value) && (mode() === "mail" ? !EMAIL.test(inp.value) : webProblem(full(inp.value)) !== "");
  paint = () => {
    const speak = touched || tried(lv);
    flag(wrap, (speak && (wrong() || (inp.value !== "" && serverSays(path)))) || (tried(lv) && missing()));
  };
  enroll(lv, { el, focus: () => inp.focus({ preventScroll: true }), bad: () => missing() || wrong() || (inp.value !== "" && serverSays(path)), path });
  return el;
}

/** Drop-down. options = [[value, label], ...] */
export function select({ label, value, options, onChange, lv, path, required = false, iconFor = null }) {
  // iconFor(value) -> sprite name. Shown left of each option and in the closed field (customizable select, Chrome / Edge 135+;
  // other browsers fall back to their plain list, text only). Names missing from the sprite are skipped.
  const glyph = (v) => { const name = iconFor?.(v); return name && document.getElementById(`i-${name}`) ? icon(name, "opt-ico") : null; };
  const sel = h("select", { class: `inp sel-inp${iconFor ? " has-ico" : ""}`, id: `s-${Math.random().toString(36).slice(2, 8)}` },
    iconFor ? h("button", { type: "button", tabindex: "-1" }, h("selectedcontent")) : null,
    ...options.map(([v, text]) => h("option", { value: v }, glyph(v), text)));
  sel.value = value();
  sel.addEventListener("change", () => onChange(sel.value));
  const missing = () => required && !sel.value;
  const paint = () => flag(sel, serverSays(path) || (tried(lv) && missing()));
  sel.addEventListener("change", paint);
  lv?.add(() => { if (sel.value !== value()) sel.value = value(); paint(); });
  const el = h("div", { class: "fe" }, h("div", { class: "fld" }, h("label", { for: sel.id, class: required ? "req" : null }, label), sel));
  enroll(lv, { el, focus: () => sel.focus({ preventScroll: true }), bad: () => missing() || serverSays(path), path });
  return el;
}

/** Label + switch row used inside dialogs. */
export const switchRow = (label, checked, onChange) =>
  h("div", { class: "swr" }, h("span", {}, label), toggle({ label, checked, onChange }));

/** Unsaved count + discard-all, shown in every editor's header. */
export function draftBar() {
  const n = h("b", {}, "0");
  const dot = h("i", { class: "dot-ind" });
  const tag = h("span", { class: "chip unsaved", hidden: true }, dot, n, "unsaved");
  const discard = iconButton("undo", "Discard all", async () => {
    if (!(await confirmDialog({ title: "Discard all changes?", text: "Your draft will be reset.", ok: "Discard", danger: true }))) return;
    await discardAll();
    toast("Discarded", "ok", 2000);
  }, { danger: true });
  discard.hidden = true;
  const sync = (s) => { if (isHeld()) return; n.textContent = String(s.changes.length); tag.hidden = discard.hidden = s.changes.length === 0; };
  sync(pending.get());
  const off = pending.subscribe(sync);
  return { el: h("div", { class: "bar-end" }, tag, discard), stop: off };
}

/** Picture chooser: thumbnail, a list of the repo's pictures, and an upload that converts the file first. */
export function imagePicker({ label, get, set, orig, accept = "image", path, lv, required = true, warn = null }) {
  const wantSvg = accept !== "image";   // "image" = pictures only, "any" = pictures and SVG icons
  const wantRaster = accept !== "svg";
  const fits = (p) => (p.endsWith(".svg") ? wantSvg : wantRaster);
  const thumb = h("img", { class: "pk-img", alt: "", width: 40, height: 40, draggable: "false", hidden: true });
  const blank = h("span", { class: "pk-img pk-ph", "aria-hidden": "true" }, icon("image"));
  const sel = h("select", { class: "inp sel-inp", id: `p-${Math.random().toString(36).slice(2, 8)}` });
  const file = h("input", { type: "file", class: "file", accept: wantSvg ? "image/*,.svg" : "image/*", tabindex: "-1", "aria-hidden": "true" });
  const up = h("button", { class: "btn ibtn", type: "button", "aria-label": "Upload", onclick: () => file.click() }, icon("upload"));
  const reset = iconButton("undo", "Reset", () => set(orig()));
  reset.classList.add("rst");

  file.addEventListener("change", async () => {
    const f = file.files[0];
    file.value = "";
    if (!f) return;
    up.disabled = true;
    try {
      const isSvg = /\.svg$/i.test(f.name) || f.type === "image/svg+xml";
      if (isSvg && !wantSvg) throw new MediaError("SVG not allowed here");
      const out = isSvg ? await processSvg(f) : await processImage(f);
      const dir = isSvg ? "/skill/" : "/image/";
      const base = safeName(f.name);
      let name = `${dir}${base}.${out.ext}`;
      for (let i = 2; fileList().some((x) => x.path === name); i++) name = `${dir}${base}-${i}.${out.ext}`;
      addFile(name, out);
      await set(name);
    } catch (e) { toast(e instanceof MediaError || e instanceof Error ? e.message : "Upload failed"); } finally { up.disabled = false; }
  });

  const missing = () => required && !get();
  const el = h("div", { class: "fe" }, h("div", { class: "fld" }, h("label", { for: sel.id, class: required ? "req" : null }, label), h("div", { class: "pk" }, thumb, blank, sel, up, reset)), file);
  lv.add(() => {
    const value = get();
    const opts = fileList().filter((f) => fits(f.path)).map((f) => f.path);
    if (value && !opts.includes(value)) opts.unshift(value);
    const key = opts.join("\n");
    if (sel.dataset.key !== key) { sel.replaceChildren(h("option", { value: "", disabled: true, hidden: true }, "Choose image"), ...opts.map((p) => h("option", { value: p }, p.split("/").slice(2).join("/") || p))); sel.dataset.key = key; }
    sel.value = value;
    thumb.hidden = !value; blank.hidden = Boolean(value);
    if (value) thumb.src = srcOf(value);
    reset.hidden = orig() === undefined || get() === orig();
    const red = (Boolean(value) && serverSays(path)) || (tried(lv) && missing()); // a picture that was simply not chosen yet stays calm until Done
    flag(sel, red);
    sel.classList.toggle("warn", Boolean(value && warn && !red && warn())); // yellow = only a suggestion, red wins
  });
  enroll(lv, { el, focus: () => sel.focus({ preventScroll: true }), bad: () => missing() || (Boolean(get()) && serverSays(path)), path });
  sel.addEventListener("change", () => set(sel.value));
  return el;
}
export { measure };

/** Modal editor for one item (clicking outside it does nothing) of a list (projects, buttons, stack).
 *  Edits go into the draft as you type (so the page behind updates), but nothing is final until Done:
 *  Cancel, Esc and the close button put the item back as it was (a new item is removed again).
 *  Done is always pressable but never confirms while a required field is empty or a link / e-mail is wrong: it jumps straight to the first such field and shows it in red. */
export function editorDialog({ title, build, collection, id, isNew = false, prefix, onReset, onClose }) {
  const lv = live();
  const form = lv.form = { fields: [], tried: false };
  const snap = isNew ? null : structuredClone(store.get().content[collection].find((x) => x.id === id));
  if (isNew) pendingIds.add(id);
  const release = hold(); // header counters stay put until this dialog is closed
  let finished = false;
  const rollback = () => edit((c) => {
    const list = c[collection];
    const at = list.findIndex((x) => x.id === id);
    if (at < 0) return;
    if (isNew) list.splice(at, 1); else list[at] = structuredClone(snap);
  });
  const finish = (keep) => {
    if (finished) return;
    finished = true;
    lv.stop();
    pendingIds.delete(id);
    if (!keep) rollback(); else if (isNew) edit(() => {}); // a confirmed new item shows up in the list and the counters
    dlg.close();
    dlg.remove();
    release();
    pending.set({}); // counters, nav dot and error chips catch up now
    store.set({});
    onClose?.();
  };
  const dlg = h("dialog", { class: "dlg ed", "aria-labelledby": "edT", tabindex: "-1" });
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(false); });
  // Done is always pressable. It never confirms while anything required is empty or wrong: it jumps to the first such field instead.
  let checking = false;
  const live_ = () => { form.fields = form.fields.filter((f) => f.el.isConnected); return form.fields; };
  const firstBad = () => live_().filter((f) => f.bad()).sort((x, y) => (x.el.compareDocumentPosition(y.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))[0];
  const jump = (f) => { f.focus(); f.el.scrollIntoView({ block: "center", behavior: "instant" }); };
  const attempt = async () => {
    if (checking || finished) return;
    checking = true;
    try {
      form.tried = true;
      lv.flush(); // red rings show up right now
      let bad = firstBad();
      if (bad) return jump(bad);
      if (!settled()) await check(); // the build's own validator has the last word
      if (finished) return;
      lv.flush();
      bad = firstBad();
      if (bad) return jump(bad);
      const p = prefix(), left = store.get().errors.filter((e) => e.startsWith(`${p}.`) || e.startsWith(`${p}:`));
      if (left.length) return toast(left[0].slice(left[0].indexOf(": ") + 2) || "Something is not valid");
      finish(true);
    } finally { checking = false; }
  };
  const done = h("button", { class: "btn", type: "button", onclick: attempt }, "Done");
  lv.add(() => { done.disabled = !store.get().content[collection].some((x) => x.id === id); });
  const body = h("div", { class: "ed-form" }, ...build(lv));
  dlg.append(
    h("header", { class: "ed-head" }, h("h2", { id: "edT" }, title), iconButton("close", "Cancel", () => finish(false))),
    body,
    h("div", { class: "dlg-row" },
      !isNew && onReset ? h("button", { class: "btn", type: "button", onclick: () => { onReset(); finish(true); } }, "Reset") : null,
      h("button", { class: "btn", type: "button", onclick: () => finish(false) }, "Cancel"),
      done));
  document.body.append(dlg);
  dlg.showModal();
  dlg.focus({ preventScroll: true });
  dlg.scrollTop = 0;
  requestAnimationFrame(() => { dlg.scrollTop = 0; });
  lv.start();
  return () => finish(false);
}

/** One list row. `id` + `grip` (from sortable().handle) make the row draggable by its handle. */
export function row({ id, grip = null, lead, title, sub, bad = false, tail = [] }) {
  return h("div", { class: `ir${bad ? " bad" : ""}`, ...(id ? { "data-id": id } : {}) },
    grip,
    lead ? h("span", { class: "ir-lead" }, lead) : null,
    h("div", { class: "ir-txt" }, h("b", {}, title), sub ? h("small", {}, sub) : null),
    bad ? h("i", { class: "badge", role: "img", "aria-label": "Has errors" }) : null,
    h("div", { class: "ir-act" }, ...tail));
}

/** Drag-to-reorder for a list of rows built with row({ id, grip }). The first row is the one the site selects when it opens.
 *  collection: "projects" | "stack" | "buttons". refresh: redraws the list (called when a drag ends without a move).
 *  Pointer: press the handle and drag (touch too); the other rows slide out of the way and the list is only changed on release.
 *  Keyboard: with the handle focused, Arrow Up / Arrow Down move the row one place; Escape cancels a drag.
 *  While a drag is on, `dragging` is true and the list must not be redrawn. */
export function sortable(list, collection, refresh) {
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  let refocus = null, dragging = false;
  const rowsOf = () => [...list.children].filter((r) => r.dataset?.id);

  const drag = (e, id) => {
    if (e.button !== 0 || !e.isPrimary || dragging) return;
    const rows = rowsOf(), from = rows.findIndex((r) => r.dataset.id === id);
    if (from < 0 || rows.length < 2) return;
    e.preventDefault();
    const btn = e.currentTarget, me = rows[from];
    const rects = rows.map((r) => { const b = r.getBoundingClientRect(); return { top: b.top + scrollY, h: b.height }; });
    const startY = e.clientY + scrollY, last = rects.at(-1);
    let y = e.clientY, to = from, raf = 0;
    dragging = true;
    btn.setPointerCapture(e.pointerId);
    list.classList.add("sorting"); me.classList.add("lift");

    const place = () => {
      const dy = clamp(y + scrollY - startY, rects[0].top - rects[from].top, last.top + last.h - rects[from].top - rects[from].h);
      me.style.transform = `translate3d(0,${dy}px,0)`;
      const mid = rects[from].top + dy + rects[from].h / 2;
      to = rects.reduce((n, r, k) => n + (k !== from && r.top + r.h / 2 < mid ? 1 : 0), 0);
      rows.forEach((r, k) => {
        if (k === from) return;
        const shift = from < to && k > from && k <= to ? -rects[from].h : from > to && k >= to && k < from ? rects[from].h : 0;
        r.style.transform = shift ? `translate3d(0,${shift}px,0)` : "";
      });
    };
    const edge = 56; // near the top or bottom of the screen the page scrolls by itself
    const tick = () => {
      raf = 0;
      const v = y < edge ? -Math.ceil((edge - y) / 4) : y > innerHeight - edge ? Math.ceil((y - (innerHeight - edge)) / 4) : 0;
      if (!v) return;
      scrollBy(0, v); place();
      raf = requestAnimationFrame(tick);
    };
    const onMove = (ev) => { y = ev.clientY; place(); if (!raf) raf = requestAnimationFrame(tick); };
    const finish = (apply) => {
      btn.removeEventListener("pointermove", onMove); btn.removeEventListener("pointerup", onUp);
      btn.removeEventListener("pointercancel", onCancel); btn.removeEventListener("lostpointercapture", onCancel);
      removeEventListener("keydown", onKey, true);
      cancelAnimationFrame(raf);
      try { btn.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      rows.forEach((r) => { r.style.transform = ""; });
      me.classList.remove("lift"); list.classList.remove("sorting");
      dragging = false;
      if (apply && to !== from) { refocus = id; reorder(collection, id, rows[to].dataset.id); } else refresh();
    };
    const onUp = () => finish(true), onCancel = () => finish(false);
    const onKey = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); finish(false); } };
    btn.addEventListener("pointermove", onMove); btn.addEventListener("pointerup", onUp);
    btn.addEventListener("pointercancel", onCancel); btn.addEventListener("lostpointercapture", onCancel);
    addEventListener("keydown", onKey, true);
  };

  return {
    get dragging() { return dragging; },
    /** The drag handle for the row of item `id`. */
    handle(id, label) {
      const btn = h("button", { class: "grip", type: "button", title: "Drag to reorder", "aria-label": `Move ${label || "item"} (Arrow Up / Down)` }, icon("grip"));
      btn.addEventListener("pointerdown", (e) => drag(e, id));
      btn.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        const rows = rowsOf(), i = rows.findIndex((r) => r.dataset.id === id), j = i + (e.key === "ArrowUp" ? -1 : 1);
        if (i < 0 || j < 0 || j >= rows.length) return;
        refocus = id; reorder(collection, id, rows[j].dataset.id);
      });
      return btn;
    },
    /** Call after the list is redrawn: a row moved with the keyboard keeps the focus. */
    restore() {
      if (refocus === null) return;
      const id = refocus; refocus = null;
      [...list.querySelectorAll(".ir")].find((r) => r.dataset.id === id)?.querySelector(".grip")?.focus();
    },
  };
}

export const note = (text) => h("p", { class: "note" }, text);
export const statusChips = () => {
  const el = h("span", { class: "chip", hidden: true });
  const sync = () => { if (isHeld()) return; const s = store.get(); el.hidden = s.checking || s.errors.length === 0; el.replaceChildren(icon("alert"), h("b", {}, String(s.errors.length)), "errors"); };
  sync();
  return { el, sync };
};
export { chip };
