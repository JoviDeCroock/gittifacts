/** Pure workspace rules: paths, per-claim limits, egress, diff parsing. */
import { defaultPolicy, type Repo } from "@app/domain";
import { describe, expect, it } from "vitest";
import { workspaceEgressDecision } from "../src/workspace/egress.js";
import { captureHeadTail, MAX_LABEL_KEY_BYTES, workspaceLabels } from "../src/workspace/machine.js";
import {
  changeIdOfWorkspace,
  checkWorkspacePath,
  limitsFor,
  workspaceIdFor,
} from "../src/workspace/model.js";
import { parseDiffStats, WS_MARKER } from "../src/workspace/scripts.js";

const claimed: Pick<Repo, "claim" | "policy"> = {
  claim: { status: "claimed", ownerId: "hu_1", expiresAt: null },
  policy: defaultPolicy(),
};
const unclaimed: Pick<Repo, "claim" | "policy"> = {
  claim: { status: "unclaimed", ownerId: null, expiresAt: "2026-10-08T00:00:00.000Z" },
  policy: defaultPolicy(),
};

describe("checkWorkspacePath", () => {
  it("normalizes paths inside the checkout", () => {
    expect(checkWorkspacePath("src/./a.ts")).toEqual({ ok: true, path: "src/a.ts" });
    expect(checkWorkspacePath("/workspace/src/a.ts")).toEqual({ ok: true, path: "src/a.ts" });
    expect(checkWorkspacePath("src/x/../a.ts")).toEqual({ ok: true, path: "src/a.ts" });
    expect(checkWorkspacePath(".", { allowRoot: true })).toEqual({ ok: true, path: "." });
  });

  it("rejects anything that leaves it, .git and control characters", () => {
    for (const p of [
      "../etc/passwd",
      "/etc/passwd",
      "a/../../b",
      ".git/config",
      "./.git/hooks/pre-push",
      "a\nb",
      "",
      ".",
    ]) {
      expect(checkWorkspacePath(p).ok, p).toBe(false);
    }
  });

  it("maps workspace ids to changes and back", () => {
    expect(changeIdOfWorkspace(workspaceIdFor("abc123"))).toBe("abc123");
    expect(changeIdOfWorkspace("task-abc")).toBeNull();
  });
});

describe("limitsFor", () => {
  it("gives unclaimed projects registries-only egress, a 30-minute TTL and a tight quota", () => {
    expect(limitsFor(unclaimed)).toMatchObject({
      network: "registries-only",
      ttlMs: 30 * 60_000,
      maxOpen: 1,
      cpuSecondsPerDay: 30 * 60,
      instance: "standard-1",
    });
  });

  it("gives claimed projects open egress and 2 hours, unless their policy says registries-only", () => {
    expect(limitsFor(claimed)).toMatchObject({ network: "open", ttlMs: 2 * 60 * 60_000 });
    const strict = {
      ...claimed,
      policy: { ...defaultPolicy(), sandbox: { network: "registries-only" as const } },
    };
    expect(limitsFor(strict).network).toBe("registries-only");
  });

  it("takes TTL overrides from vars but never loosens an unclaimed project's egress", () => {
    const vars = { WORKSPACE_TTL_UNCLAIMED_MIN: "10", WORKSPACE_TTL_CLAIMED_MIN: "45" };
    expect(limitsFor(unclaimed, vars)).toMatchObject({
      ttlMs: 10 * 60_000,
      network: "registries-only",
    });
    expect(limitsFor(claimed, vars).ttlMs).toBe(45 * 60_000);
  });
});

describe("workspaceEgressDecision (registries-only)", () => {
  const props = {
    registries: ["registry.npmjs.org"],
    gitHost: "acct.artifacts.cloudflare.net",
    pushPath: "/git/gittifacts-eu/task-c1.git",
  };
  const git = "https://acct.artifacts.cloudflare.net/git/gittifacts-eu";

  it("allows registry reads and git fetches, like CI", () => {
    expect(
      workspaceEgressDecision("GET", "https://registry.npmjs.org/esbuild", props).allowed,
    ).toBe(true);
    expect(workspaceEgressDecision("POST", `${git}/main.git/git-upload-pack`, props).allowed).toBe(
      true,
    );
  });

  it("allows pushing to its own fork only", () => {
    expect(
      workspaceEgressDecision("GET", `${git}/task-c1.git/info/refs?service=git-receive-pack`, props)
        .allowed,
    ).toBe(true);
    expect(
      workspaceEgressDecision("POST", `${git}/task-c1.git/git-receive-pack`, props).allowed,
    ).toBe(true);
    expect(workspaceEgressDecision("POST", `${git}/main.git/git-receive-pack`, props).allowed).toBe(
      false,
    );
    expect(
      workspaceEgressDecision("POST", `${git}/task-other.git/git-receive-pack`, props).allowed,
    ).toBe(false);
  });

  it("refuses everything else", () => {
    expect(
      workspaceEgressDecision("POST", "https://registry.npmjs.org/-/v1/login", props).allowed,
    ).toBe(false);
    expect(workspaceEgressDecision("GET", "https://evil.example/x", props).allowed).toBe(false);
    expect(
      workspaceEgressDecision("POST", `${git}/task-c1.git/git-receive-pack`, {
        ...props,
        pushPath: null,
      }).allowed,
    ).toBe(false);
  });
});

describe("helpers", () => {
  it("parseDiffStats reads numstat and name-status (renames included)", () => {
    const out = `3\t1\tsrc/a.ts\u00000\t0\t\u0000old.ts\u0000new.ts\u0000\n${WS_MARKER}name-status\nM\u0000src/a.ts\u0000R100\u0000old.ts\u0000new.ts\u0000`;
    expect(parseDiffStats(out)).toEqual([
      { path: "src/a.ts", status: "modified", additions: 3, deletions: 1 },
      { path: "new.ts", status: "renamed", additions: 0, deletions: 0 },
    ]);
  });

  it("captureHeadTail keeps the start and the end of long output", async () => {
    const text = `${"a".repeat(100)}${"b".repeat(1000)}${"c".repeat(100)}`;
    const stream = new Response(text).body;
    const cap = await captureHeadTail(stream, 200);
    expect(cap).toMatchObject({ bytes: 1200, truncated: true });
    expect(cap.text.startsWith("a".repeat(50))).toBe(true);
    expect(cap.text.endsWith("c".repeat(100))).toBe(true);
    expect(cap.text).toContain("bytes omitted");
  });
});

describe("container labels", () => {
  it("every label key fits the 16-byte limit", () => {
    const labels = workspaceLabels(`ws-${"x".repeat(60)}`);
    expect(Object.keys(labels).length).toBeGreaterThan(0);
    for (const key of Object.keys(labels)) {
      expect(new TextEncoder().encode(key).byteLength, key).toBeLessThanOrEqual(
        MAX_LABEL_KEY_BYTES,
      );
    }
    for (const value of Object.values(labels)) expect(value.length).toBeLessThanOrEqual(63);
  });
});
