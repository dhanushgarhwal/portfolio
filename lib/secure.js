// Small crypto helpers shared by the feedback form and the admin API.
import { createHmac, timingSafeEqual } from "node:crypto";

/** HMAC-SHA256 of `text` under `key`, as a Buffer. */
export const hmac = (key, text) => createHmac("sha256", key).update(text).digest();

/** Constant-time comparison of two strings or Buffers; differing lengths (in bytes) are simply "not equal", never an exception. */
export function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
