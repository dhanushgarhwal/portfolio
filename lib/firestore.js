// Firestore over REST, no dependencies. FIREBASE_SERVICE_ACCOUNT holds the key JSON (or its base64).
// The counter is the field `count` of the document stats/views.
const SCOPE = "https://www.googleapis.com/auth/datastore";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TIMEOUT_MS = 4000;
const REFRESH_MARGIN_MS = 60_000;

let account = null; // parsed service account
let signingKey = null; // imported private key (Promise)
let token = null; // { value, until }
let exchange = null; // token request in flight, shared by concurrent calls

export const isConfigured = () => Boolean(process.env.FIREBASE_SERVICE_ACCOUNT?.trim());

function loadAccount() {
  if (!account) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
    const { project_id, client_email, private_key } = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
    account = { projectId: project_id, email: client_email, pem: private_key };
  }
  return account;
}

const b64url = (value) => Buffer.from(value).toString("base64url");

function importKey(pem) {
  const der = Buffer.from(pem.replace(/-----[A-Z ]+-----|\s/g, ""), "base64");
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

async function signedJwt() {
  const { email, pem } = loadAccount();
  signingKey ??= importKey(pem);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }))}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await signingKey, Buffer.from(unsigned));
  return `${unsigned}.${b64url(signature)}`;
}

async function requestToken() {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await signedJwt() }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error("token");
  const { access_token, expires_in } = await res.json();
  token = { value: access_token, until: Date.now() + expires_in * 1000 - REFRESH_MARGIN_MS };
  return token.value;
}

export function getToken() {
  if (token && Date.now() < token.until) return Promise.resolve(token.value);
  exchange ??= requestToken().finally(() => { exchange = null; });
  return exchange;
}

const database = () => `projects/${loadAccount().projectId}/databases/(default)`;
const call = async (url, init) => fetch(url, {
  ...init,
  headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" },
  signal: AbortSignal.timeout(TIMEOUT_MS),
});
const API = "https://firestore.googleapis.com/v1";
const docName = (path) => `${database()}/documents/${path}`;
const commit = async (writes) => {
  const res = await call(`${API}/${database()}/documents:commit`, { method: "POST", body: JSON.stringify({ writes }) });
  if (!res.ok) throw new Error("commit");
  return (await res.json()).writeResults;
};
// One document by path: its parsed JSON, or null when it does not exist. Any other failure throws.
const readDoc = async (path) => {
  const res = await call(`${API}/${docName(path)}`, { method: "GET" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("read");
  return res.json();
};

// +1 in one round trip: an atomic server-side increment (it also creates the document if it is missing); returns the new total.
export async function addView() {
  const [result] = await commit([{
    update: { name: docName("stats/views"), fields: {} },
    updateMask: { fieldPaths: [] },
    updateTransforms: [{ fieldPath: "count", increment: { integerValue: "1" } }],
  }]);
  return Number(result.transformResults[0].integerValue);
}

// Current total; 0 when the document does not exist yet.
export async function readViews() {
  const fields = (await readDoc("stats/views"))?.fields;
  return Number(fields?.count?.integerValue ?? fields?.count?.doubleValue ?? 0);
}

// ---- feedback form ----
const errorStatus = async (res) => (await res.json().catch(() => ({})))?.error?.status; // Firestore's error name, e.g. "NOT_FOUND"

// +1 on each counter document in ONE atomic round trip; returns the new totals in the same order.
// Documents live in the collection `ratelimit`; `expireAt` lets a Firestore TTL policy clean them up.
export async function hit(buckets) {
  const results = await commit(buckets.map(({ id, expireAt }) => ({
    update: { name: docName(`ratelimit/${id}`), fields: { expireAt: { timestampValue: expireAt.toISOString() } } },
    updateMask: { fieldPaths: ["expireAt"] },
    updateTransforms: [{ fieldPath: "count", increment: { integerValue: "1" } }],
  })));
  return results.map((r) => Number(r.transformResults[0].integerValue));
}

// Per-device feedback limit: one small document per device in `ratelimit` ({ n, start, until }, all in ms), read and written in two steps.
// `rev` is the document's updateTime; setLock only succeeds when the document is still exactly as it was read (null = it must not exist yet),
// so two requests at the same moment cannot both take the last place. Returns false when someone else changed it first.
export async function getLock(id) {
  const doc = await readDoc(`ratelimit/${id}`);
  if (!doc) return null;
  const num = (field) => Number(doc.fields?.[field]?.integerValue ?? 0);
  return { n: num("n"), start: num("start"), until: num("until"), rev: doc.updateTime };
}

export async function setLock(id, { n, start, until }, rev, expireAt) {
  const res = await call(`${API}/${database()}/documents:commit`, {
    method: "POST",
    body: JSON.stringify({ writes: [{
      update: { name: docName(`ratelimit/${id}`), fields: {
        n: { integerValue: String(n) }, start: { integerValue: String(start) }, until: { integerValue: String(until) },
        expireAt: { timestampValue: expireAt.toISOString() },
      } },
      currentDocument: rev ? { updateTime: rev } : { exists: false },
    }] }),
  });
  if (res.ok) return true;
  const status = await errorStatus(res);
  if (status === "FAILED_PRECONDITION" || status === "ABORTED" || status === "ALREADY_EXISTS") return false;
  throw new Error("commit");
}

// One new document in `feedback`; createdAt is the server's clock, and an id that already exists is refused.
export async function addFeedback({ id, rating, message, ipHash, ua }) {
  await commit([{
    update: {
      name: docName(`feedback/${id}`),
      fields: {
        rating: { integerValue: String(rating) },
        message: { stringValue: message },
        ipHash: { stringValue: ipHash },
        ua: { stringValue: ua },
        read: { booleanValue: false },
      },
    },
    updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }],
    currentDocument: { exists: false },
  }]);
}

// Owner's "reset limits": one timestamp (ms) in admin/feedbackReset. Every limit record and "thank you" cookie made at or before it stops counting,
// so a reset is a single write instead of a sweep over the `ratelimit` collection.
export async function getLimitReset() {
  return Number((await readDoc("admin/feedbackReset"))?.fields?.at?.integerValue ?? 0);
}
export async function resetLimits(ms) {
  await commit([{
    update: { name: docName("admin/feedbackReset"), fields: { at: { integerValue: String(ms) } } },
    updateMask: { fieldPaths: ["at"] },
  }]);
}

// ---- admin: feedback viewer + session revocation ----
const parseDoc = (d) => {
  const f = d.fields ?? {};
  return {
    id: d.name.split("/").pop(),
    rating: Number(f.rating?.integerValue ?? 0),
    message: f.message?.stringValue ?? "",
    createdAt: f.createdAt?.timestampValue ?? null,
    read: f.read?.booleanValue === true,
    pinned: f.pinned?.booleanValue === true,
  };
};

// One page of feedback, newest first. ipHash and ua are deliberately not returned.
export async function listFeedback({ offset, limit }) {
  const res = await call(`${API}/${database()}/documents:runQuery`, {
    method: "POST",
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: "feedback" }],
      orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
      offset, limit,
    } }),
  });
  if (!res.ok) throw new Error("query");
  return (await res.json()).filter((row) => row.document).map((row) => parseDoc(row.document));
}

// Every pinned feedback (the admin allows at most 3, so this is a handful of documents), newest first.
export async function listPinned() {
  const res = await call(`${API}/${database()}/documents:runQuery`, {
    method: "POST",
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: "feedback" }],
      where: { fieldFilter: { field: { fieldPath: "pinned" }, op: "EQUAL", value: { booleanValue: true } } },
      limit: 10,
    } }),
  });
  if (!res.ok) throw new Error("query");
  return (await res.json()).filter((row) => row.document).map((row) => parseDoc(row.document))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// { total, avg (null when empty), unread } with two aggregation queries (server-side, no documents are read back).
export async function feedbackStats() {
  const run = async (aggregations, where) => {
    const res = await call(`${API}/${database()}/documents:runAggregationQuery`, {
      method: "POST",
      body: JSON.stringify({ structuredAggregationQuery: {
        aggregations,
        structuredQuery: { from: [{ collectionId: "feedback" }], ...(where ? { where } : {}) },
      } }),
    });
    if (!res.ok) throw new Error("aggregate");
    return (await res.json())[0]?.result?.aggregateFields ?? {};
  };
  const [all, unread] = await Promise.all([
    run([{ alias: "n", count: {} }, { alias: "avg", avg: { field: { fieldPath: "rating" } } }]),
    run([{ alias: "n", count: {} }], { fieldFilter: { field: { fieldPath: "read" }, op: "EQUAL", value: { booleanValue: false } } }),
  ]);
  const avg = all.avg?.doubleValue ?? (all.avg?.integerValue !== undefined ? Number(all.avg.integerValue) : null);
  return { total: Number(all.n?.integerValue ?? 0), avg: avg === null ? null : Number(avg), unread: Number(unread.n?.integerValue ?? 0) };
}

// A write that must hit an existing document: returns false when the document is not there.
async function existingWrite(write) {
  const res = await call(`${API}/${database()}/documents:commit`, { method: "POST", body: JSON.stringify({ writes: [{ ...write, currentDocument: { exists: true } }] }) });
  if (res.ok) return true;
  if (res.status === 404 || res.status === 400) {
    const status = await errorStatus(res);
    if (status === "NOT_FOUND" || status === "FAILED_PRECONDITION") { console.error("firestore: document missing", res.status, status); return false; }
  }
  console.error("firestore: write failed", res.status);
  throw new Error("commit");
}
export const setFeedbackRead = (id, read) => existingWrite({
  update: { name: docName(`feedback/${id}`), fields: { read: { booleanValue: read } } },
  updateMask: { fieldPaths: ["read"] },
});
export const setFeedbackPinned = (id, pinned) => existingWrite({
  update: { name: docName(`feedback/${id}`), fields: { pinned: { booleanValue: pinned } } },
  updateMask: { fieldPaths: ["pinned"] },
});
export const deleteFeedback = (id) => existingWrite({ delete: docName(`feedback/${id}`) });

// Logout writes a timestamp; every session issued before it stops working (admin/session.revokedBefore, ms).
export async function revokedBefore() {
  return Number((await readDoc("admin/session"))?.fields?.revokedBefore?.integerValue ?? 0);
}
export async function revokeSessions(ms) {
  await commit([{
    update: { name: docName("admin/session"), fields: { revokedBefore: { integerValue: String(ms) } } },
    updateMask: { fieldPaths: ["revokedBefore"] },
  }]);
}

// Trusted devices (admin/trusted.ids): ids of the browsers that completed an owner sign-in and are exempt from the admin rate limits. At most 2, oldest first.
export async function getTrusted() {
  const values = (await readDoc("admin/trusted"))?.fields?.ids?.arrayValue?.values ?? [];
  return values.map((v) => v.stringValue).filter((v) => typeof v === "string");
}
export async function setTrusted(ids) {
  await commit([{
    update: { name: docName("admin/trusted"), fields: { ids: { arrayValue: { values: ids.map((stringValue) => ({ stringValue })) } } } },
    updateMask: { fieldPaths: ["ids"] },
  }]);
}
