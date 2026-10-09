// /api/feedback: anonymous feedback form. Rules live in lib/feedback.js, storage in lib/firestore.js.
// Env: FIREBASE_SERVICE_ACCOUNT (already used by the view counter), RATE_SALT (16+ random characters).
// Anything missing means the route answers 501 and stores nothing.
import * as firestore from "../lib/firestore.js";
import { handleFeedback } from "../lib/feedback.js";
import { isNavigation, notFound } from "../lib/not-found.js";

const env = (name) => process.env[name]?.trim() || null;

function deps() {
  const salt = env("RATE_SALT");
  return {
    secret: salt && salt.length >= 16 ? salt : null,
    store: firestore.isConfigured() ? { getLock: firestore.getLock, setLock: firestore.setLock, add: firestore.addFeedback, getReset: firestore.getLimitReset } : null,
    now: Date.now,
  };
}

export default {
  fetch: (request) => (isNavigation(request) ? notFound(request) : handleFeedback(request, deps())),
};
