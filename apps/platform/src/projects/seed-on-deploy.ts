/**
 * Re-warm the templates' global CI cache after a deploy (cron, src/index.ts).
 *
 * The global cache key of a template's install includes the runner image, and the image is
 * rebuilt with almost every deploy (it bundles the platform's packages). Until someone re-seeds,
 * every new project pays a cold `pnpm install`: 20 s of the 49.5 s to green in journey 10, where
 * a warm cache gives ~21 s (DECISIONS 2026-10-03). So the first cron run of a new worker version
 * seeds every template once: a new seed commit per version (the engine keys seed runs by sha),
 * then `seedCache`. A marker in BLOBS records the version that was seeded; a failed template
 * leaves it unset, so the next run tries again (seeding the same version twice is idempotent).
 */
import type { CiEngine } from "@app/ci-engine";
import { TEMPLATE_IDS } from "@app/conventions";
import { type GitHost, SEED_PREFIX } from "@app/coordinator";
import { ArtifactsGitHost } from "@app/coordinator/adapters";
import * as gitwire from "@app/gitwire";
import type { Bindings } from "../app-env.js";
import { engineFor, type SeedResult, seedTemplateCaches } from "./seed-cache.js";

export const SEED_MARKER_KEY = "ci-seed/worker-version.json";

interface Marker {
  version: string;
  seededAt: string;
}

/** A GitHost that may write the platform's `seed-*` repos only (one commit per worker version). */
export function seedGitHost(env: Bindings): GitHost {
  return new ArtifactsGitHost({
    binding: env.ARTIFACTS,
    wire: gitwire,
    namespace: env.ARTIFACTS_NAMESPACE,
    accountId: env.CF_ACCOUNT_ID,
    canWrite: (repo) => repo.startsWith(SEED_PREFIX),
  });
}

export interface SeedOnDeployDeps {
  version: string | null;
  origin: string;
  marker: {
    get(): Promise<Marker | null>;
    put(m: Marker): Promise<void>;
  };
  git: GitHost;
  engine: CiEngine;
  now(): Date;
}

export type SeedOnDeployOutcome =
  | { action: "skipped"; reason: string }
  | { action: "current"; version: string }
  | { action: "seeded"; version: string; results: SeedResult[] };

export async function seedOnDeploy(deps: SeedOnDeployDeps): Promise<SeedOnDeployOutcome> {
  if (deps.version === null) return { action: "skipped", reason: "no worker version metadata" };
  const marker = await deps.marker.get().catch(() => null);
  if (marker?.version === deps.version) return { action: "current", version: deps.version };
  const results = await seedTemplateCaches(
    { git: deps.git, engine: deps.engine, origin: deps.origin },
    TEMPLATE_IDS,
    { refresh: deps.version },
  );
  if (results.every((r) => r.error === null)) {
    await deps.marker.put({ version: deps.version, seededAt: deps.now().toISOString() });
  }
  return { action: "seeded", version: deps.version, results };
}

/** Cron entry: seed once per worker version. Never throws (the cron runs other sweeps too). */
export async function runSeedOnDeploy(env: Bindings): Promise<void> {
  try {
    const out = await seedOnDeploy({
      version: env.VERSION?.id ?? null,
      origin: env.BETTER_AUTH_URL ?? "https://gittifacts.decroockjovi.workers.dev",
      marker: {
        get: async () => {
          const obj = await env.BLOBS.get(SEED_MARKER_KEY);
          return obj === null ? null : ((await obj.json()) as Marker);
        },
        put: async (m) => {
          await env.BLOBS.put(SEED_MARKER_KEY, JSON.stringify(m));
        },
      },
      git: seedGitHost(env),
      engine: engineFor(env),
      now: () => new Date(),
    });
    if (out.action === "seeded") {
      console.log(
        JSON.stringify({
          event: "ci-seed",
          version: out.version,
          seeds: out.results.map((r) => ({ t: r.templateId, run: r.runId, error: r.error })),
        }),
      );
    }
  } catch (e) {
    console.warn("ci-seed: re-seeding the template caches failed", e);
  }
}
