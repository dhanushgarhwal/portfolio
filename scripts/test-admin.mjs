// Checks for /api/admin/* (lib/admin.js) with a fake store and a fake GitHub. Run: npm test
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { LIMITS, handleAdmin, sign, verify } from "../lib/admin.js";

const HOST = "site.example";
const OWNER = "4242";
const SECRET = "s".repeat(40);
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const UUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function setup({ configured = true, githubUser = { id: 4242, login: "owner-name" }, exchangeFails = false, storeBroken = false } = {}) {
  let clock = T0;
  const docs = new Map([[UUID(1), { id: UUID(1), rating: 5, message: "great", createdAt: "2026-10-08T10:00:00Z", read: false }],
                        [UUID(2), { id: UUID(2), rating: 3, message: "<b>ok</b>", createdAt: "2026-10-08T09:00:00Z", read: true }]]);
  const counters = new Map();
  let revokedBefore = 0;
  let trustedIds = [];
  const seen = { exchange: [], hits: 0 };
  const broke = () => { if (storeBroken) throw new Error("secret db detail 10.0.0.1"); };
  const deps = {
    env: configured ? { clientId: "cid", clientSecret: "csecret", adminId: OWNER, secret: SECRET } : null,
    github: {
      exchange: async (code, verifier) => { seen.exchange.push({ code, verifier }); if (exchangeFails) throw new Error("x"); return "gh-token"; },
      user: async (token) => { assert.equal(token, "gh-token"); return githubUser; },
    },
    store: {
      hit: async (buckets) => { broke(); seen.hits++; return buckets.map(({ id }) => { counters.set(id, (counters.get(id) ?? 0) + 1); return counters.get(id); }); },
      list: async ({ offset, limit }) => { broke(); return [...docs.values()].slice(offset, offset + limit); },
      stats: async () => { broke(); const all = [...docs.values()]; return { total: all.length, unread: all.filter((d) => !d.read).length, avg: all.length ? all.reduce((s, d) => s + d.rating, 0) / all.length : null }; },
      setRead: async (id, read) => { broke(); if (!docs.has(id)) return false; docs.get(id).read = read; return true; },
      pinned: async () => { broke(); return [...docs.values()].filter((d) => d.pinned); },
      setPinned: async (id, pinned) => { broke(); if (!docs.has(id)) return false; docs.get(id).pinned = pinned; return true; },
      remove: async (id) => { broke(); return docs.delete(id); },
      revokedBefore: async () => { broke(); return revokedBefore; },
      revokeSessions: async (ms) => { revokedBefore = Math.max(revokedBefore, ms); },
      resetLimits: async (ms) => { broke(); seen.reset = ms; },
      getTrusted: async () => { broke(); return [...trustedIds]; },
      setTrusted: async (ids) => { broke(); trustedIds = [...ids]; },
    },
    now: () => clock,
  };
  return { deps, docs, seen, trusted: () => [...trustedIds], tick: (ms) => { clock += ms; }, at: () => clock };
}

const call = (t, method, path, { headers = {}, body, origin = true, site = "same-origin" } = {}) => handleAdmin(new Request(`https://${HOST}${path}`, {
  method,
  headers: { host: HOST, "x-vercel-forwarded-for": "203.0.113.7", ...(site ? { "sec-fetch-site": site } : {}), ...(origin && method !== "GET" ? { origin: `https://${HOST}` } : {}), ...headers },
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  redirect: "manual",
}), t.deps);

const cookiePair = (res, name) => {
  const line = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  const pair = line ? line.split(";")[0] : null;
  return pair && !pair.endsWith("=") ? pair : null; // an emptied cookie (logout) counts as no cookie
};

// the real flow: /login, then /callback with GitHub's answer
async function signIn(t, { tamper = {} } = {}) {
  const start = await call(t, "GET", "/api/admin/login", { site: "none" });
  const target = new URL(start.headers.get("location"));
  const oauth = cookiePair(start, "__Host-oauth");
  const state = tamper.state ?? target.searchParams.get("state");
  const res = await call(t, "GET", `/api/admin/callback?code=${tamper.code ?? "abcdef123456"}&state=${state}`, { site: "cross-site", headers: oauth && !tamper.noCookie ? { cookie: oauth } : {} });
  return { start, target, res, session: cookiePair(res, "__Host-sid") };
}
async function owner(t) {
  const { session } = await signIn(t);
  assert.ok(session, "owner gets a session");
  const me = await (await call(t, "GET", "/api/admin/me", { headers: { cookie: session } })).json();
  return { cookie: session, csrf: me.csrf, headers: { cookie: session, "x-csrf-token": me.csrf, "content-type": "application/json" } };
}

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n${e.stack.split("\n").slice(0, 4).join("\n")}`); process.exitCode = 1; } };
const status = async (res, code, error) => { assert.equal(res.status, code); if (error) assert.equal((await res.json()).error, error); };

/* ---- configuration ---- */
await test("without configuration every route is closed (501)", async () => {
  const t = setup({ configured: false });
  for (const p of ["/api/admin/me", "/api/admin/login", "/api/admin/feedback"]) await status(await call(t, "GET", p), 501, "closed");
});

/* ---- login ---- */
await test("login redirects to GitHub with state + PKCE (S256), no scope, and a safe state cookie", async () => {
  const t = setup();
  const { start, target } = await signIn(t);
  assert.equal(start.status, 302);
  assert.equal(target.origin + target.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(target.searchParams.get("client_id"), "cid");
  assert.equal(target.searchParams.get("code_challenge_method"), "S256");
  assert.ok(target.searchParams.get("state").length >= 30);
  assert.equal(target.searchParams.get("scope"), null);
  assert.equal(target.searchParams.get("client_secret"), null);
  const line = start.headers.getSetCookie()[0];
  for (const part of ["__Host-oauth=", "Path=/", "Secure", "HttpOnly", "SameSite=Lax", "Max-Age=600"]) assert.ok(line.includes(part), part);
  assert.ok(!line.includes("Domain"));
  assert.equal(start.headers.get("cache-control"), "no-store");
});

await test("the PKCE challenge matches the verifier that is sent at the token exchange", async () => {
  const t = setup();
  const { target } = await signIn(t);
  const verifier = t.seen.exchange[0].verifier;
  assert.equal(createHash("sha256").update(verifier).digest("base64url"), target.searchParams.get("code_challenge"));
  assert.equal(t.seen.exchange[0].code, "abcdef123456");
});

await test("owner: session cookie is HttpOnly, Secure, SameSite=Strict, host-bound, 2 h, and redirects to /admin", async () => {
  const t = setup();
  const { res } = await signIn(t);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/admin");
  const line = res.headers.getSetCookie().find((c) => c.startsWith("__Host-sid="));
  for (const part of ["Path=/", "Secure", "HttpOnly", "SameSite=Strict", `Max-Age=${LIMITS.sessionMs / 1000}`]) assert.ok(line.includes(part), part);
  assert.ok(!line.includes("Domain"));
  assert.ok(res.headers.getSetCookie().some((c) => c.startsWith("__Host-oauth=;") && c.includes("Max-Age=0")), "state cookie is cleared");
  assert.ok(!line.includes("gh-token"));
});

await test("another GitHub account is denied, gets no session, and is logged out", async () => {
  for (const user of [{ id: 9999, login: "x" }, { id: "4242", login: "x" }, { id: 42420, login: "x" }, { login: "owner-name" }, null]) {
    const t = setup({ githubUser: user });
    const { res, session } = await signIn(t);
    assert.equal(res.headers.get("location"), "/admin?e=denied");
    assert.equal(session, null);
    assert.ok(res.headers.getSetCookie().some((c) => c.startsWith("__Host-sid=;") && c.includes("Max-Age=0")));
  }
});

await test("a matching username is not enough: only the numeric id counts", async () => {
  const t = setup({ githubUser: { id: 1, login: "owner-name" } });
  assert.equal((await signIn(t)).res.headers.get("location"), "/admin?e=denied");
});

await test("callback rejects wrong state, missing state cookie, expired state, bad code, GitHub failure", async () => {
  const t = setup();
  assert.equal((await signIn(t, { tamper: { state: "wrong-state-value" } })).res.headers.get("location"), "/admin?e=failed");
  assert.equal((await signIn(t, { tamper: { noCookie: true } })).res.headers.get("location"), "/admin?e=failed");
  assert.equal((await signIn(t, { tamper: { code: "bad code!" } })).res.headers.get("location"), "/admin?e=failed");
  assert.equal(t.seen.exchange.length, 0, "GitHub is never called for a bad request");
  const slow = setup();
  const start = await call(slow, "GET", "/api/admin/login", { site: "none" });
  slow.tick(LIMITS.oauthMs + 1);
  const res = await call(slow, "GET", `/api/admin/callback?code=abcdef123456&state=${new URL(start.headers.get("location")).searchParams.get("state")}`, { site: "cross-site", headers: { cookie: cookiePair(start, "__Host-oauth") } });
  assert.equal(res.headers.get("location"), "/admin?e=failed");
  assert.equal((await signIn(setup({ exchangeFails: true }))).res.headers.get("location"), "/admin?e=failed");
});

await test("a state cookie signed with another secret is refused", async () => {
  const t = setup();
  const forged = sign(Buffer.from("not the key"), { s: "abc", v: "v", exp: t.at() + 1000 });
  const res = await call(t, "GET", "/api/admin/callback?code=abcdef123456&state=abc", { site: "cross-site", headers: { cookie: `__Host-oauth=${forged}` } });
  assert.equal(res.headers.get("location"), "/admin?e=failed");
});

await test("login and callback are rate limited", async () => {
  const t = setup();
  for (let i = 0; i < LIMITS.login.max; i++) await status(await call(t, "GET", "/api/admin/login", { site: "none" }), 302);
  const res = await call(t, "GET", "/api/admin/login", { site: "none" });
  await status(res, 429, "limit");
  assert.ok(Number(res.headers.get("retry-after")) > 0);
  // the return trip from GitHub has its own counter: a used-up sign-in counter does not block it, and it is limited on its own
  for (let i = 0; i < LIMITS.login.max; i++) await status(await call(t, "GET", "/api/admin/callback?code=abcdef123456&state=x"), 302);
  await status(await call(t, "GET", "/api/admin/callback?code=abcdef123456&state=x"), 429, "limit");
});

await test("a browser that opens an admin address gets the designed 404 page, never raw JSON", async () => {
  const t = setup();
  const nav = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "none" };
  const res = await handleAdmin(new Request(`https://${HOST}/api/admin/me`, { headers: { host: HOST, ...nav } }), t.deps);
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.ok(!(await res.text()).includes('"error"'));
  for (let i = 0; i < LIMITS.login.max; i++) await handleAdmin(new Request(`https://${HOST}/api/admin/login`, { headers: { host: HOST, "x-vercel-forwarded-for": "203.0.113.7", ...nav } }), t.deps);
  const limited = await handleAdmin(new Request(`https://${HOST}/api/admin/login`, { headers: { host: HOST, "x-vercel-forwarded-for": "203.0.113.7", ...nav } }), t.deps);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.match(limited.headers.get("content-type"), /text\/html/);
});

/* ---- session ---- */
await test("me: no cookie, garbage, tampered and foreign-signed cookies are 401", async () => {
  const t = setup();
  await status(await call(t, "GET", "/api/admin/me"), 401, "auth");
  await status(await call(t, "GET", "/api/admin/me", { headers: { cookie: "__Host-sid=garbage" } }), 401, "auth");
  const { cookie } = await owner(t);
  const [body, sig] = cookie.split("=")[1].split(".");
  const swapped = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), exp: t.at() + 9e9 })).toString("base64url");
  await status(await call(t, "GET", "/api/admin/me", { headers: { cookie: `__Host-sid=${swapped}.${sig}` } }), 401, "auth");
  await status(await call(t, "GET", "/api/admin/me", { headers: { cookie: `__Host-sid=${body}.${sig.slice(0, -2)}AA` } }), 401, "auth");
  const foreign = sign(Buffer.from("not the key"), { u: OWNER, l: "", iat: t.at(), exp: t.at() + 1e6, n: "x" });
  await status(await call(t, "GET", "/api/admin/me", { headers: { cookie: `__Host-sid=${foreign}` } }), 401, "auth");
});

await test("me: owner gets login name and a csrf token; nothing else", async () => {
  const t = setup();
  const { cookie } = await signIn(t).then((r) => ({ cookie: r.session }));
  const body = await (await call(t, "GET", "/api/admin/me", { headers: { cookie } })).json();
  assert.deepEqual(Object.keys(body).sort(), ["csrf", "exp", "login"]);
  assert.equal(body.login, "owner-name");
  assert.ok(body.csrf.length >= 40);
});

await test("an expired session is refused", async () => {
  const t = setup();
  const { cookie } = await owner(t);
  t.tick(LIMITS.sessionMs - 1000);
  await status(await call(t, "GET", "/api/admin/me", { headers: { cookie } }), 200);
  t.tick(2000);
  await status(await call(t, "GET", "/api/admin/me", { headers: { cookie } }), 401, "auth");
});

await test("a validly signed cookie for a different user id is refused", async () => {
  const t = setup();
  const { session } = await signIn(t);
  const data = verify(Buffer.alloc(0), "x"); // helper sanity: bad token gives null
  assert.equal(data, null);
  const other = setup();
  other.deps.env = { ...other.deps.env, adminId: "777" }; // same secret, the deployment now has a different owner
  await status(await call(other, "GET", "/api/admin/me", { headers: { cookie: session } }), 401, "auth");
});

await test("me refuses a cross-site request", async () => {
  const t = setup();
  const { cookie } = await owner(t);
  await status(await call(t, "GET", "/api/admin/me", { headers: { cookie }, site: "cross-site" }), 403, "origin");
  await status(await call(t, "GET", "/api/admin/me", { headers: { cookie, origin: "https://evil.example" }, site: null }), 403, "origin");
});

/* ---- logout ---- */
await test("logout needs the csrf token, and then the old cookie stops working everywhere", async () => {
  const t = setup();
  const a = await owner(t);
  t.tick(5);
  const b = await owner(t); // a second session (another device)
  await status(await call(t, "POST", "/api/admin/logout", { headers: { cookie: a.cookie } }), 403, "csrf");
  await status(await call(t, "POST", "/api/admin/logout", { headers: { cookie: a.cookie, "x-csrf-token": "nope" } }), 403, "csrf");
  await status(await call(t, "GET", "/api/admin/me", { headers: { cookie: a.cookie } }), 200);
  t.tick(5);
  const out = await call(t, "POST", "/api/admin/logout", { headers: a.headers });
  await status(out, 200);
  assert.ok(out.headers.getSetCookie()[0].includes("Max-Age=0"));
  await status(await call(t, "GET", "/api/admin/me", { headers: { cookie: a.cookie } }), 401, "auth");
  await status(await call(t, "GET", "/api/admin/me", { headers: { cookie: b.cookie } }), 401, "auth");
  await status(await call(t, "GET", "/api/admin/feedback", { headers: { cookie: a.cookie } }), 401, "auth");
  t.tick(5);
  assert.ok((await owner(t)).cookie, "signing in again works");
});

await test("logout without a session just clears the cookie; wrong origin is refused; GET is 405", async () => {
  const t = setup();
  const res = await call(t, "POST", "/api/admin/logout");
  await status(res, 200);
  assert.ok(res.headers.getSetCookie()[0].includes("Max-Age=0"));
  await status(await call(t, "POST", "/api/admin/logout", { origin: false }), 403, "origin");
  await status(await call(t, "POST", "/api/admin/logout", { headers: { origin: "https://evil.example" }, origin: false }), 403, "origin");
  await status(await call(t, "GET", "/api/admin/logout"), 405);
});

/* ---- feedback ---- */
await test("feedback GET: 401 without a session; list, count, average and unread with one", async () => {
  const t = setup();
  await status(await call(t, "GET", "/api/admin/feedback"), 401, "auth");
  const { cookie } = await owner(t);
  const body = await (await call(t, "GET", "/api/admin/feedback", { headers: { cookie } })).json();
  assert.equal(body.total, 2); assert.equal(body.unread, 1); assert.equal(body.avg, 4); assert.equal(body.pages, 1);
  assert.equal(body.items.length, 2);
  assert.deepEqual(Object.keys(body.items[0]).sort(), ["createdAt", "id", "message", "rating", "read"]);
});

await test("feedback GET validates page and size", async () => {
  const t = setup();
  const { cookie } = await owner(t);
  for (const q of ["page=0", "page=-1", "page=1.5", "page=abc", "page=501", "size=7", "size=1000", "size=x"]) {
    await status(await call(t, "GET", `/api/admin/feedback?${q}`, { headers: { cookie } }), 400, "invalid");
  }
  const paged = await (await call(t, "GET", "/api/admin/feedback?page=2&size=10", { headers: { cookie } })).json();
  assert.equal(paged.items.length, 0); assert.equal(paged.page, 2);
});

await test("PATCH marks read/unread; invalid ids, bodies and unknown ids are rejected", async () => {
  const t = setup();
  const { headers } = await owner(t);
  const path = `/api/admin/feedback/${UUID(1)}`;
  await status(await call(t, "PATCH", path, { headers, body: { read: true } }), 200);
  assert.equal(t.docs.get(UUID(1)).read, true);
  await status(await call(t, "PATCH", path, { headers, body: { read: false } }), 200);
  assert.equal(t.docs.get(UUID(1)).read, false);
  for (const body of [{}, { read: "yes" }, { read: true, rating: 1 }, [], "null", "{bad", { read: 1 }]) {
    await status(await call(t, "PATCH", path, { headers, body }), 400, "invalid");
  }
  await status(await call(t, "PATCH", path, { headers: { ...headers, "content-type": "text/plain" }, body: "{\"read\":true}" }), 415, "type");
  await status(await call(t, "PATCH", path, { headers, body: JSON.stringify({ read: true, pad: "x".repeat(2000) }) }), 413, "size");
  await status(await call(t, "PATCH", "/api/admin/feedback/not-a-uuid", { headers, body: { read: true } }), 400, "invalid");
  await status(await call(t, "PATCH", `/api/admin/feedback/${UUID(99)}`, { headers, body: { read: true } }), 404, "missing");
  await status(await call(t, "PATCH", "/api/admin/feedback/..%2F..%2Fadmin%2Fsession", { headers, body: { read: true } }), 400, "invalid");
});

await test("DELETE removes one document; a second delete is 404", async () => {
  const t = setup();
  const { headers } = await owner(t);
  await status(await call(t, "DELETE", `/api/admin/feedback/${UUID(2)}`, { headers }), 200);
  assert.equal(t.docs.size, 1);
  await status(await call(t, "DELETE", `/api/admin/feedback/${UUID(2)}`, { headers }), 404, "missing");
  await status(await call(t, "DELETE", "/api/admin/feedback/xyz", { headers }), 400, "invalid");
});

await test("changing calls fail without csrf, with a wrong csrf, with another session's csrf, or from another origin", async () => {
  const t = setup();
  const a = await owner(t);
  t.tick(5);
  const b = await owner(t);
  const path = `/api/admin/feedback/${UUID(1)}`;
  for (const method of ["PATCH", "DELETE"]) {
    const body = method === "PATCH" ? { read: true } : undefined;
    const base = { cookie: a.cookie, "content-type": "application/json" };
    await status(await call(t, method, path, { headers: base, body }), 403, "csrf");
    await status(await call(t, method, path, { headers: { ...base, "x-csrf-token": "wrong" }, body }), 403, "csrf");
    await status(await call(t, method, path, { headers: { ...base, "x-csrf-token": b.csrf }, body }), 403, "csrf");
    await status(await call(t, method, path, { headers: a.headers, body, origin: false }), 403, "origin");
    await status(await call(t, method, path, { headers: { ...a.headers, origin: "https://evil.example" }, body, origin: false }), 403, "origin");
    await status(await call(t, method, path, { headers: a.headers, body, site: "cross-site" }), 403, "origin");
    await status(await call(t, method, path, { headers: { "x-csrf-token": a.csrf, "content-type": "application/json" }, body }), 401, "auth");
  }
  assert.equal(t.docs.size, 2); assert.equal(t.docs.get(UUID(1)).read, false);
});

await test("feedback: other methods are 405 and unknown paths 404", async () => {
  const t = setup();
  const { headers } = await owner(t);
  await status(await call(t, "POST", "/api/admin/feedback", { headers, body: {} }), 405);
  await status(await call(t, "GET", `/api/admin/feedback/${UUID(1)}`, { headers }), 405);
  await status(await call(t, "DELETE", "/api/admin/feedback", { headers }), 405);
  await status(await call(t, "GET", "/api/admin/nothing"), 404);
  await status(await call(t, "GET", "/api/admin/me/extra"), 404);
  await status(await call(t, "GET", `/api/admin/feedback/${UUID(1)}/more`, { headers }), 404);
});

await test("repeated failed access is rate limited (429), real users are not affected before that", async () => {
  const t = setup();
  for (let i = 0; i < LIMITS.fail.max; i++) await status(await call(t, "GET", "/api/admin/feedback"), 401, "auth");
  const res = await call(t, "GET", "/api/admin/feedback");
  await status(res, 429, "limit");
  assert.ok(Number(res.headers.get("retry-after")) > 0);
});

await test("PATCH pins and unpins; at most 3 pinned at a time; the list also carries the pinned ones", async () => {
  const t = setup();
  for (const n of [3, 4, 5]) t.docs.set(UUID(n), { id: UUID(n), rating: 4, message: "m", createdAt: "2026-10-07T10:00:00Z", read: false });
  const { headers } = await owner(t);
  const at = (n) => `/api/admin/feedback/${UUID(n)}`;
  for (const n of [1, 2, 3]) await status(await call(t, "PATCH", at(n), { headers, body: { pinned: true } }), 200);
  await status(await call(t, "PATCH", at(4), { headers, body: { pinned: true } }), 409, "pinlimit");
  await status(await call(t, "PATCH", at(1), { headers, body: { pinned: true } }), 200); // already pinned: fine
  assert.equal(t.docs.get(UUID(4)).pinned, undefined);
  const list = await (await call(t, "GET", "/api/admin/feedback", { headers })).json();
  assert.deepEqual(list.pinned.map((x) => x.id).sort(), [UUID(1), UUID(2), UUID(3)]);
  await status(await call(t, "PATCH", at(2), { headers, body: { pinned: false } }), 200);
  await status(await call(t, "PATCH", at(4), { headers, body: { pinned: true } }), 200);
  for (const body of [{ pinned: "yes" }, { pinned: true, read: true }, { star: true }]) await status(await call(t, "PATCH", at(1), { headers, body }), 400, "invalid");
});

await test("changing calls are rate limited per window", async () => {
  const t = setup();
  const { headers } = await owner(t);
  const path = `/api/admin/feedback/${UUID(1)}`;
  for (let i = 0; i < LIMITS.write.max; i++) await status(await call(t, "PATCH", path, { headers, body: { read: true } }), 200);
  await status(await call(t, "PATCH", path, { headers, body: { read: true } }), 429, "limit");
});

/* ---- errors and headers ---- */
await test("storage failures answer a generic 500 and never grant access", async () => {
  const t = setup({ storeBroken: true });
  const res = await call(t, "GET", "/api/admin/feedback", { headers: { cookie: "__Host-sid=x" } });
  assert.equal(res.status, 500); // the failed-auth counter cannot run, so the call stops: closed, not open
  assert.equal(await res.text(), '{"error":"server"}');
  const ok = setup();
  const { cookie } = await owner(ok);
  ok.deps.store.revokedBefore = async () => { throw new Error("db password hunter2"); };
  const broken = await call(ok, "GET", "/api/admin/me", { headers: { cookie } });
  assert.equal(broken.status, 500);
  const text = await broken.text();
  assert.equal(text, '{"error":"server"}');
});

await test("every response is no-store, noindex, nosniff", async () => {
  const t = setup();
  const { headers } = await owner(t);
  const responses = [
    await call(t, "GET", "/api/admin/me"), await call(t, "GET", "/api/admin/login", { site: "none" }),
    await call(t, "GET", "/api/admin/feedback", { headers }), await call(t, "GET", "/api/admin/nothing"),
    await call(t, "POST", "/api/admin/feedback", { headers, body: {} }),
  ];
  for (const r of responses) {
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.match(r.headers.get("x-robots-tag"), /noindex/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  }
});

await test("no secret or GitHub token appears in any response body or header", async () => {
  const t = setup();
  const { headers } = await owner(t);
  const all = [await call(t, "GET", "/api/admin/me", { headers }), await call(t, "GET", "/api/admin/feedback", { headers }), await call(t, "GET", "/api/admin/login", { site: "none" })];
  for (const r of all) {
    const dump = JSON.stringify([...r.headers]) + (await r.clone().text());
    for (const secret of [SECRET, "csecret", "gh-token"]) assert.ok(!dump.includes(secret), `leaked ${secret}`);
  }
});

await test("POST /reset-limits: owner only, same origin, CSRF, POST only; writes the current time", async () => {
  const t = setup();
  const path = "/api/admin/reset-limits";
  await status(await call(t, "POST", path), 401, "auth");
  const { headers, cookie } = await owner(t);
  await status(await call(t, "GET", path, { headers }), 405, "method not allowed");
  await status(await call(t, "POST", path, { headers: { cookie } }), 403, "csrf");
  await status(await call(t, "POST", path, { headers, origin: false, site: null }), 403, "origin");
  assert.equal(t.seen.reset, undefined);
  const res = await call(t, "POST", path, { headers });
  await status(res, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.at, t.at());
  assert.equal(t.seen.reset, t.at());
});
await test("POST /reset-limits: a store failure is a plain 500", async () => {
  const t = setup();
  const { headers } = await owner(t);
  t.deps.store.resetLimits = async () => { throw new Error("secret db detail 10.0.0.1"); };
  const res = await call(t, "POST", "/api/admin/reset-limits", { headers });
  await status(res, 500);
  assert.ok(!/secret|10\.0\.0\.1/.test(JSON.stringify(await res.json())));
});

/* ---- trusted devices: at most 2 browsers that completed an owner sign-in are never rate limited ---- */
const deviceOf = (res) => cookiePair(res, "__Host-dev");
const hammer = async (t, headers = {}) => { for (let i = 0; i < LIMITS.login.max + 1; i++) await call(t, "GET", "/api/admin/login", { site: "none", headers }); return call(t, "GET", "/api/admin/login", { site: "none", headers }); };

await test("owner sign-in registers a trusted device cookie (HttpOnly, Secure, host-bound, 1 year)", async () => {
  const t = setup();
  const { res } = await signIn(t);
  const line = res.headers.getSetCookie().find((c) => c.startsWith("__Host-dev="));
  for (const part of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax", `Max-Age=${LIMITS.deviceMs / 1000}`]) assert.ok(line.includes(part), part);
  assert.ok(!line.includes("Domain"));
  assert.equal(t.trusted().length, 1);
});

await test("a trusted device is never rate limited; everyone else on the same address still is", async () => {
  const t = setup();
  const device = deviceOf((await signIn(t)).res);
  t.tick(LIMITS.login.windowMs); // fresh window
  await status(await hammer(t), 429, "limit");
  for (let i = 0; i < 40; i++) await status(await call(t, "GET", "/api/admin/login", { site: "none", headers: { cookie: device } }), 302);
});

await test("other GitHub accounts and failed sign-ins never become trusted", async () => {
  const t = setup({ githubUser: { id: 9999, login: "x" } });
  const { res } = await signIn(t);
  assert.equal(deviceOf(res), null);
  assert.deepEqual(t.trusted(), []);
});

await test("only 2 devices stay trusted: a third sign-in drops the longest-unused one", async () => {
  const t = setup();
  const a = deviceOf((await signIn(t)).res), b = deviceOf((await signIn(t)).res), c = deviceOf((await signIn(t)).res);
  assert.equal(t.trusted().length, LIMITS.trustedMax);
  t.tick(LIMITS.login.windowMs);
  await status(await hammer(t, { cookie: a }), 429, "limit");   // a was pushed off the list
  t.tick(LIMITS.login.windowMs);
  await status(await hammer(t, { cookie: b }), 302);
  await status(await hammer(t, { cookie: c }), 302);
});

await test("signing in again from a trusted device keeps its place and does not use a second slot", async () => {
  const t = setup();
  const first = deviceOf((await signIn(t)).res);
  const again = await signIn(t, {});
  assert.equal(t.trusted().length, 2); // two separate browsers (no cookie sent), as expected
  const t2 = setup();
  const d1 = deviceOf((await signIn(t2)).res);
  const start = await call(t2, "GET", "/api/admin/login", { site: "none", headers: { cookie: d1 } });
  const res = await call(t2, "GET", `/api/admin/callback?code=abcdef123456&state=${new URL(start.headers.get("location")).searchParams.get("state")}`, { site: "cross-site", headers: { cookie: `${cookiePair(start, "__Host-oauth")}; ${d1}` } });
  assert.equal(deviceOf(res), d1);
  assert.equal(t2.trusted().length, 1);
  assert.ok(first && again);
});

await test("a forged, tampered or foreign device cookie gives no exemption", async () => {
  const t = setup();
  const real = deviceOf((await signIn(t)).res);
  const [body] = real.split("=")[1].split(".");
  const forged = [`__Host-dev=${body}.AAAA`, "__Host-dev=x.y", `__Host-dev=${sign(Buffer.from("k"), { u: OWNER, d: "AAAAAAAAAAAAAAAA" })}`];
  t.tick(LIMITS.login.windowMs);
  for (const cookie of forged) { const u = setup(); await signIn(u); u.tick(LIMITS.login.windowMs); await status(await hammer(u, { cookie }), 429, "limit"); }
});

await test("a storage failure while checking trust falls back to the normal limits", async () => {
  const t = setup();
  const device = deviceOf((await signIn(t)).res);
  t.tick(LIMITS.login.windowMs);
  t.deps.store.getTrusted = async () => { throw new Error("db"); };
  await status(await hammer(t, { cookie: device }), 429, "limit");
});

await test("sign-in still works when the trusted list cannot be saved", async () => {
  const t = setup();
  t.deps.store.setTrusted = async () => { throw new Error("db"); };
  const { res, session } = await signIn(t);
  assert.ok(session);
  assert.equal(deviceOf(res), null);
});

await test("preview: form post renders the draft, needs session + CSRF, and the page cannot call our APIs", async () => {
  const { readFileSync } = await import("node:fs");
  const t = setup();
  t.deps.icons = () => [];
  t.deps.template = () => readFileSync(new URL("../templates/index.template.html", import.meta.url), "utf8");
  const content = JSON.parse(readFileSync(new URL("../content.json", import.meta.url), "utf8"));
  const o = await owner(t);
  const form = (csrf, data) => new URLSearchParams({ csrf, content: JSON.stringify(data) }).toString();
  const post = (csrf, data, cookie = o.cookie) => call(t, "POST", "/api/admin/preview", { headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: form(csrf, data) });
  assert.equal((await post("wrong", content)).status, 403);
  assert.equal((await post(o.csrf, content, "")).status, 401);
  const edited = structuredClone(content);
  edited.texts.home.about = "Preview only text zzq";
  t.deps.icons = () => [...JSON.stringify(content).matchAll(/"icon":"([\w-]+)"/g)].map((m) => m[1]);
  const ok = await post(o.csrf, edited);
  assert.equal(ok.status, 200);
  const page = await ok.text();
  assert.ok(page.includes("Preview only text zzq"));
  assert.ok(page.includes("<html data-preview") && !page.includes('const K="intro-at"') && page.includes('d.classList.add("js","is-intro")')); // entrance always plays in preview
  const csp = ok.headers.get("content-security-policy");
  assert.ok(csp.includes("frame-ancestors 'self'") && csp.includes("connect-src https://api.lanyard.rest") && !csp.includes("connect-src 'self'"));
  assert.equal(ok.headers.get("x-frame-options"), "SAMEORIGIN");
  const bad = structuredClone(content); bad.site.email = "nope";
  const res = await post(o.csrf, bad);
  assert.ok((await res.text()).includes("Fix the errors first"));
  assert.equal((await call(t, "GET", "/api/admin/preview", { headers: { cookie: o.cookie } })).status, 405);
  // A browser form post from a no-referrer page sends "Origin: null": fine for same-origin, refused for anything else.
  const opaque = (site) => call(t, "POST", "/api/admin/preview", { site, headers: { origin: "null", cookie: o.cookie, "content-type": "application/x-www-form-urlencoded" }, body: form(o.csrf, edited) });
  assert.equal((await opaque("same-origin")).status, 200);
  assert.equal((await opaque("cross-site")).status, 403);
  assert.equal((await opaque(null)).status, 403);
});

console.log(`admin: ${passed} checks passed${process.exitCode ? " (some failed)" : ""}`);
