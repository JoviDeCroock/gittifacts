import { expect, it } from "vitest";
import { parsePairs } from "../src/index.js";

it("parses pairs", () => {
  expect(parsePairs("a=1;b=2")).toEqual({ a: "1", b: "2" });
});
