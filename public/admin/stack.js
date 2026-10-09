// Stack: technologies shown on the Skills page, all of one kind. Name, colour, icon (picture, built-in icon or letters), visibility, order (drag the handle; the first is selected when the site opens).
// Level and link are not shown by the page, so content.json has no such fields.
import { h, icon, panel, iconButton, textButton, toggle, confirmDialog, toast } from "./ui.js";
import { store, edit, resetItem, srcOf } from "./draft.js";
import { uniqueId } from "./logic.js";
import { colorPicker } from "./colorpicker.js";
import { pendingIds, field, select, switchRow, imagePicker, live, draftBar, editorDialog, row, statusChips, sortable } from "./kit.js";

const MAX = 60;
const find = (c, id) => c.stack.find((x) => x.id === id);
const orig = (id) => store.get().original.stack.find((x) => x.id === id);

function openEditor(id, onClose, isNew = false) {
  const index = () => store.get().content.stack.findIndex((x) => x.id === id);
  const get = (k) => () => find(store.get().content, id)?.[k] ?? "";
  const set = (k) => (v) => edit((c) => { const x = find(c, id); if (x) x[k] = v; });
  const path = (k) => () => `stack[${index()}].${k}`;
  const art = (k) => () => find(store.get().content, id)?.art?.[k] ?? "";
  const setArt = (k) => (v) => edit((c) => { const x = find(c, id); if (x) { x.art[k] = v; if (k === "src") delete x.art.cdn; } });
  const first = find(store.get().content, id);

  editorDialog({
    title: first?.name || "Tech",
    onClose,
    collection: "stack", id, isNew, prefix: () => `stack[${index()}]`,
    onReset: () => resetItem("stack", id),
    build: (lv) => {
      const artBox = h("div", { class: "sub" });
      const drawArt = () => {
        const kind = find(store.get().content, id)?.art?.kind;
        if (artBox.dataset.kind === kind) return;
        artBox.dataset.kind = kind;
        const letter = field({ label: "Letters", required: true, get: art("letter"), orig: () => orig(id)?.art?.letter, set: setArt("letter"), max: 3, lv, path: path("art.letter") });
        artBox.replaceChildren(
          ...(kind === "sprite"
            ? [select({ label: "Icon", value: art("icon"), options: store.get().icons.map((n) => [n, n]), iconFor: (n) => n, onChange: setArt("icon"), lv, path: path("art.icon") })]
            : kind === "image"
              ? [imagePicker({ label: "Picture", accept: "any", get: art("src"), orig: () => orig(id)?.art?.src, set: setArt("src"), lv, path: path("art.src") }), letter]
              : [letter]));
      };
      lv.add(drawArt);

      const kinds = [["image", "Picture"], ["sprite", "Icon"], ["text", "Letters"]];
      const changeKind = (kind) => edit((c) => {
        const x = find(c, id);
        const letter = x.art.letter ?? [...x.name][0]?.toUpperCase() ?? "?";
        x.art = kind === "sprite" ? { kind, icon: store.get().icons[0] } : kind === "image"
          ? { kind, letter, src: (store.get().files.find((f) => f.path.startsWith("/skill/")) ?? store.get().files[0]).path } : { kind, letter };
      });

      const colour = field({ label: "Colour", required: true, get: get("color"), orig: () => orig(id)?.color, set: (v) => set("color")(v.trim()), max: 7, lv, path: path("color"), plain: true });
      const hexInput = colour.querySelector(".inp");
      const picker = colorPicker({ get: get("color"), set: set("color"), lv, onPreview: (hex) => { hexInput.value = hex; } });

      return [
        field({ label: "Name", required: true, get: get("name"), orig: () => orig(id)?.name, set: set("name"), max: 30, lv, path: path("name") }),
        h("div", { class: "cprow" }, colour, ...(picker.dropper ? [picker.dropper] : []), picker.swatch),
        picker.panel,
        select({ label: "Look", value: () => find(store.get().content, id)?.art?.kind ?? "text", options: kinds, onChange: changeKind, lv }),
        artBox,
        switchRow("Visible", first?.visible ?? true, (v) => set("visible")(v)),
      ];
    },
  });
}

export function stackView() {
  const lv = live();
  const bar = draftBar();
  const status = statusChips();
  const list = h("div", { class: "ilist" });
  const addBtn = textButton("Add tech", () => {
    const { content } = store.get();
    if (content.stack.length >= MAX) return toast(`At most ${MAX} items`);
    const id = uniqueId(content.stack, "tech");
    edit((c) => c.stack.push({ id, name: "", color: "#c1c5ce", art: { kind: "text", letter: "" }, visible: false }));
    openEditor(id, undefined, true);
  }, { lead: "plus" });

  const lead = (x) => (x.art.kind === "image" ? h("img", { class: "ir-img sq", src: srcOf(x.art.src), alt: "", width: 24, height: 24, decoding: "async", draggable: "false" })
    : x.art.kind === "sprite" ? icon(x.art.icon) : h("b", { class: "ltr-s" }, x.art.letter));

  const sort = sortable(list, "stack", () => draw());
  let shown = "";
  const draw = () => {
    if (sort.dragging) return;
    const { content, errors, added } = store.get();
    // the list only redraws when something it shows changed, so its pictures are not rebuilt (and reloaded) by every validation answer
    const key = JSON.stringify([content.stack, errors.filter((e) => e.startsWith("stack[")), Object.keys(added), [...pendingIds]]);
    if (key === shown) return;
    shown = key;
    list.replaceChildren(...content.stack.map((x, i) => pendingIds.has(x.id) ? null : row({
      id: x.id, grip: sort.handle(x.id, x.name),
      lead: lead(x), title: x.name, sub: x.art.kind === "image" ? "picture" : x.art.kind === "sprite" ? "icon" : "letters", bad: errors.some((e) => e.startsWith(`stack[${i}]`)),
      tail: [
        toggle({ label: x.visible ? "Hide" : "Show", checked: x.visible, onChange: (v) => edit((c) => { find(c, x.id).visible = v; }) }),
        iconButton("edit", "Edit", () => openEditor(x.id)),
        iconButton("trash", "Delete", async () => {
          if (!(await confirmDialog({ title: `Delete ${x.name}?`, ok: "Delete", danger: true }))) return;
          edit((c) => { c.stack = c.stack.filter((y) => y.id !== x.id); });
        }, { danger: true }),
      ],
    })).filter(Boolean));
    if (!list.children.length) list.replaceChildren(h("div", { class: "empty" }, icon("code", "empty-ico"), h("p", {}, "No tech")));
    addBtn.disabled = content.stack.length >= MAX;
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
