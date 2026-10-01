import { describe, expect, it } from "vitest";
import { lastMarkedLine, parsePlanOutput } from "../../src/runner/markers.js";
import { checkoutEnv, HERMETIC_SCRIPT, RUNNER_HOME } from "../../src/runner/shell.js";

const spec = {
  version: 1,
  source: "file",
  steps: [{ name: "a", command: "x", parent: null, after: [] }],
  warnings: [],
};

describe("gittifacts-runner output markers", () => {
  it("takes the last marked line", () => {
    expect(lastMarkedLine("::plan::1\nnoise\n::plan::2\r\ntrailing", "::plan::")).toBe("2");
    expect(lastMarkedLine("nothing", "::plan::")).toBeNull();
  });

  it("parses a plan document", () => {
    const res = parsePlanOutput(`log line\n::plan::${JSON.stringify(spec)}\n`, ".platform/ci.ts");
    expect(res).toMatchObject({ ok: true, spec: { steps: [{ name: "a" }] } });
  });

  it("reports author errors with the file", () => {
    const res = parsePlanOutput(
      `::plan::{"error":"Unexpected token","file":".platform/ci.ts"}`,
      "x",
    );
    expect(res).toEqual({ ok: false, author: true, error: ".platform/ci.ts: Unexpected token" });
  });

  it("separates protocol failures from author errors", () => {
    expect(parsePlanOutput("{}", "f")).toMatchObject({ ok: false, author: false });
    expect(parsePlanOutput("::plan::{nope", "f")).toMatchObject({ ok: false, author: false });
    const invalid = parsePlanOutput(
      `::plan::${JSON.stringify({ ...spec, steps: [{ name: "a b" }] })}`,
      "f",
    );
    expect(invalid).toMatchObject({ ok: false, author: true });
  });
});

describe("runner user", () => {
  it("uses the runner home and never moves /workspace", () => {
    expect(checkoutEnv({ remote: "r", headSha: "h", token: "t" }).HOME).toBe(RUNNER_HOME);
    expect(HERMETIC_SCRIPT).not.toContain("mv /workspace");
  });
});
