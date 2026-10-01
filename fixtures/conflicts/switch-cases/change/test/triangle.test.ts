import { expect, it } from "vitest";
import { area } from "../src/shapes.js";

it("triangle", () => {
  expect(area({ kind: "triangle", base: 4, height: 3 })).toBe(6);
});
