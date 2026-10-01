export interface SlugifyOptions {
  /** Joins words. Default "-". */
  separator?: string;
  /** Maximum length of the result (cut at a word boundary when possible). */
  maxLength?: number;
}

/** "Héllo, World!" → "hello-world". Strips accents and anything that is not a letter or digit. */
export function slugify(input: string, options: SlugifyOptions = {}): string {
  const separator = options.separator ?? "-";
  const words = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
  let slug = words.join(separator);
  const max = options.maxLength;
  if (max !== undefined && slug.length > max) {
    const cut = slug.slice(0, max);
    const lastSep = separator === "" ? -1 : cut.lastIndexOf(separator);
    slug = lastSep > 0 ? cut.slice(0, lastSep) : cut;
  }
  return slug;
}
