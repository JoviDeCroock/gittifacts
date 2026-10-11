/**
 * The dependency-patch path end to end through the real producer: `dependencyDiff` reads the
 * manifests and the lockfiles at base and head, and `classify` grants planless Lane 0 only when
 * the lockfile diff is the recorded patch bump re-resolved from the registry.
 */
import { dependencyDiff } from "@app/evidence";
import { describe, expect, it } from "vitest";
import { file, green, mutate, raisedCodes, replaceKind, run, withFiles } from "./helpers.js";

const manifest = (range: string) =>
  JSON.stringify({ dependencies: { "left-pad": range } }, null, 2);

function lock(v: string, resolution = `{integrity: sha512-${v.replaceAll(".", "")}==}`) {
  return [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      left-pad:",
    `        specifier: ^${v}`,
    `        version: ${v}`,
    "",
    "packages:",
    "",
    `  left-pad@${v}:`,
    `    resolution: ${resolution}`,
    "",
    "snapshots:",
    "",
    `  left-pad@${v}: {}`,
    "",
  ].join("\n");
}

/** A planless "dependency" Change: package.json one line, pnpm-lock.yaml rewritten to `head`. */
function planless(headLock: string) {
  const deps = dependencyDiff(
    { "package.json": manifest("^1.3.0") },
    { "package.json": manifest("^1.3.1") },
    {
      changedPaths: ["package.json", "pnpm-lock.yaml"],
      lockfiles: {
        base: { "pnpm-lock.yaml": lock("1.3.0") },
        head: { "pnpm-lock.yaml": headLock },
      },
    },
  );
  return mutate(
    replaceKind(
      withFiles(green(), [file("package.json", 1, 1), file("pnpm-lock.yaml", 4, 4)]),
      "dependencies",
      deps,
    ),
    (d) => {
      d.plan = null;
      d.change.category = "dependency";
      d.policy.planlessLane0 = ["dependency-patch"];
    },
  );
}

describe("dependency-patch Lane 0 checks the lockfile", () => {
  it("a registry patch bump in the lockfile auto-merges without a plan", () => {
    const r = run(planless(lock("1.3.1")));
    expect(r.computedLane, JSON.stringify(raisedCodes(r))).toBe(0);
    expect(r.reasons.map((x) => x.code)).toContain("plan.planless");
  });

  it("the same one-line package.json bump with the entry pointing at another tarball does not", () => {
    const r = run(planless(lock("1.3.1", "{tarball: https://evil.example/left-pad-1.3.1.tgz}")));
    expect(r.computedLane).toBe(1);
    const codes = r.reasons.map((x) => x.code);
    expect(codes).toContain("dependency.lockfile-unverified");
    expect(codes).not.toContain("plan.planless");
  });

  it("a lockfile that also pulls in a new package does not", () => {
    const head = lock("1.3.1").replace(
      "\nsnapshots:",
      "  evil@1.0.0:\n    resolution: {integrity: sha512-EVIL==}\n\nsnapshots:",
    );
    const r = run(planless(head));
    expect(r.computedLane).toBe(1);
    expect(r.reasons.map((x) => x.code)).toContain("dependency.lockfile-unverified");
  });
});
