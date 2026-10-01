import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as math from "../src/math.js";

it("keeps both functions and both tests", () => {
  expect(math.mul(4, 3)).toBe(12);
  expect(math.div(6, 3)).toBe(2);
  expect(() => math.div(1, 0)).toThrow(RangeError);
  const tests = readFileSync(new URL("./math.test.ts", import.meta.url), "utf8");
  expect(tests).toContain("multiplies");
  expect(tests).toContain("divides and refuses zero");
});
