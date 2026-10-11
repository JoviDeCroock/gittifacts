/**
 * The app over the real coordinator facade with the integration fakes' Ports (no `cloudflare:test`
 * import, so the E2E entry served by `wrangler dev` can use it too; harness.ts re-exports it).
 */
import { cloudflareBindings, createCoordinator } from "@app/coordinator";
import { repoAccessPort } from "../../src/access/port.js";
import { createApp } from "../../src/app.js";
import { facadeOptions } from "../../src/coordinator.js";
import { githubReviewOptions } from "../../src/github/review-hooks.js";
import { guardImportGrants } from "../../src/import/push-grant-runtime.js";
import { buildPorts } from "../../src/runtime/ports.js";
import { integrationOverrides } from "./fakes.js";

/**
 * The app with the real coordinator facade over the same Ports the DOs and Workflows get, and,
 * like production (src/coordinator.ts), the repo-access port on the facade, GitHub mode's review
 * hooks (the PR's author can't review it here) and the import-grant guard (a live import-by-push
 * grant closes before any Change starts).
 */
export function platformApp(): ReturnType<typeof createApp> {
  return createApp({
    coordinator: (e, ctx, origin) =>
      guardImportGrants(
        createCoordinator(
          buildPorts(e, "default", {
            overrides: { ...integrationOverrides("default", e), access: repoAccessPort(e) },
          }),
          cloudflareBindings(e),
          { ...facadeOptions(origin), ...githubReviewOptions(e) },
        ),
        e,
        ctx,
        origin,
      ),
  });
}
