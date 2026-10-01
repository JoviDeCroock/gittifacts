import { expect, it } from "vitest";
import { area } from "../src/shapes.js";

it("circle and square", () => {
  expect(area({ kind: "square", side: 3 })).toBe(9);
  expect(area({ kind: "circle", r: 1 })).toBeCloseTo(Math.PI);
});
