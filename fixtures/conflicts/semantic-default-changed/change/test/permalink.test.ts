import { expect, it } from "vitest";
import { permalink } from "../src/permalink.js";

it("builds dashed permalinks", () => {
  expect(permalink("Hello World")).toBe("/posts/hello-world");
});
