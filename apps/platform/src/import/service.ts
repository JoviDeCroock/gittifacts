/**
 * Import detection: proposing `.platform/*` + AGENTS.md for an imported repo as a Plan + Change.
 * (Being built: the proposal workflow lands in the next commits.)
 */
import type { ProposalView } from "@app/mcp";
import type { Caller, Services } from "../app-env.js";
import { ApiError } from "../errors.js";

export async function proposePlatformConfig(
  _svc: Services,
  _caller: Caller,
  input: { repoId: string; rerun: boolean; waitSec: number },
): Promise<ProposalView> {
  throw new ApiError(
    503,
    "upstream",
    `platform-config proposals are not available yet (${input.repoId})`,
  );
}
