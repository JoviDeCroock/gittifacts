/**
 * keygen: print a fresh Ed25519 signing key pair as JSON.
 *
 *   keygen [--name <label>]
 *
 * stdout is machine-readable JSON; hints go to stderr so `keygen > key.json` stays clean.
 */
import { parseArgs } from "node:util";
import { generateSigningKey } from "../keys.js";
import type { CliIo } from "./run-verify.js";

export async function runKeygen(
  argv: readonly string[],
  io: CliIo,
  now: Date = new Date(),
): Promise<number> {
  let name: string | undefined;
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: { name: { type: "string" }, help: { type: "boolean", short: "h" } },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      io.stderr("Usage: keygen [--name <label>]\n");
      return 0;
    }
    name = values.name;
  } catch (e) {
    io.stderr(`keygen: ${(e as Error).message}\nUsage: keygen [--name <label>]\n`);
    return 2;
  }
  const key = await generateSigningKey();
  const out = {
    alg: "Ed25519",
    keyId: key.keyId,
    publicKey: key.publicKey,
    privateKey: key.privateKey,
    createdAt: now.toISOString(),
    ...(name !== undefined ? { name } : {}),
  };
  io.stdout(`${JSON.stringify(out, null, 2)}\n`);
  const entry = JSON.stringify({
    keys: [{ keyId: key.keyId, publicKey: key.publicKey, ...(name !== undefined ? { name } : {}) }],
  });
  io.stderr(
    [
      "# Keep privateKey secret. For a Cloudflare Worker:",
      "#   wrangler secret put EVIDENCE_SIGNING_KEY        (paste privateKey)",
      "#   wrangler secret put EVIDENCE_SIGNING_PUBLIC_KEY (paste publicKey)",
      "# Publish the public half for verifiers (verify-attestation --keys keys.json):",
      `#   ${entry}`,
      '# When rotating, keep the old entry and give it "notAfter": "<rotation time>".',
      "",
    ].join("\n"),
  );
  return 0;
}
