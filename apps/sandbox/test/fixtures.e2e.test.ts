/**
 * M2/M3 acceptance: the real runner over the nine fixture repositories.
 *
 * For each fixture: materialize base/head, link the monorepo's node_modules (as
 * scripts/check-fixtures.ts does), run every runner command through the BUILT bundle, assemble
 * and sign the evidence bundle, write it as a git note on the head commit, verify it with the
 * standalone verify CLI, compute DiffStats from the runner's `diff`, classify with the base
 * policy and the fixture's approved plan, and compare with fixture.json — exactly.
 *
 * Skip with SKIP_E2E=1.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, type ClassifyResult } from "@app/classifier";
import { ChangeDiff, diffStatsOf, Plan, RepoPolicy } from "@app/domain";
import {
  type CoverageDelta,
  decodeNote,
  EVIDENCE_NOTES_REF,
  EvidenceItem,
  encodeNote,
  generateSigningKey,
  type MutationScore,
  type PublicApiDiff,
  type RedGreenProof,
  ReproducibleTransform,
  signEvidence,
  type SigningKeyPair,
  verifyEvidence,
} from "@app/evidence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { git, listFixtureNames, materializeFixture, REPO_ROOT } from "../../../scripts/lib/fixtures.js";
import { PolicyDocument } from "../src/commands/policy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SANDBOX = join(HERE, "..");
const BUNDLE = join(SANDBOX, "dist", "gittifacts-runner.mjs");
const VERIFY_CLI = join(REPO_ROOT, "packages", "evidence", "dist", "verify-attestation.mjs");
const SKIP = process.env.SKIP_E2E === "1";

interface Exec {
  code: number;
  stdout: string;
  stderr: string;
}

function exec(cmd: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<Exec> {
  return new Promise((resolve) => {
    const clean: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("VITEST") && k !== "TEST") clean[k] = v;
    execFile(cmd, [...args], { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...clean, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

/** Run the bundled CLI; assert the output contract and return the parsed document. */
async function runner(dir: string, args: readonly string[], prefix = "::evidence::"): Promise<unknown> {
  const r = await exec(process.execPath, [BUNDLE, ...args, "--cwd", dir], dir);
  const lines = r.stdout.split("\n").filter((l) => l !== "");
  if (r.code !== 0 || lines.length !== 1 || !lines[0]?.startsWith(prefix)) {
    throw new Error(`gittifacts-runner ${args.join(" ")} → exit ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr.slice(-4000)}`);
  }
  return JSON.parse(lines[0].slice(prefix.length));
}

interface Measured {
  name: string;
  redGreen: string;
  failingOnBase: number;
  coverage: string;
  mutation: string;
  api: string;
  deps: string;
  sensitive: string;
  transform: string;
  plan: string;
  computedLane: number;
  lane: number;
  human: boolean;
  seconds: number;
}

const table: Measured[] = [];
let key: SigningKeyPair;
let work: string;

const fmt = (x: number) => (Math.round(x * 1000) / 1000).toString();

describe.skipIf(SKIP)("fixtures end to end (built runner bundle)", () => {
  beforeAll(async () => {
    const built = await exec(process.execPath, [join(SANDBOX, "build.mjs")], SANDBOX);
    if (built.code !== 0) throw new Error(`build failed: ${built.stderr}`);
    if (!existsSync(VERIFY_CLI)) {
      const r = await exec(process.execPath, [join(REPO_ROOT, "packages", "evidence", "scripts", "build-cli.mjs")], join(REPO_ROOT, "packages", "evidence"));
      if (r.code !== 0) throw new Error(`could not build the verify CLI: ${r.stderr}`);
    }
    key = await generateSigningKey();
    work = mkdtempSync(join(tmpdir(), "gittifacts-e2e-"));
  });

  afterAll(() => {
    if (work !== undefined && process.env.GITTIFACTS_KEEP_E2E !== "1") rmSync(work, { recursive: true, force: true });
    if (table.length > 0) {
      const header = "fixture | red-green | cov | mutation | api | deps | sensitive | transform | lane (computed→routed) | human | s | plan";
      const rows = table.map((m) =>
        [m.name, `${m.redGreen} (${m.failingOnBase} red)`, m.coverage, m.mutation, m.api, m.deps, m.sensitive, m.transform, `${m.computedLane}→${m.lane}`, m.human, m.seconds, m.plan].join(" | "),
      );
      console.log(`\n${header}\n${rows.join("\n")}\n`);
      const out = process.env.GITTIFACTS_E2E_REPORT;
      if (out) writeFileSync(out, JSON.stringify(table, null, 2));
    }
  });

  it("covers all nine fixtures", () => {
    expect(listFixtureNames()).toHaveLength(9);
  });

  for (const name of listFixtureNames()) {
    it(name, { timeout: 600_000 }, async () => {
      const started = Date.now();
      const { dir, baseSha, headSha, fixture } = await materializeFixture(name, { outDir: work });
      symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
      const range = ["--base", baseSha, "--head", headSha];
      const evidence = (kind: string) => runner(dir, ["evidence", kind, ...range]);

      // Commands that only read git objects, in parallel.
      const [depsRaw, sensitiveRaw, policyRaw, diffRaw, apiRaw, transformsRaw] = await Promise.all([
        evidence("dependencies"),
        evidence("sensitive-paths"),
        runner(dir, ["policy", ...range]),
        runner(dir, ["diff", ...range]),
        evidence("public-api"),
        evidence("transforms"),
      ]);
      // Commands that run the test suite (sequential: they share the working tree).
      const redGreenRaw = await evidence("red-green");
      const testRunRaw = await evidence("test-run");
      const coverageRaw = await evidence("coverage");
      const mutationRaw = await evidence("mutation");
      // Plan mode over the fixture's .platform/ci.ts: a PipelineSpec, or an error document that
      // names the problem (never a crash). Recorded in the table; asserted in plan.test.ts.
      const planRaw = await runner(dir, ["plan", ".platform/ci.ts", "--head", headSha], "::plan::");
      const planDoc = z.union([z.object({ version: z.literal(1), steps: z.array(z.object({ name: z.string() })) }), z.object({ error: z.string() })]).parse(planRaw);

      const transformItems = z.array(ReproducibleTransform).parse(transformsRaw);
      const items = [redGreenRaw, testRunRaw, coverageRaw, mutationRaw, apiRaw, depsRaw, sensitiveRaw].map((x) => EvidenceItem.parse(x));
      items.push(...transformItems);
      const byKind = <K extends EvidenceItem["kind"]>(k: K) => items.find((i): i is Extract<EvidenceItem, { kind: K }> => i.kind === k);
      const redGreen = byKind("red-green") as RedGreenProof;
      const coverage = byKind("coverage") as CoverageDelta;
      const mutation = byKind("mutation") as MutationScore;
      const api = byKind("public-api") as PublicApiDiff;
      const deps = byKind("dependencies");
      const sensitive = byKind("sensitive-paths");
      const testRun = byKind("test-run");
      const policyDoc = PolicyDocument.parse(policyRaw);
      const changeDiff = ChangeDiff.parse(diffRaw);

      // Nothing measured may fail on these well-formed fixtures.
      for (const item of items) expect.soft(item.status, `${item.kind}: ${item.note ?? ""}`).not.toBe("error");
      expect(policyDoc.status).toBe("ok");

      // Sign, verify, write the note, verify the note with the standalone CLI.
      const signed = await signEvidence({ changeId: `chg_${name}`, headSha, items }, { ...key, name: "gittifacts-e2e" });
      expect((await verifyEvidence(signed, key.publicKey)).ok).toBe(true);
      const noteFile = join(work, `${name}.note.json`);
      writeFileSync(noteFile, encodeNote(signed));
      await git(dir, ["notes", `--ref=${EVIDENCE_NOTES_REF}`, "add", "-F", noteFile, headSha]);
      const note = await git(dir, ["notes", `--ref=${EVIDENCE_NOTES_REF}`, "show", headSha]);
      const fromNote = await verifyEvidence(decodeNote(note), key.publicKey);
      expect(fromNote.ok).toBe(true);
      const cli = await exec(process.execPath, [VERIFY_CLI, "--repo", dir, "--commit", headSha, "--public-key", key.publicKey, "--json"], dir);
      expect(cli.code, cli.stdout + cli.stderr).toBe(0);
      expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, bindingChecked: true, headSha, changeId: `chg_${name}` });

      // Classify: base policy, approved plan (approver ≠ author), runner DiffStats.
      const policy = RepoPolicy.parse(policyDoc.policy);
      const plan = Plan.parse({
        id: `plan_${name}`.slice(0, 64),
        repoId: "repo_fixture",
        ...fixture.plan,
        status: fixture.plan.approved ? "approved" : "draft",
        authorId: "agent_fixture",
        approvedBy: fixture.plan.approved ? "human_reviewer" : null,
        approvedAt: fixture.plan.approved ? "2026-01-02T08:00:00.000Z" : null,
        approvalSignature: null,
        supersedes: null,
        createdAt: "2026-01-02T07:00:00.000Z",
      });
      const diffStats = diffStatsOf(changeDiff);
      const ciPassed = testRun?.status === "ok" && testRun.failed === 0;
      const result: ClassifyResult = classify(fromNote.ok ? { items: fromNote.evidence.items } : null, policy, plan, diffStats, { category: fixture.claim.category }, {
        ciStatus: ciPassed ? "passed" : "failed",
        evidenceVerified: fromNote.ok,
        budgetExceeded: false,
        tourStatus: "not-generated",
        pureRevertVerified: false,
      });
      const codes = result.reasons.map((r) => r.code);

      // Record what was measured (printed as a table after the run).
      const transform = transformItems[0];
      table.push({
        name,
        redGreen: redGreen.verdict,
        failingOnBase: redGreen.base.results.filter((r) => r.outcome !== "pass").length,
        coverage: `${fmt(coverage.ratio)} (${coverage.coveredChangedLines}/${coverage.changedLines})`,
        mutation: `${mutation.status === "ok" ? fmt(mutation.score) : mutation.status} (${mutation.killed + mutation.timedOut}/${mutation.killed + mutation.timedOut + mutation.survived + mutation.noCoverage})`,
        api: `${api.classification}${api.packages.flatMap((p) => [...p.added.map((c) => `+${c.symbol}`), ...p.changed.map((c) => `~${c.symbol}`), ...p.removed.map((c) => `-${c.symbol}`)]).join(" ") ? ` ${api.packages.flatMap((p) => [...p.added.map((c) => `+${c.symbol}`), ...p.changed.map((c) => `~${c.symbol}`), ...p.removed.map((c) => `-${c.symbol}`)]).join(" ")}` : ""}`,
        deps: deps === undefined ? "?" : deps.added.map((d) => `+${d.name}`).join(" ") || "none",
        sensitive: sensitive === undefined ? "?" : sensitive.hits.map((h) => h.path).join(" ") || "none",
        transform: transform === undefined ? "n/a" : transform.status === "ok" ? String(transform.verified) : transform.status,
        plan: "error" in planDoc ? `error: ${planDoc.error}` : planDoc.steps.map((st) => st.name).join(","),
        computedLane: result.computedLane,
        lane: result.lane,
        human: result.requiresHumanApproval,
        seconds: Math.round((Date.now() - started) / 1000),
      });

      // ---- expectations from fixture.json, exactly
      const exp = fixture.expected;
      const ev = exp.evidence;
      const sorted = (xs: readonly string[]) => [...xs].sort();
      expect(result.computedLane, codes.join(", ")).toBe(exp.computedLane);
      expect(result.lane, codes.join(", ")).toBe(exp.laneWithShadow);
      expect(result.requiresHumanApproval).toBe(exp.requiresHumanApproval);
      for (const code of exp.reasonCodes) expect(codes, `missing reason ${code}`).toContain(code);

      if (ev.changedFiles) expect(sorted(changeDiff.files.map((f) => f.path))).toEqual(sorted(ev.changedFiles));
      if (ev.redGreen) expect(redGreen.verdict).toBe(ev.redGreen);
      if (ev.failingOnBase) {
        const red = redGreen.base.results.filter((r) => r.outcome !== "pass").map((r) => r.id);
        expect(sorted(red)).toEqual(sorted(ev.failingOnBase));
      }
      if (ev.publicApi) expect(api.classification).toBe(ev.publicApi);
      const symbols = (pick: (p: PublicApiDiff["packages"][number]) => { symbol: string }[]) => sorted(api.packages.flatMap((p) => pick(p).map((c) => c.symbol)));
      if (ev.apiAdded) expect(symbols((p) => p.added)).toEqual(sorted(ev.apiAdded));
      if (ev.apiChanged) expect(symbols((p) => p.changed)).toEqual(sorted(ev.apiChanged));
      if (ev.apiRemoved) expect(symbols((p) => p.removed)).toEqual(sorted(ev.apiRemoved));
      if (ev.dependenciesAdded) expect(sorted(deps?.added.map((d) => d.name) ?? [])).toEqual(sorted(ev.dependenciesAdded));
      if (ev.dependenciesRemoved) expect(sorted(deps?.removed.map((d) => d.name) ?? [])).toEqual(sorted(ev.dependenciesRemoved));
      if (ev.lockfileChanged !== undefined) expect(deps?.lockfileChanged).toBe(ev.lockfileChanged);
      if (ev.sensitiveHits) expect(sorted([...new Set(sensitive?.hits.map((h) => h.path) ?? [])])).toEqual(sorted(ev.sensitiveHits));
      if (ev.scopeDrift) expect(codes.includes("scope.drift")).toBe(ev.scopeDrift.length > 0);
      if (ev.policyChanged !== undefined) expect(policyDoc.policyChanged).toBe(ev.policyChanged);
      if (ev.transformVerified !== undefined) {
        expect(transform?.status).toBe("ok");
        expect(transform?.verified).toBe(ev.transformVerified);
        expect(transform?.command).toBe(fixture.transform?.command);
      } else {
        // No transform at base → nothing to claim.
        expect(transformItems).toEqual([]);
      }
    });
  }
});
