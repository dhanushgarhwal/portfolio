// Checks the two Firestore calls behind the feedback form against a stubbed network (no real database is touched).
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
  project_id: "demo-project", client_email: "svc@demo-project.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});

const calls = [];
let lockReply = () => new Response("{}", { status: 404 });
let commitReply = null;
globalThis.fetch = async (url, init = {}) => {
  const body = init.body && typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init.body;
  calls.push({ url: String(url), init, body });
  if (String(url).includes("oauth2.googleapis.com")) return Response.json({ access_token: "tok", expires_in: 3600 });
  if (String(url).includes("/documents/ratelimit/") && init.method === "GET") return lockReply();
  if (body.writes?.[0]?.update?.name?.includes("/ratelimit/dv-") && commitReply) return commitReply();
  const writes = body.writes;
  return Response.json({ writeResults: writes.map((w, i) => (w.updateTransforms?.[0]?.increment ? { transformResults: [{ integerValue: String(i + 2) }] } : { transformResults: [{ timestampValue: "x" }] })) });
};

const { hit, addFeedback, getLock, setLock } = await import("../lib/firestore.js");
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n${e.message}`); process.exitCode = 1; } };
const DB = "projects/demo-project/databases/(default)";

await test("hit: one atomic commit, increments, expiry, returns the new counts", async () => {
  const expireAt = new Date("2026-10-10T00:00:00.000Z");
  const counts = await hit([{ id: "h-abc-1", expireAt }, { id: "d-abc-2", expireAt }]);
  assert.deepEqual(counts, [2, 3]);
  const commit = calls.find((c) => c.url.endsWith(":commit"));
  assert.equal(commit.url, `https://firestore.googleapis.com/v1/${DB}/documents:commit`);
  assert.equal(commit.init.headers.Authorization, "Bearer tok");
  const [a, b] = commit.body.writes;
  assert.equal(a.update.name, `${DB}/documents/ratelimit/h-abc-1`);
  assert.equal(b.update.name, `${DB}/documents/ratelimit/d-abc-2`);
  assert.deepEqual(a.update.fields, { expireAt: { timestampValue: "2026-10-10T00:00:00.000Z" } });
  assert.deepEqual(a.updateMask, { fieldPaths: ["expireAt"] }); // the counter itself is never overwritten
  assert.deepEqual(a.updateTransforms, [{ fieldPath: "count", increment: { integerValue: "1" } }]);
});

await test("getLock: a missing document is null, an existing one gives n, start, until and its revision", async () => {
  assert.equal(await getLock("dv-abc"), null);
  assert.equal(calls.at(-1).url, `https://firestore.googleapis.com/v1/${DB}/documents/ratelimit/dv-abc`);
  lockReply = () => Response.json({ name: `${DB}/documents/ratelimit/dv-abc`, updateTime: "2026-10-08T12:00:00.123456Z", fields: { n: { integerValue: "2" }, start: { integerValue: "1790000000000" }, until: { integerValue: "0" } } });
  assert.deepEqual(await getLock("dv-abc"), { n: 2, start: 1790000000000, until: 0, rev: "2026-10-08T12:00:00.123456Z" });
});

await test("setLock: a new record must not exist yet, an old one must be unchanged since it was read", async () => {
  const value = { n: 1, start: 1790000000000, until: 0 };
  const expireAt = new Date("2026-10-10T00:00:00.000Z");
  assert.equal(await setLock("dv-abc", value, null, expireAt), true);
  const [fresh] = calls.at(-1).body.writes;
  assert.equal(fresh.update.name, `${DB}/documents/ratelimit/dv-abc`);
  assert.deepEqual(fresh.currentDocument, { exists: false });
  assert.deepEqual(fresh.update.fields, {
    n: { integerValue: "1" }, start: { integerValue: "1790000000000" }, until: { integerValue: "0" }, expireAt: { timestampValue: "2026-10-10T00:00:00.000Z" },
  });
  assert.equal(fresh.updateMask, undefined, "the whole record is replaced, so no old field survives");
  await setLock("dv-abc", value, "2026-10-08T12:00:00.123456Z", expireAt);
  assert.deepEqual(calls.at(-1).body.writes[0].currentDocument, { updateTime: "2026-10-08T12:00:00.123456Z" });
});

await test("setLock: someone else got there first is false, any other failure throws", async () => {
  const value = { n: 1, start: 1, until: 0 }, expireAt = new Date();
  for (const status of ["FAILED_PRECONDITION", "ABORTED", "ALREADY_EXISTS"]) {
    commitReply = () => Response.json({ error: { status } }, { status: 409 });
    assert.equal(await setLock("dv-abc", value, "r", expireAt), false, status);
  }
  commitReply = () => Response.json({ error: { status: "PERMISSION_DENIED" } }, { status: 403 });
  await assert.rejects(() => setLock("dv-abc", value, "r", expireAt));
  commitReply = null;
});

await test("addFeedback: new document only, server time, read=false, typed fields", async () => {
  calls.length = 0;
  await addFeedback({ id: "id-1", rating: 5, message: "hi", ipHash: "h", ua: "u" });
  const [w] = calls.find((c) => c.url.endsWith(":commit")).body.writes;
  assert.equal(w.update.name, `${DB}/documents/feedback/id-1`);
  assert.deepEqual(w.update.fields, {
    rating: { integerValue: "5" }, message: { stringValue: "hi" }, ipHash: { stringValue: "h" }, ua: { stringValue: "u" }, read: { booleanValue: false },
  });
  assert.deepEqual(w.updateTransforms, [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }]);
  assert.deepEqual(w.currentDocument, { exists: false });
});

await test("a failed commit throws (the route turns it into a plain 500)", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes("oauth2") ? Response.json({ access_token: "tok", expires_in: 3600 }) : new Response("no", { status: 403 }));
  await assert.rejects(() => addFeedback({ id: "x", rating: 1, message: "", ipHash: "h", ua: "" }));
  globalThis.fetch = real;
});

console.log(process.exitCode ? "\nsome firestore checks failed" : `all ${passed} firestore checks passed`);
