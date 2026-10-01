import { beforeAll, describe, expect, it } from "vitest";
import {
  base64urlDecode,
  base64urlEncode,
  canonicalBytes,
  EvidenceValidationError,
  evidenceSigningBytes,
  generateSigningKey,
  type SignedEvidence,
  type Signer,
  SignerKeyMismatchError,
  type SigningKeyPair,
  sha256Base64url,
  signDocument,
  signEvidence,
  verifyDocument,
  verifyEvidence,
} from "../src/index.js";
import { HEAD_SHA, jsonClone, samplePayload } from "./helpers.js";

let k1: SigningKeyPair;
let k2: SigningKeyPair;
let signer: Signer;
const NOW = new Date("2026-10-01T12:00:00.000Z");

beforeAll(async () => {
  k1 = await generateSigningKey();
  k2 = await generateSigningKey();
  signer = { privateKey: k1.privateKey, publicKey: k1.publicKey, name: "gittifacts-ci" };
});

async function signed(): Promise<SignedEvidence> {
  return signEvidence(samplePayload(), signer, { now: NOW });
}

describe("signEvidence / verifyEvidence", () => {
  it("round-trips, including through JSON", async () => {
    const s = await signed();
    expect(s.attestation).toMatchObject({
      v: 1,
      alg: "Ed25519",
      keyId: k1.keyId,
      signer: "gittifacts-ci",
      signedAt: "2026-10-01T12:00:00.000Z",
    });
    expect(base64urlDecode(s.attestation.signature)).toHaveLength(64);
    const r = await verifyEvidence(s, k1.publicKey);
    expect(r).toMatchObject({ ok: true, keyId: k1.keyId });
    expect(await verifyEvidence(jsonClone(s), [{ publicKey: k1.publicKey }])).toMatchObject({
      ok: true,
    });
    if (r.ok) expect(r.evidence).toEqual(s);
  });

  it("signs exactly canonical {changeId, headSha, items}", async () => {
    const s = await signed();
    const bytes = canonicalBytes({ changeId: s.changeId, headSha: s.headSha, items: s.items });
    expect(evidenceSigningBytes(samplePayload())).toEqual(bytes);
    expect(s.attestation.payloadDigest).toBe(await sha256Base64url(bytes));
  });

  it("strips unknown fields before signing", async () => {
    const payload = samplePayload() as unknown as Record<string, unknown>;
    payload.extra = "dropped";
    const s = await signEvidence(payload as never, signer, { now: NOW });
    expect(s).not.toHaveProperty("extra");
    expect(await verifyEvidence(s, k1.publicKey)).toMatchObject({ ok: true });
  });

  it("rejects invalid payloads with a typed error", async () => {
    await expect(signEvidence(samplePayload({ headSha: "HEAD" }), signer)).rejects.toBeInstanceOf(
      EvidenceValidationError,
    );
    await expect(
      signEvidence({ ...samplePayload(), items: [{ kind: "nope" }] } as never, signer),
    ).rejects.toThrow(/items/);
  });

  it("refuses a signer whose public key does not match the private key", async () => {
    await expect(
      signEvidence(samplePayload(), { ...signer, publicKey: k2.publicKey }),
    ).rejects.toBeInstanceOf(SignerKeyMismatchError);
  });

  describe("tamper detection", () => {
    type Mut = (s: SignedEvidence & Record<string, unknown>) => void;
    const cases: [string, Mut, string][] = [
      [
        "item field",
        (s) => {
          const item = s.items[1];
          if (item?.kind === "coverage") item.ratio = 1;
        },
        "digest-mismatch",
      ],
      ["item removed", (s) => void s.items.pop(), "digest-mismatch"],
      ["items reordered", (s) => void s.items.reverse(), "digest-mismatch"],
      [
        "injected unknown item field",
        (s) => {
          (s.items[0] as unknown as Record<string, unknown>).approvedBy = "mallory";
        },
        "digest-mismatch",
      ],
      [
        "headSha",
        (s) => {
          s.headSha = "3".repeat(40);
        },
        "digest-mismatch",
      ],
      [
        "changeId",
        (s) => {
          s.changeId = "chg_other";
        },
        "digest-mismatch",
      ],
      [
        "attestation.keyId",
        (s) => {
          s.attestation.keyId = "A".repeat(22);
        },
        "unknown-key",
      ],
      [
        "attestation.signature (bit flip)",
        (s) => {
          const sig = base64urlDecode(s.attestation.signature);
          sig[5] = (sig[5] ?? 0) ^ 1;
          s.attestation.signature = base64urlEncode(sig);
        },
        "bad-signature",
      ],
      [
        "attestation.signature (truncated)",
        (s) => {
          s.attestation.signature = s.attestation.signature.slice(0, 40);
        },
        "bad-signature",
      ],
      [
        "attestation.payloadDigest",
        (s) => {
          s.attestation.payloadDigest = "x";
        },
        "digest-mismatch",
      ],
      [
        "attestation.alg",
        (s) => {
          (s.attestation as Record<string, unknown>).alg = "RS256";
        },
        "schema",
      ],
      [
        "non-JSON value",
        (s) => {
          (s as Record<string, unknown>).headSha = 5;
        },
        "schema",
      ],
    ];
    it.each(cases)("detects a modified %s", async (_name, mutate, reason) => {
      const s = jsonClone(await signed()) as SignedEvidence & Record<string, unknown>;
      mutate(s);
      const r = await verifyEvidence(s, k1.publicKey);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe(reason);
        expect(r.detail.length).toBeGreaterThan(0);
      }
    });

    it("detects content + digest both rewritten (only the signature catches it)", async () => {
      const s = jsonClone(await signed());
      s.changeId = "chg_forged";
      s.attestation.payloadDigest = await sha256Base64url(
        canonicalBytes({ changeId: s.changeId, headSha: s.headSha, items: s.items }),
      );
      expect(await verifyEvidence(s, k1.publicKey)).toMatchObject({
        ok: false,
        reason: "bad-signature",
      });
    });

    it("accepts changes to unsigned metadata (signer label) — documented limitation", async () => {
      const s = jsonClone(await signed());
      s.attestation.signer = "someone-else";
      expect(await verifyEvidence(s, k1.publicKey)).toMatchObject({ ok: true });
    });
  });

  it("fails with unknown-key under the wrong key", async () => {
    const s = await signed();
    expect(await verifyEvidence(s, k2.publicKey)).toMatchObject({
      ok: false,
      reason: "unknown-key",
    });
  });

  it("fails with bad-signature when a key set lies about a key id", async () => {
    // An attacker re-labels their own signature with the trusted key id.
    const forger = { privateKey: k2.privateKey, publicKey: k2.publicKey, name: "x" };
    const forged = await signEvidence(samplePayload(), forger, { now: NOW });
    forged.attestation.keyId = k1.keyId;
    expect(await verifyEvidence(forged, k1.publicKey)).toMatchObject({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("never throws on garbage input", async () => {
    for (const junk of [null, 1, "x", [], {}, { attestation: {} }]) {
      expect(await verifyEvidence(junk, k1.publicKey)).toMatchObject({
        ok: false,
        reason: "schema",
      });
    }
    expect(await verifyEvidence(await signed(), "not-a-key")).toMatchObject({
      ok: false,
      reason: "unknown-key",
    });
  });

  describe("key rotation", () => {
    it("verifies old and new signatures against a key set", async () => {
      const old = await signed();
      const fresh = await signEvidence(
        samplePayload(),
        { privateKey: k2.privateKey, publicKey: k2.publicKey, name: "ci" },
        { now: new Date("2027-02-01T00:00:00Z") },
      );
      const keys = [
        { publicKey: k1.publicKey, notAfter: "2027-01-01T00:00:00Z", name: "2026" },
        { publicKey: k2.publicKey, name: "2027" },
      ];
      expect(await verifyEvidence(old, keys)).toMatchObject({
        ok: true,
        keyId: k1.keyId,
        keyName: "2026",
      });
      expect(await verifyEvidence(fresh, keys)).toMatchObject({
        ok: true,
        keyId: k2.keyId,
        keyName: "2027",
      });
    });

    it("rejects signatures made after a key's notAfter", async () => {
      const late = await signEvidence(samplePayload(), signer, {
        now: new Date("2027-01-01T00:00:01Z"),
      });
      const keys = [{ publicKey: k1.publicKey, notAfter: "2027-01-01T00:00:00Z" }];
      const r = await verifyEvidence(late, keys);
      expect(r).toMatchObject({ ok: false, reason: "expired-key" });
      // Exactly at the boundary is still valid.
      const edge = await signEvidence(samplePayload(), signer, {
        now: new Date("2027-01-01T00:00:00Z"),
      });
      expect(await verifyEvidence(edge, keys)).toMatchObject({ ok: true });
    });

    it("ignores key-set entries whose stated keyId does not match their key", async () => {
      const s = await signed();
      const r = await verifyEvidence(s, [{ keyId: k1.keyId, publicKey: k2.publicKey }]);
      expect(r).toMatchObject({ ok: false, reason: "unknown-key" });
    });
  });

  it("uses the current time when no clock is given", async () => {
    const before = Date.now();
    const s = await signEvidence(samplePayload(), signer);
    expect(Date.parse(s.attestation.signedAt)).toBeGreaterThanOrEqual(before - 1);
    expect(s.headSha).toBe(HEAD_SHA);
  });
});

describe("signDocument / verifyDocument", () => {
  const plan = { planId: "pln_1", intent: "Add division-by-zero guard", approvedBy: "usr_alice" };

  it("round-trips with a purpose", async () => {
    const sig = await signDocument(plan, signer, { purpose: "plan-approval", now: NOW });
    expect(sig.purpose).toBe("plan-approval");
    expect(
      await verifyDocument(plan, sig, k1.publicKey, { purpose: "plan-approval" }),
    ).toMatchObject({
      ok: true,
      keyId: k1.keyId,
    });
    // Key order of the document does not matter.
    const reordered = { approvedBy: "usr_alice", intent: plan.intent, planId: "pln_1" };
    expect(
      await verifyDocument(reordered, jsonClone(sig), [{ publicKey: k1.publicKey }]),
    ).toMatchObject({
      ok: true,
    });
  });

  it("detects a modified document", async () => {
    const sig = await signDocument(plan, signer);
    expect(sig.purpose).toBe("document");
    expect(
      await verifyDocument({ ...plan, approvedBy: "usr_mallory" }, sig, k1.publicKey),
    ).toMatchObject({
      ok: false,
      reason: "digest-mismatch",
    });
  });

  it("is domain-separated by purpose", async () => {
    const sig = await signDocument(plan, signer, { purpose: "audit-log" });
    expect(
      await verifyDocument(plan, sig, k1.publicKey, { purpose: "plan-approval" }),
    ).toMatchObject({
      ok: false,
      reason: "digest-mismatch",
    });
    const relabeled = { ...sig, purpose: "plan-approval" };
    expect(await verifyDocument(plan, relabeled, k1.publicKey)).toMatchObject({
      ok: false,
      reason: "digest-mismatch",
    });
  });

  it("cannot be confused with an evidence attestation", async () => {
    const payload = samplePayload();
    const docSig = await signDocument(payload, signer);
    const asEvidence = { ...payload, attestation: { ...docSig, purpose: undefined } };
    expect(await verifyEvidence(jsonClone(asEvidence), k1.publicKey)).toMatchObject({ ok: false });
  });

  it("reports non-canonicalizable documents as schema failures", async () => {
    const sig = await signDocument(plan, signer);
    expect(await verifyDocument({ x: Number.NaN }, sig, k1.publicKey)).toMatchObject({
      ok: false,
      reason: "schema",
    });
    await expect(signDocument({ x: () => 1 }, signer)).rejects.toThrow(/function/);
  });
});
