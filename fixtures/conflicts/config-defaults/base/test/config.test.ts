import { expect, it } from "vitest";
import { withDefaults } from "../src/config.js";

it("overrides defaults", () => {
  expect(withDefaults({ retries: 5 }).retries).toBe(5);
});
