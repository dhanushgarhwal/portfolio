// Colour picker in the site's own look: a small swatch button that opens an inline panel (saturation/brightness square + hue bar).
// While you drag, only the two thumbs, the swatch and one CSS variable change (once per frame); the draft, the validator and the
// lists behind are touched once, when you let go. Keyboard steps are batched the same way.
import { h, icon } from "./ui.js";

const HEX = /^#[0-9a-f]{6}$/i;
const clamp = (n, a = 0, b = 1) => Math.min(b, Math.max(a, n));

function hsvToHex(hue, s, v) {
  const f = (n) => { const k = (n + hue / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return `#${[f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}`;
}
function hexToHsv(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let hue = 0;
  if (d) hue = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: hue * 60, s: max ? d / max : 0, v: max };
}

const FRAME = (fn) => requestAnimationFrame(fn);

/** Drag helper: move(x, y) gets 0..1 positions inside el, at most once per frame; end() runs once when the pointer is released. */
function drag(el, move, end) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.focus({ preventScroll: true });
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect(); // measured once per drag
    let last = e, frame = 0;
    const apply = () => { frame = 0; move(clamp((last.clientX - r.left) / r.width), clamp((last.clientY - r.top) / r.height)); };
    const at = (ev) => { last = ev; if (!frame) frame = FRAME(apply); };
    const stop = () => {
      el.removeEventListener("pointermove", at);
      el.removeEventListener("pointerup", stop);
      el.removeEventListener("pointercancel", stop);
      if (frame) { cancelAnimationFrame(frame); apply(); }
      end();
    };
    el.addEventListener("pointermove", at);
    el.addEventListener("pointerup", stop);
    el.addEventListener("pointercancel", stop);
    apply();
  });
}

/** colorPicker({ get, set, lv, onPreview }) -> { swatch, dropper, panel }. Put dropper (null where the browser has no EyeDropper) and swatch beside the colour field, panel under it.
 *  onPreview(hex) is called while dragging so the text field can follow without touching the draft. */
export function colorPicker({ get, set, lv, onPreview }) {
  let hsv = { h: 0, s: 0, v: 1 };
  let shown = "";
  let dragging = false;
  let timer = 0;

  const svThumb = h("i", { class: "cp-th" });
  const sv = h("div", { class: "cp-sv", role: "slider", tabindex: "0", "aria-label": "Saturation and brightness" }, svThumb);
  const hueThumb = h("i", { class: "cp-th" });
  const hue = h("div", { class: "cp-hue", role: "slider", tabindex: "0", "aria-label": "Hue", "aria-valuemin": "0", "aria-valuemax": "360" }, hueThumb);
  const panel = h("div", { class: "cp", hidden: true }, sv, hue);
  const swatch = h("button", { class: "cp-sw", type: "button", "aria-label": "Colour picker", "aria-expanded": "false" });
  swatch.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    swatch.setAttribute("aria-expanded", String(!panel.hidden));
  });

  const hex = () => hsvToHex(hsv.h, hsv.s, hsv.v);
  // eyedropper: pick any pixel on the screen (Chrome, Edge and other Chromium browsers; hidden elsewhere)
  let dropper = null;
  if (typeof globalThis.EyeDropper === "function") {
    dropper = h("button", { class: "btn ibtn cp-eye", type: "button", "aria-label": "Pick a colour from the screen" }, icon("pipette"));
    dropper.addEventListener("click", async () => {
      dropper.disabled = true;
      try {
        const { sRGBHex } = await new globalThis.EyeDropper().open();
        if (HEX.test(sRGBHex)) {
          const next = hexToHsv(sRGBHex);
          hsv = { h: next.s && next.v ? next.h : hsv.h, s: next.s, v: next.v };
          live();
          save();
        }
      } catch { /* cancelled with Esc, or not allowed */ } finally { dropper.disabled = false; }
    });
  }
  let lastHue = -1;
  function paint() {
    const r = Math.round(hsv.h);
    if (r !== lastHue) { lastHue = r; sv.style.setProperty("--h", String(r)); hue.setAttribute("aria-valuenow", String(r)); }
    svThumb.style.left = `${hsv.s * 100}%`;
    svThumb.style.top = `${(1 - hsv.v) * 100}%`;
    hueThumb.style.left = `${(hsv.h / 360) * 100}%`;
    swatch.style.backgroundColor = shown = hex();
  }
  const save = () => { clearTimeout(timer); timer = 0; if (get().toLowerCase() !== shown) set(shown); };
  const live = () => { paint(); onPreview?.(shown); };

  drag(sv, (x, y) => { dragging = true; hsv.s = x; hsv.v = 1 - y; live(); }, () => { dragging = false; save(); });
  drag(hue, (x) => { dragging = true; hsv.h = x * 360; live(); }, () => { dragging = false; save(); });
  const keys = (e, fn) => {
    const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!k) return;
    e.preventDefault();
    fn(k[0] * (e.shiftKey ? 10 : 1), k[1] * (e.shiftKey ? 10 : 1));
    live();
    clearTimeout(timer);
    timer = setTimeout(save, 200); // a run of arrow presses is one edit
  };
  sv.addEventListener("keydown", (e) => keys(e, (dx, dy) => { hsv.s = clamp(hsv.s + dx / 100); hsv.v = clamp(hsv.v - dy / 100); }));
  hue.addEventListener("keydown", (e) => keys(e, (dx, dy) => { hsv.h = (((hsv.h + (dx - dy) * 3.6) % 360) + 360) % 360; }));

  // follow the draft (typed hex, reset, undo) without disturbing a drag in progress
  lv.add(() => {
    if (dragging || timer) return;
    const v = get();
    if (HEX.test(v) && v.toLowerCase() !== shown) {
      const next = hexToHsv(v);
      hsv = { h: next.s && next.v ? next.h : hsv.h, s: next.s, v: next.v }; // grey keeps the hue you were on
      paint();
    } else if (!shown) paint();
  });

  return { swatch, dropper, panel };
}
