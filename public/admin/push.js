// The Push screen: what changed, a commit message, one button. The server (POST /api/admin/push) re-validates everything and makes ONE atomic commit.
// After a push the draft is cleared, the commit link is shown, and the deploy state is polled for a few minutes (best effort).
import { ApiError, api, chip, confirmDialog, draft, explain, h, icon, input, panel, textButton, toast } from "./ui.js";
import * as engine from "./draft.js";
import { summarize } from "./logic.js";

const MIN = 3, MAX = 72;
const POLL_MS = 6000, POLL_MAX = 40; // about 4 minutes
let last = null; // { sha, url, state, tries } of the latest push, kept while the page stays open so leaving the screen does not lose it

/** One line, 3-72 characters (the server cleans and checks again). */
export const messageOk = (text) => { const n = [...text.replace(/\s+/g, " ").trim()].length; return n >= MIN && n <= MAX; };
const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
/** Only a commit page on github.com is ever linked; anything else the server might say is ignored. */
function commitUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === "github.com" && /^\/[\w.-]+\/[\w.-]+\/commit\/[0-9a-f]{40}$/.test(u.pathname) ? u.href : "";
  } catch { return ""; }
}

export function pushView() {
  const state = { text: "", busy: false, errors: [], stopped: false };
  let timer = 0;

  const meta = h("div", { class: "meta" });
  const sums = h("div", { class: "meta" });
  const list = h("ul", { class: "chg" });
  const problems = h("ul", { class: "chg errs", role: "alert" });
  const empty = h("div", { class: "empty" }, icon("push", "empty-ico"), h("p", {}, "No changes"));
  const msg = input({ label: "Message", max: MAX, onInput: (v) => { state.text = v; sync(); } });
  const foot = h("div", { class: "pnl-foot" });
  const form = h("div", { class: "stack" }, sums, list, problems, msg, foot);
  const done = h("div", { class: "empty" });
  const body = h("div", { class: "stack" }, empty, form, done);

  /* ---- drawing ---- */
  function sync() {
    const s = engine.store.get();
    const changes = draft.get().changes;
    const { sum, rows } = summarize(changes, s.files.map((f) => f.path));

    meta.replaceChildren(chip("changes", { strong: changes.length }), ...(s.behind ? [chip("behind", { lead: "alert" })] : []));
    const parts = [["texts", sum.texts], ["buttons", sum.buttons], ["projects", sum.projects], ["stack", sum.stack], ["journey", sum.journey], ["site", sum.site]].filter(([, n]) => n);
    const im = sum.images;
    sums.replaceChildren(
      ...parts.map(([label, n]) => chip(label, { strong: n })),
      ...(im.added ? [chip("added", { lead: "image", strong: `+${im.added}` })] : []),
      ...(im.replaced ? [chip("replaced", { lead: "image", strong: `~${im.replaced}` })] : []),
      ...(im.removed ? [chip("removed", { lead: "image", strong: `-${im.removed}` })] : []));
    list.replaceChildren(...rows.map((c) => h("li", {}, h("i", { class: `op ${c.op}` }, c.op), h("span", {}, `${c.area} · ${c.label}`))));

    const shown = state.errors.length ? state.errors : s.errors;
    problems.replaceChildren(...shown.slice(0, 8).map((e) => h("li", {}, h("i", { class: "op removed" }, "error"), h("span", {}, e))));

    const showDone = !!last && changes.length === 0;
    empty.hidden = changes.length > 0 || showDone || s.status !== "ready";
    form.hidden = changes.length === 0;
    done.hidden = !showDone;
    if (showDone) drawDone();

    const blocked = s.errors.length > 0 || s.checking || !messageOk(state.text) || state.busy || changes.length === 0;
    foot.replaceChildren(...(s.behind
      ? [textButton("Load latest", discardAndLoad, { lead: "refresh", disabled: state.busy })]
      : [textButton(state.busy ? "Pushing" : "Push", send, { lead: state.busy ? "refresh" : "push", disabled: blocked })]));
    if (state.busy) foot.querySelector("svg")?.classList.add("spin");
    for (const el of msg.querySelectorAll("input")) el.disabled = state.busy;
  }

  function drawDone() {
    const link = last.url ? h("button", { class: "btn", type: "button", onclick: () => window.open(last.url, "_blank", "noopener,noreferrer") }, icon("github", "lead"), last.sha.slice(0, 7)) : chip(last.sha.slice(0, 7), { lead: "github" });
    const label = { pending: "Deploying", success: "Live", failure: "Deploy failed", unknown: "Deploying" }[last.state];
    const ico = last.state === "success" ? "check" : last.state === "failure" ? "alert" : "refresh";
    done.replaceChildren(
      icon("check", "empty-ico"),
      h("p", {}, "Pushed"),
      link,
      last.tries >= POLL_MAX && last.state !== "success" && last.state !== "failure" ? null : h("span", { class: "chip" }, icon(ico, last.state === "pending" || last.state === "unknown" ? "spin" : ""), label),
      textButton("Done", () => { last = null; sync(); }));
  }

  /* ---- deploy state (best effort: needs Commit statuses: read on the token, otherwise it just stays "Deploying") ---- */
  function poll() {
    clearTimeout(timer);
    if (state.stopped || !last || last.state === "success" || last.state === "failure" || last.tries >= POLL_MAX) return;
    timer = setTimeout(async () => {
      const mine = last;
      try {
        const r = await api(`/api/admin/status?sha=${mine.sha}`);
        if (last === mine) { mine.state = r.state; mine.tries++; }
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        if (last === mine) mine.tries++;
      }
      if (!state.stopped) { sync(); poll(); }
    }, POLL_MS);
  }

  /* ---- actions ---- */
  async function discardAndLoad() {
    if (!(await confirmDialog({ title: "Load latest?", text: "Your draft will be discarded.", ok: "Load latest", danger: true }))) return;
    await engine.reloadLatest();
    toast("Loaded", "ok", 2000);
  }

  async function send() {
    if (state.busy) return;
    const s = engine.store.get();
    if (s.errors.length || !messageOk(state.text) || draft.get().changes.length === 0) return;
    state.busy = true;
    state.errors = [];
    sync();
    try {
      const out = await api("/api/admin/push", { method: "POST", body: { ...engine.pushPayload(), key: newKey(), message: state.text } });
      last = { sha: String(out.sha), url: commitUrl(out.url), state: "pending", tries: 0 };
      state.text = "";
      for (const el of msg.querySelectorAll("input")) el.value = "";
      msg.querySelector(".cnt").textContent = `0/${MAX}`;
      await engine.reloadLatest(); // clears the draft; the screen shows the commit
      toast("Pushed", "ok", 2500);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { state.busy = false; return; }
      if (e instanceof ApiError && e.code === "moved") {
        state.busy = false;
        sync();
        await discardAndLoad();
        return;
      }
      if (e instanceof ApiError && e.errors?.length) state.errors = e.errors;
      toast(e instanceof ApiError && e.status === 0 ? "No connection. Check the repo before retrying" : explain(e));
    } finally {
      state.busy = false;
      sync();
      poll();
    }
  }

  return {
    bar: meta,
    el: panel({ body: [body] }),
    start() {
      this.off = [engine.store.subscribe(sync), draft.subscribe(sync)];
      msg.querySelector("input")?.focus?.({ preventScroll: true });
      sync();
      poll();
    },
    stop() { state.stopped = true; clearTimeout(timer); for (const off of this.off ?? []) off(); },
  };
}
