/**
 * `repo_invites` queries and invite tokens. Everything that reads or writes invites goes through
 * here; the service (./invites.ts) decides who may.
 *
 * Tokens (`gtm_…`, the invite link a person opens) are 32 random bytes, shown once. Only their
 * SHA-256 is stored; lookups go by that hash.
 */
import { base64urlEncode, sha256Hex } from "@app/evidence";
import { and, eq, gt, isNull } from "drizzle-orm";
import { repoInvites } from "../db/schema.js";
import type { D1Store } from "../store/d1-store.js";
import { isRepoRole, type RepoRole } from "./roles.js";

export const INVITE_TOKEN_PREFIX = "gtm_";
const INVITE_TOKEN_SHAPE = /^gtm_[A-Za-z0-9_-]{43}$/;
/** An invite link works for a week. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function isInviteTokenShape(token: string): boolean {
  return INVITE_TOKEN_SHAPE.test(token);
}

export function newInviteToken(): string {
  return `${INVITE_TOKEN_PREFIX}${base64urlEncode(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export function hashInviteToken(token: string): Promise<string> {
  return sha256Hex(token);
}

export function inviteUrlFor(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/invite/${token}`;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface InviteRow {
  id: string;
  repoId: string;
  email: string;
  role: RepoRole;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedBy: string | null;
  revokedAt: string | null;
}

function toRow(r: typeof repoInvites.$inferSelect): InviteRow | null {
  if (!isRepoRole(r.role)) return null;
  const { tokenHash: _hash, ...rest } = r;
  return { ...rest, role: r.role };
}

/** Invites not yet accepted or revoked (expired ones included: the owner sees them lapse). */
export async function listOpenInvites(store: D1Store, repoId: string): Promise<InviteRow[]> {
  const rows = await store.db
    .select()
    .from(repoInvites)
    .where(
      and(
        eq(repoInvites.repoId, repoId),
        isNull(repoInvites.acceptedAt),
        isNull(repoInvites.revokedAt),
      ),
    )
    .orderBy(repoInvites.createdAt)
    .all();
  return rows.map(toRow).filter((r): r is InviteRow => r !== null);
}

export async function inviteByTokenHash(store: D1Store, hash: string): Promise<InviteRow | null> {
  const r = await store.db.select().from(repoInvites).where(eq(repoInvites.tokenHash, hash)).get();
  return r ? toRow(r) : null;
}

export async function inviteById(store: D1Store, repoId: string, id: string) {
  const r = await store.db
    .select()
    .from(repoInvites)
    .where(and(eq(repoInvites.repoId, repoId), eq(repoInvites.id, id)))
    .get();
  return r ? toRow(r) : null;
}

/** Revoke every open invite for (repo, e-mail): inviting again replaces the link. */
export async function revokeOpenInvites(
  store: D1Store,
  where: { repoId: string; email?: string; id?: string },
  at: string,
): Promise<string[]> {
  const rows = await store.db
    .update(repoInvites)
    .set({ revokedAt: at })
    .where(
      and(
        eq(repoInvites.repoId, where.repoId),
        where.email === undefined ? undefined : eq(repoInvites.email, where.email),
        where.id === undefined ? undefined : eq(repoInvites.id, where.id),
        isNull(repoInvites.acceptedAt),
        isNull(repoInvites.revokedAt),
      ),
    )
    .returning({ id: repoInvites.id });
  return rows.map((r) => r.id);
}

export async function insertInvite(
  store: D1Store,
  row: Omit<InviteRow, "acceptedAt" | "acceptedBy" | "revokedAt">,
  tokenHash: string,
): Promise<void> {
  await store.db.insert(repoInvites).values({ ...row, tokenHash });
}

/**
 * Mark an invite accepted, in one statement that also checks it is still open and unexpired, so
 * a link works once even when two tabs accept at the same moment. True when this call won.
 */
export async function markAccepted(
  store: D1Store,
  id: string,
  principalId: string,
  at: string,
): Promise<boolean> {
  const rows = await store.db
    .update(repoInvites)
    .set({ acceptedAt: at, acceptedBy: principalId })
    .where(
      and(
        eq(repoInvites.id, id),
        isNull(repoInvites.acceptedAt),
        isNull(repoInvites.revokedAt),
        gt(repoInvites.expiresAt, at),
      ),
    )
    .returning({ id: repoInvites.id });
  return rows.length > 0;
}
