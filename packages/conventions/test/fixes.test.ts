import { ErrorFix } from "@app/domain";
import { describe, expect, it } from "vitest";
import { ERROR_CODE_ALIASES, ERROR_CODES, ERROR_STATUS, fixFor, parseCall, resolveErrorCode } from "../src/index.js";
import { expectValidCall, HOST } from "./helpers.js";

describe("fixFor", () => {
  it.each([...ERROR_CODES])("%s has a valid, actionable fix", (code) => {
    for (const ctx of [{}, { host: HOST, repoId: "rep_1", planId: "pln_1", changeId: "chg_1" }]) {
      const fix = fixFor(code, ctx);
      expect(() => ErrorFix.parse(fix)).not.toThrow();
      expect(fix.call ?? fix.command, code).toBeDefined();
      if (fix.call !== undefined) expectValidCall(fix.call);
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });

  it("covers the onboarding spec's codes, directly or by alias", () => {
    for (const code of [
      "unauthenticated",
      "forbidden-scope",
      "self-approval",
      "push-to-main",
      "fix-without-red-green",
      "plan-not-approved",
      "stale-head",
      "quota-exceeded",
      "unclaimed-limit",
      "idempotency-key-reuse",
      "rate-limited",
      "not-found",
    ]) {
      expect(resolveErrorCode(code), code).not.toBeNull();
    }
    for (const target of Object.values(ERROR_CODE_ALIASES)) expect(ERROR_CODES).toContain(target);
    expect(fixFor("unauthenticated")).toEqual(fixFor("unauthorized"));
  });

  it("answers a push to main with start_change({ planId })", () => {
    const fix = fixFor("push-to-main", { repoId: "rep_1", planId: "pln_9" });
    expect(parseCall(fix.call ?? "")).toEqual({ tool: "start_change", args: { repoId: "rep_1", planId: "pln_9", title: "<what you changed>", category: "feature" } });
  });

  it("says which test must fail on base", () => {
    const none = fixFor("red-green-missing", {});
    expect(none.explanation).toMatch(/adds or changes no test/);
    expect(none.explanation).toMatch(/fails on the base commit and passes on your head/);
    const passing = fixFor("fix-without-red-green", {
      redGreen: { baseSha: "b".repeat(40), testFiles: ["test/money.test.ts"], passingOnBase: ["test/money.test.ts"] },
    });
    expect(passing.explanation).toContain("already pass on base bbbbbbbbbbbb");
    expect(passing.explanation).toContain("`test/money.test.ts`");
    expect(passing.command).toBe("pnpm exec vitest run test/money.test.ts");
    const red = fixFor("red-green-missing", { redGreen: { testFiles: ["test/a.test.ts"], failingOnHead: ["test/a.test.ts"] }, testFileCommand: "npx jest" });
    expect(red.explanation).toMatch(/still fail on your head/);
    expect(red.command).toBe("npx jest test/a.test.ts");
  });

  it("fills in specifics from the context", () => {
    expect(fixFor("insufficient-scope", { requiredScopes: ["change:create"] }).explanation).toContain("`change:create`");
    expect(fixFor("quota-exceeded", { quota: { name: "ci-minutes", limit: 60, used: 60, resetsAt: "2026-10-02T00:00:00Z" } }).explanation).toContain(
      "the ci-minutes quota (60/60); it resets at 2026-10-02T00:00:00Z",
    );
    expect(fixFor("unclaimed-limit", { refused: "deploy to production", claimUrl: "https://h/claim/x" }).explanation).toContain("https://h/claim/x");
    expect(fixFor("rate-limited", { retryAfterSec: 30 }).command).toBe("sleep 30");
    expect(fixFor("plan-not-approved", { planId: "pln_1", planStatus: "draft" }).explanation).toContain("Plan pln_1 is draft");
    expect(fixFor("not-found", { resource: "change", changeId: "chg_1" }).call).toBe('get_change_status({ changeId: "chg_1" })');
  });

  it("adds docsUrl only when the host is known", () => {
    expect(fixFor("not-found").docsUrl).toBeUndefined();
    expect(fixFor("not-found", { host: `${HOST}/` }).docsUrl).toBe(`${HOST}/start`);
  });

  it("gives unknown codes a generic fix rather than none", () => {
    const fix = fixFor("brand-new-error");
    expect(fix.explanation).toMatch(/message/);
    expect(fix.call).toBe("whoami({})");
  });

  it("never tells an agent to approve", () => {
    for (const code of ERROR_CODES) expect(fixFor(code).call ?? "").not.toMatch(/approve/);
  });
});
