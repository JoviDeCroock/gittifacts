import { stripAnsi } from "@app/evidence";

/**
 * Human logs go to stderr; stdout is reserved for the single `::evidence::` / `::plan::` line.
 * Secrets are scrubbed from everything written here.
 */

const SECRET_ENV = ["GITTIFACTS_TOKEN", "GIT_CONFIG_VALUE_0"] as const;

/** Replace any known secret value (and bearer tokens) in `text`. */
export function redact(text: string): string {
  let out = text;
  for (const name of SECRET_ENV) {
    const value = process.env[name];
    if (value !== undefined && value.length >= 6) out = out.split(value).join("***");
  }
  return out.replace(/(Authorization:\s*Bearer\s+)\S+/gi, "$1***");
}

let quiet = false;

export function setQuiet(value: boolean): void {
  quiet = value;
}

export function log(message: string): void {
  if (quiet) return;
  process.stderr.write(`[gittifacts-runner] ${redact(message)}\n`);
}

/** Raw passthrough of a child process' output to stderr (already line-oriented). */
export function passthrough(chunk: string): void {
  if (quiet) return;
  process.stderr.write(redact(chunk));
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}

/** Last `lines` lines of `text`, trimmed; for notes on failed tool runs. */
export function tail(text: string, lines = 20, maxChars = 1500): string {
  const t = stripAnsi(text).trim().split("\n").slice(-lines).join("\n");
  return t.length > maxChars ? `…${t.slice(-maxChars)}` : t;
}
