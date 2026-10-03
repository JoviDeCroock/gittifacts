/**
 * Which commit's CI judges a Change. Always the base's (a Change never edits the CI that judges
 * it), with one exception, adoption: while the default branch has no `.platform/ci.ts` (it runs
 * the detected defaults; nobody adopted a pipeline), a Change that adds one is judged by it.
 * Nothing adopted can be weakened that way, and every `.platform/` change is Lane 2 with a human
 * approval that is not the author's (classifier `policy.changed`). Without it a repo whose
 * detected defaults are red (lint debt, a monorepo) can never adopt a pipeline: the adopting
 * Change fails the red defaults, and a failing Change can't be reviewed (M5 dogfood).
 * The CI engine applies the same rule when it resolves a pipeline itself (merge-queue runs).
 */
import type { GitHost } from "./ports.js";

export const CI_PIPELINE_PATH = ".platform/ci.ts";

export async function pipelineShaFor(
  git: Pick<GitHost, "readFile">,
  repo: string,
  baseSha: string,
  headSha: string,
): Promise<string> {
  if ((await git.readFile(repo, baseSha, CI_PIPELINE_PATH)) !== null) return baseSha;
  if (headSha === baseSha) return baseSha;
  return (await git.readFile(repo, headSha, CI_PIPELINE_PATH)) !== null ? headSha : baseSha;
}
