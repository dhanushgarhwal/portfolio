// Shared "not found" answer for /api/*: the designed page for browser navigation, JSON for everything else.
import { readFileSync } from "node:fs";

const NO_STORE = { "Cache-Control": "no-store" };

let page = null; // public/404.html, read once per function instance
const loadPage = () => {
  try {
    page ??= readFileSync(new URL("../public/404.html", import.meta.url), "utf8");
  } catch {
    page = "<!DOCTYPE html><title>404</title><h1>404</h1>";
  }
  return page;
};

// True when the browser is opening the address itself (typed, clicked or reloaded), not a fetch() from the page.
export function isNavigation(request) {
  const mode = request.headers.get("sec-fetch-mode");
  const dest = request.headers.get("sec-fetch-dest");
  if (mode || dest) return mode === "navigate" || dest === "document";
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html") && !accept.includes("json");
}

export function notFound(request) {
  if (isNavigation(request)) {
    return new Response(loadPage(), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE } });
  }
  return Response.json({ error: "not found" }, { status: 404, headers: NO_STORE });
}
