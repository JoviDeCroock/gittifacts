/**
 * Base-commit test results ("the baseline"), so a failure the default branch already has is not
 * held against a Change. A test is pre-existing only when it fails on base, in two runs (a flaky
 * failure is not a baseline), with the same failure signature as on head.
 *
 * Results are kept per test file in a cache document keyed by the base commit and the runner:
 *   $GITTIFACTS_BASELINE_IN   directory of cached documents (placed by the CI Runner; optional)
 *   $GITTIFACTS_BASELINE_OUT  where the merged document is written for the Runner to store
 * A file entry means the whole file ran on that commit. Without the env, nothing is cached and
 * every base result is measured.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripAnsi } from "@app/evidence";
import { z } from "zod";
import { errorMessage, log } from "./log.js";
import type { TestRunner, TestRunOutput } from "./test-runner.js";

/**
 * The part of a failure message that identifies it: ANSI-free lines up to the first stack frame
 * (at most 5), with checkout roots replaced so base and head paths compare equal.
 */
export function failureSignature(
  message: string | null | undefined,
  roots: readonly string[],
): string {
  let text = stripAnsi(message ?? "");
  for (const root of [...roots].filter((r) => r.length > 1).sort((a, b) => b.length - a.length))
    text = text.split(root).join("<root>");
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line === "") continue;
    if (/^at\s|^❯\s|^⎯/.test(line)) break;
    lines.push(line);
    if (lines.length === 5) break;
  }
  return lines.join(" / ").slice(0, 500);
}

const CaseEntry = z.object({
  outcome: z.enum(["pass", "fail", "skip"]),
  signature: z.string().optional(),
  /** A failure seen in two runs (only confirmed failures make a head failure pre-existing). */
  confirmed: z.boolean().optional(),
});
type CaseEntry = z.infer<typeof CaseEntry>;

const FileEntry = z.object({
  /** Signature of the error when the file failed to load; null when it loaded. */
  loadError: z.string().nullable(),
  loadConfirmed: z.boolean().optional(),
  tests: z.record(z.string(), CaseEntry),
});
export type FileEntry = z.infer<typeof FileEntry>;

const BaselineDoc = z.object({
  v: z.literal(1),
  sha: z.string(),
  runner: z.string(),
  files: z.record(z.string(), FileEntry),
});
type BaselineDoc = z.infer<typeof BaselineDoc>;

export function runnerId(runner: TestRunner): string {
  return `${runner.kind}@${runner.version ?? "?"} ${runner.args.join(" ")}`.trim();
}

/** Cached and newly measured base results for one commit and runner. */
export class BaselineStore {
  private readonly files = new Map<string, FileEntry>();
  private readonly cached = new Set<string>();
  private dirty = false;

  constructor(
    readonly sha: string,
    readonly runner: string,
  ) {}

  /** Loads every cached document for (sha, runner) from `$GITTIFACTS_BASELINE_IN`. */
  static load(
    sha: string,
    runner: string,
    dir = process.env.GITTIFACTS_BASELINE_IN,
  ): BaselineStore {
    const store = new BaselineStore(sha, runner);
    if (!dir || !existsSync(dir)) return store;
    for (const name of readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .sort()) {
      try {
        const doc = BaselineDoc.safeParse(JSON.parse(readFileSync(join(dir, name), "utf8")));
        if (!doc.success || doc.data.sha !== sha || doc.data.runner !== runner) continue;
        for (const [file, entry] of Object.entries(doc.data.files)) {
          store.files.set(file, entry);
          store.cached.add(file);
        }
      } catch (error) {
        log(`baseline: ignoring ${name}: ${errorMessage(error)}`);
      }
    }
    if (store.files.size > 0)
      log(`baseline: ${store.files.size} file(s) of ${sha.slice(0, 12)} cached`);
    return store;
  }

  get(file: string): FileEntry | undefined {
    return this.files.get(file);
  }

  isCached(file: string): boolean {
    return this.cached.has(file);
  }

  has(file: string): boolean {
    return this.files.has(file);
  }

  /** Every file with base results (cached or measured). */
  knownFiles(): string[] {
    return [...this.files.keys()].sort();
  }

  /**
   * Records the files of `first` (a full run of `files` on this commit); failures in `confirm`
   * (a second run of the failing files) are confirmed.
   */
  record(
    files: readonly string[],
    first: TestRunOutput,
    confirm: TestRunOutput | null,
    roots: readonly string[],
  ): void {
    for (const file of files) {
      const load = first.files.find((f) => f.file === file)?.loadError ?? null;
      const loadAgain = confirm?.files.find((f) => f.file === file)?.loadError ?? null;
      const tests: Record<string, CaseEntry> = {};
      for (const t of first.tests.filter((x) => x.file === file)) {
        if (t.outcome !== "fail") {
          if (tests[t.id]?.outcome !== "fail") tests[t.id] = { outcome: t.outcome };
          continue;
        }
        const again = confirm?.tests.find((x) => x.id === t.id);
        tests[t.id] = {
          outcome: "fail",
          signature: failureSignature(t.message, roots),
          confirmed: again?.outcome === "fail",
        };
      }
      this.files.set(file, {
        loadError: load === null ? null : failureSignature(load, roots),
        ...(load === null ? {} : { loadConfirmed: loadAgain !== null }),
        tests,
      });
      this.dirty = true;
    }
  }

  /** Writes the merged document to `$GITTIFACTS_BASELINE_OUT` when anything was measured. */
  save(out = process.env.GITTIFACTS_BASELINE_OUT): void {
    if (!out || !this.dirty) return;
    const doc: BaselineDoc = {
      v: 1,
      sha: this.sha,
      runner: this.runner,
      files: Object.fromEntries(this.files),
    };
    try {
      writeFileSync(out, JSON.stringify(doc));
    } catch (error) {
      log(`baseline: could not write ${out}: ${errorMessage(error)}`);
    }
  }
}

/** How a failure at head compares with the base commit. */
export type BaseVerdict = "pre-existing" | "new" | "differs" | "unknown";

/**
 * A head failure against the base entry of its file: `pre-existing` when it fails there too
 * (confirmed) with the same signature; `differs` when it fails there differently; `new` when it
 * passes (or is absent) there; `unknown` when the file has no base entry.
 */
export function compareFailure(
  entry: FileEntry | undefined,
  failure: { id: string; loadError: boolean; signature: string },
): BaseVerdict {
  if (entry === undefined) return "unknown";
  if (failure.loadError) {
    if (entry.loadError === null) return "new";
    if (entry.loadConfirmed !== true) return "unknown";
    return entry.loadError === failure.signature ? "pre-existing" : "differs";
  }
  if (entry.loadError !== null) return entry.loadConfirmed === true ? "differs" : "unknown";
  const base = entry.tests[failure.id];
  if (base === undefined || base.outcome !== "fail") return "new";
  if (base.confirmed !== true) return "new";
  return base.signature === failure.signature ? "pre-existing" : "differs";
}
