// /api/admin/feedback/<id> (PATCH, DELETE). A route file of its own so Vercel never sends this path to the generic /api 404 catch-all.
export { default } from "../[[...path]].js";
