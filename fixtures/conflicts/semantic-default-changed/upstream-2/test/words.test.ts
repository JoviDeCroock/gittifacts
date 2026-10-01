import { expect, it } from "vitest";
import { countWords } from "../src/words.js";

it("counts words", () => {
  expect(countWords("  a b ")).toBe(2);
});
