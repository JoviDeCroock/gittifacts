import type { AuditEvent } from "@app/domain";
import { and } from "drizzle-orm";
import { assertRepoAccess } from "../access/access.js";
import { auditVisibility, repoAuditSubjects } from "../access/audit.js";
import type { Caller, Services } from "../app-env.js";
import { auditLogStub } from "../audit/audit.js";
import { verifyEntries } from "../audit/chain.js";
import { summarizeAudit } from "../audit/summary.js";
import type { PrincipalRef } from "../store/d1-store.js";

/** An audit event as the API returns it: with a readable one-liner. */
export type AuditEventView = AuditEvent & { summary: string };

export async function withSummaries(
  svc: Services,
  events: readonly AuditEvent[],
): Promise<AuditEventView[]> {
  const payloads = await svc.store.auditPayloads(
    svc.auditLog,
    events.map((e) => e.seq),
  );
  return events.map((e) => ({ ...e, summary: summarizeAudit(e, payloads.get(e.seq)) }));
}

export interface AuditPage {
  events: AuditEventView[];
  nextCursor: string | null;
  chain: { verified: boolean; brokenAt?: number };
  principals: Record<string, PrincipalRef>;
}

/** Exact-match filters on the audit log; together they narrow (AND). */
export interface AuditFilter {
  /** Only this repo's events (the repo, its plans and its changes). */
  repoId?: string | undefined;
  subject?: string | undefined;
  /** The principal that acted (e.g. one agent's trail). */
  actor?: string | undefined;
  action?: string | undefined;
}

/**
 * A page of the audit log (newest first) from the D1 mirror, with two checks:
 * 1. the returned rows themselves (hashes, payloads, signatures, links between adjacent seqs),
 *    which catches tampering with the mirror;
 * 2. the full chain in the AuditLog DO (the source of truth).
 * `brokenAt` is the lowest failing seq.
 *
 * Only events the caller may read (src/access/audit.ts): its repos' events, its own principals',
 * and platform-wide ones for platform admins; auditors read everything.
 */
export async function listAudit(
  svc: Services,
  caller: Caller,
  q: AuditFilter & { cursor?: string | undefined; limit: number },
): Promise<AuditPage> {
  // A named repo the caller can't read is a 404, like everywhere else.
  if (q.repoId !== undefined) await assertRepoAccess(svc, caller.principal, q.repoId, "read");
  const readable = await auditVisibility(svc, caller.principal);
  const inRepo = q.repoId === undefined ? undefined : repoAuditSubjects(q.repoId);
  const visible = readable === null ? inRepo : inRepo === undefined ? readable : and(readable, inRepo);
  const events = await svc.store.listAuditEvents({
    log: svc.auditLog,
    ...(visible !== undefined ? { visible } : {}),
    ...(q.subject !== undefined ? { subject: q.subject } : {}),
    ...(q.actor !== undefined ? { actor: q.actor } : {}),
    ...(q.action !== undefined ? { action: q.action } : {}),
    ...(q.cursor !== undefined ? { beforeSeq: Number(q.cursor) } : {}),
    limit: q.limit + 1,
  });
  const page = events.slice(0, q.limit);
  const nextCursor =
    events.length > q.limit && page.length > 0 ? String(page[page.length - 1]!.seq) : null;

  const signer = await svc.signer();
  const ascending = [...page].reverse();
  const payloads = await svc.store.auditPayloads(
    svc.auditLog,
    ascending.map((e) => e.seq),
  );
  const [pageCheck, doCheck] = await Promise.all([
    verifyEntries(ascending, signer, { payloads, contiguous: false }),
    auditLogStub(svc.env, svc.auditLog).verifyChain(),
  ]);
  const broken = [pageCheck, doCheck].filter((r) => !r.verified).map((r) => r.brokenAt ?? 0);
  const chain =
    broken.length === 0 ? { verified: true } : { verified: false, brokenAt: Math.min(...broken) };
  const events2 = page.map((e) => ({ ...e, summary: summarizeAudit(e, payloads.get(e.seq)) }));
  const principals = await svc.store.principalRefs(page.map((e) => e.principalId));
  return { events: events2, nextCursor, chain, principals };
}
