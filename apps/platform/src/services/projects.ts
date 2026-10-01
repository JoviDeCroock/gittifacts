/**
 * `create_project` / `POST /api/v1/projects` (docs/prompts/02-onboarding.md §3): one call that
 *
 * 1. creates the repo (= the project; `projectId` is the repo id) from a template, an import or
 *    empty, with `.platform/ci.ts`, `.platform/policy.ts` and AGENTS.md in its initial commit;
 * 2. starts the bootstrap Change (first CI run + first preview of that commit);
 * 3. opens the caller's first Change, so `remote` is a push grant for its fork right away;
 *
 * and returns at once: CI and the preview finish in the background (`wait_for_change` on
 * `bootstrapChangeId`), and `previewUrl` serves a "building" page until then.
 *
 * Auth: until unclaimed projects exist (O3), callers need repo:read + change:create. The project
 * is owned by the human, or by the agent's owner. O3's seam: a caller without a principal gets an
 * unclaimed project and `token`/`claimUrl` set.
 */
import { call, isTemplateId, nextStepsFor, projectSlug, TEMPLATES } from "@app/conventions";
import type { Repo } from "@app/domain";
import type { ProjectCreated } from "@app/mcp";
import { z } from "zod";
import type { Caller, Services } from "../app-env.js";
import { restrictedRepoIds } from "../auth/repo-scope.js";
import { ApiError } from "../errors.js";
import { previewUrlFor, previewZone } from "../previews/ids.js";
import { recordProjectCreated } from "../projects/onboarding.js";

export const CreateProjectInput = z
  .object({
    name: z.string().trim().min(1).max(63).optional(),
    template: z.string().min(1).max(100).optional(),
    from: z.string().url().startsWith("https://").max(500).optional(),
    description: z.string().max(500).optional(),
  })
  .strict()
  .refine((v) => v.template === undefined || v.from === undefined, {
    message: "pass template or from, not both",
    path: ["from"],
  });
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

const FIRST_CHANGE_TITLE = "First change";

/** Stable short suffix: from the idempotency key when there is one (a retry names the same repo). */
async function suffix(key: string | undefined): Promise<string> {
  const bytes =
    key === undefined
      ? crypto.getRandomValues(new Uint8Array(4))
      : new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return [...bytes.slice(0, 3)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function projectName(
  input: Pick<CreateProjectInput, "name" | "template" | "from">,
  key: string | undefined,
): Promise<string> {
  if (input.name !== undefined) {
    const slug = projectSlug(input.name);
    return slug.length >= 2 ? slug : `${slug}-project`;
  }
  const base =
    input.template ??
    (input.from === undefined
      ? "project"
      : projectSlug(
          input.from
            .replace(/\.git$/, "")
            .split("/")
            .pop() ?? "import",
        ));
  return `${base.slice(0, 50)}-${await suffix(key)}`;
}

function assertMayCreate(caller: Caller): void {
  const scopes = caller.principal.scopes;
  const missing = (["repo:read", "change:create"] as const).filter((s) => !scopes.includes(s));
  if (missing.length > 0) {
    throw new ApiError(403, "insufficient-scope", `missing scope: ${missing.join(", ")}`, {
      required: ["repo:read", "change:create"],
      missing,
    });
  }
  if (restrictedRepoIds(caller.principal) !== null) {
    throw new ApiError(
      403,
      "repo-not-granted",
      "this agent session is limited to specific repos, so it cannot create new ones",
      { allowedRepoIds: restrictedRepoIds(caller.principal) },
      {
        explanation:
          "A session the human limited to some repos can't widen itself. Ask the human to create the project, or to approve a session that is not repo-restricted.",
        call: "whoami({})",
      },
    );
  }
}

export async function createProject(
  svc: Services,
  caller: Caller,
  raw: unknown,
  idempotencyKey?: string,
): Promise<ProjectCreated> {
  const startedAt = svc.clock.now();
  assertMayCreate(caller);
  const input = CreateProjectInput.parse(raw);
  const actor = caller.principal;
  const name = await projectName(input, idempotencyKey);

  // 1. The repo with its initial commit (template / empty), or an import.
  let repo: Repo;
  let source: "template" | "import" | "empty";
  if (input.from !== undefined) {
    source = "import";
    // An import is idempotent by name: a retry finds it and continues.
    const existing = await svc.store.getRepoByArtifactsName(name);
    repo =
      existing !== null && existing.importedFrom === input.from
        ? existing
        : await svc.coordinator.importRepo(actor, { name, url: input.from });
  } else {
    source = input.template === undefined ? "empty" : "template";
    repo = await svc.coordinator.createRepo(actor, {
      name,
      ...(input.template === undefined ? {} : { template: input.template }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey: `project:${idempotencyKey}` }),
    });
  }

  // 2 + 3, concurrently: the bootstrap (first CI + preview) and the caller's first Change.
  const runsCi = source !== "empty";
  const [bootstrap, first] = await Promise.all([
    runsCi ? svc.coordinator.startBootstrapChange(actor, repo.id) : Promise.resolve(null),
    svc.coordinator
      .startChange(actor, {
        repoId: repo.id,
        title: FIRST_CHANGE_TITLE,
        category: "feature",
        ...(idempotencyKey === undefined
          ? {}
          : { idempotencyKey: `first-change:${idempotencyKey}` }),
      })
      .then(
        (r) => r,
        (e: unknown) => {
          // The project exists and its CI runs; the agent can start a change itself.
          console.warn("create_project: first change not opened", e);
          return null;
        },
      ),
  ]);

  const zone = previewZone(svc.env);
  const template = repo.template;
  const hasPreview =
    bootstrap !== null &&
    (template === null ||
      !isTemplateId(template) ||
      TEMPLATES[template].manifest.previewCommand !== null);
  const previewUrl = hasPreview && bootstrap !== null ? previewUrlFor(zone, bootstrap.id) : null;
  const mcpUrl = `${svc.origin}/mcp`;
  const remote = first === null ? null : { ...first.remote, changeId: first.change.id };

  const nextSteps = nextStepsFor("project_created", {
    projectId: repo.id,
    changeId: bootstrap?.id,
    firstChange:
      first === null
        ? undefined
        : {
            changeId: first.change.id,
            remote: { url: first.remote.url, branch: first.remote.branch },
          },
    previewUrl,
    claimUrl: null,
    claimed: repo.claim.status === "claimed",
  });
  if (first === null) {
    nextSteps.unshift({
      title: "Open your first Change (the fork could not be made just now)",
      call: call("start_change", { repoId: repo.id, title: "<what>", category: "feature" }),
    });
  }

  const respondedAt = svc.clock.now();
  svc.waitUntil(
    recordProjectCreated(svc.store, svc.env, {
      projectId: repo.id,
      template,
      source,
      principalId: actor.id,
      bootstrapChangeId: bootstrap?.id ?? null,
      createdAt: startedAt,
      respondedAt,
    }).catch((e: unknown) => console.warn("ttfg: could not record the project", e)),
  );

  return {
    projectId: repo.id,
    name: repo.name,
    template,
    defaultBranch: repo.defaultBranch,
    remote,
    // O3: an unclaimed project's own bearer token. Authenticated callers keep theirs.
    token: null,
    mcpUrl,
    previewUrl,
    // O3: the link a human opens to claim an unclaimed project.
    claimUrl: null,
    bootstrapChangeId: bootstrap?.id ?? null,
    nextSteps,
  };
}
