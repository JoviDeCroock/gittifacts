/**
 * Per-invocation state shared by every command: IO, global flags, output, the resolved host and
 * token, and a connection helper that turns any failure into an error envelope with a `fix`.
 */
import type { Globals } from "./args.js";
import { shellQuote } from "./calls.js";
import {
  type Credentials,
  credentialsPath,
  findProject,
  mcpUrlFor,
  noHostError,
  type ProjectConfig,
  type ResolvedToken,
  readCredentials,
  resolveHost,
  resolveToken,
} from "./config.js";
import { type FailureContext, toCliError } from "./failures.js";
import type { CliIo } from "./io.js";
import type { McpConnection } from "./mcp.js";
import type { Output } from "./output.js";

export interface Target {
  host: string;
  hostSource: string;
  mcpUrl: string;
  token: ResolvedToken | null;
}

export class Ctx {
  private projectCache: { path: string; config: ProjectConfig } | null | undefined;
  private credsCache: Credentials | undefined;

  constructor(
    readonly io: CliIo,
    readonly argv: readonly string[],
    readonly globals: Globals,
    readonly out: Output,
  ) {}

  get credentialsPath(): string {
    return credentialsPath(this.io.env, this.io.home);
  }

  project(): { path: string; config: ProjectConfig } | null {
    if (this.projectCache === undefined) this.projectCache = findProject(this.io.cwd);
    return this.projectCache;
  }

  creds(): Credentials {
    this.credsCache ??= readCredentials(this.credentialsPath);
    return this.credsCache;
  }

  /** Forget cached credentials after a command rewrote them. */
  invalidate(): void {
    this.credsCache = undefined;
  }

  targetOrNull(): Target | null {
    const project = this.project()?.config ?? null;
    const resolved = resolveHost(this.globals.host, this.io.env, project, this.creds());
    if (!resolved) return null;
    return {
      host: resolved.host,
      hostSource: resolved.source,
      mcpUrl: mcpUrlFor(resolved.host, project, this.io.env),
      token: resolveToken(resolved.host, this.io.env, this.creds(), project, this.io.now()),
    };
  }

  target(): Target {
    const t = this.targetOrNull();
    if (!t) throw noHostError();
    return t;
  }

  failureContext(target: Target, command: string): FailureContext {
    return {
      host: target.host,
      mcpUrl: target.mcpUrl,
      command,
      tokenSource: target.token ? target.token.source : null,
    };
  }

  /**
   * Connects, runs `fn`, closes. Any failure (connect, call, or thrown by `fn`) becomes a CliError
   * carrying `meta` (e.g. the idempotency key to retry with).
   */
  async withConnection<T>(
    target: Target,
    command: string,
    opts: { headers?: Record<string, string>; meta?: Record<string, unknown> },
    fn: (conn: McpConnection) => Promise<T>,
  ): Promise<T> {
    let conn: McpConnection | undefined;
    try {
      conn = await this.io.connect({
        mcpUrl: target.mcpUrl,
        token: target.token?.token ?? null,
        headers: opts.headers ?? {},
        fetch: this.io.fetch,
      });
      return await fn(conn);
    } catch (e) {
      const err = toCliError(e, this.failureContext(target, command));
      Object.assign(err.meta, opts.meta ?? {});
      // The platform's own unauthorized envelope names the header; the CLI can name the command.
      if (err.body.code === "unauthorized" && err.body.fix.command === undefined) {
        err.body.fix = { ...err.body.fix, command: `gittifacts login --host ${target.host}` };
      }
      throw err;
    } finally {
      await conn?.close().catch(() => undefined);
    }
  }

  newIdempotencyKey(): string {
    return `cli_${this.io.randomId()}`;
  }

  /** This invocation as a shell command, with `--idempotency-key` set to `key`. */
  retryCommand(key: string): string {
    const out: string[] = [];
    for (let i = 0; i < this.argv.length; i++) {
      const a = this.argv[i] ?? "";
      if (a === "--idempotency-key") {
        i += 1;
        continue;
      }
      if (a.startsWith("--idempotency-key=")) continue;
      out.push(shellQuote(a));
    }
    return ["gittifacts", ...out, "--idempotency-key", shellQuote(key)].join(" ");
  }
}
