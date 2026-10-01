export function slugify(text: string, separator = "_"): string {
  return text
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "")
    .join(separator);
}
