// Texts: every text in content.json, with its length limit. Limits match scripts/schema.mjs (the server re-checks everything).
import { h, panel } from "./ui.js";
import { store, edit } from "./draft.js";
import { richField } from "./rich.js";
import { field, live, draftBar, statusChips, EMAIL } from "./kit.js";

const GROUPS = [
  { title: "Intro", fields: [["texts.intro", "Intro word", 30], ["texts.updated", "Updated", 30]] },
  { title: "Home", fields: [["texts.home.hey", "Greeting", 40], ["texts.home.title", "Title", 80], ["texts.home.handle", "Handle", 40], ["texts.home.about", "About", 400, true]] },
  { title: "Projects", fields: [["texts.projects.hey", "Label", 40], ["texts.projects.title", "Title", 80]] },
  { title: "Skills", fields: [["texts.skills.hey", "Label", 40], ["texts.skills.title", "Title", 80]] },
  { title: "Feedback", fields: [["texts.feedback.hey", "Label", 40], ["texts.feedback.title", "Title", 80], ["texts.feedback.placeholder", "Placeholder", 80], ["texts.feedback.send", "Send", 20], ["texts.feedback.blocked", "Blocked", 20], ["texts.feedback.thanks", "Thanks", 80]] },
  { title: "Site", fields: [["site.title", "Tab title", 80], ["site.ogTitle", "Share title", 80], ["site.ogImageAlt", "Share alt", 80], ["site.email", "Email", 120]] },
];
const at = (root, path) => path.split(".").reduce((o, k) => o?.[k], root);

export function textsView() {
  const lv = live();
  const bar = draftBar();
  const status = statusChips();
  lv.add(status.sync);

  const panels = GROUPS.map((g) => panel({
    title: g.title,
    cls: "fields",
    body: g.fields.map(([path, label, max, multiline]) => (path === "texts.home.about" ? richField : field)({
      label, path, max, multiline, lv, valid: path === "site.email" ? (v) => EMAIL.test(v) : undefined,
      get: () => at(store.get().content, path) ?? "",
      orig: () => at(store.get().original, path),
      set: (v) => edit((c) => { const keys = path.split("."); const last = keys.pop(); keys.reduce((o, k) => o[k], c)[last] = v; }),
    })),
  }));

  return {
    bar: h("div", { class: "bar-end" }, status.el, bar.el),
    el: h("div", { class: "stack" }, ...panels),
    start: () => lv.start(),
    stop: () => { lv.stop(); bar.stop(); },
  };
}
