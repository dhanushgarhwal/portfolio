// View counter rules. The store is passed in ({ addView, readViews }), so this file never touches the network.
// Each visitor counts once (cookie v=1, one year); bots never count.
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|curl|wget|python|node-fetch|axios/i;
const SEEN = /(?:^|;\s*)v=1(?:;|$)/;
const COOKIE = "v=1; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax";

const reply = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

export async function handleViews(request, store) {
  const { method, headers } = request;
  if (method !== "GET" && method !== "POST") return reply({ error: "method not allowed" }, 405, { Allow: "GET, POST" });
  if (!store) return reply({ error: "database not configured" }, 501);

  try {
    const counts = method === "POST" && !SEEN.test(headers.get("cookie") ?? "") && !BOT.test(headers.get("user-agent") ?? "");
    if (!counts) return reply({ views: await store.readViews() });
    return reply({ views: await store.addView() }, 200, { "Set-Cookie": COOKIE });
  } catch {
    return reply({ error: "db error" }, 500);
  }
}
