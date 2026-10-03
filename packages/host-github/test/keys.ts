/**
 * A throwaway RSA key in GitHub's PEM format (PKCS#1), generated per test run: no key material
 * is ever committed.
 */
import { generateKeyPairSync } from "node:crypto";

export const TEST_APP_PEM: string = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
