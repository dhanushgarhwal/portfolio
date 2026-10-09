// Builds the static site: content.json + templates/*.template.html -> public/*.html.
// Runs on Vercel for every deploy (npm run build) and locally. Any problem stops the build with a readable list
// and a non-zero exit code, so a bad content.json can never go live.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateContent } from "./schema.mjs";
import { iconsIn, renderPage } from "./render.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = [
  { template: "templates/index.template.html", out: "public/index.html" },
];

// The page loads its own styles and scripts as /file?v=<hash of the file>. The address changes only when the file does, so the browser can keep
// each version for a year without asking (vercel.json: immutable for these addresses) and a deploy still shows the new files at once.
const ASSETS = ["state.css", "style.css", "feedback.css", "fonts.js", "script.js", "feedback.js"];
const ASSET_URL = new RegExp(`(href|src)="/(${ASSETS.map((a) => a.replace(".", "\\.")).join("|")})"`, "g");
const stamp = (html) => html.replace(ASSET_URL, (_, attr, file) => {
  const hash = createHash("sha256").update(readFileSync(join(root, "public", file))).digest("hex").slice(0, 10);
  return `${attr}="/${file}?v=${hash}"`;
});

const fail = (lines) => {
  console.error(`\nbuild stopped:\n${lines.map((l) => `  - ${l}`).join("\n")}\n`);
  process.exit(1);
};

let content;
try {
  content = JSON.parse(readFileSync(join(root, "content.json"), "utf8"));
} catch (e) {
  fail([`content.json cannot be read: ${e.message}`]);
}

const templates = PAGES.map((p) => ({ ...p, source: readFileSync(join(root, p.template), "utf8") }));
const icons = iconsIn(templates[0].source); // the page's sprite decides which icons exist
const fileExists = (publicPath) => existsSync(join(root, "public", publicPath));

const { errors, warnings } = validateContent(content, { icons, fileExists });

for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length) fail(errors);

try {
  for (const { source, out } of templates) {
    const html = stamp(renderPage(source, content));
    const target = join(root, out);
    writeFileSync(`${target}.tmp`, html);
    renameSync(`${target}.tmp`, target); // the old page stays until the new one is complete
    console.log(`built ${out} (${html.length} bytes)`);
  }
} catch (e) {
  fail([e.message]);
}
