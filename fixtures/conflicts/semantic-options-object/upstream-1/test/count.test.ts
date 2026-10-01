import { expect, it } from "vitest";
import { itemCount } from "../src/count.js";

it("counts items", () => {
  expect(itemCount()).toBe(5);
});
