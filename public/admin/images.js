// Images: list, add, replace, remove. No move, crop or resize controls. New files are converted to WebP in the browser (see media.js).
import { h, icon, panel, iconButton, textButton, confirmDialog, toast } from "./ui.js";
import { store, fileList, srcOf, usedBy, addFile, replaceFile, removeFile, resetFile } from "./draft.js";
import { safeName } from "./logic.js";
import { processImage, MediaError } from "./media.js";
import { live, draftBar, statusChips } from "./kit.js";

const kb = (n) => `${Math.max(1, Math.round(n / 1024))} KB`;
const stem = (p) => p.replace(/\.[^.]+$/, "");

// the favicon and share image must stay PNG (the page declares type="image/png"; crawlers want PNG/JPEG); everything else becomes WebP
const formatFor = (path) => (usedBy(path).some((r) => r.path.startsWith("images.")) ? "png" : "webp");

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept, class: "file", tabindex: "-1", "aria-hidden": "true" });
    input.addEventListener("change", () => { resolve(input.files[0] ?? null); input.remove(); });
    input.addEventListener("cancel", () => { resolve(null); input.remove(); });
    document.body.append(input);
    input.click();
  });
}
const fail = (e) => toast(e instanceof MediaError || e instanceof Error ? e.message : "Failed");

async function addImage() {
  const f = await pickFile("image/*");
  if (!f) return;
  try {
    const out = await processImage(f);
    const base = safeName(f.name);
    let path = `/image/${base}.${out.ext}`;
    for (let i = 2; fileList().some((x) => x.path === path); i++) path = `/image/${base}-${i}.${out.ext}`;
    addFile(path, out);
    toast("Added", "ok", 1800);
  } catch (e) { fail(e); }
}

async function replaceImage(path) {
  const f = await pickFile("image/*");
  if (!f) return;
  try {
    const format = formatFor(path);
    const out = await processImage(f, { format });
    replaceFile(path, `${stem(path)}.${out.ext}`, out);
    toast("Replaced", "ok", 1800);
  } catch (e) { fail(e); }
}

/** Removing a picture that the site uses needs an answer: point its uses at another picture, or unlink them. */
function removeImage(path) {
  const refs = usedBy(path);
  if (!refs.length) {
    return confirmDialog({ title: "Remove image?", ok: "Remove", danger: true }).then((yes) => { if (yes) removeFile(path, null); });
  }
  return new Promise((resolve) => {
    const others = fileList().filter((f) => f.path !== path && !f.path.endsWith(".svg") === !path.endsWith(".svg"));
    const canUnlink = refs.every((r) => !r.required);
    const sel = h("select", { class: "inp sel-inp", id: "rmSel" },
      ...(canUnlink ? [h("option", { value: "" }, "Unlink")] : []),
      ...others.map((f) => h("option", { value: f.path }, f.path.split("/").slice(2).join("/") || f.path)));
    const dlg = h("dialog", { class: "dlg", "aria-labelledby": "rmT" });
    const done = (go) => { dlg.close(); dlg.remove(); if (go) { try { removeFile(path, sel.value || null); } catch (e) { fail(e); } } resolve(); };
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); done(false); });
    dlg.append(
      h("h2", { id: "rmT" }, "In use"),
      h("ul", { class: "uses" }, ...refs.map((r) => h("li", {}, r.label))),
      others.length || canUnlink ? h("div", { class: "fld" }, h("label", { for: "rmSel" }, canUnlink ? "Replace with" : "Replace with (required)"), sel) : h("p", {}, "No other image to use"),
      h("div", { class: "dlg-row" },
        h("button", { class: "btn", type: "button", autofocus: true, onclick: () => done(false) }, "Cancel"),
        h("button", { class: "btn danger", type: "button", disabled: !others.length && !canUnlink, onclick: () => done(true) }, "Remove")));
    document.body.append(dlg);
    dlg.showModal();
  });
}

export function imagesView() {
  const lv = live();
  const bar = draftBar();
  const status = statusChips();
  const grid = h("div", { class: "igrid" });
  const add = textButton("Add image", addImage, { lead: "plus" });

  const tilesBy = new Map(); // path -> { sig, node }: a tile is built once and kept while what it shows is the same, so its picture is never reloaded
  let shown = "";
  const draw = () => {
    const s = store.get();
    const files = fileList().filter((f) => !f.path.endsWith(".svg") || f.path.startsWith("/image/"));
    const gone = s.removed.filter((p) => !(p in s.added));
    const sigs = files.map((f) => `${f.path}|${f.state ?? ""}|${f.size}|${usedBy(f.path).length}|${f.data ? f.data.length : 0}`);
    const key = `${sigs.join("\n")}\n--\n${gone.join("\n")}`;
    if (key === shown) return; // nothing visible changed (e.g. a validation answer)
    shown = key;
    const tiles = files.map((f, i) => {
      const hit = tilesBy.get(f.path);
      if (hit?.sig === sigs[i]) return hit.node;
      const used = usedBy(f.path).length;
      const name = f.path.split("/").slice(2).join("/") || f.path;
      const node = h("article", { class: `itile${f.state ? ` ${f.state}` : ""}` },
        h("div", { class: "ithumb" }, h("img", { src: srcOf(f.path), alt: "", loading: "lazy", decoding: "async", draggable: "false" }), f.state ? h("i", { class: "tag" }, f.state) : null),
        h("div", { class: "imeta" }, h("b", {}, name), h("small", {}, `${kb(f.size)}${used ? ` · ${used} use${used > 1 ? "s" : ""}` : ""}`)),
        h("div", { class: "ir-act" },
          f.state ? iconButton("undo", "Undo", () => resetFile(f.path)) : null,
          iconButton("replace", "Replace", () => replaceImage(f.path)),
          iconButton("trash", "Remove", () => removeImage(f.path), { danger: true })));
      tilesBy.set(f.path, { sig: sigs[i], node });
      return node;
    });
    for (const p of [...tilesBy.keys()]) if (!files.some((f) => f.path === p)) tilesBy.delete(p);
    grid.replaceChildren(...(tiles.length ? tiles : [h("div", { class: "empty" }, icon("image", "empty-ico"), h("p", {}, "No images"))]),
      ...gone.map((p) => h("article", { class: "itile removed" },
        h("div", { class: "ithumb" }, h("i", { class: "tag" }, "removed")),
        h("div", { class: "imeta" }, h("b", {}, p.split("/").slice(2).join("/") || p)),
        h("div", { class: "ir-act" }, iconButton("undo", "Undo", () => resetFile(p))))));
  };
  lv.add(() => { draw(); status.sync(); });

  return {
    bar: h("div", { class: "bar-end" }, status.el, bar.el),
    el: panel({ actions: [add], body: [grid] }),
    start: () => lv.start(),
    stop: () => { lv.stop(); bar.stop(); },
  };
}
