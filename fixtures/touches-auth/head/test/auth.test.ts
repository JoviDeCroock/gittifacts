import { describe, expect, it } from "vitest";
import { signToken, verifyToken } from "../src/index.js";

const SECRET = "fixture-secret-0123456789";
const NOW = 1_700_000_000;

const encoder = new TextEncoder();

/** Signs an arbitrary payload exactly like the library does, to probe claim validation. */
async function signRaw(payloadJson: string): Promise<string> {
  const base64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const payload = base64url(encoder.encode(payloadJson));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return `${payload}.${base64url(signature)}`;
}

describe("signToken / verifyToken", () => {
  it("round-trips the claims of a valid token", async () => {
    const token = await signToken({ sub: "user_42", exp: NOW + 60 }, SECRET);
    await expect(verifyToken(token, SECRET, NOW)).resolves.toEqual({ sub: "user_42", exp: NOW + 60 });
  });

  it("produces a two-part base64url token", async () => {
    const token = await signToken({ sub: "user_42", exp: NOW }, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("is deterministic for the same claims and secret", async () => {
    const claims = { sub: "user_42", exp: NOW + 3600 };
    expect(await signToken(claims, SECRET)).toBe(await signToken(claims, SECRET));
  });

  it("rejects an expired token", async () => {
    const token = await signToken({ sub: "user_42", exp: NOW - 1 }, SECRET);
    await expect(verifyToken(token, SECRET, NOW)).resolves.toBeNull();
  });

  it("rejects a token at its exact expiry second", async () => {
    const token = await signToken({ sub: "user_42", exp: NOW }, SECRET);
    await expect(verifyToken(token, SECRET, NOW)).resolves.toBeNull();
  });

  it("accepts a token up to the second before it expires", async () => {
    const token = await signToken({ sub: "user_42", exp: NOW }, SECRET);
    await expect(verifyToken(token, SECRET, NOW - 1)).resolves.toEqual({ sub: "user_42", exp: NOW });
  });

  it("rejects a token signed with another secret", async () => {
    const token = await signToken({ sub: "user_42", exp: NOW + 60 }, "another-secret-0123456789");
    await expect(verifyToken(token, SECRET, NOW)).resolves.toBeNull();
  });

  it("rejects a token whose payload was swapped", async () => {
    const mine = await signToken({ sub: "user_42", exp: NOW + 60 }, SECRET);
    const theirs = await signToken({ sub: "admin", exp: NOW + 60 }, SECRET);
    const forged = `${theirs.split(".")[0]}.${mine.split(".")[1]}`;
    await expect(verifyToken(forged, SECRET, NOW)).resolves.toBeNull();
  });

  it("rejects malformed tokens", async () => {
    const valid = await signToken({ sub: "user_42", exp: NOW + 60 }, SECRET);
    for (const token of ["", "abc", `${valid}.extra`, "!!!.???", `${valid.split(".")[0]}.`, "a.b"]) {
      await expect(verifyToken(token, SECRET, NOW)).resolves.toBeNull();
    }
  });

  it("rejects correctly signed payloads that are not valid claims", async () => {
    for (const payload of ["not json", "null", "[1]", '{"sub":"","exp":1}', '{"sub":"x","exp":1.5}', '{"sub":"x"}']) {
      await expect(verifyToken(await signRaw(payload), SECRET, 0)).resolves.toBeNull();
    }
    await expect(verifyToken(await signRaw('{"sub":"x","exp":5}'), SECRET, 0)).resolves.toEqual({
      sub: "x",
      exp: 5,
    });
  });

  it("refuses secrets shorter than 16 characters", async () => {
    const token = await signToken({ sub: "user_42", exp: NOW + 60 }, SECRET);
    await expect(signToken({ sub: "user_42", exp: NOW }, "too-short")).rejects.toThrow(RangeError);
    await expect(verifyToken(token, "too-short", NOW)).rejects.toThrow(RangeError);
  });

  it("refuses to sign invalid claims", async () => {
    await expect(signToken({ sub: "", exp: NOW }, SECRET)).rejects.toThrow("sub must not be empty");
    await expect(signToken({ sub: "user_42", exp: NOW + 0.5 }, SECRET)).rejects.toThrow(
      "exp must be an integer",
    );
  });

  it("checks expiry against the current time by default", async () => {
    const future = await signToken({ sub: "user_42", exp: 4_102_444_800 }, SECRET);
    const past = await signToken({ sub: "user_42", exp: 946_684_800 }, SECRET);
    await expect(verifyToken(future, SECRET)).resolves.not.toBeNull();
    await expect(verifyToken(past, SECRET)).resolves.toBeNull();
  });
});
