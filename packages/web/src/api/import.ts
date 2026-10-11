/**
 * Import a private repo by push (apps/platform/src/import/push-project.ts): a signed-in person
 * creates an empty repo and gets a one-time grant to push its history. Humans only; agents import
 * public repos with `create_project({ from })`. Polls the grant until the push closes it.
 */
import { request } from "./client.js";

export interface ImportGrant {
  url: string;
  branch: string;
  token: string;
  expiresAt: string;
  command: string;
  closesWhen: string;
}

export interface ImportStarted {
  projectId: string;
  name: string;
  defaultBranch: string;
  importGrant: ImportGrant;
}

export interface ImportGrantStatus {
  repoId: string;
  status: "open" | "closing" | "closed";
  openUntil: string;
  closeReason: "pushed" | "change-started" | "expired" | "closed-by-owner" | null;
  mainSha: string | null;
  imported: boolean;
}

const enc = encodeURIComponent;

export const importApi = {
  start: (name: string, key?: string) => request<ImportStarted>("POST", "/api/v1/projects", { name, importMode: "push" }, key),
  status: (repoId: string) => request<{ grant: ImportGrantStatus | null }>("GET", `/api/v1/repos/${enc(repoId)}/import-grant`),
  reopen: (repoId: string, key?: string) => request<{ grant: ImportGrant; status: ImportGrantStatus }>("POST", `/api/v1/repos/${enc(repoId)}/import-grant`, {}, key),
};

/** The env var the grant's command reads the token from (src/import/push-grant.ts). */
export const IMPORT_TOKEN_ENV = "GITTIFACTS_IMPORT_TOKEN";

/** What to paste: the token into its env var, then the one push. `<your-branch>` becomes the branch. */
export function pushCommands(g: ImportGrant, localBranch = "main"): string {
  return `export ${IMPORT_TOKEN_ENV}='${g.token}'\n${g.command.replace("<your-branch>", localBranch)}`;
}
