import { listItems } from "./items.js";

export function itemCount(): number {
  return listItems().length;
}
