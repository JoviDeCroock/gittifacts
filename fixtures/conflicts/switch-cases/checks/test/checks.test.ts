import { expect, it } from "vitest";
import { area } from "../src/shapes.js";

it("handles all four shapes", () => {
  expect(area({ kind: "square", side: 3 })).toBe(9);
  expect(area({ kind: "rectangle", width: 2, height: 5 })).toBe(10);
  expect(area({ kind: "triangle", base: 4, height: 3 })).toBe(6);
  expect(area({ kind: "circle", r: 2 })).toBeCloseTo(4 * Math.PI);
});
