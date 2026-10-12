/**
 * A repo's code and history, without rendering: page hrefs (the same shapes as @app/conventions
 * `pageUrl`), path crumbs, sizes, the activity calendar and commits grouped by day. Pure.
 */
import type { CommitActivity, CommitSummary } from "@app/domain";

const enc = encodeURIComponent;
const repoBase = (repoId: string) => `/repos/${enc(repoId)}`;
const encodePath = (path: string) => path.split("/").filter(Boolean).map(enc).join("/");
const refQuery = (ref: string | undefined) => (ref ? `?ref=${enc(ref)}` : "");

export function treeHref(repoId: string, path = "", ref?: string): string {
  const p = encodePath(path);
  return `${repoBase(repoId)}/tree${p ? `/${p}` : ""}${refQuery(ref)}`;
}

export function blobHref(repoId: string, path: string, ref?: string): string {
  return `${repoBase(repoId)}/blob/${encodePath(path)}${refQuery(ref)}`;
}

export function commitsHref(repoId: string, ref?: string): string {
  return `${repoBase(repoId)}/commits${refQuery(ref)}`;
}

export function commitHref(repoId: string, sha: string): string {
  return `${repoBase(repoId)}/commits/${enc(sha)}`;
}

export function activityHref(repoId: string, ref?: string): string {
  return `${repoBase(repoId)}/activity${refQuery(ref)}`;
}

export const shortSha = (sha: string) => sha.slice(0, 7);

/** "src/lib/a.ts" → [src, src/lib, src/lib/a.ts], each with its own name. */
export function pathCrumbs(path: string): Array<{ name: string; path: string }> {
  const parts = path.split("/").filter(Boolean);
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }));
}

export function parentPath(path: string): string {
  return path.split("/").filter(Boolean).slice(0, -1).join("/");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Lines of a text file (a trailing newline does not start another). */
export function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|ico)$/i;
export const isImagePath = (path: string) => IMAGE.test(path);
export const isMarkdownPath = (path: string) => /\.(md|markdown)$/i.test(path);

// ---------------------------------------------------------------- activity

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export interface ActivityCell {
  date: string;
  commits: number;
  level: HeatLevel;
}

export interface ActivityGrid {
  /** Columns, oldest first: one per week, Monday to Sunday (days after `to` are null). */
  weeks: Array<Array<ActivityCell | null>>;
  /** Month labels over the first column each month starts in. */
  months: Array<{ column: number; label: string }>;
  /** The busiest day's count, for the scale key. */
  max: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Lays the days of `activity` (Monday-aligned) into week columns. Levels split the busiest day
 * into quarters (1 = a quarter or less), so one busy day does not wash the rest to level 1 only
 * when the spread is small; zero is always level 0.
 */
export function activityGrid(activity: Pick<CommitActivity, "days">): ActivityGrid {
  const max = activity.days.reduce((m, d) => Math.max(m, d.commits), 0);
  const level = (n: number): HeatLevel =>
    n === 0 || max === 0 ? 0 : (Math.min(4, Math.ceil((n / max) * 4)) as HeatLevel);
  const weeks: ActivityGrid["weeks"] = [];
  const months: ActivityGrid["months"] = [];
  let lastMonth = -1;
  for (let i = 0; i < activity.days.length; i += 7) {
    const week = activity.days.slice(i, i + 7).map((d) => ({ ...d, level: level(d.commits) }));
    const month = Number(week[0]?.date.slice(5, 7)) - 1;
    if (month !== lastMonth) {
      months.push({ column: weeks.length, label: MONTHS[month] ?? "" });
      lastMonth = month;
    }
    weeks.push([...week, ...Array<null>(7 - week.length).fill(null)]);
  }
  return { weeks, months, max };
}

/** Commits per week, oldest first, with the Monday each starts on. */
export function weeklyTotals(
  activity: Pick<CommitActivity, "days">,
): Array<{ week: string; commits: number }> {
  const out: Array<{ week: string; commits: number }> = [];
  for (let i = 0; i < activity.days.length; i += 7) {
    const days = activity.days.slice(i, i + 7);
    out.push({ week: days[0]?.date ?? "", commits: days.reduce((n, d) => n + d.commits, 0) });
  }
  return out;
}

/** "2026-10-12" → "Mon 12 Oct 2026" (UTC, like the buckets). */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  return `${wd} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** When a commit landed (committer time), else when it was written. */
export const commitTime = (c: CommitSummary) => c.committer.at ?? c.author.at;

/** Commits in log order, grouped under the UTC day they landed on ("unknown" last). */
export function commitsByDay(
  commits: CommitSummary[],
): Array<{ date: string | null; commits: CommitSummary[] }> {
  const groups: Array<{ date: string | null; commits: CommitSummary[] }> = [];
  for (const c of commits) {
    const at = commitTime(c);
    const date = at === null ? null : at.slice(0, 10);
    const last = groups.at(-1);
    if (last && last.date === date) last.commits.push(c);
    else groups.push({ date, commits: [c] });
  }
  return groups;
}
