/**
 * Mutation score on changed lines from a Stryker `mutation.json`
 * (mutation-testing-report-schema, v1 or v2).
 *
 * A mutant counts when its location [start.line, end.line] contains a changed line.
 * Score = (Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage), Stryker's own
 * definition; CompileError, RuntimeError, Ignored and Pending mutants are not valid.
 * With no valid mutants on changed lines the item is `skipped` with score 0 (never a
 * free 100%).
 */
import { z } from "zod";
import { truncate } from "../encoding.js";
import type { MutationScore } from "../schema.js";
import { ProducerInputError } from "./errors.js";
import { createPathResolver } from "./paths.js";

const Position = z.object({ line: z.number().int(), column: z.number().int().optional() });
const Mutant = z.object({
  id: z.union([z.string(), z.number()]),
  mutatorName: z.string(),
  replacement: z.string().optional(),
  location: z.object({ start: Position, end: Position }),
  status: z.string(),
});
const FileResult = z.object({
  language: z.string().optional(),
  source: z.string().optional(),
  mutants: z.array(Mutant),
});
export const StrykerReport = z.object({
  schemaVersion: z.string(),
  projectRoot: z.string().optional(),
  files: z.record(z.string(), FileResult),
  framework: z.object({ name: z.string(), version: z.string().optional() }).optional(),
});
export type StrykerReport = z.infer<typeof StrykerReport>;

export const MUTANT_STATUSES = [
  "Killed",
  "Survived",
  "NoCoverage",
  "Timeout",
  "CompileError",
  "RuntimeError",
  "Ignored",
  "Pending",
] as const;

export function parseStrykerReport(input: unknown): StrykerReport {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (e) {
      throw new ProducerInputError(`mutation report is not JSON: ${(e as Error).message}`);
    }
  }
  const r = StrykerReport.safeParse(value);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new ProducerInputError(
      `not a mutation-testing-report-schema report${i ? ` (${i.path.join(".")}: ${i.message})` : ""}`,
    );
  }
  return r.data;
}

export interface MutationScoreOptions {
  id?: string;
  tool?: string;
  /** Prefix to strip from report file keys; defaults to the report's `projectRoot`. */
  root?: string;
  logRef?: string;
}

const MAX_SURVIVORS = 500;

export function mutationScore(
  report: StrykerReport,
  changedLines: Readonly<Record<string, readonly number[]>>,
  opts: MutationScoreOptions = {},
): MutationScore {
  const resolve = createPathResolver(Object.keys(report.files), opts.root ?? report.projectRoot);
  let killed = 0;
  let survived = 0;
  let timedOut = 0;
  let noCoverage = 0;
  let invalid = 0;
  const unknownStatuses = new Set<string>();
  const files: string[] = [];
  const survivors: MutationScore["survivors"] = [];

  for (const path of Object.keys(changedLines).sort()) {
    const lines = new Set(changedLines[path] ?? []);
    if (lines.size === 0) continue;
    const key = resolve(path);
    const result = key === undefined ? undefined : report.files[key];
    if (!result) continue;
    let touched = false;
    for (const m of result.mutants) {
      const { start, end } = m.location;
      let hit = false;
      for (let l = start.line; l <= Math.max(start.line, end.line); l++) {
        if (lines.has(l)) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
      touched = true;
      switch (m.status) {
        case "Killed":
          killed++;
          break;
        case "Timeout":
          timedOut++;
          break;
        case "Survived":
        case "NoCoverage": {
          if (m.status === "Survived") survived++;
          else noCoverage++;
          const s: MutationScore["survivors"][number] = {
            file: path,
            line: Math.max(1, start.line),
            mutator: m.mutatorName,
            status: m.status,
          };
          if (m.replacement !== undefined) s.replacement = truncate(m.replacement, 500);
          survivors.push(s);
          break;
        }
        case "CompileError":
        case "RuntimeError":
        case "Ignored":
        case "Pending":
          invalid++;
          break;
        default:
          unknownStatuses.add(m.status);
      }
    }
    if (touched) files.push(path);
  }

  const valid = killed + timedOut + survived + noCoverage;
  survivors.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  const item: MutationScore = {
    id: opts.id ?? "mutation",
    kind: "mutation",
    // Statuses we do not understand are an unknown, and unknown must not read as fine.
    status: unknownStatuses.size > 0 ? "error" : valid === 0 ? "skipped" : "ok",
    tool: opts.tool ?? "stryker",
    files,
    killed,
    survived,
    timedOut,
    noCoverage,
    score: valid === 0 ? 0 : (killed + timedOut) / valid,
    survivors: survivors.slice(0, MAX_SURVIVORS),
  };
  const notes: string[] = [];
  if (valid === 0) notes.push("no valid mutants on changed lines");
  if (invalid > 0)
    notes.push(
      `${invalid} mutants on changed lines were not valid (compile/runtime error, ignored, pending)`,
    );
  if (unknownStatuses.size > 0)
    notes.push(`unknown mutant statuses: ${[...unknownStatuses].join(", ")}`);
  if (survivors.length > MAX_SURVIVORS)
    notes.push(`${survivors.length - MAX_SURVIVORS} more survivors not listed`);
  if (notes.length > 0) item.note = truncate(notes.join("; "), 4000);
  if (opts.logRef !== undefined) item.logRef = opts.logRef;
  return item;
}
