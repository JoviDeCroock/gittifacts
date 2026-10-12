/**
 * Browsing a repo's code and history (read-only): the tree at a ref, one file, the commit log,
 * one commit with its diff, and commit activity. The schemas are the HTTP and MCP contract; the
 * helpers are pure (no I/O, no clocks: `now` is passed in).
 */
import { Sha } from "@app/evidence";
import { z } from "zod";
import { ChangeDiffFile, Id, IsoDate, Lane } from "./model.js";

/** Commits a log page holds at most (Artifacts' `log` answers up to 1000 per call). */
export const MAX_LOG_PAGE = 100;
/** Commits the activity summary reads at most; older history is reported as `truncated`. */
export const MAX_ACTIVITY_COMMITS = 1000;
/** Text served inline at most; a larger file is `too-large` (fetch it raw). */
export const MAX_INLINE_FILE_BYTES = 512 * 1024;
/** Weeks of activity a caller may ask for. */
export const MAX_ACTIVITY_WEEKS = 52;

/** A branch, tag or commit sha. No spaces, no `..`, nothing git refuses in a ref name. */
export const CodeRef = z
  .string()
  .min(1)
  .max(255)
  .regex(/^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._\-/]+$/, "not a branch, tag or commit sha");

/**
 * A repo-relative path ("" is the root): no leading or trailing slash, no empty, `.` or `..`
 * segment, no NUL. Returns null for anything else, so a caller can answer 400.
 */
export function normalizeRepoPath(input: string): string | null {
  const trimmed = input.replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return "";
  if (trimmed.length > 1024 || trimmed.includes("\0")) return null;
  const parts = trimmed.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return parts.join("/");
}

export const CodeEntryKind = z.enum(["dir", "file", "symlink", "submodule"]);
export type CodeEntryKind = z.infer<typeof CodeEntryKind>;

export const CodeTreeEntry = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  kind: CodeEntryKind,
  /** Git mode as written in the tree ("100644", "100755", "120000", "160000", "40000"). */
  mode: z.string(),
  sha: Sha,
});
export type CodeTreeEntry = z.infer<typeof CodeTreeEntry>;

/** Directories first, then files, each by name (as a file browser lists them). */
export function sortTreeEntries<T extends { name: string; kind: CodeEntryKind }>(
  entries: T[],
): T[] {
  const rank = (k: CodeEntryKind) => (k === "dir" ? 0 : 1);
  return [...entries].sort(
    (a, b) => rank(a.kind) - rank(b.kind) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

const README = /^readme(\.(md|markdown|txt|rst))?$/i;

/** The entry a directory listing shows below itself: README.md first, then any README. */
export function readmeOf<T extends { name: string; kind: CodeEntryKind }>(entries: T[]): T | null {
  const files = entries.filter((e) => e.kind === "file" && README.test(e.name));
  return files.find((e) => /\.md$/i.test(e.name)) ?? files[0] ?? null;
}

export const CodeFileKind = z.enum(["text", "binary", "too-large"]);
export type CodeFileKind = z.infer<typeof CodeFileKind>;

export const CodeFile = z.object({
  path: z.string().min(1),
  sha: Sha,
  size: z.number().int().nonnegative(),
  kind: CodeFileKind,
  /** UTF-8 content; null unless `kind` is "text". */
  text: z.string().nullable(),
});
export type CodeFile = z.infer<typeof CodeFile>;

export const CodeTree = z.object({
  ref: z.string(),
  commitSha: Sha,
  path: z.string(),
  entries: z.array(CodeTreeEntry),
  /** The directory's README, when it has one and it is text. */
  readme: CodeFile.nullable(),
});
export type CodeTree = z.infer<typeof CodeTree>;

export const CodeFileResponse = z.object({
  ref: z.string(),
  commitSha: Sha,
  file: CodeFile,
});
export type CodeFileResponse = z.infer<typeof CodeFileResponse>;

/**
 * Binary or text, the way git decides for diffs: a NUL in the first 8000 bytes is binary; so is
 * anything that is not valid UTF-8.
 */
export function classifyFile(bytes: Uint8Array): { kind: CodeFileKind; text: string | null } {
  if (bytes.length > MAX_INLINE_FILE_BYTES) return { kind: "too-large", text: null };
  if (bytes.subarray(0, 8000).includes(0)) return { kind: "binary", text: null };
  try {
    return { kind: "text", text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes) };
  } catch {
    return { kind: "binary", text: null };
  }
}

// ---------------------------------------------------------------- history

export const CommitPerson = z.object({
  name: z.string(),
  email: z.string(),
  /** Null when the host did not say. */
  at: IsoDate.nullable(),
});
export type CommitPerson = z.infer<typeof CommitPerson>;

/** The Change that landed a commit on the default branch (its `mergedSha`), if one did. */
export const LandedBy = z.object({
  changeId: Id,
  title: z.string(),
  lane: Lane.nullable(),
  authorKind: z.enum(["human", "agent", "system", "integration"]),
  authorName: z.string(),
});
export type LandedBy = z.infer<typeof LandedBy>;

export const CommitSummary = z.object({
  sha: Sha,
  /** The message's first line. */
  title: z.string(),
  message: z.string(),
  author: CommitPerson,
  committer: CommitPerson,
  parents: z.array(Sha),
  landedBy: LandedBy.nullable(),
});
export type CommitSummary = z.infer<typeof CommitSummary>;

export const CommitLog = z.object({
  ref: z.string(),
  /** The commit `ref` names; null when it names nothing (an empty repo). */
  headSha: Sha.nullable(),
  commits: z.array(CommitSummary),
  /** Pass as `offset` for the next page; null on the last one. */
  nextOffset: z.number().int().nonnegative().nullable(),
});
export type CommitLog = z.infer<typeof CommitLog>;

export const CommitDetail = z.object({
  commit: CommitSummary,
  /** Against the first parent; a root commit against the empty tree (`parentSha` null). */
  diff: z.object({
    parentSha: Sha.nullable(),
    files: z.array(ChangeDiffFile),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    /**
     * False when the commit touches more files than a commit view reads: files past the cap are
     * listed (`truncated`, no counts) and the totals cover the read files only.
     */
    complete: z.boolean(),
  }),
});
export type CommitDetail = z.infer<typeof CommitDetail>;

/** First line of a commit message, trimmed ("(no message)" when empty). */
export function commitTitle(message: string): string {
  const line = message.trimStart().split("\n", 1)[0]?.trim() ?? "";
  return line === "" ? "(no message)" : line.slice(0, 200);
}

// ---------------------------------------------------------------- activity

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CommitActivity = z.object({
  ref: z.string(),
  headSha: Sha.nullable(),
  weeks: z.number().int().positive(),
  /** First day of the window (a Monday, UTC) and today (UTC). */
  from: Day,
  to: Day,
  /** One row per day from `from` to `to`, by the date a commit landed (committer date). */
  days: z.array(z.object({ date: Day, commits: z.number().int().nonnegative() })),
  total: z.number().int().nonnegative(),
  /** Most commits first, at most 10. */
  authors: z.array(z.object({ name: z.string(), commits: z.number().int().positive() })),
  /**
   * The read stopped at its cap while still inside the window: the counts are a lower bound,
   * never a complete picture.
   */
  truncated: z.boolean(),
});
export type CommitActivity = z.infer<typeof CommitActivity>;

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Buckets commits (newest first, as `log` returns them) into UTC days over the last `weeks` whole
 * weeks, Monday-aligned so a calendar grid has full columns. `capped`: the read hit its limit.
 * Commits with no date (`at` null) are not counted anywhere: they say nothing about when.
 */
export function commitActivity(
  commits: ReadonlyArray<{ at: number | null; author: string }>,
  input: { nowMs: number; weeks: number; capped: boolean },
): Omit<CommitActivity, "ref" | "headSha"> {
  const today = Math.floor(input.nowMs / DAY_MS) * DAY_MS;
  // getUTCDay: 0 = Sunday; Monday-based offset.
  const sinceMonday = (new Date(today).getUTCDay() + 6) % 7;
  const start = today - sinceMonday * DAY_MS - (input.weeks - 1) * 7 * DAY_MS;
  const counts = new Map<string, number>();
  const authors = new Map<string, number>();
  let total = 0;
  let oldest: number | null = null;
  for (const c of commits) {
    if (c.at === null) continue;
    const ms = c.at * 1000;
    oldest = oldest === null ? ms : Math.min(oldest, ms);
    if (ms < start || ms >= today + DAY_MS) continue;
    const day = isoDay(ms);
    counts.set(day, (counts.get(day) ?? 0) + 1);
    const who = c.author.trim() || "Unknown";
    authors.set(who, (authors.get(who) ?? 0) + 1);
    total++;
  }
  const days: CommitActivity["days"] = [];
  for (let d = start; d <= today; d += DAY_MS) {
    const date = isoDay(d);
    days.push({ date, commits: counts.get(date) ?? 0 });
  }
  return {
    weeks: input.weeks,
    from: isoDay(start),
    to: isoDay(today),
    days,
    total,
    authors: [...authors.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 10)
      .map(([name, n]) => ({ name, commits: n })),
    truncated: input.capped && (oldest === null || oldest >= start),
  };
}
