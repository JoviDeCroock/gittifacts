/**
 * Workers Issues webhook normalization. The webhook is the generic Notifications envelope; its
 * Issues `data` was undocumented, and is as captured live on 2026-10-02:
 *
 *   data: { issue: { id, title, fingerprint, count: "1", first_observed, last_observed,
 *           status: "ISSUE_STATUS_ACTIVE", type: "ISSUE_TYPE_EXCEPTION",
 *           services: [{ name: "<script>", type: "SERVICE_TYPE_WORKER", … }] },
 *           state_event: "ALERT_STATE_EVENT_START", state_correlation_id }
 *
 * No version id: the coordinator reads it from the issue's newest occurrence
 * (`Telemetry.issueOccurrence`). Fields are still read leniently from several spellings, and a
 * bare issue object (as `GET …/observability/issues/{id}` returns it) is accepted too.
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

const ChangeIdLike = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
const UrlLike = z.string().url();

export function normalizeIssue(payload: unknown, now: Date): NormalizedIssue | null {
  if (!isObj(payload)) return null;
  const data = isObj(payload.data) ? payload.data : {};
  const nested = isObj(data.issue) ? data.issue : {};
  const sources = [nested, data, payload];

  const id = firstString(sources, [
    "issueId",
    "issue_id",
    "id",
    "fingerprint",
    "alert_correlation_id",
  ]);
  if (id === null) return null;
  const scriptName =
    firstString(sources, [
      "service",
      "scriptName",
      "script_name",
      "worker",
      "workerName",
      "services.0.name",
      "$metadata.service",
    ]) ?? "";
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
  const count = Math.max(
    0,
    Math.trunc(firstNumber(sources, ["count", "occurrences", "occurrenceCount"]) ?? 1),
  );
  const firstSeen = toIso(
    firstString(sources, [
      "firstObserved",
      "first_observed",
      "firstSeen",
      "first_seen",
      "created",
      "ts",
    ]),
    now,
  );
  const lastSeen = toIso(
    firstString(sources, [
      "lastObserved",
      "last_observed",
      "lastSeen",
      "last_seen",
      "updated",
      "ts",
    ]),
    now,
  );
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
  const status = String(at(nested, "status") ?? at(data, "status") ?? "").toLowerCase();
  const resolved =
    payload.alert_event === "ALERT_STATE_EVENT_END" ||
    status === "resolved" ||
    status === "issue_status_resolved" ||
    status === "issue_status_ignored";
  return { issue: parsed.data, scriptName, resolved, raw: payload };
}

const FRAME = /at (?:([\w$.<>[\]]+) )?\(?((?:[\w@.-]+\/)*[\w@.-]+\.[cm]?[jt]sx?):\d+(?::\d+)?\)?/g;

/**
 * Stack frames from a Workers Issues payload, leniently (the payload is undocumented): V8 stack
 * strings anywhere in it, and objects with a `filename`/`file` field. Paths are repo-relative as
 * far as the stack says; deploy-train attribution scores Changes by them (§4.8).
 */
export function framesOf(raw: unknown): { file: string; fn?: string }[] {
  const out: { file: string; fn?: string }[] = [];
  const seen = new Set<string>();
  const push = (file: string, fn?: string) => {
    const clean = file.replace(/^(\.\/|\/+)/, "");
    const key = `${clean}#${fn ?? ""}`;
    if (seen.has(key) || out.length >= 200) return;
    seen.add(key);
    out.push(fn === undefined ? { file: clean } : { file: clean, fn });
  };
  const visit = (v: unknown, depth: number): void => {
    if (depth > 8 || out.length >= 200) return;
    if (typeof v === "string") {
      for (const m of v.matchAll(FRAME)) if (m[2] !== undefined) push(m[2], m[1]);
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
    } else if (isObj(v)) {
      const file = v.filename ?? v.fileName ?? v.file;
      const fn = v.function ?? v.functionName ?? v.fn;
      if (typeof file === "string" && file !== "")
        push(file, typeof fn === "string" ? fn : undefined);
      for (const x of Object.values(v)) visit(x, depth + 1);
    }
  };
  visit(raw, 0);
  return out;
}
