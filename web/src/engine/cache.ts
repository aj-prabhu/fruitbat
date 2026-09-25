// Cache detection for the Loading UX (docs/PLAN.md S1-09, rule 11: "cache detection"). A model's
// first pinned file is looked up in the Cache API directly: `caches.match` searches every cache
// this origin owns (Transformers.js's own cache included), so this needs no knowledge of the
// internal cache name and makes no network request of its own -- it is safe to call before the
// user has asked for anything.
import type { PinnedModel } from "./pins";
import { pinnedFileUrl } from "./pins";

/** Is `url` already sitting in this origin's Cache API? Never throws (no Cache API: false). */
export async function isCached(url: string): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  try {
    const res = await caches.match(url);
    return !!res;
  } catch {
    return false;
  }
}

/** Was `model`'s first pinned file already downloaded in an earlier session? */
export function isModelCached(model: Pick<PinnedModel, "id" | "revision" | "url_template" | "files">): Promise<boolean> {
  const first = model.files[0];
  if (!first) return Promise.resolve(false);
  return isCached(pinnedFileUrl(model as PinnedModel, first.path));
}
