import { expect, it } from "vitest";
import { defaults, withDefaults } from "../src/config.js";

it("verbose is off by default", () => {
  expect(defaults.verbose).toBe(false);
  expect(withDefaults({ verbose: true }).verbose).toBe(true);
});
