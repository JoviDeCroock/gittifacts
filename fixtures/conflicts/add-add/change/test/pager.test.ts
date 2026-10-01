import { expect, it } from "vitest";
import { page } from "../src/pager.js";

it("pages by 50", () => {
  const items = Array.from({ length: 120 }, (_, i) => i);
  expect(page(items, 0)).toHaveLength(50);
  expect(page(items, 2)).toEqual(items.slice(100));
});
