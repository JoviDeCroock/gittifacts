import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { parseFlags, parseList, parsePairs } from "../src/index.js";

it("has the fix in the moved parser and no legacy module", () => {
  expect(parsePairs("t=ab==; a = 1 ")).toEqual({ t: "ab==", a: "1" });
  expect(parseList("a,b")).toEqual(["a", "b"]);
  expect(parseFlags("--x")).toEqual({ x: true });
  expect(existsSync(new URL("../src/legacy.ts", import.meta.url))).toBe(false);
});
