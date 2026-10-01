import { describe, expect, it } from "vitest";
import * as math from "../src/math.js";

describe("math", () => {
  it("adds", () => {
    expect(math.add(2, 3)).toBe(5);
  });

  it("subtracts", () => {
    expect(math.sub(2, 3)).toBe(-1);
  });
});
