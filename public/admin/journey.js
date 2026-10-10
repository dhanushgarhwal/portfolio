// Journey: manage the Journey page. Same flow as the other editors (draft in memory + IndexedDB, nothing leaves until Push).
//
//   Entries    date-sorted list (the order the page shows); add, edit, duplicate, delete (with confirm), show/hide, pin.
//              Each entry opens in the shared editor dialog (kit.js editorDialog); its fields are judged by the build's own validator.
//   Page       on/off, title, subtitle, direction, start and end labels.
//   Road       the seed (type, re-roll, lock) and the five path sliders. The same seed always draws the same road.
//   Highlight  breathing on/off, speed, colour.
//   Data       export the whole block as JSON, import one (checked by the server's validator before it is accepted).
//
// Every rule (limits, ranges, dates, links, icons, image paths) lives in scripts/schema.mjs; this file only mirrors the numbers it needs for
// counters and slider ends (logic.js JOURNEY, kept equal by scripts/test-editors.mjs). The page preview is the global Preview button, which
// renders the real site from the unsaved draft, Journey page included.
import { h, icon, panel, iconButton, textButton, toggle, confirmDialog, toast, api, ApiError, explain } from "./ui.js";
import { store, edit, resetItem } from "./draft.js";
import { JOURNEY, journeyDateKey, newJourney, randomSeed, sameDates, sortJourney, uniqueId } from "./logic.js";
import { colorPicker } from "./colorpicker.js";
import { pendingIds, field, linkField, select, switchRow, imagePicker, slider, live, draftBar, editorDialog, row, statusChips, note } from "./kit.js";

const find = (c, id) => c.journey?.entries.find((x) => x.id === id);
const orig = (id) => store.get().original.journey?.entries.find((x) => x.id === id);
const origJ = (k) => () => store.get().original.journey?.[k];
const J = () => store.get().content.journey;
const setJ = (k) => (v) => edit((c) => { if (c.journey) c.journey[k] = v; });
const ALLOWED = ["enabled", "title", "subtitle", "direction", "startLabel", "endLabel", "seed", "path", "highlight", "entries"];
const MAX_FILE = 200_000; // the same ceiling the server puts on a whole content.json

/** A switch row that follows the draft (undo, discard and import move it too). */
function liveSwitch(label, get, set, lv, disabled = () => false) {
  const tg = toggle({ label, checked: get(), onChange: set });
  lv.add(() => { tg.setAttribute("aria-checked", String(get())); tg.disabled = disabled(); });
  return h("div", { class: "swr" }, h("span", {}, label), tg);
}

/* ---------- one entry ---------- */
function openEditor(id, onClose, isNew = false) {
  const index = () => J().entries.findIndex((x) => x.id === id);
  const get = (k) => () => find(store.get().content, id)?.[k] ?? "";
  const set = (k) => (v) => edit((c) => { const x = find(c, id); if (x) x[k] = v; });
  const path = (k) => () => `journey.entries[${index()}].${k}`;
  const link = (k) => () => find(store.get().content, id)?.link?.[k] ?? "";
  const setLink = (k) => (v) => edit((c) => { const x = find(c, id); if (x?.link) x.link[k] = v; });
  const first = find(store.get().content, id);
  const o = (k) => () => (isNew ? undefined : orig(id)?.[k]);

  editorDialog({
    title: first?.title || "Entry",
    onClose,
    collection: "journey.entries", id, isNew, prefix: () => `journey.entries[${index()}]`,
    onReset: () => resetItem("journey.entries", id),
    build: (lv) => {
      const linkBox = h("div", { class: "sub" });
      const drawLink = () => {
        const has = Boolean(find(store.get().content, id)?.link);
        if (linkBox.dataset.has === String(has)) return;
        linkBox.dataset.has = String(has);
        linkBox.replaceChildren(
          switchRow("Link", has, (on) => edit((c) => {
            const x = find(c, id);
            if (on) x.link = { label: "see it", url: "https://" }; else delete x.link;
          })),
          ...(has ? [
            field({ label: "Link label", required: true, get: link("label"), orig: () => (isNew ? undefined : orig(id)?.link?.label), set: setLink("label"), max: JOURNEY.label, lv, path: path("link.label") }),
            linkField({ label: "Link", mailLabel: "Mail", get: link("url"), orig: () => (isNew ? undefined : orig(id)?.link?.url), set: setLink("url"), kind: () => (/^mailto:/i.test(find(store.get().content, id)?.link?.url ?? "") ? "mail" : "web"), lv, path: path("link.url") }),
          ] : []));
      };
      lv.add(drawLink);

      return [
        field({ label: "Title", required: true, get: get("title"), orig: o("title"), set: set("title"), max: JOURNEY.title, lv, path: path("title") }),
        field({ label: "Date", required: true, get: get("date"), orig: o("date"), set: (v) => set("date")(v.trim()), max: 10, lv, path: path("date"), plain: true, valid: (v) => journeyDateKey(v.trim()) !== "" }),
        note("2024, 2024-05 or 2024-05-17"),
        field({ label: "Text", required: true, get: get("text"), orig: o("text"), set: set("text"), max: JOURNEY.text, multiline: true, lv, path: path("text") }),
        field({ label: "Tag", required: true, get: get("tag"), orig: o("tag"), set: set("tag"), max: JOURNEY.tag, lv, path: path("tag") }),
        select({ label: "Icon", value: get("icon"), options: store.get().icons.map((n) => [n, n]), iconFor: (n) => n, onChange: set("icon"), lv, path: path("icon"), required: true }),
        imagePicker({
          label: "Picture", required: false, clearable: true, lv, path: path("image"), get: get("image"),
          orig: () => (isNew ? undefined : orig(id) ? orig(id).image ?? "" : undefined),
          set: (v) => edit((c) => { const x = find(c, id); if (!x) return; if (v) x.image = v; else delete x.image; }),
        }),
        linkBox,
        select({ label: "Card side", value: get("side"), options: JOURNEY.sides, onChange: set("side"), lv, path: path("side") }),
        switchRow("Visible", first?.visible ?? true, (v) => set("visible")(v)),
        switchRow("Pinned", first?.pinned ?? false, (v) => set("pinned")(v)),
      ];
    },
  });
}

/* ---------- import / export ---------- */
function exportJson() {
  const text = `${JSON.stringify(J(), null, 2)}\n`;
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = h("a", { href: url, download: "journey.json", hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Reads a file, checks it with the server's own validator and only then puts it in the draft. */
async function importJson(file) {
  if (!file) return;
  if (file.size > MAX_FILE) return toast("File too big");
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast("Not valid JSON"); }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return toast("Not a Journey block");
  const unknown = Object.keys(data).filter((k) => !ALLOWED.includes(k));
  if (unknown.length) return toast(`Unknown key: ${unknown[0].slice(0, 24)}`);
  const s = store.get();
  try {
    const r = await api("/api/admin/validate", { method: "POST", body: { base: s.base, content: { ...s.content, journey: data }, added: Object.keys(s.added), removed: s.removed } });
    const bad = r.errors.filter((e) => e.startsWith("journey"));
    if (bad.length) return toast(bad[0].slice(0, 120));
  } catch (e) { return toast(e instanceof ApiError ? explain(e) : "Could not check the file"); }
  if (!(await confirmDialog({ title: "Replace the Journey?", text: "Settings and entries are replaced by the file. You can still discard it before pushing.", ok: "Replace", danger: true }))) return;
  edit((c) => { c.journey = data; });
  toast("Imported", "ok", 2000);
}

/* ---------- the screen ---------- */
export function journeyView() {
  const lv = live();
  const bar = draftBar();
  const status = statusChips();
  let locked = false; // the seed lock lives only while this screen is open

  const has = () => Boolean(J());
  const jget = (k) => () => J()?.[k] ?? "";
  const pget = (g, k) => () => J()?.[g]?.[k] ?? 0;
  const pset = (g, k) => (v) => edit((c) => { if (c.journey) c.journey[g][k] = v; });
  const porig = (g, k) => () => store.get().original.journey?.[g]?.[k];
  const reset = (label, run) => iconButton("undo", label, run);

  /* -- entries -- */
  const list = h("div", { class: "ilist" });
  const cap = () => (J()?.entries.length ?? 0) >= JOURNEY.entries;
  const addBtn = textButton("Add entry", () => {
    if (cap()) return toast(`At most ${JOURNEY.entries} entries`);
    const { content, icons } = store.get();
    const id = uniqueId(content.journey.entries, "entry");
    const now = new Date();
    const date = `${Math.min(2100, Math.max(1900, now.getFullYear()))}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    edit((c) => c.journey.entries.push({ id, date, title: "", text: "", tag: "milestone", icon: icons.includes("star") ? "star" : icons[0], visible: true, pinned: false, side: "auto" }));
    openEditor(id, undefined, true);
  }, { lead: "plus" });

  const duplicate = (x) => {
    if (cap()) return toast(`At most ${JOURNEY.entries} entries`);
    const id = uniqueId(J().entries, "entry");
    edit((c) => {
      const copy = structuredClone(find(c, x.id));
      copy.id = id; copy.pinned = false;
      copy.title = `${[...copy.title].slice(0, JOURNEY.title - 5).join("")} copy`.trim();
      c.journey.entries.push(copy);
    });
    openEditor(id, undefined, true); // Cancel removes the copy again
  };

  const lead = (x) => (document.getElementById(`i-${x.icon}`) ? icon(x.icon) : h("b", { class: "ltr-s" }, [...(x.title || "?")][0]?.toUpperCase() ?? "?"));
  let shown = "";
  const draw = () => {
    const { content, errors, added } = store.get();
    const j = content.journey;
    if (!j) return;
    // redraw only when something the list shows changed (pictures are not reloaded by every validation answer)
    const key = JSON.stringify([j.entries, j.direction, errors.filter((e) => e.startsWith("journey.entries[")), Object.keys(added), [...pendingIds]]);
    if (key === shown) return;
    shown = key;
    const at = new Map(j.entries.map((x, i) => [x.id, i]));
    const twins = sameDates(j.entries);
    let latest = null, latestKey = "";
    for (const x of j.entries) { const k = journeyDateKey(x.date); if (x.visible && k && k >= latestKey) { latest = x.id; latestKey = k; } }
    const rows = sortJourney(j.entries, j.direction).map((x) => {
      if (pendingIds.has(x.id)) return null;
      const i = at.get(x.id);
      const bad = errors.some((e) => e.startsWith(`journey.entries[${i}]`));
      const flags = [!journeyDateKey(x.date) ? "bad date" : twins.has(x.id) ? "same date" : "", x.id === latest ? "latest" : "", x.pinned ? "pinned" : "", x.visible ? "" : "hidden"].filter(Boolean);
      const pin = iconButton("pin", x.pinned ? "Unpin" : "Pin", () => edit((c) => { const e = find(c, x.id); e.pinned = !e.pinned; }));
      pin.classList.toggle("on", x.pinned);
      pin.setAttribute("aria-pressed", String(x.pinned));
      return row({
        id: x.id, lead: lead(x), title: x.title || "Untitled", bad,
        sub: [...new Set([x.date, x.tag, ...flags].filter(Boolean))].join(" · "),
        tail: [
          toggle({ label: x.visible ? "Hide" : "Show", checked: x.visible, onChange: (v) => edit((c) => { find(c, x.id).visible = v; }) }),
          pin,
          iconButton("file", "Duplicate", () => duplicate(x)),
          iconButton("edit", "Edit", () => openEditor(x.id)),
          iconButton("trash", "Delete", async () => {
            if (!(await confirmDialog({ title: `Delete ${x.title || "entry"}?`, ok: "Delete", danger: true }))) return;
            edit((c) => { c.journey.entries = c.journey.entries.filter((y) => y.id !== x.id); });
          }, { danger: true }),
        ],
      });
    }).filter(Boolean);
    list.replaceChildren(...(rows.length ? rows : [h("div", { class: "empty" }, icon("marker", "empty-ico"), h("p", {}, "No entries"))]));
    addBtn.disabled = j.entries.length >= JOURNEY.entries;
  };

  /* -- page -- */
  const heads = [["title", "Title", JOURNEY.heading], ["subtitle", "Subtitle", JOURNEY.subtitle], ["startLabel", "Start label", JOURNEY.label], ["endLabel", "End label", JOURNEY.label]];
  const pageBody = [
    liveSwitch("Enabled", () => Boolean(J()?.enabled), setJ("enabled"), lv),
    ...heads.slice(0, 2).map(([k, label, max]) => field({ label, required: true, get: jget(k), orig: origJ(k), set: setJ(k), max, lv, path: `journey.${k}` })),
    select({ label: "Direction", value: jget("direction") || "latest-top", options: JOURNEY.directions, onChange: setJ("direction"), lv, path: "journey.direction" }),
    ...heads.slice(2).map(([k, label, max]) => field({ label, required: true, get: jget(k), orig: origJ(k), set: setJ(k), max, lv, path: `journey.${k}` })),
  ];
  const pagePanel = panel({ title: "Page", actions: [reset("Reset to defaults", () => edit((c) => { Object.assign(c.journey, JOURNEY.defaults.head); }))], body: pageBody });

  /* -- road -- */
  const seed = field({
    label: "Seed", required: true, plain: true, max: 10, lv, path: "journey.seed",
    get: () => String(J()?.seed ?? ""), orig: () => (origJ("seed")() === undefined ? undefined : String(origJ("seed")())),
    valid: (v) => /^\d{1,10}$/.test(v) && +v <= JOURNEY.ranges.seed[1],
    set: (v) => { if (/^\d{1,10}$/.test(v) && +v <= JOURNEY.ranges.seed[1]) setJ("seed")(Number(v)); },
  });
  const seedInput = seed.querySelector(".inp");
  seedInput.setAttribute("inputmode", "numeric");
  const roll = iconButton("refresh", "Re-roll road", () => { if (!locked) setJ("seed")(randomSeed(() => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296)); });
  const lock = iconButton("lock", "Lock seed", () => { locked = !locked; lv.flush(); });
  const syncLock = () => {
    roll.disabled = locked; seedInput.disabled = locked;
    lock.setAttribute("aria-pressed", String(locked));
    lock.setAttribute("aria-label", locked ? "Unlock seed" : "Lock seed");
    lock.classList.toggle("on", locked);
    const use = lock.querySelector("use");
    use?.setAttribute("href", locked ? "#i-lock" : "#i-unlock");
  };
  lv.add(syncLock);
  const SLIDERS = [["spacing", "Spacing"], ["amplitude", "Swing"], ["curviness", "Curviness"], ["jitter", "Randomness"], ["width", "Road width"]];
  const roadPanel = panel({
    title: "Road",
    actions: [reset("Reset to defaults", () => edit((c) => { c.journey.path = { ...JOURNEY.defaults.path }; }))],
    body: [
      h("div", { class: "seedrow" }, seed, roll, lock),
      note("Same seed, same road"),
      ...SLIDERS.map(([k, label]) => slider({ label, range: JOURNEY.ranges.path[k], get: pget("path", k), orig: porig("path", k), set: pset("path", k), lv, path: `journey.path.${k}` })),
    ],
  });

  /* -- highlight -- */
  const colour = field({ label: "Colour", required: true, get: () => J()?.highlight?.color ?? "", orig: () => porig("highlight", "color")(), set: (v) => pset("highlight", "color")(v.trim()), max: 7, lv, path: "journey.highlight.color", plain: true });
  const hexInput = colour.querySelector(".inp");
  const picker = colorPicker({ get: () => J()?.highlight?.color ?? "#c1c5ce", set: pset("highlight", "color"), lv, onPreview: (hex) => { hexInput.value = hex; } });
  const lightPanel = panel({
    title: "Highlight",
    actions: [reset("Reset to defaults", () => edit((c) => { c.journey.highlight = { ...JOURNEY.defaults.highlight }; }))],
    body: [
      liveSwitch("Breathing", () => Boolean(J()?.highlight?.breathing), pset("highlight", "breathing"), lv),
      slider({ label: "Speed", range: JOURNEY.ranges.highlight.speed, get: pget("highlight", "speed"), orig: porig("highlight", "speed"), set: pset("highlight", "speed"), lv, path: "journey.highlight.speed" }),
      h("div", { class: "cprow" }, colour, ...(picker.dropper ? [picker.dropper] : []), picker.swatch),
      picker.panel,
    ],
  });

  /* -- data -- */
  const pick = h("input", { type: "file", class: "file", accept: "application/json,.json", tabindex: "-1", "aria-hidden": "true" });
  pick.addEventListener("change", async () => { const f = pick.files[0]; pick.value = ""; await importJson(f); });
  const dataPanel = panel({
    title: "Data",
    actions: [textButton("Export", exportJson, { lead: "download" }), textButton("Import", () => pick.click(), { lead: "upload" })],
    body: [note("JSON of the whole Journey"), pick],
  });

  const entriesPanel = panel({ title: "Entries", actions: [addBtn], body: [list] });
  const startBtn = textButton("Create Journey", () => edit((c) => { c.journey = newJourney(); }), { lead: "plus" });
  const emptyPanel = panel({ body: [h("div", { class: "empty" }, icon("marker", "empty-ico"), h("p", {}, "No Journey"), startBtn)] });
  const panels = [entriesPanel, pagePanel, roadPanel, lightPanel, dataPanel];

  lv.add(() => {
    const on = has();
    emptyPanel.hidden = on;
    for (const p of panels) p.hidden = !on;
    draw();
    status.sync();
  });

  return {
    bar: h("div", { class: "bar-end" }, status.el, bar.el),
    el: h("div", { class: "stack" }, emptyPanel, ...panels),
    start: () => lv.start(),
    stop: () => { lv.stop(); bar.stop(); },
  };
}
