/**
 * POST /webhooks/workers-issues — Workers Issues → Notifications generic webhook.
 *
 * Authenticity: Cloudflare echoes the destination's shared secret in `cf-webhook-auth` (no HMAC,
 * no timestamp). Compared in constant time against ISSUES_WEBHOOK_SECRET; fail closed when unset.
 *
 * Wiring: one account-wide Issues automation → Notifications policy → generic webhook destination
 * (scripts/setup-workers-issues.sh), so every project Worker reports here without per-project
 * setup. Only project Workers (`gf-…`) are stored and forwarded: the platform's own Worker and
 * anything else in the account are acknowledged and dropped, and so is the destination's test
 * message.
 *
 * Payload: the generic Notifications envelope; `data.issue` carries the issue id, title, count,
 * timestamps and `services[].name` (the Worker), but no version id (captured live 2026-10-02,
 * docs/research/release-observability.md §2). We keep the raw body, extract what we can, and the
 * coordinator reads the version from the issue's newest occurrence (Issues API).
 */
import type { LinkedIssue } from "@app/domain";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv, Services } from "../app-env.js";
import { ApiError, unauthorized } from "../errors.js";
import { DEPLOY_SCRIPT_PREFIX } from "../services/repos.js";

export const ISSUES_WEBHOOK_PATH = "/webhooks/workers-issues";
const MAX_BODY_BYTES = 256 * 1024;

export const NotificationEnvelope = z
  .object({
    name: z.string().optional(),
    text: z.string().optional(),
    data: z.unknown().optional(),
    ts: z.number().optional(),
    account_id: z.string().optional(),
    policy_id: z.string().optional(),
    policy_name: z.string().optional(),
    alert_type: z.string().optional(),
    alert_correlation_id: z.string().optional(),
    alert_event: z.string().optional(),
  })
  .passthrough();
export type NotificationEnvelope = z.infer<typeof NotificationEnvelope>;

/** Constant-time comparison of two secrets (SHA-256 first, so lengths don't leak). */
export async function secretsEqual(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- lenient extraction

function at(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function firstString(sources: unknown[], paths: string[]): string | null {
  for (const src of sources) {
    for (const p of paths) {
      const v = p === "" ? src : at(src, p);
      if (typeof v === "string" && v.trim() !== "") return v.trim();
      if (typeof v === "number" && Number.isFinite(v)) return String(v);
    }
  }
  return null;
}

function firstCount(sources: unknown[], paths: string[]): number | null {
  for (const src of sources) {
    for (const p of paths) {
      const v = at(src, p);
      const n = typeof v === "string" ? Number(v) : v;
      if (typeof n === "number" && Number.isInteger(n) && n >= 0) return n;
    }
  }
  return null;
}

function toIso(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v < 1e12 ? v * 1000 : v; // seconds vs milliseconds
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === "string" && v.trim() !== "") {
    if (/^\d+(\.\d+)?$/.test(v.trim())) return toIso(Number(v));
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

function firstTime(sources: unknown[], paths: string[]): string | null {
  for (const src of sources) {
    for (const p of paths) {
      const iso = toIso(at(src, p));
      if (iso) return iso;
    }
  }
  return null;
}

function safeUrl(v: string | null): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export interface ExtractedIssue {
  id: string;
  title: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  scriptName: string;
  versionId: string | null;
  url: string | null;
}

export async function extractIssue(env: NotificationEnvelope, now: Date): Promise<ExtractedIssue> {
  const data = env.data;
  const sources = [data, at(data, "issue"), at(data, "occurrence")];
  const envTime = toIso(env.ts);
  let id = firstString(sources, ["issueId", "issue_id", "id", "fingerprint"]);
  if (!id) {
    id = env.alert_correlation_id ?? null;
  }
  if (!id) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([env.text ?? "", env.name ?? "", envTime ?? ""])),
    );
    id = `anon-${[...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }
  const title =
    firstString(sources, ["title", "issueTitle", "message", "error.message", "error"]) ??
    env.text ??
    env.name ??
    "Workers issue";
  const lastSeen =
    firstTime(sources, ["lastObserved", "last_observed", "lastSeen", "last_seen", "timestamp"]) ??
    envTime ??
    now.toISOString();
  const firstSeen =
    firstTime(sources, ["firstObserved", "first_observed", "firstSeen", "first_seen", "created"]) ??
    lastSeen;
  return {
    id: id.slice(0, 200),
    title: title.slice(0, 500),
    count:
      firstCount(sources, ["count", "occurrences", "occurrenceCount", "occurrence_count"]) ?? 1,
    firstSeen,
    lastSeen,
    scriptName:
      firstString(sources, [
        "service",
        "scriptName",
        "script_name",
        "script",
        "worker",
        "services.0.name",
        "$metadata.service",
      ]) ?? "unknown",
    versionId: firstString(sources, [
      "scriptVersion.id",
      "script_version.id",
      "versionId",
      "version_id",
      "scriptVersionId",
      "$workers.scriptVersion.id",
      "version.id",
    ]),
    url: safeUrl(
      firstString(sources, ["url", "issueUrl", "issue_url", "dashboardUrl", "dashboard_url"]),
    ),
  };
}

// ---------------------------------------------------------------- handler

export async function handleIssuesWebhook(c: Context<AppEnv>): Promise<Response> {
  const secret = c.env.ISSUES_WEBHOOK_SECRET;
  const given = c.req.header("cf-webhook-auth");
  if (!secret || !given || !(await secretsEqual(given, secret))) {
    throw unauthorized("invalid webhook secret");
  }
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES)
    throw new ApiError(413, "payload-too-large", "webhook body too large");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid-request", "webhook body is not JSON");
  }
  const parsed = NotificationEnvelope.safeParse(json);
  if (!parsed.success)
    throw new ApiError(400, "invalid-request", "webhook body is not a notification envelope");

  // The destination's "Hello World" test message (sent when it is created or tested).
  if (parsed.data.alert_type === undefined && parsed.data.data === undefined)
    return c.json({ received: true, ignored: "not a Workers Issues alert" }, 202);
  const svc: Services = c.get("services");
  const issue = await extractIssue(parsed.data, svc.clock.now());
  // The automation is account-wide: only project Workers concern the platform.
  if (issue.scriptName !== "unknown" && !issue.scriptName.startsWith(DEPLOY_SCRIPT_PREFIX))
    return c.json({ received: true, ignored: `not a project Worker: ${issue.scriptName}` }, 202);
  const change = issue.versionId
    ? await svc.store.getChangeByRolloutVersion(issue.versionId)
    : null;
  const linked: LinkedIssue & { scriptName: string; raw: unknown } = {
    id: issue.id,
    changeId: change?.id ?? null,
    title: issue.title,
    count: issue.count,
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
    versionId: issue.versionId,
    url: issue.url,
    scriptName: issue.scriptName,
    raw: json,
  };
  await svc.store.putIssue(linked);

  // Detection must not depend on this push: the rollout polls telemetry anyway. Forward, but never
  // fail the delivery (Notifications retries would only duplicate the stored issue).
  let forwarded = true;
  try {
    await svc.coordinator.onIssue(json);
  } catch (e) {
    forwarded = false;
    console.error("coordinator.onIssue failed", e);
  }
  return c.json({ received: true, issueId: issue.id, changeId: linked.changeId, forwarded }, 202);
}
