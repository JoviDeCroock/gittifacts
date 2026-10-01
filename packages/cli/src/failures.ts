/**
 * Maps anything a call can throw (SDK transport errors, HTTP statuses, network failures, aborted
 * requests) to the platform's error envelope, each with a `fix`.
 */
import { ProtocolError, SdkError, SdkErrorCode, SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client";
import { CliError, cliError, EXIT, parseEnvelope } from "./errors.js";
import { isRecord } from "./tools/schema.js";

export interface FailureContext {
  host: string;
  mcpUrl: string;
  /** The command being run, for fixes that point back at it. */
  command: string;
  tokenSource: string | null;
}

export function unauthorized(ctx: FailureContext, detail?: string): CliError {
  const had = ctx.tokenSource !== null;
  return cliError(
    "unauthorized",
    had
      ? `the platform rejected your token (from ${ctx.tokenSource})${detail ? `: ${detail}` : ""}`
      : "this call needs a token and none is configured",
    {
      explanation: had
        ? "The token is invalid, expired or revoked. Log in again (OAuth device flow), or set GITTIFACTS_TOKEN to an agent token a human created for you."
        : "Log in (OAuth device flow), or set GITTIFACTS_TOKEN to an agent token a human created for you. No account? `gittifacts init` creates an unclaimed project with its own token.",
      command: `gittifacts login --host ${ctx.host}`,
    },
  );
}

function network(ctx: FailureContext, e: unknown): CliError {
  const cause = e instanceof Error && isRecord(e.cause) ? e.cause : null;
  const code = cause && typeof cause.code === "string" ? cause.code : undefined;
  return cliError(
    "network",
    `could not reach ${ctx.mcpUrl}${code ? ` (${code})` : ""}`,
    {
      explanation: `Check the host (${ctx.host}) and your connection, then retry. Retrying a mutating command with the same --idempotency-key is safe.`,
      command: `curl -sS ${ctx.host}/start`,
    },
    { details: e instanceof Error ? e.message : String(e) },
  );
}

function httpFailure(ctx: FailureContext, status: number, text: string | null): CliError {
  const envelope = text ? parseEnvelope(text) : null;
  if (envelope) return new CliError(envelope);
  let oauthDetail: string | undefined;
  try {
    const body: unknown = text ? JSON.parse(text) : null;
    if (isRecord(body) && typeof body.error_description === "string") oauthDetail = body.error_description;
  } catch {
    // not JSON
  }
  if (status === 401) return unauthorized(ctx, oauthDetail);
  if (status === 403) {
    return cliError("forbidden", `the platform refused this call (HTTP 403)${oauthDetail ? `: ${oauthDetail}` : ""}`, {
      explanation: "Your token lacks the scope or the repo access this needs. whoami shows your scopes; ask the human who owns this agent to grant more.",
      command: "gittifacts whoami",
    });
  }
  if (status === 404 || status === 405) {
    return cliError("not-found", `no MCP endpoint at ${ctx.mcpUrl} (HTTP ${status})`, {
      explanation: "Check --host: it should be the platform origin, whose /start page names the MCP URL.",
      command: `curl -sS ${ctx.host}/start`,
    });
  }
  if (status === 429) {
    return cliError("rate-limited", "too many requests (HTTP 429)", {
      explanation: "Wait a little and retry with the same --idempotency-key.",
      command: "sleep 10",
    });
  }
  return cliError(
    "upstream",
    `the platform answered HTTP ${status}`,
    { explanation: "Retry shortly; retrying with the same --idempotency-key is safe." },
    { details: text ?? undefined },
  );
}

export function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || /aborted/i.test(e.message));
}

export function unknownTool(ctx: FailureContext, tool: string): CliError {
  return cliError("unknown-tool", `${ctx.host} has no MCP tool named ${tool}`, {
    explanation: `This platform build doesn't offer ${tool} (yet). List what it has, or upgrade the CLI if it was renamed.`,
    command: "gittifacts tools --remote",
  });
}

export function toCliError(e: unknown, ctx: FailureContext): CliError {
  if (e instanceof CliError) return e;
  if (e instanceof UnauthorizedError) return unauthorized(ctx);
  if (e instanceof SdkHttpError) {
    const text = isRecord(e.data) && typeof e.data.text === "string" ? e.data.text : null;
    return httpFailure(ctx, e.status, text);
  }
  if (e instanceof SdkError) {
    if (e.code === SdkErrorCode.RequestTimeout) {
      return cliError("timeout", "the platform did not answer in time", {
        explanation: "Retry; retrying a mutating command with the same --idempotency-key is safe.",
      });
    }
    if (isRecord(e.data) && typeof e.data.status === "number") {
      return httpFailure(ctx, e.data.status, typeof e.data.text === "string" ? e.data.text : null);
    }
    return network(ctx, e);
  }
  if (e instanceof ProtocolError) {
    const m = /unknown tool:?\s*([\w-]+)|tool ([\w-]+) not found/i.exec(e.message);
    if (m) return unknownTool(ctx, m[1] ?? m[2] ?? "?");
    return cliError("protocol", e.message, {
      explanation: "The MCP server rejected the request. Retry; if it persists, check the CLI version against the platform.",
      command: "gittifacts --version",
    }, { details: { code: e.code } });
  }
  if (e instanceof TypeError && /fetch failed|network/i.test(e.message)) return network(ctx, e);
  if (isAbort(e)) {
    return cliError("interrupted", "interrupted", { explanation: "Run the command again." }, {
      exitCode: EXIT.interrupted,
    });
  }
  return cliError(
    "cli-internal",
    e instanceof Error ? e.message : String(e),
    { explanation: "Unexpected CLI failure. Retry; if it persists, report it with the CLI version.", command: "gittifacts --version" },
  );
}
