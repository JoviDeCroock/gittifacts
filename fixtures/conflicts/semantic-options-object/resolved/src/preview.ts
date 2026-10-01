import { listItems } from "./items.js";

export function preview(): string {
  return listItems({ limit: 2 }).join(", ");
}
