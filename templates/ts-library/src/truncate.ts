export interface TruncateOptions {
  /** Appended when the text is cut. Counts towards `maxLength`. Default "…". */
  ellipsis?: string;
}

/** Shortens `text` to at most `maxLength` characters, ending with `ellipsis` when cut. */
export function truncate(text: string, maxLength: number, options: TruncateOptions = {}): string {
  if (!Number.isInteger(maxLength) || maxLength < 0) {
    throw new RangeError(`maxLength must be a non-negative integer, got ${maxLength}`);
  }
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  const ellipsis = Array.from(options.ellipsis ?? "…");
  if (ellipsis.length >= maxLength) return ellipsis.slice(0, maxLength).join("");
  return chars.slice(0, maxLength - ellipsis.length).join("").trimEnd() + ellipsis.join("");
}
