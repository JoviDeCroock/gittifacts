/**
 * `create_project({ name, importMode: "push" })` / `POST /api/v1/projects { importMode: "push" }`:
 * a private repo's way in (src/import/push-grant.ts). A human owner gets an EMPTY claimed project
 * and a one-time import grant; there is no bootstrap Change and no first Change yet (either would
 * close the grant). The push closes the grant and starts the bootstrap CI + detection proposal.
 */
import type { ImportGrantData, ProjectCreated } from "@app/mcp";
import { assertRepoAccess } from "../access/access.js";
import type { Caller, Services } from "../app-env.js";
import { assertScopes } from "../auth/middleware.js";
import { ApiError } from "../errors.js";
import type { CreateProjectInput } from "../services/projects.js";
import { projectName } from "../services/projects.js";
import { humanRequired, openImportGrant } from "./push-grant.js";
import { grantDeps } from "./push-grant-runtime.js";

/** Without credentials there is no human owner to hand the grant to. */
export function refuseAnonymousPushImport(input: CreateProjectInput): void {
  if (input.importMode !== "push") return;
  throw new ApiError(
    401,
    "unauthorized",
    "import by push needs a signed-in human owner",
    { importMode: "push" },
    {
      explanation:
        'The grant writes the new project\'s main repo, so only its human owner gets one. Sign in (the web app, or /api/auth/sign-in/email) and call POST /api/v1/projects { name, importMode: "push" } with that session. Public repos can be imported without it: create_project({ from: "https://…" }).',
    },
  );
}

export async function createPushImportProject(
  svc: Services,
  caller: Caller,
  input: CreateProjectInput,
  idempotencyKey: string | undefined,
): Promise<ProjectCreated & { importGrant: ImportGrantData }> {
  if (caller.principal.kind !== "human") throw humanRequired();
  assertScopes(caller, ["repo:admin"]);
  const name = await projectName(input, idempotencyKey);
  const repo = await svc.coordinator.createRepo(caller.principal, {
    name,
    empty: true,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey: `project:${idempotencyKey}` }),
  });
  // The creator is the claimed project's owner; the grant needs exactly that.
  await assertRepoAccess(svc, caller.principal, repo.id, "admin");
  const { grant } = await openImportGrant(grantDeps(svc), caller.principal, repo);
  const statusUrl = `${svc.origin}/api/v1/repos/${repo.id}/import-grant`;
  return {
    projectId: repo.id,
    name: repo.name,
    template: null,
    defaultBranch: repo.defaultBranch,
    remote: null,
    token: null,
    mcpUrl: `${svc.origin}/mcp`,
    previewUrl: null,
    claimUrl: null,
    bootstrapChangeId: null,
    importGrant: grant,
    nextSteps: [
      {
        title: `Push your history in one push (the grant closes at the first push)`,
        command: grant.command,
        why: grant.closesWhen,
      },
      {
        title: "Check that the grant closed and the import was detected",
        command: `curl -b <your session cookie> ${statusUrl}`,
      },
      {
        title: "Approve the detection Plan, then review its Change (.platform/* + AGENTS.md)",
        command: `open ${svc.origin}/repos/${repo.id}`,
      },
    ],
  };
}
