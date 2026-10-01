import { expect, it } from "vitest";
import { listItems } from "../src/items.js";

it("lists every item by default", () => {
  expect(listItems()).toHaveLength(5);
});
