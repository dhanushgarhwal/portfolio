// Checks for the content rules and the renderer. Run: npm test
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateContent } from "./schema.mjs";
import { iconsIn, renderPage } from "./render.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = JSON.parse(readFileSync(join(root, "content.json"), "utf8"));
const template = readFileSync(join(root, "templates/index.template.html"), "utf8");
const env = { icons: iconsIn(template), fileExists: (p) => existsSync(join(root, "public", p)) };
const copy = () => structuredClone(base);
const check = (c) => validateContent(c, env);

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n${e.message}`); process.exitCode = 1; } };
const rejects = (name, mutate, expected) => test(name, () => {
  const c = copy(); mutate(c);
  const { errors } = check(c);
  assert.ok(errors.some((e) => e.includes(expected)), `expected an error containing "${expected}", got:\n${errors.join("\n") || "(none)"}`);
});

test("shipped content.json is valid", () => assert.deepEqual(check(copy()).errors, []));

rejects("javascript: link in a button", (c) => { c.buttons[0].url = "javascript:alert(1)"; }, "buttons[0].url");
rejects("data: link in a project", (c) => { c.projects[0].url = "data:text/html,x"; }, "projects[0].url");
rejects("protocol-relative link", (c) => { c.buttons[0].url = "//evil.example"; }, "buttons[0].url");
rejects("http (not https) link", (c) => { c.buttons[0].url = "http://example.com"; }, "buttons[0].url");
rejects("login inside a link", (c) => { c.buttons[0].url = "https://a:b@example.com"; }, "buttons[0].url");
rejects("javascript: link inside about text", (c) => { c.texts.home.about = "hi [[x|javascript:alert(1)]]"; }, "texts.home.about");
rejects("unclosed [[ in about text", (c) => { c.texts.home.about = "hi [[x"; }, "texts.home.about");
rejects("missing button id", (c) => { delete c.buttons[1].id; }, '"id" is missing');
rejects("duplicate button id", (c) => { c.buttons[1].id = c.buttons[0].id; }, "used twice");
rejects("bad id characters", (c) => { c.projects[0].id = "My Project!"; }, "projects[0].id");
rejects("over-long title", (c) => { c.texts.home.title = "x".repeat(500); }, "texts.home.title");
rejects("line break in a text", (c) => { c.texts.home.hey = "a\nb"; }, "texts.home.hey");
rejects("unknown key (typo)", (c) => { c.buttons[0].lable = "x"; }, 'unknown key "lable"');
rejects("unknown icon", (c) => { c.buttons[0].icon = "nope"; }, "unknown icon");
rejects("bad colour", (c) => { c.stack[0].color = "red"; }, "stack[0].color");
rejects("old stack group is gone", (c) => { c.stack[0].group = "tools"; }, "stack[0]");
rejects("old stackGroups list is gone", (c) => { c.stackGroups = ["tools"]; }, "stackGroups");
rejects("missing project image", (c) => { c.projects[0].image = "/image/does-not-exist.webp"; }, "does not exist");
rejects("image path escaping the folder", (c) => { c.projects[0].image = "/image/../script.js"; }, "projects[0].image");
rejects("image of a wrong type", (c) => { c.projects[0].image = "/image/x.html"; }, "projects[0].image");
rejects("CDN link on another host", (c) => { c.stack[0].art.cdn = "https://evil.example/x.svg"; }, "stack[0].art.cdn");
rejects("no visible project", (c) => { c.projects[0].visible = false; }, "at least one visible project");
rejects("no visible stack item", (c) => { c.stack.forEach((x) => { x.visible = false; }); }, "at least one visible item");
rejects("wrong schema version", (c) => { c.schemaVersion = 2; }, "schemaVersion");
rejects("site address with a path", (c) => { c.site.url = "https://example.com/x"; }, "site.url");
rejects("email button with its own url", (c) => { c.buttons[5].url = "https://x.com"; }, "site.email");

test("a hidden button leaves the page, the others stay", () => {
  const c = copy(); c.buttons[1].visible = false;
  const html = renderPage(template, c);
  assert.ok(!html.includes("linkedin.com"));
  assert.equal((html.match(/<a class="chip"/g) ?? []).length, 5 + 1 /* + the project button */);
});
test("all buttons hidden removes the row", () => {
  const c = copy(); c.buttons.forEach((b) => { b.visible = false; });
  assert.ok(!renderPage(template, c).includes('class="links in"'));
});
test("a deleted button leaves no trace", () => {
  const c = copy(); c.buttons.splice(0, 1);
  assert.ok(!renderPage(template, c).includes("github.com/dhanushgarhwal\""));
});
test("typed HTML is escaped everywhere", () => {
  const c = copy();
  c.texts.home.title = '<img src=x onerror=alert(1)>';
  c.projects[0].name = '"><script>alert(1)</script>';
  c.projects[0].description = "a & b <b>";
  c.stack[0].name = "<i>";
  c.site.title = "</title><script>1</script>";
  const html = renderPage(template, c);
  assert.ok(!/<script>(alert|1)/.test(html));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes("a &amp; b &lt;b&gt;"));
});
test("projects and stack render in the order of content.json, first one first", () => {
  const c = copy();
  c.stack.push({ id: "new", name: "New", color: "#112233", art: { kind: "text", letter: "N" }, visible: true });
  c.projects.push({ ...c.projects[0], id: "second", name: "second" });
  c.stack.reverse();
  const html = renderPage(template, c);
  assert.equal((html.match(/class="card slide" aria-label/g) ?? []).length, 2);
  const names = [...html.matchAll(/class="card tile"[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, c.stack.filter((x) => x.visible).map((x) => x.name));
  assert.equal(names[0], "New");
});
test("the page has no timeline and no group labels", () => {
  const html = renderPage(template, copy());
  assert.ok(!/id="tl|tl-bar|tl-thumb|data-g=/.test(html));
});
test("template with an unknown placeholder fails", () => {
  assert.throws(() => renderPage(template.replace("{{site.title}}", "{{site.nothing}}"), copy()));
});

// feedback page
rejects("feedback title missing", (c) => { delete c.texts.feedback.title; }, '"title" is missing');
rejects("feedback text too long", (c) => { c.texts.feedback.thanks = "x".repeat(300); }, "texts.feedback.thanks");
test("feedback is the 4th section of the main page: a nav icon, no link, no separate page", () => {
  const html = renderPage(template, copy());
  assert.match(html, /<a role="button" data-go="feedback" aria-label="Feedback" data-tip="Feedback"><svg aria-hidden="true"><use href="#i-star"\/><\/svg><\/a>/);
  assert.match(html, /<main class="wrap view" data-page="feedback">/);
  assert.equal((html.match(/data-go="/g) ?? []).length, 4, "home, projects, skills, feedback");
  assert.ok(!/href="\/feedback"|#feedback/.test(html), "no /feedback or #feedback address anywhere");
  assert.ok(!existsSync(join(root, "templates/feedback.template.html")), "the old separate page is gone");
  assert.ok(!JSON.stringify(copy().buttons).includes("feedback"), "no feedback button on the home page");
});
test("feedback section has no Cloudflare / Turnstile piece any more", () => {
  const html = renderPage(template, copy());
  assert.ok(!/turnstile|sitekey|challenges\.cloudflare|fbCf/i.test(html));
  assert.ok(!/turnstile|challenges\.cloudflare/i.test(readFileSync(join(root, "public/feedback.js"), "utf8")));
});
test("feedback section: short placeholder, and the blocked text sits on the send button", () => {
  const html = renderPage(template, copy());
  assert.match(html, /id="fbPh"[^>]*>don(?:'|&#39;)t overthink, it(?:'|&#39;)s anonymous</); // the hint is its own element, not a real placeholder, so it can never be selected
  assert.doesNotMatch(html, /<textarea[^>]*placeholder=/);
  assert.match(html, /<button class="btn" id="fbSend" type="submit" disabled data-send="send" data-blocked="limit reached">send<\/button>/);
  assert.match(html, /id="fbStars"[^>]*data-level="0"/);
  assert.match(html, /id="fbDone" inert aria-hidden="true"/);
});
rejects("feedback blocked text too long", (c) => { c.texts.feedback.blocked = "x".repeat(21); }, "texts.feedback.blocked");
test("feedback section: texts escaped", () => {
  const c = copy(); c.texts.feedback.placeholder = '"><script>1</script>';
  assert.ok(!renderPage(template, c).includes("<script>1</script>"));
});
test("feedback section has the form pieces the script needs, and its files are loaded", () => {
  const html = renderPage(template, copy());
  for (const id of ["fb", "fbStars", "fbText", "fbHp", "fbMsg", "fbSend", "fbCount", "fbBody", "fbDone"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.equal((html.match(/class="fb-star"/g) ?? []).length, 5);
  assert.ok(html.includes('href="/feedback.css"') && html.includes('src="/feedback.js"'));
});

// end to end: a bad content.json must stop the real build and leave the previous page untouched
test("build stops on bad content and keeps the old page", () => {
  const dir = mkdtempSync(join(tmpdir(), "build-"));
  try {
    for (const p of ["scripts", "templates", "public", "content.json"]) cpSync(join(root, p), join(dir, p), { recursive: true });
    const run = () => spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: dir, encoding: "utf8" });
    assert.equal(run().status, 0, "good content should build");
    const before = readFileSync(join(dir, "public/index.html"), "utf8");
    const bad = copy(); bad.buttons[0].url = "javascript:alert(1)"; delete bad.buttons[1].id; bad.texts.home.title = "x".repeat(200);
    writeFileSync(join(dir, "content.json"), JSON.stringify(bad));
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /buttons\[0\]\.url/);
    assert.match(r.stderr, /"id" is missing/);
    assert.match(r.stderr, /texts\.home\.title/);
    assert.equal(readFileSync(join(dir, "public/index.html"), "utf8"), before, "old page must stay");
    writeFileSync(join(dir, "content.json"), "{ not json");
    assert.equal(run().status, 1);
    writeFileSync(join(dir, "content.json"), JSON.stringify(base));
    assert.equal(run().status, 0, "the build needs no Turnstile key any more");
    assert.ok(!/TURNSTILE/.test(run().stderr), "and does not warn about one");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// the built page asks for its own files by a content hash, so a year-long browser cache can never show an old file
test("build stamps the page's styles and scripts with a hash of each file", () => {
  const dir = mkdtempSync(join(tmpdir(), "stamp-"));
  try {
    for (const p of ["scripts", "templates", "public", "content.json"]) cpSync(join(root, p), join(dir, p), { recursive: true });
    assert.equal(spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: dir, encoding: "utf8" }).status, 0);
    const html = readFileSync(join(dir, "public/index.html"), "utf8");
    const files = ["state.css", "style.css", "feedback.css", "fonts.js", "script.js", "feedback.js"];
    for (const f of files) {
      const hash = createHash("sha256").update(readFileSync(join(dir, "public", f))).digest("hex").slice(0, 10);
      assert.ok(html.includes(`="/${f}?v=${hash}"`), `${f} is not loaded by its hash`);
    }
    assert.ok(!/(?:href|src)="\/(?:state|style|feedback)\.css"|(?:href|src)="\/(?:fonts|script|feedback)\.js"/.test(html), "no file is left without a hash");
    writeFileSync(join(dir, "public/script.js"), `${readFileSync(join(dir, "public/script.js"), "utf8")}\n// changed`);
    spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: dir, encoding: "utf8" });
    assert.notEqual(readFileSync(join(dir, "public/index.html"), "utf8").match(/script\.js\?v=(\w+)/)[1], html.match(/script\.js\?v=(\w+)/)[1], "a changed file gets a new address");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(process.exitCode ? "\nsome checks failed" : `all ${passed} checks passed`);
