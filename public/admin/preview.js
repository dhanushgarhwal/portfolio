// Preview mode. One fixed button in the top right corner: "Preview" opens the site rendered from the current draft (nothing is saved or pushed),
// and the very same button, in the very same place, becomes "Exit". The page is rendered by the server with the build's own renderer and shown in an iframe
// of this origin; pictures added in the draft (not in the repo yet) are swapped in from the draft after the page loads.
import { csrfToken, h, icon, loadMe, toast } from "./ui.js";
import * as engine from "./draft.js";

const ENDPOINT = "/api/admin/preview";
const FRAME = "previewFrame";

let button = null, label = null, glyph = null;
let layer = null; // the overlay while preview is open
let unsubscribe = null;

const isOpen = () => layer !== null;

function paint() {
  const open = isOpen();
  label.textContent = open ? "Exit" : "Preview";
  glyph.replaceWith((glyph = icon(open ? "close" : "eye", "lead")));
  button.setAttribute("aria-label", open ? "Exit preview" : "Preview site");
  button.setAttribute("aria-pressed", String(open));
  button.classList.toggle("on", open);
}

/** Swaps pictures that only exist in the draft for their data, so the preview shows them. */
function fillDraftImages(doc) {
  const { added } = engine.store.get();
  const paths = Object.keys(added);
  if (!paths.length) return;
  for (const img of doc.querySelectorAll("img[src]")) {
    const data = added[img.getAttribute("src")]?.data;
    if (data) img.src = data;
  }
  for (const link of doc.querySelectorAll('link[rel="preload"][as="image"]')) link.remove(); // the preload would fetch the old file
}

async function open() {
  const s = engine.store.get();
  if (isOpen() || s.status !== "ready" || !s.content) return;
  try { await loadMe(); } catch { return toast("Signed out"); } // fresh CSRF token, and proof the session is alive
  if (isOpen()) return;

  const frame = h("iframe", { class: "pv-frame", name: FRAME, "aria-label": "Site preview", referrerpolicy: "no-referrer" });
  layer = h("div", { class: "pv", role: "region", "aria-label": "Preview mode" }, frame);
  frame.addEventListener("load", () => {
    try { fillDraftImages(frame.contentDocument); } catch { /* a blocked frame has nothing to fill */ }
    layer?.classList.add("ready");
    frame.focus();
  });

  const form = h("form", { method: "post", action: ENDPOINT, target: FRAME, hidden: true },
    h("input", { type: "hidden", name: "csrf", value: csrfToken() }),
    h("input", { type: "hidden", name: "content", value: JSON.stringify(s.content) }));
  document.body.append(layer, form);
  form.submit();
  form.remove();

  document.documentElement.classList.add("pv-on");
  paint();
}

function close() {
  if (!isOpen()) return;
  layer.remove();
  layer = null;
  document.documentElement.classList.remove("pv-on");
  paint();
  button.focus({ preventScroll: true });
}

/** Creates the corner button once; call again later to re-sync it (e.g. when the draft finishes loading). */
export function mountPreview() {
  if (button) return;
  glyph = icon("eye", "lead");
  label = h("span", {}, "Preview");
  button = h("button", { class: "btn pv-btn", type: "button", "aria-label": "Preview site", "aria-pressed": "false", disabled: true, onclick: () => (isOpen() ? close() : open()) }, glyph, label);
  document.body.append(button);

  const sync = (s) => { button.disabled = !isOpen() && (s.status !== "ready" || !s.content); };
  unsubscribe = engine.store.subscribe(sync);
  sync(engine.store.get());
  addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen() && !document.querySelector("dialog[open]")) { e.preventDefault(); close(); } });
}

/** Removes the button and closes any preview (signed out). */
export function unmountPreview() {
  close();
  unsubscribe?.();
  unsubscribe = null;
  button?.remove();
  button = label = glyph = null;
}
