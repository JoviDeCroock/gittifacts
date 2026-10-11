/**
 * Installation access tokens (docs/research/github-app.md §5, decision 8): minted per job with
 * `repository_ids` and the minimal `permissions`, revoked when the job ends, never logged, never
 * handed to a sandbox. A token is an opaque object: its value is only reachable through
 * `authorization()`, so it doesn't show up in JSON, inspection or error messages.
 */
import { z } from "zod";
import { GITHUB_API, GITHUB_API_VERSION, GithubHttpError, rateLimitOf } from "./api.js";
import { importAppKey, signAppJwt } from "./jwt.js";

export interface AppCredentials {
  appId: number;
  clientId: string;
  /** PEM (PKCS#1 or PKCS#8). */
  privateKey: string;
}

export type Permissions = Partial<
  Record<
    "contents" | "checks" | "pull_requests" | "metadata" | "issues" | "statuses",
    "read" | "write"
  >
>;

export interface InstallationToken {
  readonly installationId: number;
  readonly expiresAt: string;
  readonly permissions: Permissions;
  /** `Bearer <token>` / the raw value for git basic auth; never log either. */
  authorization(): string;
  value(): string;
  toJSON(): string;
}

function opaque(
  installationId: number,
  raw: string,
  expiresAt: string,
  permissions: Permissions,
): InstallationToken {
  return {
    installationId,
    expiresAt,
    permissions,
    authorization: () => `Bearer ${raw}`,
    value: () => raw,
    toJSON: () => "[installation token]",
  };
}

const TokenAnswer = z.object({
  token: z.string().min(10),
  expires_at: z.string(),
  permissions: z.record(z.string(), z.string()).optional(),
});

export class InstallationTokens {
  private key: Promise<CryptoKey> | null = null;
  private jwt: { value: string; until: number } | null = null;

  constructor(
    private readonly app: AppCredentials,
    private readonly opts: { fetch?: typeof fetch; apiBase?: string; now?: () => Date } = {},
  ) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** An App JWT, reused until a minute before it expires. */
  async appJwt(): Promise<string> {
    const now = this.now();
    if (this.jwt !== null && this.jwt.until - 60_000 > now.getTime()) return this.jwt.value;
    this.key ??= importAppKey(this.app.privateKey);
    const { jwt, expiresAt } = await signAppJwt({
      key: await this.key,
      issuer: this.app.clientId,
      now,
    });
    this.jwt = { value: jwt, until: expiresAt };
    return jwt;
  }

  private async send(
    method: string,
    path: string,
    auth: string,
    body?: unknown,
  ): Promise<Response> {
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.apiBase ?? GITHUB_API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": GITHUB_API_VERSION,
        "user-agent": "gittifacts",
        authorization: auth,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if ((res.status === 403 || res.status === 429) && rateLimitOf(res, this.now().getTime())) {
      throw rateLimitOf(res, this.now().getTime());
    }
    return res;
  }

  /** `POST /app/installations/{id}/access_tokens`, scoped to repos and permissions. */
  async mint(
    installationId: number,
    scope: { repositoryIds: number[]; permissions: Permissions },
  ): Promise<InstallationToken> {
    const path = `/app/installations/${installationId}/access_tokens`;
    const res = await this.send("POST", path, `Bearer ${await this.appJwt()}`, {
      repository_ids: scope.repositoryIds,
      permissions: scope.permissions,
    });
    const text = await res.text();
    if (!res.ok)
      throw new GithubHttpError(res.status, path, `minting an installation token: ${res.status}`);
    const parsed = TokenAnswer.safeParse(JSON.parse(text));
    if (!parsed.success)
      throw new GithubHttpError(502, path, "minting an installation token: unexpected answer");
    return opaque(installationId, parsed.data.token, parsed.data.expires_at, scope.permissions);
  }

  /** `DELETE /installation/token`: end of job. Best effort (it expires within the hour anyway). */
  async revoke(token: InstallationToken): Promise<boolean> {
    try {
      const res = await this.send("DELETE", "/installation/token", token.authorization());
      await res.body?.cancel();
      return res.status === 204;
    } catch {
      return false;
    }
  }

  /** Run `job` with a fresh, scoped token and revoke it afterwards, whatever happens. */
  async withToken<T>(
    installationId: number,
    scope: { repositoryIds: number[]; permissions: Permissions },
    job: (token: InstallationToken) => Promise<T>,
  ): Promise<T> {
    const token = await this.mint(installationId, scope);
    try {
      return await job(token);
    } finally {
      await this.revoke(token);
    }
  }
}

/**
 * One token for one job (a queue message, a workflow step): minted on first use, revoked by
 * `release()`. Every GitHub call of the job shares it; nothing outlives the job.
 */
export class JobToken {
  private token: Promise<InstallationToken> | null = null;

  constructor(
    private readonly tokens: InstallationTokens,
    private readonly installationId: number,
    private readonly scope: { repositoryIds: number[]; permissions: Permissions },
  ) {}

  async value(): Promise<string> {
    // A long job (a backtest runs up to an hour) outlives a token: mint again shortly before it
    // expires, revoking the old one.
    const current = this.token === null ? null : await this.token.catch(() => null);
    if (current !== null && Date.parse(current.expiresAt) - Date.now() < 5 * 60_000) {
      this.token = null;
      await this.tokens.revoke(current);
    }
    this.token ??= this.tokens.mint(this.installationId, this.scope);
    return (await this.token).value();
  }

  async release(): Promise<void> {
    const t = this.token;
    this.token = null;
    if (t === null) return;
    try {
      await this.tokens.revoke(await t);
    } catch {
      // never minted
    }
  }
}
