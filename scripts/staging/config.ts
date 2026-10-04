/**
 * The staging Worker's wrangler config (docs/testing.md, "Staging"), derived from
 * apps/platform/wrangler.jsonc so staging never drifts from production's bindings. Written next to
 * it as wrangler.staging.json (gitignored).
 *
 *   pnpm tsx scripts/staging/config.ts [--d1-id <uuid>]   # prints the path (default: STAGING.d1Id)
 *
 * Differences from production: its own name, D1, R2 bucket, queues, Artifacts namespace,
 * rate-limit namespaces and metrics dataset; previews on `*-pvs.resynapse.dev` (production:
 * `*-pv.resynapse.dev`); GitHub mode and platform admins off; the Artifacts push event filtered to the
 * staging namespace.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { stripJsonc } from "../../apps/e2e/server/config.js";

export const STAGING = {
  name: "gittifacts-staging",
  url: "https://gittifacts-staging.decroockjovi.workers.dev",
  d1: "gittifacts-staging",
  /** Created by scripts/staging/setup.sh on 2026-10-04 (not a secret). */
  d1Id: "860fe658-cc60-45d0-9dbe-adf80e65207b",
  /**
   * Previews on the same zone as production, a disjoint first-level pattern (`p-…-pvs.resynapse.dev`,
   * covered by Universal SSL; production owns `*-pv.resynapse.dev`).
   */
  previewSuffix: "-pvs.resynapse.dev",
  zone: "resynapse.dev",
  bucket: "gittifacts-staging-blobs",
  artifactsNamespace: "gittifacts-staging-eu",
  queues: {
    "gittifacts-webhooks": "gittifacts-staging-webhooks",
    "gittifacts-webhooks-dlq": "gittifacts-staging-webhooks-dlq",
    "gittifacts-github-events": "gittifacts-staging-github-events",
    "gittifacts-github-events-dlq": "gittifacts-staging-github-events-dlq",
  } as Record<string, string>,
  /** Production uses 4301–4303; staging counters must not share them. */
  rateLimitOffset: 100,
  metricsDataset: "gittifacts_staging_metrics",
} as const;

type Json = Record<string, unknown>;

export function stagingConfig(prod: Json, d1Id: string): Json {
  const cfg = structuredClone(prod);
  cfg.name = STAGING.name;
  cfg.routes = [{ pattern: `*${STAGING.previewSuffix}/*`, zone_name: STAGING.zone }];
  cfg.workers_dev = true;
  cfg.vars = {
    ...(cfg.vars as Json),
    ARTIFACTS_NAMESPACE: STAGING.artifactsNamespace,
    PREVIEW_HOST_SUFFIX: STAGING.previewSuffix,
    BETTER_AUTH_URL: STAGING.url,
    METRICS_DATASET: STAGING.metricsDataset,
    PLATFORM_ADMINS: "",
    PLATFORM_AUDITORS: "",
    // GitHub mode stays on production only (one GitHub App, one webhook URL).
    GITHUB_APP_ID: "",
    GITHUB_APP_SLUG: "",
    GITHUB_APP_CLIENT_ID: "",
    GITHUB_REPO_ALLOWLIST: "",
  };
  cfg.d1_databases = [{ binding: "DB", database_name: STAGING.d1, database_id: d1Id, migrations_dir: "migrations" }];
  cfg.r2_buckets = (cfg.r2_buckets as Json[]).map((b) => ({ ...b, bucket_name: STAGING.bucket }));
  cfg.artifacts = (cfg.artifacts as Json[]).map((a) => ({ ...a, namespace: STAGING.artifactsNamespace }));
  cfg.analytics_engine_datasets = [{ binding: "METRICS", dataset: STAGING.metricsDataset }];
  cfg.ratelimits = (cfg.ratelimits as Json[]).map((r) => ({
    ...r,
    namespace_id: String(Number(r.namespace_id) + STAGING.rateLimitOffset),
  }));
  const q = cfg.queues as { producers: Json[]; consumers: Json[] };
  const rename = (n: unknown) => STAGING.queues[String(n)] ?? `${STAGING.name}-${String(n)}`;
  cfg.queues = {
    producers: q.producers.map((p) => ({ ...p, queue: rename(p.queue) })),
    consumers: q.consumers.map((c) => ({ ...c, queue: rename(c.queue), dead_letter_queue: rename(c.dead_letter_queue) })),
  };
  const triggers = cfg.triggers as { crons?: string[]; events?: Json[] };
  cfg.triggers = {
    crons: triggers.crons ?? [],
    events: (triggers.events ?? []).map((e) => ({ ...e, filter: { namespace: STAGING.artifactsNamespace } })),
  };
  return cfg;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { "d1-id": { type: "string" } } });
  const d1Id = values["d1-id"] ?? process.env.STAGING_D1_ID ?? STAGING.d1Id;
  const platform = resolve(import.meta.dirname, "../../apps/platform");
  const prod = JSON.parse(stripJsonc(readFileSync(join(platform, "wrangler.jsonc"), "utf8"))) as Json;
  const out = join(platform, "wrangler.staging.json");
  writeFileSync(out, `${JSON.stringify(stagingConfig(prod, d1Id), null, 2)}\n`);
  console.log(out);
}
