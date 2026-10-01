/**
 * Ed25519 attestations over canonical JSON.
 *
 * An evidence attestation signs exactly `canonicalBytes({changeId, headSha, items})`.
 * `attestation.payloadDigest` is SHA-256 of those same bytes; it is redundant with the
 * signature but lets a verifier say *what* failed (content vs. signature).
 *
 * Not covered by the signature: `attestation.signedAt`, `attestation.signer`,
 * `attestation.keyId` (the key id is bound implicitly: the wrong key fails to verify).
 * `signedAt` is the signer's claim and is only used to apply a key's `notAfter`.
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
  | "expired-key";

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

export const DEFAULT_DOCUMENT_PURPOSE = "document";

/** The exact bytes a document signature signs: canonical `{document, purpose}`. */
export function documentSigningBytes(value: unknown, purpose: string): Uint8Array {
  return canonicalBytes({ document: value, purpose });
}

// --------------------------------------------------------------------------- sign

async function signBytes(bytes: Uint8Array, signer: Signer, now: Date): Promise<Attestation> {
  if (Number.isNaN(now.getTime())) throw new RangeError("opts.now is an invalid Date");
  const keyId = await keyIdFor(signer.publicKey);
  const privateKey = await importPrivateKey(signer.privateKey);
  const signature = new Uint8Array(await subtle().sign(ED25519, privateKey, bytes));
  // Catch a mis-paired signer before it produces attestations nobody can verify.
  const publicKey = await importPublicKey(signer.publicKey);
  if (!(await subtle().verify(ED25519, publicKey, signature, bytes))) {
    throw new SignerKeyMismatchError();
  }
  return {
    v: 1,
    alg: "Ed25519",
    keyId,
    payloadDigest: await sha256Base64url(bytes),
    signature: base64urlEncode(signature),
    signedAt: now.toISOString(),
    signer: signer.name,
  };
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

/** Sign any JSON value. `purpose` provides domain separation (default "document"). */
export async function signDocument(
  value: unknown,
  signer: Signer,
  opts: { purpose?: string; now?: Date } = {},
): Promise<DocumentSignature> {
  const purpose = opts.purpose ?? DEFAULT_DOCUMENT_PURPOSE;
  if (purpose.length === 0 || purpose.length > 200)
    throw new RangeError("purpose must be 1..200 chars");
  const attestation = await signBytes(
    documentSigningBytes(value, purpose),
    signer,
    opts.now ?? new Date(),
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

async function verifyBytes(
  bytes: Uint8Array,
  att: Attestation,
  keys: KeySet | string,
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

  const signedAt = Date.parse(att.signedAt);
  let expired: ResolvedKey | null = null;
  for (const key of candidates) {
    let valid = false;
    try {
      const handle = await importPublicKey(key.publicKey);
      valid = await subtle().verify(ED25519, handle, signature, bytes);
    } catch {
      valid = false;
    }
    if (!valid) continue;
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
 * purpose the document was signed for (otherwise `digest-mismatch`).
 */
export async function verifyDocument(
  value: unknown,
  sig: unknown,
  keys: KeySet | string,
  opts: { purpose?: string } = {},
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
  const r = await verifyBytes(bytes, parsed.data, keys);
  if (!r.ok) return r;
  const ok: DocumentVerifyResult = { ok: true, keyId: r.key.keyId, signature: parsed.data };
  if (r.key.name !== undefined) ok.keyName = r.key.name;
  return ok;
}
