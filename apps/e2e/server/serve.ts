/**
 * Serves the real platform Worker locally for the pre-deploy browser E2E (Playwright's webServer):
 * `wrangler dev --local` on the e2e config (./config.ts), a fresh persisted state directory, D1
 * migrations applied, throwaway secrets. Needs the built assets (web, docs, CLI tarball,
 * templates), the same ones the deploy builds: `pnpm --filter @app/e2e prepare-assets`.
 *
 *   pnpm --filter @app/e2e serve            # http://127.0.0.1:8799, Ctrl-C to stop
 *
 * Nothing here reaches the Cloudflare account: no remote bindings, no containers.
 */
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, webcrypto } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeE2eConfig } from "./config.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const PLATFORM = join(ROOT, "apps/platform");
export const E2E_PORT = Number(process.env.E2E_PORT ?? 8799);
/** The seed route's shared secret; the specs read the same variable (lib/seed.ts). */
export const SEED_TOKEN = process.env.E2E_SEED_TOKEN ?? "e2e-local-seed-token";
const GITHUB_WEBHOOK_SECRET = "e2e-github-webhook-secret";

async function signingKey(): Promise<string> {
  const pair = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64url");
  return JSON.stringify({
    privateKey: b64(await webcrypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: b64(await webcrypto.subtle.exportKey("raw", pair.publicKey)),
    name: "e2e",
  });
}

/** dotenv: single quotes keep the value verbatim (JSON, multi-line PEM); none of ours has a '. */
function envLine(key: string, value: string): string {
  if (value.includes("'")) throw new Error(`${key} must not contain a single quote`);
  return `${key}='${value}'`;
}

async function main(): Promise<void> {
  if (!existsSync(join(ROOT, "packages/web/dist/index.html"))) {
    console.error("packages/web/dist is missing: run `pnpm --filter @app/e2e prepare-assets` first");
    process.exit(2);
  }
  // E2E_STATE_DIR: a state directory of its own, so two gate servers on one machine (E2E_PORT)
  // don't wipe each other's database.
  const state = process.env.E2E_STATE_DIR ?? join(PLATFORM, ".wrangler/e2e-state");
  // Every run starts from an empty database: tests make their own data (unique per test).
  rmSync(state, { recursive: true, force: true });
  mkdirSync(state, { recursive: true });
  const envFile = join(PLATFORM, ".dev.vars.e2e");
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString();
  const secrets: Array<[string, string]> = [
    ["PLATFORM_SIGNING_KEY", await signingKey()],
    ["BETTER_AUTH_SECRET", randomBytes(32).toString("hex")],
    ["ISSUES_WEBHOOK_SECRET", randomBytes(16).toString("hex")],
    // The GitHub webhook signature check needs a secret to reject bad signatures against.
    ["GITHUB_APP_WEBHOOK_SECRET", GITHUB_WEBHOOK_SECRET],
    ["GITHUB_APP_CLIENT_SECRET", "e2e-client-secret"],
    ["GITHUB_APP_PRIVATE_KEY", pem],
    ["E2E_SEED_TOKEN", SEED_TOKEN],
  ];
  writeFileSync(envFile, `${secrets.map(([k, v]) => envLine(k, v)).join("\n")}\n`);
  const config = writeE2eConfig({
    platformDir: PLATFORM,
    port: E2E_PORT,
    secretNames: secrets.map(([k]) => k),
  });
  const wrangler = (args: string[], opts: { inherit?: boolean } = {}) =>
    [process.execPath, [join(ROOT, "node_modules/wrangler/bin/wrangler.js"), ...args], opts] as const;

  const [node, migrateArgs] = wrangler([
    "d1", "migrations", "apply", "DB", "--local", "--config", config, "--persist-to", state,
  ]);
  const migrated = spawnSync(node, migrateArgs, {
    cwd: PLATFORM,
    stdio: "inherit",
    env: { ...process.env, CI: "1" },
  });
  if (migrated.status !== 0) process.exit(migrated.status ?? 1);

  const [, devArgs] = wrangler([
    "dev", "--local", "--config", config, "--persist-to", state, "--env-file", envFile,
    "--port", String(E2E_PORT), "--ip", "127.0.0.1", "--inspector-port", "0",
    "--show-interactive-dev-session=false", "--log-level", "warn",
  ]);
  const child = spawn(node, devArgs, {
    cwd: PLATFORM,
    stdio: "inherit",
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => process.exit(code ?? 0));
}

await main();
