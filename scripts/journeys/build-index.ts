/**
 * Builds journeys.json from the per-video metadata (<slug>.json next to each .webm) and a
 * hand-written review file (findings.json: { "<slug>": { findings: [{t, severity, text}], numbers? } }).
 *
 *   pnpm tsx scripts/journeys/build-index.ts --out <dir> [--findings <dir>/findings.json]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

interface Finding {
  t: number;
  severity: "P1" | "P2" | "P3";
  text: string;
}
interface Review {
  findings?: Finding[];
  numbers?: Record<string, number | string>;
  note?: string;
}

const { values } = parseArgs({
  options: { out: { type: "string" }, findings: { type: "string" } },
});
if (!values.out) {
  console.error("usage: build-index.ts --out <dir> [--findings findings.json]");
  process.exit(2);
}
const out = values.out;
const reviewPath = values.findings ?? join(out, "findings.json");
const reviews = existsSync(reviewPath)
  ? (JSON.parse(readFileSync(reviewPath, "utf8")) as Record<string, Review>)
  : {};

const entries = readdirSync(out)
  .filter((f) => /^\d\d-.*\.webm$/.test(f))
  .sort()
  .map((webm) => {
    const slug = webm.replace(/\.webm$/, "");
    const metaPath = join(out, `${slug}.json`);
    const meta = existsSync(metaPath)
      ? (JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>)
      : {};
    const review = reviews[slug] ?? {};
    const sev = { P1: 0, P2: 1, P3: 2 } as const;
    return {
      file: webm,
      title: meta.title,
      persona: meta.persona,
      viewport: meta.viewport,
      mode: meta.mode,
      durationSec: meta.durationSec,
      sizeMB: meta.sizeMB,
      realElapsedSec: meta.realElapsedSec,
      chapters: meta.chapters ?? [],
      numbers: { ...((meta.metrics as Record<string, unknown>) ?? {}), ...(review.numbers ?? {}) },
      findings: [...(review.findings ?? [])].sort(
        (a, b) => sev[a.severity] - sev[b.severity] || a.t - b.t,
      ),
      ...(review.note ? { note: review.note } : {}),
      consoleAndNetwork: meta.problems ?? [],
      cuts: ((meta.notes as string[] | undefined) ?? []).filter((n) => n.startsWith("cut ")),
    };
  });

writeFileSync(
  join(out, "journeys.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), journeys: entries }, null, 2)}\n`,
);
console.log(`${entries.length} journeys → ${join(out, "journeys.json")}`);
