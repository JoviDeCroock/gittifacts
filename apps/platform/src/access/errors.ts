/**
 * Access refusals. A principal that may not read a repo gets exactly the 404 a missing repo,
 * plan or change gets (same message, same fix), so ids of other people's repos leak nothing.
 */
import type { Principal } from "@app/domain";
import { repoNotGranted } from "../auth/repo-scope.js";
import { ApiError, notFound } from "../errors.js";
import { MIN_ROLE, NEED_SCOPES, NEED_TEXT, type RepoNeed, type RepoRole } from "./roles.js";

export function noSuchRepo(repoId: string): ApiError {
  return notFound(`repo ${repoId}`, {
    explanation: "No repo with that id. List the repos you can act on.",
    call: "list_repos({})",
  });
}

export function noSuchChange(changeId: string): ApiError {
  return notFound(`change ${changeId}`, {
    explanation:
      "No change with that id. Start one from an approved plan (or list a repo's changes).",
    call: 'start_change({ repoId: "<repoId>", planId: "<planId>", title: "<title>", category: "fix" })',
  });
}

export function noSuchPlan(planId: string, repoId = "<repoId>"): ApiError {
  return notFound(`plan ${planId}`, {
    explanation:
      "No plan with that id. Draft a plan; a human other than you approves it before work starts.",
    call: `create_plan({ repoId: "${repoId}", title: "<title>", intent: "<why>", acceptanceCriteria: ["<observable result>"] })`,
  });
}

export { repoNotGranted };

/** 403 for a principal that can see the repo but may not do this on it. */
export function refused(
  p: Principal,
  repoId: string,
  need: RepoNeed,
  why: "human-only" | "scope" | "role" | "auditor",
  role: RepoRole | null,
): ApiError {
  if (why === "auditor") {
    return new ApiError(
      403,
      "forbidden",
      `platform auditors are read-only (${NEED_TEXT[need]} on repo ${repoId} refused)`,
      { repoId, need },
      {
        explanation:
          "This principal is a platform auditor (PLATFORM_AUDITORS): it can read every repo and the audit log, and never write, review or approve.",
      },
    );
  }
  if (why === "human-only") {
    return new ApiError(
      403,
      "forbidden",
      `only a human may do this (${NEED_TEXT[need]})`,
      { repoId, need, kind: p.kind },
      {
        explanation:
          "Humans approve intent: agents and integrations never review, approve or administer a repo. Ask a human member of the repo.",
        call: `list_members({ repoId: "${repoId}" })`,
      },
    );
  }
  if (why === "scope") {
    const required = [...NEED_SCOPES[need]];
    return new ApiError(403, "insufficient-scope", `missing scope: one of ${required.join(", ")}`, {
      required,
      missing: required,
    });
  }
  const needed = MIN_ROLE[need];
  const whose = p.kind === "human" ? "your role" : "the role of the human who owns this principal";
  return new ApiError(
    403,
    "insufficient-role",
    `${whose} on repo ${repoId} is ${role ?? "none"}; ${NEED_TEXT[need]} needs ${needed} or above`,
    { repoId, role, needed, need },
    {
      explanation: `Repo roles are reader < reviewer < maintainer < owner. Ask an owner of repo ${repoId} to make ${p.kind === "human" ? "you" : "your owner"} a ${needed} (list_members shows who the owners are), or hand this step to someone who is.`,
      call: `list_members({ repoId: "${repoId}" })`,
    },
  );
}
