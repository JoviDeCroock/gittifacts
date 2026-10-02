/**
 * The coordinator's `access` port on the platform: the same chokepoint as routes and services
 * (./access.ts), so the facade refuses a non-member even when a route or tool forgot to ask.
 */
import type { RepoAccess } from "@app/coordinator";
import type { Bindings } from "../app-env.js";
import { ApiError } from "../errors.js";
import { D1Store } from "../store/d1-store.js";
import { type AccessDeps, assertRepoAccess } from "./access.js";

export function repoAccessPort(
  env: Pick<Bindings, "DB" | "BLOBS" | "PLATFORM_ADMINS" | "PLATFORM_AUDITORS">,
): RepoAccess {
  // One deps object per facade (= per request), so its checks share the access memo.
  const deps: AccessDeps = { store: new D1Store(env.DB, env.BLOBS), env };
  return {
    async check(actor, repoId, need) {
      try {
        await assertRepoAccess(deps, actor, repoId, need);
        return "allowed";
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return "hidden";
        if (e instanceof ApiError && e.status === 403) return "denied";
        throw e;
      }
    },
  };
}
