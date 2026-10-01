import { beforeAll, describe, expect, it } from "vitest";
import {
  decodeNote,
  decodeNotes,
  EVIDENCE_NOTE_FORMAT,
  EvidenceNoteError,
  encodeNote,
  generateSigningKey,
  lastNoteDocument,
  type SignedEvidence,
  type SigningKeyPair,
  signEvidence,
  splitNoteDocuments,
  verifyEvidence,
} from "../src/index.js";
import { samplePayload } from "./helpers.js";

let key: SigningKeyPair;
let first: SignedEvidence;
let second: SignedEvidence;

beforeAll(async () => {
  key = await generateSigningKey();
  const signer = { privateKey: key.privateKey, publicKey: key.publicKey, name: "ci" };
  first = await signEvidence(samplePayload(), signer, { now: new Date("2026-10-01T00:00:00Z") });
  second = await signEvidence(samplePayload({ items: [] }), signer, {
    now: new Date("2026-10-02T00:00:00Z"),
  });
});

describe("encodeNote", () => {
  it("is stable pretty JSON with the format marker first and a trailing newline", () => {
    const text = encodeNote(first);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.startsWith(`{\n  "format": "${EVIDENCE_NOTE_FORMAT}",\n  "changeId": `)).toBe(true);
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      "format",
      "changeId",
      "headSha",
      "attestation",
      "items",
    ]);
    // Deterministic regardless of the caller's key order.
    const shuffled = JSON.parse(
      JSON.stringify({
        items: first.items,
        attestation: first.attestation,
        headSha: first.headSha,
        changeId: first.changeId,
      }),
    ) as SignedEvidence;
    expect(encodeNote(shuffled)).toBe(text);
    expect(encodeNote(first)).toBe(text);
  });

  it("produces 2-space indented nested JSON", () => {
    const text = encodeNote(first);
    expect(text).toContain('\n  "attestation": {\n    "alg": "Ed25519",');
    expect(text).toContain('\n  "items": [\n    {\n');
  });

  it("rejects invalid input with a typed error", () => {
    expect(() => encodeNote({ ...first, headSha: "nope" })).toThrow(EvidenceNoteError);
  });
});

describe("decodeNote / decodeNotes", () => {
  it("round-trips and still verifies", async () => {
    const note = decodeNote(encodeNote(first));
    expect(note.format).toBe(EVIDENCE_NOTE_FORMAT);
    expect(note.changeId).toBe(first.changeId);
    expect(note.items).toEqual(first.items);
    expect(await verifyEvidence(note, key.publicKey)).toMatchObject({ ok: true });
  });

  it("takes the LAST complete document of an appended note", async () => {
    // `git notes append` separates entries with a blank line.
    const text = `${encodeNote(first)}\n${encodeNote(second)}`;
    expect(splitNoteDocuments(text)).toHaveLength(2);
    const last = decodeNote(text);
    expect(last.items).toEqual([]);
    expect(decodeNotes(text).map((n) => n.attestation.signedAt)).toEqual([
      first.attestation.signedAt,
      second.attestation.signedAt,
    ]);
    expect(await verifyEvidence(lastNoteDocument(text), key.publicKey)).toMatchObject({ ok: true });
  });

  it("handles compact, back-to-back documents and braces inside strings", () => {
    const a = JSON.stringify({ ...first, format: EVIDENCE_NOTE_FORMAT });
    const tricky = { ...second, format: EVIDENCE_NOTE_FORMAT, changeId: 'chg_{"}\\{' };
    const text = a + JSON.stringify(tricky);
    const docs = decodeNotes(text);
    expect(docs).toHaveLength(2);
    expect(docs[1]?.changeId).toBe('chg_{"}\\{');
  });

  it("ignores an incomplete trailing document", () => {
    const full = encodeNote(first);
    const text = `${full}\n${encodeNote(second).slice(0, 120)}`;
    expect(decodeNote(text).attestation.signedAt).toBe(first.attestation.signedAt);
    expect(decodeNotes(text)).toHaveLength(1);
  });

  it("tolerates CRLF line endings", () => {
    const text = encodeNote(first).replace(/\n/g, "\r\n");
    expect(decodeNote(text).changeId).toBe(first.changeId);
  });

  it("throws typed errors", () => {
    const code = (fn: () => unknown): string | undefined => {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(EvidenceNoteError);
        return (e as EvidenceNoteError).code;
      }
      return undefined;
    };
    expect(code(() => decodeNote(""))).toBe("empty");
    expect(code(() => decodeNote("hello world\n"))).toBe("empty");
    expect(code(() => decodeNote("{ not json }"))).toBe("invalid-json");
    expect(code(() => decodeNote('{"format":"other/v1"}'))).toBe("schema");
    const withoutFormat = JSON.stringify(first);
    expect(code(() => decodeNote(withoutFormat))).toBe("schema");
    // decodeNotes validates every document; decodeNote only the last.
    const text = `{"junk":true}\n\n${encodeNote(first)}`;
    expect(decodeNote(text).changeId).toBe(first.changeId);
    expect(code(() => decodeNotes(text))).toBe("schema");
  });
});
