/** Shared by the workspace/import integration tests: the app over the real coordinator facade. */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { cloudflareBindings, createCoordinator } from "@app/coordinator";
import { repoAccessPort } from "../../src/access/port.js";
import { createApp } from "../../src/app.js";
import { facadeOptions } from "../../src/coordinator.js";
import { guardImportGrants } from "../../src/import/push-grant-runtime.js";
import { buildPorts } from "../../src/runtime/ports.js";
import type { TestApp } from "../http.js";
import { integrationOverrides } from "./fakes.js";

export function fetchVia(app: TestApp) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(input, init), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
}

/**
 * The app with the real coordinator facade over the same Ports the DOs and Workflows get, and,
 * like production (src/coordinator.ts), the repo-access port on the facade and the import-grant
 * guard (a live import-by-push grant closes before any Change starts).
 */
export function platformApp(): TestApp {
  return createApp({
    coordinator: (e, ctx, origin) =>
      guardImportGrants(
        createCoordinator(
          buildPorts(e, "default", {
            overrides: { ...integrationOverrides("default", e), access: repoAccessPort(e) },
          }),
          cloudflareBindings(e),
          facadeOptions(origin),
        ),
        e,
        ctx,
        origin,
      ),
  });
}
