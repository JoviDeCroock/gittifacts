/**
 * Hash chain for the audit log. Pure functions; the AuditLog Durable Object is the only writer.
 *
 *   payloadHash = b64url(SHA-256(canonical(payload ?? null)))
 *   hash        = b64url(SHA-256(canonical({seq, at, principalId, action, subject, payloadHash, prevHash})))
 *   prevHash    = previous entry's hash; genesis = 43 x "A" (the b64url of 32 zero bytes)
 *   signature   = platform Ed25519 over documentSigningBytes(hash, "gittifacts/audit-entry")
 */
import type { AuditEvent } from "@app/domain";
import { canonicalBytes, sha256Base64url } from "@app/evidence";
import { z } from "zod";
import { type PlatformSigner, Purpose } from "../signing.js";

export const GENESIS_HASH = "A".repeat(43);

export const AuditAppendInput = z.object({
  principalId: z.string().min(1).max(64),
  action: z.string().min(1).max(100),
  subject: z.string().min(1).max(200),
  payload: z.unknown(),
});
export type AuditAppendInput = z.infer<typeof AuditAppendInput>;

export type ChainLink = Pick<AuditEvent, "seq" | "hash">;

export async function payloadHashOf(payload: unknown): Promise<string> {
  return sha256Base64url(canonicalBytes(payload ?? null));
}

export async function entryHashOf(
  e: Pick<AuditEvent, "seq" | "at" | "principalId" | "action" | "subject" | "payloadHash" | "prevHash">,
): Promise<string> {
  return sha256Base64url(
    canonicalBytes({
      seq: e.seq,
      at: e.at,
      principalId: e.principalId,
      action: e.action,
      subject: e.subject,
      payloadHash: e.payloadHash,
      prevHash: e.prevHash,
    }),
  );
}

export async function buildEntry(
  prev: ChainLink | null,
  input: AuditAppendInput,
  at: Date,
  signer: PlatformSigner,
): Promise<AuditEvent> {
  const seq = prev ? prev.seq + 1 : 1;
  const prevHash = prev ? prev.hash : GENESIS_HASH;
  const base = {
    seq,
    at: at.toISOString(),
    principalId: input.principalId,
    action: input.action,
    subject: input.subject,
    payloadHash: await payloadHashOf(input.payload),
    prevHash,
  };
  const hash = await entryHashOf(base);
  const sig = await signer.signDetached(hash, Purpose.auditEntry, at);
  return { ...base, hash, signature: sig.signature, keyId: sig.keyId };
}

export interface ChainVerification {
  verified: boolean;
  /** First seq that failed (hash, link, payload or signature). */
  brokenAt?: number;
  reason?: string;
  /** Entries checked. */
  checked: number;
  /** Highest seq seen. */
  headSeq: number;
}

/**
 * Verify entries in ascending seq order. `anchor` is the entry before the first one
 * (null = the first entry must be seq 1 and link to genesis). `payloads` (by seq), when present,
 * are re-hashed against `payloadHash`. With `contiguous: false`, gaps in seq are allowed and
 * links are only checked between adjacent seqs (used for a filtered page of the D1 mirror).
 */
export async function verifyEntries(
  entries: readonly AuditEvent[],
  signer: PlatformSigner,
  opts: {
    anchor?: ChainLink | null;
    payloads?: ReadonlyMap<number, unknown>;
    contiguous?: boolean;
  } = {},
): Promise<ChainVerification> {
  const contiguous = opts.contiguous ?? true;
  let prev: ChainLink | null = opts.anchor ?? null;
  let headSeq = prev?.seq ?? 0;
  let checked = 0;
  const fail = (seq: number, reason: string): ChainVerification => ({
    verified: false,
    brokenAt: seq,
    reason,
    checked,
    headSeq,
  });
  for (const e of entries) {
    if (contiguous) {
      const expectedSeq = prev ? prev.seq + 1 : 1;
      if (e.seq !== expectedSeq) return fail(e.seq, `expected seq ${expectedSeq}, found ${e.seq}`);
      const expectedPrev = prev ? prev.hash : GENESIS_HASH;
      if (e.prevHash !== expectedPrev) return fail(e.seq, "prevHash does not link to the previous entry");
    } else if (prev && e.seq === prev.seq + 1 && e.prevHash !== prev.hash) {
      return fail(e.seq, "prevHash does not link to the previous entry");
    } else if (!prev && e.seq === 1 && e.prevHash !== GENESIS_HASH) {
      return fail(e.seq, "first entry does not link to genesis");
    }
    if (opts.payloads?.has(e.seq)) {
      const ph = await payloadHashOf(opts.payloads.get(e.seq));
      if (ph !== e.payloadHash) return fail(e.seq, "payload does not match payloadHash");
    }
    const hash = await entryHashOf(e);
    if (hash !== e.hash) return fail(e.seq, "entry hash mismatch");
    const sig = await signer.verifyDetached(e.hash, e.signature, {
      purpose: Purpose.auditEntry,
      keyId: e.keyId,
      signedAt: e.at,
    });
    if (!sig.ok) return fail(e.seq, `signature: ${sig.reason}`);
    prev = { seq: e.seq, hash: e.hash };
    headSeq = e.seq;
    checked++;
  }
  return { verified: true, checked, headSeq };
}
