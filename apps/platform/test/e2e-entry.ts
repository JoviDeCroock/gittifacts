/**
 * Entry for the pre-deploy browser E2E (apps/e2e, `wrangler dev --local`): the workerd test entry
 * (the production Worker with fakes for Artifacts, containers and the reviewer model) plus
 * `POST /__e2e/seed` (./e2e-seed.ts). Production builds src/index.ts and never sees this file.
 */
import { handleE2eSeed } from "./e2e-seed.js";
import { platformApp } from "./integration/platform-app.js";
import worker from "./worker-entry.js";

export * from "./worker-entry.js";

// Like the integration tests: the API's coordinator facade runs on the same fake Ports the
// Durable Objects and Workflows get (production's facade would reach for Artifacts).
const app = platformApp();

export default {
  ...worker,
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith("/__e2e/")) return handleE2eSeed(request);
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Parameters<typeof worker.fetch>[1]>;
