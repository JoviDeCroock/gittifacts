/**
 * Local fuzzy search over command names, titles and descriptions: the offline twin of the MCP
 * `search_tools` discovery tool. Also powers "did you mean" for unknown commands and flags.
 */
import type { CommandSpec } from "./commands.js";

export interface SearchHit {
  command: string;
  tool: string | null;
  title?: string | undefined;
  description: string;
  score: number;
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** `chst` matches `change_status` (characters in order). */
function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i += 1;
  return i === needle.length;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur.push(Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = cur;
  }
  return prev[b.length] ?? Math.max(a.length, b.length);
}

function tokenScore(token: string, nameWords: string[], title: string, description: string) {
  if (nameWords.includes(token)) return 30;
  if (nameWords.some((w) => w.startsWith(token))) return 20;
  if (nameWords.some((w) => w.includes(token))) return 12;
  if (words(title).some((w) => w === token || w.startsWith(token))) return 10;
  if (words(description).some((w) => w === token)) return 8;
  if (words(description).some((w) => w.startsWith(token))) return 5;
  if (token.length >= 4 && nameWords.some((w) => levenshtein(token, w) <= 1)) return 6;
  if (token.length >= 3 && isSubsequence(token, nameWords.join(""))) return 3;
  return 0;
}

/** Ranks `commands` against a free-text query. Commands that match nothing are left out. */
export function searchCommands(
  query: string,
  commands: readonly CommandSpec[],
  limit = 10,
): SearchHit[] {
  const q = query.trim().toLowerCase();
  const tokens = words(q);
  if (tokens.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const c of commands) {
    const name = c.tool ?? c.command;
    const nameWords = words(name);
    const title = c.title ?? "";
    let score = 0;
    let matched = 0;
    for (const t of tokens) {
      const s = tokenScore(t, nameWords, title, c.description);
      score += s;
      if (s > 0) matched += 1;
    }
    if (matched === 0) continue;
    const joined = q.replace(/[\s-]+/g, "_");
    if (name === joined || c.command === q) score += 100;
    else if (name.includes(joined)) score += 40;
    // Every query word matching beats a high score on one word.
    score += matched === tokens.length ? 15 : 0;
    hits.push({ command: c.command, tool: c.tool, title: c.title, description: c.description, score });
  }
  return hits
    .sort((a, b) => b.score - a.score || a.command.localeCompare(b.command))
    .slice(0, limit);
}

/** Close spellings of `input` among `candidates` (for "did you mean"). */
export function suggest(input: string, candidates: readonly string[], max = 3): string[] {
  const a = input.toLowerCase();
  return candidates
    .map((c) => ({ c, d: levenshtein(a, c.toLowerCase()) }))
    .filter(({ c, d }) => d <= Math.max(2, Math.floor(c.length / 3)) || c.startsWith(a))
    .sort((x, y) => x.d - y.d || x.c.localeCompare(y.c))
    .slice(0, max)
    .map(({ c }) => c);
}
