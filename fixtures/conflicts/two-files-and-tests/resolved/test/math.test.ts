import { describe, expect, it } from "vitest";
import * as math from "../src/math.js";

describe("math", () => {
  it("adds", () => {
    expect(math.add(2, 3)).toBe(5);
  });

  it("subtracts", () => {
    expect(math.sub(2, 3)).toBe(-1);
  });

  it("multiplies", () => {
    expect(math.mul(4, 3)).toBe(12);
  });

  it("divides and refuses zero", () => {
    expect(math.div(6, 3)).toBe(2);
    expect(() => math.div(1, 0)).toThrow(RangeError);
  });
});
