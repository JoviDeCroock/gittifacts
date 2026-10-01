import { expect, it } from "vitest";
import { run } from "../src/handlers.js";

it("reverses unicode safely", () => {
  expect(run("reverse", "abc")).toBe("cba");
  expect(run("reverse", "a😀b")).toBe("b😀a");
});
