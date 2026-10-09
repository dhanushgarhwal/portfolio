// Checks: SVG sanitizer, editor logic, repo reader, /api/admin/content and /api/admin/validate. Run: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleAdmin } from "../lib/admin.js";
import { makeRepo } from "../lib/repo.js";
import { sanitizeSvg } from "../public/admin/svg.js";
import { changesOf, errorsAt, moveItem, refsTo, rewriteRefs, safeName, sniff, uniqueId } from "../public/admin/logic.js";
import { iconsIn } from "./render.mjs";
import { validateContent } from "./schema.mjs";

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n${e.stack.split("\n").slice(0, 4).join("\n")}`); process.exitCode = 1; } };
const content = () => JSON.parse(readFileSync(new URL("../content.json", import.meta.url), "utf8"));
const icons = iconsIn(readFileSync(new URL("../templates/index.template.html", import.meta.url), "utf8"));

/* ---- SVG sanitizer ---- */
const OK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>x</title><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><path d="M1 1h4z" fill="url(#g)"/><use href="#g"/></svg>';
await test("svg: a normal icon passes and comes back rebuilt", () => {
  const r = sanitizeSvg(`<?xml version="1.0"?>\n<!-- c -->\n${OK}`);
  assert.ok(r.ok, r.error);
  assert.ok(r.svg.startsWith("<svg") && r.svg.includes('<linearGradient id="g">'));
});
await test("svg: scripts, handlers, styles, external refs, entities and foreign content are rejected", () => {
  const bad = [
    "<svg><script>alert(1)</script></svg>", '<svg onload="x()"></svg>', '<svg><path d="M0 0" onclick="x"/></svg>', "<svg><style>*{}</style></svg>",
    '<svg style="x:y"></svg>', '<svg><use href="https://e.com/a.svg#a"/></svg>', '<svg><image href="data:image/png;base64,AA"/></svg>',
    '<svg><rect fill="url(https://e.com/x)"/></svg>', '<svg><a href="javascript:alert(1)"><path d="M0 0"/></a></svg>', "<svg><foreignObject><div/></foreignObject></svg>",
    '<!DOCTYPE svg [<!ENTITY x "y">]><svg/>', "<svg><![CDATA[x]]></svg>", '<svg><path d="M0 0" fill="javascript:x"/></svg>', "<svg><animate attributeName=\"href\"/></svg>",
    '<svg><rect width="1" width="2"/></svg>', "<svg><g></svg>", "<svg/><svg/>", "<div/>", "plain text", '<svg><path d="M0 0&#x3c;"/></svg>', '<svg><text>x</text></svg>',
    '<svg><use href="#a" xlink:href="https://x.y/z"/></svg>',
  ];
  for (const s of bad) assert.equal(sanitizeSvg(s).ok, false, s);
});
await test("svg: size and element caps", () => {
  assert.equal(sanitizeSvg(`<svg>${"<g/>".repeat(500)}</svg>`).ok, false);
  assert.equal(sanitizeSvg(`<svg>${" ".repeat(50_000)}</svg>`).ok, false);
});
await test("svg: output never contains a forbidden token", () => {
  const r = sanitizeSvg(OK);
  assert.ok(!/script|on\w+=|javascript|style|http/i.test(r.svg.replace('xmlns="http://www.w3.org/2000/svg"', "")));
});

/* ---- logic ---- */
await test("sniff: real type by magic bytes, not by name", () => {
  const b = (...x) => new Uint8Array(x);
  assert.equal(sniff(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "png");
  assert.equal(sniff(b(0xff, 0xd8, 0xff, 0xe0)), "jpeg");
  assert.equal(sniff(new TextEncoder().encode("GIF89a....")), "gif");
  assert.equal(sniff(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")), "webp");
  assert.equal(sniff(new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="x"></svg>')), "svg");
  assert.equal(sniff(new TextEncoder().encode("<html><script>alert(1)</script>")), null);
  assert.equal(sniff(new TextEncoder().encode("MZ\x90\x00 evil.exe")), null);
});
await test("safeName: no path, no dots, no odd characters", () => {
  assert.equal(safeName("../../Etc/My Photo (1).PNG"), "etc-my-photo-1");
  assert.equal(safeName("....png"), "image");
  assert.equal(safeName("é ü.webp"), "e-u");
  assert.ok(safeName("a".repeat(200) + ".png").length <= 40);
});
await test("uniqueId is valid and unused", () => {
  const id = uniqueId([{ id: "button-aaaa" }], "button");
  assert.match(id, /^[a-z0-9][a-z0-9-]{0,39}$/);
});
await test("refsTo / rewriteRefs: replace, unlink, and required uses", () => {
  const c = content();
  assert.deepEqual(refsTo(c, "/image/og.png").map((r) => r.path), ["images.og"]);
  assert.equal(refsTo(c, "/image/portfolio.webp")[0].required, true);
  const moved = rewriteRefs(c, "/image/portfolio.webp", "/image/new.webp");
  assert.equal(moved.projects[0].image, "/image/new.webp");
  assert.equal(c.projects[0].image, "/image/portfolio.webp", "input is not mutated");
  assert.throws(() => rewriteRefs(c, "/image/og.png", null));
  const unl = rewriteRefs(c, "/image/skill/git.svg", null);
  assert.deepEqual(unl.stack.find((s) => s.id === "git").art, { kind: "text", letter: "G" });
  const swapped = rewriteRefs(c, "/image/skill/git.svg", "/skill/git2.svg");
  assert.equal(swapped.stack.find((s) => s.id === "git").art.cdn, undefined);
});
await test("changesOf: texts, items, files", () => {
  const a = content(), b = content();
  assert.deepEqual(changesOf(a, b), []);
  b.texts.home.title = "x";
  b.buttons[0].visible = false;
  b.buttons.push({ id: "n", label: "N", icon: "code", url: "https://a.b", visible: true });
  b.stack = b.stack.filter((s) => s.id !== "git");
  const c = changesOf(a, b, { added: ["/image/a.webp"], removed: ["/image/b.png"] });
  const has = (area, op, id) => c.some((x) => x.area === area && x.op === op && x.id === id);
  assert.ok(has("texts", "edited", "home.title") && has("buttons", "edited", "github") && has("buttons", "added", "n") && has("stack", "removed", "git"));
  assert.ok(has("files", "added", "/image/a.webp") && has("files", "removed", "/image/b.png"));
});
await test("moveItem puts an item where another one was; changesOf reports a move, not an add or remove", () => {
  const ids = (l) => l.map((x) => x.id).join("");
  const l = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  assert.equal(ids(moveItem(l, "a", "c")), "bcad");
  assert.equal(ids(moveItem(l, "d", "b")), "adbc");
  assert.equal(ids(moveItem(l, "a", "a")), "abcd");
  assert.equal(ids(moveItem(l, "x", "a")), "abcd");
  assert.equal(ids(l), "abcd", "input is not mutated");
  const a = content(), b = content();
  b.stack = moveItem(b.stack, b.stack[0].id, b.stack.at(-1).id);
  b.projects.push({ ...b.projects[0], id: "second" });
  const c = changesOf(a, b);
  assert.ok(c.some((x) => x.area === "stack" && x.op === "moved"));
  assert.ok(!c.some((x) => x.area === "projects" && x.op === "moved"), "adding at the end is not a move");
  assert.ok(!c.some((x) => x.area === "stack" && x.op !== "moved"));
});
await test("errorsAt picks the messages under a path", () => {
  const e = ["buttons[1].url: link must start with https://", "buttons[10].url: x", "texts.intro: is empty"];
  assert.deepEqual(errorsAt(e, "buttons[1].url"), ["link must start with https://"]);
  assert.deepEqual(errorsAt(e, "texts.intro"), ["is empty"]);
  assert.deepEqual(errorsAt(e, "buttons[1]"), ["link must start with https://"]);
});

/* ---- repo reader (fake GitHub) ---- */
const SHA = "a".repeat(40), TREE = "b".repeat(40), BLOB = "c".repeat(40);
function fakeGithub({ truncated = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    assert.equal(init.headers.Authorization, "Bearer tok");
    const path = url.replace("https://api.github.com/repos/o/r/", "");
    const json = (o) => new Response(JSON.stringify(o), { status: 200 });
    if (path.startsWith("git/ref/heads/")) return json({ object: { sha: SHA } });
    if (path === `git/commits/${SHA}`) return json({ tree: { sha: TREE } });
    if (path === `git/trees/${TREE}?recursive=1`) return json({ truncated, tree: [
      { path: "public/image/og.png", type: "blob", size: 10 }, { path: "public/skill/git.svg", type: "blob", size: 5 },
      { path: "public/script.js", type: "blob", size: 99 }, { path: "api/x.js", type: "blob", size: 1 }, { path: "public/image", type: "tree" }] });
    if (path === `git/trees/${TREE}`) return json({ tree: [{ path: "content.json", type: "blob", sha: BLOB }] });
    if (path === `git/blobs/${BLOB}`) return json({ encoding: "base64", content: Buffer.from(JSON.stringify(content())).toString("base64") });
    return new Response("{}", { status: 404 });
  };
  return { calls, repo: makeRepo({ token: "tok", repo: "o/r", branch: "main" }, fetchImpl) };
}
await test("repo: head, files (only image + skill, as site paths, cached), content", async () => {
  const g = fakeGithub();
  assert.equal(await g.repo.head(), SHA);
  const files = await g.repo.files(SHA);
  assert.deepEqual(files, [{ path: "/image/og.png", size: 10 }, { path: "/skill/git.svg", size: 5 }]);
  const before = g.calls.length;
  await g.repo.files(SHA);
  assert.equal(g.calls.length, before, "second read comes from the cache");
  assert.equal((await g.repo.content(SHA)).schemaVersion, 1);
});
await test("repo: truncated tree and bad sha are refused", async () => {
  await assert.rejects(fakeGithub({ truncated: true }).repo.files(SHA));
  await assert.rejects(fakeGithub().repo.files("../../etc"));
});

/* ---- routes ---- */
const HOST = "site.example", SECRET = "s".repeat(40), T0 = Date.UTC(2026, 9, 8, 12);
function setup({ repo = fakeGithub().repo, brokenRepo = false } = {}) {
  const counters = new Map();
  return {
    env: { clientId: "cid", clientSecret: "cs", adminId: "4242", secret: SECRET },
    github: { exchange: async () => "t", user: async () => ({ id: 4242, login: "me" }) },
    store: { hit: async (b) => b.map(({ id }) => { counters.set(id, (counters.get(id) ?? 0) + 1); return counters.get(id); }), revokedBefore: async () => 0, revokeSessions: async () => {}, list: async () => [], stats: async () => ({}), setRead: async () => true, remove: async () => true },
    repo: brokenRepo ? { head: async () => { throw new Error("token ghp_SECRET"); }, files: async () => { throw new Error("x"); }, content: async () => { throw new Error("x"); } } : repo,
    icons: () => icons,
    now: () => T0,
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
const good = (extra = {}) => ({ base: SHA, content: content(), added: [], removed: [], ...extra });

await test("content: needs a session; returns base, content, files, icons; nothing secret", async () => {
  const deps = setup();
  assert.equal((await call(deps, "GET", "/api/admin/content")).status, 401);
  const o = await owner(deps);
  const res = await call(deps, "GET", "/api/admin/content", { headers: { cookie: o.cookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.base, SHA);
  assert.equal(body.content.schemaVersion, 1);
  assert.ok(body.icons.includes("github") && body.files.length === 2);
  assert.ok(!JSON.stringify(body).includes("tok"));
  assert.match(res.headers.get("cache-control"), /no-store/);
  assert.equal((await call(deps, "GET", "/api/admin/content?base=nope", { headers: { cookie: o.cookie } })).status, 400);
  assert.equal((await call(deps, "GET", "/api/admin/content?base=" + SHA, { headers: { cookie: o.cookie } })).status, 200);
});
await test("content: wrong origin, wrong method, no repo, broken repo (never leaks)", async () => {
  const deps = setup();
  const o = await owner(deps);
  assert.equal((await call(deps, "GET", "/api/admin/content", { headers: { cookie: o.cookie }, site: "cross-site" })).status, 403);
  assert.equal((await call(deps, "POST", "/api/admin/content", { headers: o.headers, body: "{}" })).status, 405);
  const none = setup({ repo: null });
  const o2 = await owner(none);
  const r = await call(none, "GET", "/api/admin/content", { headers: { cookie: o2.cookie } });
  assert.equal(r.status, 501); assert.equal((await r.json()).error, "norepo");
  const broken = setup({ brokenRepo: true });
  const o3 = await owner(broken);
  const b = await call(broken, "GET", "/api/admin/content", { headers: { cookie: o3.cookie } });
  assert.equal(b.status, 500);
  assert.ok(!(await b.text()).includes("ghp_SECRET"));
});
await test("validate: auth, CSRF, origin, JSON type, size and strict body shape", async () => {
  const deps = setup();
  const o = await owner(deps);
  const post = (body, headers = o.headers, opts = {}) => call(deps, "POST", "/api/admin/validate", { headers, body, ...opts });
  assert.equal((await post(good(), { "content-type": "application/json" })).status, 401);
  assert.equal((await post(good(), { cookie: o.cookie, "content-type": "application/json" })).status, 403);
  assert.equal((await post(good(), o.headers, { site: "cross-site" })).status, 403);
  assert.equal((await post(good(), { ...o.headers, "content-type": "text/plain" })).status, 415);
  assert.equal((await post("x".repeat(300_000))).status, 413);
  assert.equal((await post("{nope")).status, 400);
  for (const bad of [good({ base: "zz" }), good({ extra: 1 }), { base: SHA, content: {} }, good({ added: ["/../x.png"] }), good({ added: ["/image/a.html"] }), good({ removed: "x" }), good({ added: Array(300).fill("/image/a.png") }), []]) {
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
});
await test("validate: uses the build's validator, with the draft's file changes", async () => {
  const deps = setup();
  const o = await owner(deps);
  const post = async (b) => (await call(deps, "POST", "/api/admin/validate", { headers: o.headers, body: b })).json();
  const ok = await post(good());
  assert.equal(ok.ok, false, "the sample repo has no portfolio.webp");
  assert.ok(ok.errors.some((e) => e.includes("/image/portfolio.webp")));
  const fixed = await post(good({ added: ["/image/portfolio.webp", "/image/favicon.png", "/image/favicon-sm.png"] }));
  assert.deepEqual(fixed.errors, [], fixed.errors.join("\n"));
  const c = content();
  c.buttons[0].url = "javascript:alert(1)";
  c.texts.intro = "x".repeat(99);
  const bad = await post(good({ content: c, added: ["/image/portfolio.webp", "/image/favicon.png", "/image/favicon-sm.png"] }));
  assert.ok(bad.errors.some((e) => e.startsWith("buttons[0].url")) && bad.errors.some((e) => e.startsWith("texts.intro")));
  const gone = await post(good({ removed: ["/image/og.png"], added: ["/image/portfolio.webp", "/image/favicon.png", "/image/favicon-sm.png"] }));
  assert.ok(gone.errors.some((e) => e.includes("images.og")), "removing a used file is caught");
  const same = validateContent(c, { icons, fileExists: () => true });
  assert.ok(bad.errors.every((e) => same.errors.includes(e) || e.includes("does not exist")), "same messages as the build");
});
await test("validate: write limiter applies", async () => {
  const deps = setup();
  const o = await owner(deps);
  let last;
  for (let i = 0; i < 125; i++) last = await call(deps, "POST", "/api/admin/validate", { headers: o.headers, body: good() });
  assert.equal(last.status, 429);
  assert.ok(last.headers.get("retry-after"));
});

await test("repo: the commit object and content.json of a commit are fetched once, even when asked for together or again", async () => {
  const g = fakeGithub();
  const [data, files] = await Promise.all([g.repo.content(SHA), g.repo.files(SHA)]); // what the admin does on load
  assert.equal(data.schemaVersion, 1);
  assert.equal(files.length, 2);
  assert.equal(g.calls.filter((u) => u.endsWith(`git/commits/${SHA}`)).length, 1, "one request for the commit, not one per reader");
  const before = g.calls.length;
  const again = await g.repo.content(SHA);
  assert.equal(g.calls.length, before, "a repeat comes from the cache");
  again.schemaVersion = 99; // a caller changing its copy must not change what the next one gets
  assert.equal((await g.repo.content(SHA)).schemaVersion, 1);
});
await test("repo: a failed load is not remembered", async () => {
  let fail = true;
  const repo = makeRepo({ token: "tok", repo: "o/r", branch: "main" }, async (url) => {
    if (fail) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify(url.includes("git/commits/") ? { tree: { sha: TREE } } : { tree: [{ path: "content.json", type: "blob", sha: BLOB }], encoding: "base64", content: Buffer.from("{\"ok\":1}").toString("base64") }), { status: 200 });
  });
  await assert.rejects(() => repo.content(SHA));
  fail = false;
  assert.deepEqual(await repo.content(SHA), { ok: 1 });
});

console.log(`editors: ${passed} checks passed`);
