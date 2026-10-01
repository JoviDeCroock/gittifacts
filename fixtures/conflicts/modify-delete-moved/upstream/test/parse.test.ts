import { expect, it } from "vitest";
import { parseFlags, parseList } from "../src/index.js";

it("parses lists and flags", () => {
  expect(parseList("a, b,,c")).toEqual(["a", "b", "c"]);
  expect(parseFlags("--a --no-b x")).toEqual({ a: true, b: false });
});
