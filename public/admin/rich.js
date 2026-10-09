// Rich About editor. The stored value stays the site's own format: [[highlight]] and [[text|link]].
// Select text to get a small menu (highlight, link, clear). Nothing is remembered: typing next to a styled word is always plain.
import { h, icon, iconButton } from "./ui.js";
import { errorsFor, settled } from "./draft.js";

const URL_OK = /^(https:\/\/[^\s/][^\s]*|mailto:[^\s]+|tel:[^\s]+)$/i;
const CLEAN = /[\u200b\r\n\t]+/g;
const isHi = (n) => n?.nodeType === 1 && n.classList.contains("hi");
const hiOf = (n, root) => { for (let el = n; el && el !== root; el = el.parentNode) if (isHi(el)) return el; return null; };

/** source -> DOM nodes (tolerant: broken markup stays as plain text and the validator reports it). */
function build(source) {
  const out = [];
  let rest = source;
  while (rest) {
    const open = rest.indexOf("[[");
    const close = open < 0 ? -1 : rest.indexOf("]]", open + 2);
    if (open < 0 || close < 0) { out.push(document.createTextNode(rest)); break; }
    if (open) out.push(document.createTextNode(rest.slice(0, open)));
    const inner = rest.slice(open + 2, close);
    const bar = inner.indexOf("|");
    const text = bar < 0 ? inner : inner.slice(0, bar);
    const url = bar < 0 ? "" : inner.slice(bar + 1);
    const el = h(url ? "a" : "span", { class: "hi" });
    el.textContent = text;
    if (url) el.dataset.url = url;
    out.push(el);
    rest = rest.slice(close + 2);
  }
  return out;
}

/** DOM -> source. */
export function serialize(root) {
  let s = "";
  for (const n of root.childNodes) {
    if (n.nodeType === 3) s += n.data.replace(CLEAN, " ");
    else if (isHi(n)) {
      const t = n.textContent.replace(CLEAN, " ").replace(/[|\[\]]/g, "");
      if (!t.trim()) continue;
      s += n.dataset.url ? `[[${t}|${n.dataset.url}]]` : `[[${t}]]`;
    } else s += n.textContent.replace(CLEAN, " ");
  }
  return s;
}

export function richField({ label, path, max, lv, get, orig, set }) {
  const uid = `r-${Math.random().toString(36).slice(2, 8)}`;
  const ed = h("div", { class: "inp rich", id: uid, contenteditable: "plaintext-only", role: "textbox", "aria-multiline": "true", "aria-labelledby": `${uid}-l`, spellcheck: "false", autocapitalize: "off" });
  if (ed.contentEditable !== "plaintext-only") ed.setAttribute("contenteditable", "true"); // older browsers: plain "true", paste and drop are filtered below
  const count = h("span", { class: "cnt" });
  const reset = iconButton("undo", "Reset", () => { set(orig()); paint(orig()); });
  reset.classList.add("rst");
  const el = h("div", { class: "fe" }, h("div", { class: "fld" }, h("label", { id: `${uid}-l`, for: uid }, label), ed, count), reset);
  const menu = toolbar();

  const sync = () => { count.textContent = `${[...serialize(ed)].length}/${max}`; };
  function paint(source) { ed.replaceChildren(...build(source)); sync(); }
  const commit = () => {
    for (const n of [...ed.querySelectorAll(".hi")]) if (!n.textContent) n.remove();
    const v = serialize(ed);
    sync();
    if (v !== get()) set(v);
  };

  /* --- editing rules --- */
  const room = () => max - [...serialize(ed)].length;
  const insertPlain = (text) => {
    const t = text.replace(CLEAN, " ").slice(0, Math.max(0, room() + (getSelection().toString().length)));
    if (!t) return;
    if (!document.execCommand("insertText", false, t)) {
      const r = getSelection().getRangeAt(0); r.deleteContents();
      const n = document.createTextNode(t); r.insertNode(n); r.setStartAfter(n); r.collapse(true);
      getSelection().removeAllRanges(); getSelection().addRange(r);
    }
  };
  ed.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); if ((e.ctrlKey || e.metaKey) && ["b", "i", "u"].includes(e.key.toLowerCase())) e.preventDefault(); });
  ed.addEventListener("paste", (e) => { e.preventDefault(); insertPlain(e.clipboardData?.getData("text/plain") ?? ""); });
  ed.addEventListener("drop", (e) => e.preventDefault());
  ed.addEventListener("beforeinput", (e) => {
    if (e.inputType.startsWith("format") || e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") return e.preventDefault();
    if (e.inputType !== "insertText" || !e.data) return;
    const sel = getSelection();
    if (sel.isCollapsed && room() <= 0) return e.preventDefault();
    if (!sel.isCollapsed || !sel.rangeCount) return;
    // typing at the edge of a styled word never continues the style
    const r = sel.getRangeAt(0), hi = hiOf(r.startContainer, ed);
    if (!hi) return;
    const atEnd = r.startContainer.nodeType === 3 ? r.startOffset === r.startContainer.length && r.startContainer === hi.lastChild : r.startOffset >= hi.childNodes.length;
    const atStart = r.startOffset === 0 && (r.startContainer === hi || r.startContainer === hi.firstChild);
    if (!atEnd && !atStart) return;
    e.preventDefault();
    const t = document.createTextNode(e.data);
    hi.parentNode.insertBefore(t, atEnd ? hi.nextSibling : hi);
    const nr = document.createRange(); nr.setStart(t, t.length); nr.collapse(true);
    sel.removeAllRanges(); sel.addRange(nr);
    commit();
  });
  ed.addEventListener("input", commit);

  /* --- selection menu --- */
  const range = () => { const s = getSelection(); return s.rangeCount && !s.isCollapsed && ed.contains(s.anchorNode) && ed.contains(s.focusNode) ? s.getRangeAt(0) : null; };
  let saved = null, frame = 0;
  const refresh = () => {
    frame = 0;
    const r = range();
    if (!r) { if (!menu.busy()) menu.hide(); return; }
    saved = r.cloneRange();
    menu.show(r.getBoundingClientRect(), touching(r));
  };
  const queue = () => { if (!frame) frame = requestAnimationFrame(refresh); };
  const touching = (r) => [...ed.querySelectorAll(".hi")].filter((n) => r.intersectsNode(n));
  document.addEventListener("selectionchange", () => { if (document.activeElement === ed || menu.busy()) queue(); });
  ed.addEventListener("blur", () => setTimeout(() => { if (!menu.busy() && document.activeElement !== ed) menu.hide(); }, 0));
  addEventListener("resize", () => menu.hide());
  addEventListener("scroll", queue, { capture: true, passive: true });

  function restore() {
    ed.focus({ preventScroll: true });
    const s = getSelection(); s.removeAllRanges();
    if (saved) s.addRange(saved);
    return saved;
  }
  /** Replaces the selection with ONE element (or plain text when url === null and plain). Existing styled words it touches are absorbed whole. */
  function apply(kind, url = "") {
    const r = restore();
    if (!r) return;
    const first = hiOf(r.startContainer, ed), last = hiOf(r.endContainer, ed);
    if (first) r.setStartBefore(first);
    if (last) r.setEndAfter(last);
    const text = r.toString().replace(CLEAN, " ").replace(/[|\[\]]/g, "");
    r.deleteContents();
    let node;
    if (kind === "clear" || !text.trim()) node = document.createTextNode(text);
    else {
      node = h(kind === "link" ? "a" : "span", { class: "hi" });
      node.textContent = text;
      if (kind === "link") node.dataset.url = url;
    }
    r.insertNode(node);
    ed.normalize();
    const after = document.createRange(); after.setStartAfter(node); after.collapse(true); // caret goes after it: no style is carried forward
    const s = getSelection(); s.removeAllRanges(); s.addRange(after);
    saved = null;
    menu.hide();
    commit();
  }
  menu.bind({
    onHighlight: (active) => apply(active ? "clear" : "hi"),
    onLink: (u) => apply("link", u),
    onClear: () => apply("clear"),
    validUrl: (u) => URL_OK.test(u) && u.length <= 300,
  });

  lv.add(() => {
    if (document.activeElement !== ed && serialize(ed) !== get()) paint(get());
    else if (!ed.firstChild && get()) paint(get());
    reset.hidden = orig() === undefined || get() === orig();
    const bad = settled() && serialize(ed) !== "" && errorsFor(typeof path === "function" ? path() : path).length > 0;
    ed.classList.toggle("bad", bad);
    if (bad) ed.setAttribute("aria-invalid", "true"); else ed.removeAttribute("aria-invalid");
  });
  paint(get());
  return el;
}

/* ---------- the floating menu (one per editor, lives in <body>) ---------- */
function toolbar() {
  let handlers = null;
  const mk = (name, label, fn) => { const b = iconButton(name, label, fn); b.classList.add("fmt-b"); return b; };
  const bHi = mk("marker", "Highlight", () => handlers.onHighlight(bHi.getAttribute("aria-pressed") === "true"));
  const bLink = mk("link", "Link", () => open());
  const bClear = mk("close", "Clear formatting", () => handlers.onClear());
  const url = h("input", { class: "inp fmt-in", type: "text", placeholder: "https://", autocomplete: "off", spellcheck: "false", maxlength: "300", "aria-label": "Link address" });
  const ok = mk("check", "Apply link", () => submit());
  const row = h("div", { class: "fmt-row" }, bHi, bLink, bClear);
  const form = h("div", { class: "fmt-row", hidden: true }, url, ok);
  const el = h("div", { class: "fmt", role: "toolbar", "aria-label": "Text style", hidden: true }, row, form);
  for (const b of [bHi, bLink, bClear, ok]) b.addEventListener("mousedown", (e) => e.preventDefault()); // keeps the text selected
  el.addEventListener("mousedown", (e) => { if (e.target !== url) e.preventDefault(); });
  document.body.append(el);

  function open() { row.hidden = true; form.hidden = false; url.focus(); url.select(); }
  function submit() {
    const v = url.value.trim();
    if (!handlers.validUrl(v)) { url.classList.add("bad"); return; }
    handlers.onLink(v);
  }
  url.addEventListener("input", () => url.classList.remove("bad"));
  url.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hide(); } });

  function hide() { el.hidden = true; row.hidden = false; form.hidden = true; url.value = ""; url.classList.remove("bad"); }
  return {
    bind: (h2) => { handlers = h2; },
    busy: () => !el.hidden && el.contains(document.activeElement),
    hide,
    show(rect, hits) {
      if (!form.hidden) return; // the link box stays put while it is being typed in
      const plain = hits.length > 0 && hits.every((n) => !n.dataset.url);
      bHi.setAttribute("aria-pressed", String(plain));
      bHi.classList.toggle("on", plain);
      url.value = hits.length === 1 && hits[0].dataset.url ? hits[0].dataset.url : url.value;
      el.hidden = false;
      const w = el.offsetWidth, ht = el.offsetHeight;
      const x = Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), innerWidth - w - 8);
      const y = rect.top - ht - 8 < 8 ? rect.bottom + 8 : rect.top - ht - 8;
      el.style.left = `${Math.round(x)}px`;
      el.style.top = `${Math.round(y)}px`;
    },
  };
}
