/**
 * Corpus integrity (not part of `pnpm test`, which only runs the scripted pipeline):
 *
 *   pnpm --filter @app/resolver exec tsx scripts/check-corpus.ts [case…]
 *
 * For every case: the tests pass at base, after each upstream change and on the change alone; the
 * merge conflicts (textual) or merges cleanly and then fails (semantic) as the case says; the
 * expected resolution passes the expected-behaviour checks with the expected scope and culprit;
 * and naive resolutions (take only upstream's side, only the change's side, or nothing for a
 * semantic conflict) FAIL those checks, so a passing check means something.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeLlmClient } from "@app/tour";
import { createResolver } from "../src/resolver.js";
import type { ModelResolution } from "../src/schema.js";
import { buildWorkspace } from "../src/workspace.js";
import { ApplyResolutionDoc, parseMergeOutput } from "../src/merge-doc.js";
import {
  buildRunner,
  evaluateCase,
  listCases,
  type Prepared,
  prepareCase,
  readOverlay,
  runRunner,
  runTests,
  scratchRoot,
  scriptedClient,
} from "./lib/corpus.js";

type Env = Record<string, string | undefined>;
const runtime = globalThis as { process?: { argv: string[]; env: Env; exitCode?: number } };
const argv = runtime.process?.argv.slice(2) ?? [];

function naive(p: Prepared, side: "ours" | "theirs"): ModelResolution {
  const ws = buildWorkspace(p.merge, p.input.files ?? [], false);
  if (!ws.ok) throw new Error(ws.message);
  const answer: ModelResolution = {
    status: "resolved",
    regions: [],
    files: [],
    semanticConflictWith: null,
    rationale: `naive: take ${side}`,
  };
  for (const f of ws.ws.conflicted) {
    if (f.wholeFile) answer.files.push({ path: f.path, content: f.sides[side] });
    else f.regions.forEach((r, i) => answer.regions.push({ file: f.path, conflict: i + 1, text: r[side].join("") }));
  }
  return answer;
}

async function naiveFails(p: Prepared, bundle: string, root: string, side: "ours" | "theirs"): Promise<string> {
  const out = await createResolver(new FakeLlmClient([{ json: naive(p, side) }])).resolve(p.input);
  if (out.status !== "resolved") return `naive ${side}: ejected (${out.eject.cause})`;
  const patch = join(root, `${p.c.name}-${side}.patch`);
  writeFileSync(patch, out.patch);
  const doc = parseMergeOutput(
    (await runRunner(bundle, ["apply-resolution", "--patch", patch, "--onto", out.applyOnto], p.m.dir)).stdout,
    ApplyResolutionDoc,
  );
  if (doc.status !== "resolved") return `naive ${side}: did not apply`;
  const checks = await runTests(p.m.dir, doc.newSha, root, readOverlay(join(p.c.dir, "checks")));
  return checks.ok ? `NAIVE ${side.toUpperCase()} PASSES THE CHECKS` : "ok";
}

async function main(): Promise<void> {
  const root = scratchRoot("gittifacts-corpus-check-");
  const bundle = buildRunner(join(root, "runner"));
  let failures = 0;
  try {
    for (const c of listCases(argv)) {
      const problems: string[] = [];
      const p = await prepareCase(c, bundle, root, 1);
      const shas = [["base", p.m.base], ...p.m.upstream.map((u) => [u.changeId, u.sha]), ["change", p.m.head]];
      for (const [label, sha] of shas) {
        const run = await runTests(p.m.dir, sha!, root);
        if (!run.ok) problems.push(`tests fail at ${label}: ${run.failing.map((f) => f.id).join(", ")}`);
      }
      const r = await evaluateCase(c, { bundle, root, budgetUsd: 1, client: scriptedClient });
      if (!r.success) problems.push(`expected resolution: ${r.failure}`);
      if (r.outside !== c.spec.expect.outsideHunks) problems.push(`outside ${r.outside}, expected ${c.spec.expect.outsideHunks}`);
      if (r.culprit !== c.spec.expect.culprit) problems.push(`culprit ${r.culprit}, expected ${c.spec.expect.culprit}`);
      if (c.spec.kind === "textual") {
        for (const side of ["ours", "theirs"] as const) {
          const verdict = await naiveFails(p, bundle, root, side);
          if (verdict !== "ok") problems.push(verdict);
        }
      } else {
        const asMerged = await runTests(p.m.dir, p.merge.status === "clean" ? p.merge.newSha : p.m.onto, root, readOverlay(join(c.dir, "checks")));
        if (asMerged.ok) problems.push("the checks pass on the unresolved merged tree");
      }
      failures += problems.length > 0 ? 1 : 0;
      console.log(`${problems.length === 0 ? "ok  " : "FAIL"} ${c.name} (${c.spec.kind}, checks ${r.checks?.passed ?? 0} passed)`);
      for (const problem of problems) console.log(`     ${problem}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  if (runtime.process) runtime.process.exitCode = failures > 0 ? 1 : 0;
}

await main();
