/** "hello world" → "Hello World". */
export function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .filter((word) => word !== "")
    .map((word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
