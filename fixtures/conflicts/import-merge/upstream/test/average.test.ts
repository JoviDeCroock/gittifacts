import { expect, it } from "vitest";
import { average } from "../src/report.js";

it("averages", () => {
  expect(average([2, 4])).toBe(3);
  expect(average([])).toBe(0);
});
