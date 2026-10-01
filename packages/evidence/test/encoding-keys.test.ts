import { describe, expect, it } from "vitest";
import {
  base64urlDecode,
  base64urlEncode,
  bytesEqual,
  ED25519,
  EncodingError,
  generateSigningKey,
  hexEncode,
  importPrivateKey,
  importPublicKey,
  KeyError,
  keyIdFor,
  parseKeySet,
  publicKeyFromPrivateKey,
  resolveKeySet,
  sha256,
  sha256Base64url,
  subtle,
  truncate,
  utf8Decode,
  utf8Encode,
  wellFormed,
} from "../src/index.js";

function hex(s: string): Uint8Array {
  return new Uint8Array((s.match(/../g) ?? []).map((b) => Number.parseInt(b, 16)));
}

// RFC 8032 §7.1, TEST 1.
const RFC8032_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC8032_PUB = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const PKCS8_PREFIX = "302e020100300506032b657004220420";

describe("encoding", () => {
  it("base64url round-trips all lengths and matches RFC 4648 vectors", () => {
    const vectors: [string, string][] = [
      ["", ""],
      ["f", "Zg"],
      ["fo", "Zm8"],
      ["foo", "Zm9v"],
      ["foob", "Zm9vYg"],
      ["fooba", "Zm9vYmE"],
      ["foobar", "Zm9vYmFy"],
    ];
    for (const [plain, enc] of vectors) {
      expect(base64urlEncode(utf8Encode(plain))).toBe(enc);
      expect(utf8Decode(base64urlDecode(enc))).toBe(plain);
    }
    const all = new Uint8Array(256).map((_, i) => i);
    for (let n = 0; n <= all.length; n += 7) {
      const slice = all.slice(0, n);
      expect(base64urlDecode(base64urlEncode(slice))).toEqual(slice);
    }
    expect(base64urlEncode(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
  });

  it("base64url decode is strict", () => {
    expect(() => base64urlDecode("Zg==")).toThrow(EncodingError); // padding
    expect(() => base64urlDecode("Z+8")).toThrow(EncodingError); // standard alphabet
    expect(() => base64urlDecode("Zm9vY")).toThrow(EncodingError); // impossible length
    expect(() => base64urlDecode("Zh")).toThrow(/trailing bits/); // non-canonical "f"
    expect(() => base64urlDecode("Zm9 v")).toThrow(EncodingError);
  });

  it("sha256 matches the FIPS 180-2 'abc' vector", async () => {
    expect(hexEncode(await sha256("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256Base64url(new Uint8Array())).toBe(
      "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
    );
  });

  it("utf8Decode is fatal on malformed input", () => {
    expect(() => utf8Decode(new Uint8Array([0xc3]))).toThrow();
  });

  it("wellFormed and truncate never leave lone surrogates", () => {
    expect(wellFormed("a\ud800b\udc00c😀")).toBe("a�b�c😀");
    const s = `${"x".repeat(9)}😀tail`;
    const t = truncate(s, 11);
    expect(t.length).toBeLessThanOrEqual(11);
    expect(wellFormed(t)).toBe(t);
    expect(truncate("short", 10)).toBe("short");
  });

  it("bytesEqual", () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});

describe("keys", () => {
  it("generates a usable key pair with a 22-char key id", async () => {
    const k = await generateSigningKey();
    expect(base64urlDecode(k.publicKey)).toHaveLength(32);
    expect(base64urlDecode(k.privateKey)).toHaveLength(48);
    expect(k.keyId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await keyIdFor(k.publicKey)).toBe(k.keyId);
    expect(await keyIdFor(base64urlDecode(k.publicKey))).toBe(k.keyId);
    expect(await publicKeyFromPrivateKey(k.privateKey)).toBe(k.publicKey);
    await expect(importPrivateKey(k.privateKey)).resolves.toBeDefined();
    await expect(importPublicKey(k.publicKey)).resolves.toBeDefined();
  });

  it("keyId = base64url(first 16 bytes of SHA-256(raw public key))", async () => {
    const raw = hex(RFC8032_PUB);
    const expected = base64urlEncode((await sha256(raw)).slice(0, 16));
    expect(await keyIdFor(raw)).toBe(expected);
  });

  it("interoperates with RFC 8032 test vector 1", async () => {
    const pkcs8 = base64urlEncode(hex(PKCS8_PREFIX + RFC8032_SEED));
    expect(await publicKeyFromPrivateKey(pkcs8)).toBe(base64urlEncode(hex(RFC8032_PUB)));
    const key = await importPrivateKey(pkcs8);
    const sig = new Uint8Array(await subtle().sign(ED25519, key, new Uint8Array()));
    expect(hexEncode(sig)).toBe(
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    );
  });

  it("rejects malformed keys with KeyError", async () => {
    await expect(importPublicKey("abc")).rejects.toBeInstanceOf(KeyError);
    await expect(importPublicKey(base64urlEncode(new Uint8Array(31)))).rejects.toThrow(/32 bytes/);
    await expect(importPrivateKey("not base64!")).rejects.toBeInstanceOf(KeyError);
    await expect(importPrivateKey(base64urlEncode(new Uint8Array(48)))).rejects.toBeInstanceOf(
      KeyError,
    );
    await expect(keyIdFor(new Uint8Array(10))).rejects.toBeInstanceOf(KeyError);
  });

  it("parses key sets as arrays or {keys}", async () => {
    const k = await generateSigningKey();
    expect(parseKeySet([{ publicKey: k.publicKey }])).toEqual([{ publicKey: k.publicKey }]);
    expect(
      parseKeySet({
        keys: [{ keyId: k.keyId, publicKey: k.publicKey, notAfter: "2027-01-01T00:00:00Z" }],
      }),
    ).toHaveLength(1);
    expect(() => parseKeySet({ keys: [{ publicKey: 1 }] })).toThrow(KeyError);
    expect(() => parseKeySet([{ publicKey: k.publicKey, notAfter: "tomorrow" }])).toThrow(KeyError);
  });

  it("resolveKeySet drops entries whose stated keyId does not match", async () => {
    const a = await generateSigningKey();
    const b = await generateSigningKey();
    const r = await resolveKeySet([
      { keyId: b.keyId, publicKey: a.publicKey },
      { publicKey: "garbage" },
      { publicKey: b.publicKey, name: "b" },
    ]);
    expect(r.keys).toEqual([{ keyId: b.keyId, publicKey: b.publicKey, name: "b" }]);
    expect(r.rejected).toHaveLength(2);
  });
});
