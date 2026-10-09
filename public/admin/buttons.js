// Buttons: label, link, icon, show / hide, add, delete, order (drag the handle). The preview uses the site's own .links / .chip CSS.
import { h, icon, panel, iconButton, textButton, toggle, confirmDialog, toast } from "./ui.js";
import { store, edit, resetItem } from "./draft.js";
import { uniqueId } from "./logic.js";
import { pendingIds, field, linkField, urlForIcon, select, switchRow, live, draftBar, editorDialog, row, note, statusChips, sortable } from "./kit.js";

const MAX = 12;
const find = (c, id) => c.buttons.find((b) => b.id === id);
const orig = (id) => store.get().original.buttons.find((b) => b.id === id);

function preview() {
  const links = h("div", { class: "links" });
  const box = h("div", { class: "bpv", role: "img", "aria-label": "Preview" }, links);
  const sync = () => {
    const shown = store.get().content.buttons.filter((b) => b.visible);
    links.replaceChildren(...shown.map((b) => h("span", { class: "chip" }, icon(b.icon), h("span", {}, b.label || "…"))));
    box.classList.toggle("none", shown.length === 0);
  };
  return { el: box, sync };
}

function openEditor(id, onClose, isNew = false) {
  const index = () => store.get().content.buttons.findIndex((b) => b.id === id);
  const get = (k) => () => find(store.get().content, id)?.[k] ?? "";
  const set = (k) => (v) => edit((c) => { const b = find(c, id); if (b) b[k] = v; });
  editorDialog({
    title: find(store.get().content, id)?.label || "Button",
    onClose,
    collection: "buttons", id, isNew, prefix: () => `buttons[${index()}]`,
    onReset: () => resetItem("buttons", id),
    build: (lv) => {
      const b = find(store.get().content, id);
      const path = (k) => `buttons[${index()}].${k}`;
      return [
        field({ label: "Label", required: true, get: get("label"), orig: () => orig(id)?.label, set: set("label"), max: 24, lv, path: () => path("label") }),
        select({ label: "Icon", value: get("icon"), options: store.get().icons.map((n) => [n, n]), iconFor: (n) => n, onChange: (v) => edit((c) => { const x = find(c, id); if (!x) return; x.icon = v; if (x.type !== "mail") x.url = urlForIcon(x.url, v); }), lv }),
        b.type === "mail"
          ? note("Opens your email address")
          : linkField({ label: "Link", mailLabel: "Mail", get: get("url"), orig: () => orig(id)?.url, set: set("url"), kind: () => (find(store.get().content, id)?.icon === "mail" ? "mail" : "web"), lv, path: () => path("url") }),
        switchRow("Visible", b.visible, (v) => set("visible")(v)),
      ];
    },
  });
}

export function buttonsView() {
  const lv = live();
  const bar = draftBar();
  const status = statusChips();
  const pv = preview();
  const list = h("div", { class: "ilist" });
  const addBtn = textButton("Add button", () => {
    const { content, icons } = store.get();
    if (content.buttons.length >= MAX) return toast(`At most ${MAX} buttons`);
    const id = uniqueId(content.buttons, "button");
    edit((c) => c.buttons.push({ id, label: "", icon: icons.includes("code") ? "code" : icons[0], url: "https://", visible: true }));
    openEditor(id, undefined, true);
  }, { lead: "plus" });

  const sort = sortable(list, "buttons", () => draw());
  let shown = "";
  const draw = () => {
    if (sort.dragging) return;
    const { content, errors, added } = store.get();
    // the list only redraws when something it shows changed, so its pictures are not rebuilt (and reloaded) by every validation answer
    const key = JSON.stringify([content.buttons, errors.filter((e) => e.startsWith("buttons[")), Object.keys(added), [...pendingIds]]);
    if (key === shown) return;
    shown = key;
    list.replaceChildren(...content.buttons.map((b, i) => {
      if (pendingIds.has(b.id)) return null;
      const bad = errors.some((e) => e.startsWith(`buttons[${i}]`));
      return row({
        id: b.id, grip: sort.handle(b.id, b.label),
        lead: icon(b.icon), title: b.label, sub: b.type === "mail" ? "email" : b.url, bad,
        tail: [
          toggle({ label: b.visible ? "Hide" : "Show", checked: b.visible, onChange: (v) => edit((c) => { find(c, b.id).visible = v; }) }),
          iconButton("edit", "Edit", () => openEditor(b.id)),
          iconButton("trash", "Delete", async () => {
            if (!(await confirmDialog({ title: `Delete ${b.label}?`, ok: "Delete", danger: true }))) return;
            edit((c) => { c.buttons = c.buttons.filter((x) => x.id !== b.id); });
          }, { danger: true }),
        ],
      });
    }).filter(Boolean));
    if (!list.children.length) list.replaceChildren(h("div", { class: "empty" }, icon("button", "empty-ico"), h("p", {}, "No buttons")));
    sort.restore();
  };
  lv.add(() => { pv.sync(); draw(); status.sync(); addBtn.disabled = store.get().content.buttons.length >= MAX; });

  return {
    bar: h("div", { class: "bar-end" }, status.el, bar.el),
    el: h("div", { class: "stack" },
      panel({ title: "Preview", body: [pv.el] }),
      panel({ actions: [addBtn], body: [list] })),
    start: () => lv.start(),
    stop: () => { lv.stop(); bar.stop(); },
  };
}
