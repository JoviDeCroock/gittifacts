import { expect, it } from "vitest";
import { listItems } from "../src/items.js";

it("pages with limit and offset", () => {
  expect(listItems({ offset: 1, limit: 2 })).toEqual(["banana", "cherry"]);
});
