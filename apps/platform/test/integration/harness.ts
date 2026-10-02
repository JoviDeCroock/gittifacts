/** Shared by the workspace/import integration tests: the app over the real coordinator facade. */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { cloudflareBindings, createCoordinator } from "@app/coordinator";
import { createApp } from "../../src/app.js";
import { facadeOptions } from "../../src/coordinator.js";
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

/** The app with the real coordinator facade over the same Ports the DOs and Workflows get. */
export function platformApp(): TestApp {
  return createApp({
    coordinator: (e, _ctx, origin) =>
      createCoordinator(
        buildPorts(e, "default", { overrides: integrationOverrides("default", e) }),
        cloudflareBindings(e),
        facadeOptions(origin),
      ),
  });
}
