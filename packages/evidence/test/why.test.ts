import { describe, expect, it } from "vitest";
import {
  decodeWhyNote,
  EvidenceNoteError,
  encodeWhyNote,
  generateSigningKey,
  signDocument,
  verifyDocument,
  WHY_NOTE_FORMAT,
  type WhyNote,
  type WhyRecord,
  whySigningRecord,
} from "../src/index.js";
import { HEAD_SHA } from "./helpers.js";

const LANDED = "3333333333333333333333333333333333333333";

function record(): WhyRecord {
  return {
    format: WHY_NOTE_FORMAT,
    changeId: "chg_1",
    title: "Guard division by zero",
    category: "fix",
    headSha: HEAD_SHA,
    landedSha: LANDED,
    author: { id: "ag_1", kind: "agent", name: "builder-bot" },
    accountable: { id: "usr_ada", kind: "human", name: "Ada" },
    plan: {
      id: "pln_1",
      title: "Division guard",
      intent: "div(x, 0) must throw instead of returning Infinity",
      acceptanceCriteria: ["div(1, 0) throws RangeError"],
      outOfScope: ["other operators"],
      approvedBy: { id: "usr_bo", kind: "human", name: "Bo" },
      approvedAt: "2026-10-10T08:00:00.000Z",
      approvalSignature: "c2lnbmF0dXJl",
    },
    lane: 1,
    laneReasons: [{ code: "signal.public-api", lane: 1, message: "public API changed" }],
    approvals: [
      {
        reviewer: { id: "usr_bo", kind: "human", name: "Bo" },
        headSha: HEAD_SHA,
        at: "2026-10-10T08:05:00.000Z",
        source: "platform",
      },
    ],
    agentTrace: { provider: "claude-code", traceId: "trace-1" },
    evidenceId: "ev_1",
    landedAt: "2026-10-10T08:10:00.000Z",
  };
}

describe("refs/notes/why", () => {
  it("round-trips, reads top-down, and its signature covers everything but the attestation", async () => {
    const key = await generateSigningKey();
    const signer = { privateKey: key.privateKey, publicKey: key.publicKey, name: "gittifacts" };
    const rec = record();
    const sig = await signDocument(rec, signer, { purpose: "gittifacts/document" });
    const note: WhyNote = {
      ...rec,
      attestation: { keyId: sig.keyId, purpose: sig.purpose, signature: sig.signature },
    };
    const text = encodeWhyNote(note);
    expect(text.startsWith(`{\n  "format": "${WHY_NOTE_FORMAT}",\n  "changeId": "chg_1",`)).toBe(
      true,
    );
    expect(text.endsWith("\n}\n")).toBe(true);
    expect(encodeWhyNote(note)).toBe(text);

    const read = decodeWhyNote(`older junk\n\n${text}`);
    expect(read).toEqual(note);
    expect(
      await verifyDocument(whySigningRecord(read), sig, key.publicKey, {
        purpose: "gittifacts/document",
      }),
    ).toMatchObject({ ok: true });
    // Rewriting the intent breaks the signature.
    const forged = { ...read, plan: { ...read.plan!, intent: "something else entirely" } };
    expect(await verifyDocument(whySigningRecord(forged), sig, key.publicKey)).toMatchObject({
      ok: false,
    });
  });

  it("the last complete document wins; empty, malformed and unknown fields are refused", () => {
    const note = (title: string): WhyNote => ({
      ...record(),
      title,
      attestation: { keyId: "k", purpose: "gittifacts/document", signature: "s" },
    });
    const two = `${encodeWhyNote(note("first"))}\n${encodeWhyNote(note("second"))}`;
    expect(decodeWhyNote(two).title).toBe("second");
    expect(() => decodeWhyNote("")).toThrow(EvidenceNoteError);
    expect(() => decodeWhyNote('{"format":"gittifacts.why/v1"}')).toThrow(/not a gittifacts.why/);
    expect(() => encodeWhyNote({ ...note("x"), extra: 1 } as WhyNote)).toThrow(/cannot encode/);
  });
});
