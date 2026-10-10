// /api/admin/*: GitHub login, session, and the feedback viewer. Storage and GitHub are passed in (see api/admin/[[...path]].js),
// so this file never touches the network and the tests run with fakes.
//
//   GET    /api/admin/login            start GitHub sign-in (state + PKCE), redirects to github.com
//   GET    /api/admin/callback         GitHub returns here; only the owner's numeric user id gets a session
//   POST   /api/admin/logout           ends the session on the server (all sessions issued before now stop working)
//   GET    /api/admin/me               { login, csrf, exp }   (the page asks this first)
//   GET    /api/admin/feedback         ?page=1&size=10 -> { items, total, unread, avg, page, pages, size }
//   PATCH  /api/admin/feedback/<id>    { read: boolean } or { pinned: boolean }   (at most 3 pinned, else 409 "pinlimit")
//   DELETE /api/admin/feedback/<id>
//   POST   /api/admin/reset-limits     clears every visitor's feedback limit (devices and browsers) -> { ok, at }
//   GET    /api/admin/content          { base, content, files, icons }  latest content.json + image list from the repo (read-only)
//   POST   /api/admin/preview          form post { csrf, content } -> the site page rendered from the draft (shown inside the admin in an iframe, nothing is saved)
//   POST   /api/admin/validate         { base, content, added, removed } -> { errors, warnings }  (the build's own validator)
//   POST   /api/admin/push             { base, key, message, content, added{path: dataURL}, removed[] } -> { ok, sha, url }  one atomic commit
//   GET    /api/admin/status?sha=      { state: "pending" | "success" | "failure" | "unknown" }  deploy state of a pushed commit (best effort)
//
// Every protected call checks, in this order: method, origin, session cookie (signature, expiry, owner id, not revoked),
// failed-auth limit, CSRF header (changing calls only), write limit, body shape.
// Up to 2 trusted devices (browsers that completed an owner sign-in) are exempt from all of these rate limits; everyone else is limited as before.
import { createHash, randomBytes } from "node:crypto";
import { clientIp, hashIp } from "./feedback.js";
import { hmac, safeEqual } from "./secure.js";
import { isNavigation, pageResponse } from "./not-found.js";
import { validateContent } from "../scripts/schema.mjs";
import { esc, renderPage } from "../scripts/render.mjs";
import { sanitizeSvg } from "../public/admin/svg.js";
import { LIMITS as FILE_LIMITS, sniff } from "../public/admin/logic.js";
import { PUBLIC_PATH, isSha } from "./repo.js";

export const LIMITS = {
  sessionMs: 2 * 60 * 60 * 1000, // absolute lifetime of a session
  oauthMs: 10 * 60 * 1000,       // time allowed between "sign in" and GitHub's answer
  login: { max: 10, windowMs: 10 * 60 * 1000 },
  fail: { max: 30, windowMs: 10 * 60 * 1000 },
  write: { max: 120, windowMs: 10 * 60 * 1000 },
  maxBody: 1024,
  maxValidateBody: 260_000,
  maxPaths: 200,
  push: { max: 6, windowMs: 10 * 60 * 1000 }, // pushes per 10 minutes, on top of the write limit
  maxPushBody: 4_400_000,                     // Vercel refuses bodies over 4.5 MB; the draft is capped at 3 MB of pictures (+33% base64)
  message: { min: 3, max: 72 },
  sizes: [10, 20, 50],
  maxPinned: 3,
  maxPage: 500,
  trustedMax: 2,                         // devices that are never rate limited
  deviceMs: 365 * 24 * 60 * 60 * 1000,   // lifetime of the trusted-device cookie
};
const SID = "__Host-sid";     // session cookie: HttpOnly, Secure, SameSite=Strict
const OAUTH = "__Host-oauth"; // sign-in state cookie: SameSite=Lax because GitHub sends the browser back from another site
const DEV = "__Host-dev";     // trusted-device cookie: HttpOnly, Secure, SameSite=Lax (GitHub sends the browser back to /callback from another site)
const DEVICE_ID = /^[A-Za-z0-9_-]{16}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const b64 = (buf) => Buffer.from(buf).toString("base64url");
// one derived key per purpose, so a value signed for one job can never be replayed for another
const keyFor = (secret, purpose) => hmac(secret, `admin:${purpose}`);

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};
const reply = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...HEADERS, ...extra } });
function redirect(to, cookies) {
  const headers = new Headers({ ...HEADERS, Location: to });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

const setCookie = (name, value, maxAge, sameSite) => `${name}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=${sameSite}`;
const clearCookie = (name, sameSite) => setCookie(name, "", 0, sameSite);
function cookies(header) {
  const out = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/* ---- signed values: "<base64url json>.<base64url hmac>" ---- */
export const sign = (key, data) => { const body = b64(JSON.stringify(data)); return `${body}.${b64(hmac(key, body))}`; };
export function verify(key, token) {
  if (typeof token !== "string" || token.length > 1024) return null;
  const [body, sig, extra] = token.split(".");
  if (extra !== undefined || !body || !sig || !safeEqual(sig, b64(hmac(key, body)))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return data && typeof data === "object" ? data : null;
  } catch { return null; }
}
// The CSRF token is bound to the session cookie it was issued for.
const csrfFor = (secret, sessionCookie) => b64(hmac(keyFor(secret, "csrf"), sessionCookie));

/* ---- request checks ---- */
// allowOpaque: a same-origin form post from a page served with "Referrer-Policy: no-referrer" carries "Origin: null" (Fetch spec).
// It is accepted only when the browser itself says Sec-Fetch-Site is same-origin (a header page scripts cannot set or forge).
function sameOrigin(headers, url, { requireOrigin, allowOpaque = false }) {
  const site = headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && !(site === "none" && !requireOrigin)) return false;
  const origin = headers.get("origin");
  if (allowOpaque && origin === "null") return site === "same-origin";
  if (!origin) return !requireOrigin;
  try { return new URL(origin).host === (headers.get("host") ?? new URL(url).host); } catch { return false; }
}

// Counts this visitor in a time bucket; returns 0 when allowed, or the seconds to wait.
// Trusted devices (at most LIMITS.trustedMax) skip every limit below. A device becomes trusted only by finishing a real owner sign-in
// (see callback). The cookie is signed, bound to the owner id, and its device id must still be on the stored list, so it cannot be forged,
// carried over after being pushed off the list, or used by another GitHub account. It grants no access by itself, only freedom from the counters.
// Any storage problem means "not trusted": the normal limits then apply.
const trustCache = new WeakMap();
async function trusted(deps, request) {
  if (trustCache.has(request)) return trustCache.get(request);
  const pending = (async () => {
    try {
      const data = verify(keyFor(deps.env.secret, "device"), cookies(request.headers.get("cookie"))[DEV]);
      if (!data || data.u !== deps.env.adminId || typeof data.d !== "string" || !DEVICE_ID.test(data.d) || !deps.store.getTrusted) return false;
      return (await deps.store.getTrusted()).includes(data.d);
    } catch { return false; }
  })();
  trustCache.set(request, pending);
  return pending;
}

// Adds (or refreshes) this browser on the trusted list. Newest last; when more than LIMITS.trustedMax, the longest-unused one drops off.
// Returns the Set-Cookie line, or null when it could not be saved (sign-in still works, the device just stays untrusted).
async function trust(deps, request) {
  if (!deps.store.getTrusted || !deps.store.setTrusted) return null;
  try {
    const old = verify(keyFor(deps.env.secret, "device"), cookies(request.headers.get("cookie"))[DEV]);
    const id = old && old.u === deps.env.adminId && DEVICE_ID.test(old.d ?? "") ? old.d : b64(randomBytes(12)).slice(0, 16);
    const list = await deps.store.getTrusted();
    if (list.at(-1) !== id) await deps.store.setTrusted([...list.filter((x) => x !== id), id].slice(-LIMITS.trustedMax));
    const cookie = sign(keyFor(deps.env.secret, "device"), { u: deps.env.adminId, d: id, iat: deps.now() });
    return setCookie(DEV, cookie, LIMITS.deviceMs / 1000, "Lax");
  } catch { return null; }
}

async function limited(deps, request, name, { max, windowMs }) {
  if (await trusted(deps, request)) return 0;
  const now = deps.now();
  const bucket = Math.floor(now / windowMs);
  const visitor = hashIp(keyFor(deps.env.secret, "rate").toString("hex"), clientIp(request.headers));
  const [n] = await deps.store.hit([{ id: `a${name}-${visitor}-${bucket}`, expireAt: new Date((bucket + 1) * windowMs + 86_400_000) }]);
  return n > max ? Math.max(1, Math.ceil(((bucket + 1) * windowMs - now) / 1000)) : 0;
}
const tooMany = (seconds) => reply({ error: "limit" }, 429, { "Retry-After": String(seconds) });

/** { session, cookie } or null. Fails closed: a storage error is an exception, never access. */
async function authenticate(request, deps) {
  const cookie = cookies(request.headers.get("cookie"))[SID];
  const data = cookie && verify(keyFor(deps.env.secret, "session"), cookie);
  const now = deps.now();
  if (!data || data.u !== deps.env.adminId || !Number.isFinite(data.iat) || !Number.isFinite(data.exp)) return null;
  if (data.exp <= now || data.iat > now + 60_000) return null;
  if (data.iat <= (await deps.store.revokedBefore())) return null;
  return { session: data, cookie };
}

/* ---- routes ---- */
async function login(request, deps) {
  if (request.method !== "GET") return reply({ error: "method not allowed" }, 405, { Allow: "GET" });
  const wait = await limited(deps, request, "l", LIMITS.login);
  if (wait) return tooMany(wait);
  const state = b64(randomBytes(24));
  const verifier = b64(randomBytes(32));
  const params = new URLSearchParams({
    client_id: deps.env.clientId, state, allow_signup: "false",
    code_challenge: b64(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
  }); // no scope: the sign-in only needs the account's public id
  const pending = sign(keyFor(deps.env.secret, "oauth"), { s: state, v: verifier, exp: deps.now() + LIMITS.oauthMs });
  return redirect(`https://github.com/login/oauth/authorize?${params}`, [setCookie(OAUTH, pending, LIMITS.oauthMs / 1000, "Lax")]);
}

async function callback(request, deps) {
  if (request.method !== "GET") return reply({ error: "method not allowed" }, 405, { Allow: "GET" });
  const wait = await limited(deps, request, "c", LIMITS.login); // its own counter: starting a sign-in and coming back from GitHub are counted apart
  if (wait) return tooMany(wait);
  const drop = [clearCookie(OAUTH, "Lax")];
  const fail = (why) => redirect(`/admin?e=${why}`, [...drop, clearCookie(SID, "Strict")]);

  const url = new URL(request.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const pending = verify(keyFor(deps.env.secret, "oauth"), cookies(request.headers.get("cookie"))[OAUTH]);
  if (!pending || pending.exp <= deps.now() || !state || !safeEqual(String(pending.s), state) || !/^[A-Za-z0-9_-]{8,100}$/.test(code)) return fail("failed");

  let user;
  try {
    user = await deps.github.user(await deps.github.exchange(code, pending.v)); // the GitHub token is used once and never stored
  } catch { return fail("failed"); }
  if (!Number.isSafeInteger(user?.id) || String(user.id) !== deps.env.adminId) return fail("denied");

  const now = deps.now();
  const login = typeof user.login === "string" && /^[A-Za-z0-9-]{1,39}$/.test(user.login) ? user.login : "";
  const session = sign(keyFor(deps.env.secret, "session"), { u: deps.env.adminId, l: login, iat: now, exp: now + LIMITS.sessionMs, n: b64(randomBytes(9)) });
  const device = await trust(deps, request);
  return redirect("/admin", [...drop, setCookie(SID, session, LIMITS.sessionMs / 1000, "Strict"), ...(device ? [device] : [])]);
}

async function me(request, deps) {
  if (request.method !== "GET") return reply({ error: "method not allowed" }, 405, { Allow: "GET" });
  if (!sameOrigin(request.headers, request.url, { requireOrigin: false })) return reply({ error: "origin" }, 403);
  const auth = await authenticate(request, deps);
  if (!auth) return reply({ error: "auth" }, 401);
  return reply({ login: auth.session.l || "", csrf: csrfFor(deps.env.secret, auth.cookie), exp: auth.session.exp });
}

async function logout(request, deps) {
  if (request.method !== "POST") return reply({ error: "method not allowed" }, 405, { Allow: "POST" });
  if (!sameOrigin(request.headers, request.url, { requireOrigin: true })) return reply({ error: "origin" }, 403);
  const gone = { "Set-Cookie": clearCookie(SID, "Strict") };
  const auth = await authenticate(request, deps);
  if (!auth) return reply({ ok: true }, 200, gone); // nothing valid to end; the cookie is cleared anyway
  const sent = request.headers.get("x-csrf-token") ?? "";
  if (!safeEqual(sent, csrfFor(deps.env.secret, auth.cookie))) return reply({ error: "csrf" }, 403);
  const wait = await limited(deps, request, "w", LIMITS.write);
  if (wait) return tooMany(wait);
  await deps.store.revokeSessions(deps.now());
  return reply({ ok: true }, 200, gone);
}

async function feedback(request, deps, id) {
  const { method } = request;
  const allowed = id ? ["PATCH", "DELETE"] : ["GET"];
  if (!allowed.includes(method)) return reply({ error: "method not allowed" }, 405, { Allow: allowed.join(", ") });
  const changing = method !== "GET";
  if (!sameOrigin(request.headers, request.url, { requireOrigin: changing })) return reply({ error: "origin" }, 403);

  const auth = await authenticate(request, deps);
  if (!auth) {
    const wait = await limited(deps, request, "f", LIMITS.fail);
    return wait ? tooMany(wait) : reply({ error: "auth" }, 401);
  }
  if (changing) {
    if (!safeEqual(request.headers.get("x-csrf-token") ?? "", csrfFor(deps.env.secret, auth.cookie))) return reply({ error: "csrf" }, 403);
    const wait = await limited(deps, request, "w", LIMITS.write);
    if (wait) return tooMany(wait);
  }

  if (method === "GET") {
    const q = new URL(request.url).searchParams;
    const page = Number(q.get("page") ?? 1), size = Number(q.get("size") ?? LIMITS.sizes[0]);
    if (!Number.isInteger(page) || page < 1 || page > LIMITS.maxPage || !LIMITS.sizes.includes(size)) return reply({ error: "invalid" }, 400);
    const [stats, items, pinned] = await Promise.all([deps.store.stats(), deps.store.list({ offset: (page - 1) * size, limit: size }), deps.store.pinned ? deps.store.pinned() : []]);
    return reply({ items, pinned, total: stats.total, unread: stats.unread, avg: stats.avg, page, size, pages: Math.max(1, Math.ceil(stats.total / size)) });
  }

  if (!ID.test(id)) return reply({ error: "invalid" }, 400);
  let field, value;
  if (method === "PATCH") {
    const parsed = await readJson(request, LIMITS.maxBody);
    if (parsed.denied) return parsed.denied;
    const { body } = parsed;
    if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1) return reply({ error: "invalid" }, 400);
    [field, value] = Object.entries(body)[0];
    if ((field !== "read" && field !== "pinned") || typeof value !== "boolean") return reply({ error: "invalid" }, 400);
    if (field === "pinned") {
      if (!deps.store.setPinned || !deps.store.pinned) return reply({ error: "not set up" }, 501);
      if (value) { // at most 3 pinned at a time; pinning one that is already pinned is fine
        const now = await deps.store.pinned();
        if (!now.some((x) => x.id === id) && now.length >= LIMITS.maxPinned) return reply({ error: "pinlimit" }, 409);
      }
    }
  }
  const done = method === "PATCH" ? await (field === "read" ? deps.store.setRead(id, value) : deps.store.setPinned(id, value)) : await deps.store.remove(id);
  return done ? reply({ ok: true }) : reply({ error: "missing" }, 404);
}

// Owner-only: every feedback limit record and "already sent" cookie made before now stops counting. Cheap, one write.
async function resetLimits(request, deps) {
  const denied = await guard(request, deps, { method: "POST", changing: true });
  if (denied) return denied;
  if (!deps.store.resetLimits) return reply({ error: "not set up" }, 501);
  const at = deps.now();
  await deps.store.resetLimits(at);
  return reply({ ok: true, at });
}

// Shared door for the editor routes: method, origin, session, failed-auth limit, CSRF + write limit (changing calls). Returns a Response or null.
async function guard(request, deps, { method, changing }) {
  if (request.method !== method) return reply({ error: "method not allowed" }, 405, { Allow: method });
  if (!sameOrigin(request.headers, request.url, { requireOrigin: changing })) return reply({ error: "origin" }, 403);
  const auth = await authenticate(request, deps);
  if (!auth) {
    const wait = await limited(deps, request, "f", LIMITS.fail);
    return wait ? tooMany(wait) : reply({ error: "auth" }, 401);
  }
  if (changing) {
    if (!safeEqual(request.headers.get("x-csrf-token") ?? "", csrfFor(deps.env.secret, auth.cookie))) return reply({ error: "csrf" }, 403);
    const wait = await limited(deps, request, "w", LIMITS.write);
    if (wait) return tooMany(wait);
  }
  return null;
}
const noRepo = (deps) => (deps.repo ? null : reply({ error: "norepo" }, 501));

async function content(request, deps) {
  const denied = (await guard(request, deps, { method: "GET", changing: false })) ?? noRepo(deps);
  if (denied) return denied;
  const wanted = new URL(request.url).searchParams.get("base");
  if (wanted !== null && !isSha(wanted)) return reply({ error: "invalid" }, 400);
  const base = wanted ?? (await deps.repo.head());
  const [data, files] = await Promise.all([deps.repo.content(base), deps.repo.files(base)]);
  return reply({ base, head: wanted ? await deps.repo.head() : base, content: data, files, icons: deps.icons() });
}

// Reads a JSON request body: { body } when it is fine, { denied: Response } when the type, size or syntax is wrong.
async function readJson(request, maxBytes) {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return { denied: reply({ error: "type" }, 415) };
  const text = await request.text();
  if (Buffer.byteLength(text) > maxBytes) return { denied: reply({ error: "size" }, 413) };
  try { return { body: JSON.parse(text) }; } catch { return { denied: reply({ error: "invalid" }, 400) }; }
}

async function validate(request, deps) {
  const denied = (await guard(request, deps, { method: "POST", changing: true })) ?? noRepo(deps);
  if (denied) return denied;
  const parsed = await readJson(request, LIMITS.maxValidateBody);
  if (parsed.denied) return parsed.denied;
  const { body } = parsed;
  const paths = (v) => Array.isArray(v) && v.length <= LIMITS.maxPaths && v.every((p) => typeof p === "string" && PUBLIC_PATH.test(p));
  if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join() !== "added,base,content,removed"
    || !isSha(body.base) || !paths(body.added) || !paths(body.removed)) return reply({ error: "invalid" }, 400);

  const files = new Set((await deps.repo.files(body.base)).map((f) => f.path));
  for (const p of body.removed) files.delete(p);
  for (const p of body.added) files.add(p);
  const { errors, warnings } = validateContent(body.content, { icons: deps.icons(), fileExists: (p) => files.has(p) });
  return reply({ errors: errors.slice(0, 50), warnings: warnings.slice(0, 50), ok: errors.length === 0 });
}

/* ---- preview: the draft rendered exactly like the build would, never saved ---- */
// Runs in an iframe inside the admin, so it is a form post (an iframe cannot send headers): the CSRF token travels as a form field.
// The page gets the public site's rules, except it may not talk to any of our APIs (no view counted, no feedback sent) and may only be framed by the admin.
const PREVIEW_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https://cdn.jsdelivr.net; font-src 'self' https://fonts.gstatic.com; connect-src https://api.lanyard.rest wss://api.lanyard.rest; worker-src 'none'; manifest-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'";
// The entrance always plays in preview (the site skips it for an hour after a visit). The head script that decides is swapped for one that never skips,
// and <html data-preview> tells script.js not to remember the visit. Only this response changes; the public site and the build output are untouched.
const HEAD_DECIDER = /<script>\(d=>\{const K="intro-at"[\s\S]*?\}\)\(document\.documentElement\)<\/script>/;
const PREVIEW_DECIDER = '<script>(d=>{d.classList.add("js","is-intro");setTimeout(()=>d.classList.add("lit"),4e3);setTimeout(()=>d.classList.remove("is-intro"),12e3)})(document.documentElement)</script>';
export function withPreviewEntrance(html) {
  if (!HEAD_DECIDER.test(html)) throw new Error("preview: entrance script not found in the template");
  return html.replace(HEAD_DECIDER, () => PREVIEW_DECIDER).replace(/<html(?=[\s>])/, "<html data-preview");
}
const previewPage = (html, status = 200) => new Response(html, {
  status,
  headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PREVIEW_CSP, "X-Frame-Options": "SAMEORIGIN" },
});
// The "fix the errors first" page shown inside the preview frame: same Poppins files as the site (served from /font, allowed by the CSP), one centred card,
// and no scrolling at all (the page is exactly the frame's size and clips anything extra; at most 8 lines are listed, the rest are counted).
const PROBLEM_CSS = [300, 400, 500, 600, 700].map((w) => `@font-face{font-family:"Poppins";font-style:normal;font-weight:${w};font-display:swap;src:url(/font/poppins-${w}.woff2) format("woff2")}`).join("")
  + 'html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000;overscroll-behavior:none}'
  + 'body{box-sizing:border-box;display:flex;align-items:center;justify-content:center;padding:24px;color:#c1c5ce;font:400 13px/1.55 "Poppins",system-ui,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;user-select:none;-webkit-user-select:none}'
  + 'main{box-sizing:border-box;width:max-content;max-width:min(100%,460px);max-height:100%;margin:auto;overflow:hidden}'
  + 'h1{margin:0 0 12px;font-size:15px;font-weight:600;line-height:1.35;color:#f1f3f7}'
  + 'ul{margin:0;padding:0;list-style:none;display:grid;gap:8px}'
  + 'li{display:grid;gap:1px;padding-left:14px;position:relative;overflow-wrap:anywhere}'
  + 'li::before{content:"";position:absolute;left:0;top:.7em;width:4px;height:4px;border-radius:50%;background:#6b7280}'
  + 'b{font-weight:500;color:#e4e7ee}'
  + 'p{margin:10px 0 0;color:#8a90a0;font-size:12px}'
  + '@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}';
const problemLine = (line) => {
  const [field, ...rest] = String(line).split(": ");
  return rest.length ? `<li><b>${esc(field)}</b><span>${esc(rest.join(": "))}</span></li>` : `<li><span>${esc(line)}</span></li>`;
};
const previewProblem = (lines) => previewPage(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Preview</title><style>${PROBLEM_CSS}</style></head><body><main><h1>Fix the errors first</h1><ul>${lines.slice(0, 8).map(problemLine).join("")}</ul>${lines.length > 8 ? `<p>and ${lines.length - 8} more</p>` : ""}</main></body></html>`);

async function preview(request, deps) {
  if (request.method !== "POST") return reply({ error: "method not allowed" }, 405, { Allow: "POST" });
  if (!sameOrigin(request.headers, request.url, { requireOrigin: true, allowOpaque: true })) return reply({ error: "origin" }, 403);
  const auth = await authenticate(request, deps);
  if (!auth) {
    const wait = await limited(deps, request, "f", LIMITS.fail);
    return wait ? tooMany(wait) : reply({ error: "auth" }, 401);
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return reply({ error: "type" }, 415);
  const text = await request.text();
  if (Buffer.byteLength(text) > LIMITS.maxValidateBody) return reply({ error: "size" }, 413);
  const form = new URLSearchParams(text);
  if (!safeEqual(form.get("csrf") ?? "", csrfFor(deps.env.secret, auth.cookie))) return reply({ error: "csrf" }, 403);
  const wait = await limited(deps, request, "w", LIMITS.write);
  if (wait) return tooMany(wait);

  let data;
  try { data = JSON.parse(form.get("content") ?? ""); } catch { return reply({ error: "invalid" }, 400); }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return reply({ error: "invalid" }, 400);
  // Pictures added in the draft are not in the repo yet; the admin swaps them in after the page loads, so every path counts as present here.
  const { errors } = validateContent(data, { icons: deps.icons(), fileExists: () => true });
  if (errors.length) return previewProblem(errors);
  try {
    return previewPage(withPreviewEntrance(renderPage(deps.template(), data)));
  } catch (e) {
    return previewProblem([e instanceof Error ? e.message : "Could not render"]);
  }
}

/* ---- push ---- */
const MIME = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml" };
const KEY = /^[A-Za-z0-9_-]{16,64}$/;
const BAD_MESSAGE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const invalid = (...errors) => reply({ error: "invalid", errors }, 422);

/** One line, 3-72 characters, no control or direction-override characters. Returns the cleaned message or "". */
export function cleanMessage(value) {
  if (typeof value !== "string" || value.length > 400) return "";
  const text = value.normalize("NFC").replace(/\s+/g, " ").trim();
  const n = [...text].length;
  return n >= LIMITS.message.min && n <= LIMITS.message.max && !BAD_MESSAGE.test(text) ? text : "";
}

/** data URL -> checked bytes. Real type by magic bytes must match the file extension and the declared type; SVGs are rebuilt by the sanitizer. */
export function decodePicture(path, data) {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(typeof data === "string" ? data : "");
  if (!m || m[2].length > 800_000) return { error: `${path}: not a picture` };
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase().replace("jpg", "jpeg");
  let bytes = Buffer.from(m[2], "base64");
  const kind = sniff(new Uint8Array(bytes));
  if (!kind || kind !== ext || MIME[kind] !== m[1]) return { error: `${path}: file type does not match` };
  if (kind === "svg") {
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return { error: `${path}: not text` }; }
    const clean = sanitizeSvg(text);
    if (!clean.ok) return { error: `${path}: ${clean.error}` };
    bytes = Buffer.from(clean.svg, "utf8");
  } else if (bytes.length > FILE_LIMITS.bytes) return { error: `${path}: bigger than ${FILE_LIMITS.bytes / 1000} KB` };
  if (bytes.length === 0) return { error: `${path}: empty` };
  return { bytes };
}

async function push(request, deps) {
  const denied = (await guard(request, deps, { method: "POST", changing: true })) ?? noRepo(deps);
  if (denied) return denied;
  const wait = await limited(deps, request, "p", LIMITS.push);
  if (wait) return tooMany(wait);
  const parsed = await readJson(request, LIMITS.maxPushBody);
  if (parsed.denied) return parsed.denied;
  const { body } = parsed;
  if (!isPlain(body) || Object.keys(body).sort().join() !== "added,base,content,key,message,removed" || !isSha(body.base)
    || typeof body.key !== "string" || !KEY.test(body.key) || !isPlain(body.added) || !Array.isArray(body.removed)) return reply({ error: "invalid" }, 400);
  const message = cleanMessage(body.message);
  if (!message) return invalid("message: 3-72 characters on one line");

  // paths: whitelist only, no overlap, capped
  const addedPaths = Object.keys(body.added);
  if (addedPaths.length > FILE_LIMITS.files || body.removed.length > LIMITS.maxPaths) return invalid("too many files");
  if (!addedPaths.every((p) => PUBLIC_PATH.test(p)) || !body.removed.every((p) => typeof p === "string" && PUBLIC_PATH.test(p))) return reply({ error: "invalid" }, 400);
  const removed = [...new Set(body.removed)];
  if (removed.length !== body.removed.length || removed.some((p) => addedPaths.includes(p))) return invalid("files: a path is listed twice");

  // pictures: decode and re-check everything the browser claimed
  const pictures = [];
  let total = 0;
  const errors = [];
  for (const path of addedPaths) {
    const r = decodePicture(path, body.added[path]);
    if (r.error) { errors.push(r.error); continue; }
    total += r.bytes.length;
    pictures.push({ path: `public${path}`, bytes: r.bytes });
  }
  if (errors.length) return invalid(...errors.slice(0, 20));
  if (total > FILE_LIMITS.total + 40_000 * addedPaths.length) return invalid("pictures: too big in total"); // sanitized SVGs may differ slightly from what the page measured

  // one click = one key: a repeat of the same click is refused before anything reaches GitHub
  const [seen] = await deps.store.hit([{ id: `apk-${body.key}`, expireAt: new Date(deps.now() + 86_400_000) }]);
  if (seen > 1) return reply({ error: "dup" }, 409);

  if ((await deps.repo.head()) !== body.base) return reply({ error: "moved" }, 409); // the branch moved since the draft was loaded: stop, never overwrite

  const existing = new Set((await deps.repo.files(body.base)).map((f) => f.path));
  if (removed.some((p) => !existing.has(p))) return invalid("files: a removed file does not exist");
  const files = new Set(existing);
  for (const p of removed) files.delete(p);
  for (const p of addedPaths) files.add(p);
  const checked = validateContent(body.content, { icons: deps.icons(), fileExists: (p) => files.has(p) });
  if (checked.errors.length) return invalid(...checked.errors.slice(0, 20));

  const json = `${JSON.stringify(body.content, null, 2)}\n`;
  const before = await deps.repo.content(body.base);
  if (json === `${JSON.stringify(before, null, 2)}\n` && !pictures.length && !removed.length) return reply({ error: "nochange" }, 400);

  try {
    const done = await deps.repo.commit({
      base: body.base, message,
      files: [{ path: "content.json", bytes: Buffer.from(json, "utf8") }, ...pictures],
      removed: removed.map((p) => `public${p}`),
    });
    return reply({ ok: true, sha: done.sha, url: `https://github.com/${deps.repo.name}/commit/${done.sha}` });
  } catch (e) {
    if (e?.code === "moved") return reply({ error: "moved" }, 409);
    return reply({ error: e?.code === "readonly" ? "readonly" : "github" }, 502); // never says more
  }
}

async function status(request, deps) {
  const denied = (await guard(request, deps, { method: "GET", changing: false })) ?? noRepo(deps);
  if (denied) return denied;
  const sha = new URL(request.url).searchParams.get("sha");
  if (!isSha(sha)) return reply({ error: "invalid" }, 400);
  return reply({ state: await deps.repo.status(sha) });
}

/**
 * @param {Request} request
 * @param {{ env: {clientId, clientSecret, adminId, secret}|null, store: object, repo: {head, files, content}|null, icons: () => string[], github: {exchange: Function, user: Function}, now: () => number }} deps
 */
export async function handleAdmin(request, deps) {
  const res = await route(request, deps);
  // A person opening one of these addresses in the browser (typed, clicked, or sent back by GitHub) never sees raw JSON:
  // any error answer becomes the designed 404 page. The admin page itself uses fetch(), which is not a navigation, and keeps the JSON.
  if (res.status >= 400 && isNavigation(request)) {
    return pageResponse(res.status === 429 ? 429 : 404, res.status === 429 ? { "Retry-After": res.headers.get("Retry-After") ?? "60" } : {});
  }
  return res;
}

async function route(request, deps) {
  if (!deps.env) return reply({ error: "closed" }, 501);
  try {
    const [, , , route, id, extra] = new URL(request.url).pathname.replace(/\/+$/, "").split("/"); // "", "api", "admin", route, id
    if (extra !== undefined) return reply({ error: "not found" }, 404);
    if (id !== undefined && route !== "feedback") return reply({ error: "not found" }, 404);
    switch (route) {
      case "login": return await login(request, deps);
      case "callback": return await callback(request, deps);
      case "logout": return await logout(request, deps);
      case "me": return await me(request, deps);
      case "feedback": return await feedback(request, deps, id);
      case "reset-limits": return await resetLimits(request, deps);
      case "content": return await content(request, deps);
      case "validate": return await validate(request, deps);
      case "preview": return await preview(request, deps);
      case "push": return await push(request, deps);
      case "status": return await status(request, deps);
      default: return reply({ error: "not found" }, 404);
    }
  } catch {
    return reply({ error: "server" }, 500); // never says why
  }
}

// The real GitHub calls (5 s timeout each). The access token only lives inside these two calls.
export const makeGithub = ({ clientId, clientSecret }) => ({
  async exchange(code, verifier) {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier }),
      signal: AbortSignal.timeout(5000),
    });
    const data = res.ok ? await res.json() : null;
    if (typeof data?.access_token !== "string") throw new Error("exchange");
    return data.access_token;
  },
  async user(token) {
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "portfolio-admin", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error("user");
    return res.json();
  },
});
