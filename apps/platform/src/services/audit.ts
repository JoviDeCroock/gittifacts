import type { AuditEvent } from "@app/domain";
import { and, inArray } from "drizzle-orm";
import { assertRepoAccess } from "../access/access.js";
import { auditVisibility, repoAuditSubjects } from "../access/audit.js";
import type { Caller, Services } from "../app-env.js";
import { auditLogStub } from "../audit/audit.js";
import { verifyEntries } from "../audit/chain.js";
import { summarizeAudit } from "../audit/summary.js";
import { changes, plans, repos } from "../db/schema.js";
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

/** What a subject is called, for reading: a change or plan title, a repo or principal name. */
export interface AuditSubjectRef {
  title: string;
  repoId: string | null;
  repoName: string | null;
}

export interface ChainStatus {
  /** True only when no break was found and every entry up to the head is verified. */
  verified: boolean;
  brokenAt?: number;
  /** Highest seq verified in the AuditLog DO (it and every earlier entry). */
  verifiedThrough: number;
  /** Head of the log when checked. */
  headSeq: number;
  /** verifiedThrough reached headSeq; false means the rest is checked on later reads. */
  complete: boolean;
}

export interface AuditPage {
  events: AuditEventView[];
  nextCursor: string | null;
  chain: ChainStatus;
  principals: Record<string, PrincipalRef>;
  /** `change:<id>`, `plan:<id>`, `repo:<id>`, `principal:<id>` → its title (unknown ones left out). */
  subjects: Record<string, AuditSubjectRef>;
}

/**
 * Titles for the subjects `events` name, in three batched lookups (changes, plans, repos) plus the
 * principal names already resolved. Only called with events the caller may read, so a title
 * never leaks a repo the caller can't see.
 */
export async function auditSubjectRefs(
  svc: Services,
  subjects: Iterable<string>,
  principals: Record<string, PrincipalRef>,
): Promise<Record<string, AuditSubjectRef>> {
  const ids = { change: new Set<string>(), plan: new Set<string>(), repo: new Set<string>() };
  const out: Record<string, AuditSubjectRef> = {};
  for (const subject of new Set(subjects)) {
    const at = subject.indexOf(":");
    const kind = subject.slice(0, at);
    const id = subject.slice(at + 1);
    if (kind === "change" || kind === "plan" || kind === "repo") ids[kind].add(id);
    const p = kind === "principal" ? principals[id] : undefined;
    if (p !== undefined) out[subject] = { title: p.name, repoId: null, repoName: null };
  }
  const db = svc.store.db;
  // D1 caps bound parameters per statement: look up in chunks of 90 ids.
  const batch = async <T>(set: Set<string>, fn: (chunk: string[]) => Promise<T[]>) => {
    const all = [...set];
    const out: T[] = [];
    for (let i = 0; i < all.length; i += 90) out.push(...(await fn(all.slice(i, i + 90))));
    return out;
  };
  const [cs, ps] = await Promise.all([
    batch(ids.change, (c) =>
      db
        .select({ id: changes.id, title: changes.title, repoId: changes.repoId })
        .from(changes)
        .where(inArray(changes.id, c))
        .all(),
    ),
    batch(ids.plan, (c) =>
      db
        .select({ id: plans.id, title: plans.title, repoId: plans.repoId })
        .from(plans)
        .where(inArray(plans.id, c))
        .all(),
    ),
  ]);
  for (const r of [...cs, ...ps]) ids.repo.add(r.repoId);
  const rs = await batch(ids.repo, (c) =>
    db.select({ id: repos.id, name: repos.name }).from(repos).where(inArray(repos.id, c)).all(),
  );
  const repoName = new Map(rs.map((r) => [r.id, r.name]));
  for (const r of rs) out[`repo:${r.id}`] = { title: r.name, repoId: r.id, repoName: r.name };
  for (const [kind, rows] of [
    ["change", cs],
    ["plan", ps],
  ] as const)
    for (const r of rows)
      out[`${kind}:${r.id}`] = {
        title: r.title,
        repoId: r.repoId,
        repoName: repoName.get(r.repoId) ?? null,
      };
  return out;
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
 * 2. the chain in the AuditLog DO (the source of truth), incrementally from its verified-through
 *    checkpoint and at most a bounded number of new entries per read (M9): when more remain the
 *    status says so (`complete: false`, `verifiedThrough`) instead of blocking the log.
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
  const visible =
    readable === null ? inRepo : inRepo === undefined ? readable : and(readable, inRepo);
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
  const broken = [pageCheck, doCheck]
    .map((r) => r.brokenAt)
    .filter((b): b is number => b !== undefined);
  const chain: ChainStatus = {
    verified: pageCheck.verified && doCheck.verified,
    verifiedThrough: doCheck.verifiedThrough,
    headSeq: doCheck.headSeq,
    complete: doCheck.complete,
    ...(broken.length > 0 ? { brokenAt: Math.min(...broken) } : {}),
  };
  const events2 = page.map((e) => ({ ...e, summary: summarizeAudit(e, payloads.get(e.seq)) }));
  // Subjects about principals are named too (e.g. `principal:<agent>` when a token is issued).
  const principals = await svc.store.principalRefs(
    page.flatMap((e) =>
      e.subject.startsWith("principal:") ? [e.principalId, e.subject.slice(10)] : [e.principalId],
    ),
  );
  const subjects = await auditSubjectRefs(
    svc,
    page.map((e) => e.subject),
    principals,
  );
  return { events: events2, nextCursor, chain, principals, subjects };
}

/** Full re-verify of the AuditLog DO from genesis (platform admins only; see routes/audit.ts). */
export async function reverifyAudit(svc: Services): Promise<ChainStatus & { checked: number }> {
  const r = await auditLogStub(svc.env, svc.auditLog).verifyChainFull();
  return {
    verified: r.verified,
    verifiedThrough: r.verifiedThrough,
    headSeq: r.headSeq,
    complete: r.complete,
    checked: r.checked,
    ...(r.brokenAt !== undefined ? { brokenAt: r.brokenAt } : {}),
  };
}
