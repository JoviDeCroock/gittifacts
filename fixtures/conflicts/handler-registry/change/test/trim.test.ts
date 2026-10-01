import { expect, it } from "vitest";
import { run } from "../src/handlers.js";

it("trims", () => {
  expect(run("trim", "  a b  ")).toBe("a b");
});
