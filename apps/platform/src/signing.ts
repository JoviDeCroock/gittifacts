/**
 * The platform's Ed25519 signer (the `Signer` port), backed by `@app/evidence` and the
 * `PLATFORM_SIGNING_KEY` secret (JSON as printed by the evidence keygen CLI).
 *
 * Detached document signatures (plan approvals, audit entries, `Signer.signDocument`) are the raw
 * base64url Ed25519 signature over `@app/evidence`'s `documentSigningBytes(value, purpose)`, i.e.
 * canonical JSON of `{ document, purpose }`. The purpose gives domain separation, so a plan
 * approval can never be replayed as an audit entry or an evidence attestation. Verify with
 * {@link PlatformSigner.verifyDetached} (or rebuild a `DocumentSignature` for `verifyDocument`).
 */
import type { Signer as SignerPort } from "@app/coordinator";
import {
  type DocumentSignature,
  documentSigningBytes,
  type EvidencePayload,
  KeyError,
  keyIdFor,
  publicKeyFromPrivateKey,
  type ResolvedKey,
  resolveKeySet,
  type SignedEvidence,
  sha256Base64url,
  signDocument,
  signEvidence,
  verifyDocument,
  verifyEvidence,
} from "@app/evidence";
import { z } from "zod";

export const SIGNER_NAME = "gittifacts";

/** Domain-separation labels for detached signatures. */
export const Purpose = {
  document: "gittifacts/document",
  planApproval: "gittifacts/plan-approval",
  auditEntry: "gittifacts/audit-entry",
} as const;
export type Purpose = (typeof Purpose)[keyof typeof Purpose];

const RetiredKey = z.object({
  publicKey: z.string().min(1),
  keyId: z.string().optional(),
  /** Signatures made after this instant no longer verify under this key. */
  notAfter: z.string().datetime({ offset: true }),
  name: z.string().optional(),
});

/** `PLATFORM_SIGNING_KEY` secret: keygen output, optionally with retired keys for rotation. */
export const PlatformKeySecret = z.object({
  privateKey: z.string().min(1),
  publicKey: z.string().min(1).optional(),
  keyId: z.string().optional(),
  name: z.string().optional(),
  previous: z.array(RetiredKey).default([]),
});

export interface PublishedKey {
  keyId: string;
  alg: "Ed25519";
  publicKey: string;
  notAfter?: string;
}

export interface DetachedSignature {
  signature: string;
  keyId: string;
  signedAt: string;
}

export type VerifyOutcome = { ok: true; keyId: string } | { ok: false; reason: string };

export class SigningKeyConfigError extends Error {
  override readonly name = "SigningKeyConfigError";
}

export class PlatformSigner implements SignerPort {
  private constructor(
    private readonly privateKey: string,
    readonly publicKey: string,
    readonly keyId: string,
    /** Current key first, then retired keys (each with notAfter). */
    readonly keys: readonly ResolvedKey[],
    private readonly now: () => Date,
  ) {}

  static async fromSecret(
    secret: string,
    now: () => Date = () => new Date(),
  ): Promise<PlatformSigner> {
    let json: unknown;
    try {
      json = JSON.parse(secret);
    } catch {
      throw new SigningKeyConfigError("PLATFORM_SIGNING_KEY is not JSON");
    }
    const parsed = PlatformKeySecret.safeParse(json);
    if (!parsed.success) {
      throw new SigningKeyConfigError(`PLATFORM_SIGNING_KEY is invalid: ${parsed.error.message}`);
    }
    const s = parsed.data;
    let publicKey: string;
    try {
      publicKey = s.publicKey ?? (await publicKeyFromPrivateKey(s.privateKey));
    } catch (e) {
      throw new SigningKeyConfigError(`PLATFORM_SIGNING_KEY: ${(e as Error).message}`);
    }
    const keyId = await keyIdFor(publicKey);
    if (s.keyId !== undefined && s.keyId !== keyId) {
      throw new SigningKeyConfigError(
        `PLATFORM_SIGNING_KEY keyId ${s.keyId} does not match its public key`,
      );
    }
    const resolved = await resolveKeySet([
      { publicKey, ...(s.name ? { name: s.name } : {}) },
      ...s.previous.map((k) => ({
        publicKey: k.publicKey,
        notAfter: k.notAfter,
        ...(k.keyId ? { keyId: k.keyId } : {}),
        ...(k.name ? { name: k.name } : {}),
      })),
    ]);
    if (resolved.rejected.length > 0) {
      throw new SigningKeyConfigError(
        `PLATFORM_SIGNING_KEY has invalid entries: ${resolved.rejected.map((r) => r.reason).join("; ")}`,
      );
    }
    return new PlatformSigner(s.privateKey, publicKey, keyId, resolved.keys, now);
  }

  private get evidenceSigner() {
    return { privateKey: this.privateKey, publicKey: this.publicKey, name: SIGNER_NAME };
  }

  /** `{ keys: [...] }` for /.well-known/gittifacts-keys.json and `verify-attestation --keys`. */
  publishedKeys(): { keys: PublishedKey[] } {
    return {
      keys: this.keys.map((k) => ({
        keyId: k.keyId,
        alg: "Ed25519" as const,
        publicKey: k.publicKey,
        ...(k.notAfter ? { notAfter: k.notAfter } : {}),
      })),
    };
  }

  async signEvidence(payload: EvidencePayload): Promise<SignedEvidence> {
    return signEvidence(payload, this.evidenceSigner, { now: this.now() });
  }

  async verifyEvidence(signed: SignedEvidence): Promise<{ ok: boolean; reason?: string }> {
    const r = await verifyEvidence(signed, this.keys);
    return r.ok ? { ok: true } : { ok: false, reason: `${r.reason}: ${r.detail}` };
  }

  async verifyEvidenceDetailed(signed: unknown): Promise<VerifyOutcome> {
    const r = await verifyEvidence(signed, this.keys);
    return r.ok ? { ok: true, keyId: r.keyId } : { ok: false, reason: `${r.reason}: ${r.detail}` };
  }

  /** Port method: detached signature with the generic document purpose. */
  async signDocument(value: unknown): Promise<string> {
    return (await this.signDetached(value, Purpose.document)).signature;
  }

  async signDetached(value: unknown, purpose: Purpose, at?: Date): Promise<DetachedSignature> {
    const sig = await signDocument(value, this.evidenceSigner, { purpose, now: at ?? this.now() });
    return { signature: sig.signature, keyId: sig.keyId, signedAt: sig.signedAt };
  }

  /**
   * Verify a raw detached signature. `signedAt` is the time the signature claims (an audit
   * entry's `at`, a plan's `approvedAt`); it is only used to apply a retired key's `notAfter`.
   */
  async verifyDetached(
    value: unknown,
    signature: string,
    opts: { purpose: Purpose; keyId: string; signedAt: string },
  ): Promise<VerifyOutcome> {
    let bytes: Uint8Array;
    try {
      bytes = documentSigningBytes(value, opts.purpose);
    } catch (e) {
      return { ok: false, reason: `schema: ${(e as Error).message}` };
    }
    const sig: DocumentSignature = {
      v: 1,
      alg: "Ed25519",
      keyId: opts.keyId,
      payloadDigest: await sha256Base64url(bytes),
      signature,
      signedAt: opts.signedAt,
      signer: SIGNER_NAME,
      purpose: opts.purpose,
    };
    const r = await verifyDocument(value, sig, this.keys, { purpose: opts.purpose });
    return r.ok ? { ok: true, keyId: r.keyId } : { ok: false, reason: `${r.reason}: ${r.detail}` };
  }
}

const cache = new Map<string, Promise<PlatformSigner>>();

/** One parsed signer per isolate and secret value. */
export function platformSigner(env: { PLATFORM_SIGNING_KEY: string }): Promise<PlatformSigner> {
  const secret = env.PLATFORM_SIGNING_KEY;
  if (!secret) return Promise.reject(new SigningKeyConfigError("PLATFORM_SIGNING_KEY is not set"));
  let p = cache.get(secret);
  if (!p) {
    p = PlatformSigner.fromSecret(secret);
    p.catch(() => cache.delete(secret));
    cache.set(secret, p);
  }
  return p;
}

export { KeyError };
