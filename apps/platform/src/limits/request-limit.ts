/**
 * Per-token request limits for unclaimed projects (onboarding §4). An unclaimed project's token
 * belongs to an ownerless agent principal; every authenticated request it makes (HTTP API and
 * MCP) is counted by the Workers Rate Limiting binding `UNCLAIMED_TOKEN_LIMITER`, keyed by the
 * principal. The binding's per-location, 60-second window is the right shape for "requests per
 * minute" (creation limits need global, longer windows: see ./creation.ts).
 *
 * Fail closed: a missing binding or a limiter error refuses the request (429), so a
 * misconfiguration can't silently lift the limit. Claimed agents and humans are never limited here.
 */
import type { Principal } from "@app/domain";
import { RateLimited } from "./creation.js";

export interface TokenLimiterEnv {
  UNCLAIMED_TOKEN_LIMITER?: RateLimit;
}

/** An unclaimed project's agent: an agent no human owns (yet). */
export function isUnclaimedAgent(p: Pick<Principal, "kind" | "ownerId">): boolean {
  return p.kind === "agent" && p.ownerId === null;
}

export async function enforceUnclaimedRequestRate(
  env: TokenLimiterEnv,
  principal: Pick<Principal, "id" | "kind" | "ownerId">,
): Promise<void> {
  if (!isUnclaimedAgent(principal)) return;
  let ok = false;
  try {
    const limiter = env.UNCLAIMED_TOKEN_LIMITER;
    if (limiter === undefined) throw new Error("UNCLAIMED_TOKEN_LIMITER is not bound");
    ok = (await limiter.limit({ key: `token:${principal.id}` })).success;
  } catch (e) {
    console.error("unclaimed token limiter unavailable; refusing", e);
  }
  if (!ok) {
    throw new RateLimited(
      "token",
      60,
      "too many requests for this unclaimed project's token (per-minute limit)",
      { principalId: principal.id },
    );
  }
}
