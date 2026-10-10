// /api/feedback rules. Storage and the clock are passed in (see api/feedback.js), so this file never touches the network.
//
//   GET   -> { state: "open", form }  a signed form token (proves the page was open for a moment)
//            { state: "sent" }        this browser already sent feedback in the last 24 h (cookie "fbs")
//            { state: "blocked", retry }  this device already used its 3 feedbacks, retry = seconds left
//   POST  -> { rating, message, form, hp }  ->  stored in Firestore, nothing is ever sent back but "ok"
//
// A "device" is the visitor's network address (IPv6 cut to its /64) plus the operating system named in the user agent,
// hashed. It is the same in Chrome, Brave, Firefox and in private windows, so switching browser or profile does not
// reset the limit. Each device may send 3 feedbacks; the 3rd one blocks it for 24 hours. Each browser may send 1 per 24 h.
//
// Order of checks, cheapest first: same origin, content type and size, shape, spam trap, rating and message,
// form token (age), already sent from this browser, device limit, store.
import { hmac, safeEqual } from "./secure.js";

export const RULES = {
  maxBody: 8192,        // bytes; a 1000-character message of emoji is about 4 KB
  maxMessage: 1000,     // characters
  minFillMs: 3000,      // faster than this after the form token was issued is a bot
  maxAgeMs: 2 * 60 * 60 * 1000,
  perDevice: 3,         // feedbacks one device may send; the last one starts the block
  windowMs: 24 * 60 * 60 * 1000, // the count starts over this long after a device's first feedback
  lockMs: 24 * 60 * 60 * 1000,   // how long a device stays blocked after its last allowed feedback
  sentMs: 24 * 60 * 60 * 1000,   // how long a browser keeps showing "thank you"
  maxUa: 200,
};
const KEYS = ["rating", "message", "form", "hp"];
// control characters except tab and line breaks, plus the Unicode line/paragraph separators
const BAD_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/;

const reply = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers } });


/* ---- form token: "<issued at ms>.<signature>" ---- */
export const issueToken = (secret, now) => `${now}.${hmac(secret, `form:${now}`).toString("base64url")}`;

/** "ok" | "bad" (forged, malformed or too old) | "fast" (too soon). */
export function checkToken(secret, token, now) {
  if (typeof token !== "string" || token.length > 80) return "bad";
  const [stamp, sig, extra] = token.split(".");
  if (extra !== undefined || !/^\d{10,15}$/.test(stamp ?? "") || !sig) return "bad";
  if (!safeEqual(sig, hmac(secret, `form:${stamp}`).toString("base64url"))) return "bad";
  const age = now - Number(stamp);
  if (age < 0 || age > RULES.maxAgeMs) return "bad";
  return age < RULES.minFillMs ? "fast" : "ok";
}

/* ---- visitor ---- */
export function clientIp(headers) {
  const raw = headers.get("x-vercel-forwarded-for") ?? headers.get("x-real-ip") ?? headers.get("x-forwarded-for") ?? "";
  return raw.split(",")[0].trim().slice(0, 64);
}
// The address is never stored, only this keyed hash of it.
export const hashIp = (secret, ip) => hmac(secret, `ip:${ip || "unknown"}`).toString("hex").slice(0, 32);

/** IPv4 as is; IPv6 cut to its /64 (phones and PCs rotate the last 64 bits all the time); IPv4-in-IPv6 becomes IPv4. */
export function networkOf(ip) {
  const raw = String(ip ?? "").trim().toLowerCase().split("%")[0];
  if (!raw.includes(":")) return raw;
  const mapped = /^(?:0*:)*:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  if (mapped) return mapped[1];
  const [head, tail, extra] = raw.split("::");
  if (extra !== undefined) return raw;
  const groups = (part) => (part ? part.split(":") : []);
  const left = groups(head), right = groups(tail);
  const fill = tail === undefined ? [] : Array(Math.max(0, 8 - left.length - right.length)).fill("0");
  return [...left, ...fill, ...right].slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":");
}

const SYSTEMS = [[/windows/i, "windows"], [/android/i, "android"], [/iphone|ipad|ipod/i, "ios"], [/cros/i, "chromeos"], [/mac os x|macintosh/i, "mac"], [/linux|x11/i, "linux"]];
export const systemOf = (ua) => SYSTEMS.find(([re]) => re.test(ua ?? ""))?.[1] ?? "other";

/** The device id that counts feedbacks: network + operating system, hashed. Same across browsers, profiles and private windows. */
export function deviceId(secret, ip, ua) {
  const where = ip ? networkOf(ip) : `ua:${ua ?? ""}`; // no address (local testing) must not put every visitor into one device
  return `dv-${hmac(secret, `device:${where}|${systemOf(ua)}`).toString("hex").slice(0, 32)}`;
}

/* ---- "already sent" cookie: "<sent at ms>.<signature>", 24 h, readable by this route only ---- */
const SENT_COOKIE = /(?:^|;\s*)fbs=(\d{10,15})\.([\w-]{40,50})(?:;|$)/;
export const sentCookie = (secret, now) =>
  `fbs=${now}.${hmac(secret, `sent:${now}`).toString("base64url")}; Max-Age=${RULES.sentMs / 1000}; Path=/api/feedback; HttpOnly; Secure; SameSite=Lax`;
export function wasSent(secret, cookieHeader, now, resetAt = 0) {
  const m = SENT_COOKIE.exec(cookieHeader ?? "");
  if (!m || !safeEqual(m[2], hmac(secret, `sent:${m[1]}`).toString("base64url"))) return false;
  if (Number(m[1]) <= resetAt) return false; // the owner reset the limits after this cookie was set
  const age = now - Number(m[1]);
  return age >= -60_000 && age < RULES.sentMs;
}

/* ---- device limit ----
   The store keeps one small record per device: { n, start, until, rev }. Reading and writing are separate steps, and a write
   only lands if nobody changed the record in between (rev), so two feedbacks sent at the same moment cannot both take the 3rd place. */
const secondsUntil = (ms, now) => Math.max(1, Math.ceil((ms - now) / 1000));

/** The block's end time (ms) when the device is blocked now, else 0. */
export async function blockedUntil(store, id, now, resetAt = 0) {
  const cur = await store.getLock(id);
  return cur && cur.until > now && cur.start > resetAt ? cur.until : 0;
}

/** When the owner last reset all limits (ms); 0 when never, or when it cannot be read (limits then stay in force). */
export async function resetOf(store) {
  try { return store.getReset ? Number(await store.getReset()) || 0 : 0; } catch { return 0; }
}

/** Takes one of the device's places. { ok: true } or { ok: false, until }. */
export async function claimPlace(store, id, now, resetAt = 0) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await store.getLock(id);
    const reset = Boolean(cur) && cur.start <= resetAt; // the record is older than the owner's last reset: it counts for nothing
    if (cur && !reset && cur.until > now) return { ok: false, until: cur.until };
    const fresh = !cur || reset || cur.until !== 0 || now - cur.start >= RULES.windowMs; // no record, a reset or finished block, or an old count
    const n = (fresh ? 0 : cur.n) + 1, start = fresh ? now : cur.start;
    const until = n >= RULES.perDevice ? now + RULES.lockMs : 0;
    const expireAt = new Date(Math.max(start + RULES.windowMs, until) + 86_400_000); // for the optional TTL policy
    if (await store.setLock(id, { n, start, until }, cur?.rev ?? null, expireAt)) return { ok: true };
  }
  throw new Error("busy");
}

function sameOrigin(headers, url) {
  const site = headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === (headers.get("host") ?? new URL(url).host);
  } catch {
    return false;
  }
}

/* ---- rating and message ---- */
/** Returns { rating, message } or null. The message is optional; the rating is required. */
export function readFeedback(body) {
  const { rating, message = "" } = body;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null;
  if (typeof message !== "string" || BAD_CHARS.test(message)) return null;
  const clean = message.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if ([...clean].length > RULES.maxMessage) return null;
  return { rating, message: clean };
}

/**
 * @param {Request} request
 * @param {{ secret: string|null, store: {getLock: Function, setLock: Function, add: Function, getReset?: Function}|null, now: () => number }} deps
 */
export async function handleFeedback(request, deps) {
  const { method, headers } = request;
  if (method !== "GET" && method !== "POST") return reply({ error: "method not allowed" }, 405, { Allow: "GET, POST" });
  if (!deps.secret || !deps.store) return reply({ error: "closed" }, 501);

  const ua = (headers.get("user-agent") ?? "").replace(BAD_CHARS, "").slice(0, RULES.maxUa);
  const ip = clientIp(headers);
  const device = deviceId(deps.secret, ip, ua);

  if (method === "GET") {
    const now = deps.now();
    const resetAt = await resetOf(deps.store);
    if (wasSent(deps.secret, headers.get("cookie"), now, resetAt)) return reply({ state: "sent" });
    let until = 0;
    try { until = await blockedUntil(deps.store, device, now, resetAt); } catch { /* the page only shows the state; a submit is checked again */ }
    if (until) return reply({ state: "blocked", retry: secondsUntil(until, now) });
    return reply({ state: "open", form: issueToken(deps.secret, now) });
  }

  try {
    if (!sameOrigin(headers, request.url)) return reply({ error: "origin" }, 403);
    if (!(headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return reply({ error: "type" }, 415);
    if (Number(headers.get("content-length") ?? 0) > RULES.maxBody) return reply({ error: "size" }, 413);
    const text = await request.text();
    if (Buffer.byteLength(text) > RULES.maxBody) return reply({ error: "size" }, 413);

    let body;
    try { body = JSON.parse(text); } catch { return reply({ error: "invalid" }, 400); }
    if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => !KEYS.includes(k))) {
      return reply({ error: "invalid" }, 400);
    }

    // spam trap: a filled field gets the same "ok" a person would, and nothing is stored
    if (body.hp !== undefined && typeof body.hp !== "string") return reply({ error: "invalid" }, 400);
    if (body.hp) return reply({ ok: true });

    const entry = readFeedback(body);
    if (!entry) return reply({ error: "invalid" }, 400);

    const now = deps.now();
    const stamp = checkToken(deps.secret, body.form, now);
    if (stamp === "bad") return reply({ error: "expired" }, 400);
    if (stamp === "fast") return reply({ error: "fast" }, 400);

    const resetAt = await resetOf(deps.store);
    if (wasSent(deps.secret, headers.get("cookie"), now, resetAt)) return reply({ error: "sent" }, 429);

    const place = await claimPlace(deps.store, device, now, resetAt);
    if (!place.ok) {
      const retry = secondsUntil(place.until, now);
      return reply({ error: "limit", retry }, 429, { "Retry-After": String(retry) });
    }

    await deps.store.add({ id: crypto.randomUUID(), rating: entry.rating, message: entry.message, ipHash: hashIp(deps.secret, ip), ua });
    return reply({ ok: true }, 200, { "Set-Cookie": sentCookie(deps.secret, now) });
  } catch {
    return reply({ error: "server" }, 500); // never says why
  }
}
