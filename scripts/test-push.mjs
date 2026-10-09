// Checks: atomic push (blobs -> tree -> commit -> ref), conflict safety, path whitelist, picture checks, limits, no leaks. Run: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cleanMessage, decodePicture, handleAdmin } from "../lib/admin.js";
import { makeRepo } from "../lib/repo.js";
import { iconsIn } from "./render.mjs";

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n${e.stack.split("\n").slice(0, 5).join("\n")}`); process.exitCode = 1; } };
const content = () => JSON.parse(readFileSync(new URL("../content.json", import.meta.url), "utf8"));
const icons = iconsIn(readFileSync(new URL("../templates/index.template.html", import.meta.url), "utf8"));

/* ---- fake GitHub with write endpoints ---- */
const SHA = "a".repeat(40), TREE = "b".repeat(40), BLOB = "c".repeat(40);
const hex = (prefix, n) => `${prefix}${String(n).padStart(39, "0")}`;
const REPO_FILES = ["public/image/favicon.png", "public/image/favicon-sm.png", "public/image/og.png", "public/image/portfolio.webp", "public/skill/git.svg", "public/skill/old.svg"];
function fakeGithub({ failAt = null, failStatus = 500, refStatus = 200, headAfter = null, status = null } = {}) {
  const log = [];
  const state = { head: SHA };
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const path = url.replace("https://api.github.com/repos/o/r/", "");
    const body = init.body ? JSON.parse(init.body) : null;
    log.push({ method, path, body });
    assert.equal(init.headers.Authorization, "Bearer tok");
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    if (failAt && `${method} ${path.split("?")[0]}`.startsWith(failAt)) return json({ message: "ghp_SECRET" }, failStatus);
    if (method === "GET" && path === "git/ref/heads/main") { if (headAfter && log.filter((l) => l.path === "git/ref/heads/main").length > 1) state.head = headAfter; return json({ object: { sha: state.head } }); }
    if (method === "GET" && path === `git/commits/${SHA}`) return json({ tree: { sha: TREE } });
    if (method === "GET" && path === `git/trees/${TREE}?recursive=1`) return json({ truncated: false, tree: REPO_FILES.map((p) => ({ path: p, type: "blob", size: 10 })) });
    if (method === "GET" && path === `git/trees/${TREE}`) return json({ tree: [{ path: "content.json", type: "blob", sha: BLOB }] });
    if (method === "GET" && path === `git/blobs/${BLOB}`) return json({ encoding: "base64", content: Buffer.from(JSON.stringify(content())).toString("base64") });
    if (method === "POST" && path === "git/blobs") return json({ sha: hex("d", log.length) }, 201);
    if (method === "POST" && path === "git/trees") return json({ sha: hex("e", log.length) }, 201);
    if (method === "POST" && path === "git/commits") return json({ sha: hex("f", log.length) }, 201);
    if (method === "PATCH" && path === "git/refs/heads/main") { if (refStatus !== 200) return json({ message: "no" }, refStatus); state.head = body.sha; return json({ ref: "x" }); }
    if (method === "GET" && path.startsWith("commits/") && path.endsWith("/status")) return status ? status() : json({ state: "success", total_count: 1 });
    return json({}, 404);
  };
  const writes = () => log.filter((l) => l.method !== "GET");
  return { log, state, writes, repo: makeRepo({ token: "tok", repo: "o/r", branch: "main" }, fetchImpl) };
}

/* ---- request helpers (same shapes as the other admin tests) ---- */
const HOST = "site.example", SECRET = "s".repeat(40), T0 = Date.UTC(2026, 9, 8, 12);
function setup(g = fakeGithub(), { repo = g.repo } = {}) {
  const counters = new Map();
  return {
    g, counters,
    env: { clientId: "cid", clientSecret: "cs", adminId: "4242", secret: SECRET },
    github: { exchange: async () => "t", user: async () => ({ id: 4242, login: "me" }) },
    store: { hit: async (b) => b.map(({ id }) => { counters.set(id, (counters.get(id) ?? 0) + 1); return counters.get(id); }), revokedBefore: async () => 0, revokeSessions: async () => {}, list: async () => [], stats: async () => ({}), setRead: async () => true, remove: async () => true },
    repo, icons: () => icons, now: () => T0,
  };
}
const call = (deps, method, path, { headers = {}, body, site = "same-origin" } = {}) => handleAdmin(new Request(`https://${HOST}${path}`, {
  method, headers: { host: HOST, "x-vercel-forwarded-for": "203.0.113.7", "sec-fetch-site": site, ...(method !== "GET" ? { origin: `https://${HOST}` } : {}), ...headers },
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), redirect: "manual",
}), deps);
async function owner(deps) {
  const start = await call(deps, "GET", "/api/admin/login", { site: "none" });
  const oauth = start.headers.getSetCookie()[0].split(";")[0];
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const res = await call(deps, "GET", `/api/admin/callback?code=abcdef123456&state=${state}`, { site: "cross-site", headers: { cookie: oauth } });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-sid=")).split(";")[0];
  const me = await (await call(deps, "GET", "/api/admin/me", { headers: { cookie } })).json();
  return { cookie, headers: { cookie, "x-csrf-token": me.csrf, "content-type": "application/json" } };
}

/* ---- sample pictures ---- */
const url = (mime, bytes) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
const WEBP = url("image/webp", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(40, 1)]));
const PNG = url("image/png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(30, 2)]));
const SVG = url("image/svg+xml", '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h4z" fill="#fff"/></svg>');
let n = 0;
const key = () => `k${String(++n).padStart(15, "0")}`;
const edited = () => { const c = content(); c.texts.home.title = "Dhanush G"; return c; };
const body = (extra = {}) => ({ base: SHA, key: key(), message: "Update title", content: edited(), added: {}, removed: [], ...extra });
// `limit: true` keeps the push limiter; otherwise it is reset before each call so one test can send many requests
async function fresh(opts, { limit = false } = {}) {
  const deps = setup(fakeGithub(opts));
  const o = await owner(deps);
  const push = (b, h = o.headers, extra = {}) => {
    if (!limit) for (const k of [...deps.counters.keys()]) if (k.startsWith("ap-")) deps.counters.delete(k);
    return call(deps, "POST", "/api/admin/push", { headers: h, body: b, ...extra });
  };
  return { deps, o, push };
}

/* ---- the happy path: one atomic commit ---- */
await test("push: content + new picture + removed file make ONE commit, in order, never forced", async () => {
  const { deps, push } = await fresh();
  const res = await push(body({ added: { "/image/new-shot.webp": WEBP, "/skill/new.svg": SVG }, removed: ["/skill/old.svg"] }));
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.match(out.sha, /^[0-9a-f]{40}$/);
  assert.equal(out.url, `https://github.com/o/r/commit/${out.sha}`);
  const w = deps.g.writes();
  assert.deepEqual(w.map((x) => `${x.method} ${x.path}`), ["POST git/blobs", "POST git/blobs", "POST git/blobs", "POST git/trees", "POST git/commits", "PATCH git/refs/heads/main"]);
  const tree = w.find((x) => x.path === "git/trees").body;
  assert.equal(tree.base_tree, TREE);
  const paths = tree.tree.map((e) => `${e.path}:${e.sha === null ? "del" : "add"}`).sort();
  assert.deepEqual(paths, ["content.json:add", "public/image/new-shot.webp:add", "public/skill/new.svg:add", "public/skill/old.svg:del"]);
  const commit = w.find((x) => x.path === "git/commits").body;
  assert.deepEqual(commit.parents, [SHA]);
  assert.equal(commit.message, "Update title");
  const ref = w.at(-1).body;
  assert.equal(ref.force, false);
  assert.equal(ref.sha, out.sha);
  assert.equal(deps.g.state.head, out.sha);
  const blob = w[0].body;
  assert.equal(blob.encoding, "base64");
  assert.equal(JSON.parse(Buffer.from(blob.content, "base64").toString()).texts.home.title, "Dhanush G", "content.json is the first blob");
  assert.match(res.headers.get("cache-control"), /no-store/);
});
await test("push: only content (no pictures) is one blob; replace of an existing picture keeps its path", async () => {
  const a = await fresh();
  assert.equal((await a.push(body())).status, 200);
  assert.equal(a.deps.g.writes().filter((x) => x.path === "git/blobs").length, 1);
  const b = await fresh();
  assert.equal((await b.push(body({ content: content(), added: { "/image/portfolio.webp": WEBP } }))).status, 200);
  assert.ok(b.deps.g.writes().find((x) => x.path === "git/trees").body.tree.some((e) => e.path === "public/image/portfolio.webp"));
});
await test("push: content.json is written the way the repo has it (2 spaces, final newline)", async () => {
  const { deps, push } = await fresh();
  await push(body());
  const blob = deps.g.writes()[0].body;
  const text = Buffer.from(blob.content, "base64").toString();
  assert.ok(text.endsWith("}\n") && text.startsWith('{\n  "schemaVersion"'));
});

/* ---- gate: the same door as every admin call ---- */
await test("push: no session, no CSRF, wrong origin, wrong method, wrong type, too big, bad JSON", async () => {
  const { deps, o, push } = await fresh();
  assert.equal((await push(body(), { "content-type": "application/json" })).status, 401);
  assert.equal((await push(body(), { cookie: o.cookie, "content-type": "application/json" })).status, 403);
  assert.equal((await push(body(), { ...o.headers, "x-csrf-token": "nope" })).status, 403);
  assert.equal((await push(body(), o.headers, { site: "cross-site" })).status, 403);
  assert.equal((await call(deps, "GET", "/api/admin/push", { headers: { cookie: o.cookie } })).status, 405);
  assert.equal((await push(body(), { ...o.headers, "content-type": "text/plain" })).status, 415);
  assert.equal((await push("x".repeat(4_500_000))).status, 413);
  assert.equal((await push("{nope")).status, 400);
  assert.equal(deps.g.writes().length, 0, "nothing reached GitHub");
});
await test("push: strict body shape (exact keys, types, key format)", async () => {
  const { deps, push } = await fresh();
  const b = body();
  for (const bad of [[], null, { ...b, extra: 1 }, { ...b, base: "zz" }, { ...b, key: "short" }, { ...b, key: "bad key bad key bad key!" }, { ...b, added: [] }, { ...b, removed: {} }, { ...b, message: 5 },
    (({ key: _k, ...rest }) => rest)(b), { ...b, added: { "/image/a.webp": 1 } }]) {
    const r = await push(bad);
    assert.ok([400, 422].includes(r.status), `${r.status} ${JSON.stringify(bad)?.slice(0, 50)}`);
  }
  assert.equal(deps.g.writes().length, 0);
});

/* ---- path whitelist ---- */
await test("push: writes are limited to /image/** and /skill/** pictures (everything else is refused before GitHub)", async () => {
  const { deps, push } = await fresh();
  for (const p of ["/../x.png", "/image/../../api/x.png", "/image/a.html", "/image/.hidden.png", "/api/admin.png", "/public/image/a.png", "image/a.png", "/image/a.png/", "/image//a.png", "/script.js", "/content.json", "/image/a.php", "/image/%2e%2e/a.png", "/image/a\\b.png", "/image/a.png\n.js"]) {
    assert.equal((await push(body({ added: { [p]: WEBP } }))).status, 400, `added ${p}`);
    assert.equal((await push(body({ removed: [p] }))).status, 400, `removed ${p}`);
  }
  assert.equal((await push(body({ added: { "/image/x.webp": WEBP }, removed: ["/image/x.webp"] }))).status, 422, "same path added and removed");
  assert.equal((await push(body({ removed: ["/skill/old.svg", "/skill/old.svg"] }))).status, 422, "duplicate removal");
  assert.equal((await push(body({ removed: ["/skill/ghost.svg"] }))).status, 422, "removing a file that is not in the repo");
  assert.equal(deps.g.writes().length, 0);
});

/* ---- pictures are re-checked on the server ---- */
await test("pictures: type by magic bytes must match the name and the declared type; SVG is rebuilt; size caps", () => {
  assert.ok(decodePicture("/image/a.webp", WEBP).bytes);
  assert.ok(decodePicture("/image/a.png", PNG).bytes);
  assert.ok(decodePicture("/skill/a.svg", SVG).bytes);
  const bad = [
    ["/image/a.png", WEBP], ["/image/a.webp", PNG], ["/image/a.svg", WEBP], ["/image/a.webp", url("image/png", Buffer.from("RIFF\0\0\0\0WEBPVP8 "))],
    ["/image/a.png", url("image/png", "<html><script>alert(1)</script></html>")], ["/image/a.png", url("image/png", "MZ\x90\x00 evil")],
    ["/skill/a.svg", url("image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ["/skill/a.svg", url("image/svg+xml", '<svg onload="x()"></svg>')], ["/skill/a.svg", url("image/png", "<svg></svg>")],
    ["/image/a.webp", "data:image/webp;base64,%%%"], ["/image/a.webp", "https://evil.example/a.webp"], ["/image/a.webp", "data:text/html;base64,AAAA"], ["/image/a.webp", 5], ["/image/a.webp", ""],
    ["/image/a.webp", url("image/webp", Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBPVP8 "), Buffer.alloc(600_000)]))],
  ];
  for (const [p, d] of bad) assert.ok(decodePicture(p, d).error, p + String(d).slice(0, 40));
  const out = decodePicture("/skill/a.svg", url("image/svg+xml", '<?xml version="1.0"?><!-- c --><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'));
  assert.ok(!out.bytes.toString().includes("<?xml") && !out.bytes.toString().includes("<!--"), "the sanitizer rebuilt the file");
});
await test("push: a lying picture is refused with its path, and nothing is written", async () => {
  const { deps, push } = await fresh();
  const r = await push(body({ added: { "/image/fake.png": WEBP } }));
  assert.equal(r.status, 422);
  const out = await r.json();
  assert.equal(out.error, "invalid");
  assert.ok(out.errors[0].includes("/image/fake.png"));
  assert.equal(deps.g.writes().length, 0);
  assert.equal(deps.g.state.head, SHA);
});
await test("push: more than 24 files is refused", async () => {
  const { deps, push } = await fresh();
  const added = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`/image/p${i}.webp`, WEBP]));
  assert.equal((await push(body({ added }))).status, 422);
  assert.equal(deps.g.writes().length, 0);
});

/* ---- message ---- */
await test("message: 3-72 characters, one line, cleaned; control characters refused", async () => {
  assert.equal(cleanMessage("  Update   the\ttitle \n now "), "Update the title now");
  assert.equal(cleanMessage("ab"), "");
  assert.equal(cleanMessage("x".repeat(73)), "");
  assert.equal(cleanMessage("x".repeat(72)).length, 72);
  assert.equal(cleanMessage("hi\u0000there"), "");
  assert.equal(cleanMessage("hi\u202ethere"), "", "direction override");
  assert.equal(cleanMessage("\u{1F600}\u{1F600}\u{1F600}"), "\u{1F600}\u{1F600}\u{1F600}", "counted as characters, not code units");
  assert.equal(cleanMessage(null), "");
  const { deps, push } = await fresh();
  for (const m of ["", "ab", "x".repeat(80), "bad\u0007bell"]) assert.equal((await push(body({ message: m }))).status, 422, JSON.stringify(m));
  assert.equal(deps.g.writes().length, 0);
});

/* ---- validation: same validator as the build ---- */
await test("push: invalid content (javascript: link, too-long text, missing id, missing file) is refused, repo untouched", async () => {
  const { deps, push } = await fresh();
  const c = content();
  c.buttons[0].url = "javascript:alert(1)";
  c.texts.intro = "x".repeat(99);
  const r = await push(body({ content: c }));
  assert.equal(r.status, 422);
  const out = await r.json();
  assert.ok(out.errors.some((e) => e.startsWith("buttons[0].url")) && out.errors.some((e) => e.startsWith("texts.intro")));
  const c2 = edited(); delete c2.projects[0].id;
  assert.equal((await push(body({ content: c2 }))).status, 422);
  assert.equal((await push(body({ removed: ["/image/og.png"] }))).status, 422, "removing a file the site uses");
  assert.equal((await push(body({ content: { schemaVersion: 1 } }))).status, 422);
  assert.equal(deps.g.writes().length, 0);
  assert.equal(deps.g.state.head, SHA);
});
await test("push: nothing changed is not a commit", async () => {
  const { deps, push } = await fresh();
  const r = await push(body({ content: content() }));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "nochange");
  assert.equal(deps.g.writes().length, 0);
});

/* ---- conflicts, double click, failures ---- */
await test("conflict: the branch moved since the draft was loaded -> stop, no write, no force", async () => {
  const { deps, push } = await fresh();
  deps.g.state.head = "9".repeat(40);
  const r = await push(body());
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "moved");
  assert.equal(deps.g.writes().length, 0);
  assert.equal(deps.g.state.head, "9".repeat(40), "untouched");
});
await test("conflict: the branch moves DURING the push (ref update is not a fast-forward) -> moved, ref untouched", async () => {
  const { deps, push } = await fresh({ refStatus: 422 });
  const r = await push(body());
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "moved");
  assert.equal(deps.g.state.head, SHA);
  assert.ok(deps.g.writes().every((x) => x.body?.force !== true), "never forced");
});
await test("conflict: head moves between the route's check and the commit step -> moved", async () => {
  const { deps, push } = await fresh({ headAfter: "8".repeat(40) });
  const r = await push(body());
  assert.equal(r.status, 409);
  assert.equal(deps.g.writes().length, 0, "the commit step re-checks the head before creating anything");
});
await test("double click: the same key is refused, and a second push from the same base cannot make a second commit", async () => {
  const { deps, push } = await fresh();
  const b = body();
  assert.equal((await push(b)).status, 200);
  const again = await push(b);
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error, "dup");
  const other = await push({ ...b, key: key() }); // a new click on the old draft: the branch has moved on
  assert.equal(other.status, 409);
  assert.equal((await other.json()).error, "moved");
  assert.equal(deps.g.writes().filter((x) => x.path === "git/commits").length, 1, "exactly one commit");
  assert.equal(deps.g.writes().filter((x) => x.method === "PATCH").length, 1);
});
await test("failure at any step leaves the branch untouched, and the answer never explains why", async () => {
  for (const [failAt, code, expected] of [["POST git/blobs", 500, "github"], ["POST git/trees", 500, "github"], ["POST git/commits", 500, "github"], ["PATCH git/refs", 500, "github"], ["POST git/blobs", 403, "readonly"], ["POST git/trees", 404, "readonly"]]) {
    const { deps, push } = await fresh({ failAt, failStatus: code });
    const r = await push(body({ added: { "/image/n.webp": WEBP } }));
    assert.equal(r.status, 502, failAt);
    const text = await r.text();
    assert.equal(JSON.parse(text).error, expected, failAt);
    assert.ok(!text.includes("ghp_SECRET") && !text.includes("tok"), "no leak");
    assert.equal(deps.g.state.head, SHA, `${failAt}: branch untouched`);
  }
});
await test("push: no repo configured answers 501 norepo; a broken repo never leaks", async () => {
  const none = setup(fakeGithub(), { repo: null });
  const o = await owner(none);
  const r = await call(none, "POST", "/api/admin/push", { headers: o.headers, body: body() });
  assert.equal(r.status, 501);
  assert.equal((await r.json()).error, "norepo");
  const broken = setup(fakeGithub(), { repo: { name: "o/r", head: async () => { throw new Error("token ghp_SECRET"); }, files: async () => { throw new Error("x"); }, content: async () => { throw new Error("x"); }, commit: async () => { throw new Error("x"); } } });
  const o2 = await owner(broken);
  const b = await call(broken, "POST", "/api/admin/push", { headers: o2.headers, body: body() });
  assert.equal(b.status, 500);
  assert.ok(!(await b.text()).includes("ghp_SECRET"));
});
await test("push: rate limit (6 per 10 minutes) answers 429 with Retry-After, before any GitHub call", async () => {
  const { deps, push } = await fresh({}, { limit: true });
  let last;
  for (let i = 0; i < 7; i++) last = await push(body({ message: "Update title again" }));
  assert.equal(last.status, 429);
  assert.ok(last.headers.get("retry-after"));
  assert.ok(deps.g.writes().filter((x) => x.path === "git/commits").length <= 1, "after the first success the base is stale");
});
await test("push: a browser opening the address gets the designed 404, not JSON", async () => {
  const { deps } = await fresh();
  const r = await call(deps, "GET", "/api/admin/push", { site: "none", headers: { accept: "text/html", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } });
  assert.equal(r.status, 404);
  assert.ok((r.headers.get("content-type") ?? "").includes("text/html"));
});

/* ---- status ---- */
await test("status: owner only, valid sha only, answers a short state", async () => {
  const { deps, o } = await fresh();
  const get = (q, h = { cookie: o.cookie }) => call(deps, "GET", `/api/admin/status${q}`, { headers: h });
  assert.equal((await get(`?sha=${SHA}`, {})).status, 401);
  assert.equal((await get("?sha=zz")).status, 400);
  assert.equal((await get("")).status, 400);
  const r = await get(`?sha=${SHA}`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { state: "success" });
  assert.equal((await call(deps, "POST", "/api/admin/status", { headers: o.headers, body: "{}" })).status, 405);
});
await test("status: pending / failure / unknown; a GitHub error becomes unknown, never an error", async () => {
  const states = [[{ state: "pending", total_count: 1 }, "pending"], [{ state: "success", total_count: 0 }, "pending"], [{ state: "failure", total_count: 1 }, "failure"], [{ state: "error", total_count: 1 }, "failure"], [{ weird: 1 }, "unknown"]];
  for (const [payload, expected] of states) {
    const g = fakeGithub({ status: () => new Response(JSON.stringify(payload), { status: 200 }) });
    assert.equal(await g.repo.status(SHA), expected);
  }
  const g = fakeGithub({ status: () => new Response("{}", { status: 403 }) });
  assert.equal(await g.repo.status(SHA), "unknown");
  await assert.rejects(g.repo.status("../x"));
});

/* ---- repo.commit directly ---- */
await test("repo.commit: refuses a bad base sha and a base that is not the head", async () => {
  const g = fakeGithub();
  await assert.rejects(g.repo.commit({ base: "nope", message: "m", files: [], removed: [] }));
  await assert.rejects(g.repo.commit({ base: "1".repeat(40), message: "m", files: [], removed: [] }), (e) => e.code === "moved");
  assert.equal(g.writes().length, 0);
});

console.log(`push: ${passed} checks passed`);
