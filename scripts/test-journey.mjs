// Checks for the Journey page: content rules, sorting, build output and the page script's data reader. Run: node scripts/test-journey.mjs (also part of npm test)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { journeyDateKey, latestJourney, sortJourney, validateContent, LIMITS } from "./schema.mjs";
import { iconsIn, journeyData, renderPage } from "./render.mjs";
import { clampTo, markSeen, mount, readConfig, readSeen, unmount } from "../public/journey.js";
import * as core from "../public/journey/core.js";
import { SAMPLE_JOURNEY_ENTRIES } from "./fixtures.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shipped = JSON.parse(readFileSync(join(root, "content.json"), "utf8"));
const withSampleRoad = (content) => ({ ...content, journey: { ...content.journey, entries: structuredClone(SAMPLE_JOURNEY_ENTRIES) } });
const base = withSampleRoad(shipped);
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
const entry = (n, extra = {}) => ({ id: `e-${n}`, date: "2024-01", title: `t${n}`, text: "x", tag: "tag", icon: "code", visible: true, pinned: false, side: "auto", ...extra });

/* ---- the shipped content and the optional key ---- */
test("shipped journey is valid", () => assert.deepEqual(check(structuredClone(shipped)).errors, []));
test("the sample road is valid", () => assert.deepEqual(check(copy()).errors, []));
test("no journey key is valid, and builds a page without the Journey", () => {
  const c = copy(); delete c.journey;
  assert.deepEqual(check(c).errors, []);
  const html = renderPage(template, c);
  assert.ok(!/journey/i.test(html.replace(/<symbol id="i-route"[^>]*>[\s\S]*?<\/symbol>/, "")), "nothing about the Journey is left in the page");
  assert.equal((html.match(/data-go="/g) ?? []).length, 4);
});
test("enabled:false builds no nav item, page, style or data", () => {
  const c = copy(); c.journey.enabled = false;
  assert.deepEqual(check(c).errors, []);
  const html = renderPage(template, c);
  assert.ok(!/data-go="journey"|data-page="journey"|journey\.css|journey-data/.test(html));
});

/* ---- rules ---- */
rejects("journey is not an object", (c) => { c.journey = []; }, "journey: must be an object");
rejects("unknown journey key", (c) => { c.journey.extra = 1; }, 'unknown key "extra"');
rejects("missing journey key", (c) => { delete c.journey.seed; }, '"seed" is missing');
rejects("enabled is not a boolean", (c) => { c.journey.enabled = "yes"; }, "journey.enabled");
rejects("bad direction", (c) => { c.journey.direction = "up"; }, "journey.direction");
rejects("empty title", (c) => { c.journey.title = ""; }, "journey.title");
rejects("subtitle too long", (c) => { c.journey.subtitle = "x".repeat(41); }, "journey.subtitle");
rejects("seed with decimals", (c) => { c.journey.seed = 1.5; }, "journey.seed");
rejects("negative seed", (c) => { c.journey.seed = -1; }, "journey.seed");
rejects("path.amplitude too big", (c) => { c.journey.path.amplitude = 2; }, "journey.path.amplitude");
rejects("path.spacing too small", (c) => { c.journey.path.spacing = 10; }, "journey.path.spacing");
rejects("path.width as text", (c) => { c.journey.path.width = "46"; }, "journey.path.width");
rejects("path has an unknown key", (c) => { c.journey.path.depth = 1; }, 'unknown key "depth"');
rejects("NaN is not a number", (c) => { c.journey.path.jitter = null; }, "journey.path.jitter");
rejects("highlight colour", (c) => { c.journey.highlight.color = "white"; }, "journey.highlight.color");
rejects("highlight speed 0", (c) => { c.journey.highlight.speed = 0; }, "journey.highlight.speed");
rejects("entries is not a list", (c) => { c.journey.entries = {}; }, "journey.entries");
rejects("entry with a bad id", (c) => { c.journey.entries[0].id = "Bad Id"; }, "journey.entries[0].id");
rejects("duplicate entry id", (c) => { c.journey.entries[1].id = c.journey.entries[0].id; }, "used twice");
for (const [name, date] of [["words", "last spring"], ["month 13", "2024-13"], ["day 31 in april", "2024-04-31"], ["feb 30", "2024-02-30"], ["year 1800", "1800"], ["slashes", "2024/05/01"], ["day without month", "2024--05"]]) {
  rejects(`bad date: ${name}`, (c) => { c.journey.entries[0].date = date; }, "journey.entries[0].date");
}
test("good dates", () => {
  for (const date of ["2024", "2024-05", "2024-05-17", "2024-02-29", "1900", "2100-12-31"]) {
    const c = copy(); c.journey.entries[0].date = date;
    assert.deepEqual(check(c).errors, [], date);
  }
  const c = copy(); c.journey.entries[0].date = "2023-02-29"; // not a leap year
  assert.ok(check(c).errors.length);
});
rejects("entry title too long", (c) => { c.journey.entries[0].title = "x".repeat(LIMITS.journeyTitle + 1); }, "journey.entries[0].title");
rejects("entry text too long", (c) => { c.journey.entries[0].text = "x".repeat(LIMITS.journeyText + 1); }, "journey.entries[0].text");
rejects("entry text with a line break", (c) => { c.journey.entries[0].text = "a\nb"; }, "journey.entries[0].text");
rejects("entry text with an unclosed [[", (c) => { c.journey.entries[0].text = "a [[b"; }, "journey.entries[0].text");
rejects("entry text with a javascript: link", (c) => { c.journey.entries[0].text = "a [[b|javascript:alert(1)]]"; }, "journey.entries[0].text");
rejects("entry tag empty", (c) => { c.journey.entries[0].tag = ""; }, "journey.entries[0].tag");
rejects("entry tag too long", (c) => { c.journey.entries[0].tag = "x".repeat(21); }, "journey.entries[0].tag");
rejects("entry with an unknown icon", (c) => { c.journey.entries[0].icon = "nope"; }, "unknown icon");
rejects("entry side", (c) => { c.journey.entries[0].side = "middle"; }, "journey.entries[0].side");
rejects("entry visible is not a boolean", (c) => { c.journey.entries[0].visible = "true"; }, "journey.entries[0].visible");
rejects("entry pinned is missing", (c) => { delete c.journey.entries[0].pinned; }, '"pinned" is missing');
rejects("entry typo", (c) => { c.journey.entries[0].titel = "x"; }, 'unknown key "titel"');
rejects("entry image outside /image", (c) => { c.journey.entries[0].image = "/script.js"; }, "journey.entries[0].image");
rejects("entry image that does not exist", (c) => { c.journey.entries[0].image = "/image/journey/nope.webp"; }, "does not exist");
rejects("entry image escaping the folder", (c) => { c.journey.entries[0].image = "/image/../script.js"; }, "journey.entries[0].image");
rejects("entry link with javascript:", (c) => { c.journey.entries[0].link = { label: "x", url: "javascript:alert(1)" }; }, "journey.entries[0].link.url");
rejects("entry link without a label", (c) => { c.journey.entries[0].link = { url: "https://example.com" }; }, '"label" is missing');
rejects("entry link with an extra key", (c) => { c.journey.entries[0].link = { label: "x", url: "https://example.com", rel: "x" }; }, 'unknown key "rel"');
test("entry with an existing image and a link is valid", () => {
  const c = copy(); c.journey.entries[0].image = "/image/favicon.png"; c.journey.entries[0].link = { label: "see it", url: "https://example.com" };
  assert.deepEqual(check(c).errors, []);
});
test("entry cap", () => {
  const c = copy(); c.journey.entries = Array.from({ length: LIMITS.journeyEntries }, (_, i) => entry(i));
  assert.deepEqual(check(c).errors, []);
  c.journey.entries.push(entry(999));
  assert.ok(check(c).errors.some((e) => e.includes("at most")));
});
test("zero entries is valid and renders an empty note", () => {
  const c = copy(); c.journey.entries = [];
  assert.deepEqual(check(c).errors, []);
  const html = renderPage(template, c);
  assert.ok(html.includes("nothing here yet"));
  assert.equal(journeyData(c.journey).latest, null);
});
test("every error is reported, not just the first", () => {
  const c = copy(); c.journey.seed = -1; c.journey.path.width = 0; c.journey.entries[0].date = "x"; c.journey.entries[1].side = "up";
  assert.ok(check(c).errors.filter((e) => e.startsWith("journey.")).length >= 4);
});

/* ---- sorting ---- */
const ids = (list) => list.map((e) => e.id).join(",");
test("date keys", () => {
  assert.equal(journeyDateKey("2024"), "2024-00-00");
  assert.equal(journeyDateKey("2024-05"), "2024-05-00");
  assert.equal(journeyDateKey("2024-05-07"), "2024-05-07");
  for (const bad of ["", "x", 2024, null, undefined, "2024-1", "2024-00", "2024-05-00"]) assert.equal(journeyDateKey(bad), "", String(bad));
});
test("sort: newest first and oldest first, ties keep the list order, bad dates last, input untouched", () => {
  const list = [entry(1, { date: "2022" }), entry(2, { date: "2024-05" }), entry(3, { date: "bad" }), entry(4, { date: "2024-05" }), entry(5, { date: "2023-06-01" }), entry(6, { date: "2022-00" })];
  const before = ids(list);
  assert.equal(ids(sortJourney(list, "latest-top")), "e-2,e-4,e-5,e-1,e-3,e-6");
  assert.equal(ids(sortJourney(list, "latest-bottom")), "e-1,e-5,e-2,e-4,e-3,e-6");
  assert.equal(ids(list), before);
  assert.deepEqual(sortJourney([], "latest-top"), []);
});
test("a year is older than any month inside the same year", () => {
  const list = [entry(1, { date: "2024" }), entry(2, { date: "2024-01" })];
  assert.equal(ids(sortJourney(list, "latest-top")), "e-2,e-1");
  assert.equal(latestJourney(list).id, "e-2");
});
test("latest: newest visible entry, ties go to the later one, hidden and invalid ones never win", () => {
  assert.equal(latestJourney([entry(1, { date: "2024-05" }), entry(2, { date: "2024-05" })]).id, "e-2");
  assert.equal(latestJourney([entry(1, { date: "2020" }), entry(2, { date: "2030", visible: false })]).id, "e-1");
  assert.equal(latestJourney([entry(1, { date: "nope" })]), undefined);
  assert.equal(latestJourney([]), undefined);
});

/* ---- build output ---- */
test("page has the nav item, the shell, the stylesheet and the lazy script address", () => {
  const html = renderPage(template, copy());
  assert.match(html, /<a role="button" data-go="journey" aria-label="Journey" data-tip="Journey"><svg aria-hidden="true"><use href="#i-route"\/><\/svg><\/a>/);
  assert.match(html, /<main class="wrap view" data-page="journey" data-src="\/journey\.js">/);
  assert.ok(html.includes('<link rel="stylesheet" href="/journey.css">'));
  assert.ok(!/<script[^>]*journey/.test(html.replace(/<script type="application\/json"[\s\S]*?<\/script>/, "")), "journey.js is not loaded up front");
  assert.ok(html.includes('id="i-route"') && html.includes('id="jyStage"') && html.includes('id="journey-data"'));
});
test("nav order: skills, journey, feedback", () => {
  const html = renderPage(template, copy());
  const at = (s) => html.indexOf(`data-go="${s}"`);
  assert.ok(at("skills") < at("journey") && at("journey") < at("feedback"));
});
test("fallback list: one article per visible entry, newest first, latest marked, escaped", () => {
  const c = copy();
  c.journey.entries.push(entry(8, { id: "hidden-one", date: "2030", visible: false }));
  c.journey.entries[0].title = '"><script>1</script>';
  const html = renderPage(template, c);
  assert.equal((html.match(/class="card jy-item/g) ?? []).length, c.journey.entries.length - 1);
  assert.ok(!html.includes("hidden-one"), "hidden entries never leave the server");
  assert.ok(!html.includes("<script>1</script>"));
  assert.equal((html.match(/is-latest/g) ?? []).length, 1);
  assert.ok(html.indexOf('data-id="portfolio-live"') < html.indexOf('data-id="first-line-of-code"') || html.indexOf('data-id="first-line-of-code"') < 0);
  assert.match(html, /<time datetime="2026-10">oct 2026<\/time>/);
});
test("direction latest-bottom reverses the list", () => {
  const c = copy(); c.journey.direction = "latest-bottom";
  const html = renderPage(template, c);
  assert.ok(html.indexOf('data-id="first-line-of-code"') < html.indexOf('data-id="portfolio-live"'));
});
test("entry text keeps [[highlight]] and links; image and link render", () => {
  const c = copy();
  c.journey.entries[0].text = "a [[b]] and [[c|https://example.com]]";
  c.journey.entries[0].image = "/image/favicon.png";
  c.journey.entries[0].link = { label: "see it", url: "https://example.com/x" };
  const html = renderPage(template, c);
  assert.ok(html.includes('<span class="hi">b</span>') && html.includes('<a class="hi" href="https://example.com" target="_blank" rel="noopener noreferrer">c</a>'));
  assert.ok(html.includes('class="jy-img" src="/image/favicon.png"'));
  assert.ok(html.includes('rel="noopener noreferrer"><svg aria-hidden="true"><use href="#i-external"/></svg><span>see it</span>'));
});
test("data block: valid JSON that cannot close its script tag, only visible entries", () => {
  const c = copy();
  c.journey.entries[0].title = "</script><!-- & \u2028";
  c.journey.entries[1].visible = false;
  const html = renderPage(template, c);
  const m = /<script type="application\/json" id="journey-data">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "data block present");
  assert.ok(!/[<>&\u2028\u2029]/.test(m[1]), "no raw <, >, & or line separators inside the data");
  const data = JSON.parse(m[1]);
  assert.equal(data.entries.length, c.journey.entries.length - 1);
  assert.ok(data.entries.every((e) => e.visible !== false) && !data.entries.some((e) => e.id === c.journey.entries[1].id));
  assert.equal(data.entries.find((e) => e.id === c.journey.entries[0].id).title, "</script><!-- & \u2028");
  assert.equal(data.latest, "portfolio-live");
  assert.ok(data.ranges.path.spacing);
});

/* ---- the page script's reader: never trusts the data ---- */
const goodData = () => JSON.parse(/id="journey-data">([\s\S]*?)<\/script>/.exec(renderPage(template, copy()))[1]);
test("readConfig: good data comes through", () => {
  const cfg = readConfig(goodData());
  assert.equal(cfg.entries.length, base.journey.entries.length);
  assert.equal(cfg.latest, "portfolio-live");
  assert.equal(cfg.seed, base.journey.seed);
  assert.deepEqual(cfg.path, base.journey.path);
  assert.equal(cfg.highlight.color, "#c1c5ce");
});
test("readConfig: nothing to show", () => {
  for (const raw of [null, undefined, 5, "x", [], { enabled: false }]) assert.equal(readConfig(raw), null, String(raw));
});
test("readConfig: numbers are clamped, junk falls back, it never throws", () => {
  const raw = goodData();
  raw.path = { spacing: 1e9, amplitude: -4, curviness: "x", jitter: NaN, width: 33.7 };
  raw.highlight = { breathing: 1, speed: 99, color: "javascript:x" };
  raw.seed = "nope"; raw.direction = "sideways"; raw.title = 5;
  const cfg = readConfig(raw);
  assert.deepEqual(cfg.path, { spacing: 800, amplitude: 0.2, curviness: 0.55, jitter: 0.35, width: 34 });
  assert.deepEqual(cfg.highlight, { breathing: true, speed: 1, color: "#c1c5ce" });
  assert.equal(cfg.seed, 1);
  assert.equal(cfg.direction, "latest-top");
  assert.equal(cfg.title, "journey");
});
test("readConfig: bad entries are dropped, odd images and sides are cleaned, latest falls back", () => {
  const raw = goodData();
  raw.entries = [null, 5, { id: 1 }, { id: "a", date: "2024", title: "t", image: "//evil.example/x.png", side: "up", pinned: "yes" }, ...raw.entries];
  raw.latest = "does-not-exist";
  const cfg = readConfig(raw);
  assert.equal(cfg.entries[0].id, "a");
  assert.equal(cfg.entries[0].image, "");
  assert.equal(cfg.entries[0].side, "auto");
  assert.equal(cfg.entries[0].pinned, false);
  assert.equal(cfg.latest, "a");
  raw.entries = Array.from({ length: 500 }, (_, i) => ({ id: `e${i}`, date: "2024", title: "t" }));
  assert.equal(readConfig(raw).entries.length, 60);
});
test("readConfig: works without the range table", () => {
  const raw = goodData(); delete raw.ranges; raw.path.spacing = 99999;
  assert.equal(readConfig(raw).path.spacing, 800);
});
test("clampTo", () => {
  assert.equal(clampTo(5, [0, 1, false], 0.5), 1);
  assert.equal(clampTo(-5, [0, 1, false], 0.5), 0);
  assert.equal(clampTo(undefined, [0, 1, false], 0.5), 0.5);
  assert.equal(clampTo(2.6, [0, 10, true], 0), 3);
});

/* ---- STEP 2: the world's pure parts (public/journey/core.js) ---- */
const cfg = { seed: 20261009, nodes: 7, spacing: 340, amplitude: 0.62, jitter: 0.35 };
test("prng: same seed, same numbers; different seed differs", () => {
  const a = core.mulberry32(7), b = core.mulberry32(7), c = core.mulberry32(8);
  const x = [a(), a(), a()], y = [b(), b(), b()];
  assert.deepEqual(x, y);
  assert.notDeepEqual(x, [c(), c(), c()]);
  assert.ok(x.every((v) => v >= 0 && v < 1));
});
test("rubber band: untouched inside, soft and bounded outside, monotone", () => {
  assert.equal(core.rubber(50, 100), 50);
  assert.equal(core.rubber(0, 100), 0);
  assert.equal(core.rubber(100, 100), 100);
  const a = core.rubber(-30, 100), b = core.rubber(-300, 100), c = core.rubber(-1e9, 100);
  assert.ok(a < 0 && b < a && c > -90.0001 && c <= b);
  assert.ok(core.rubber(130, 100) > 100 && core.rubber(1e9, 100) < 190.0001);
});
test("wheel units and friction", () => {
  assert.equal(core.wheelDelta(10, 0, 800), 10);
  assert.equal(core.wheelDelta(3, 1, 800), 96);
  assert.equal(core.wheelDelta(1, 2, 800), 800);
  let v = 2; for (let i = 0; i < 400; i++) v = core.friction(v, 16);
  assert.ok(v < 0.004 && v > 0, "momentum fades out");
});
const heading = (L) => Math.round((Math.atan2(L.dx, L.dy) * 180) / Math.PI);
test("route: same seed gives the identical road, another seed does not", () => {
  const a = core.buildRoute(cfg), b = core.buildRoute(cfg), c = core.buildRoute({ ...cfg, seed: 1 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.legs, c.legs);
  assert.equal(a.points.length, cfg.nodes + 2);
  assert.equal(a.nodeS[0], 0);
  assert.equal(a.total, a.nodeS.at(-1));
});
test("route: straight stretches at any angle, never upward, legs join at corners, starting straight down", () => {
  for (const seed of [1, 7, 99, 20261009, 31337]) for (const nodes of [0, 1, 2, 7, 25, 60]) {
    const r = core.buildRoute({ ...cfg, seed, nodes }), L = r.legs;
    assert.equal(L.length, nodes + 1);
    assert.ok(L.every((l) => Math.abs(Math.hypot(l.dx, l.dy) - 1) < 1e-9 && l.dy >= 0), "unit direction, never upward");
    assert.deepEqual([L[0].dx, L[0].dy], [0, 1], "starts going down");
    for (let i = 1; i < L.length; i++) {
      assert.equal(L[i].s0, L[i - 1].s1);
      assert.ok(Math.abs(L[i].x0 - (L[i - 1].x0 + L[i - 1].dx * (L[i - 1].s1 - L[i - 1].s0))) < 1e-6 && Math.abs(L[i].y0 - (L[i - 1].y0 + L[i - 1].dy * (L[i - 1].s1 - L[i - 1].s0))) < 1e-6, "legs join at a corner");
    }
    assert.equal(L.at(-1).s1, r.total);
  }
});
test("route: straight, sideways and tilted stretches all occur, and the tilts zig-zag", () => {
  const r = core.buildRoute({ ...cfg, nodes: 60 }), h = r.legs.map(heading);
  assert.ok(h.some((a) => a === 0) && h.some((a) => Math.abs(a) === 90) && h.some((a) => Math.abs(a) > 15 && Math.abs(a) < 80), "vertical, horizontal and tilted");
  assert.ok(h.some((a) => a > 15 && a < 80) && h.some((a) => a < -15 && a > -80), "tilted both ways");
  for (let i = 1; i < h.length; i++) {
    const turn = Math.abs(h[i] - h[i - 1]);
    assert.ok(turn >= 20 && turn <= 126, `a corner turns by a real amount, never back over itself (${h[i - 1]} -> ${h[i]})`);
    assert.ok(h[i] * h[i - 1] <= 0, "a bend never keeps leaning the same way");
  }
});
/* the cards as the page lays them out: one per milestone, each with its own (measured) half height */
const cardsFor = (n, viewW, hhs) => Array.from({ length: n }, (_, i) => ({ ...(viewW < 640 ? { gap: 22, max: 168, min: 116, edge: 14 } : {}), viewW, hh: hhs?.[i] ?? 60 + ((i * 37) % 90), ...(i === 0 ? { grow: 1.14, edge: 6 } : {}) }));
const onScreen = (r, c, W, H, grow = 0) => r.plans.map((p, i) => i).filter((i) => { const p = r.plans[i]; return p.x < c.x + W / 2 - grow && p.x + p.w > c.x - W / 2 + grow && p.y + p.hh > c.y - H / 2 + grow && p.y - p.hh < c.y + H / 2 - grow; });
const SCREENS = [[1366, 768], [1920, 1080], [768, 1024], [390, 844], [360, 640], [844, 390], [1280, 600]];
const boxesOverlap = (a, b, m = 0) => a.x < b.x + b.w + m && a.x + a.w + m > b.x && a.y - a.hh < b.y + b.hh + m && a.y + a.hh + m > b.y - b.hh;
test("route: one or two cards are on the screen at every point of the road, never none, and two never overlap each other or the road", () => {
  let twos = 0, samples = 0;
  for (const [W, H] of SCREENS) for (const seed of [3, 4, 5, 6, 7, 20261009]) for (const nodes of [1, 2, 7, 20]) {
    const r = core.buildRoute({ ...cfg, seed, nodes, view: { w: W, h: H }, cards: cardsFor(nodes, W) });
    for (let s = 0; s <= r.total; s += 2) {
      const c = core.pointAt(r, s), on = onScreen(r, c, W, H), on4 = onScreen(r, c, W, H, 4); // a card counts as a third one only when it is more than 4 px on the screen
      samples++;
      assert.ok(on.length >= 1, `${W}x${H} seed ${seed} nodes ${nodes}: no card on the screen at distance ${s}`);
      assert.ok(on4.length <= 2, `${W}x${H} seed ${seed} nodes ${nodes}: ${on4.length} cards at distance ${s}`);
      if (on4.length === 2) twos++;
      const near = core.cardIndex(r.cuts, s, nodes);
      assert.ok(near >= 0 && near < nodes);
      assert.ok(Math.abs(r.nodeS[near + 1] - s) <= Math.min(...r.nodeS.slice(1, nodes + 1).map((v) => Math.abs(v - s))) + 1e-6, `the HUD names the card nearest the dot (${s}: ${near})`);
    }
    for (let i = 0; i + 1 < nodes; i++) {
      assert.ok(!boxesOverlap(r.plans[i], r.plans[i + 1]), `${W}x${H} seed ${seed}: cards ${i + 1} and ${i + 2} overlap`);
    }
    for (const [i, p] of r.plans.entries()) for (const L of r.legs) assert.ok(core.boxToLeg(L, p.x, p.y - p.hh, p.x + p.w, p.y + p.hh) > 0, `${W}x${H}: card ${i + 1} touches the road`);
    assert.equal(r.cuts.length, Math.max(0, nodes - 1));
    assert.ok(onScreen(r, core.pointAt(r, 0), W, H).length >= 1, "the first card is in view at the very start");
    assert.ok(onScreen(r, core.pointAt(r, r.total), W, H).length >= 1, "the last card is in view at the very end");
  }
  assert.ok(twos > samples * 0.15, "two cards share the screen for a good part of the road");
});
test("route: neighbouring cards go on opposite sides where the geometry allows", () => {
  let opposite = 0, pairs = 0;
  for (const [W, H] of SCREENS) for (const seed of [3, 4, 5]) {
    const r = core.buildRoute({ ...cfg, seed, nodes: 12, view: { w: W, h: H }, cards: cardsFor(12, W) });
    for (let i = 1; i < 12; i++) { pairs++; if (r.plans[i].side !== r.plans[i - 1].side) opposite++; }
  }
  assert.ok(opposite / pairs > 0.8, `most neighbours are on opposite sides (${opposite}/${pairs})`);
});
test("route: half distance: a stretch between two milestones is half the old hand-off length", () => {
  const W = 1366, H = 768, r = core.buildRoute({ ...cfg, nodes: 7, view: { w: W, h: H }, cards: cardsFor(7, W) });
  for (let k = 1; k < 7; k++) {
    const len = r.nodeS[k + 1] - r.nodeS[k], L = r.legs[k], a = r.plans[k - 1], b = r.plans[k];
    const exit = core.exitAlong(L.x0, L.y0, L.dx, L.dy, [a.x, a.y - a.hh, a.x + a.w, a.y + a.hh], W, H);
    const entry = core.exitAlong(0, 0, -L.dx, -L.dy, [b.x - L.x0 - L.dx * len, b.y - L.y0 - L.dy * len - b.hh, b.x - L.x0 - L.dx * len + b.w, b.y - L.y0 - L.dy * len + b.hh], W, H);
    assert.ok(len >= (exit + entry) / 2 - 4, `stretch ${k}: ${len} is never shorter than half of ${exit + entry}`);
    assert.ok(len <= Math.max(0.75 * (exit + entry), Math.max(exit, entry) + 5) + 5, `stretch ${k}: ${len} is far less than the old ${exit + entry}`);
  }
});
test("route: the hand-off is built from the card heights it is given (taller cards give longer stretches)", () => {
  const short = core.buildRoute({ ...cfg, nodes: 7, view: { w: 1366, h: 768 }, cards: cardsFor(7, 1366, Array(7).fill(60)) });
  const tall = core.buildRoute({ ...cfg, nodes: 7, view: { w: 1366, h: 768 }, cards: cardsFor(7, 1366, Array(7).fill(150)) });
  assert.ok(tall.total > short.total + 300);
  const big = core.buildRoute({ ...cfg, nodes: 7, view: { w: 1366, h: 1200 }, cards: cardsFor(7, 1366, Array(7).fill(60)) });
  assert.ok(big.total > short.total + 300, "a taller screen needs longer stretches");
});
test("route: every road has straight-down, sideways and tilted stretches, on every screen", () => {
  for (const [W, H] of SCREENS) for (let seed = 1; seed <= 40; seed++) for (const nodes of [6, 7, 12]) {
    const r = core.buildRoute({ ...cfg, seed: seed * 7919, nodes, view: { w: W, h: H }, cards: cardsFor(nodes, W) }), h = r.legs.map(heading);
    assert.ok(h.some((a) => a === 0) && h.some((a) => Math.abs(a) === 90) && h.some((a) => Math.abs(a) > 15 && Math.abs(a) < 80), `${W}x${H} seed ${seed * 7919} nodes ${nodes}: vertical, horizontal and tilted: ${h}`);
  }
});
test("route: a milestone is never closer than the safety minimum to the one before, and the gaps vary", () => {
  for (const [W, H] of SCREENS) for (const seed of [3, 4, 5, 20261009]) {
    const r = core.buildRoute({ ...cfg, seed, nodes: 30, view: { w: W, h: H }, cards: cardsFor(30, W) }), gaps = r.legs.slice(1, -1).map((l) => l.s1 - l.s0);
    assert.ok(Math.min(...gaps) >= core.MIN_GAP - 1e-9);
    assert.ok(Math.max(...gaps) > Math.min(...gaps) + 60, "gaps vary");
  }
});
test("route: every milestone sits exactly on a corner where two different stretches meet", () => {
  for (const seed of [2, 5, 12, 20261009, 777]) {
    const r = core.buildRoute({ ...cfg, seed, nodes: 30 });
    for (let i = 1; i <= 30; i++) {
      assert.equal(r.nodeS[i], r.legs[i].s0);
      assert.equal(r.nodeS[i], r.legs[i - 1].s1);
      assert.notEqual(heading(r.legs[i]), heading(r.legs[i - 1]));
    }
  }
});
test("route: 0 and 1 entries still build; amplitude and jitter extremes stay finite and near the middle", () => {
  assert.equal(core.buildRoute({ ...cfg, nodes: 0 }).points.length, 2);
  assert.equal(core.buildRoute({ ...cfg, nodes: 1 }).points.length, 3);
  for (const o of [{ jitter: 0, amplitude: 0.2 }, { jitter: 1, amplitude: 0.9 }]) {
    const r = core.buildRoute({ ...cfg, ...o, nodes: 30 });
    assert.ok(r.legs.every((l) => Object.values(l).every(Number.isFinite)));
  }
  const r = core.buildRoute({ ...cfg, nodes: 60 }); // the road wanders but is pulled back: it never drifts off for good
  assert.ok(Math.max(Math.abs(r.bounds.minX), Math.abs(r.bounds.maxX)) < 6000);
});
test("route: adding milestones never moves the earlier ones", () => {
  const a = core.buildRoute({ ...cfg, nodes: 6 }), b = core.buildRoute({ ...cfg, nodes: 12 });
  for (let i = 0; i < 7; i++) assert.deepEqual(a.points[i], b.points[i]);
  assert.deepEqual(a.nodeS.slice(0, 7), b.nodeS.slice(0, 7));
});
test("legSpan, distToLeg, boxToLeg: clipping and distances work for tilted stretches", () => {
  const d = Math.SQRT1_2, L = { s0: 0, s1: 100, x0: 0, y0: 0, dx: d, dy: d };
  const out = {};
  assert.ok(core.legSpan(L, 20, 0, 50, 200, out)); assert.ok(Math.abs(out.a - 20 / d) < 1e-9 && Math.abs(out.b - 50 / d) < 1e-9);
  assert.equal(core.legSpan(L, 200, 0, 300, 100, out), false);
  assert.equal(core.legSpan({ s0: 0, s1: 50, x0: 10, y0: 0, dx: 0, dy: 1 }, 20, 0, 30, 100, out), false, "vertical stretch beside the box");
  assert.ok(Math.abs(core.distToLeg(L, 50, 0) - 50 * d) < 1e-9);
  assert.ok(Math.abs(core.distToLeg(L, -30, -40) - 50) < 1e-9, "past the start: distance to the end point");
  assert.equal(core.boxToLeg(L, 40, 40, 60, 60), 0);
  assert.ok(Math.abs(core.boxToLeg(L, 100, 0, 150, 20) - core.distToLeg(L, 100, 20)) < 1e-9);
});
test("pointAt: on the road at every milestone, carries straight on past both ends", () => {
  const r = core.buildRoute(cfg);
  r.nodeS.forEach((s, i) => { const p = core.pointAt(r, s); assert.ok(Math.abs(p.x - r.points[i].x) < 1e-6); assert.ok(Math.abs(p.y - r.points[i].y) < 1e-6); });
  const first = core.pointAt(r, -50), end = core.pointAt(r, r.total + 50), p0 = r.points[0], pn = r.points.at(-1);
  assert.deepEqual([first.x, first.y], [p0.x + 0, p0.y - 50]);
  assert.deepEqual([end.x, end.y], [pn.x + end.dx * 50, pn.y + end.dy * 50]);
  const out = {}; assert.equal(core.pointAt(r, 100, out), out);
  for (let s = 0; s <= r.total; s += 13) { // continuous: no jump between neighbouring distances
    const a = core.pointAt(r, s), b = core.pointAt(r, s + 13);
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) <= 13 + 1e-6);
  }
});
test("routeIndex: fractional milestone index of a distance", () => {
  const r = core.buildRoute({ ...cfg, nodes: 12 });
  assert.equal(core.routeIndex(r.nodeS, -5), 0);
  assert.equal(core.routeIndex(r.nodeS, r.total + 5), r.nodeS.length - 1);
  assert.equal(core.routeIndex(r.nodeS, r.nodeS[4]), 4);
  assert.ok(Math.abs(core.routeIndex(r.nodeS, (r.nodeS[4] + r.nodeS[5]) / 2) - 4.5) < 1e-9);
});test("cardPlan: beside its corner on whichever side clears the road, on every kind of corner; the latest one is a little wider", () => {
  const hit = (a, b) => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
  for (const seed of [3, 20261009, 55, 8, 91, 12, 13]) for (const viewW of [360, 768, 1440]) {
    const view = { w: Math.ceil(viewW / 200) * 200, h: 1000 };
    const r = core.buildRoute({ ...cfg, seed, nodes: 30, view }), small = viewW < 640;
    const o = small ? { gap: 22, max: 168, min: 116, edge: 14 } : {}, boxes = [];
    for (let row = 1; row <= 30; row++) {
      const p = r.points[row], c = core.cardPlan(r, row, { viewW, ...o });
      assert.ok(c.side === "left" || c.side === "right");
      assert.ok(c.w >= (small ? 116 : 150) && c.w <= (small ? 168 : 210));
      assert.equal(c.y, p.y);
      assert.ok(c.side === "right" ? c.x > p.x : c.x + c.w < p.x, "beside the milestone, not over it");
      const box = [c.x, c.y - 100, c.x + c.w, c.y + 100];
      for (let i = Math.max(0, row - 3); i < Math.min(r.legs.length, row + 3); i++) assert.ok(core.boxToLeg(r.legs[i], ...box) >= 24, `${seed}/${viewW}: card ${row} on the road (stretch ${i})`);
      const big = core.cardPlan(r, row, { viewW, ...o, grow: 1.14, edge: 6, hh: 115 });
      assert.ok(big.w >= c.w && big.w <= viewW / 2 - 20, "the latest card is no narrower, and still on the screen");
      boxes.push(box);
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (j - i < 3) assert.ok(!hit(boxes[i], boxes[j]), `${seed}: neighbouring cards overlap`);
  }
  const wide = core.buildRoute({ ...cfg, nodes: 5 });
  assert.ok(core.cardPlan(wide, 2, { viewW: 1440, grow: 1.14 }).w > core.cardPlan(wide, 2, { viewW: 1440 }).w, "wider when there is room");
});
test("props: deterministic, sorted by y and clear of the road", () => {
  const route = core.buildRoute(cfg);
  const a = core.buildProps({ seed: 3, route, roadWidth: 46, count: 60 }), b = core.buildProps({ seed: 3, route, roadWidth: 46, count: 60 });
  assert.deepEqual(a, b);
  assert.ok(a.length > 20 && a.every((p, i) => i === 0 || a[i - 1].y <= p.y));
  for (const p of a) for (const L of route.legs) assert.ok(core.distToLeg(L, p.x, p.y) >= 23 + p.r - 0.01, "prop on the road");
});
test("props: a kind never repeats within one deal, and every kind appears", () => {
  const route = core.buildRoute({ ...cfg, nodes: 30 }), pr = core.buildProps({ seed: 5, route, roadWidth: 46, count: 200 });
  for (let i = 0; i < pr.length; i++) for (let j = Math.max(0, i - 3); j < i; j++) assert.notEqual(pr[i].kind, pr[j].kind, "same kind too close");
  assert.equal(new Set(pr.map((p) => p.kind)).size, core.PROP_KINDS);
  assert.ok(pr.every((p) => p.kind >= 0 && p.kind < core.PROP_KINDS));
});
test("scroll bounds: hard clamp, non-numbers become 0", () => {
  assert.equal(core.clampScroll(-50, 100), 0);
  assert.equal(core.clampScroll(500, 100), 100);
  assert.equal(core.clampScroll(NaN, 100), 0);
  assert.equal(core.clampScroll(40, 100), 40);
});
test("virtualisation window: only nearby props, empty and edge cases", () => {
  const ys = [100, 440, 780, 1120, 1460, 1800, 2140];
  assert.deepEqual(core.visibleRange(ys, 0, 800, 0), [0, 2]);
  assert.deepEqual(core.visibleRange(ys, 0, 800, 100), [0, 2]);
  assert.deepEqual(core.visibleRange(ys, 1000, 800, 0), [3, 5]);
  assert.deepEqual(core.visibleRange(ys, 5000, 800, 100), [-1, -1]);
  assert.deepEqual(core.visibleRange([], 0, 800, 100), [-1, -1]);
});
test("distance keeps its place across a resize", () => {
  assert.equal(core.progress(50, 200), 0.25);
  assert.equal(core.progress(5, 0), 0);
  assert.equal(core.fromProgress(0.25, 400), 100);
  assert.equal(core.fromProgress(9, 400), 400);
});
/* ---- the road is the same road every time (STEP 3: "random but fixed, 100%") ---- */
test("the shipped seed draws exactly this road, byte for byte (golden checksum)", () => {
  const r = core.buildRoute(cfg), sig = r.legs.map((l) => [l.s0, l.s1, l.x0, l.y0, l.dx, l.dy].map((v) => v.toFixed(3)).join(",")).join(";") + "|" + r.nodeS.map((v) => v.toFixed(3)).join(",");
  assert.equal(createHash("sha256").update(sig).digest("hex").slice(0, 16), "969992756bc0559b");
  assert.equal(base.journey.seed, 20261009);
});
test("entry order for the world follows the sorted list; direction decides the first row", () => {
  const list = [entry(1, { date: "2022" }), entry(2, { date: "2024-05" }), entry(3, { date: "2023" })];
  assert.equal(ids(sortJourney(list, "latest-top")), "e-2,e-3,e-1");
  assert.equal(ids(sortJourney(list, "latest-bottom")), "e-1,e-3,e-2");
});
test("text markers: bold, safe links only, plain text kept", () => {
  assert.deepEqual(core.splitMarks("a [[b]] c"), [{ t: "a ", hi: false }, { t: "b", hi: true }, { t: " c", hi: false }]);
  const l = core.splitMarks("[[x|https://example.com]]");
  assert.equal(l[0].url, "https://example.com");
  assert.equal(core.splitMarks("[[x|javascript:alert(1)]]")[0].url, undefined);
  assert.deepEqual(core.splitMarks(""), []);
});
test("date label matches the server list", () => {
  assert.equal(core.dateLabel("2026-10"), "oct 2026");
  assert.equal(core.dateLabel("2024"), "2024");
  assert.equal(core.dateLabel("2024-05-07"), "7 may 2024");
});
test("quality guard steps down one level at a time and stops at the floor", () => {
  assert.equal(core.nextQuality(0, 16), 0);
  assert.equal(core.nextQuality(0, 40), 1);
  assert.equal(core.nextQuality(1, 40), 2);
  assert.equal(core.nextQuality(2, 90), 2);
});
test("readConfig keeps safe links and /image paths only", () => {
  const raw = goodData();
  raw.entries = [{ id: "a", date: "2024", title: "t", image: "/image/journey/x.webp", link: { label: "see it", url: "https://example.com" } }, { id: "b", date: "2024", title: "t", image: "/image/../x.js", link: { label: "x", url: "javascript:alert(1)" } }];
  const c = readConfig(raw);
  assert.equal(c.entries[0].image, "/image/journey/x.webp");
  assert.equal(c.entries[0].link.url, "https://example.com");
  assert.equal(c.entries[1].image, "");
  assert.equal(c.entries[1].link, null);
});


/* ---- the road is the same road every time (STEP 3: "random but fixed, 100%") ---- */

/* ---- wheel gestures: the same boundaries the page-changing wheel uses ---- */
test("swipe tracker: a pause, a change of direction or a new swipe on top of a dying tail starts a gesture; the tail does not", () => {
  const t = core.swipeTracker();
  assert.equal(t.feed(0, 50), true, "the first event");
  let t0 = 0; for (const d of [60, 70, 66, 55, 40, 28, 18, 11, 7, 4]) assert.equal(t.feed((t0 += 16), d), false, `tail event ${d}`);
  assert.equal(t.feed(t0 + 16, 60), true, "a new swipe made on top of the tail (speed climbs again after dying down)");
  assert.equal(t.feed(t0 + 32, -8), true, "direction change");
  assert.equal(t.feed(t0 + 400, -8), true, "after a pause");
  assert.equal(t.feed(t0 + 416, -9), false);
  const arrived = core.swipeTracker(); arrived.seed(1000, 40);
  assert.equal(arrived.feed(1016, 36), false, "the tail of the swipe that opened the page");
  assert.equal(arrived.feed(1032, 30), false);
  assert.equal(arrived.feed(1500, 36), true, "the next gesture counts at once, with no waiting time");
});
test("edgeFor: at the top only outward (up) points out of the road, at the end only down", () => {
  assert.equal(core.edgeFor(0, 500, -1), true);
  assert.equal(core.edgeFor(0, 500, 1), false);
  assert.equal(core.edgeFor(500, 500, 1), true);
  assert.equal(core.edgeFor(500, 500, -1), false);
  assert.equal(core.edgeFor(250, 500, 1), false);
  assert.equal(core.edgeFor(250, 500, -1), false);
  assert.equal(core.edgeFor(-30, 500, -1), true, "still springing back from the rubber band");
  assert.equal(core.edgeFor(530, 500, 1), true);
});

/* ---- mount / unmount many times: nothing may be left behind (listeners, observers, frames, timers, nodes) ---- */
{
  const live = { listeners: 0, observers: 0 }, frames = new Map(), timers = new Set(), keyed = new Map();
  let fid = 0, clock = performance.now();
  const ctxStub = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === "createImageData" ? (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) : k === "getImageData" ? () => ({ data: new Uint8ClampedArray(4) }) : k === "createRadialGradient" || k === "createLinearGradient" ? () => ({ addColorStop() {} }) : k === "createPattern" ? () => ({}) : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  class El {
    constructor(tag) { this.tag = tag; this.kids = []; this.parent = null; this.style = {}; this.dataset = {}; this.cls = new Set(); this.attrs = {}; this.q = {}; this.hidden = false; this.width = 300; this.height = 150; this.textContent = ""; this.handlers = {}; }
    get classList() { const s = this.cls; return { add: (...a) => a.forEach((x) => s.add(x)), remove: (...a) => a.forEach((x) => s.delete(x)), toggle: (x, f) => ((f === undefined ? !s.has(x) : f) ? s.add(x) : s.delete(x)), contains: (x) => s.has(x) }; }
    set className(v) { this.cls = new Set(String(v).split(" ").filter(Boolean)); }
    get className() { return [...this.cls].join(" "); }
    get firstChild() { return this.kids[0] ?? null; }
    get lastChild() { return this.kids.at(-1) ?? null; }
    _ins(c, i) { if (typeof c === "string") return; c.remove(); c.parent = this; this.kids.splice(i, 0, c); }
    append(...n) { for (const c of n) this._ins(c, this.kids.length); }
    prepend(...n) { n.slice().reverse().forEach((c) => this._ins(c, 0)); }
    before(...n) { const p = this.parent; for (const c of n) p._ins(c, p.kids.indexOf(this)); }
    insertBefore(c, ref) { this._ins(c, ref ? this.kids.indexOf(ref) : this.kids.length); }
    remove() { if (this.parent) { this.parent.kids.splice(this.parent.kids.indexOf(this), 1); this.parent = null; } }
    setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; } removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, f, o) { live.listeners++; (this.handlers[t] ??= []).push(f); o?.signal?.addEventListener("abort", () => { live.listeners--; this.handlers[t] = this.handlers[t].filter((x) => x !== f); }); }
    removeEventListener() {}
    querySelector(sel) { return this.q[sel] ?? null; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 700 }; }
    getContext() { return ctxStub; }
    matches() { return false; } closest() { return null; } focus() {} setPointerCapture() {} releasePointerCapture() {}
    fire(type, ev = {}) { for (const f of [...(this.handlers[type] ?? [])]) f({ preventDefault() {}, stopPropagation() {}, target: this, ...ev }); }
  }
  const listen = (t, f, o) => { live.listeners++; (keyed.get(t) ?? keyed.set(t, []).get(t)).push(f); o?.signal?.addEventListener("abort", () => { live.listeners--; keyed.set(t, keyed.get(t).filter((x) => x !== f)); }); };
  const win = (type, ev = {}) => { const calls = { prevented: 0 }; for (const f of [...(keyed.get(type) ?? [])]) f({ preventDefault() { calls.prevented++; }, stopPropagation() {}, ...ev }); return calls; };
  const saveGlobals = {};
  const setGlobal = (k, v) => { saveGlobals[k] = Object.getOwnPropertyDescriptor(globalThis, k); Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); };
  const env2 = (search = "") => {
    setGlobal("window", globalThis); setGlobal("devicePixelRatio", 2); setGlobal("Element", El); setGlobal("location", { search });
    setGlobal("document", { hidden: false, createElement: (t) => new El(t), createElementNS: (_, t) => new El(t), addEventListener: listen, documentElement: new El("html") });
    setGlobal("matchMedia", (q) => ({ matches: false, addEventListener: listen, media: q }));
    setGlobal("ResizeObserver", class { observe() { live.observers++; this.on = true; } disconnect() { if (this.on) live.observers--; this.on = false; } });
    setGlobal("Path2D", class { moveTo() {} lineTo() {} });
    setGlobal("requestAnimationFrame", (cb) => { frames.set(++fid, cb); return fid; });
    setGlobal("cancelAnimationFrame", (id) => frames.delete(id));
    setGlobal("addEventListener", listen);
    setGlobal("sessionStorage", { _m: new Map(), getItem(k) { return this._m.get(k) ?? null; }, setItem(k, v) { this._m.set(k, v); } });
    const st = globalThis.setTimeout, ct = globalThis.clearTimeout;
    setGlobal("setTimeout", (f, ms) => { const id = st(() => { timers.delete(id); f(); }, ms); timers.add(id); return id; });
    setGlobal("clearTimeout", (id) => { timers.delete(id); ct(id); });
    saveGlobals.__st = st; saveGlobals.__ct = ct;
  };
  const restore = () => {
    for (const [k, d] of Object.entries(saveGlobals)) { if (k.startsWith("__")) continue; if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
    globalThis.setTimeout = saveGlobals.__st; globalThis.clearTimeout = saveGlobals.__ct;
  };
  const flush = (n) => { for (let i = 0; i < n; i++) { const cbs = [...frames.values()]; frames.clear(); clock += 16; cbs.forEach((cb) => cb(clock)); } };
  const makeView = (content) => {
    const view = new El("main"), stage = new El("div"), list = new El("ol"), data = new El("script");
    data.textContent = JSON.stringify(journeyData(content.journey));
    list.append(new El("li"));
    stage.append(list); view.append(stage);
    Object.assign(view.q, { "#journey-data": data, "#jyStage": stage, "#jyList": list });
    view.cls.add("on");
    return { view, stage, list };
  };
  const names = (stage) => stage.kids.map((k) => k.className).join("|");

  test("20 mounts and unmounts leave no listener, observer, frame, timer or node behind", () => {
    env2();
    try {
      for (let i = 0; i < 20; i++) {
        const { view, stage } = makeView(base);
        mount(view);
        assert.ok(/jy-spot/.test(names(stage)), "the vignette canvas exists while mounted");
        flush(12);
        stage.fire("pointerdown", { pointerId: 1, pointerType: "mouse", clientX: 300, clientY: 300, button: 0, timeStamp: clock });
        for (let k = 0; k < 6; k++) { stage.fire("pointermove", { pointerId: 1, pointerType: "mouse", clientX: 300 + k * 90, clientY: 300 + k * 20, timeStamp: clock + k }); flush(2); }
        stage.fire("pointerup", { pointerId: 1, pointerType: "mouse", clientX: 800, clientY: 400, timeStamp: clock });
        win("wheel", { deltaY: 240, deltaX: 0, deltaMode: 0, timeStamp: clock + 1000, target: view });
        flush(60);
        unmount();
        assert.equal(live.listeners, 0, `listeners after cycle ${i}`);
        assert.equal(live.observers, 0, "observers");
        assert.equal(frames.size, 0, "pending animation frames");
        assert.equal(timers.size, 0, "pending timers");
        assert.equal(stage.kids.length, 1, `only the list is left in the stage: ${names(stage)}`);
        assert.equal(view.attrs["data-hold"], undefined);
      }
    } finally { try { unmount(); } catch { /* already unmounted */ } restore(); }
  });
  test("a journey with no entries still mounts, draws the empty road and unmounts cleanly", () => {
    env2();
    try {
      const c = copy(); c.journey.entries = [];
      const { view, stage } = makeView(c);
      mount(view); flush(10);
      win("wheel", { deltaY: 200, deltaX: 0, deltaMode: 0, timeStamp: clock + 1000, target: view });
      flush(30);
      unmount();
      assert.equal(view.dataset.world, undefined);
      assert.equal(stage.kids.length, 1);
    } finally { try { unmount(); } catch { /* already unmounted */ } restore(); }
  });
  test("wheel, keys and swipes: the road keeps them, except at an end they point out of, where the page change gets them", () => {
    env2();
    try {
      const { view } = makeView(base);
      mount(view); flush(80); // settled at the latest card: the top of the road, glide finished
      view.attrs["data-hold"] = ""; // (what script.js sets while the page is open)
      // top of the road is pos 0 after Home
      const key = (k, extra = {}) => win("keydown", { key: k, repeat: false, target: view, timeStamp: clock, ...extra });
      key("Home"); flush(120);
      assert.equal(key("ArrowUp").prevented, 0, "ArrowUp at the very top is not taken (script.js changes the page)");
      assert.equal(view.attrs["data-hold"], undefined, "so the page's input is released for that one event");
      unmount(); mount(view); flush(80); view.attrs["data-hold"] = ""; key("Home"); flush(120);
      assert.equal(key("ArrowDown").prevented, 1, "ArrowDown at the top moves the road");
      assert.equal(view.attrs["data-hold"], "", "and the road keeps the input");
      flush(60);
      let w = win("wheel", { deltaY: 33.3, deltaX: 0, deltaMode: 0, timeStamp: clock + 5000, target: view });
      assert.equal(w.prevented, 1, "wheel down mid-road is the road's");
      assert.equal(view.attrs["data-hold"], "");
      key("End"); flush(160);
      w = win("wheel", { deltaY: 40.1, deltaX: 0, deltaMode: 0, timeStamp: clock + 9000, target: view });
      assert.equal(view.attrs["data-hold"], undefined, "a fresh wheel gesture down at the very end is released to the page change");
      for (let i = 1; i < 8; i++) win("wheel", { deltaY: 40.1 - i, deltaX: 0, deltaMode: 0, timeStamp: clock + 9000 + i * 16, target: view });
      assert.equal(view.attrs["data-hold"], undefined, "the rest of that gesture is the page change's too");
      unmount();
      assert.equal(timers.size, 0, "the one-event release leaves no timer behind");
    } finally { try { unmount(); } catch { /* already unmounted */ } restore(); }
  });
  test("opening: only the tail of the swipe or held key that opened the page waits; the next gesture works at once", () => {
    env2();
    try {
      const { view } = makeView(base);
      const opened = { wheel: { t: performance.now(), d: 40, notch: false }, key: "" };
      mount(view, opened); flush(80);
      view.attrs["data-hold"] = "";
      const tail = win("wheel", { deltaY: 36, deltaX: 0, deltaMode: 0, timeStamp: opened.wheel.t + 16, target: view });
      assert.equal(tail.prevented, 1, "the tail is swallowed (the browser must not scroll either)");
      const fresh = win("wheel", { deltaY: 36, deltaX: 0, deltaMode: 0, timeStamp: opened.wheel.t + 400, target: view });
      assert.equal(fresh.prevented, 1);
      unmount();
      const held = { wheel: null, key: "arrowdown" };
      mount(view, held); flush(80);
      win("keydown", { key: "Home", repeat: false, target: view, timeStamp: clock }); flush(120); // (the road resumes where it was left: start from the top)
      assert.equal(win("keydown", { key: "ArrowDown", repeat: true, target: view, timeStamp: clock }).prevented, 1, "a repeat of the opening key is swallowed");
      assert.equal(win("keydown", { key: "ArrowDown", repeat: false, target: view, timeStamp: clock }).prevented, 1, "a fresh press works at once");
      unmount();
    } finally { try { unmount(); } catch { /* already unmounted */ } restore(); }
  });
  test("no clouds anywhere: no fog canvas, no reveal button, no hint", () => {
    env2();
    try {
      const { view, stage } = makeView(base);
      mount(view); flush(20);
      assert.ok(!/jy-fog|jy-reveal|jy-hint/.test(names(stage)), names(stage));
      unmount();
    } finally { try { unmount(); } catch { /* already unmounted */ } restore(); }
  });
  test("an old content.json that still has a clouds block builds and is ignored", () => {
    const c = copy(); c.journey.clouds = { enabled: true, density: 0.8 };
    assert.deepEqual(check(c).errors, []);
    assert.ok(!/clouds/.test(renderPage(template, c)));
  });
}


/* ---- first visit starts at the start marker, a return visit on the current card; the cookie ---- */
const fakeEnv = ({ cookie = "", store = {}, blockStorage = false, blockCookie = false, https = true } = {}) => {
  const env = { location: { protocol: https ? "https:" : "http:" }, written: [] };
  const jar = { v: cookie };
  Object.defineProperty(env, "localStorage", { get() { if (blockStorage) throw new Error("SecurityError"); return { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } }; } });
  env.document = { get cookie() { if (blockCookie) throw new Error("blocked"); return jar.v; }, set cookie(v) { if (blockCookie) throw new Error("blocked"); env.written.push(v); jar.v = jar.v ? `${jar.v}; ${v.split(";")[0]}` : v.split(";")[0]; } };
  return env;
};
test("cookie decision: a new visitor is new, markSeen writes the cookie and the copy, and then the visitor is a returning one", () => {
  const e = fakeEnv();
  assert.equal(readSeen(e), false);
  markSeen(e);
  assert.match(e.written[0], /^jy-seen=1; max-age=31536000; path=\/; SameSite=Lax; Secure$/);
  assert.equal(readSeen(e), true);
  assert.equal(readSeen(fakeEnv({ store: { "jy-seen": "1" } })), true, "the localStorage copy alone is enough");
  assert.equal(readSeen(fakeEnv({ cookie: "a=1; jy-seen=1; b=2" })), true, "the cookie alone is enough, anywhere in the jar");
  assert.equal(readSeen(fakeEnv({ cookie: "xjy-seen=1; jy-seen=0" })), false, "only the exact cookie counts");
  const plain = fakeEnv({ https: false }); markSeen(plain);
  assert.ok(!plain.written[0].includes("Secure"), "Secure only on https");
});
test("cookie decision: blocked storage or cookies never throw; with both blocked the visitor is new every time", () => {
  for (const o of [{ blockStorage: true }, { blockCookie: true }, { blockStorage: true, blockCookie: true }]) {
    const e = fakeEnv(o);
    assert.doesNotThrow(() => { readSeen(e); markSeen(e); });
  }
  const both = fakeEnv({ blockStorage: true, blockCookie: true });
  markSeen(both); assert.equal(readSeen(both), false);
  assert.equal(readSeen(fakeEnv({ blockStorage: true })), false);
  assert.equal(readSeen(fakeEnv({ blockCookie: true, store: { "jy-seen": "1" } })), true);
  assert.equal(readSeen({}), false, "no document, no storage at all");
  markSeen({});
});
test("start place: a new visitor starts on the start marker (the far end with latest-top, the top with latest-bottom), a returning one on the current card", () => {
  assert.equal(core.startS("latest-top", 5000), 5000);
  assert.equal(core.startS("latest-bottom", 5000), 0);
  assert.equal(core.openingPos(false, "latest-top", 5000, 700), 5000);
  assert.equal(core.openingPos(false, "latest-bottom", 5000, 4300), 0);
  assert.equal(core.openingPos(true, "latest-top", 5000, 700), 700);
  assert.equal(core.openingPos(true, "latest-bottom", 5000, 4300), 4300);
});
test("trail origin: a new visitor\'s line begins at the start marker, a returning visitor\'s at the \"i am here\" marker", () => {
  assert.equal(core.trailOrigin(false, "latest-top", 5000), 5000);
  assert.equal(core.trailOrigin(true, "latest-top", 5000), 0);
  assert.equal(core.trailOrigin(false, "latest-bottom", 5000), 0);
  assert.equal(core.trailOrigin(true, "latest-bottom", 5000), 5000);
});
/* ---- the trail: from the start marker to the dot ---- */
test("trail: starts at the start marker, ends exactly at the dot, follows every corner, and is empty on the marker", () => {
  const W = 1366, H = 768, r = core.buildRoute({ ...cfg, nodes: 9, view: { w: W, h: H }, cards: cardsFor(9, W) });
  const buf = new Float64Array(5 * (r.legs.length + 2)), huge = [-1e6, -1e6, 1e6, 1e6];
  for (const dir of ["latest-top", "latest-bottom"]) {
    const start = core.startS(dir, r.total);
    assert.equal(core.trailSegs(r, Math.min(start, start), Math.max(start, start), huge, buf), 0, "empty while the dot is on the start marker");
    for (const dot of [1, r.total * 0.2, r.nodeS[3], r.nodeS[3] + 0.001, r.total * 0.5, r.total - 1, r.total]) {
      if (Math.abs(dot - start) < 1e-6) continue;
      const lo = Math.min(start, dot), hi = Math.max(start, dot), n = core.trailSegs(r, lo, hi, huge, buf);
      const a = core.pointAt(r, lo), b = core.pointAt(r, hi);
      assert.ok(n >= 1);
      assert.ok(Math.hypot(buf[0] - a.x, buf[1] - a.y) < 1e-6, "the first piece begins at the lower end");
      assert.ok(Math.hypot(buf[(n - 1) * 5 + 2] - b.x, buf[(n - 1) * 5 + 3] - b.y) < 1e-6, "the last piece ends at the upper end");
      // the whole trail is continuous (one chain) and as long as the road between its ends
      let len = 0;
      for (let i = 0; i < n; i++) {
        const o = i * 5; len += Math.hypot(buf[o + 2] - buf[o], buf[o + 3] - buf[o + 1]);
        if (i) { assert.equal(buf[o + 4], 1, "pieces chain"); assert.ok(Math.hypot(buf[o] - buf[o - 3], buf[o + 1] - buf[o - 2]) < 1e-6, "no gap at the corner"); }
      }
      assert.ok(Math.abs(len - (hi - lo)) < 1e-6, "its length is the distance travelled from the start marker");
    }
  }
  // it grows and shrinks with the dot: more road, longer trail
  const len = (d) => { const n = core.trailSegs(r, 0, d, huge, buf); let t = 0; for (let i = 0; i < n; i++) t += Math.hypot(buf[i * 5 + 2] - buf[i * 5], buf[i * 5 + 3] - buf[i * 5 + 1]); return t; };
  assert.ok(len(400) < len(900) && len(900) < len(r.total));
});
test("trail: cut to the screen, it stays on the screen, ends where the road leaves it, and allocates nothing", () => {
  const W = 390, H = 844, r = core.buildRoute({ ...cfg, nodes: 9, view: { w: W, h: H }, cards: cardsFor(9, W) });
  const buf = new Float64Array(5 * (r.legs.length + 2)), c = core.pointAt(r, r.total / 2), rect = [c.x - W / 2 - 80, c.y - H / 2 - 80, c.x + W / 2 + 80, c.y + H / 2 + 80];
  const n = core.trailSegs(r, 0, r.total / 2, rect, buf);
  assert.ok(n >= 1 && n < r.legs.length);
  for (let i = 0; i < n; i++) for (const k of [0, 2]) { assert.ok(buf[i * 5 + k] >= rect[0] - 1e-6 && buf[i * 5 + k] <= rect[2] + 1e-6); assert.ok(buf[i * 5 + k + 1] >= rect[1] - 1e-6 && buf[i * 5 + k + 1] <= rect[3] + 1e-6); }
  assert.ok(Math.hypot(buf[(n - 1) * 5 + 2] - c.x, buf[(n - 1) * 5 + 3] - c.y) < 1e-6, "the line ends exactly at the dot");
});
test("journey.js is fetched in the background when the browser is idle (not only on click) and can warm itself up", () => {
  const script = readFileSync(join(root, "public/script.js"), "utf8");
  assert.match(script, /requestIdleCallback/);
  assert.match(script, /idle\(\(\) => load\(\)/, "the background load is scheduled when idle");
  assert.match(script, /saveData/, "a data-saver visitor keeps the lazy behaviour");
  assert.match(script, /m\.warm\?\.\(view\)/);
  assert.match(readFileSync(join(root, "public/journey.js"), "utf8"), /export function warm\(view\)/);
});
console.log(process.exitCode ? "\nsome journey checks failed" : `all ${passed} journey checks passed`);
