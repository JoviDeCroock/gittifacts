/**
 * Workers Issues webhook normalization. The webhook is the generic Notifications envelope and the
 * Issues-specific `data` is undocumented (release-observability.md §2, §9), so this reads the
 * fields leniently from several plausible spellings, and also accepts a bare issue object (as
 * returned by `GET …/observability/issues/{id}`, which the HTTP layer may re-fetch).
 */
import { LinkedIssue } from "@app/domain";
import { z } from "zod";

export interface NormalizedIssue {
  issue: LinkedIssue;
  scriptName: string;
  /** The alert closed (`ALERT_STATE_EVENT_END`): stored, but not a rollout signal. */
  resolved: boolean;
  raw: unknown;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function at(source: Obj, path: string): unknown {
  let cur: unknown = source;
  for (const key of path.split(".")) {
    if (!isObj(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function firstString(sources: Obj[], paths: string[]): string | null {
  for (const s of sources) {
    for (const p of paths) {
      const v = at(s, p);
      if (typeof v === "string" && v.trim() !== "") return v.trim();
      if (typeof v === "number" && Number.isFinite(v)) return String(v);
    }
  }
  return null;
}

function firstNumber(sources: Obj[], paths: string[]): number | null {
  for (const s of sources) {
    for (const p of paths) {
      const v = at(s, p);
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    }
  }
  return null;
}

function toIso(v: string | null, fallback: Date): string {
  if (v === null) return fallback.toISOString();
  // Unix seconds or milliseconds.
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? fallback.toISOString() : d.toISOString();
}

const ChangeIdLike = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const UrlLike = z.string().url();

export function normalizeIssue(payload: unknown, now: Date): NormalizedIssue | null {
  if (!isObj(payload)) return null;
  const data = isObj(payload.data) ? payload.data : {};
  const nested = isObj(data.issue) ? data.issue : {};
  const sources = [nested, data, payload];

  const id = firstString(sources, ["issueId", "issue_id", "id", "fingerprint", "alert_correlation_id"]);
  if (id === null) return null;
  const scriptName =
    firstString(sources, ["service", "scriptName", "script_name", "worker", "workerName", "$metadata.service"]) ?? "";
  const title =
    firstString(sources, ["title", "message", "error.message", "text", "name"]) ?? "Workers issue";
  const versionId = firstString(sources, [
    "scriptVersion.id",
    "versionId",
    "version_id",
    "scriptVersionId",
    "workerVersionId",
    "$workers.scriptVersion.id",
  ]);
  const tag = firstString(sources, ["scriptVersion.tag", "versionTag", "version_tag", "changeId"]);
  const changeId = tag !== null && ChangeIdLike.safeParse(tag).success ? tag : null;
  const count = Math.max(0, Math.trunc(firstNumber(sources, ["count", "occurrences", "occurrenceCount"]) ?? 1));
  const firstSeen = toIso(firstString(sources, ["firstObserved", "first_observed", "firstSeen", "first_seen", "created", "ts"]), now);
  const lastSeen = toIso(firstString(sources, ["lastObserved", "last_observed", "lastSeen", "last_seen", "updated", "ts"]), now);
  const urlRaw = firstString(sources, ["url", "link", "dashboardUrl"]);
  const url = urlRaw !== null && UrlLike.safeParse(urlRaw).success ? urlRaw : null;

  const parsed = LinkedIssue.safeParse({
    id: id.slice(0, 200),
    changeId,
    title: title.slice(0, 500),
    count,
    firstSeen,
    lastSeen,
    versionId,
    url,
  });
  if (!parsed.success) return null;
  const resolved = payload.alert_event === "ALERT_STATE_EVENT_END" || at(data, "status") === "resolved";
  return { issue: parsed.data, scriptName, resolved, raw: payload };
}
