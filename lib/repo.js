// Read-only GitHub access for the admin editors. Server side only: the token never reaches the browser.
// Env (see api/admin/[[...path]].js): GITHUB_TOKEN (fine-grained, this repo only, Contents: read), GITHUB_REPO ("owner/name"), GITHUB_BRANCH (default "main").
const API = "https://api.github.com";
const SHA = /^[0-9a-f]{40}$/;
const WRITABLE = /^public\/(image|skill)\//;
// A site path the editors may add, replace or remove: only /image/** and /skill/**, plain names, known picture types, no "..", no dot-files.
export const PUBLIC_PATH = /^\/(image|skill)\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(png|webp|jpe?g|gif|avif|svg)$/;
// Why a push stopped. `code` is what the route answers with; the message never reaches the browser.
const stop = (code, status = 0) => Object.assign(new Error(code), { code, status });

export const isSha = (v) => typeof v === "string" && SHA.test(v);

export function makeRepo({ token, repo, branch }, fetchImpl = fetch) {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "portfolio-admin", "X-GitHub-Api-Version": "2022-11-28" };
  async function get(path) {
    const res = await fetchImpl(`${API}/repos/${repo}/${path}`, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`github ${res.status}`);
    return res.json();
  }
  // Writes. 401/403/404 mean the token cannot write here; 409/422 on the ref means the branch moved.
  async function send(method, path, body) {
    const res = await fetchImpl(`${API}/repos/${repo}/${path}`, {
      method, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw stop([401, 403, 404].includes(res.status) ? "readonly" : "github", res.status);
    return res.json();
  }
  const trees = new Map(); // commit sha -> files; a commit never changes, so this cache is always correct
  // Same reasoning for the commit object and for content.json at a commit: they never change, so a repeat (or a request that arrives
  // while the first is still running) costs no GitHub call. A failed load is forgotten, so the next try asks again.
  const commits = new Map(), contents = new Map();
  const remember = (map, key, load) => {
    if (map.has(key)) return map.get(key);
    const pending = load().catch((e) => { map.delete(key); throw e; });
    if (map.size >= 8) map.delete(map.keys().next().value);
    map.set(key, pending);
    return pending;
  };
  const commitOf = (sha) => remember(commits, sha, () => get(`git/commits/${sha}`));
  return {
    name: repo,
    /** sha of the branch's latest commit */
    async head() {
      const ref = await get(`git/ref/heads/${encodeURIComponent(branch)}`);
      if (!isSha(ref?.object?.sha)) throw new Error("head");
      return ref.object.sha;
    },
    /** [{ path: "/image/og.png", size }] for every file the editors may touch, at one commit */
    async files(commit) {
      if (!isSha(commit)) throw new Error("sha");
      if (trees.has(commit)) return trees.get(commit);
      const c = await commitOf(commit);
      const t = await get(`git/trees/${c?.tree?.sha}?recursive=1`);
      if (!Array.isArray(t?.tree) || t.truncated) throw new Error("tree");
      const files = t.tree.filter((e) => e.type === "blob" && WRITABLE.test(e.path)).map((e) => ({ path: e.path.slice("public".length), size: e.size ?? 0 }));
      if (trees.size > 8) trees.delete(trees.keys().next().value);
      trees.set(commit, files);
      return files;
    },
    /** parsed content.json at one commit */
    async content(commit) {
      const text = await remember(contents, commit, async () => {
        const c = await commitOf(commit);
        const t = await get(`git/trees/${c?.tree?.sha}`);
        const entry = t?.tree?.find((e) => e.path === "content.json" && e.type === "blob");
        if (!entry) throw new Error("content");
        const blob = await get(`git/blobs/${entry.sha}`);
        if (blob?.encoding !== "base64") throw new Error("blob");
        return Buffer.from(blob.content, "base64").toString("utf8");
      });
      return JSON.parse(text); // parsed fresh each time: a caller may change what it gets
    },
    /**
     * One atomic commit on top of `base`: blobs -> tree -> commit -> fast-forward ref update (never forced).
     * Until the ref moves, everything created is an unreferenced object, so a failure at any step leaves the branch untouched.
     * @param {{ base: string, message: string, files: {path: string, bytes: Buffer}[], removed: string[] }} job  repo paths ("content.json", "public/image/x.webp")
     * @returns {Promise<{ sha: string }>} throws an Error whose `code` is "moved", "readonly" or "github"
     */
    async commit({ base, message, files, removed }) {
      if (!isSha(base)) throw stop("github");
      try {
        if ((await this.head()) !== base) throw stop("moved");
        const parent = await commitOf(base);
        if (!isSha(parent?.tree?.sha)) throw stop("github");
        const entries = [];
        for (let i = 0; i < files.length; i += 6) { // a few blobs at a time, not 25 at once
          const part = await Promise.all(files.slice(i, i + 6).map(async (f) => {
            const blob = await send("POST", "git/blobs", { content: f.bytes.toString("base64"), encoding: "base64" });
            if (!isSha(blob?.sha)) throw stop("github");
            return { path: f.path, mode: "100644", type: "blob", sha: blob.sha };
          }));
          entries.push(...part);
        }
        for (const path of removed) entries.push({ path, mode: "100644", type: "blob", sha: null });
        const tree = await send("POST", "git/trees", { base_tree: parent.tree.sha, tree: entries });
        if (!isSha(tree?.sha)) throw stop("github");
        const made = await send("POST", "git/commits", { message, tree: tree.sha, parents: [base] });
        if (!isSha(made?.sha)) throw stop("github");
        try {
          await send("PATCH", `git/refs/heads/${encodeURIComponent(branch).replace(/%2F/g, "/")}`, { sha: made.sha, force: false });
        } catch (e) {
          throw e.status === 422 || e.status === 409 ? stop("moved") : e; // not a fast-forward: someone pushed in between
        }
        return { sha: made.sha };
      } catch (e) {
        throw e?.code ? e : stop("github");
      }
    },
    /** Deploy state of a commit, best effort: "success" | "failure" | "pending" | "unknown" (needs Commit statuses: read; without it "unknown"). */
    async status(commit) {
      if (!isSha(commit)) throw stop("sha");
      try {
        const s = await get(`commits/${commit}/status`);
        if (s?.total_count === 0) return "pending";
        return s?.state === "success" ? "success" : s?.state === "failure" || s?.state === "error" ? "failure" : s?.state === "pending" ? "pending" : "unknown";
      } catch { return "unknown"; }
    },
  };
}
