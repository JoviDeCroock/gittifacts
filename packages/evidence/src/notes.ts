/**
 * Git-notes format for `refs/notes/evidence`.
 *
 * A note is pretty-printed JSON (2-space indent, canonical key order inside, a
 * fixed top-level order for readability) with a trailing newline:
 *
 *   { "format": "gittifacts.evidence/v1", "changeId": …, "headSha": …,
 *     "attestation": {…}, "items": […] }
 *
 * `git notes append` concatenates notes separated by a blank line, so a note may
 * hold several JSON documents. The LAST complete document is authoritative;
 * an incomplete trailing fragment is ignored.
 */
import { stableStringify } from "./canonical.js";
import { EVIDENCE_NOTE_FORMAT, EvidenceNote, SignedEvidence } from "./schema.js";

export type EvidenceNoteErrorCode = "empty" | "invalid-json" | "schema" | "invalid-input";

export class EvidenceNoteError extends Error {
  override readonly name = "EvidenceNoteError";
  readonly code: EvidenceNoteErrorCode;
  /** Index of the offending document within the note, when applicable. */
  readonly documentIndex: number | undefined;
  readonly issues: readonly string[];
  constructor(
    code: EvidenceNoteErrorCode,
    message: string,
    opts: { documentIndex?: number; issues?: string[] } = {},
  ) {
    super(message);
    this.code = code;
    this.documentIndex = opts.documentIndex;
    this.issues = opts.issues ?? [];
  }
}

function issuesOf(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): string[] {
  return error.issues.map((i) => `${i.path.map(String).join(".") || "<root>"}: ${i.message}`);
}

/** Serialize a signed bundle as a note body. Validates first; output is deterministic. */
export function encodeNote(signed: SignedEvidence): string {
  const parsed = SignedEvidence.safeParse(signed);
  if (!parsed.success) {
    const issues = issuesOf(parsed.error);
    throw new EvidenceNoteError("invalid-input", `cannot encode note: ${issues.join("; ")}`, {
      issues,
    });
  }
  // Serialize the caller's fields (not the stripped copy) so the bytes that were
  // signed are exactly the bytes that land in the note.
  const doc = {
    format: EVIDENCE_NOTE_FORMAT,
    changeId: signed.changeId,
    headSha: signed.headSha,
    attestation: signed.attestation,
    items: signed.items,
  };
  // stableStringify sorts keys; rebuild the top level in our fixed order.
  const body = (["format", "changeId", "headSha", "attestation", "items"] as const).map((k) => {
    const v = stableStringify(doc[k], 2).replace(/\n/g, "\n  ");
    return `  ${JSON.stringify(k)}: ${v}`;
  });
  return `{\n${body.join(",\n")}\n}\n`;
}

/**
 * Split note text into its complete top-level JSON object texts. Scans with
 * string/escape awareness; text outside objects (blank lines, stray junk) and an
 * unterminated trailing object are skipped.
 */
export function splitNoteDocuments(text: string): string[] {
  const docs: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c /* \ */) i++;
      else if (c === 0x22 /* " */) inString = false;
      continue;
    }
    if (depth === 0) {
      if (c === 0x7b /* { */) {
        start = i;
        depth = 1;
      }
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) depth++;
    else if (c === 0x7d || c === 0x5d) {
      depth--;
      if (depth === 0) {
        docs.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return docs;
}

/** JSON-parse every complete document in a note, without schema validation. */
export function parseNoteDocuments(text: string): unknown[] {
  return splitNoteDocuments(text).map((doc, index) => {
    try {
      return JSON.parse(doc) as unknown;
    } catch (e) {
      throw new EvidenceNoteError(
        "invalid-json",
        `note document ${index} is not valid JSON: ${(e as Error).message}`,
        {
          documentIndex: index,
        },
      );
    }
  });
}

function validate(doc: unknown, index: number): EvidenceNote {
  const parsed = EvidenceNote.safeParse(doc);
  if (!parsed.success) {
    const issues = issuesOf(parsed.error);
    throw new EvidenceNoteError(
      "schema",
      `note document ${index} is not a ${EVIDENCE_NOTE_FORMAT} note: ${issues.slice(0, 5).join("; ")}`,
      {
        documentIndex: index,
        issues,
      },
    );
  }
  return parsed.data;
}

/** Every document in the note, each validated. Throws {@link EvidenceNoteError}. */
export function decodeNotes(text: string): EvidenceNote[] {
  const docs = parseNoteDocuments(text);
  if (docs.length === 0)
    throw new EvidenceNoteError("empty", "note contains no complete JSON document");
  return docs.map(validate);
}

function parseLast(text: string): { doc: unknown; index: number } {
  const docs = splitNoteDocuments(text);
  const index = docs.length - 1;
  const last = docs[index];
  if (last === undefined)
    throw new EvidenceNoteError("empty", "note contains no complete JSON document");
  try {
    return { doc: JSON.parse(last) as unknown, index };
  } catch (e) {
    throw new EvidenceNoteError(
      "invalid-json",
      `note document ${index} is not valid JSON: ${(e as Error).message}`,
      {
        documentIndex: index,
      },
    );
  }
}

/** The last complete document in the note, validated. Throws {@link EvidenceNoteError}. */
export function decodeNote(text: string): EvidenceNote {
  const { doc, index } = parseLast(text);
  return validate(doc, index);
}

/**
 * The raw (unvalidated) last document. Pass this to `verifyEvidence` when you want
 * the signature checked over exactly what is stored, including any injected fields.
 */
export function lastNoteDocument(text: string): unknown {
  return parseLast(text).doc;
}
