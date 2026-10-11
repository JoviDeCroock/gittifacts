import { generateKeyPairSync, webcrypto } from "node:crypto";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

function b64url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64url");
}

/** A throwaway platform signing key per test run, in the PLATFORM_SIGNING_KEY secret format. */
async function testSigningKey(): Promise<string> {
  const pair = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const privateKey = b64url(await webcrypto.subtle.exportKey("pkcs8", pair.privateKey));
  const publicKey = b64url(await webcrypto.subtle.exportKey("raw", pair.publicKey));
  return JSON.stringify({ privateKey, publicKey, name: "test" });
}

/** A throwaway GitHub App private key per run (PKCS#1 PEM, the format GitHub hands out). */
function testGithubAppPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // The production module with fakes for Artifacts, containers and the model (see the file).
      main: "./test/worker-entry.ts",
      // Never reach the real account from tests (AI, Artifacts, Flagship, Browser stay unbound/local).
      remoteBindings: false,
      miniflare: {
        // The auth limits (src/security/auth-limits.ts) are real bindings here too, but every
        // test signs up from the same (absent) client IP: raise them so only the tests that
        // inject a limiter see a 429 (test/http-security.test.ts).
        ratelimits: {
          AUTH_LIMITER: { namespace_id: "4304", simple: { limit: 100_000, period: 60 } },
          AUTH_EMAIL_LIMITER: { namespace_id: "4305", simple: { limit: 100_000, period: 60 } },
          OAUTH_LIMITER: { namespace_id: "4306", simple: { limit: 100_000, period: 60 } },
        },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
          PLATFORM_SIGNING_KEY: await testSigningKey(),
          BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123456789",
          BETTER_AUTH_URL: "http://localhost",
          GITHUB_CLIENT_ID: "",
          GITHUB_CLIENT_SECRET: "",
          ISSUES_WEBHOOK_SECRET: "test-issues-webhook-secret",
          // GitHub mode's Reader App (src/github/app-config.ts); tests blank any of these to
          // exercise "not configured" (test/github-helpers.ts).
          GITHUB_APP_ID: "4242",
          GITHUB_APP_SLUG: "gittifacts-test",
          GITHUB_APP_CLIENT_ID: "Iv23testclient",
          GITHUB_APP_CLIENT_SECRET: "cs-test-secret",
          GITHUB_APP_WEBHOOK_SECRET: "whsec-test-0123456789",
          GITHUB_APP_PRIVATE_KEY: testGithubAppPem(),
          // wrangler.jsonc limits production to its allowlist; tests cover every repo unless they set one.
          GITHUB_REPO_ALLOWLIST: "",
          CF_API_TOKEN: "",
          // wrangler.jsonc carries the production Turnstile site key and admins: tests use
          // Cloudflare's test keys (an empty var falls back to them, opted in with
          // TURNSTILE_TEST_KEYS; without it a missing secret fails closed) and no platform admins.
          TURNSTILE_SITE_KEY: "",
          TURNSTILE_TEST_KEYS: "1",
          PLATFORM_ADMINS: "",
        },
      },
    }),
  ],
  test: {
    name: "platform",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
}));
