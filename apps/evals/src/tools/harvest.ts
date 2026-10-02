/**
 * Reads platform ids, preview URLs and platform error codes out of raw tool output (before
 * truncation), so the checker can attribute what a run created to that run, and the report can
 * show which errors agents hit. Text-based on purpose: the agent may reach the platform through
 * MCP, the HTTP API or curl in its shell, and all of them print the same JSON fields.
 */
import { emptyHarvest, type Harvest } from "../agent/tool-outcome.js";

const ID = "[A-Za-z0-9][A-Za-z0-9._:-]{0,63}";
const FIELD = new RegExp(`"(projectId|repoId|changeId|planId)"\\s*:\\s*"(${ID})"`, "g");
/** `"change": { "id": "…"` (Change objects carry `id` first), same for plan and repo. */
const OBJECT_ID = new RegExp(
  `"(change|plan|repo|project)"\\s*:\\s*\\{\\s*"id"\\s*:\\s*"(${ID})"`,
  "g",
);
/** Fork remotes are `…/task-<changeId>.git` (or without `.git`). */
const TASK_FORK = /\/task-([a-z0-9]{6,40})(?:\.git)?\b/g;
/** Bootstrap changes are `bs-<repoId>` (repo ids are [0-9a-z], 20 characters). */
const BOOTSTRAP = /\bbs-([a-z0-9]{4,40})(?![a-z0-9])/g;
const URL_RE = /https?:\/\/[^\s"'<>`\\)\]]+/g;

export function harvest(text: string, previewSuffix: string): Harvest {
  const h = emptyHarvest();
  const add = (list: string[], v: string) => {
    if (!list.includes(v)) list.push(v);
  };
  for (const m of text.matchAll(FIELD)) {
    const [, field, value] = m;
    if (field === "changeId") add(h.changeIds, value!);
    else if (field === "planId") add(h.planIds, value!);
    else add(h.repoIds, value!);
  }
  for (const m of text.matchAll(OBJECT_ID)) {
    const [, kind, value] = m;
    if (kind === "change") add(h.changeIds, value!);
    else if (kind === "plan") add(h.planIds, value!);
    else add(h.repoIds, value!);
  }
  for (const m of text.matchAll(TASK_FORK)) add(h.changeIds, m[1]!);
  for (const m of text.matchAll(BOOTSTRAP)) {
    add(h.changeIds, `bs-${m[1]!}`);
    add(h.repoIds, m[1]!);
  }
  const suffix = previewSuffix.toLowerCase();
  for (const m of text.matchAll(URL_RE)) {
    let u: URL;
    try {
      u = new URL(m[0].replace(/[.,;:]+$/, ""));
    } catch {
      continue;
    }
    if (suffix && u.hostname.toLowerCase().endsWith(suffix)) {
      add(h.previewUrls, `${u.protocol}//${u.hostname.toLowerCase()}`);
    }
  }
  return h;
}

/** True when `h` found nothing. */
export function isEmptyHarvest(h: Harvest): boolean {
  return h.repoIds.length + h.changeIds.length + h.planIds.length + h.previewUrls.length === 0;
}

/**
 * Platform error codes in a JSON body: `{ "error": { "code": "…" } }` (HTTP API) or a top-level
 * `{ "code": "…", "message": …, "fix": … }` (MCP tool errors), anywhere in the text; each code
 * once per result.
 */
export function errorCodes(text: string): string[] {
  const out = new Set<string>();
  const nested = /"error"\s*:\s*\{\s*"code"\s*:\s*"([a-z0-9][a-z0-9._-]{0,63})"/g;
  const flat = /"code"\s*:\s*"([a-z][a-z0-9._-]{0,63})"\s*,\s*"message"\s*:/g;
  for (const m of text.matchAll(nested)) out.add(m[1]!);
  for (const m of text.matchAll(flat)) out.add(m[1]!);
  return [...out];
}
