export function slugify(text: string, separator = "-"): string {
  return text
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "")
    .join(separator);
}
