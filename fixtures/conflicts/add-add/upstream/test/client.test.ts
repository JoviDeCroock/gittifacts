import { expect, it } from "vitest";
import { endpoint, retries } from "../src/client.js";

it("builds versioned URLs", () => {
  expect(endpoint("users")).toBe("/api/v2/users");
  expect(retries).toBe(5);
});
