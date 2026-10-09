// content.json + template -> final HTML. Pure functions: no files, no network.
// Template syntax: {{path.to.value}} is HTML-escaped; {{{name}}} is a block this file built (already escaped).
// A {{{block}}} alone on its line disappears with its line when it is empty.
import { parseAbout } from "./schema.mjs";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ESC[c]);

const MIME = { webp: "image/webp", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", avif: "image/avif", svg: "image/svg+xml" };
const mimeOf = (path) => MIME[path.split(".").pop().toLowerCase()];
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${esc(name)}"/></svg>`;

// External links open in a new tab, mailto/tel and same-site paths stay in the tab.
function linkAttrs(url) {
  if (url.startsWith("/") || /^(mailto|tel):/i.test(url)) return `href="${esc(url)}"`;
  return `href="${esc(url)}" target="_blank" rel="noopener noreferrer"`;
}

// Round buttons on the home page carry an aria-label; the text button on a project card is named by its own text.
const chip = ({ label, icon: name, url, mail, aria = true }) => {
  const href = mail ? 'href="https://mail.google.com/" target="_blank" rel="noopener noreferrer"' : linkAttrs(url);
  return `<a class="chip"${mail ? " data-mail" : ""} ${href}${aria ? ` aria-label="${esc(label)}"` : ""}>${icon(name)}<span>${esc(label)}</span></a>`;
};

function about(source) {
  return parseAbout(source).map((p) => {
    if (p.text !== undefined) return esc(p.text);
    return p.url ? `<a class="hi" ${linkAttrs(p.url)}>${esc(p.hi)}</a>` : `<span class="hi">${esc(p.hi)}</span>`;
  }).join("");
}

function links(buttons) {
  const shown = buttons.filter((b) => b.visible);
  if (!shown.length) return "";
  const rows = shown.map((b) => `      ${chip({ label: b.label, icon: b.icon, url: b.url, mail: b.type === "mail" })}`);
  return `<div class="links in" style="--i:2">\n${rows.join("\n")}\n    </div>`;
}

function project(p) {
  const letter = [...p.name][0].toUpperCase();
  const foot = p.button ? `\n        <div class="foot">${chip({ ...p.button, aria: false })}</div>` : "";
  // The odd spacing after </a> is how the page has always been written; kept so the output stays byte-identical.
  return `    <article class="card slide" aria-label="${esc(p.name)}">
      <i class="hl"></i>
        <a class="shot" ${linkAttrs(p.url)} aria-label="Open ${esc(p.name)}"><img src="${esc(p.image)}" alt="" width="${p.imageWidth}" height="${p.imageHeight}" decoding="async" draggable="false"></a>      <div class="info">
        <h2><span class="pi">${esc(letter)}<img src="${esc(p.icon)}" alt="" width="18" height="18" decoding="async" draggable="false"></span>${esc(p.name)}</h2>
        <p>${esc(p.description)}</p>${foot}
      </div>
    </article>`;
}

function tile(x) {
  const a = x.art;
  let art;
  if (a.kind === "image") {
    art = `<b class="ltr">${esc(a.letter)}</b><img src="${esc(a.src)}"${a.cdn ? ` data-cdn="${esc(a.cdn)}"` : ""} alt="" width="52" height="52" decoding="async" draggable="false">`;
  } else if (a.kind === "sprite") {
    art = icon(a.icon);
  } else {
    art = `<b class="ltr keep">${esc(a.letter)}</b>`;
  }
  return `      <article class="card tile" style="--c:${esc(x.color)}" aria-label="${esc(x.name)}"><i class="hl"></i><span class="art">${art}</span><h3>${esc(x.name)}</h3></article>`;
}

export function renderPage(template, content, env = {}) {
  const projects = content.projects.filter((p) => p.visible);
  // tiles follow the order in content.json (the admin reorders it); the first one is selected when the page opens
  const stack = content.stack.filter((x) => x.visible);
  const first = projects[0];
  const preload = first
    ? `<link rel="preload" as="image" href="${esc(first.image)}"${mimeOf(first.image) ? ` type="${mimeOf(first.image)}"` : ""}>`
    : "";

  const blocks = {
    preloadProject: preload,
    about: about(content.texts.home.about),
    links: links(content.buttons),
    projects: projects.map(project).join("\n"),
    tiles: stack.map(tile).join("\n"),
  };
  const values = content;

  const lookup = (path) => {
    let v = values;
    for (const key of path.split(".")) v = v?.[key];
    if (typeof v !== "string") throw new Error(`template needs "${path}" but content.json has no text there`);
    return v;
  };

  // 1) blocks, removing the whole line of an empty one  2) plain values, escaped
  let out = template.replace(/^[ \t]*\{\{\{(\w+)\}\}\}[ \t]*\n|\{\{\{(\w+)\}\}\}/gm, (m, lineName, name) => {
    const key = lineName ?? name;
    if (!(key in blocks)) throw new Error(`template has an unknown block {{{${key}}}}`);
    if (lineName && blocks[key] === "") return "";
    return lineName ? `${m.slice(0, m.indexOf("{{{"))}${blocks[key]}\n` : blocks[key];
  });
  out = out.replace(/\{\{([\w.]+)\}\}/g, (_, path) => esc(lookup(path)));
  if (/\{\{/.test(out)) throw new Error("template still has an unreplaced {{ }}");

  // the body carries what script.js needs (email address, Discord account)
  out = out.replace("<body>", `<body data-email="${esc(content.site.email)}" data-discord="${esc(content.site.discordId)}">`);
  return out;
}

// Names of the icons the template provides: <symbol id="i-github"> -> "github".
export const iconsIn = (template) => [...template.matchAll(/<symbol id="i-([\w-]+)"/g)].map((m) => m[1]);
