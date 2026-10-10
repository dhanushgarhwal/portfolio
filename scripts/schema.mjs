// content.json rules. Shared by the build (scripts/build.mjs) and, later, by the admin server, so a draft
// that passes here is exactly what the build accepts. No dependencies, no file or network access:
// everything the rules need from outside (icon names, which files exist) is passed in.

import { journeyDateKey, sortJourney } from "../public/admin/logic.js";

// 1 = pages, buttons, projects, stack. The optional "journey" block was added without a version bump on purpose:
// it is optional, so every content.json written for version 1 stays valid and a pushed draft still matches.
export const SCHEMA_VERSION = 1;

export const LIMITS = {
  text: 80, about: 400, label: 24, url: 300, name: 40, description: 300, handle: 40,
  buttons: 12, projects: 30, stack: 60, bytes: 200_000,
  journeyEntries: 60, journeyTitle: 60, journeyText: 280, journeyTag: 20,
};

/** Every number the Journey page accepts: [min, max, whole numbers only]. One table, read by the build, the admin editor and the page itself. */
export const JOURNEY_RANGES = {
  seed: [0, 2_147_483_647, true],
  path: {
    spacing: [160, 800, true], amplitude: [0.2, 0.9, false], curviness: [0, 1, false], jitter: [0, 1, false], width: [20, 120, true],
  },
  highlight: { speed: [0.1, 1, false] },
};
export const JOURNEY_DIRECTIONS = ["latest-top", "latest-bottom"];
export const JOURNEY_SIDES = ["auto", "left", "right"];

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const EMAIL = /^[^\s@<>"]{1,64}@[A-Za-z0-9.-]{1,200}\.[A-Za-z]{2,24}$/;
const IMAGE_PATH = /^\/(image|skill)\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(png|webp|jpe?g|gif|avif|svg)$/;
const CDN_HOST = "cdn.jsdelivr.net";
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const KINDS = ["image", "sprite", "text"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Accepts https:, mailto:, tel: and site-relative paths. Returns an error string, or "" when fine. */
export function checkUrl(value, { relative = true } = {}) {
  if (typeof value !== "string" || !value) return "is empty";
  if (value.length > LIMITS.url) return `is longer than ${LIMITS.url} characters`;
  if (CONTROL.test(value) || /\s/.test(value)) return "has spaces or control characters";
  if (value.startsWith("/")) {
    if (!relative) return "must start with https://";
    return value.startsWith("//") || value.includes("\\") || value.split("/").includes("..") ? "is not a safe path" : "";
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  if (scheme === "mailto") {
    const address = value.slice(7).split("?")[0];
    return address ? (EMAIL.test(address) ? "" : "is not a valid email address") : "is empty";
  }
  if (scheme === "tel") return value.length > scheme.length + 1 ? "" : "is empty";
  if (scheme !== "https") return "must start with https://";
  try {
    const u = new URL(value);
    if (u.username || u.password) return "must not contain a login";
    if (!u.hostname.includes(".")) return "has no valid host";
  } catch {
    return "is not a valid link";
  }
  return "";
}

/** Splits the about text into plain / highlight / link parts. [[text]] highlights, [[text|https://...]] links. */
export function parseAbout(source) {
  const parts = [];
  let rest = source;
  for (;;) {
    const open = rest.indexOf("[[");
    if (open < 0) break;
    const close = rest.indexOf("]]", open + 2);
    if (close < 0) throw new Error("a [[ is never closed");
    if (open) parts.push({ text: rest.slice(0, open) });
    const inner = rest.slice(open + 2, close);
    if (inner.includes("[[")) throw new Error("[[ inside [[ is not allowed");
    const bar = inner.indexOf("|");
    const text = bar < 0 ? inner : inner.slice(0, bar);
    const url = bar < 0 ? null : inner.slice(bar + 1);
    if (!text.trim()) throw new Error("a highlight is empty");
    if (url !== null) {
      const problem = checkUrl(url, { relative: false });
      if (problem) throw new Error(`link "${text}" ${problem}`);
    }
    parts.push({ hi: text, url });
    rest = rest.slice(close + 2);
  }
  if (rest.includes("]]")) throw new Error("a ]] has no [[");
  if (rest) parts.push({ text: rest });
  return parts;
}


// The date key and the display order are shared with the admin page (one implementation, public/admin/logic.js), so both always agree.
export { journeyDateKey, sortJourney };

/** The newest visible entry: the one the page opens on. Same date -> the one later in the list. Undefined when nothing is visible. */
export function latestJourney(entries) {
  let best, bestKey = "";
  for (const e of entries) {
    if (e?.visible === false) continue;
    const k = journeyDateKey(e?.date);
    if (k && k >= bestKey) { best = e; bestKey = k; }
  }
  return best;
}

/**
 * @param {unknown} content parsed content.json
 * @param {{ icons: string[], fileExists: (publicPath: string) => boolean }} env
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateContent(content, env) {
  const errors = [];
  const warnings = [];
  const err = (path, msg) => errors.push(`${path}: ${msg}`);

  const keys = (obj, path, required, optional = []) => {
    if (!isObj(obj)) { err(path, "must be an object"); return false; }
    for (const k of required) if (!(k in obj)) err(path, `"${k}" is missing`);
    for (const k of Object.keys(obj)) if (!required.includes(k) && !optional.includes(k)) err(path, `unknown key "${k}"`);
    return true;
  };
  const str = (v, path, max, { min = 1 } = {}) => {
    if (typeof v !== "string") { err(path, "must be text"); return false; }
    if (v.trim().length < min) { err(path, "is empty"); return false; }
    if (v.length > max) { err(path, `is longer than ${max} characters`); return false; }
    if (CONTROL.test(v)) { err(path, "has control characters or line breaks"); return false; }
    if (v !== v.trim()) { err(path, "has spaces at the start or end"); return false; }
    return true;
  };
  const url = (v, path, opts) => { const p = checkUrl(v, opts); if (p) err(path, `link ${p}`); };
  const bool = (v, path) => { if (typeof v !== "boolean") err(path, "must be true or false"); };
  const icon = (v, path) => { if (typeof v !== "string" || !env.icons.includes(v)) err(path, `unknown icon "${v}"`); };
  const id = (v, path, seen) => {
    if (typeof v !== "string" || !ID.test(v)) return err(path, "id must be 1-40 lowercase letters, digits or dashes");
    if (seen.has(v)) return err(path, `id "${v}" is used twice`);
    seen.add(v);
  };
  const image = (v, path, { fallback = false } = {}) => {
    if (typeof v !== "string" || !IMAGE_PATH.test(v)) return err(path, "must be a file inside /image or /skill (png, webp, jpg, gif, avif, svg)");
    if (!env.fileExists(v)) {
      if (fallback) warnings.push(`${path}: ${v} not found, the page will use its CDN copy`);
      else err(path, `file ${v} does not exist`);
    }
  };
  const size = (v, path) => { if (!Number.isInteger(v) || v < 1 || v > 10000) err(path, "must be a whole number from 1 to 10000"); };

  if (!isObj(content)) return { errors: ["content.json must be an object"], warnings };
  if (JSON.stringify(content).length > LIMITS.bytes) err("content.json", `is bigger than ${LIMITS.bytes} bytes`);
  if (!keys(content, "content", ["schemaVersion", "site", "images", "texts", "buttons", "projects", "stack"], ["journey"])) return { errors, warnings };
  if (content.schemaVersion !== SCHEMA_VERSION) err("schemaVersion", `must be ${SCHEMA_VERSION}`);

  // site
  const s = content.site;
  if (keys(s, "site", ["url", "title", "ogTitle", "ogImageAlt", "email", "discordId"])) {
    if (typeof s.url !== "string" || !/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(:\d+)?$/i.test(s.url) || s.url.length > LIMITS.url) err("site.url", "must be an https address with no path and no trailing slash");
    str(s.title, "site.title", LIMITS.text);
    str(s.ogTitle, "site.ogTitle", LIMITS.text);
    str(s.ogImageAlt, "site.ogImageAlt", LIMITS.text);
    if (typeof s.email !== "string" || !EMAIL.test(s.email)) err("site.email", "is not a valid address");
    if (typeof s.discordId !== "string" || !/^\d{5,25}$/.test(s.discordId)) err("site.discordId", "must be 5-25 digits");
  }

  // images
  if (keys(content.images, "images", ["favicon", "faviconSmall", "og"])) {
    for (const k of ["favicon", "faviconSmall", "og"]) image(content.images[k], `images.${k}`);
  }

  // texts
  const t = content.texts;
  if (keys(t, "texts", ["intro", "updated", "home", "projects", "skills", "feedback"])) {
    str(t.intro, "texts.intro", 30);
    str(t.updated, "texts.updated", 30);
    if (keys(t.home, "texts.home", ["hey", "title", "handle", "about"])) {
      str(t.home.hey, "texts.home.hey", 40);
      str(t.home.title, "texts.home.title", LIMITS.text);
      str(t.home.handle, "texts.home.handle", LIMITS.handle);
      if (str(t.home.about, "texts.home.about", LIMITS.about)) {
        try { parseAbout(t.home.about); } catch (e) { err("texts.home.about", e.message); }
      }
    }
    if (keys(t.feedback, "texts.feedback", ["hey", "title", "placeholder", "send", "blocked", "thanks"])) {
      str(t.feedback.hey, "texts.feedback.hey", 40);
      str(t.feedback.title, "texts.feedback.title", LIMITS.text);
      str(t.feedback.placeholder, "texts.feedback.placeholder", LIMITS.text);
      str(t.feedback.send, "texts.feedback.send", 20);
      str(t.feedback.blocked, "texts.feedback.blocked", 20);
      str(t.feedback.thanks, "texts.feedback.thanks", LIMITS.text);
    }
    for (const page of ["projects", "skills"]) {
      if (keys(t[page], `texts.${page}`, ["hey", "title"])) {
        str(t[page].hey, `texts.${page}.hey`, 40);
        str(t[page].title, `texts.${page}.title`, LIMITS.text);
      }
    }
  }

  // buttons
  if (!Array.isArray(content.buttons)) err("buttons", "must be a list");
  else {
    if (content.buttons.length > LIMITS.buttons) err("buttons", `at most ${LIMITS.buttons} buttons`);
    const seen = new Set();
    content.buttons.forEach((b, i) => {
      const p = `buttons[${i}]`;
      if (!keys(b, p, ["id", "label", "icon", "visible"], ["url", "type"])) return;
      id(b.id, `${p}.id`, seen);
      str(b.label, `${p}.label`, LIMITS.label);
      icon(b.icon, `${p}.icon`);
      bool(b.visible, `${p}.visible`);
      if (b.type !== undefined && b.type !== "mail") err(`${p}.type`, 'can only be "mail"');
      if (b.type === "mail") { if ("url" in b) err(`${p}.url`, "an email button takes its address from site.email"); }
      else if (!("url" in b)) err(`${p}.url`, "is missing");
      else url(b.url, `${p}.url`);
    });
  }

  // projects
  if (!Array.isArray(content.projects)) err("projects", "must be a list");
  else {
    if (content.projects.length > LIMITS.projects) err("projects", `at most ${LIMITS.projects} projects`);
    if (!content.projects.some((x) => x?.visible === true)) err("projects", "needs at least one visible project");
    const seen = new Set();
    content.projects.forEach((x, i) => {
      const p = `projects[${i}]`;
      if (!keys(x, p, ["id", "name", "description", "image", "imageWidth", "imageHeight", "url", "icon", "visible"], ["button"])) return;
      id(x.id, `${p}.id`, seen);
      str(x.name, `${p}.name`, LIMITS.name);
      str(x.description, `${p}.description`, LIMITS.description);
      image(x.image, `${p}.image`);
      size(x.imageWidth, `${p}.imageWidth`);
      size(x.imageHeight, `${p}.imageHeight`);
      url(x.url, `${p}.url`);
      image(x.icon, `${p}.icon`);
      bool(x.visible, `${p}.visible`);
      if (x.button !== undefined && x.button !== null && keys(x.button, `${p}.button`, ["label", "icon", "url"])) {
        str(x.button.label, `${p}.button.label`, LIMITS.label);
        icon(x.button.icon, `${p}.button.icon`);
        url(x.button.url, `${p}.button.url`);
      }
    });
  }

  // stack
  if (!Array.isArray(content.stack)) err("stack", "must be a list");
  else {
    if (content.stack.length > LIMITS.stack) err("stack", `at most ${LIMITS.stack} items`);
    if (!content.stack.some((x) => x?.visible === true)) err("stack", "needs at least one visible item");
    const seen = new Set();
    content.stack.forEach((x, i) => {
      const p = `stack[${i}]`;
      if (!keys(x, p, ["id", "name", "color", "art", "visible"])) return;
      id(x.id, `${p}.id`, seen);
      str(x.name, `${p}.name`, 30);
      if (typeof x.color !== "string" || !HEX.test(x.color)) err(`${p}.color`, "must look like #a1b2c3");
      bool(x.visible, `${p}.visible`);
      const a = x.art;
      if (!isObj(a) || !KINDS.includes(a.kind)) return err(`${p}.art.kind`, `must be one of ${KINDS.join(", ")}`);
      const letter = (v) => str(v, `${p}.art.letter`, 3);
      if (a.kind === "image") {
        keys(a, `${p}.art`, ["kind", "letter", "src"], ["cdn"]);
        letter(a.letter);
        const hasCdn = a.cdn !== undefined;
        image(a.src, `${p}.art.src`, { fallback: hasCdn });
        if (hasCdn) {
          try {
            const u = new URL(a.cdn);
            if (u.protocol !== "https:" || u.hostname !== CDN_HOST || checkUrl(a.cdn, { relative: false })) throw 0;
          } catch { err(`${p}.art.cdn`, `must be an https://${CDN_HOST}/ link`); }
        }
      } else if (a.kind === "sprite") {
        keys(a, `${p}.art`, ["kind", "icon"]);
        icon(a.icon, `${p}.art.icon`);
      } else {
        keys(a, `${p}.art`, ["kind", "letter"]);
        letter(a.letter);
      }
    });
  }

  // journey (optional: no key = no Journey page)
  if (content.journey !== undefined) {
    const j = content.journey;
    // "clouds" was an earlier experiment: a leftover block in an old content.json is accepted and ignored, never drawn
    if (keys(j, "journey", ["enabled", "title", "subtitle", "direction", "startLabel", "endLabel", "seed", "path", "highlight", "entries"], ["clouds"])) {
      const num = (v, path, [min, max, whole]) => {
        if (typeof v !== "number" || !Number.isFinite(v)) return err(path, "must be a number");
        if (whole && !Number.isInteger(v)) return err(path, "must be a whole number");
        if (v < min || v > max) err(path, `must be from ${min} to ${max}`);
      };
      const R = JOURNEY_RANGES;
      bool(j.enabled, "journey.enabled");
      str(j.title, "journey.title", LIMITS.text);
      str(j.subtitle, "journey.subtitle", 40);
      if (!JOURNEY_DIRECTIONS.includes(j.direction)) err("journey.direction", `must be one of ${JOURNEY_DIRECTIONS.join(", ")}`);
      str(j.startLabel, "journey.startLabel", LIMITS.label);
      str(j.endLabel, "journey.endLabel", LIMITS.label);
      num(j.seed, "journey.seed", R.seed);
      if (keys(j.path, "journey.path", Object.keys(R.path))) for (const k of Object.keys(R.path)) num(j.path[k], `journey.path.${k}`, R.path[k]);
      if (keys(j.highlight, "journey.highlight", ["breathing", "speed", "color"])) {
        bool(j.highlight.breathing, "journey.highlight.breathing");
        num(j.highlight.speed, "journey.highlight.speed", R.highlight.speed);
        if (typeof j.highlight.color !== "string" || !HEX.test(j.highlight.color)) err("journey.highlight.color", "must look like #a1b2c3");
      }
      if (!Array.isArray(j.entries)) err("journey.entries", "must be a list");
      else {
        if (j.entries.length > LIMITS.journeyEntries) err("journey.entries", `at most ${LIMITS.journeyEntries} entries`);
        const seen = new Set();
        j.entries.forEach((x, i) => {
          const p = `journey.entries[${i}]`;
          if (!keys(x, p, ["id", "date", "title", "text", "tag", "icon", "visible", "pinned", "side"], ["image", "link"])) return;
          id(x.id, `${p}.id`, seen);
          if (typeof x.date !== "string" || !journeyDateKey(x.date)) err(`${p}.date`, "must be a real date like 2024, 2024-05 or 2024-05-17");
          str(x.title, `${p}.title`, LIMITS.journeyTitle);
          if (str(x.text, `${p}.text`, LIMITS.journeyText)) {
            try { parseAbout(x.text); } catch (e) { err(`${p}.text`, e.message); }
          }
          str(x.tag, `${p}.tag`, LIMITS.journeyTag);
          icon(x.icon, `${p}.icon`);
          bool(x.visible, `${p}.visible`);
          bool(x.pinned, `${p}.pinned`);
          if (!JOURNEY_SIDES.includes(x.side)) err(`${p}.side`, `must be one of ${JOURNEY_SIDES.join(", ")}`);
          if (x.image !== undefined) image(x.image, `${p}.image`);
          if (x.link !== undefined && keys(x.link, `${p}.link`, ["label", "url"])) {
            str(x.link.label, `${p}.link.label`, LIMITS.label);
            url(x.link.url, `${p}.link.url`);
          }
        });
      }
    }
  }

  return { errors, warnings };
}
