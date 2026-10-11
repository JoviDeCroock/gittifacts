/**
 * The few GitHub calls the App setup needs (manifest conversion, user authorization, the user's
 * installations). Every response is validated with zod. Tokens are passed in, never logged, and
 * never appear in errors.
 *
 * REST version pinned to 2026-03-10 (docs/research/github-app.md, decision 11).
 */
import { z } from "zod";

export const GITHUB_API = "https://api.github.com";
export const GITHUB_WEB = "https://github.com";
export const GITHUB_API_VERSION = "2026-03-10";
const UA = "gittifacts";

export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

function headers(extra: Record<string, string> = {}): Headers {
  return new Headers({
    accept: "application/vnd.github+json",
    "x-github-api-version": GITHUB_API_VERSION,
    "user-agent": UA,
    ...extra,
  });
}

async function readJson<S extends z.ZodType>(res: Response, schema: S, what: string) {
  const text = await res.text();
  if (!res.ok) {
    let msg = "";
    try {
      msg = String((JSON.parse(text) as { message?: unknown }).message ?? "");
    } catch {
      // not JSON
    }
    throw new GithubApiError(res.status, "github-error", `${what}: GitHub answered ${res.status}${msg ? ` (${msg.slice(0, 200)})` : ""}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new GithubApiError(502, "github-bad-response", `${what}: GitHub's answer is not JSON`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new GithubApiError(502, "github-bad-response", `${what}: unexpected answer shape`);
  }
  return parsed.data as z.infer<S>;
}

const Account = z.object({ login: z.string().min(1), id: z.number().int(), type: z.string() });

/** `POST /app-manifests/{code}/conversions`: the App plus its secrets (shown once). */
export const ManifestConversion = z.object({
  id: z.number().int().positive(),
  slug: z.string().min(1),
  name: z.string().min(1),
  owner: Account,
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  webhook_secret: z.string().min(1),
  pem: z.string().includes("PRIVATE KEY"),
  html_url: z.url(),
  permissions: z.record(z.string(), z.string()).default({}),
  events: z.array(z.string()).default([]),
});
export type ManifestConversion = z.infer<typeof ManifestConversion>;

export async function convertManifest(code: string): Promise<ManifestConversion> {
  const res = await fetch(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: headers(),
  });
  return readJson(res, ManifestConversion, "manifest conversion");
}

const TokenAnswer = z.union([
  z.object({ access_token: z.string().min(1), token_type: z.string().optional() }),
  z.object({ error: z.string(), error_description: z.string().optional() }),
]);

/** Exchange a user-authorization code for a user access token (the App's client credentials). */
export async function exchangeUserCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<string> {
  const res = await fetch(`${GITHUB_WEB}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
  });
  const out = await readJson(res, TokenAnswer, "user authorization");
  if ("error" in out) throw new GithubApiError(400, "github-oauth-error", `user authorization: ${out.error}`);
  return out.access_token;
}

export async function getUser(token: string): Promise<{ login: string; id: number }> {
  const res = await fetch(`${GITHUB_API}/user`, {
    headers: headers({ authorization: `Bearer ${token}` }),
  });
  return readJson(res, z.object({ login: z.string(), id: z.number().int() }), "user");
}

export const InstallationInfo = z.object({
  id: z.number().int().positive(),
  app_id: z.number().int().positive(),
  account: Account.nullable(),
  repository_selection: z.enum(["all", "selected"]),
  permissions: z.record(z.string(), z.string()).default({}),
  events: z.array(z.string()).default([]),
  suspended_at: z.string().nullable().optional(),
});
export type InstallationInfo = z.infer<typeof InstallationInfo>;

/**
 * `GET /app/installations/{id}` with the App's JWT: one installation of our App, or null when
 * GitHub doesn't know it (deleted). Used when a delivery names an installation we never recorded.
 */
export async function appInstallation(appJwt: string, id: number): Promise<InstallationInfo | null> {
  const res = await fetch(`${GITHUB_API}/app/installations/${id}`, {
    headers: headers({ authorization: `Bearer ${appJwt}` }),
  });
  if (res.status === 404) {
    await res.body?.cancel();
    return null;
  }
  return readJson(res, InstallationInfo, "app installation");
}

const MAX_PAGES = 10;

/** `GET /user/installations`: the App's installations this user can access (≤ 1,000). */
export async function userInstallations(token: string): Promise<InstallationInfo[]> {
  const out: InstallationInfo[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`${GITHUB_API}/user/installations?per_page=100&page=${page}`, {
      headers: headers({ authorization: `Bearer ${token}` }),
    });
    const body = await readJson(
      res,
      z.object({ total_count: z.number(), installations: z.array(InstallationInfo) }),
      "user installations",
    );
    out.push(...body.installations);
    if (body.installations.length < 100) break;
  }
  return out;
}

export const RepoInfo = z.object({
  id: z.number().int().positive(),
  full_name: z.string().min(3),
  private: z.boolean(),
  /**
   * The authenticated user's access (user-token listings only; absent in webhook payloads).
   * Absent or partial counts as the least access: it can only lower what a link grants.
   */
  permissions: z
    .object({
      admin: z.boolean().optional(),
      maintain: z.boolean().optional(),
      push: z.boolean().optional(),
      triage: z.boolean().optional(),
      pull: z.boolean().optional(),
    })
    .optional(),
});
export type RepoInfo = z.infer<typeof RepoInfo>;

/** `GET /user/installations/{id}/repositories` (≤ 1,000). */
export async function userInstallationRepos(token: string, installationId: number) {
  const out: RepoInfo[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(
      `${GITHUB_API}/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
      { headers: headers({ authorization: `Bearer ${token}` }) },
    );
    const body = await readJson(
      res,
      z.object({ total_count: z.number(), repositories: z.array(RepoInfo) }),
      "installation repositories",
    );
    out.push(...body.repositories);
    if (body.repositories.length < 100) break;
  }
  return out;
}

/** `DELETE /applications/{client_id}/token`: we only needed the user token to verify. */
export async function revokeUserToken(input: {
  clientId: string;
  clientSecret: string;
  token: string;
}): Promise<void> {
  const basic = btoa(`${input.clientId}:${input.clientSecret}`);
  const res = await fetch(`${GITHUB_API}/applications/${encodeURIComponent(input.clientId)}/token`, {
    method: "DELETE",
    headers: headers({ authorization: `Basic ${basic}`, "content-type": "application/json" }),
    body: JSON.stringify({ access_token: input.token }),
  });
  await res.body?.cancel();
}
