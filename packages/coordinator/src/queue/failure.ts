/**
 * Why a merge-queue command failed, in a form that is safe to store, audit and show: the error's
 * class and its message, with anything that looks like a credential removed. Queue jobs mint
 * short-lived git tokens and pass them in headers and remotes, so an error from git or fetch can
 * carry one; nothing here may leak it into the audit log or the queue view.
 */

export interface CommandFailure {
  /** `Error.name` (or the constructor's name, or the thrown value's type). */
  errorClass: string;
  /** The redacted message, at most MESSAGE_MAX characters. */
  message: string;
}

const MESSAGE_MAX = 1000;
export const REDACTED = "[redacted]";

/** Patterns of secrets an error message may carry. Each keeps its prefix so the text still reads. */
const SECRET_PATTERNS: [RegExp, string][] = [
  // HTTP auth headers and schemes: "Authorization: Bearer x", "Bearer x", "Basic x".
  [/\b(authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*[^\s"',;]+/gi, `$1${REDACTED}`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // Credentials in URLs: https://user:secret@host, https://token@host.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:"']+(?::[^\s/@"']*)?@/gi, `$1${REDACTED}@`],
  // key=value / key: value pairs whose key names a secret.
  [
    /\b((?:access[_-]?)?token|secret|password|passwd|api[_-]?key|client[_-]?secret|signature)(["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi,
    `$1$2${REDACTED}`,
  ],
  // Known token shapes: gittifacts agent tokens, GitHub tokens, JWTs.
  [/\bgtf_[A-Za-z0-9_-]{6,}/g, REDACTED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
];

/** Remove credentials from free text (error messages, job output tails). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function classOf(e: unknown): string {
  if (e instanceof Error) {
    const name = e.name !== "" ? e.name : e.constructor.name;
    return name === "" ? "Error" : name;
  }
  if (e === null) return "null";
  if (typeof e === "object") return (e as object).constructor?.name ?? "object";
  return typeof e;
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

/** The class and redacted message of anything a handler threw. Never throws. */
export function describeFailure(e: unknown): CommandFailure {
  const raw = messageOf(e).replace(/\s+/g, " ").trim();
  const message = redactSecrets(raw);
  return {
    errorClass: classOf(e).slice(0, 100),
    message:
      message === ""
        ? "(no message)"
        : message.length > MESSAGE_MAX
          ? `${message.slice(0, MESSAGE_MAX - 1)}…`
          : message,
  };
}

/** One line for logs, the outbox's `last_error` and protocol results: "TypeError: fetch failed". */
export function failureText(f: CommandFailure): string {
  return `${f.errorClass}: ${f.message}`;
}

/** Parse `failureText` back (outbox rows store the text). Unknown shapes keep the whole text. */
export function parseFailureText(text: string): CommandFailure {
  const m = /^([A-Za-z_$][\w$.]{0,99}): ([\s\S]*)$/.exec(text);
  return m === null
    ? { errorClass: "Error", message: text }
    : { errorClass: m[1] ?? "Error", message: m[2] ?? "" };
}
