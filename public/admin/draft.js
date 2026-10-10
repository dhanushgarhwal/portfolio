// The draft engine. Holds the working copy of content.json and the image changes. Nothing leaves the browser until the Push screen sends it (push.js).
// The draft lives in memory and in IndexedDB, so a refresh or an expired session never loses edits.
import { api, ApiError, confirmDialog, createStore, draft as pending, toast } from "./ui.js";
import { changesOf, refsTo, rewriteRefs, errorsAt, moveItem, listAt, LIMITS } from "./logic.js";

const DB = "admin-draft", KEY = "draft";

/* ---- IndexedDB (one record) ---- */
function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idb(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("kv", mode);
      const req = fn(tx.objectStore("kv"));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
const readSaved = () => idb("readonly", (s) => s.get(KEY)).catch(() => undefined);
const writeSaved = (v) => idb("readwrite", (s) => (v ? s.put(v, KEY) : s.delete(KEY)));

/* ---- state ---- */
// status: "idle" | "loading" | "ready" | "error"
export const store = createStore({
  status: "idle", error: "", base: "", head: "", original: null, content: null, files: [], icons: [],
  added: {},   // "/image/x.webp" -> { data, size, width?, height? }   (new or replaced files)
  removed: [], // repo files to delete
  errors: [], warnings: [], checking: false, stale: false, behind: false,
});

let saveTimer = 0, checkTimer = 0, checkRun = 0;

function publish() {
  const s = store.get();
  pending.set({ changes: s.content ? changesOf(s.original, s.content, { added: Object.keys(s.added), removed: s.removed }) : [] });
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const s = store.get();
    const hasChanges = pending.get().changes.length > 0;
    writeSaved(hasChanges ? { base: s.base, content: s.content, added: s.added, removed: s.removed } : null).catch(() => { /* private mode: edits still live in memory */ });
  }, 600);
}

function touch(patch) {
  store.set({ ...patch, stale: true });
  publish();
  persist();
  schedule();
}

/* ---- server validation (the build's own validator) ---- */
function schedule() {
  clearTimeout(checkTimer);
  checkRun++; // an answer for an older draft must never land
  checkTimer = setTimeout(check, 500);
}
export async function check() {
  const s = store.get();
  if (!s.content) return;
  const run = ++checkRun;
  store.set({ checking: true });
  try {
    const r = await api("/api/admin/validate", { method: "POST", body: { base: s.base, content: s.content, added: Object.keys(s.added), removed: s.removed } });
    if (run === checkRun) store.set({ errors: r.errors, warnings: r.warnings, checking: false, stale: false });
  } catch (e) {
    if (run === checkRun) store.set({ checking: false, stale: false });
    if (!(e instanceof ApiError)) throw e;
  }
}
export const errorsFor = (prefix) => errorsAt(store.get().errors, prefix);
/** True only when the server's answer belongs to the draft on screen. Older answers are never shown (that was the flashing red ring). */
export const settled = () => { const s = store.get(); return !s.stale && !s.checking; };

/* ---- loading ---- */
export async function load() {
  if (store.get().status === "loading") return;
  store.set({ status: "loading", error: "" });
  try {
    const saved = await readSaved();
    let remote = await api("/api/admin/content");
    let resume = false;
    if (saved?.content && saved.base) {
      if (saved.base === remote.base) resume = true;
      else {
        const keep = await confirmDialog({ title: "Repo changed", text: "Keep your draft or load the latest?", ok: "Keep draft" });
        if (keep) { remote = await api(`/api/admin/content?base=${saved.base}`); resume = true; } else await writeSaved(null).catch(() => {});
      }
    }
    store.set({
      status: "ready", base: remote.base, head: remote.head, original: remote.content, files: remote.files, icons: remote.icons,
      content: resume ? saved.content : structuredClone(remote.content), added: resume ? saved.added ?? {} : {}, removed: resume ? saved.removed ?? [] : [],
      behind: remote.head !== remote.base, errors: [], warnings: [],
    });
    publish();
    check();
    if (remote.head !== remote.base) toast("Repo has newer commits", "ok", 3500);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return store.set({ status: "idle" });
    store.set({ status: "error", error: e instanceof ApiError && e.code === "norepo" ? "norepo" : e instanceof ApiError && e.status === 0 ? "offline" : "failed" });
  }
}

/** Forgets the working copy (memory and IndexedDB) and loads the repo's latest state. Used after a successful push and for "Load latest". */
export async function reloadLatest() {
  clearTimeout(saveTimer);
  clearTimeout(checkTimer);
  checkRun++; // a validation still on its way must not write into the fresh state
  await writeSaved(null).catch(() => {});
  store.set({ status: "idle", error: "", base: "", head: "", original: null, content: null, files: [], added: {}, removed: [], errors: [], warnings: [], checking: false, behind: false });
  publish();
  return load();
}

/** The body of POST /api/admin/push (the message and key are added by the Push screen). */
export function pushPayload() {
  const { base, content, added, removed } = store.get();
  return { base, content, added: Object.fromEntries(Object.entries(added).map(([path, a]) => [path, a.data])), removed };
}

/* ---- edits ---- */
/** edit((content) => { content.texts.home.title = "x"; }) works on a copy, so a throwing edit changes nothing */
export function edit(fn) {
  const next = structuredClone(store.get().content);
  fn(next);
  touch({ content: next });
}

/** Puts the item `fromId` of a list (projects, stack, buttons) where `toId` is. The first item of each list is the one selected when the site opens. */
export function reorder(collection, fromId, toId) {
  edit((c) => { c[collection] = moveItem(c[collection], fromId, toId); });
}

export function resetTexts(paths) { // paths like ["texts.home.title"]; resets those leaves to the loaded value
  const { original } = store.get();
  edit((c) => {
    for (const p of paths) {
      const keys = p.split(".");
      const last = keys.pop();
      const get = (o) => keys.reduce((x, k) => x[k], o);
      get(c)[last] = get(original)[last];
    }
  });
}
/** Puts one item of a list back as it was loaded (area is a list path: "projects", "journey.entries"). An item the repo does not have is removed. */
export function resetItem(area, id) {
  const { original } = store.get();
  const orig = listAt(original, area)?.find((x) => x.id === id);
  edit((c) => {
    const list = listAt(c, area);
    if (!list) return;
    const i = list.findIndex((x) => x.id === id);
    if (orig && i >= 0) list[i] = structuredClone(orig);
    else if (orig) list.push(structuredClone(orig));
    else if (i >= 0) list.splice(i, 1);
  });
}
export async function discardAll() {
  clearTimeout(saveTimer);
  const { original } = store.get();
  await writeSaved(null).catch(() => {});
  touch({ content: structuredClone(original), added: {}, removed: [] });
}

/* ---- files: repo files + added - removed ---- */
export function fileList() {
  const { files, added, removed } = store.get();
  const out = files.filter((f) => !removed.includes(f.path) || f.path in added).map((f) => (f.path in added ? { path: f.path, size: added[f.path].size, state: "replaced", data: added[f.path].data } : { ...f, state: "" }));
  for (const [path, a] of Object.entries(added)) if (!out.some((f) => f.path === path)) out.push({ path, size: a.size, state: "new", data: a.data });
  return out.sort((x, y) => x.path.localeCompare(y.path));
}
/** a picture address the admin page may show: new files are data: URLs, existing ones come from the live site */
export const srcOf = (path) => store.get().added[path]?.data ?? path;
export const exists = (path) => fileList().some((f) => f.path === path);
export const usedBy = (path) => refsTo(store.get().content, path);

function room(extra) {
  const { added } = store.get();
  const list = Object.values(added);
  if (list.length >= LIMITS.files) throw new Error("Too many new files");
  if (list.reduce((n, a) => n + a.size, 0) + extra > LIMITS.total) throw new Error("Draft images too big");
}

/** Adds a new file; refuses a name that is already taken, so nothing unrelated is ever overwritten. */
export function addFile(path, asset) {
  if (exists(path)) throw new Error("Name taken");
  room(asset.size);
  touch({ added: { ...store.get().added, [path]: asset } });
}

/** Replaces `oldPath`. When the extension changes the file gets a new name and every use of it follows. */
export function replaceFile(oldPath, newPath, asset) {
  const s = store.get();
  if (newPath !== oldPath && exists(newPath)) throw new Error("Name taken");
  room(asset.size - (s.added[oldPath]?.size ?? 0));
  const added = { ...s.added };
  const removed = [...s.removed];
  if (newPath !== oldPath) {
    delete added[oldPath];
    if (s.files.some((f) => f.path === oldPath) && !removed.includes(oldPath)) removed.push(oldPath);
  }
  added[newPath] = asset;
  const content = newPath === oldPath ? s.content : rewriteRefs(s.content, oldPath, newPath);
  touch({ added, removed, content });
}

/** Removes a file. `to` = another file path to move its uses to, or null to unlink (see rewriteRefs). */
export function removeFile(path, to) {
  const s = store.get();
  const added = { ...s.added };
  const removed = [...s.removed];
  delete added[path];
  if (s.files.some((f) => f.path === path) && !removed.includes(path)) removed.push(path);
  const content = refsTo(s.content, path).length ? rewriteRefs(s.content, path, to) : s.content;
  touch({ added, removed, content });
}

/** Undo for one file: forget a new file, or bring back a removed or replaced one. */
export function resetFile(path) {
  const s = store.get();
  const added = { ...s.added };
  delete added[path];
  touch({ added, removed: s.removed.filter((p) => p !== path) });
}
