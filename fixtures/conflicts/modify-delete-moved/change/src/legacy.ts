/** Parses "a=1;b=2" into an object. */
export function parsePairs(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of input.split(";")) {
    const eq = part.indexOf("=");
    const key = (eq === -1 ? part : part.slice(0, eq)).trim();
    const value = eq === -1 ? "" : part.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}
