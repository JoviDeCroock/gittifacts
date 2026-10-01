import { expect, it } from "vitest";
import { peak } from "../src/report.js";

it("finds the peak", () => {
  expect(peak([1, 5, 2])).toBe(5);
});
