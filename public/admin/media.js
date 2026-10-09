// Turns a chosen file into something safe to keep in the draft: real type by magic bytes, re-encoded (no metadata), size-capped.
// Raster pictures become WebP (PNG when the site needs PNG: favicon and share image); SVGs go through the strict sanitizer.
import { LIMITS, sniff } from "./logic.js";
import { sanitizeSvg } from "./svg.js";

export class MediaError extends Error {}
const fail = (m) => { throw new MediaError(m); };

const toDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(new MediaError("Cannot read file"));
  r.readAsDataURL(blob);
});
const encode = (canvas, type, q) => new Promise((resolve) => canvas.toBlob(resolve, type, q));

/**
 * @param {File} file
 * @param {{ format?: "webp" | "png" }} opts
 * @returns {Promise<{ data: string, size: number, width: number, height: number, ext: string }>}  data is a data: URL
 */
export async function processImage(file, { format = "webp" } = {}) {
  if (!(file instanceof Blob) || file.size === 0) fail("Empty file");
  if (file.size > LIMITS.source) fail("File over 10 MB");
  const kind = sniff(new Uint8Array(await file.slice(0, 512).arrayBuffer()));
  if (!kind) fail("Not an image");
  if (kind === "svg") fail("Use an SVG here? Add it in Stack");
  if (kind === "avif" && typeof createImageBitmap !== "function") fail("Unsupported image");

  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { fail("Cannot open image"); }
  const type = format === "png" ? "image/png" : "image/webp";
  let scale = Math.min(1, LIMITS.dim / Math.max(bitmap.width, bitmap.height));
  try {
    for (let round = 0; round < 8; round++) {
      const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height); // drawing to a canvas drops EXIF, ICC, GPS and any embedded data
      for (const q of format === "png" ? [undefined] : [0.86, 0.78, 0.68, 0.58]) {
        const blob = await encode(canvas, type, q);
        if (!blob || blob.type !== type) fail(format === "png" ? "PNG not supported" : "WebP not supported");
        if (blob.size <= LIMITS.bytes) return { data: await toDataUrl(blob), size: blob.size, width, height, ext: format };
      }
      scale *= 0.8;
    }
  } finally { bitmap.close?.(); }
  return fail("Image too large");
}

/** @returns {Promise<{ data: string, size: number, ext: "svg" }>} */
export async function processSvg(file) {
  if (!(file instanceof Blob) || file.size === 0) fail("Empty file");
  if (file.size > LIMITS.svg * 2) fail("SVG too big");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (sniff(bytes) !== "svg") fail("Not an SVG");
  const result = sanitizeSvg(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!result.ok) fail(result.error);
  const blob = new Blob([result.svg], { type: "image/svg+xml" });
  return { data: await toDataUrl(blob), size: blob.size, ext: "svg" };
}

/** natural size of a picture, from the live site (existing files) or a data: URL (new ones) */
export const measure = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
  img.onerror = () => reject(new MediaError("Cannot open image"));
  img.src = src;
});
