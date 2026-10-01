/**
 * Errors the CLI prints: always the platform's envelope `{ error: { code, message, fix } }`, so an
 * agent parses one shape whether the error came from the server, the network or the CLI itself.
 */
import type { ApiError, ErrorFix } from "@app/domain";
import { isRecord } from "./tools/schema.js";

export type { ErrorFix };
export type ErrorBody = ApiError["error"];

/** Process exit codes (documented in README.md and `gittifacts help`). */
export const EXIT = {
  /** The command did what was asked. */
  ok: 0,
  /** An error document `{ error }` was printed: platform, network, auth or local failure. */
  error: 1,
  /** Bad usage (unknown command or flag, missing argument); nothing was sent. `{ error }` printed. */
  usage: 2,
  /** `wait`: the milestone was not reached (timeout or unreachable). The result is printed. */
  notReached: 3,
  /** Interrupted with Ctrl-C. `{ error: { code: "interrupted" } }` printed. */
  interrupted: 130,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  /** Printed next to `error` (e.g. the `idempotencyKey` to retry with). */
  readonly meta: Record<string, unknown> = {};

  constructor(
    readonly body: ErrorBody,
    readonly exitCode: ExitCode = EXIT.error,
  ) {
    super(body.message);
    this.name = "CliError";
  }
}

export function cliError(
  code: string,
  message: string,
  fix: ErrorFix,
  opts: { details?: unknown; exitCode?: ExitCode } = {},
): CliError {
  return new CliError(
    { code, message, fix, ...(opts.details !== undefined ? { details: opts.details } : {}) },
    opts.exitCode ?? EXIT.error,
  );
}

export function usageError(message: string, fix: ErrorFix, details?: unknown): CliError {
  return cliError("usage", message, fix, { details, exitCode: EXIT.usage });
}

/** The platform's envelope, if `v` is one (from a tool error's text or an HTTP error body). */
export function asEnvelope(v: unknown): ErrorBody | null {
  if (!isRecord(v) || !isRecord(v.error)) return null;
  const e = v.error;
  if (typeof e.code !== "string" || typeof e.message !== "string" || !isRecord(e.fix)) return null;
  if (typeof e.fix.explanation !== "string") return null;
  const fix: ErrorFix = { explanation: e.fix.explanation };
  if (typeof e.fix.call === "string") fix.call = e.fix.call;
  if (typeof e.fix.command === "string") fix.command = e.fix.command;
  if (typeof e.fix.docsUrl === "string") fix.docsUrl = e.fix.docsUrl;
  return {
    code: e.code,
    message: e.message,
    fix,
    ...("details" in e ? { details: e.details } : {}),
  };
}

export function parseEnvelope(text: string): ErrorBody | null {
  try {
    return asEnvelope(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Codes where retrying the same call (with the same idempotency key) is the right move. */
export const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "network",
  "timeout",
  "upstream",
  "internal",
  "rate-limited",
  "idempotency-key-in-flight",
]);
