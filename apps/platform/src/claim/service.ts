/**
 * The claim flow (onboarding §4): a human opens the claimUrl (`/claim/<token>`), signs in,
 * passes Turnstile, and the unclaimed project becomes theirs:
 *
 * - the project (repo) is claimed: owner = the human, no expiry; the unclaimed limits stop
 *   applying at once (every limit keys off `repo.claim.status` at call time);
 * - the agent that created it is now owned by the human, with the same scopes and repo (it still
 *   can never approve anything);
 * - its previews lose the "Unclaimed project — not verified" banner;
 * - `project.claimed` is audit-logged.
 *
 * Single-use and idempotent: the claim token works once; the same human retrying gets the same
 * answer (`alreadyClaimed: true`), anyone else gets 409. Claims race expiry through one
 * conditional update on `project_claims.status`, so a project is either claimed or deleted.
 */
import { claimingLines, unclaimedLimitLines } from "@app/conventions";
import { bootstrapChangeIdFor } from "@app/coordinator";
import { defaultPolicy, type Principal } from "@app/domain";
import { and, eq, gt } from "drizzle-orm";
import type { Services } from "../app-env.js";
import { previews, principals, projectClaims } from "../db/schema.js";
import { ApiError, conflict, forbidden, notFound } from "../errors.js";
import { quotaHints, unclaimedLimits } from "../limits/config.js";
import { previewUrlFor, previewZone } from "../previews/ids.js";
import { limitsFor, type WorkspaceConfigVars } from "../workspace/model.js";
import { type ClaimRow, claimRowByToken } from "./store.js";
import { isClaimTokenShape } from "./tokens.js";
import { NOT_CONFIGURED, turnstileSiteKey, verifyTurnstile } from "./turnstile.js";

export interface ClaimView {
  status: "unclaimed" | "claimed" | "expired";
  project: {
    id: string;
    name: string;
    template: string | null;
    createdAt: string;
    expiresAt: string | null;
    previewUrl: string | null;
  };
  createdBy: { kind: "agent"; principalId: string; name: string };
  claimedBy: { principalId: string; name: string } | null;
  claimedAt: string | null;
  claiming: string[];
  limits: string[];
  turnstile: { siteKey: string };
  viewer: { signedIn: boolean; principalId: string | null; isClaimer: boolean };
}

export interface ClaimResult {
  status: "claimed";
  project: { id: string; name: string };
  ownerId: string;
  claimedAt: string;
  alreadyClaimed: boolean;
  next: { repoPath: string };
}

const unknownClaim = () =>
  notFound("claim link", {
    explanation:
      "This claim link is not valid. Ask the agent that created the project for its claimUrl again (it is in the create_project response).",
  });

async function rowFor(svc: Services, token: string): Promise<ClaimRow> {
  if (!isClaimTokenShape(token)) throw unknownClaim();
  const row = await claimRowByToken(svc.store, token);
  if (row === null) throw unknownClaim();
  return row;
}

function statusOf(row: ClaimRow, nowMs: number): ClaimView["status"] {
  if (row.status === "claimed") return "claimed";
  if (row.status !== "unclaimed" || Date.parse(row.expiresAt) <= nowMs) return "expired";
  return "unclaimed";
}

export function unclaimedLimitTexts(env: Services["env"]): string[] {
  const l = unclaimedLimits(env);
  const ws = limitsFor(
    { claim: { status: "unclaimed", ownerId: null, expiresAt: null }, policy: defaultPolicy() },
    env as unknown as WorkspaceConfigVars,
  );
  return unclaimedLimitLines(quotaHints(l, Math.round((ws.cpuSecondsPerDay ?? 0) / 60)));
}

export async function getClaimView(
  svc: Services,
  token: string,
  viewer: Principal | null,
): Promise<ClaimView> {
  const row = await rowFor(svc, token);
  const status = statusOf(row, svc.clock.now().getTime());
  const repo = status === "expired" ? null : await svc.store.getRepo(row.repoId);
  const names = await svc.store.principalRefs(
    [row.agentPrincipalId, row.claimedBy].filter((x): x is string => x !== null),
  );
  const bootstrap = repo === null ? null : await svc.store.getChange(bootstrapChangeIdFor(repo.id));
  return {
    status,
    project: {
      id: row.repoId,
      name: row.projectName,
      template: repo?.template ?? null,
      createdAt: row.createdAt,
      expiresAt: status === "claimed" ? null : row.expiresAt,
      previewUrl: bootstrap === null ? null : previewUrlFor(previewZone(svc.env), bootstrap.id),
    },
    createdBy: {
      kind: "agent",
      principalId: row.agentPrincipalId,
      name: names[row.agentPrincipalId]?.name ?? "an agent",
    },
    claimedBy:
      row.claimedBy === null
        ? null
        : { principalId: row.claimedBy, name: names[row.claimedBy]?.name ?? row.claimedBy },
    claimedAt: row.claimedAt,
    claiming: claimingLines(),
    limits: unclaimedLimitTexts(svc.env),
    turnstile: { siteKey: turnstileSiteKey(svc.env) },
    viewer: {
      signedIn: viewer !== null,
      principalId: viewer?.id ?? null,
      isClaimer: viewer !== null && row.claimedBy === viewer.id,
    },
  };
}

/** Hand the project, its agent and its previews to `owner` (idempotent). */
async function transfer(svc: Services, row: ClaimRow, owner: Principal): Promise<void> {
  const repo = await svc.store.getRepo(row.repoId);
  if (repo !== null && (repo.claim.status !== "claimed" || repo.claim.ownerId !== owner.id)) {
    await svc.store.updateRepo(repo.id, {
      claim: { status: "claimed", ownerId: owner.id, expiresAt: null },
    });
  }
  await svc.store.db
    .update(principals)
    .set({ ownerId: owner.id })
    .where(and(eq(principals.id, row.agentPrincipalId), eq(principals.kind, "agent")));
  await svc.store.db.update(previews).set({ claimed: true }).where(eq(previews.repoId, row.repoId));
}

function result(
  row: ClaimRow,
  ownerId: string,
  claimedAt: string,
  alreadyClaimed: boolean,
): ClaimResult {
  return {
    status: "claimed",
    project: { id: row.repoId, name: row.projectName },
    ownerId,
    claimedAt,
    alreadyClaimed,
    next: { repoPath: `/repos/${row.repoId}` },
  };
}

function expired(row: ClaimRow): ApiError {
  return new ApiError(
    410,
    "invalid-state",
    `project ${row.projectName} expired unclaimed`,
    { expiresAt: row.expiresAt },
    {
      explanation:
        "Unclaimed projects are deleted when their time runs out. Ask the agent to create a new project and send you its new claimUrl.",
    },
  );
}

export async function claimProject(
  svc: Services,
  claimer: Principal,
  token: string,
  input: { turnstileToken: string; remoteIp: string | null; idempotencyKey?: string },
): Promise<ClaimResult> {
  if (claimer.kind !== "human") {
    throw forbidden(
      "only a signed-in human can claim a project",
      { kind: claimer.kind },
      {
        explanation:
          "Agents never take ownership. Give the claimUrl to a human: they open it, sign in and claim.",
      },
    );
  }
  const row = await rowFor(svc, token);
  const now = svc.clock.now();
  const already = async (r: ClaimRow): Promise<ClaimResult> => {
    if (r.claimedBy !== claimer.id) {
      throw conflict("this project was already claimed by someone else", "conflict", {
        explanation:
          "A project has one owner. Ask its owner to add you, or ask the agent for a new project.",
      });
    }
    await transfer(svc, r, claimer);
    return result(r, claimer.id, r.claimedAt ?? now.toISOString(), true);
  };
  if (row.status === "claimed") return already(row);
  if (statusOf(row, now.getTime()) === "expired") throw expired(row);

  const check = await verifyTurnstile(svc.env, {
    token: input.turnstileToken,
    remoteIp: input.remoteIp,
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  });
  if (!check.success) {
    const notConfigured = check.errorCodes.includes(NOT_CONFIGURED);
    await svc.audit.append({
      principalId: claimer.id,
      action: "project.claim-refused",
      subject: `repo:${row.repoId}`,
      payload: { reason: "turnstile", errorCodes: check.errorCodes },
    });
    if (notConfigured) {
      throw new ApiError(
        503,
        NOT_CONFIGURED,
        "turnstile is not configured on this platform, so no project can be claimed",
        { errorCodes: check.errorCodes },
        {
          explanation:
            "The operator must set the TURNSTILE_SECRET_KEY secret (and TURNSTILE_SITE_KEY var). Local dev and tests set TURNSTILE_TEST_KEYS=1 to use Cloudflare's test keys. Retrying will not help until then.",
        },
      );
    }
    throw new ApiError(
      403,
      "turnstile-failed",
      "the human check (Turnstile) did not pass",
      { errorCodes: check.errorCodes },
      {
        explanation:
          "The check failed or expired. Reload the claim page, complete the check again and press Claim.",
      },
    );
  }

  const claimedAt = now.toISOString();
  const won = await svc.store.db
    .update(projectClaims)
    .set({ status: "claimed", claimedAt, claimedBy: claimer.id })
    .where(
      and(
        eq(projectClaims.repoId, row.repoId),
        eq(projectClaims.status, "unclaimed"),
        gt(projectClaims.expiresAt, claimedAt),
      ),
    )
    .returning({ repoId: projectClaims.repoId });
  if (won.length === 0) {
    const fresh = await claimRowByToken(svc.store, token);
    if (fresh?.status === "claimed") return already(fresh);
    throw expired(row);
  }
  await transfer(svc, row, claimer);
  await svc.audit.append({
    principalId: claimer.id,
    action: "project.claimed",
    subject: `repo:${row.repoId}`,
    payload: { agentPrincipalId: row.agentPrincipalId, turnstileTestKeys: check.testKeys },
  });
  return result(row, claimer.id, claimedAt, false);
}
