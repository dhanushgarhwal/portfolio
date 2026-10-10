// Strict SVG sanitizer. Pure string code (no DOM, no dependencies), so the admin page and the server (which imports this file) use the same rules.
// It does not "clean" markup with regexes: it tokenises the file, keeps only allow-listed elements and attributes,
// and writes the SVG out again from those tokens. Anything unexpected rejects the file.
//
// Rejected: DOCTYPE/ENTITY, CDATA, processing instructions, <script>, <style>, <foreignObject>, <image>, <a>, <animate*>, <set>,
// event attributes, style attributes, external references (href must be "#id", url() must be "#id"), non-numeric geometry.

export const SVG_LIMITS = { bytes: 40_000, elements: 400, depth: 24 };

const ELEMENTS = new Set([
  "svg", "g", "defs", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "title", "desc",
  "lineargradient", "radialgradient", "stop", "clippath", "mask", "symbol", "use",
]);
const CANON = { lineargradient: "linearGradient", radialgradient: "radialGradient", clippath: "clipPath" };

const ATTRS = new Set([
  "id", "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "width", "height", "points", "transform",
  "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset",
  "stroke-opacity", "fill-opacity", "opacity", "fill-rule", "clip-rule", "clip-path", "mask", "offset", "stop-color", "stop-opacity",
  "gradientunits", "gradienttransform", "spreadmethod", "fx", "fy", "viewbox", "preserveaspectratio", "href", "xmlns", "xmlns:xlink",
  "xlink:href", "version", "clippathunits", "maskunits", "maskcontentunits", "patterntransform",
]);
const ATTR_CANON = { viewbox: "viewBox", preserveaspectratio: "preserveAspectRatio", gradientunits: "gradientUnits", gradienttransform: "gradientTransform",
  spreadmethod: "spreadMethod", clippathunits: "clipPathUnits", maskunits: "maskUnits", maskcontentunits: "maskContentUnits", patterntransform: "patternTransform" };

const NS = new Set(["http://www.w3.org/2000/svg", "http://www.w3.org/1999/xlink"]);
const COLOR = /^(none|currentColor|transparent|#[0-9a-fA-F]{3,8}|(rgb|hsl)a?\(\s*[-0-9.%\s,/]+\)|[a-zA-Z]{3,20}|url\(#[A-Za-z0-9_.:-]{1,60}\))$/;
const NUMS = /^[-+0-9.eE\s,%a-z()]*$/; // numbers, units, transform functions; letters allowed only inside this charset (no quotes, <, >, &, ;, :, /)
const PATH = /^[MmZzLlHhVvCcSsQqTtAa0-9eE+\-.,\s]*$/;
const ID_REF = /^#[A-Za-z0-9_.:-]{1,60}$/;
const IDENT = /^[A-Za-z][A-Za-z0-9_.:-]{0,59}$/;

const escAttr = (v) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const decode = (v) => v.replace(/&(amp|lt|gt|quot|apos|#\d{1,6}|#x[0-9a-fA-F]{1,6});/g, (_, e) => {
  if (e === "amp") return "&"; if (e === "lt") return "<"; if (e === "gt") return ">"; if (e === "quot") return '"'; if (e === "apos") return "'";
  const n = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return n > 31 && n < 127 && n !== 38 && n !== 60 && n !== 62 ? String.fromCharCode(n) : "\u0000"; // anything exotic becomes NUL and is rejected below
});

function attrValue(name, raw) {
  const v = decode(raw).trim();
  if (v.includes("\u0000") || v.length > 4000) return null;
  if (name === "d") return PATH.test(v) ? v : null;
  if (name === "points") return /^[-+0-9eE.\s,]*$/.test(v) ? v : null;
  if (name === "href" || name === "xlink:href") return ID_REF.test(v) ? v : null;
  if (name === "id") return IDENT.test(v) ? v : null;
  if (name === "xmlns" || name === "xmlns:xlink") return NS.has(v) ? v : null;
  if (name === "fill" || name === "stroke" || name === "stop-color") return COLOR.test(v) ? v : null;
  if (name === "clip-path" || name === "mask") return v === "none" || /^url\(#[A-Za-z0-9_.:-]{1,60}\)$/.test(v) ? v : null;
  if (/url\s*\(|javascript|data:|&|\\/i.test(v)) return null;
  return NUMS.test(v) ? v : null;
}

/** @returns {{ ok: true, svg: string } | { ok: false, error: string }} */
export function sanitizeSvg(input) {
  if (typeof input !== "string") return { ok: false, error: "Not text" };
  if (input.length > SVG_LIMITS.bytes) return { ok: false, error: "SVG too big" };
  let src = input.replace(/^\uFEFF/, "");
  src = src.replace(/^\s*<\?xml[^>]*\?>/i, "").replace(/<!--[\s\S]*?-->/g, "");
  if (/<!|<\?|\]\]>/.test(src)) return { ok: false, error: "Unsupported markup" };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(src)) return { ok: false, error: "Invalid characters" };

  const out = [];
  const stack = [];
  let count = 0, seenRoot = false, i = 0;
  const tag = /<(\/?)([A-Za-z][A-Za-z0-9:-]*)((?:\s+[A-Za-z_:][A-Za-z0-9_:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const text = src.slice(i, lt < 0 ? src.length : lt);
    if (text.trim()) {
      const top = stack[stack.length - 1];
      if (top !== "title" && top !== "desc") return { ok: false, error: "Text not allowed" };
      if (/[&<>]/.test(text)) return { ok: false, error: "Unsupported text" };
      out.push(text.trim());
    }
    if (lt < 0) break;
    tag.lastIndex = lt;
    const m = tag.exec(src);
    if (!m) return { ok: false, error: "Unsupported markup" };
    i = tag.lastIndex;
    const [, closing, rawName, rawAttrs, selfClose] = m;
    const lower = rawName.toLowerCase();
    if (!ELEMENTS.has(lower)) return { ok: false, error: `<${rawName}> not allowed` };
    const name = CANON[lower] ?? lower;

    if (closing) {
      if (rawAttrs.trim() || selfClose || stack.pop() !== name) return { ok: false, error: "Broken nesting" };
      out.push(`</${name}>`);
      continue;
    }
    if (++count > SVG_LIMITS.elements) return { ok: false, error: "Too many elements" };
    if (!seenRoot) { if (name !== "svg") return { ok: false, error: "Not an SVG" }; seenRoot = true; }
    else if (!stack.length) return { ok: false, error: "More than one root" };
    if (name === "svg" && stack.length) return { ok: false, error: "Nested svg" };

    const attrs = [], used = new Set();
    for (const a of rawAttrs.matchAll(/([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const key = a[1].toLowerCase();
      if (used.has(key)) return { ok: false, error: "Duplicate attribute" };
      used.add(key);
      if (key.startsWith("on") || key === "style" || key === "class" || key === "src") return { ok: false, error: "Attribute not allowed" };
      if (!ATTRS.has(key)) return { ok: false, error: `Attribute "${a[1]}" not allowed` };
      const v = attrValue(key, a[2] ?? a[3] ?? "");
      if (v === null) return { ok: false, error: `Bad value for "${a[1]}"` };
      attrs.push(` ${key === "xlink:href" ? "xlink:href" : ATTR_CANON[key] ?? key}="${escAttr(v)}"`);
    }
    if (name === "use" && !used.has("href") && !used.has("xlink:href")) return { ok: false, error: "<use> needs a #link" };
    if (name === "svg" && !used.has("xmlns")) attrs.unshift(' xmlns="http://www.w3.org/2000/svg"');
    out.push(`<${name}${attrs.join("")}${selfClose ? "/" : ""}>`);
    if (!selfClose) { stack.push(name); if (stack.length > SVG_LIMITS.depth) return { ok: false, error: "Too deep" }; }
  }
  if (!seenRoot) return { ok: false, error: "Not an SVG" };
  if (stack.length) return { ok: false, error: "Broken nesting" };
  return { ok: true, svg: out.join("") };
}
