import { listItems } from "./items.js";

export function preview(): string {
  return listItems(2).join(", ");
}
