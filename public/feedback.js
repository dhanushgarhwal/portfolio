"use strict";
// Feedback section of the main page: stars, message, spam checks, send. Nothing is ever shown back from the server except "sent" or a short error.
// It starts the first time the section is opened (script.js adds the class "on" to it), so visitors who never open it cost nothing.
//
// The form is in one of four modes:
//   loading  asking the server what this visitor may do
//   open     the normal form
//   sent     this browser already sent feedback in the last 24 h: "thank you" replaces the form (same box size)
//   blocked  this device already used its 3 feedbacks: the form is locked and the button says "limit reached" for 24 h
// The server decides (cookie for "sent", device record for "blocked"); localStorage only saves a round trip and a flash on a revisit.
(() => {
const view = document.querySelector('[data-page="feedback"]');
if (!view) return;
// Admin preview (<html data-preview>): the same page as a mockup. No request, nothing stored in the browser, no limit, no waiting.
// "send" shows the thank-you, and opening the preview again starts from the normal form because nothing was remembered.
const PREVIEW = document.documentElement.hasAttribute("data-preview");

const $ = (sel) => view.querySelector(sel);
const stars = [...view.querySelectorAll(".fb-star")];
const card = $("#fb"), area = $("#fbText"), msg = $("#fbMsg"), send = $("#fbSend"), count = $("#fbCount");
const ph = $("#fbPh"), field = ph.parentElement, trap = $("#fbHp"), body = $("#fbBody"), done = $("#fbDone"), starBox = $("#fbStars");
const HINT = ph.dataset.text;
const SEND_TEXT = send.dataset.send, BLOCKED_TEXT = send.dataset.blocked;
const MIN_FILL_MS = 3200;                 // the server refuses anything faster than 3 s after the form token was issued
const TOKEN_MAX_AGE_MS = 100 * 60 * 1000; // the server refuses form tokens older than 2 h; ask for a fresh one a little earlier
const DAY_MS = 24 * 60 * 60 * 1000;
const SENT_KEY = "fb-sent", BLOCK_KEY = "fb-blocked";

const wait = (seconds) => {
  const h = Math.ceil(seconds / 3600);
  return h <= 1 ? "in about an hour" : `in about ${h} hours`;
};
const TEXT = {
  rate: "pick a rating",
  fast: "one moment, then try again",
  closed: "not available right now",
  failed: "could not send, try again",
  network: "no connection, try again",
  blocked: (seconds) => `you can send again ${wait(seconds)}`,
};

let rating = 0, formToken = "", tokenAt = 0, readyAt = Infinity, busy = false, started = false, loading = false;
let mode = "loading", sentAt = 0, blockedUntil = 0;

const sync = () => field.classList.toggle("filled", area.value.length > 0); // the hint is its own element, shown only while the box is empty
const say = (text, isError = false) => { msg.textContent = text; msg.classList.toggle("err", isError); };
const refresh = () => { send.disabled = mode !== "open" || busy || !rating || !formToken || Date.now() < readyAt; };

/* ---- "sent" reminder in this browser (the server's cookie is the real one) ---- */
const remember = () => { if (PREVIEW) return; try { localStorage.setItem(SENT_KEY, String(Date.now())); } catch { /* storage blocked: the cookie still works */ } };
const forget = () => { if (PREVIEW) return; try { localStorage.removeItem(SENT_KEY); } catch { /* nothing to do */ } };
function remembered() {
  if (PREVIEW) return 0;
  try {
    const at = Number(localStorage.getItem(SENT_KEY));
    const age = Date.now() - at;
    if (at > 0 && age >= -60000 && age < DAY_MS) return at;
    if (at) forget();
  } catch { /* storage blocked */ }
  return 0;
}

/* ---- "blocked" reminder: the time the block ends, kept in this browser so a new tab knows at once, before any request (the server stays the real judge) ---- */
const rememberBlock = (until) => { if (PREVIEW) return; try { localStorage.setItem(BLOCK_KEY, String(until)); } catch { /* storage blocked: the server still answers */ } };
const forgetBlock = () => { if (PREVIEW) return; try { localStorage.removeItem(BLOCK_KEY); } catch { /* nothing to do */ } };
function blockedLeft() {
  if (PREVIEW) return 0;
  try {
    const until = Number(localStorage.getItem(BLOCK_KEY));
    const left = until - Date.now();
    if (until > 0 && left > 0 && left <= DAY_MS + 60000) return Math.ceil(left / 1000);
    if (until) forgetBlock();
  } catch { /* storage blocked */ }
  return 0;
}

/* ---- modes ---- */
function setMode(next, retry = 0) {
  mode = next;
  const sent = next === "sent", blocked = next === "blocked";
  card.classList.toggle("is-sent", sent);
  body.inert = sent;
  done.inert = !sent;
  done.setAttribute("aria-hidden", String(!sent));
  const loadingNow = next === "loading"; // until the answer is known the form is dimmed and cannot be used, so it never shows as open and then flips
  body.classList.toggle("locked", blocked);
  body.classList.toggle("loading", loadingNow);
  area.disabled = blocked || loadingNow;
  area.inert = blocked || loadingNow; // no focus, no caret, no selection, not even by Ctrl+A
  stars.forEach((s) => { s.disabled = blocked || loadingNow; });
  send.textContent = blocked ? BLOCKED_TEXT : SEND_TEXT;
  blockedUntil = blocked ? Date.now() + Math.max(1, retry) * 1000 : 0;
  if (blocked) rememberBlock(blockedUntil); else if (!loadingNow) forgetBlock();
  // blocked: the wait time takes the place of the hint inside the message box (the box is empty, so the hint is visible)
  const hint = blocked ? TEXT.blocked(retry) : HINT;
  if (blocked) { area.value = ""; count.hidden = true; say(""); sync(); }
  ph.textContent = hint;
  area.setAttribute("aria-label", hint);
  refresh();
}

/* ---- stars: a radio group, mouse preview, arrow keys; the colour follows the number ---- */
const paint = (n) => {
  starBox.dataset.level = String(n);
  stars.forEach((s, i) => s.classList.toggle("on", i < n));
};
function choose(n) {
  rating = n;
  stars.forEach((s, i) => { s.setAttribute("aria-checked", String(i + 1 === n)); s.tabIndex = i + 1 === n || (!n && i === 0) ? 0 : -1; });
  paint(n);
  say("");
  refresh();
}
stars.forEach((s, i) => {
  s.addEventListener("click", () => choose(i + 1));
  s.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse" && !s.disabled) paint(i + 1); });
  s.addEventListener("pointerleave", () => paint(rating));
  s.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const n = Math.min(5, Math.max(1, (rating || i + 1) + step));
    choose(n);
    stars[n - 1].focus();
  });
});
starBox.addEventListener("pointerleave", () => paint(rating));

/* ---- no right-click menu in the form (not the browser's, not the site's); typing, selecting and Ctrl+V still work ---- */
body.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); });

/* ---- message counter: only shown near the limit ---- */
area.addEventListener("input", () => {
  sync();
  const n = area.value.length;
  count.hidden = n < 800;
  count.textContent = `${n}/1000`;
});

/* ---- what may this visitor do? one request: the state, and a signed form token when open ---- */
async function load() {
  if (loading) return;
  if (PREVIEW) { formToken = "preview"; tokenAt = Date.now(); readyAt = 0; setMode("open"); return; } // mockup: always the open form
  loading = true;
  formToken = "";
  refresh();
  try {
    const res = await fetch("/api/feedback", { cache: "no-store", credentials: "same-origin" });
    if (res.status === 501) { say(TEXT.closed, true); return; }
    if (!res.ok) throw 0;
    const data = await res.json();
    if (data.state === "sent") { sentAt = Date.now(); setMode("sent"); return; }
    if (data.state === "blocked") { setMode("blocked", data.retry); return; }
    formToken = data.form;
    tokenAt = Date.now();
    readyAt = tokenAt + MIN_FILL_MS;
    setMode("open");
    setTimeout(refresh, MIN_FILL_MS + 50);
  } catch {
    if (mode === "loading") say(TEXT.network, true); // a remembered block or sent state stays as it is
  } finally {
    loading = false;
  }
}

/* ---- send ---- */
card.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (send.disabled) return;
  if (PREVIEW) { // mockup: nothing is sent or stored; it only shows the thank-you
    sentAt = Date.now();
    area.value = ""; sync(); count.hidden = true; choose(0);
    setMode("sent");
    return;
  }
  busy = true; refresh(); say("");
  let res = null, data = {};
  try {
    res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ rating, message: area.value, form: formToken, hp: trap.value }),
    });
    if (!res.ok) data = await res.json().catch(() => ({}));
  } catch { /* no connection */ }
  busy = false;

  if (res?.ok) {
    sentAt = Date.now();
    remember();
    area.value = ""; sync(); count.hidden = true; choose(0); // a clean form if it ever comes back after 24 h
    setMode("sent");
    return;
  }
  const code = res ? data.error ?? "failed" : "network";
  if (code === "sent") { sentAt = Date.now(); remember(); setMode("sent"); return; }  // this browser already sent today
  if (code === "limit") { setMode("blocked", data.retry); return; }                    // the device used its 3 places (maybe from another browser)
  if (code === "expired") load();
  else if (code === "fast") readyAt = Date.now() + MIN_FILL_MS;
  say(TEXT[code === "expired" ? "fast" : code] ?? TEXT.failed, true);
  refresh();
});

choose(0);
{ // first paint: a block remembered from an earlier visit shows at once; otherwise the form waits, dimmed, for the server's answer
  const left = blockedLeft();
  if (left) setMode("blocked", left); else setMode("loading");
}

/* ---- starts when the section is first opened (or a moment earlier, when its button is pointed at or touched);
   later visits only re-check what can have run out meanwhile ---- */
function start() {
  if (started) return;
  started = true;
  const at = remembered();
  if (at) { sentAt = at; setMode("sent"); return; } // sent earlier today: no request at all
  load(); // a remembered block stays on screen while this confirms it
}
function opened() {
  if (!started) { start(); return; }
  const now = Date.now();
  if (mode === "loading") load();                                          // the first try failed
  else if (mode === "sent" && now - sentAt >= DAY_MS) { forget(); load(); } // the day is over
  else if (mode === "blocked" && now >= blockedUntil) load();              // the block is over
  else if (mode === "open" && now - tokenAt > TOKEN_MAX_AGE_MS) load();   // a long-open tab gets a fresh form token
}
const opener = document.querySelector('[data-go="feedback"]');
for (const type of ["pointerenter", "pointerdown", "focus"]) opener?.addEventListener(type, start, { once: true });
new MutationObserver(() => { if (view.classList.contains("on")) opened(); }).observe(view, { attributes: true, attributeFilter: ["class"] });
if (view.classList.contains("on")) opened();
})();
