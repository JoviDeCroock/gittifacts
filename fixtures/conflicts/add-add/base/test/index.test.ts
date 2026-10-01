import { expect, it } from "vitest";
import { name } from "../src/index.js";

it("has a name", () => {
  expect(name).toBe("corpus");
});
