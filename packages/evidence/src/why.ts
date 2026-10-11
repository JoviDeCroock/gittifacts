/**
 * Git-notes format for `refs/notes/why`: why a Change landed, on the commit that landed it.
 *
 * `refs/notes/evidence` proves what a Change does. This note records why it exists and who
 * answers for it: the human-approved Plan (intent, acceptance criteria, out of scope), the author
 * (for an agent, also the human accountable for it), the lane and its reasons, the approvals, the
 * agent trace and the evidence it landed with. Any clone can read it without the platform:
 *
 *   git fetch origin 'refs/notes/why:refs/notes/why' && git log --notes=why -1
 *
 * `attestation.signature` is the platform's detached Ed25519 signature over
 * `documentSigningBytes(<the note without "attestation">, attestation.purpose)`, checked with the
 * platform's published keys (/.well-known/gittifacts-keys.json); `landedAt` is when it was signed.
 * Like evidence notes, the LAST complete JSON document in a note is authoritative.
 */
import { z } from "zod";
import { documentSigningBytes, type VerifyFailureReason, verifyDocument } from "./attest.js";
import { CanonicalizationError, stableStringify } from "./canonical.js";
import { sha256Base64url } from "./encoding.js";
import type { KeySet } from "./keys.js";
import { EvidenceNoteError, lastNoteDocument, splitNoteDocuments } from "./notes.js";
import { type DocumentSignature, Sha } from "./schema.js";

export const WHY_NOTES_REF = "refs/notes/why";
export const WHY_NOTE_FORMAT = "gittifacts.why/v1";
/** The purpose the platform signs why notes with: its generic detached-document purpose. */
export const WHY_SIGNATURE_PURPOSE = "gittifacts/document";

/** A principal as the note shows it: enough to know who, without the platform. */
export const WhyPrincipal = z.object({
  id: z.string().min(1),
  /** "unknown" when the platform no longer has the principal: never guessed. */
  kind: z.enum(["human", "agent", "system", "integration", "unknown"]),
  name: z.string(),
});
export type WhyPrincipal = z.infer<typeof WhyPrincipal>;

/** The note's content: everything the signature covers. */
export const WhyRecord = z.object({
  format: z.literal(WHY_NOTE_FORMAT),
  changeId: z.string().min(1),
  title: z.string(),
  /** The author's claimed category (a claim: it can only raise risk). */
  category: z.string(),
  /** The Change's head as reviewed, and the commit this note is on (they differ after a rebase). */
  headSha: Sha,
  landedSha: Sha,
  author: WhyPrincipal,
  /** For an agent or integration: the human who registered it and answers for it. */
  accountable: WhyPrincipal.nullable(),
  /** The Plan a human approved; null when the Change had none (no approved intent). */
  plan: z
    .object({
      id: z.string().min(1),
      title: z.string(),
      intent: z.string(),
      acceptanceCriteria: z.array(z.string()),
      outOfScope: z.array(z.string()),
      approvedBy: WhyPrincipal.nullable(),
      approvedAt: z.string().nullable(),
      /** The platform's signature over the plan approval (purpose "gittifacts/plan-approval"). */
      approvalSignature: z.string().nullable(),
    })
    .nullable(),
  lane: z.number().int().min(0).max(2).nullable(),
  laneReasons: z.array(
    z.object({ code: z.string(), lane: z.number().int().min(0).max(2), message: z.string() }),
  ),
  /** Approvals that stood when it landed (withdrawn ones are left out), oldest first. */
  approvals: z.array(
    z.object({ reviewer: WhyPrincipal, headSha: Sha, at: z.string(), source: z.string() }),
  ),
  agentTrace: z
    .object({ provider: z.string(), traceId: z.string(), url: z.string().optional() })
    .nullable(),
  /** The signed evidence it landed with (refs/notes/evidence on the same commit). */
  evidenceId: z.string().nullable(),
  landedAt: z.string(),
});
export type WhyRecord = z.infer<typeof WhyRecord>;

export const WhyNote = WhyRecord.extend({
  attestation: z.object({
    keyId: z.string().min(1),
    purpose: z.string().min(1),
    signature: z.string().min(1),
  }),
});
export type WhyNote = z.infer<typeof WhyNote>;

const ORDER = [
  "format",
  "changeId",
  "title",
  "category",
  "headSha",
  "landedSha",
  "author",
  "accountable",
  "plan",
  "lane",
  "laneReasons",
  "approvals",
  "agentTrace",
  "evidenceId",
  "landedAt",
  "attestation",
] as const satisfies readonly (keyof WhyNote)[];

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.map(String).join(".") || "<root>"}: ${i.message}`);
}

/** Serialize a signed note: validated, deterministic, a fixed top-level order for reading. */
export function encodeWhyNote(note: WhyNote): string {
  const parsed = WhyNote.strict().safeParse(note);
  if (!parsed.success) {
    const issues = issuesOf(parsed.error);
    throw new EvidenceNoteError("invalid-input", `cannot encode why note: ${issues.join("; ")}`, {
      issues,
    });
  }
  const body = ORDER.map((k) => {
    const v = stableStringify(note[k], 2).replace(/\n/g, "\n  ");
    return `  ${JSON.stringify(k)}: ${v}`;
  });
  return `{\n${body.join(",\n")}\n}\n`;
}

/** The last complete document in a `refs/notes/why` note, validated. Throws EvidenceNoteError. */
export function decodeWhyNote(text: string): WhyNote {
  const docs = splitNoteDocuments(text);
  const last = docs[docs.length - 1];
  if (last === undefined)
    throw new EvidenceNoteError("empty", "note contains no complete JSON document");
  let doc: unknown;
  try {
    doc = JSON.parse(last);
  } catch (e) {
    throw new EvidenceNoteError(
      "invalid-json",
      `why note is not valid JSON: ${(e as Error).message}`,
      {
        documentIndex: docs.length - 1,
      },
    );
  }
  const parsed = WhyNote.safeParse(doc);
  if (!parsed.success) {
    const issues = issuesOf(parsed.error);
    throw new EvidenceNoteError("schema", `not a ${WHY_NOTE_FORMAT} note: ${issues.join("; ")}`, {
      documentIndex: docs.length - 1,
      issues,
    });
  }
  return parsed.data;
}

/** What the signature covers: the note without its attestation. */
export function whySigningRecord(note: WhyNote): WhyRecord {
  const { attestation: _, ...record } = note;
  return record;
}

// --------------------------------------------------------------------------- verify

export type WhyVerifyFailureReason = VerifyFailureReason | "bad-note" | "commit-mismatch";

export type WhyVerifyResult =
  | {
      ok: true;
      note: WhyNote;
      keyId: string;
      keyName?: string;
      /** False when no commit was given, so `landedSha` was not compared with anything. */
      bindingChecked: boolean;
    }
  | {
      ok: false;
      reason: WhyVerifyFailureReason;
      detail: string;
      /** The schema-valid note, when it got that far (for display only: it is not trusted). */
      note?: WhyNote;
    };

/**
 * Verify a `refs/notes/why` note's text. Never throws for bad input.
 *
 * - The LAST complete JSON document is authoritative (an appended forgery fails the commit).
 * - It must be a valid `gittifacts.why/v1` note signed with purpose `gittifacts/document`.
 * - The signature is checked over the stored document minus `attestation`, as given (not the
 *   schema-stripped copy), so a field injected after signing fails like an edited one.
 * - `landedAt` is the signing time the note claims; it is only used to apply a key's `notAfter`.
 * - With `opts.commit`, `landedSha` must name that commit (a note copied elsewhere fails).
 */
export async function verifyWhyNote(
  text: string,
  keys: KeySet | string,
  opts: { commit?: string } = {},
): Promise<WhyVerifyResult> {
  let doc: unknown;
  try {
    doc = lastNoteDocument(text);
  } catch (e) {
    if (!(e instanceof EvidenceNoteError)) throw e;
    return { ok: false, reason: "bad-note", detail: e.message };
  }
  const parsed = WhyNote.safeParse(doc);
  if (!parsed.success) {
    const issues = issuesOf(parsed.error).slice(0, 5);
    return {
      ok: false,
      reason: "schema",
      detail: `not a ${WHY_NOTE_FORMAT} note: ${issues.join("; ")}`,
    };
  }
  const note = parsed.data;
  const { attestation: _, ...record } = doc as Record<string, unknown>;
  const { purpose } = note.attestation;
  let bytes: Uint8Array;
  try {
    bytes = documentSigningBytes(record, purpose);
  } catch (e) {
    if (!(e instanceof CanonicalizationError)) throw e;
    return { ok: false, reason: "schema", detail: `not canonicalizable: ${e.message}`, note };
  }
  if (Number.isNaN(Date.parse(note.landedAt))) {
    return {
      ok: false,
      reason: "schema",
      detail: `landedAt is not a date: ${note.landedAt}`,
      note,
    };
  }
  const sig: DocumentSignature = {
    v: 1,
    alg: "Ed25519",
    keyId: note.attestation.keyId,
    payloadDigest: await sha256Base64url(bytes),
    signature: note.attestation.signature,
    signedAt: new Date(note.landedAt).toISOString(),
    signer: "gittifacts",
    purpose,
  };
  const r = await verifyDocument(record, sig, keys, { purpose: WHY_SIGNATURE_PURPOSE });
  if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail, note };
  if (opts.commit !== undefined && note.landedSha !== opts.commit) {
    return {
      ok: false,
      reason: "commit-mismatch",
      detail: `note says it landed as ${note.landedSha}, not ${opts.commit}`,
      note,
    };
  }
  const ok: WhyVerifyResult = {
    ok: true,
    note,
    keyId: r.keyId,
    bindingChecked: opts.commit !== undefined,
  };
  if (r.keyName !== undefined) ok.keyName = r.keyName;
  return ok;
}
