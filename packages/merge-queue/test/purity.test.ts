import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The core must be pure and IO-free: time comes from events, randomness only in the simulator.
const FORBIDDEN = [
  /Date\.now/,
  /new Date\(/,
  /Math\.random/,
  /\bfetch\(/,
  /setTimeout|setInterval/,
  /crypto\./,
  /cloudflare:/,
  /process\./,
];

describe("purity", () => {
  it("src/ uses no clock, randomness or IO", () => {
    const dir = join(import.meta.dirname, "..", "src");
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f), "utf8");
      for (const re of FORBIDDEN) expect(re.test(text), `${f} matches ${re}`).toBe(false);
    }
  });
});
