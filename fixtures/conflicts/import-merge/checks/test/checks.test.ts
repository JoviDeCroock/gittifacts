import { expect, it } from "vitest";
import * as report from "../src/report.js";

it("has total, average and peak", () => {
  expect(report.total([1, 2])).toBe(3);
  expect(report.average([2, 4])).toBe(3);
  expect(report.peak([1, 5, 2])).toBe(5);
});
