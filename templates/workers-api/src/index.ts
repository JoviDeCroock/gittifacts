import { handle } from "./app.js";
import type { FlagsBinding } from "./flags.js";

/**
 * Bindings. The platform adds `FLAGS` and `VERSION` to every version it deploys (see
 * src/flags.ts); they are absent in tests, previews and `wrangler dev`. Bundles may declare
 * plain vars only: deployed Workers can't bind KV, D1, R2 or other resources yet.
 */
export interface Env {
  /** Change kill-switch flags: `isChangeEnabled(env, changeId)`. */
  FLAGS?: FlagsBinding;
  /** The deployed version: `{ id, tag, timestamp }` (`tag` is the Change id). */
  VERSION?: { id: string; tag: string; timestamp: string };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
};
