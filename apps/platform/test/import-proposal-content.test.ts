/**
 * The import proposal's content (pure `buildProposal`): one risk per install-script problem (not a
 * second "Detection is unsure" copy), unapproved install scripts skipped in pnpm-workspace.yaml
 * (`allowBuilds: false`, never `true`), and an acceptance criterion that only promises a green
 * run when the default branch is green too.
 */
import { BUILD_SCRIPTS_DOUBT, type DetectReport, inspectRepo } from "@app/conventions";
import { describe, expect, it } from "vitest";
import { buildProposal, type ExistingFiles, mainCiCriterion } from "../src/import/proposal.js";

const LOCK = `lockfileVersion: '9.0'

packages:
  esbuild@0.28.2:
    resolution: {integrity: x}
  sharp@0.34.1:
    resolution: {integrity: x}
  fsevents@2.3.3:
    resolution: {integrity: x}
    os: [darwin]
`;

function report(files: Record<string, string>): DetectReport {
  return inspectRepo({ files: Object.keys(files), read: (p) => files[p] ?? null });
}

const PKG = JSON.stringify({
  name: "clock-api",
  packageManager: "pnpm@11.27.0",
  scripts: { test: "vitest run", build: "esbuild src/index.ts --bundle --outfile=dist/index.js" },
  devDependencies: { esbuild: "0.28.2", sharp: "0.34.1", vitest: "4.1.11" },
});

const repo = {
  id: "rep_1",
  name: "clock-api",
  claim: { status: "claimed" as const, ownerId: "hu_1", expiresAt: null },
  importedFrom: "https://github.com/acme/clock-api",
};
const none: ExistingFiles = { ci: false, policy: false, agentsMd: null };

describe("buildProposal: install scripts", () => {
  it("skips unapproved install scripts in pnpm-workspace.yaml and says so once", () => {
    const r = report({ "package.json": PKG, "pnpm-lock.yaml": LOCK });
    expect(r.buildScriptsNeedingApproval.map((d) => d.name)).toEqual(["esbuild", "sharp"]);
    const p = buildProposal({
      repo,
      report: r,
      existing: { ...none, pnpmWorkspace: "packages:\n  - .\n" },
      host: "https://gf.example",
    });
    const yaml = p.files["pnpm-workspace.yaml"] ?? "";
    expect(yaml).toMatch(/^packages:\n {2}- \.\n\nallowBuilds:\n/);
    expect(yaml).toContain("  esbuild: false\n  sharp: false\n");
    expect(yaml).not.toMatch(/: true/);
    expect(p.plan.scopePaths).toContain("pnpm-workspace.yaml");

    const risks = (p.plan.riskDeclarations ?? []).map((x) => x.description);
    const scripts = risks.filter((d) => /esbuild, sharp/.test(d));
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatch(/lists them as false under allowBuilds .* approves nothing/);
    expect(risks.some((d) => d.includes(BUILD_SCRIPTS_DOUBT))).toBe(false);
    // fsevents (os: darwin) never installs on the runners: not a risk at all.
    expect(risks.join("\n")).not.toMatch(/fsevents/);
  });

  it("never writes the file when it wasn't read, or for pnpm 10 (which only warns)", () => {
    const r = report({ "package.json": PKG, "pnpm-lock.yaml": LOCK });
    const unread = buildProposal({ repo, report: r, existing: none, host: "https://gf.example" });
    expect(unread.files["pnpm-workspace.yaml"]).toBeUndefined();
    expect(unread.plan.scopePaths).not.toContain("pnpm-workspace.yaml");

    const pnpm10 = report({
      "package.json": PKG.replace("pnpm@11.27.0", "pnpm@10.12.1"),
      "pnpm-lock.yaml": LOCK,
    });
    const p10 = buildProposal({
      repo,
      report: pnpm10,
      existing: { ...none, pnpmWorkspace: null },
      host: "https://gf.example",
    });
    expect(p10.files["pnpm-workspace.yaml"]).toBeUndefined();
  });

  it("leaves a flow-style allowBuilds to a human and says the install will fail", () => {
    const r = report({ "package.json": PKG, "pnpm-lock.yaml": LOCK });
    const p = buildProposal({
      repo,
      report: r,
      existing: { ...none, pnpmWorkspace: "allowBuilds: { vitest: true }\n" },
      host: "https://gf.example",
    });
    expect(p.files["pnpm-workspace.yaml"]).toBeUndefined();
    const risks = (p.plan.riskDeclarations ?? []).map((x) => x.description).join("\n");
    expect(risks).toMatch(/CI installs will fail \(ERR_PNPM_IGNORED_BUILDS\)/);
  });
});

describe("buildProposal: acceptance criteria follow main's CI", () => {
  const r = report({
    "package.json": PKG.replace(', sharp: "0.34.1"', ""),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  });
  const criteria = (mainCi?: Parameters<typeof mainCiCriterion>[0]) =>
    buildProposal({ repo, report: r, existing: none, host: "https://gf.example", mainCi }).plan
      .acceptanceCriteria;

  it("promises a passing run only when main passes", () => {
    expect(criteria({ status: "passed" })).toContain(
      "The proposal's own CI run passes (the default branch passes the same steps today)",
    );
    expect(criteria().join("\n")).not.toMatch(/own CI run passes/);
    expect(criteria().join("\n")).toMatch(/already fails on the default branch is pre-existing/);
  });

  it("names the steps that already fail on main as pre-existing", () => {
    expect(criteria({ status: "failed", failedSteps: ["test"] }).at(-1)).toBe(
      "The proposal's CI runs the same steps as the default branch and every step that passes there passes here; `test` already fails on the default branch (pre-existing, not caused by this Change)",
    );
    expect(mainCiCriterion({ status: "failed", failedSteps: ["lint", "test"] })).toMatch(
      /`lint`, `test` already fail on/,
    );
  });
});
