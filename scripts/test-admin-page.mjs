// Checks that the admin page works under its own Content-Security-Policy, and that vercel.json serves it safely. Run: npm test
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const vercel = JSON.parse(read("vercel.json"));
const html = read("public/admin/index.html");
const files = Object.fromEntries(readdirSync(join(root, "public/admin")).map((f) => [f, read(`public/admin/${f}`)]));

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n${e.message}`); process.exitCode = 1; } };
const PUBLIC = "/((?!admin|api/admin).*)"; // the public site and every other address except the admin
const rule = (source) => vercel.headers.find((h) => h.source === source);
const header = (source, key) => rule(source)?.headers.find((h) => h.key === key)?.value;

test("CSP: no inline script, inline style, style attribute, event handler or javascript: URL in the admin page", () => {
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "inline <script>");
  assert.ok(!/<style[\s>]/i.test(html), "inline <style>");
  assert.ok(!/\sstyle\s*=/i.test(html), "style attribute");
  assert.ok(!/\son[a-z]+\s*=/i.test(html), "inline handler");
  assert.ok(!/javascript:/i.test(html));
  for (const [name, code] of Object.entries(files)) {
    if (!name.endsWith(".js")) continue;
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|setAttribute\(\s*["']style["']/.test(code), `${name}: unsafe sink`);
    assert.ok(!/localStorage|sessionStorage/.test(code), `${name}: browser storage`);
  }
});

test("Journey admin: the section is registered after Stack and before Feedback, and everything it draws exists in the admin sprite", () => {
  const app = files["app.js"], j = files["journey.js"];
  const ids = [...app.matchAll(/\{ id: "(\w+)", label/g)].map((m) => m[1]);
  assert.ok(ids.indexOf("journey") === ids.indexOf("stack") + 1 && ids.indexOf("journey") < ids.indexOf("feedback"), ids.join());
  assert.match(app, /journey: journeyView/);
  const sprite = new Set([...html.matchAll(/id="i-([a-z0-9-]+)"/g)].map((m) => m[1]));
  const used = new Set([...[app, j, files["kit.js"]].join("\n").matchAll(/(?:icon|iconButton)\("([a-z0-9-]+)"/g)].map((m) => m[1]));
  for (const name of [...used, "route", "unlock", "lock", "marker", "pin", "file", "download", "upload", "refresh"]) assert.ok(sprite.has(name), `missing icon i-${name}`);
});
test("Journey admin: the Push screen counts Journey changes and the editor never writes markup or styles", () => {
  assert.match(files["push.js"], /\["journey", sum\.journey\]/);
  assert.ok(!/innerHTML|style=|\.style\.cssText|setAttribute\("style"/.test(files["journey.js"]));
  assert.ok(!/localStorage|sessionStorage|eval\(|new Function/.test(files["journey.js"]));
});

test("CSP: the page only loads files from its own origin", () => {
  for (const url of html.match(/(?:src|href)="[^"#][^"]*"/g) ?? []) assert.ok(/="\/(?!\/)/.test(url), url);
  for (const css of ["admin/admin.css", "style.css", "state.css"]) assert.ok(!/url\(\s*["']?(https?:)?\/\//.test(read(`public/${css}`)), `${css} loads from outside`);
  for (const code of Object.values(files)) assert.ok(!/https?:\/\/[a-z0-9]/i.test(code.replace(/http:\/\/www\.w3\.org\/(2000\/svg|1999\/xlink)/g, "")), "external address in admin code"); // a bare "https://" (a link being typed) is fine, a host is not
});

for (const source of ["/admin", "/admin/(.*)"]) {
  test(`${source}: security headers`, () => {
    const csp = header(source, "Content-Security-Policy");
    for (const part of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'", "form-action 'self'", "frame-src 'self'"]) assert.ok(csp.includes(part), part);
    assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(csp), "no wildcard or unsafe source");
    assert.equal(header(source, "X-Frame-Options"), "DENY");
    assert.equal(header(source, "X-Content-Type-Options"), "nosniff");
    assert.equal(header(source, "Referrer-Policy"), "no-referrer");
    assert.equal(header(source, "Cache-Control"), "no-store");
    assert.match(header(source, "X-Robots-Tag"), /noindex/);
    assert.ok(header(source, "Permissions-Policy"));
  });
}

test("/admin is served from public/admin/index.html and the public site rules are unchanged", () => {
  assert.deepEqual(vercel.rewrites.find((r) => r.source === "/admin"), { source: "/admin", destination: "/admin/index.html" });
  assert.ok(!vercel.rewrites.some((r) => r.source === "/feedback"), "feedback lives on the main page now");
  assert.equal(header("/sw.js", "Cache-Control"), "no-cache");
  assert.equal(header("/font/(.*)", "Cache-Control"), "public, max-age=31536000, immutable");
  assert.match(header("/(image|skill)/(.*)", "Cache-Control"), /^public, max-age=\d+, stale-while-revalidate=\d+$/);
  const VERSIONED = "/(state\\.css|style\\.css|feedback\\.css|journey\\.css|fonts\\.js|script\\.js|feedback\\.js|journey\\.js)";
  assert.equal(header(VERSIONED, "Cache-Control"), "public, max-age=31536000, immutable");
  assert.deepEqual(rule(VERSIONED).has, [{ type: "query", key: "v" }], "only an address that carries a ?v= version is cached for a year");
  const known = new Set(["/sw.js", "/font/(.*)", "/(image|skill)/(.*)", VERSIONED, PUBLIC]);
  assert.equal(vercel.headers.filter((h) => !h.source.startsWith("/admin") && !known.has(h.source)).length, 0, "only the sw.js, picture/font caching and public-site rules exist besides the admin rules");
});

test("the page is noindex and every file it loads exists", () => {
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  for (const m of html.matchAll(/(?:src|href)="(\/[^"#]*)"/g)) {
    const rel = m[1].slice(1);
    assert.doesNotThrow(() => read(`public/${rel}`), m[1]);
  }
});

test("every icon the app asks for exists in the sprite", () => {
  const sprite = new Set([...html.matchAll(/<symbol id="i-([a-z]+)"/g)].map((m) => m[1]));
  const used = new Set([...Object.values(files).join("\n").matchAll(/icon\(\s*"([a-z]+)"|\bicon:\s*"([a-z]+)"|iconButton\(\s*"([a-z]+)"|lead:\s*"([a-z]+)"|\[\s*"(?:alert|lock)",/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]).filter(Boolean));
  for (const name of ["text", "image", "button", "work", "code", "feedback", "push", "logout", "github", "lock", "trash", "refresh", "prev", "next", "plus", "inbox", "alert"]) used.add(name);
  for (const name of used) assert.ok(sprite.has(name), `missing icon ${name}`);
});

test("public site: security headers that cannot break it, and a CSP that only allows what the page uses", () => {
  const csp = header(PUBLIC, "Content-Security-Policy");
  assert.ok(csp, "public CSP exists");
  for (const part of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'", "form-action 'none'", "worker-src 'self'", "connect-src 'self' https://api.lanyard.rest wss://api.lanyard.rest", "img-src 'self' data: https://cdn.jsdelivr.net"]) assert.ok(csp.includes(part), part);
  assert.ok(!/unsafe-eval/.test(csp) && !/(^|[ ;])\*/.test(csp) && !/ https:( |;|$)/.test(csp), "no eval, no bare wildcard or scheme source");
  assert.equal(header(PUBLIC, "X-Frame-Options"), "DENY");
  assert.equal(header(PUBLIC, "X-Content-Type-Options"), "nosniff");
  assert.equal(header(PUBLIC, "Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.ok(header(PUBLIC, "Permissions-Policy"));
  assert.ok(!rule(PUBLIC).headers.some((h) => h.key === "Cache-Control"), "caching is untouched");
  // the admin keeps its own, stricter rules: the public pattern must not match them
  const re = new RegExp(`^${PUBLIC.replace(/^\//, "/")}$`);
  for (const p of ["/admin", "/admin/app.js", "/api/admin/me", "/api/admin/push"]) assert.ok(!re.test(p), `${p} must not get the public rule`);
  for (const p of ["/", "/index.html", "/style.css", "/api/views", "/api/feedback", "/image/og.png", "/sw.js"]) assert.ok(re.test(p), `${p} must get the public rule`);
});

test("admin scripts and styles are kept but always revalidated; the page and the API stay no-store", () => {
  assert.equal(header("/admin/(.*)\\.(js|css)", "Cache-Control"), "no-cache");
  assert.equal(header("/admin", "Cache-Control"), "no-store");
  assert.equal(header("/admin/(.*)", "Cache-Control"), "no-store");
});

test("the admin page preloads every module the app imports, so they load side by side", () => {
  const preloaded = new Set([...html.matchAll(/<link rel="modulepreload" href="\/admin\/([a-z]+)\.js">/g)].map((m) => m[1]));
  const imported = new Set();
  for (const code of Object.values(files)) for (const m of code.matchAll(/from "\.\/([a-z]+)\.js"/g)) imported.add(m[1]);
  for (const name of imported) assert.ok(preloaded.has(name), `${name}.js is imported but not preloaded`);
  for (const name of preloaded) assert.ok(read(`public/admin/${name}.js`), `${name}.js is preloaded but missing`);
});

console.log(`admin page: ${passed} checks passed${process.exitCode ? " (some failed)" : ""}`);
