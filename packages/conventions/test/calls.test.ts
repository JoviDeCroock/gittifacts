import { describe, expect, it } from "vitest";
import { call, isToolName, parseCall, TOOL_NAMES } from "../src/index.js";

describe("call()", () => {
  it("formats bare keys and JSON values", () => {
    expect(call("start_change", { planId: "pln_1" })).toBe('start_change({ planId: "pln_1" })');
    expect(call("whoami")).toBe("whoami({})");
    expect(
      call("create_plan", {
        repoId: "r",
        acceptanceCriteria: ["a", "b"],
        timeoutSec: 3,
        ok: true,
        x: undefined,
      }),
    ).toBe('create_plan({ repoId: "r", acceptanceCriteria: ["a", "b"], timeoutSec: 3, ok: true })');
  });

  it("quotes keys that are not identifiers and escapes strings", () => {
    expect(call("ws_exec", { "dash-key": 'say "hi", ok: no' })).toBe(
      'ws_exec({ "dash-key": "say \\"hi\\", ok: no" })',
    );
  });

  it("round-trips through parseCall", () => {
    const args = { repoId: "rep_1", nested: { a: [1, { b: "c: d" }] }, s: "{ e: f }" };
    const parsed = parseCall(call("create_plan", args));
    expect(parsed).toEqual({ tool: "create_plan", args });
  });
});

describe("parseCall()", () => {
  it.each([
    "start_change",
    "start_change()",
    "start_change({ planId })",
    "Start({})",
    "x({ a: 1 }) trailing",
    'a({ "b": })',
  ])("rejects %j", (text) => {
    expect(parseCall(text)).toBeNull();
  });

  it("accepts placeholders and whitespace", () => {
    expect(parseCall('  get_tour({ changeId: "<changeId>" }) ')).toEqual({
      tool: "get_tour",
      args: { changeId: "<changeId>" },
    });
  });
});

describe("TOOL_NAMES", () => {
  it("are snake_case and unique", () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
    for (const name of TOOL_NAMES) expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it("include the spec's tools", () => {
    for (const name of [
      "create_project",
      "create_plan",
      "start_change",
      "get_change_status",
      "get_evidence",
      "get_tour",
      "request_review",
      "list_issues_for_change",
      "wait_for_change",
      "whoami",
      "capabilities",
    ]) {
      expect(isToolName(name)).toBe(true);
    }
    expect(isToolName("approve_change")).toBe(false);
  });
});
