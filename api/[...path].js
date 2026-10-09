// Any /api/* path without its own route.
import { notFound } from "../lib/not-found.js";

export default { fetch: notFound };
