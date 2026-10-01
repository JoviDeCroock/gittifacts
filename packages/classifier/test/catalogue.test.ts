import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatReason,
  GATES,
  REASON_CODES,
  REVERT_WAIVABLE_CODES,
  type ReasonCode,
} from "../src/index.js";

const entries = Object.entries(REASON_CODES) as Array<
  [ReasonCode, (typeof REASON_CODES)[ReasonCode]]
>;

describe("REASON_CODES catalogue", () => {
  it("is stable (renaming a code is a breaking change — add new codes instead)", () => {
    expect(entries.map(([code]) => code).sort()).toMatchSnapshot();
  });

  it.each(entries)("%s is well-formed", (code, spec) => {
    expect(code).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    expect(spec.template.length).toBeGreaterThan(0);
    expect(spec.condition.length).toBeGreaterThan(0);
    for (const gate of spec.gates) expect(GATES).toContain(gate);
    if (spec.lane === 0) {
      expect(spec.outcome).toBe("pass");
    } else {
      expect(["fail", "unknown"]).toContain(spec.outcome);
      expect(spec.gates.length).toBeGreaterThan(0);
    }
  });

  it("missing/errored signal codes are 'unknown', never 'fail'", () => {
    for (const [code, spec] of entries) {
      if (code.startsWith("signal.missing.") || code.startsWith("signal.error."))
        expect(spec.outcome).toBe("unknown");
    }
  });

  it("only plan paperwork and size can be waived for a verified revert", () => {
    for (const code of REVERT_WAIVABLE_CODES) expect(code).toMatch(/^(plan\.|size\.)/);
  });

  it("formatReason fills placeholders and leaves unknown ones visible", () => {
    expect(formatReason("size.lines-over-lane0", { lines: 160, max: 150 })).toBe(
      "160 changed lines exceed the Lane 0 limit of 150.",
    );
    expect(formatReason("plan.approved")).toBe("Plan {planId} is approved.");
  });
});

describe("README decision table", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  // Only the "## Decision table" section (other tables mention signal kinds, not codes).
  const section = readme.split(/^## /m).find((s) => s.startsWith("Decision table")) ?? "";
  const rows = new Map<string, string>();
  for (const line of section.split("\n")) {
    const m = /^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/.exec(line);
    if (m?.[1] && m[2]) rows.set(m[1], m[2]);
  }

  it.each(entries)("documents %s with its lane", (code, spec) => {
    const lane = rows.get(code);
    expect(lane, `README is missing a row for ${code}`).toBeDefined();
    expect(lane).toContain(String(spec.lane));
  });

  it("documents no codes that do not exist", () => {
    for (const code of rows.keys()) expect(Object.hasOwn(REASON_CODES, code), code).toBe(true);
  });
});

describe("source purity", () => {
  const dir = new URL("../src/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

  it.each(files)("%s has no clocks, randomness, I/O or globals", (name) => {
    const source = readFileSync(new URL(name, dir), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const forbidden of [
      /\bDate\b/,
      /Math\.random/,
      /\bfetch\(/,
      /\bcrypto\b/,
      /\bprocess\./,
      /\bsetTimeout\b/,
      /\bconsole\./,
      /from "node:/,
      /\bawait\b/,
      /(:\s*any\b|\bas\s+any\b|<any\b)/,
    ]) {
      expect(source, `${name} matches ${forbidden}`).not.toMatch(forbidden);
    }
  });
});
