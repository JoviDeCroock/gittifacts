/**
 * Transcripts carry the agent's short-lived credentials (unclaimed-project bearer tokens, push
 * grants, Artifacts URLs with tokens). They are redacted before anything is stored in R2 or served
 * by the results API; Workflow step outputs that hold them are marked sensitive.
 */

const PATTERNS: [RegExp, string][] = [
  // Platform tokens (agent, unclaimed, refresh).
  [/\bgt[a-z]_[A-Za-z0-9_-]{8,}/g, "gt*_[redacted]"],
  // Bearer headers and http.extraHeader values.
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]"],
  // JSON "token"/"password"/"secret" fields (any nesting, escaped quotes included).
  [
    /(\\?"(?:token|password|secret|accessToken|refreshToken|access_token|refresh_token)\\?"\s*:\s*\\?")[^"\\]{6,}/gi,
    "$1[redacted]",
  ],
  // Credentials embedded in URLs (https://user:secret@host).
  [/(https?:\/\/[^\s/:@"']+:)[^\s@"']{6,}@/g, "$1[redacted]@"],
  // Token query parameters.
  [/([?&](?:token|access_token|sig|signature)=)[^&\s"']{6,}/gi, "$1[redacted]"],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Redacts every string inside a JSON-like value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  }
  return value;
}
