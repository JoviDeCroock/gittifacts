import { expect, it } from "vitest";
import { total } from "../src/report.js";

it("totals", () => {
  expect(total([1, 2, 3])).toBe(6);
});
