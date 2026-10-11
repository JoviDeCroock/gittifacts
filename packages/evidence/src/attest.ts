/**
 * Ed25519 attestations over canonical JSON.
 *
 * The content bytes of an evidence attestation are exactly `canonicalBytes({changeId, headSha,
 * items})` (a document signature's: `canonicalBytes({document, purpose})`), and
 * `attestation.payloadDigest` is their SHA-256.
 *
 * - **v2** (evidence attestations since 2026-10-11; documents on request): the signature covers
 *   `canonicalBytes({typ: "gittifacts.attestation/v2", v: 2, alg, keyId, payloadDigest, signedAt,
 *   signer})`. The digest binds the content, and `signedAt` and `signer` are signed too, so a
 *   retired key's `notAfter` holds against anyone who lacks the key. (A leaked key can sign any
 *   time: revoke it, don't only expire it.)
 * - **v1** (still verified): the signature covers the content bytes alone, and `signedAt`/`signer`
 *   are unsigned claims. A v1 attestation from a key with `notAfter` cannot prove when it was
 *   signed, so it fails as `unverifiable-time` (unknown escalates) unless the caller states that
 *   `signedAt` comes from signed content (`signedAtBound`, e.g. an audit entry's `at`).
 *
 * The two signed shapes never collide: content objects have the keys `{changeId, headSha, items}`
 * or `{document, purpose}`, the v2 header has `typ`.
 */
import { CanonicalizationError, canonicalBytes } from "./canonical.js";
import { base64urlDecode, base64urlEncode, sha256Base64url, subtle } from "./encoding.js";
import {
  ED25519,
  ED25519_SIGNATURE_BYTES,
  importPrivateKey,
  importPublicKey,
  KeyError,
  type KeySet,
  keyIdFor,
  type ResolvedKey,
  resolveKeySet,
} from "./keys.js";
import { type Attestation, DocumentSignature, EvidencePayload, SignedEvidence } from "./schema.js";

export interface Signer {
  /** base64url PKCS#8 Ed25519 private key. */
  privateKey: string;
  /** base64url raw public key; must belong to `privateKey` (checked on every signature). */
  publicKey: string;
  /** Human/service label recorded in the attestation, e.g. "gittifacts-ci". */
  name: string;
}

export type VerifyFailureReason =
  | "schema"
  | "unknown-key"
  | "digest-mismatch"
  | "bad-signature"
  | "expired-key"
  /** A v1 attestation (unsigned `signedAt`) from a key that has a `notAfter`. */
  | "unverifiable-time";

export interface VerifyFailure {
  ok: false;
  reason: VerifyFailureReason;
  detail: string;
}

export type EvidenceVerifyResult =
  | { ok: true; keyId: string; keyName?: string; evidence: SignedEvidence }
  | VerifyFailure;

export type DocumentVerifyResult =
  | { ok: true; keyId: string; keyName?: string; signature: DocumentSignature }
  | VerifyFailure;

export class EvidenceValidationError extends Error {
  override readonly name = "EvidenceValidationError";
  readonly issues: readonly { path: string; message: string }[];
  constructor(what: string, issues: readonly { path: PropertyKey[]; message: string }[]) {
    const flat = issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
    super(`${what}: ${flat.map((i) => `${i.path || "<root>"}: ${i.message}`).join("; ")}`);
    this.issues = flat;
  }
}

export class SignerKeyMismatchError extends KeyError {
  constructor() {
    super("signer.publicKey does not belong to signer.privateKey");
  }
}

// --------------------------------------------------------------------------- bytes

/** The exact bytes an evidence attestation signs. Validates the payload first. */
export function evidenceSigningBytes(payload: EvidencePayload): Uint8Array {
  const parsed = EvidencePayload.safeParse(payload);
  if (!parsed.success)
    throw new EvidenceValidationError("invalid evidence payload", parsed.error.issues);
  const p = parsed.data;
  return canonicalBytes({ changeId: p.changeId, headSha: p.headSha, items: p.items });
}

export const ATTESTATION_V2_TYPE = "gittifacts.attestation/v2";

/** The attestation version {@link signEvidence} writes. */
export const ATTESTATION_VERSION = 2;

/** The exact bytes a v2 signature signs: the attestation header, which commits to the content. */
export function attestationSigningBytes(
  att: Pick<Attestation, "alg" | "keyId" | "payloadDigest" | "signedAt" | "signer">,
): Uint8Array {
  return canonicalBytes({
    typ: ATTESTATION_V2_TYPE,
    v: 2,
    alg: att.alg,
    keyId: att.keyId,
    payloadDigest: att.payloadDigest,
    signedAt: att.signedAt,
    signer: att.signer,
  });
}

export const DEFAULT_DOCUMENT_PURPOSE = "document";

/** The exact bytes a document signature signs: canonical `{document, purpose}`. */
export function documentSigningBytes(value: unknown, purpose: string): Uint8Array {
  return canonicalBytes({ document: value, purpose });
}

// --------------------------------------------------------------------------- sign

async function signBytes(
  bytes: Uint8Array,
  signer: Signer,
  now: Date,
  version: 1 | 2 = ATTESTATION_VERSION,
): Promise<Attestation> {
  if (Number.isNaN(now.getTime())) throw new RangeError("opts.now is an invalid Date");
  const keyId = await keyIdFor(signer.publicKey);
  const header = {
    alg: "Ed25519" as const,
    keyId,
    payloadDigest: await sha256Base64url(bytes),
    signedAt: now.toISOString(),
    signer: signer.name,
  };
  const signed = version === 2 ? attestationSigningBytes(header) : bytes;
  const privateKey = await importPrivateKey(signer.privateKey);
  const signature = new Uint8Array(await subtle().sign(ED25519, privateKey, signed));
  // Catch a mis-paired signer before it produces attestations nobody can verify.
  const publicKey = await importPublicKey(signer.publicKey);
  if (!(await subtle().verify(ED25519, publicKey, signature, signed))) {
    throw new SignerKeyMismatchError();
  }
  return { v: version, ...header, signature: base64urlEncode(signature) };
}

/**
 * Validate and sign an evidence payload. Unknown fields are stripped by validation
 * before signing, so the returned object is exactly what was signed (+ attestation).
 */
export async function signEvidence(
  payload: EvidencePayload,
  signer: Signer,
  opts: { now?: Date } = {},
): Promise<SignedEvidence> {
  const parsed = EvidencePayload.safeParse(payload);
  if (!parsed.success)
    throw new EvidenceValidationError("invalid evidence payload", parsed.error.issues);
  const { changeId, headSha, items } = parsed.data;
  const bytes = canonicalBytes({ changeId, headSha, items });
  const attestation = await signBytes(bytes, signer, opts.now ?? new Date());
  return { changeId, headSha, items, attestation };
}

/**
 * Sign any JSON value. `purpose` provides domain separation (default "document").
 *
 * Default `version: 1`: the raw signature covers `{document, purpose}` alone, so it can be stored
 * without its attestation (the platform's audit entries and plan approvals, why notes). Put the
 * signing time in the document and verify with `signedAtBound`. `version: 2` also signs
 * `signedAt` and `signer`; use it when the whole attestation is kept.
 */
export async function signDocument(
  value: unknown,
  signer: Signer,
  opts: { purpose?: string; now?: Date; version?: 1 | 2 } = {},
): Promise<DocumentSignature> {
  const purpose = opts.purpose ?? DEFAULT_DOCUMENT_PURPOSE;
  if (purpose.length === 0 || purpose.length > 200)
    throw new RangeError("purpose must be 1..200 chars");
  const attestation = await signBytes(
    documentSigningBytes(value, purpose),
    signer,
    opts.now ?? new Date(),
    opts.version ?? 1,
  );
  return { ...attestation, purpose };
}

// --------------------------------------------------------------------------- verify

function fail(reason: VerifyFailureReason, detail: string): VerifyFailure {
  return { ok: false, reason, detail };
}

function formatIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}

/**
 * `signedAtBound`: the caller vouches that `att.signedAt` is a time the signed content itself
 * commits to (v1 only; v2 always signs it). Without it a v1 attestation cannot prove its time.
 */
async function verifyBytes(
  bytes: Uint8Array,
  att: Attestation,
  keys: KeySet | string,
  signedAtBound = false,
): Promise<{ ok: true; key: ResolvedKey } | VerifyFailure> {
  const digest = await sha256Base64url(bytes);
  if (digest !== att.payloadDigest) {
    return fail(
      "digest-mismatch",
      `payload digest is ${digest}, attestation says ${att.payloadDigest}`,
    );
  }

  const resolved = await resolveKeySet(keys);
  const candidates = resolved.keys.filter((k) => k.keyId === att.keyId);
  if (candidates.length === 0) {
    const extra =
      resolved.rejected.length > 0
        ? ` (${resolved.rejected.length} key entries rejected as invalid)`
        : "";
    return fail("unknown-key", `no trusted key with id ${att.keyId}${extra}`);
  }

  let signature: Uint8Array;
  try {
    signature = base64urlDecode(att.signature);
  } catch (e) {
    return fail("bad-signature", `signature is not base64url: ${(e as Error).message}`);
  }
  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    return fail(
      "bad-signature",
      `signature must be ${ED25519_SIGNATURE_BYTES} bytes, got ${signature.length}`,
    );
  }

  let signed: Uint8Array;
  if (att.v === 2) {
    const header = bytesOrSchemaFailure(() => attestationSigningBytes(att));
    if (!(header instanceof Uint8Array)) return header;
    signed = header;
  } else {
    signed = bytes;
  }
  const timeSigned = att.v === 2 || signedAtBound;

  const signedAt = Date.parse(att.signedAt);
  let expired: ResolvedKey | null = null;
  let untimed: ResolvedKey | null = null;
  for (const key of candidates) {
    let valid = false;
    try {
      const handle = await importPublicKey(key.publicKey);
      valid = await subtle().verify(ED25519, handle, signature, signed);
    } catch {
      valid = false;
    }
    if (!valid) continue;
    if (key.notAfter !== undefined && !timeSigned) {
      // Unknown escalates: anyone may have edited an unsigned signedAt to sit before notAfter.
      untimed = key;
      continue;
    }
    if (key.notAfter !== undefined && !(signedAt <= Date.parse(key.notAfter))) {
      expired = key;
      continue;
    }
    return { ok: true, key };
  }
  if (expired) {
    return fail(
      "expired-key",
      `key ${expired.keyId} is not valid after ${expired.notAfter}; attestation signed at ${att.signedAt}`,
    );
  }
  if (untimed) {
    return fail(
      "unverifiable-time",
      `key ${untimed.keyId} is retired (notAfter ${untimed.notAfter}) and this v1 attestation does not sign its time (signedAt ${att.signedAt} is an unsigned claim); re-sign it with a current key, or trust the key without notAfter if you accept its v1 notes`,
    );
  }
  return fail("bad-signature", `Ed25519 signature does not verify under key ${att.keyId}`);
}

function bytesOrSchemaFailure(build: () => Uint8Array): Uint8Array | VerifyFailure {
  try {
    return build();
  } catch (e) {
    if (e instanceof CanonicalizationError)
      return fail("schema", `not canonicalizable: ${e.message}`);
    throw e;
  }
}

/**
 * Verify a signed evidence bundle (e.g. a decoded note). Never throws for bad input.
 *
 * The signature is checked over the *input's* `{changeId, headSha, items}` as given,
 * not over the schema-stripped copy, so fields injected after signing are detected.
 * On success, `evidence` is the schema-validated bundle — consume that.
 */
export async function verifyEvidence(
  signed: unknown,
  keys: KeySet | string,
): Promise<EvidenceVerifyResult> {
  const parsed = SignedEvidence.safeParse(signed);
  if (!parsed.success) return fail("schema", formatIssues(parsed.error.issues));
  const raw = signed as { changeId: unknown; headSha: unknown; items: unknown };
  const bytes = bytesOrSchemaFailure(() =>
    canonicalBytes({ changeId: raw.changeId, headSha: raw.headSha, items: raw.items }),
  );
  if (!(bytes instanceof Uint8Array)) return bytes;
  const r = await verifyBytes(bytes, parsed.data.attestation, keys);
  if (!r.ok) return r;
  const ok: EvidenceVerifyResult = { ok: true, keyId: r.key.keyId, evidence: parsed.data };
  if (r.key.name !== undefined) ok.keyName = r.key.name;
  return ok;
}

/**
 * Verify a detached document signature. `opts.purpose`, when given, must match the
 * purpose the document was signed for (otherwise `digest-mismatch`). `opts.signedAtBound`: the
 * caller took `sig.signedAt` from a field of the signed document (v1 signatures only).
 */
export async function verifyDocument(
  value: unknown,
  sig: unknown,
  keys: KeySet | string,
  opts: { purpose?: string; signedAtBound?: boolean } = {},
): Promise<DocumentVerifyResult> {
  const parsed = DocumentSignature.safeParse(sig);
  if (!parsed.success) return fail("schema", formatIssues(parsed.error.issues));
  const purpose = opts.purpose ?? parsed.data.purpose;
  if (purpose !== parsed.data.purpose) {
    return fail(
      "digest-mismatch",
      `signed for purpose "${parsed.data.purpose}", expected "${purpose}"`,
    );
  }
  const bytes = bytesOrSchemaFailure(() => documentSigningBytes(value, purpose));
  if (!(bytes instanceof Uint8Array)) return bytes;
  const r = await verifyBytes(bytes, parsed.data, keys, opts.signedAtBound ?? false);
  if (!r.ok) return r;
  const ok: DocumentVerifyResult = { ok: true, keyId: r.key.keyId, signature: parsed.data };
  if (r.key.name !== undefined) ok.keyName = r.key.name;
  return ok;
}
