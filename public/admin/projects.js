// Projects: what a project card shows (name, description, image, icon, link, optional button, visibility). Add, edit, remove.
// Status / date / tech lists are not part of the card, so content.json has no such fields. Drag the handle to reorder; the first project is the one in focus when the site opens.
import { h, icon, panel, iconButton, textButton, toggle, confirmDialog, toast } from "./ui.js";
import { store, edit, resetItem, srcOf } from "./draft.js";
import { uniqueId } from "./logic.js";
import { pendingIds, field, linkField, urlForIcon, select, switchRow, imagePicker, measure, live, draftBar, editorDialog, row, statusChips, sortable } from "./kit.js";

const MAX = 30;
const REC = { w: 1200, h: 630 }; // recommended project picture; only a suggestion, never required
/** True when the picture is clearly off the suggestion: another shape (more than 2% apart) or narrower than recommended. */
const offSize = (p) => Boolean(p?.image && p.imageWidth > 0 && p.imageHeight > 0
  && (Math.abs(p.imageWidth / p.imageHeight - REC.w / REC.h) / (REC.w / REC.h) > 0.02 || p.imageWidth < REC.w));
const find = (c, id) => c.projects.find((p) => p.id === id);
const orig = (id) => store.get().original.projects.find((p) => p.id === id);

function openEditor(id, onClose, isNew = false) {
  const index = () => store.get().content.projects.findIndex((p) => p.id === id);
  const get = (k) => () => find(store.get().content, id)?.[k] ?? "";
  const set = (k) => (v) => edit((c) => { const p = find(c, id); if (p) p[k] = v; });
  const path = (k) => () => `projects[${index()}].${k}`;
  const btn = (k) => () => find(store.get().content, id)?.button?.[k] ?? "";
  const setBtn = (k) => (v) => edit((c) => { const p = find(c, id); if (p?.button) p.button[k] = v; });
  const first = find(store.get().content, id);

  editorDialog({
    title: first?.name || "Project",
    onClose,
    collection: "projects", id, isNew, prefix: () => `projects[${index()}]`,
    onReset: () => resetItem("projects", id),
    build: (lv) => {
      const buttonBox = h("div", { class: "sub" });
      const drawButton = () => {
        const has = Boolean(find(store.get().content, id)?.button);
        if (buttonBox.dataset.has === String(has)) return;
        buttonBox.dataset.has = String(has);
        buttonBox.replaceChildren(
          switchRow("Button", has, (on) => edit((c) => {
            const p = find(c, id);
            if (on) p.button = { label: "source code", icon: store.get().icons.includes("github") ? "github" : store.get().icons[0], url: "https://" };
            else delete p.button;
          })),
          ...(has ? [
            field({ label: "Button label", required: true, get: btn("label"), orig: () => orig(id)?.button?.label, set: setBtn("label"), max: 24, lv, path: path("button.label") }),
            select({ label: "Button icon", value: btn("icon"), options: store.get().icons.map((n) => [n, n]), iconFor: (n) => n, onChange: (v) => edit((c) => { const b = find(c, id)?.button; if (!b) return; b.icon = v; b.url = urlForIcon(b.url, v); }), lv }),
            linkField({ label: "Button link", mailLabel: "Button mail", get: btn("url"), orig: () => orig(id)?.button?.url, set: setBtn("url"), kind: () => (find(store.get().content, id)?.button?.icon === "mail" ? "mail" : "web"), lv, path: path("button.url") }),
          ] : []));
      };
      lv.add(drawButton);
      const size = h("span", { class: "chip", title: "Recommended size (only a suggestion)" }, `${REC.w}×${REC.h}`);

      // choosing a picture also records its real size (the page reserves that space before the picture loads)
      const choose = (key) => async (value) => {
        let dims = null;
        if (key === "image") { try { dims = await measure(srcOf(value)); } catch { toast("Cannot open image"); return; } }
        edit((c) => { const p = find(c, id); p[key] = value; if (dims) { p.imageWidth = dims.width; p.imageHeight = dims.height; } });
      };
      return [
        field({ label: "Name", required: true, get: get("name"), orig: () => orig(id)?.name, set: set("name"), max: 40, lv, path: path("name") }),
        field({ label: "Description", required: true, get: get("description"), orig: () => orig(id)?.description, set: set("description"), max: 300, multiline: true, lv, path: path("description") }),
        imagePicker({ label: "Image", get: get("image"), orig: () => orig(id)?.image, set: choose("image"), lv, path: path("image"), warn: () => offSize(find(store.get().content, id)) }),
        h("div", { class: "swr" }, h("span", {}, "Recommended size"), size),
        imagePicker({ label: "Icon", get: get("icon"), orig: () => orig(id)?.icon, set: choose("icon"), lv, path: path("icon") }),
        linkField({ label: "Link", get: get("url"), orig: () => orig(id)?.url, set: set("url"), lv, path: path("url") }),
        buttonBox,
        switchRow("Visible", first?.visible ?? true, (v) => set("visible")(v)),
      ];
    },
  });
}

export function projectsView() {
  const lv = live();
  const bar = draftBar();
  const status = statusChips();
  const list = h("div", { class: "ilist" });
  const addBtn = textButton("Add project", () => {
    const { content } = store.get();
    if (content.projects.length >= MAX) return toast(`At most ${MAX} projects`);
    const id = uniqueId(content.projects, "project");
    edit((c) => c.projects.push({
      id, name: "", description: "", image: "", imageWidth: 1200, imageHeight: 630,
      url: "https://", icon: "", visible: false,
    }));
    openEditor(id, undefined, true);
  }, { lead: "plus" });

  const sort = sortable(list, "projects", () => draw());
  let shown = "";
  const draw = () => {
    if (sort.dragging) return;
    const { content, errors, added } = store.get();
    // the list only redraws when something it shows changed, so its pictures are not rebuilt (and reloaded) by every validation answer
    const key = JSON.stringify([content.projects, errors.filter((e) => e.startsWith("projects[")), Object.keys(added), [...pendingIds]]);
    if (key === shown) return;
    shown = key;
    list.replaceChildren(...content.projects.map((p, i) => pendingIds.has(p.id) ? null : row({
      id: p.id, grip: sort.handle(p.id, p.name),
      lead: p.image ? h("img", { class: "ir-img", src: srcOf(p.image), alt: "", width: 40, height: 24, decoding: "async", draggable: "false" }) : h("span", { class: "ir-img ph", "aria-hidden": "true" }, icon("image")),
      title: p.name, sub: p.url, bad: errors.some((e) => e.startsWith(`projects[${i}]`)),
      tail: [
        toggle({ label: p.visible ? "Hide" : "Show", checked: p.visible, onChange: (v) => edit((c) => { find(c, p.id).visible = v; }) }),
        iconButton("edit", "Edit", () => openEditor(p.id)),
        iconButton("trash", "Delete", async () => {
          if (!(await confirmDialog({ title: `Delete ${p.name}?`, ok: "Delete", danger: true }))) return;
          edit((c) => { c.projects = c.projects.filter((x) => x.id !== p.id); });
        }, { danger: true }),
      ],
    })).filter(Boolean));
    if (!list.children.length) list.replaceChildren(h("div", { class: "empty" }, icon("work", "empty-ico"), h("p", {}, "No projects")));
    addBtn.disabled = content.projects.length >= MAX;
    sort.restore();
  };
  lv.add(() => { draw(); status.sync(); });

  return {
    bar: h("div", { class: "bar-end" }, status.el, bar.el),
    el: panel({ actions: [addBtn], body: [list] }),
    start: () => lv.start(),
    stop: () => { lv.stop(); bar.stop(); },
  };
}
