/**
 * `whoami` for a caller without credentials (O3): nobody yet, no repos, and what an unclaimed
 * project would get. The name says what to do next, because an agent reads it first.
 */
import type { WhoamiData } from "@app/mcp";
import type { Services } from "../app-env.js";
import { unclaimedLimits } from "../limits/config.js";
import { unclaimedCreationState } from "../limits/kill-switch.js";

export async function anonymousWhoami(svc: Services): Promise<WhoamiData> {
  const l = unclaimedLimits(svc.env);
  const state = await unclaimedCreationState(svc.store, svc.env.FLAGS, svc.env);
  return {
    principal: {
      id: "anonymous",
      kind: "agent",
      name: state.enabled
        ? "anonymous (no credentials): create_project returns an unclaimed project + its own Bearer token"
        : "anonymous (no credentials): creating projects without an account is off; use MCP OAuth",
      ownerId: null,
      keys: [],
      scopes: [],
      repoIds: [],
    },
    ownerName: null,
    canApprove: false,
    repos: [],
    quotas: {
      enforced: true,
      ciMinutesPerDay: l.ci.minutesPerDay,
      ciMinutesUsedToday: 0,
      artifactsOpsPerDay: l.artifactsOpsPerDay,
    },
  };
}
