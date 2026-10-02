/**
 * Loads generate/platform-entry.ts: esbuild bundles it for Node with `cloudflare:*` imports
 * replaced by inert classes (only module evaluation happens: route definitions and constants,
 * never a request), writes the bundle to a temp file and imports it. Cached per process.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const STUB = `
export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class RpcTarget {}
export class NonRetryableError extends Error {}
export const env = {};
`;

export interface OpenApiOperation {
  tags?: string[];
  summary?: string;
  description?: string;
  security?: Record<string, string[]>[];
  parameters?: {
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: unknown;
  }[];
  requestBody?: { content?: Record<string, { schema?: unknown }> };
  responses?: Record<
    string,
    { description?: string; content?: Record<string, { schema?: unknown }> }
  >;
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
}

export interface PlatformModule {
  createApp(): { getOpenAPI31Document(config: unknown): OpenApiDocument };
  OPENAPI_PATH: string;
  DEFAULT_UNCLAIMED_LIMITS: Record<string, unknown>;
  WORKSPACE_LIMITS: Record<"claimed" | "unclaimed", Record<string, unknown>>;
  WebhookEvent: { options: readonly string[] };
  DEFAULT_EVENTS: readonly string[];
  INTEGRATION_SCOPES: readonly string[];
  DEPLOY_PLATFORM_SCOPES: readonly string[];
  SCOPE_WORDS: Record<string, { title: string; description: string }>;
  NEVER_WORDS: readonly string[];
  BACKOFF_SECONDS: readonly number[];
  MAX_ATTEMPTS: number;
  USER_AGENT: string;
  INTEGRATION_REFRESH_TTL_DAYS: number;
  ACCESS_TOKEN_TTL_SEC: number;
  CODE_TTL_MS: number;
  DEFAULT_SESSION_DAYS: number;
  SESSION_DAY_CHOICES: readonly number[];
  REQUEST_TTL_MS: number;
  DEVICE_CODE_TTL: string;
  DEVICE_POLL_INTERVAL: string;
  OAUTH_PATHS: Record<string, string>;
  DEFAULT_SESSION_SCOPES: readonly string[];
  DELEGABLE_SCOPES: readonly string[];
  NEVER_DELEGATED: readonly string[];
  CLI_CLIENT_ID: string;
  FRONT_DOOR_PATHS: Record<string, string>;
  discoveryDocuments(
    urls: { origin: string; mcpUrl: string; openapiUrl: string; issuer: string },
    version: string,
  ): { path: string; contentType: string; body: unknown }[];
}

let cached: Promise<PlatformModule> | null = null;

export function loadPlatform(): Promise<PlatformModule> {
  cached ??= (async () => {
    const result = await build({
      entryPoints: [join(import.meta.dirname, "..", "platform-entry.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      write: false,
      logLevel: "error",
      plugins: [
        {
          name: "cloudflare-stubs",
          setup(b) {
            b.onResolve({ filter: /^cloudflare:/ }, (a) => ({
              path: a.path,
              namespace: "cf-stub",
            }));
            b.onLoad({ filter: /.*/, namespace: "cf-stub" }, () => ({
              contents: STUB,
              loader: "js",
            }));
          },
        },
      ],
    });
    const dir = mkdtempSync(join(tmpdir(), "gittifacts-docs-"));
    const file = join(dir, "platform.mjs");
    writeFileSync(file, result.outputFiles[0]?.text ?? "");
    try {
      return (await import(pathToFileURL(file).href)) as PlatformModule;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
  return cached;
}

/** The platform's OpenAPI document, exactly as `GET /api/v1/openapi.json` would serve it. */
export async function openApiDocument(): Promise<OpenApiDocument> {
  const p = await loadPlatform();
  return p.createApp().getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "gittifacts", version: "1.0.0" },
  });
}
