import { PAGE_SIZE } from "./constants.js";

export function page<T>(items: readonly T[], index: number): T[] {
  return items.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE);
}
