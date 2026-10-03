/**
 * GitHub mode (docs/prompts/06-two-modes.md §3): our GitHub Apps, the manifest flow that creates
 * them (platform admins), and the installations you linked. In mock mode the calls go to
 * ./mock-github.ts.
 */
import { ApiError, type Method, request } from "./client.js";
import { isMockMode } from "./mode.js";

export interface GithubApp {
  id: number;
  kind: "reader" | "actor";
  slug: string;
  name: string;
  owner: { login: string; type: string };
  htmlUrl: string;
  installUrl: string;
  permissions: Record<string, string>;
  events: string[];
  createdAt: string;
}

export interface GithubInstallation {
  id: number;
  appId: number;
  account: { login: string; type: string };
  repositorySelection: string;
  suspended: boolean;
  repos: { id: number; fullName: string; private: boolean; repoId: string | null; prWrites: "on" | "off" }[];
  linkedAs: string;
  linkedAt: string;
  manageUrl: string;
}

export interface GithubOverview {
  apps: GithubApp[];
  installations: GithubInstallation[];
  canCreateApps: boolean;
  actorAppsEnabled: boolean;
  webhookUrl: string;
}

export interface ManifestInput {
  kind?: "reader" | "actor";
  org?: string;
  name?: string;
}

export interface ManifestStart {
  kind: "reader" | "actor";
  name: string;
  org: string | null;
  action: string;
  manifest: string;
  state: string;
  expiresAt: string;
}

async function call<T>(method: Method, path: string, body?: unknown): Promise<T> {
  if (!isMockMode()) return request<T>(method, path, body);
  const mock = await import("./mock-github.js");
  const res = await mock.handle(method, path, body);
  if (res.status >= 200 && res.status < 300) return res.body as T;
  throw new ApiError(res.status, `http_${res.status}`, `The server answered ${res.status}.`);
}

export const githubApi = {
  overview: () => call<GithubOverview>("GET", "/api/v1/github"),
  setPrWrites: (repoId: string, value: "on" | "off") =>
    call<{ repoId: string; prWrites: "on" | "off" }>("PUT", `/api/v1/github/repos/${encodeURIComponent(repoId)}/pr-writes`, { value }),
  startManifest: (input: ManifestInput) => call<ManifestStart>("POST", "/api/v1/github/manifests", input),
};

/** Send the browser to GitHub with the manifest: a real form POST, as the flow requires. */
export function submitManifest(start: ManifestStart): void {
  if (isMockMode()) {
    window.location.assign(`/settings/github?created=${encodeURIComponent(start.name)}&mock`);
    return;
  }
  const form = document.createElement("form");
  form.method = "post";
  form.action = start.action;
  const field = document.createElement("input");
  field.type = "hidden";
  field.name = "manifest";
  field.value = start.manifest;
  form.appendChild(field);
  document.body.appendChild(form);
  form.submit();
}

/** What a `?error=` code on /settings/github means, in plain words. */
export const FLOW_ERRORS: Record<string, string> = {
  "state-invalid": "That link wasn't issued by gittifacts. Start again from this page.",
  "state-expired": "That step expired or was already used (links are good for one hour, once). Start again.",
  "state-not-yours": "That step was started by someone else. Start again while signed in as yourself.",
  "not-admin": "Only a platform admin can create the GitHub App.",
  "code-missing": "GitHub didn't send a code back. Start again.",
  "code-expired": "GitHub's code expired (one hour). Start again.",
  "conversion-failed": "GitHub didn't hand over the new App's credentials. Check the App on GitHub, then try again.",
  "installation-missing": "GitHub didn't say which installation this is. Open the App's page on GitHub and install it again.",
  "installation-not-yours": "Your GitHub account can't see that installation, so it wasn't linked.",
  "authorization-denied": "You cancelled the authorization on GitHub, so the installation wasn't linked.",
  "authorization-failed": "GitHub refused the authorization code. Try again.",
  "no-app": "The GitHub App isn't set up yet.",
  "github-error": "GitHub answered with an error. Try again in a minute.",
  internal: "Something went wrong on our side. Try again.",
};
