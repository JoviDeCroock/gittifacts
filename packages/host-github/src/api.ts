/**
 * A small GitHub REST client for one installation (docs/research/github-app.md §5):
 * - `X-GitHub-Api-Version: 2026-03-10` on every call (decision 11);
 * - conditional GETs: the ETag of every read is kept and sent as `If-None-Match`; a 304 costs
 *   nothing against the rate limit and returns the cached body;
 * - writes go through the installation's `WriteGovernor` (serialized, ≤ 80/min, ≤ 500/h);
 * - 403/429 rate limits become `GithubRateLimited` (retry-after, or the reset time, or 60 s);
 * - tokens come from a provider and never appear in errors or logs.
 */
import { GithubRateLimited, type WriteGate, WriteGovernor } from "./governor.js";

export const GITHUB_API = "https://api.github.com";
export const GITHUB_API_VERSION = "2026-03-10";

export class GithubHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "GithubHttpError";
  }
}

export interface EtagCache {
  get(key: string): { etag: string; body: unknown } | undefined;
  set(key: string, value: { etag: string; body: unknown }): void;
}

export interface GithubApiOptions {
  /** Bearer token for each call (an installation token; never logged). */
  token: () => Promise<string>;
  fetch?: typeof fetch;
  apiBase?: string;
  governor?: WriteGate;
  etags?: EtagCache;
  now?: () => number;
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export class GithubApi {
  readonly governor: WriteGate;
  private readonly etags: EtagCache;
  private readonly base: string;

  constructor(private readonly opts: GithubApiOptions) {
    this.governor = opts.governor ?? new WriteGovernor();
    this.etags = opts.etags ?? new Map();
    this.base = opts.apiBase ?? GITHUB_API;
  }

  async get<T = unknown>(path: string): Promise<T> {
    return (await this.call("GET", path)) as T;
  }

  /**
   * A GraphQL query (a read: GitHub's GraphQL budget is points, not content writes, so it isn't
   * governed). Errors in the body throw. Mutations go through `write("POST", "/graphql", …)`.
   */
  async graphql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T> {
    const out = (await this.call("POST", "/graphql", { query, variables })) as {
      data?: T;
      errors?: { message?: string }[];
    };
    if (out.errors !== undefined && out.errors.length > 0) {
      throw new GithubHttpError(
        502,
        "/graphql",
        `GitHub GraphQL: ${String(out.errors[0]?.message ?? "error").slice(0, 200)}`,
      );
    }
    if (out.data === undefined)
      throw new GithubHttpError(502, "/graphql", "GitHub GraphQL: no data");
    return out.data;
  }

  /** A content-creating or updating request (POST/PATCH/PUT/DELETE), governed. */
  async write<T = unknown>(
    method: Exclude<Method, "GET">,
    path: string,
    body?: unknown,
  ): Promise<T> {
    return (await this.governor.run(() => this.call(method, path, body))) as T;
  }

  private async call(method: Method, path: string, body?: unknown): Promise<unknown> {
    const headers = new Headers({
      accept: "application/vnd.github+json",
      "x-github-api-version": GITHUB_API_VERSION,
      "user-agent": "gittifacts",
      authorization: `Bearer ${await this.opts.token()}`,
    });
    const cached = method === "GET" ? this.etags.get(path) : undefined;
    if (cached !== undefined) headers.set("if-none-match", cached.etag);
    if (body !== undefined) headers.set("content-type", "application/json");
    const doFetch = this.opts.fetch ?? fetch;
    const res = await doFetch(`${this.base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 304 && cached !== undefined) {
      await res.body?.cancel();
      return cached.body;
    }
    if (res.status === 403 || res.status === 429) {
      const limited = rateLimitOf(res, this.opts.now?.() ?? Date.now());
      if (limited !== null) {
        await res.body?.cancel();
        throw limited;
      }
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = "";
      try {
        msg = String((JSON.parse(text) as { message?: unknown }).message ?? "");
      } catch {
        // not JSON
      }
      throw new GithubHttpError(
        res.status,
        path,
        `GitHub ${method} ${path}: ${res.status}${msg ? ` ${msg.slice(0, 200)}` : ""}`,
      );
    }
    const out: unknown = text === "" ? null : JSON.parse(text);
    const etag = res.headers.get("etag");
    if (method === "GET" && etag !== null) this.etags.set(path, { etag, body: out });
    return out;
  }
}

/** A 403/429 that is a rate limit (primary or secondary), as a retry-after. */
export function rateLimitOf(res: Response, nowMs: number): GithubRateLimited | null {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter !== null && /^\d+$/.test(retryAfter))
    return new GithubRateLimited(Number(retryAfter));
  if (res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? "0") * 1000;
    return new GithubRateLimited(Math.max(1, Math.ceil((reset - nowMs) / 1000)));
  }
  // Secondary limits without headers: "wait for at least one minute".
  return res.status === 429 ? new GithubRateLimited(60) : null;
}
