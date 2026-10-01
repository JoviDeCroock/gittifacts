import { describe, expect, it } from "vitest";
import { run } from "../src/handlers.js";

describe("handlers", () => {
  it("upper and lower", () => {
    expect(run("upper", "aB")).toBe("AB");
    expect(run("lower", "aB")).toBe("ab");
  });
  it("rejects unknown names", () => {
    expect(() => run("nope", "x")).toThrow("unknown handler: nope");
  });
});
