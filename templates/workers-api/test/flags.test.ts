import { describe, expect, it } from "vitest";
import { changeFlagKey, type FlagsBinding, isChangeEnabled } from "../src/flags.js";

const binding = (value: boolean | Error, seen: string[] = []): FlagsBinding => ({
  async getBooleanValue(key, defaultValue) {
    seen.push(key);
    if (value instanceof Error) throw value;
    return value ?? defaultValue;
  },
});

describe("isChangeEnabled", () => {
  it("reads the change's flag", async () => {
    const seen: string[] = [];
    expect(await isChangeEnabled({ FLAGS: binding(false, seen) }, "k3j9")).toBe(false);
    expect(await isChangeEnabled({ FLAGS: binding(true) }, "k3j9")).toBe(true);
    expect(seen).toEqual([changeFlagKey("k3j9")]);
    expect(changeFlagKey("k3j9")).toBe("change-k3j9");
  });

  it("counts the change as on without a binding (tests, previews, wrangler dev)", async () => {
    expect(await isChangeEnabled({}, "k3j9")).toBe(true);
  });

  it("counts the change as on when the flag can't be evaluated", async () => {
    expect(await isChangeEnabled({ FLAGS: binding(new Error("unavailable")) }, "k3j9")).toBe(true);
  });
});
