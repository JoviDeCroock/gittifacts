import type { AuditEvent } from "@app/domain";
import type { Services } from "../app-env.js";
import { auditLogStub } from "../audit/audit.js";
import { verifyEntries } from "../audit/chain.js";

export interface AuditPage {
  events: AuditEvent[];
  nextCursor: string | null;
  chain: { verified: boolean; brokenAt?: number };
}

/**
 * A page of the audit log (newest first) from the D1 mirror, with two checks:
 * 1. the returned rows themselves (hashes, payloads, signatures, links between adjacent seqs),
 *    which catches tampering with the mirror;
 * 2. the full chain in the AuditLog DO (the source of truth).
 * `brokenAt` is the lowest failing seq.
 */
export async function listAudit(
  svc: Services,
  q: { subject?: string | undefined; cursor?: string | undefined; limit: number },
): Promise<AuditPage> {
  const events = await svc.store.listAuditEvents({
    log: svc.auditLog,
    ...(q.subject !== undefined ? { subject: q.subject } : {}),
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
  return { events: page, nextCursor, chain };
}
