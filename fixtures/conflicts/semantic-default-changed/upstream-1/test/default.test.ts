import { expect, it } from "vitest";
import { slugify } from "../src/slug.js";

it("joins with underscores by default", () => {
  expect(slugify("A B")).toBe("a_b");
  expect(slugify("A B", "-")).toBe("a-b");
});
