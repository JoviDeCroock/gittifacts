import { expect, it } from "vitest";
import { nextId } from "../src/ids.js";

it("allocates the next id", () => {
  expect(nextId([3, 9])).toBe(10);
  expect(nextId([])).toBe(1);
});
