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
 * Auth: authenticated callers need repo:read + change:create; the project is owned by the human,
 * or by the agent's owner. A caller without credentials gets an unclaimed project through
 * src/claim/create.ts (`token` and `claimUrl` set), which calls `createProjectAs` as the
 * project's own, ownerless agent principal.
 */
import { call, isTemplateId, nextStepsFor, projectSlug, TEMPLATES } from "@app/conventions";
import { PLACEHOLDER_CHANGE_TITLE } from "@app/coordinator";
import type { Principal, Repo } from "@app/domain";
import type { ProjectCreated } from "@app/mcp";
import { z } from "zod";
import { isPlatformAuditor } from "../access/config.js";
import { auditorReadOnly } from "../access/route.js";
import type { Caller, Services } from "../app-env.js";
import { restrictedRepoIds } from "../auth/repo-scope.js";
import { ApiError } from "../errors.js";
import { createPushImportProject } from "../import/push-project.js";
import { previewUrlFor, previewZone } from "../previews/ids.js";
import { recordProjectCreated } from "../projects/onboarding.js";

export const CreateProjectInput = z
  .object({
    name: z.string().trim().min(1).max(63).optional(),
    template: z.string().min(1).max(100).optional(),
    from: z.string().url().startsWith("https://").max(500).optional(),
    description: z.string().max(500).optional(),
    /** Private repos: an empty project its human owner pushes into (src/import/push-project.ts). */
    importMode: z.enum(["push"]).optional(),
  })
  .strict()
  .refine((v) => v.template === undefined || v.from === undefined, {
    message: "pass template or from, not both",
    path: ["from"],
  })
  .refine((v) => v.importMode === undefined || (v.template ?? v.from) === undefined, {
    message: "importMode push creates an empty project: no template or from",
    path: ["importMode"],
  });
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

/** Renamed by the Change's first push (its Plan's title, else the commit subject). */
const FIRST_CHANGE_TITLE = PLACEHOLDER_CHANGE_TITLE;

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
  if (isPlatformAuditor(caller.principal, svc.env)) throw auditorReadOnly();
  assertMayCreate(caller);
  const input = CreateProjectInput.parse(raw);
  if (input.importMode === "push") {
    return createPushImportProject(svc, caller, input, idempotencyKey);
  }
  return createProjectAs(svc, caller.principal, input, idempotencyKey);
}

/**
 * What an unclaimed project adds once its repo exists (src/claim/create.ts): the project's own
 * Bearer token and claim link, and when it expires. Runs before the first Change is opened, so
 * that Change's fork and token are charged to the project's quotas.
 */
export interface UnclaimedSetup {
  afterRepo(repo: Repo): Promise<{ token: string; claimUrl: string; expiresAt: string }>;
}

/** The project setup proper, as `actor` (a caller's principal, or an unclaimed agent). */
export async function createProjectAs(
  svc: Services,
  actor: Principal,
  input: CreateProjectInput,
  idempotencyKey: string | undefined,
  unclaimed?: UnclaimedSetup,
): Promise<ProjectCreated> {
  const startedAt = svc.clock.now();
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

  const extras = unclaimed === undefined ? null : await unclaimed.afterRepo(repo);
  // afterRepo binds an unclaimed project's agent to the new repo (repoIds): act as the stored
  // principal from here on, or the facade's repo-access check would not see the binding.
  const acting =
    unclaimed === undefined ? actor : ((await svc.store.getPrincipal(actor.id)) ?? actor);

  // 2 + 3, concurrently: the bootstrap (first CI + preview) and the caller's first Change.
  const runsCi = source !== "empty";
  const [bootstrap, first] = await Promise.all([
    runsCi ? svc.coordinator.startBootstrapChange(acting, repo.id) : Promise.resolve(null),
    svc.coordinator
      .startChange(acting, {
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
    claimUrl: extras?.claimUrl ?? null,
    claimed: repo.claim.status === "claimed",
    expiresAt: extras?.expiresAt ?? repo.claim.expiresAt,
    // Created without credentials: the caller must reconnect with the token before anything else.
    anonymous: extras?.token ? { mcpUrl } : undefined,
    imported: source === "import",
  });
  if (first === null) {
    // After the reconnect step, which stays first for an anonymous caller.
    nextSteps.splice(extras?.token ? 1 : 0, 0, {
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
    // An unclaimed project's own Bearer token (O3). Authenticated callers keep theirs.
    token: extras?.token ?? null,
    mcpUrl,
    previewUrl,
    // The link a human opens to claim an unclaimed project.
    claimUrl: extras?.claimUrl ?? null,
    bootstrapChangeId: bootstrap?.id ?? null,
    nextSteps,
  };
}
