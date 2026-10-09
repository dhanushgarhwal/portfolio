// /api/admin/*: owner-only admin API. Rules live in lib/admin.js, storage in lib/firestore.js.
// Env: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, ADMIN_GITHUB_ID (digits), SESSION_SECRET (32+ random characters), FIREBASE_SERVICE_ACCOUNT.
// Anything missing or malformed means every route answers 501 and nothing is readable.
import * as firestore from "../../lib/firestore.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleAdmin, makeGithub } from "../../lib/admin.js";
import { makeRepo } from "../../lib/repo.js";
import { iconsIn } from "../../scripts/render.mjs";

// Icon names come from the template that ships with this deploy (vercel.json includeFiles).
let iconCache;
let templateCache;
const template = () => (templateCache ??= readFileSync(join(process.cwd(), "templates/index.template.html"), "utf8"));
const icons = () => (iconCache ??= iconsIn(template()));

// Repo reading: GITHUB_TOKEN + GITHUB_REPO ("owner/name"), optional GITHUB_BRANCH. Missing or malformed -> the editors answer 501 "norepo".
function repo() {
  const token = env("GITHUB_TOKEN"), name = env("GITHUB_REPO"), branch = env("GITHUB_BRANCH") ?? "main";
  if (!token || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(name ?? "") || !/^[A-Za-z0-9_./-]{1,100}$/.test(branch)) return null;
  return makeRepo({ token, repo: name, branch });
}

const env = (name) => process.env[name]?.trim() || null;

function deps() {
  const clientId = env("GITHUB_CLIENT_ID"), clientSecret = env("GITHUB_CLIENT_SECRET");
  const adminId = env("ADMIN_GITHUB_ID"), secret = env("SESSION_SECRET");
  const ready = clientId && clientSecret && /^\d{1,20}$/.test(adminId ?? "") && secret && secret.length >= 32 && firestore.isConfigured();
  return {
    env: ready ? { clientId, clientSecret, adminId, secret } : null,
    github: ready ? makeGithub({ clientId, clientSecret }) : null,
    store: {
      hit: firestore.hit, list: firestore.listFeedback, stats: firestore.feedbackStats,
      setRead: firestore.setFeedbackRead, pinned: firestore.listPinned, setPinned: firestore.setFeedbackPinned, remove: firestore.deleteFeedback,
      revokedBefore: firestore.revokedBefore, revokeSessions: firestore.revokeSessions, resetLimits: firestore.resetLimits,
      getTrusted: firestore.getTrusted, setTrusted: firestore.setTrusted,
    },
    repo: ready ? repo() : null,
    icons,
    template,
    now: Date.now,
  };
}

export default { fetch: (request) => handleAdmin(request, deps()) };
