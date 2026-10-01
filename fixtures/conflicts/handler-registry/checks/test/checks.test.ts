import { expect, it } from "vitest";
import { handlers, run } from "../src/handlers.js";

it("keeps every handler from both sides", () => {
  expect(Object.keys(handlers).sort()).toEqual(["lower", "reverse", "trim", "upper"]);
  expect(run("reverse", "abc")).toBe("cba");
  expect(run("trim", "  x ")).toBe("x");
  expect(run("upper", "x")).toBe("X");
});
