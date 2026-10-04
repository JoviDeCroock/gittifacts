/** One-line human summaries of evidence items (CLI output, notifications, logs). */
import { truncate } from "./encoding.js";
import type { EvidenceItem } from "./schema.js";

const pct = (r: number): string => `${Math.floor(r * 1000) / 10}%`;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function body(item: EvidenceItem): string {
  switch (item.kind) {
    case "red-green": {
      const pre = item.preExisting?.length ?? 0;
      return `${item.verdict} (${plural(item.tests.length, "test")}${pre > 0 ? `; ${pre} pre-existing failure${pre === 1 ? "" : "s"} not counted` : ""})`;
    }
    case "test-run": {
      const pre = item.preExisting?.length ?? 0;
      const failed =
        pre > 0 ? `${item.failed} failed (${pre} pre-existing)` : `${item.failed} failed`;
      return `${item.passed} passed, ${failed}, ${item.skipped} skipped (${item.runner})`;
    }
    case "coverage": {
      const base = `${pct(item.ratio)} of ${plural(item.changedLines, "changed executable line")} covered`;
      const n = item.unmeasuredFiles?.length ?? 0;
      return n > 0 ? `${base}; ${plural(n, "changed file")} not in report` : base;
    }
    case "mutation":
      return `score ${pct(item.score)} (${item.killed} killed, ${item.timedOut} timed out, ${item.survived} survived, ${item.noCoverage} no coverage)`;
    case "public-api": {
      const count = (k: "added" | "removed" | "changed") =>
        item.packages.reduce((n, p) => n + p[k].length, 0);
      return `${item.classification} (+${count("added")} -${count("removed")} ~${count("changed")})`;
    }
    case "dependencies": {
      const parts = [`+${item.added.length} -${item.removed.length} ~${item.changed.length}`];
      if (item.newInstallScripts.length > 0)
        parts.push(plural(item.newInstallScripts.length, "new install script"));
      if (item.lockfileChanged) parts.push("lockfile changed");
      return parts.join(", ");
    }
    case "sensitive-paths": {
      if (item.hits.length === 0) return `no hits (${plural(item.patterns.length, "pattern")})`;
      const paths = [...new Set(item.hits.map((h) => h.path))];
      const shown = paths.slice(0, 3).join(", ");
      return `${plural(item.hits.length, "hit")}: ${shown}${paths.length > 3 ? ", ..." : ""}`;
    }
    case "preview":
      return item.url ?? item.versionId ?? "no preview url";
    case "screenshots": {
      const diffs = item.shots.map((s) => s.diffRatio).filter((d): d is number => d !== undefined);
      const max = diffs.length > 0 ? `, max diff ${pct(Math.max(...diffs))}` : "";
      return `${plural(item.shots.length, "shot")}${max}`;
    }
    case "agent-trace":
      return `${item.provider} trace ${item.traceId}`;
    case "transform":
      return item.verified
        ? `${item.transform}: reproduced (${plural(item.files.length, "file")})`
        : `${item.transform}: NOT reproduced (${item.mismatchedFiles.length} mismatched)`;
    case "llm-judgment":
      return `${item.question}: ${item.outcome} (${item.model})`;
    case "conflict-resolution": {
      const against = `against ${plural(item.upstreamChanges.length, "upstream change")}`;
      const scope = item.touchesOutsideConflictHunks
        ? "edits outside the conflict hunks"
        : `within ${plural(item.conflictHunks.length, "conflict hunk")}`;
      const semantic =
        item.semanticConflictWith === null
          ? ""
          : `, semantic conflict with ${item.semanticConflictWith}`;
      return `resolved ${against}, ${scope}${semantic} (${item.resolver.model})`;
    }
    case "quarantine":
      return `${plural(item.tests.length, "quarantined test")}, ${item.inAffectedSet.length} in the affected set`;
    case "qa-run": {
      const n = (v: string) => item.criteria.filter((c) => c.verdict === v).length;
      return `QA ${n("pass")} passed, ${n("fail")} failed, ${n("couldnt-test")} couldn't test (${plural(item.artifacts.length, "artifact")}, ${item.model})`;
    }
  }
}

/**
 * For `ok` items, the measurement; for `skipped`/`error` items, why — their numbers are
 * not measurements and are deliberately not shown.
 */
export function summarizeItem(item: EvidenceItem): string {
  if (item.status === "ok") return body(item);
  const why = item.note ? `: ${truncate(item.note.replace(/\s+/g, " "), 120)}` : "";
  return item.status === "error" ? `measurement failed${why}` : `skipped${why}`;
}
