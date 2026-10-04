/**
 * The hermetic E2E server's wrangler config, derived from apps/platform/wrangler.jsonc so a new
 * binding shows up here without anyone remembering to copy it. What differs from production:
 *
 * - main is test/e2e-entry.ts: the production Worker with the integration fakes (Artifacts,
 *   containers, the reviewer model) plus the `/__e2e/seed` route that only exists in that entry;
 * - no containers, zone routes, remote bindings or event triggers (nothing reaches the account);
 * - local vars: the origin, Cloudflare's always-pass Turnstile test keys, no admins, no allowlist.
 *
 * Written next to wrangler.jsonc (gitignored) so every relative path in it still resolves.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** JSONC → JSON: drops // and block comments and trailing commas, leaving strings untouched. */
export function stripJsonc(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (ch === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export interface E2eConfigOptions {
  platformDir: string;
  port: number;
  /** Secrets the env file supplies: wrangler passes only declared ones to the Worker. */
  secretNames: string[];
}

type Json = Record<string, unknown>;

export function writeE2eConfig({ platformDir, port, secretNames }: E2eConfigOptions): string {
  const raw = readFileSync(join(platformDir, "wrangler.jsonc"), "utf8");
  const cfg = JSON.parse(stripJsonc(raw)) as Json;
  cfg.main = "./test/e2e-entry.ts";
  delete cfg.containers;
  delete cfg.routes;
  delete cfg.triggers;
  delete cfg.observability;
  const exportsCfg = (cfg.exports ?? {}) as Record<string, Json>;
  for (const entry of Object.values(exportsCfg)) delete entry.container;
  // Remote-only bindings: the entry's fakes stand in for Artifacts and the model.
  delete cfg.artifacts;
  delete cfg.ai;
  cfg.secrets = { required: secretNames };
  cfg.vars = {
    ...(cfg.vars as Json),
    BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
    TURNSTILE_SITE_KEY: "",
    PLATFORM_ADMINS: "",
    PLATFORM_AUDITORS: "",
    GITHUB_REPO_ALLOWLIST: "",
  };
  cfg.dev = { port, ip: "127.0.0.1" };
  const path = join(platformDir, "wrangler.e2e.json");
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
  return path;
}
