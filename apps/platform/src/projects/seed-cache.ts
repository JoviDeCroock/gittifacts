/**
 * Warm the CI engine's global dependency cache for every launch template (DECISIONS.md: hermetic
 * global cache + `seedCache`), so the first project created from a template already hits a
 * published install snapshot instead of paying a cold `pnpm install`.
 *
 * For each template: a platform-owned Artifacts repo `seed-<id>-<digest8>` (the `seed-` prefix is
 * reserved) holds the template's files at one commit; `ciEngine.seedCache` runs its global-scope
 * install there and publishes the snapshot under the input-addressed key every project from the
 * template computes (package.json, lockfile and pnpm-workspace.yaml are not placeholder-rendered).
 * Idempotent per template content: a second call reuses the repo and the engine's run.
 */
import { type CiEngine, EngineKind, selectCiEngine } from "@app/ci-engine";
import { TEMPLATE_IDS, type TemplateId } from "@app/conventions";
import type { GitHost } from "@app/coordinator";
import { TEMPLATE_DIGESTS } from "../generated/templates.js";
import { templateFiles } from "./initial-commit.js";

export interface SeedResult {
  templateId: TemplateId;
  repo: string;
  sha: string;
  runId: string | null;
  error: string | null;
}

export function seedRepoName(id: TemplateId): string {
  return `seed-${id}-${(TEMPLATE_DIGESTS[id] ?? "0").slice(0, 8)}`;
}

/**
 * The seed commit for `refresh` (a worker version id): the head itself when its message already
 * names it, else a new commit with the same tree on top. The CI engine derives a seed run's id
 * from (template, sha), so only a new sha makes it seed again; the global cache key includes the
 * runner image, which changes with almost every deploy (DECISIONS 2026-10-03).
 */
async function refreshedSeed(
  git: GitHost,
  repo: string,
  id: TemplateId,
  head: string,
  refresh: string,
): Promise<string> {
  const label = `(worker ${refresh})`;
  const message = (await git.commitMessage?.(repo, head)) ?? "";
  if (message.includes(label)) return head;
  const tree = await git.treeOf(repo, head);
  if (tree === null) throw new Error(`seed repo ${repo}: no tree at ${head}`);
  const { sha } = await git.commitTree(repo, {
    treeSha: tree,
    parents: [head],
    message: `CI cache seed for template ${id} ${label}`,
    branch: "main",
    expectedOld: head,
  });
  return sha;
}

async function seedRepo(
  git: GitHost,
  id: TemplateId,
  origin: string,
  refresh?: string,
): Promise<{ repo: string; sha: string }> {
  const repo = seedRepoName(id);
  try {
    await git.createRepo(repo, { defaultBranch: "main", description: `CI cache seed for ${id}` });
  } catch (e) {
    if (!/ALREADY_EXISTS/.test(e instanceof Error ? e.message : String(e))) {
      const code = (e as { code?: unknown }).code;
      if (code !== "ALREADY_EXISTS") throw e;
    }
  }
  const head = await git.branchHead(repo, "main");
  if (head !== null) {
    return { repo, sha: refresh === undefined ? head : await refreshedSeed(git, repo, id, head, refresh) };
  }
  const files = templateFiles(id, {
    projectName: id,
    host: origin,
    mcpUrl: `${origin}/mcp`,
    repoId: repo,
    claimed: true,
  });
  const { sha } = await git.writeInitialCommit(repo, {
    branch: "main",
    files,
    message: `CI cache seed for template ${id}`,
  });
  return { repo, sha };
}

export async function seedTemplateCaches(
  deps: { git: GitHost; engine: CiEngine; origin: string },
  templates: readonly TemplateId[] = TEMPLATE_IDS,
  /** Seed again for this worker version (a new seed commit), even if the head was seeded. */
  opts: { refresh?: string } = {},
): Promise<SeedResult[]> {
  const seed = deps.engine.seedCache?.bind(deps.engine);
  return Promise.all(
    templates.map(async (templateId): Promise<SeedResult> => {
      try {
        const { repo, sha } = await seedRepo(deps.git, templateId, deps.origin, opts.refresh);
        if (seed === undefined) {
          return { templateId, repo, sha, runId: null, error: "this CI engine cannot seed caches" };
        }
        const { runId } = await seed({
          templateId,
          artifactsRepo: repo,
          remote: deps.git.remoteOf(repo),
          sha,
          limits: { maxMinutes: 30 },
        });
        return { templateId, repo, sha, runId, error: null };
      } catch (e) {
        return {
          templateId,
          repo: seedRepoName(templateId),
          sha: "",
          runId: null,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );
}

/** The real engine (not the coordinator's lazy wrapper, which has no seedCache). */
export function engineFor(
  env: Parameters<typeof selectCiEngine>[0] & { CI_ENGINE: string },
): CiEngine {
  const kind = EngineKind.parse(env.CI_ENGINE);
  return selectCiEngine(env, { engine: kind });
}
