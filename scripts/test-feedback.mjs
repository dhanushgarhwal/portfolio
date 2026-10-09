// Checks for /api/feedback (lib/feedback.js) with a fake store. Run: npm test
import assert from "node:assert/strict";
import { RULES, claimPlace, deviceId, handleFeedback, hashIp, issueToken, networkOf, readFeedback, sentCookie, systemOf, wasSent } from "../lib/feedback.js";

const SECRET = "test-secret-with-16-plus-chars";
const HOST = "site.example";
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";
const BRAVE_WIN = CHROME_WIN; // Brave sends the Chrome user agent
const FIREFOX_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";
const CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36";

// A store that behaves like the real one: records have a revision, and a write only lands if the revision is still the one that was read.
function setup({ configured = true, readThrows = false, writeThrows = false, beforeWrite = null } = {}) {
  const stored = [];
  const locks = new Map();
  let rev = 0, clock = T0;
  const store = {
    getLock: async (id) => {
      if (readThrows) throw new Error("secret db detail 10.0.0.1");
      const l = locks.get(id);
      return l ? { n: l.n, start: l.start, until: l.until, rev: l.rev } : null;
    },
    setLock: async (id, value, expected, expireAt) => {
      if (writeThrows) throw new Error("secret db detail 10.0.0.1");
      await beforeWrite?.(id, locks);
      if ((locks.get(id)?.rev ?? null) !== expected) return false;
      locks.set(id, { ...value, rev: String(++rev), expireAt });
      return true;
    },
    add: async (d) => { stored.push(d); },
  };
  const deps = { secret: configured ? SECRET : null, store: configured ? store : null, now: () => clock };
  return { deps, stored, locks, tick: (ms) => { clock += ms; }, at: () => clock };
}

const goodBody = (t, extra = {}) => ({ rating: 4, message: "nice site", form: issueToken(SECRET, t.at() - 5000), hp: "", ...extra });
const request = (path, init) => new Request(`https://${HOST}/api/feedback${path}`, init);
const post = (t, body, headers = {}) => handleFeedback(request("", {
  method: "POST",
  headers: { "content-type": "application/json", origin: `https://${HOST}`, host: HOST, "x-vercel-forwarded-for": "203.0.113.7", "user-agent": CHROME_WIN, ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
}), t.deps);
const get = (t, headers = {}) => handleFeedback(request("", { headers: { "x-vercel-forwarded-for": "203.0.113.7", "user-agent": CHROME_WIN, ...headers } }), t.deps);
const cookieOf = (res) => (res.headers.get("set-cookie") ?? "").split(";")[0];

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n${e.message}`); process.exitCode = 1; } };
const status = async (res, code, error) => {
  assert.equal(res.status, code);
  if (error) assert.equal((await res.json()).error, error);
};

/* ---- form token and state ---- */
await test("GET on a fresh visitor: state open, a form token, nothing touched", async () => {
  const t = setup();
  const res = await get(t);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.state, "open");
  assert.match(data.form, /^\d+\./);
  assert.equal(t.stored.length + t.locks.size, 0);
});

/* ---- a valid submit ---- */
await test("a valid submit is stored once, with a hashed address, and sets the 24 h cookie", async () => {
  const t = setup();
  const res = await post(t, goodBody(t));
  await status(res, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(t.stored.length, 1);
  const doc = t.stored[0];
  assert.equal(doc.rating, 4);
  assert.equal(doc.message, "nice site");
  assert.equal(doc.ipHash, hashIp(SECRET, "203.0.113.7"));
  assert.ok(!JSON.stringify(doc).includes("203.0.113.7"), "raw address must never be stored");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const cookie = res.headers.get("set-cookie");
  assert.match(cookie, /^fbs=\d+\.[\w-]+;/);
  for (const part of ["Max-Age=86400", "HttpOnly", "Secure", "SameSite=Lax", "Path=/api/feedback"]) assert.ok(cookie.includes(part), part);
  assert.ok([...t.locks.keys()].every((id) => id.startsWith("dv-") && !id.includes("203.0.113.7")), "the device record is keyed by a hash");
});

await test("rating alone is accepted", async () => {
  const t = setup();
  await status(await post(t, goodBody(t, { message: undefined })), 200);
  assert.equal(t.stored[0].message, "");
});
await test("blank message is stored empty, CRLF and blank-line runs are tidied", async () => {
  const t = setup();
  await post(t, goodBody(t, { message: "  a\r\n\r\n\r\n\r\nb  " }));
  assert.equal(t.stored[0].message, "a\n\nb");
});

for (const [name, patch] of [
  ["rating 0", { rating: 0 }], ["rating 6", { rating: 6 }], ["rating as text", { rating: "5" }],
  ["rating 2.5", { rating: 2.5 }], ["no rating", { rating: undefined }],
  ["message too long", { message: "x".repeat(RULES.maxMessage + 1) }],
  ["message not text", { message: 5 }],
  ["control character", { message: "a\u0007b" }],
  ["line separator", { message: "a\u2028b" }],
  ["unknown field", { extra: 1 }],
  ["the old Turnstile field", { cf: "token" }],
]) {
  await test(`rejects ${name}`, async () => {
    const t = setup();
    await status(await post(t, goodBody(t, patch)), 400, "invalid");
    assert.equal(t.stored.length, 0);
  });
}
await test("exactly 1000 characters (emoji counted as one) is fine", async () => {
  const t = setup();
  await status(await post(t, goodBody(t, { message: "😀".repeat(1000) })), 200);
});

await test("filled spam trap: looks like success, stores and counts nothing", async () => {
  const t = setup();
  const res = await post(t, goodBody(t, { hp: "http://spam" }));
  await status(res, 200);
  assert.equal(t.stored.length + t.locks.size, 0);
  assert.equal(res.headers.get("set-cookie"), null, "a bot must not get the cookie");
});

await test("wrong or missing origin is refused", async () => {
  const t = setup();
  await status(await post(t, goodBody(t), { origin: "https://evil.example" }), 403, "origin");
  await status(await post(t, goodBody(t), { origin: "" }), 403, "origin");
  await status(await post(t, goodBody(t), { "sec-fetch-site": "cross-site" }), 403, "origin");
  assert.equal(t.stored.length, 0);
});
await test("same-origin fetch metadata is accepted", async () => {
  const t = setup();
  await status(await post(t, goodBody(t), { "sec-fetch-site": "same-origin" }), 200);
});
await test("not JSON content type", async () => {
  const t = setup();
  await status(await post(t, goodBody(t), { "content-type": "text/plain" }), 415);
});
await test("oversized body", async () => {
  const t = setup();
  await status(await post(t, goodBody(t, { message: "x".repeat(20000) })), 413);
});
await test("broken JSON, array, null", async () => {
  const t = setup();
  await status(await post(t, "{ nope"), 400, "invalid");
  await status(await post(t, "[1]"), 400, "invalid");
  await status(await post(t, "null"), 400, "invalid");
});

await test("form token: missing, forged, other secret, future, old", async () => {
  const t = setup();
  for (const form of [undefined, "", "abc", `${t.at() - 9000}.AAAA`, issueToken("another-secret-xxxxxxxxxxxx", t.at() - 9000), issueToken(SECRET, t.at() + 60000), issueToken(SECRET, t.at() - RULES.maxAgeMs - 1000)]) {
    await status(await post(t, goodBody(t, { form })), 400, "expired");
  }
  assert.equal(t.stored.length + t.locks.size, 0);
});
await test("form token: a stamp edited after signing fails", async () => {
  const t = setup();
  const [, sig] = issueToken(SECRET, t.at() - 9000).split(".");
  await status(await post(t, goodBody(t, { form: `${t.at() - 20000}.${sig}` })), 400, "expired");
});
await test("form token: too fast is refused (and does not use a place), then fine after the wait", async () => {
  const t = setup();
  const form = issueToken(SECRET, t.at() - 1000);
  await status(await post(t, goodBody(t, { form })), 400, "fast");
  assert.equal(t.locks.size, 0);
  t.tick(RULES.minFillMs);
  await status(await post(t, goodBody(t, { form })), 200);
});

/* ---- once per browser per 24 h ---- */
await test("after sending, the same browser gets state 'sent' and cannot send again", async () => {
  const t = setup();
  const cookie = cookieOf(await post(t, goodBody(t)));
  assert.deepEqual(await (await get(t, { cookie })).json(), { state: "sent" });
  await status(await post(t, goodBody(t), { cookie }), 429, "sent");
  assert.equal(t.stored.length, 1);
  assert.equal([...t.locks.values()][0].n, 1, "the refused try did not use a place");
});
await test("the 'sent' state ends after 24 hours", async () => {
  const t = setup();
  const cookie = cookieOf(await post(t, goodBody(t)));
  t.tick(DAY - 1000);
  assert.equal((await (await get(t, { cookie })).json()).state, "sent");
  t.tick(2000);
  assert.equal((await (await get(t, { cookie })).json()).state, "open");
});
await test("a forged, edited or foreign cookie does not count as sent", async () => {
  const t = setup();
  const good = sentCookie(SECRET, t.at()).split(";")[0];
  const [name, value] = good.split("=");
  const [stamp, sig] = value.split(".");
  assert.ok(wasSent(SECRET, good, t.at()));
  assert.ok(!wasSent(SECRET, `${name}=${Number(stamp) + 1}.${sig}`, t.at()), "edited stamp");
  assert.ok(!wasSent("another-secret-xxxxxxxxxxxx", good, t.at()), "other secret");
  assert.ok(!wasSent(SECRET, `${name}=${stamp}.${"A".repeat(43)}`, t.at()), "made-up signature");
  assert.ok(!wasSent(SECRET, "", t.at()) && !wasSent(SECRET, undefined, t.at()));
  assert.ok(!wasSent(SECRET, sentCookie(SECRET, t.at() + 3_600_000).split(";")[0], t.at()), "from the future");
});

/* ---- three per device, across browsers and private windows ---- */
await test("a device may send 3; the 4th is refused with a retry time, from any browser", async () => {
  const t = setup();
  // three "different browsers or private windows": no cookie is carried over, even the user agent differs
  await status(await post(t, goodBody(t), { "user-agent": CHROME_WIN }), 200);
  await status(await post(t, goodBody(t), { "user-agent": FIREFOX_WIN }), 200);
  await status(await post(t, goodBody(t), { "user-agent": BRAVE_WIN }), 200);
  assert.equal(t.stored.length, 3);
  for (const ua of [CHROME_WIN, FIREFOX_WIN, "Mozilla/5.0 (Windows NT 10.0) Edg/130"]) {
    const res = await post(t, goodBody(t), { "user-agent": ua });
    await status(res, 429, "limit");
    assert.equal(res.headers.get("retry-after"), String(DAY / 1000));
  }
  assert.equal(t.stored.length, 3, "nothing more was stored");
});
await test("a blocked device sees state 'blocked' with the seconds left, in every browser", async () => {
  const t = setup();
  for (let i = 0; i < 3; i++) await post(t, goodBody(t), { "user-agent": i % 2 ? FIREFOX_WIN : CHROME_WIN });
  t.tick(3600 * 1000);
  for (const ua of [CHROME_WIN, FIREFOX_WIN]) {
    const data = await (await get(t, { "user-agent": ua })).json();
    assert.equal(data.state, "blocked");
    assert.equal(data.retry, DAY / 1000 - 3600);
    assert.equal(data.form, undefined, "no form token for a blocked device");
  }
});
await test("the block lasts 24 hours from the 3rd feedback, then the device is open again", async () => {
  const t = setup();
  for (let i = 0; i < 3; i++) { await post(t, goodBody(t)); if (i < 2) t.tick(60_000); }
  t.tick(DAY - 2000);                                      // 2 s before 24 h after the 3rd
  await status(await post(t, goodBody(t)), 429, "limit");
  t.tick(2500);
  assert.equal((await (await get(t)).json()).state, "open");
  await status(await post(t, goodBody(t)), 200);
  assert.equal(t.stored.length, 4);
});
await test("the count starts over 24 hours after a device's first feedback", async () => {
  const t = setup();
  await post(t, goodBody(t)); await post(t, goodBody(t));
  t.tick(DAY + 1000);
  await status(await post(t, goodBody(t)), 200);          // would be the 3rd, but the old two are a day old
  await status(await post(t, goodBody(t)), 200);
  await status(await post(t, goodBody(t)), 200);          // 3rd of the new count
  await status(await post(t, goodBody(t)), 429, "limit");
});
await test("limits belong to one device: another address, another operating system, or another network are untouched", async () => {
  const t = setup();
  for (let i = 0; i < 3; i++) await post(t, goodBody(t));
  await status(await post(t, goodBody(t)), 429, "limit");
  await status(await post(t, goodBody(t), { "x-vercel-forwarded-for": "198.51.100.9" }), 200);                  // someone else
  await status(await post(t, goodBody(t), { "user-agent": CHROME_ANDROID }), 200);                              // same address, a phone
  assert.equal((await (await get(t, { "x-vercel-forwarded-for": "198.51.100.9" })).json()).state, "open");
});
await test("IPv6: the same /64 is one device, a different /64 is another", async () => {
  const t = setup();
  const at = (ip) => ({ "x-vercel-forwarded-for": ip });
  await post(t, goodBody(t), at("2401:4900:1234:5678:aaaa:bbbb:cccc:dddd"));
  await post(t, goodBody(t), at("2401:4900:1234:5678:1111:2222:3333:4444"));
  await post(t, goodBody(t), at("2401:4900:1234:5678::9"));
  await status(await post(t, goodBody(t), at("2401:4900:1234:5678:5:6:7:8")), 429, "limit");
  await status(await post(t, goodBody(t), at("2401:4900:1234:9999::1")), 200);
});
await test("two feedbacks at the same moment cannot both take the last place", async () => {
  const t = setup();
  await post(t, goodBody(t)); await post(t, goodBody(t));
  const results = await Promise.all([post(t, goodBody(t)), post(t, goodBody(t))]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 429]);
  assert.equal(t.stored.length, 3);
});
await test("slow database: both requests read '2 used' before either writes, still only one gets the last place", async () => {
  const t = setup();
  await post(t, goodBody(t)); await post(t, goodBody(t));
  const read = t.deps.store.getLock;
  t.deps.store.getLock = async (id) => { const v = await read(id); await new Promise((r) => setTimeout(r, 15)); return v; }; // both reads finish before any write
  const results = await Promise.all([post(t, goodBody(t)), post(t, goodBody(t)), post(t, goodBody(t))]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 429, 429]);
  assert.equal(t.stored.length, 3, "exactly 3 feedbacks stored, never 4");
});
await test("a record changed by someone else between read and write is retried, not overwritten", async () => {
  let once = true;
  const t = setup({ beforeWrite: (id, locks) => { if (once) { once = false; locks.set(id, { n: 1, start: T0, until: 0, rev: "other" }); } } });
  await status(await post(t, goodBody(t)), 200);
  assert.equal([...t.locks.values()][0].n, 2, "their count was kept and ours added");
});
await test("claimPlace gives up after repeated conflicts", async () => {
  const store = { getLock: async () => null, setLock: async () => false };
  await assert.rejects(() => claimPlace(store, "dv-x", T0), /busy/);
});
await test("device records expire a day after they stop mattering (for the optional TTL policy)", async () => {
  const t = setup();
  await post(t, goodBody(t));
  assert.ok([...t.locks.values()][0].expireAt.getTime() >= T0 + DAY + DAY);
});

await test("no address at all (local testing) does not put every visitor into one device", async () => {
  const t = setup();
  const bare = (ua) => ({ "x-vercel-forwarded-for": "", "x-real-ip": "", "x-forwarded-for": "", "user-agent": ua });
  assert.notEqual(deviceId(SECRET, "", "A"), deviceId(SECRET, "", "B"));
  for (let i = 0; i < 3; i++) await post(t, goodBody(t), bare("one"));
  await status(await post(t, goodBody(t), bare("one")), 429, "limit");
  await status(await post(t, goodBody(t), bare("two")), 200);
});

/* ---- helpers ---- */
await test("networkOf: IPv4, IPv6 /64, IPv4-mapped, zone ids", () => {
  assert.equal(networkOf("203.0.113.7"), "203.0.113.7");
  assert.equal(networkOf("2401:4900:1234:5678:aaaa:bbbb:cccc:dddd"), "2401:4900:1234:5678");
  assert.equal(networkOf("2401:4900:1234:5678::1"), "2401:4900:1234:5678");
  assert.equal(networkOf("2001:db8::"), "2001:db8:0:0");
  assert.equal(networkOf("::ffff:1.2.3.4"), "1.2.3.4");
  assert.equal(networkOf("FE80::1%eth0"), "fe80:0:0:0");
});
await test("systemOf: the same device gives the same system in every browser", () => {
  assert.equal(systemOf(CHROME_WIN), "windows");
  assert.equal(systemOf(FIREFOX_WIN), "windows");
  assert.equal(systemOf(CHROME_ANDROID), "android");
  assert.equal(systemOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari"), "ios");
  assert.equal(systemOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari"), "mac");
  assert.equal(systemOf("Mozilla/5.0 (X11; Linux x86_64) Firefox"), "linux");
  assert.equal(systemOf(""), "other");
  assert.equal(deviceId(SECRET, "203.0.113.7", CHROME_WIN), deviceId(SECRET, "203.0.113.7", FIREFOX_WIN));
});

/* ---- the rest ---- */
await test("not configured: closed, and says so only as 501", async () => {
  const t = setup({ configured: false });
  await status(await post(t, goodBody(t)), 501, "closed");
  await status(await get(t), 501);
});
await test("other methods", async () => {
  const t = setup();
  for (const method of ["PUT", "DELETE", "PATCH"]) await status(await handleFeedback(request("", { method }), t.deps), 405);
});
await test("a database error on submit is a plain 500 with no details", async () => {
  for (const opts of [{ readThrows: true }, { writeThrows: true }]) {
    const t = setup(opts);
    const res = await post(t, goodBody(t));
    await status(res, 500);
    const text = JSON.stringify(await res.json());
    assert.ok(!/secret|10\.0\.0\.1|db/i.test(text));
    assert.equal(t.stored.length, 0);
    assert.equal(res.headers.get("set-cookie"), null);
  }
});
await test("a database error on GET still shows the form (the submit is checked again)", async () => {
  const t = setup({ readThrows: true });
  assert.equal((await (await get(t)).json()).state, "open");
});
await test("user agent is trimmed and cleaned", async () => {
  const t = setup();
  await post(t, goodBody(t), { "user-agent": "A".repeat(500) });
  assert.equal(t.stored[0].ua.length, RULES.maxUa);
});
await test("owner reset: a blocked device and a \"sent\" browser can send again, and the count starts over", async () => {
  const t = setup();
  let resetAt = 0;
  t.deps.store.getReset = async () => resetAt;
  let cookie = "";
  for (let i = 0; i < RULES.perDevice; i++) {
    t.tick(5000);
    const res = await post(t, goodBody(t), { cookie: "" });
    await status(res, 200);
    cookie = cookieOf(res);
  }
  t.tick(5000);
  await status(await post(t, goodBody(t), { cookie: "" }), 429, "limit");
  assert.equal((await (await get(t, { cookie: "" })).json()).state, "blocked");
  assert.equal((await (await get(t, { cookie })).json()).state, "sent");
  resetAt = t.at();
  t.tick(1000);
  assert.equal((await (await get(t, { cookie })).json()).state, "open");
  await status(await post(t, goodBody(t), { cookie }), 200);
  assert.equal(t.stored.length, RULES.perDevice + 1);
  t.tick(5000);
  await status(await post(t, goodBody(t), { cookie: "" }), 200); // second place of a fresh count, not blocked
});
await test("a reset that cannot be read keeps the limits in force", async () => {
  const t = setup();
  t.deps.store.getReset = async () => { throw new Error("down"); };
  for (let i = 0; i < RULES.perDevice; i++) { t.tick(5000); await status(await post(t, goodBody(t), { cookie: "" }), 200); }
  t.tick(5000);
  await status(await post(t, goodBody(t), { cookie: "" }), 429, "limit");
});
await test("readFeedback unit", () => {
  assert.deepEqual(readFeedback({ rating: 5 }), { rating: 5, message: "" });
  assert.equal(readFeedback({ rating: 5, message: "a\u0000" }), null);
});

console.log(process.exitCode ? "\nsome feedback checks failed" : `all ${passed} feedback checks passed`);
