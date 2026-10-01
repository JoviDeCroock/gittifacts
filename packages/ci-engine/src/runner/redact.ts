/**
 * Log redaction. Applied to everything a container prints before it is stored or returned.
 *
 * Exact secrets (the step's read token, in raw and URL-encoded form) are replaced, and so is
 * anything shaped like an Artifacts token or a Bearer header, since tokens are opaque and their
 * format already differs between docs (`art_v1_`) and production (`art_v2_e_`).
 */

export const REDACTED = "[REDACTED]";

const GENERIC_PATTERNS: readonly RegExp[] = [
  /art_v\d+_[A-Za-z0-9_]+(?:(?:\?|%3[Ff])expires(?:=|%3[Dd])\d+)?/g,
  /(Authorization:\s*(?:Bearer|Basic)\s+)[^\s'"]+/gi,
  /(https?:\/\/[^\s:/@'"]+:)[^\s@/'"]+@/g,
];

function escapeRegExp(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  for (const re of GENERIC_PATTERNS) {
    out = out.replace(re, (match, prefix: unknown) =>
      typeof prefix === "string"
        ? `${prefix}${REDACTED}${match.endsWith("@") ? "@" : ""}`
        : REDACTED,
    );
  }
  return out;
}

/** The secret plus encodings it commonly appears in. */
export function secretVariants(secret: string): string[] {
  const variants = new Set([secret, encodeURIComponent(secret)]);
  const q = secret.indexOf("?");
  if (q > 0) variants.add(secret.slice(0, q));
  return [...variants].filter((v) => v.length >= 8);
}

export interface StreamRedactor {
  /** Feeds decoded text; returns what is safe to emit now. */
  push(text: string): string;
  /** Emits whatever is still held back. */
  flush(): string;
}

/**
 * Holds back the trailing partial line so a secret split across chunks is still caught. A line
 * longer than `maxHold` is emitted except for its last `overlap` characters.
 */
export function createStreamRedactor(
  secrets: readonly string[],
  opts: { maxHold?: number; overlap?: number } = {},
): StreamRedactor {
  const all = secrets.flatMap(secretVariants);
  const maxHold = opts.maxHold ?? 64 * 1024;
  const overlap = Math.max(opts.overlap ?? 1024, ...all.map((s) => s.length));
  let held = "";
  return {
    push(text) {
      held += text;
      const nl = held.lastIndexOf("\n");
      let cut = nl === -1 ? 0 : nl + 1;
      if (cut === 0 && held.length > maxHold) cut = held.length - overlap;
      if (cut === 0) return "";
      const ready = held.slice(0, cut);
      held = held.slice(cut);
      return redactText(ready, all);
    },
    flush() {
      const ready = held;
      held = "";
      return redactText(ready, all);
    },
  };
}
