import { expect, it } from "vitest";
import { parsePairs } from "../src/index.js";

it("keeps '=' in values and trims", () => {
  expect(parsePairs("t=ab==")).toEqual({ t: "ab==" });
  expect(parsePairs(" a = 1 ;b=2")).toEqual({ a: "1", b: "2" });
});
