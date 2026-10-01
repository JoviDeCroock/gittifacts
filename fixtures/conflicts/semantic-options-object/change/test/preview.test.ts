import { expect, it } from "vitest";
import { preview } from "../src/preview.js";

it("previews two items", () => {
  expect(preview()).toBe("apple, banana");
});
