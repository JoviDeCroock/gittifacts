#!/usr/bin/env node
// Markdown summary of a Playwright JSON report for $GITHUB_STEP_SUMMARY (docs/testing.md):
// counts, every failure, every test that only passed on its retry ("flaky": reported, never
// silently green), skips with their reason (quarantine, missing secrets) and timing annotations.
//
//   node scripts/e2e-summary.mjs <report.json> "<title>"
import { existsSync, readFileSync } from "node:fs";

const [file, title = "E2E"] = process.argv.slice(2);
if (!file || !existsSync(file)) {
  console.log(`### ${title}\n\nNo report at \`${file}\` (the run stopped before the tests).`);
  process.exit(0);
}
const report = JSON.parse(readFileSync(file, "utf8"));
const rows = { failed: [], flaky: [], skipped: [], passed: [], notes: [] };

function walk(suite, path) {
  for (const s of suite.suites ?? []) walk(s, [...path, s.title].filter(Boolean));
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      const name = `${[...path, spec.title].join(" › ")} [${t.projectName}]`;
      const results = t.results ?? [];
      const last = results.at(-1);
      const ms = results.reduce((a, r) => a + (r.duration ?? 0), 0);
      for (const a of t.annotations ?? []) {
        if (a.type !== "skip") rows.notes.push(`${name}: **${a.type}** ${a.description ?? ""}`);
      }
      if (t.status === "skipped") {
        const why = (t.annotations ?? []).find((a) => a.type === "skip")?.description ?? "";
        rows.skipped.push(`${name}${why ? `: ${why}` : ""}`);
      } else if (t.status === "flaky") rows.flaky.push(`${name} (passed on retry ${results.length - 1})`);
      else if (t.status === "unexpected") {
        const msg = (last?.error?.message ?? "").split("\n")[0].replace(/\u001b\[[0-9;]*m/g, "").slice(0, 300);
        rows.failed.push(`${name}: ${msg}`);
      } else rows.passed.push(`${name} (${(ms / 1000).toFixed(1)} s)`);
    }
  }
}
walk(report, []);

const secs = ((report.stats?.duration ?? 0) / 1000).toFixed(0);
const out = [`### ${title}`, ""];
out.push(
  `**${rows.failed.length === 0 ? "passed" : "FAILED"}** in ${secs} s: ${rows.passed.length} passed, ${rows.failed.length} failed, ${rows.flaky.length} flaky, ${rows.skipped.length} skipped`,
  "",
);
const section = (head, list) => {
  if (list.length === 0) return;
  out.push(`**${head}**`, "", ...list.map((l) => `- ${l}`), "");
};
section("Failed", rows.failed);
section("Flaky (passed only on the one allowed retry: fix or quarantine with an owner)", rows.flaky);
section("Skipped", rows.skipped);
section("Notes", rows.notes);
console.log(out.join("\n"));
