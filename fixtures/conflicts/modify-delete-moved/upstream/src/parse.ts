/** Parsers for the small text formats the CLI accepts. */

/** Parses "a,b,,c" into ["a", "b", "c"]. */
export function parseList(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Parses "--a --no-b" into { a: true, b: false }. */
export function parseFlags(input: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const token of input.split(/\s+/)) {
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    if (name.startsWith("no-")) out[name.slice(3)] = false;
    else if (name !== "") out[name] = true;
  }
  return out;
}

/** Parses "a=1;b=2" into an object. */
export function parsePairs(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of input.split(";")) {
    const [key, value] = part.split("=");
    if (key) out[key] = value ?? "";
  }
  return out;
}
