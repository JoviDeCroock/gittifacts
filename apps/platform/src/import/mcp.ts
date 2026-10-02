/**
 * The import-detection tool's slice of the platform `McpBackend`
 * (packages/mcp/src/tools/import.ts): repo-scoped, idempotent per (principal, key), rules in
 * ./service.ts.
 */
import type { ImportToolsBackend } from "@app/mcp";
import type { Services } from "../app-env.js";
import type { McpBackendHelpers } from "../workspace/mcp.js";
import { proposePlatformConfig } from "./service.js";

export function createImportMcpBackend(svc: Services, h: McpBackendHelpers): ImportToolsBackend {
  return {
    async proposePlatformConfig(mc, input, opts) {
      const caller = await h.scoped(mc, { repoId: input.repoId });
      return h.idem(caller, "propose_platform_config", opts.idempotencyKey, input, () =>
        proposePlatformConfig(svc, caller, input),
      );
    },
  };
}
