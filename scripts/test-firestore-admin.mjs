// Request shapes of the admin's Firestore calls (feedback list, stats, mark read, delete, session revocation) against a stubbed network.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
  project_id: "demo-project", client_email: "svc@demo-project.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});

const calls = [];
let next = () => Response.json({});
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes("oauth2.googleapis.com")) return Response.json({ access_token: "tok", expires_in: 3600 });
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ url: String(url), method: init.method, body, auth: init.headers.Authorization });
  return next(body, String(url));
};
const fs = await import("../lib/firestore.js");
const DB = "projects/demo-project/databases/(default)";
const API = `https://firestore.googleapis.com/v1/${DB}/documents`;
let passed = 0;
const test = async (name, fn) => { calls.length = 0; try { await fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n${e.message}`); process.exitCode = 1; } };
const doc = (id, f) => ({ document: { name: `${DB}/documents/feedback/${id}`, fields: f }, readTime: "t" });

await test("listFeedback: newest first, offset + limit, typed parse, no ipHash or user agent returned", async () => {
  next = () => Response.json([
    doc("a", { rating: { integerValue: "4" }, message: { stringValue: "hi" }, createdAt: { timestampValue: "2026-10-08T10:00:00Z" }, read: { booleanValue: true }, ipHash: { stringValue: "SECRET" }, ua: { stringValue: "UA" } }),
    doc("b", { rating: { integerValue: "1" } }),
    { readTime: "t" },
  ]);
  const items = await fs.listFeedback({ offset: 20, limit: 10 });
  const [c] = calls;
  assert.equal(c.url, `${API}:runQuery`); assert.equal(c.method, "POST"); assert.equal(c.auth, "Bearer tok");
  assert.deepEqual(c.body.structuredQuery, { from: [{ collectionId: "feedback" }], orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }], offset: 20, limit: 10 });
  assert.deepEqual(items, [
    { id: "a", rating: 4, message: "hi", createdAt: "2026-10-08T10:00:00Z", read: true, pinned: false },
    { id: "b", rating: 1, message: "", createdAt: null, read: false, pinned: false },
  ]);
  assert.ok(!JSON.stringify(items).includes("SECRET"));
});

await test("feedbackStats: count + average, and a count of read == false", async () => {
  next = (body) => Response.json([{ result: { aggregateFields: body.structuredAggregationQuery.structuredQuery.where ? { n: { integerValue: "2" } } : { n: { integerValue: "7" }, avg: { doubleValue: 4.25 } } } }]);
  assert.deepEqual(await fs.feedbackStats(), { total: 7, avg: 4.25, unread: 2 });
  const queries = calls.map((c) => c.body.structuredAggregationQuery);
  assert.ok(calls.every((c) => c.url === `${API}:runAggregationQuery`));
  const plain = queries.find((q) => !q.structuredQuery.where), unread = queries.find((q) => q.structuredQuery.where);
  assert.deepEqual(plain.aggregations, [{ alias: "n", count: {} }, { alias: "avg", avg: { field: { fieldPath: "rating" } } }]);
  assert.deepEqual(unread.structuredQuery.where, { fieldFilter: { field: { fieldPath: "read" }, op: "EQUAL", value: { booleanValue: false } } });
});

await test("feedbackStats: empty collection gives avg null, whole-number average is read as a number", async () => {
  next = () => Response.json([{ result: { aggregateFields: { n: { integerValue: "0" }, avg: { nullValue: null } } } }]);
  assert.deepEqual(await fs.feedbackStats(), { total: 0, avg: null, unread: 0 });
  next = () => Response.json([{ result: { aggregateFields: { n: { integerValue: "2" }, avg: { integerValue: "4" } } } }]);
  assert.equal((await fs.feedbackStats()).avg, 4);
});

await test("setFeedbackRead: only the read field, only an existing document", async () => {
  next = () => Response.json({ writeResults: [{}] });
  assert.equal(await fs.setFeedbackRead("id-1", true), true);
  const [w] = calls[0].body.writes;
  assert.equal(calls[0].url, `${API}:commit`);
  assert.deepEqual(w, { update: { name: `${DB}/documents/feedback/id-1`, fields: { read: { booleanValue: true } } }, updateMask: { fieldPaths: ["read"] }, currentDocument: { exists: true } });
});

await test("deleteFeedback: one delete, only an existing document", async () => {
  next = () => Response.json({ writeResults: [{}] });
  assert.equal(await fs.deleteFeedback("id-1"), true);
  assert.deepEqual(calls[0].body.writes, [{ delete: `${DB}/documents/feedback/id-1`, currentDocument: { exists: true } }]);
});

await test("a missing document is false (not an error); any other failure throws", async () => {
  next = () => Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
  assert.equal(await fs.deleteFeedback("gone"), false);
  next = () => Response.json({ error: { status: "FAILED_PRECONDITION" } }, { status: 400 });
  assert.equal(await fs.setFeedbackRead("gone", true), false);
  next = () => Response.json({ error: { status: "PERMISSION_DENIED" } }, { status: 403 });
  await assert.rejects(() => fs.deleteFeedback("x"));
  next = () => new Response("boom", { status: 500 });
  await assert.rejects(() => fs.setFeedbackRead("x", false));
  next = () => Response.json({ error: { status: "INVALID_ARGUMENT" } }, { status: 400 });
  await assert.rejects(() => fs.setFeedbackRead("x", false));
});

await test("revokedBefore: 0 when never set, the stored number otherwise; revokeSessions writes only that field", async () => {
  next = () => new Response("{}", { status: 404 });
  assert.equal(await fs.revokedBefore(), 0);
  assert.equal(calls[0].url, `${API}/admin/session`); assert.equal(calls[0].method, "GET");
  next = () => Response.json({ fields: { revokedBefore: { integerValue: "1790000000000" } } });
  assert.equal(await fs.revokedBefore(), 1790000000000);
  next = () => new Response("no", { status: 500 });
  await assert.rejects(() => fs.revokedBefore());
  calls.length = 0;
  next = () => Response.json({ writeResults: [{}] });
  await fs.revokeSessions(1790000000123);
  assert.deepEqual(calls[0].body.writes, [{ update: { name: `${DB}/documents/admin/session`, fields: { revokedBefore: { integerValue: "1790000000123" } } }, updateMask: { fieldPaths: ["revokedBefore"] } }]);
});

await test("getLimitReset: 0 when never set, the stored number otherwise; resetLimits writes only that field", async () => {
  next = () => new Response("{}", { status: 404 });
  assert.equal(await fs.getLimitReset(), 0);
  assert.equal(calls[0].url, `${API}/admin/feedbackReset`);
  next = () => Response.json({ fields: { at: { integerValue: "1790000000000" } } });
  assert.equal(await fs.getLimitReset(), 1790000000000);
  next = () => new Response("no", { status: 500 });
  await assert.rejects(() => fs.getLimitReset());
  calls.length = 0;
  next = () => Response.json({ writeResults: [{}] });
  await fs.resetLimits(1790000000456);
  assert.deepEqual(calls[0].body.writes, [{ update: { name: `${DB}/documents/admin/feedbackReset`, fields: { at: { integerValue: "1790000000456" } } }, updateMask: { fieldPaths: ["at"] } }]);
});

console.log(process.exitCode ? "\nsome admin firestore checks failed" : `admin firestore: ${passed} checks passed`);
