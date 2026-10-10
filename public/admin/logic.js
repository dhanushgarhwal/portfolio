// Pure helpers for the editors: no DOM, no network, so they run in the browser and in `npm test`.

export const LIMITS = { url: 300, dim: 2000, bytes: 500_000, source: 10_000_000, total: 3_000_000, files: 24, svg: 40_000 };

/* ---- links and e-mail: the same rules as scripts/schema.mjs, so the editor can judge a value the moment it is typed ---- */
export const EMAIL = /^[^\s@<>"]{1,64}@[A-Za-z0-9.-]{1,200}\.[A-Za-z]{2,24}$/;
/** Returns "" when a web link (already carrying https://) is fine, otherwise a short reason. */
export function webProblem(value) {
  if (!value || value.length > LIMITS.url) return "bad length";
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return "spaces";
  if (!/^https:\/\//i.test(value)) return "scheme";
  try {
    const u = new URL(value);
    if (u.username || u.password) return "login";
    if (!u.hostname.includes(".")) return "host";
  } catch { return "invalid"; }
  return "";
}

/* ---- order ---- */
/** Returns a copy of `list` where the item `fromId` now sits where the item `toId` was. Unknown ids or the same id: the list unchanged. */
export function moveItem(list, fromId, toId) {
  const next = [...list];
  const i = next.findIndex((x) => x.id === fromId), j = next.findIndex((x) => x.id === toId);
  if (i < 0 || j < 0 || i === j) return next;
  const [item] = next.splice(i, 1);
  next.splice(j, 0, item);
  return next;
}

/* ---- names ---- */
export const slug = (text, max = 30) => String(text).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");
export const safeName = (filename) => slug(String(filename).replace(/\.[^.]*$/, ""), 40) || "image";
export function uniqueId(list, prefix) {
  const used = new Set(list.map((x) => x.id));
  for (;;) {
    const id = `${prefix}-${Math.random().toString(36).slice(2, 6)}`;
    if (!used.has(id)) return id;
  }
}

/* ---- real file type by magic bytes (the file name and the browser's type are never trusted) ---- */
const eq = (b, at, s) => [...s].every((c, i) => b[at + i] === c.charCodeAt(0));
export function sniff(bytes) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && eq(b, 1, "PNG") && b[4] === 0x0d && b[5] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 6 && (eq(b, 0, "GIF87a") || eq(b, 0, "GIF89a"))) return "gif";
  if (b.length >= 12 && eq(b, 0, "RIFF") && eq(b, 8, "WEBP")) return "webp";
  if (b.length >= 12 && eq(b, 4, "ftyp") && (eq(b, 8, "avif") || eq(b, 8, "avis"))) return "avif";
  const head = new TextDecoder().decode(b.slice(0, 400)).replace(/^\uFEFF/, "").trimStart();
  if (/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)?<svg[\s>]/i.test(head)) return "svg";
  return null;
}

/* ---- where the content points at a file ---- */
/** [{ path, required }] : every place content.json uses `file`. required = it cannot simply be emptied. */
export function refsTo(content, file) {
  const refs = [];
  for (const k of ["favicon", "faviconSmall", "og"]) if (content.images?.[k] === file) refs.push({ path: `images.${k}`, label: `Site ${k}`, required: true });
  content.projects?.forEach((p, i) => {
    if (p.image === file) refs.push({ path: `projects[${i}].image`, label: `${p.name} image`, required: true });
    if (p.icon === file) refs.push({ path: `projects[${i}].icon`, label: `${p.name} icon`, required: true });
  });
  content.stack?.forEach((s, i) => { if (s.art?.kind === "image" && s.art.src === file) refs.push({ path: `stack[${i}].art.src`, label: s.name, required: false }); });
  content.journey?.entries?.forEach((e, i) => { if (e.image === file) refs.push({ path: `journey.entries[${i}].image`, label: `${e.title || e.id} picture`, required: false }); });
  return refs;
}
/** Points every use of `from` at `to`. to === null unlinks (only allowed where nothing is required; an image tile falls back to its letter). */
export function rewriteRefs(content, from, to) {
  const next = structuredClone(content);
  for (const k of ["favicon", "faviconSmall", "og"]) if (next.images[k] === from) { if (to === null) throw new Error("required"); next.images[k] = to; }
  for (const p of next.projects) for (const k of ["image", "icon"]) if (p[k] === from) { if (to === null) throw new Error("required"); p[k] = to; }
  for (const s of next.stack) {
    if (s.art?.kind === "image" && s.art.src === from) {
      if (to === null) s.art = { kind: "text", letter: s.art.letter };
      else { s.art.src = to; delete s.art.cdn; } // the CDN copy belonged to the old picture
    }
  }
  for (const e of next.journey?.entries ?? []) if (e.image === from) { if (to === null) delete e.image; else e.image = to; } // a milestone picture is optional: unlinking simply removes it
  return next;
}

/* ---- Journey: the page's own limits (mirrored from scripts/schema.mjs, which the admin page cannot import; test-editors.mjs checks both stay equal) and the date helpers scripts/schema.mjs imports from here ---- */
export const JOURNEY = {
  entries: 60, title: 60, text: 280, tag: 20, subtitle: 40, label: 24, heading: 80,
  ranges: {
    seed: [0, 2_147_483_647, true],
    path: { spacing: [160, 800, true], amplitude: [0.2, 0.9, false], curviness: [0, 1, false], jitter: [0, 1, false], width: [20, 120, true] },
    highlight: { speed: [0.1, 1, false] },
  },
  directions: [["latest-top", "Newest first"], ["latest-bottom", "Oldest first"]],
  sides: [["auto", "Auto"], ["left", "Left"], ["right", "Right"]],
  // what a new Journey (and each group's "Reset to defaults") starts from: the values the page itself falls back to
  defaults: {
    head: { title: "journey", subtitle: "the road so far", direction: "latest-top", startLabel: "the start", endLabel: "i am here" },
    path: { spacing: 340, amplitude: 0.62, curviness: 0.55, jitter: 0.35, width: 46 },
    highlight: { breathing: true, speed: 0.5, color: "#c1c5ce" },
  },
};
const DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
/** A sortable "YYYY-MM-DD" for "YYYY", "YYYY-MM" or "YYYY-MM-DD" (real days only, 1900-2100; missing parts are 00), or "" when the date is not valid. */
export function journeyDateKey(value) {
  const m = typeof value === "string" ? DATE.exec(value) : null;
  if (!m) return "";
  const y = +m[1], mo = m[2] === undefined ? 0 : +m[2], d = m[3] === undefined ? 0 : +m[3];
  if (y < 1900 || y > 2100 || mo > 12 || (m[2] !== undefined && mo < 1)) return "";
  if (m[3] !== undefined && (d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate())) return "";
  return `${m[1]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
/** Entries in the order the page shows them (stable; invalid dates last). Never changes the input. */
export function sortJourney(entries, direction = "latest-top") {
  const sign = direction === "latest-bottom" ? 1 : -1;
  return entries.map((e, i) => ({ e, i, k: journeyDateKey(e?.date) }))
    .sort((a, b) => (!a.k || !b.k ? (a.k ? -1 : b.k ? 1 : 0) : a.k === b.k ? 0 : (a.k < b.k ? -1 : 1) * sign) || a.i - b.i)
    .map((x) => x.e);
}
/** Ids whose date is shared with another entry (same day, month or year as written). */
export function sameDates(entries) {
  const seen = new Map();
  for (const e of entries) { const k = e.date; if (journeyDateKey(k)) seen.set(k, (seen.get(k) ?? 0) + 1); }
  return new Set(entries.filter((e) => (seen.get(e.date) ?? 0) > 1).map((e) => e.id));
}
/** A fresh seed for the road: a whole number the schema accepts. `rand` returns [0, 1). */
export const randomSeed = (rand = Math.random) => Math.min(JOURNEY.ranges.seed[1], Math.floor(rand() * (JOURNEY.ranges.seed[1] + 1)));
/** Clamps a number into [min, max] (whole numbers rounded). Anything that is not a finite number gives the fallback. */
export function clampTo(value, [min, max, whole], fallback = min) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const c = Math.min(max, Math.max(min, n));
  return whole ? Math.round(c) : Math.round(c * 1000) / 1000;
}
/** The list at a dotted path of the draft: "projects", or "journey.entries". Undefined when it is not there. */
export const listAt = (content, area) => area.split(".").reduce((o, k) => o?.[k], content);
/** The block a brand-new Journey starts as: header, road and highlight defaults, no entries yet. */
export const newJourney = () => ({ enabled: true, ...structuredClone(JOURNEY.defaults.head), seed: randomSeed(), path: { ...JOURNEY.defaults.path }, highlight: { ...JOURNEY.defaults.highlight }, entries: [] });

/* ---- what changed (labels for the unsaved list and the Push screen) ---- */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function leaves(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) leaves(v, `${prefix}${k}.`, out);
    else out[`${prefix}${k}`] = v;
  }
  return out;
}
/** The Journey block: settings are compared leaf by leaf, entries by id (their order is the date, so there is no "moved"). A block that appears or goes away is one change. */
function journeyChanges(before, after, out) {
  if (!before && !after) return;
  if (!before || !after) { out.push({ area: "journey", op: after ? "added" : "removed", id: "journey", label: "journey" }); return; }
  const a = leaves({ ...before, entries: undefined }), b = leaves({ ...after, entries: undefined });
  for (const k of Object.keys({ ...a, ...b })) if (k !== "entries" && a[k] !== b[k]) out.push({ area: "journey", op: "edited", id: k, label: `journey.${k}` });
  const was = new Map(before.entries.map((x) => [x.id, x])), now = new Map(after.entries.map((x) => [x.id, x]));
  for (const [id, x] of now) {
    if (!was.has(id)) out.push({ area: "journey", op: "added", id, label: x.title || id });
    else if (!same(was.get(id), x)) out.push({ area: "journey", op: "edited", id, label: x.title || id });
  }
  for (const [id, x] of was) if (!now.has(id)) out.push({ area: "journey", op: "removed", id, label: x.title || id });
}
export function changesOf(original, current, { added = [], removed = [] } = {}) {
  const out = [];
  const a = leaves(original.texts), b = leaves(current.texts);
  for (const k of Object.keys(b)) if (a[k] !== b[k]) out.push({ area: "texts", op: "edited", id: k, label: k });
  const sa = leaves(original.site), sb = leaves(current.site);
  for (const k of Object.keys(sb)) if (sa[k] !== sb[k]) out.push({ area: "site", op: "edited", id: k, label: `site.${k}` });
  const ia = leaves(original.images), ib = leaves(current.images);
  for (const k of Object.keys(ib)) if (ia[k] !== ib[k]) out.push({ area: "images", op: "edited", id: k, label: `images.${k}` });
  for (const area of ["buttons", "projects", "stack"]) {
    const before = new Map(original[area].map((x) => [x.id, x])), after = new Map(current[area].map((x) => [x.id, x]));
    for (const [id, x] of after) {
      const label = x.label ?? x.name ?? id;
      if (!before.has(id)) out.push({ area, op: "added", id, label });
      else if (!same(before.get(id), x)) out.push({ area, op: "edited", id, label });
    }
    for (const [id, x] of before) if (!after.has(id)) out.push({ area, op: "removed", id, label: x.label ?? x.name ?? id });
    // the order of the items both sides still have (adding or removing one is not a move)
    const keptBefore = original[area].map((x) => x.id).filter((id) => after.has(id));
    const keptAfter = current[area].map((x) => x.id).filter((id) => before.has(id));
    if (!same(keptBefore, keptAfter)) out.push({ area, op: "moved", id: "order", label: "order" });
  }
  journeyChanges(original.journey, current.journey, out);
  for (const p of added) out.push({ area: "files", op: "added", id: p, label: p });
  for (const p of removed) out.push({ area: "files", op: "removed", id: p, label: p });
  return out;
}

/** Validator messages look like "projects[0].url: link must start with https://". Returns the ones under `prefix`. */
export const errorsAt = (errors, prefix) => errors.filter((e) => e.startsWith(`${prefix}:`) || e.startsWith(`${prefix}.`) || e.startsWith(`${prefix}[`)).map((e) => e.slice(e.indexOf(": ") + 2));

/** Counts for the Push screen. A file that is added over one the repo already has is a "replace". */
export function summarize(changes, existing = []) {
  const sum = { texts: 0, buttons: 0, projects: 0, stack: 0, journey: 0, site: 0, images: { added: 0, replaced: 0, removed: 0 } };
  const rows = changes.map((c) => {
    if (c.area === "files") {
      const op = c.op === "added" && existing.includes(c.id) ? "replaced" : c.op;
      sum.images[op]++;
      return { ...c, op };
    }
    sum[c.area === "images" ? "site" : c.area]++;
    return c;
  });
  return { sum, rows };
}
