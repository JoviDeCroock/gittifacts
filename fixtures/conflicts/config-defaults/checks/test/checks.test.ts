import { expect, it } from "vitest";
import { defaults } from "../src/config.js";

it("keeps both keys and the new timeout", () => {
  expect(defaults).toEqual({
    retries: 3,
    timeoutMs: 5000,
    baseUrl: "https://api.example.com",
    verbose: false,
  });
});
