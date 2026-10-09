// /api/views: the visit counter. Rules live in lib/views.js, storage in lib/firestore.js.
import * as firestore from "../lib/firestore.js";
import { isNavigation, notFound } from "../lib/not-found.js";
import { handleViews } from "../lib/views.js";

export default {
  fetch: (request) => (isNavigation(request) ? notFound(request) : handleViews(request, firestore.isConfigured() ? firestore : null)),
};
