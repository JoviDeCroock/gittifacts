import { expect, it } from "vitest";
import { itemCount } from "../src/count.js";
import { listItems } from "../src/items.js";
import { preview } from "../src/preview.js";

it("the preview uses the options form; paging still works", () => {
  expect(preview()).toBe("apple, banana");
  expect(listItems({ offset: 3 })).toEqual(["date", "elderberry"]);
  expect(itemCount()).toBe(5);
});
