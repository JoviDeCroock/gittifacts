import { slugify } from "./slug.js";

export function permalink(title: string): string {
  return `/posts/${slugify(title)}`;
}
