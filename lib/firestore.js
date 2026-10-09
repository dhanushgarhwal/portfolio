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
const call = async (url, init) => {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return res;
};
const API = "https://firestore.googleapis.com/v1";

// +1 in one round trip: an atomic server-side increment (it also creates the document if it is missing); returns the new total.
export async function addView() {
  const db = database();
  const res = await call(`${API}/${db}/documents:commit`, {
    method: "POST",
    body: JSON.stringify({
      writes: [{
        update: { name: `${db}/documents/stats/views`, fields: {} },
        updateMask: { fieldPaths: [] },
        updateTransforms: [{ fieldPath: "count", increment: { integerValue: "1" } }],
      }],
    }),
  });
  if (!res.ok) throw new Error("commit");
  const { writeResults } = await res.json();
  return Number(writeResults[0].transformResults[0].integerValue);
}

// Current total; 0 when the document does not exist yet.
export async function readViews() {
  const res = await call(`${API}/${database()}/documents/stats/views`, { method: "GET" });
  if (res.status === 404) return 0;
  if (!res.ok) throw new Error("read");
  const { fields } = await res.json();
  return Number(fields?.count?.integerValue ?? fields?.count?.doubleValue ?? 0);
}
