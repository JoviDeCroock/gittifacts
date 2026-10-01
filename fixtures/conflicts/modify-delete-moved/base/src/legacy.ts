/** Parses "a=1;b=2" into an object. */
export function parsePairs(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of input.split(";")) {
    const [key, value] = part.split("=");
    if (key) out[key] = value ?? "";
  }
  return out;
}
