/**
 * Credential-less `create_project` (onboarding §4): an agent with no account gets an UNCLAIMED
 * project, a short-lived Bearer token for it and a `claimUrl` for a human.
 *
 * Order matters (each step fails closed before anything is created):
 * 1. the kill switch (src/limits/kill-switch.ts) → 503 creation-disabled;
 * 2. input validation;
 * 3. an Idempotency-Key replay finds the project it created (no new rate-limit charge);
 * 4. per-IP, per-ASN and global creation limits (src/limits/creation.ts) → 429 rate-limited;
 * 5. a fresh ownerless agent principal (agent scopes only, no repos yet);
 * 6. the project, as that agent (`createProjectAs`): once the repo exists, the agent is bound to
 *    it, the claim record and the token are made, and the first Change's fork + push token are
 *    charged to the project's Artifacts-operation quota.
 */

import { fixFor } from "@app/conventions";
import { sha256Hex } from "@app/evidence";
import type { ProjectCreated } from "@app/mcp";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import type { Services } from "../app-env.js";
import { disablePrincipal } from "../auth/principals.js";
import { projectClaims, unclaimedCreations } from "../db/schema.js";
import { ApiError, conflict } from "../errors.js";
import type { AnonymousClient } from "../limits/client.js";
import { unclaimedLimits } from "../limits/config.js";
import { takeCreation } from "../limits/creation.js";
import { unclaimedCreationState } from "../limits/kill-switch.js";
import { chargeArtifactsOps } from "../limits/quotas.js";
import { CreateProjectInput, createProjectAs, projectName } from "../services/projects.js";
import { bindAgentToRepo, createUnclaimedAgent, issueProjectToken } from "./principal.js";
import { claimRowByRepo } from "./store.js";
import { claimUrlFor, deriveClaimToken, hashClaimToken } from "./tokens.js";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
/** A creation still without a repo after this long is treated as interrupted and resumed. */
const IN_FLIGHT_MS = 60_000;
const MIN_ANON_KEY = 16;

export function creationDisabled(origin: string): ApiError {
  return new ApiError(
    503,
    "creation-disabled",
    "creating projects without an account is switched off right now",
    undefined,
    fixFor("creation-disabled", { host: origin }),
  );
}

interface Reservation {
  keyHash: string;
  principalId: string | null;
  resumed: boolean;
}

/** Find (or start) the creation an Idempotency-Key names. */
async function reserveKey(
  svc: Services,
  key: string,
  requestHash: string,
  now: Date,
): Promise<Reservation> {
  if (key.length < MIN_ANON_KEY) {
    throw new ApiError(
      400,
      "invalid-request",
      `without credentials, an Idempotency-Key must have at least ${MIN_ANON_KEY} characters`,
      { minLength: MIN_ANON_KEY },
      {
        explanation:
          "The key is what finds your project again on a retry, so it must be unguessable: use a random UUID.",
        command: "uuidgen",
      },
    );
  }
  const db = svc.store.db;
  const keyHash = await sha256Hex(`anon:${key}`);
  await db
    .delete(unclaimedCreations)
    .where(
      and(
        eq(unclaimedCreations.keyHash, keyHash),
        lt(unclaimedCreations.expiresAt, now.toISOString()),
      ),
    );
  const row = await db
    .select()
    .from(unclaimedCreations)
    .where(eq(unclaimedCreations.keyHash, keyHash))
    .get();
  if (row === undefined) return { keyHash, principalId: null, resumed: false };
  if (row.requestHash !== requestHash) {
    throw conflict(
      "this Idempotency-Key was used for a different create_project request",
      "idempotency-key-reuse",
      fixFor("idempotency-key-reuse"),
    );
  }
  if (row.repoId === null && now.getTime() - Date.parse(row.createdAt) < IN_FLIGHT_MS) {
    throw conflict(
      "the first request with this Idempotency-Key is still creating the project",
      "idempotency-key-in-flight",
      fixFor("idempotency-key-in-flight", { retryAfterSec: 2 }),
    );
  }
  return { keyHash, principalId: row.principalId, resumed: true };
}

export async function createUnclaimedProject(
  svc: Services,
  client: AnonymousClient,
  raw: unknown,
  idempotencyKey?: string,
): Promise<ProjectCreated> {
  const state = await unclaimedCreationState(svc.store, svc.env.FLAGS);
  if (!state.enabled) throw creationDisabled(svc.origin);
  const input = CreateProjectInput.parse(raw);
  const limits = unclaimedLimits(svc.env);
  const now = svc.clock.now();
  const db = svc.store.db;

  const reservation =
    idempotencyKey === undefined
      ? null
      : await reserveKey(svc, idempotencyKey, await sha256Hex(JSON.stringify(input)), now);

  let principal = reservation?.principalId
    ? await svc.store.getPrincipal(reservation.principalId)
    : null;
  if (principal === null) {
    await takeCreation(svc.env, client, limits, now.getTime());
    principal = await createUnclaimedAgent(svc.store, {
      label: await projectName(input, idempotencyKey),
      now,
    });
    if (reservation !== null) {
      const inserted = await db
        .insert(unclaimedCreations)
        .values({
          keyHash: reservation.keyHash,
          requestHash: await sha256Hex(JSON.stringify(input)),
          principalId: principal.id,
          repoId: null,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
        })
        .onConflictDoNothing()
        .returning({ keyHash: unclaimedCreations.keyHash });
      if (inserted.length === 0) {
        // A concurrent first request with the same key won the race.
        await disablePrincipal(svc.store, principal.id, now);
        throw conflict(
          "the first request with this Idempotency-Key is still creating the project",
          "idempotency-key-in-flight",
          fixFor("idempotency-key-in-flight", { retryAfterSec: 2 }),
        );
      }
    }
  }
  const agent = principal;

  let created = false;
  try {
    const out = await createProjectAs(svc, agent, input, idempotencyKey, {
      afterRepo: async (repo) => {
        created = true;
        const expiresAt =
          repo.claim.expiresAt ??
          new Date(now.getTime() + limits.ttlDays * 86_400_000).toISOString();
        await bindAgentToRepo(svc.store, agent.id, repo.id);
        let row = await claimRowByRepo(svc.store, repo.id);
        if (row === null) {
          const seed = {
            repoId: repo.id,
            agentPrincipalId: agent.id,
            createdAt: now.toISOString(),
          };
          const token = await deriveClaimToken(svc.env, seed);
          await db
            .insert(projectClaims)
            .values({
              ...seed,
              claimTokenHash: await hashClaimToken(token),
              creatorIpHash: client.ipHash,
              creatorAsn: client.asn,
              expiresAt,
              status: "unclaimed",
              projectName: repo.name,
            })
            .onConflictDoNothing();
          row = await claimRowByRepo(svc.store, repo.id);
          await svc.audit.append({
            principalId: agent.id,
            action: "project.unclaimed-created",
            subject: `repo:${repo.id}`,
            payload: {
              name: repo.name,
              template: repo.template,
              expiresAt,
              creator: { ipHash: client.ipHash, asn: client.asn, country: client.country },
            },
          });
        }
        if (row === null) throw new Error(`claim record for ${repo.id} missing`);
        // The first Change's fork and its push token.
        await chargeArtifactsOps(svc.env, svc.store, repo, 2, limits, now.getTime(), null);
        const token = await issueProjectToken(svc.store, agent.id, new Date(row.expiresAt), now);
        const claimToken = await deriveClaimToken(svc.env, {
          repoId: row.repoId,
          agentPrincipalId: row.agentPrincipalId,
          createdAt: row.createdAt,
        });
        return { token, claimUrl: claimUrlFor(svc.origin, claimToken), expiresAt: row.expiresAt };
      },
    });
    if (reservation !== null) {
      await db
        .update(unclaimedCreations)
        .set({ repoId: out.projectId })
        .where(
          and(
            eq(unclaimedCreations.keyHash, reservation.keyHash),
            isNull(unclaimedCreations.repoId),
          ),
        );
    }
    return out;
  } catch (e) {
    // Nothing was created: the principal can never be used (no token was issued either).
    if (!created && reservation === null)
      await disablePrincipal(svc.store, agent.id, now).catch(() => false);
    throw e;
  }
}

/** Unexpired unclaimed creations from one IP (for tests and the admin view). */
export async function recentCreationsFrom(svc: Services, ipHash: string, sinceMs: number) {
  return svc.store.db
    .select({ repoId: projectClaims.repoId })
    .from(projectClaims)
    .where(
      and(
        eq(projectClaims.creatorIpHash, ipHash),
        gt(projectClaims.createdAt, new Date(sinceMs).toISOString()),
      ),
    )
    .all();
}
