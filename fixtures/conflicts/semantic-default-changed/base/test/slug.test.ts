import { expect, it } from "vitest";
import { slugify } from "../src/slug.js";

it("slugifies with an explicit separator", () => {
  expect(slugify("  Hello   World ", "+")).toBe("hello+world");
});
