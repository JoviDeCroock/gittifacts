import { expect, it } from "vitest";
import { area } from "../src/shapes.js";

it("rectangle", () => {
  expect(area({ kind: "rectangle", width: 2, height: 5 })).toBe(10);
});
