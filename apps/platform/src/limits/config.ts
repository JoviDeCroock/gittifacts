/**
 * Hard limits for unclaimed projects (docs/prompts/02-onboarding.md §4, O3). One place for the
 * numbers; every enforcement point reads them from here. Defaults are deliberately tight: an
 * unclaimed project is the platform's main abuse vector (crypto mining in CI, spam or phishing on
 * previews). Operators can tune them without a deploy of code through the `UNCLAIMED_LIMITS` var
 * (a JSON object with any subset of the fields below) and `UNCLAIMED_TTL_DAYS`.
 *
 * Claiming a project lifts every one of these: the checks key off `repo.claim.status` at call
 * time, so nothing needs migrating when a human claims it.
 */
import type { UnclaimedQuotaHints } from "@app/conventions";
import { z } from "zod";

const MiB = 1024 * 1024;

const Bucket = z.object({
  /** Requests allowed in a burst. */
  capacity: z.number().int().min(1),
  /** Seconds to refill the whole capacity. */
  periodSec: z.number().int().min(1),
});
export type Bucket = z.infer<typeof Bucket>;

export const UnclaimedLimits = z.object({
  ttlDays: z.number().min(0.0001).max(90),
  ci: z.object({
    minutesPerDay: z.number().int().min(1),
    minutesPerRun: z.number().int().min(1),
    maxLogBytes: z
      .number()
      .int()
      .min(64 * 1024),
    maxArtifactBytes: z.number().int().min(MiB),
    instance: z.enum(["lite", "standard-1", "standard-2"]),
  }),
  /** Bytes the platform stores for the project (CI logs, build artifacts), all time. */
  storageBytes: z.number().int().min(0),
  /** Platform-mediated Artifacts operations (forks, push/clone tokens, imports) per UTC day. */
  artifactsOpsPerDay: z.number().int().min(1),
  /** Aggregate over every unclaimed project created from one IP (or IPv6 /64). */
  perIp: z.object({
    ciMinutesPerDay: z.number().int().min(1),
    storageBytes: z.number().int().min(0),
    artifactsOpsPerDay: z.number().int().min(1),
  }),
  /** Credential-less create_project: token buckets per IP, per ASN and platform-wide. */
  creation: z.object({
    ipHour: Bucket,
    ipDay: Bucket,
    asnHour: Bucket,
    asnDay: Bucket,
    globalHour: Bucket,
    globalDay: Bucket,
  }),
  /** Requests per minute per unclaimed token (mirrors the UNCLAIMED_TOKEN_LIMITER binding). */
  requestsPerMinute: z.number().int().min(1),
});
export type UnclaimedLimits = z.infer<typeof UnclaimedLimits>;

export const DEFAULT_UNCLAIMED_LIMITS: UnclaimedLimits = {
  ttlDays: 7,
  ci: {
    minutesPerDay: 60,
    minutesPerRun: 10,
    maxLogBytes: 2 * MiB,
    maxArtifactBytes: 20 * MiB,
    instance: "standard-2",
  },
  storageBytes: 200 * MiB,
  artifactsOpsPerDay: 300,
  perIp: { ciMinutesPerDay: 120, storageBytes: 500 * MiB, artifactsOpsPerDay: 600 },
  creation: {
    ipHour: { capacity: 3, periodSec: 3600 },
    ipDay: { capacity: 10, periodSec: 86_400 },
    asnHour: { capacity: 30, periodSec: 3600 },
    asnDay: { capacity: 200, periodSec: 86_400 },
    globalHour: { capacity: 300, periodSec: 3600 },
    globalDay: { capacity: 2000, periodSec: 86_400 },
  },
  requestsPerMinute: 120,
};

/** Shallow-per-section merge of a partial override onto the defaults. */
function merge(base: UnclaimedLimits, raw: unknown): UnclaimedLimits {
  if (typeof raw !== "object" || raw === null) return base;
  const o = raw as Record<string, unknown>;
  const section = <T extends object>(b: T, v: unknown): T =>
    typeof v === "object" && v !== null ? { ...b, ...(v as Partial<T>) } : b;
  const creation = section(base.creation, o.creation);
  const candidate = {
    ...base,
    ...o,
    ci: section(base.ci, o.ci),
    perIp: section(base.perIp, o.perIp),
    creation: Object.fromEntries(
      Object.entries(creation).map(([k, v]) => [
        k,
        section(base.creation[k as keyof UnclaimedLimits["creation"]], v),
      ]),
    ),
  };
  const parsed = UnclaimedLimits.safeParse(candidate);
  if (!parsed.success) {
    console.warn("UNCLAIMED_LIMITS is invalid; using the defaults", parsed.error.issues[0]);
    return base;
  }
  return parsed.data;
}

export interface LimitsEnv {
  UNCLAIMED_LIMITS?: string;
  UNCLAIMED_TTL_DAYS?: string;
}

export function unclaimedLimits(env: LimitsEnv): UnclaimedLimits {
  let limits = DEFAULT_UNCLAIMED_LIMITS;
  if (env.UNCLAIMED_LIMITS) {
    try {
      limits = merge(limits, JSON.parse(env.UNCLAIMED_LIMITS));
    } catch {
      console.warn("UNCLAIMED_LIMITS is not JSON; using the defaults");
    }
  }
  const ttl = Number(env.UNCLAIMED_TTL_DAYS);
  if (env.UNCLAIMED_TTL_DAYS && Number.isFinite(ttl) && ttl > 0 && ttl <= 90) {
    limits = { ...limits, ttlDays: ttl };
  }
  return limits;
}

export function unclaimedTtlMs(env: LimitsEnv): number {
  return Math.round(unclaimedLimits(env).ttlDays * 86_400_000);
}

/** What /start, llms.txt and whoami tell agents (numbers, not adjectives). */
export function quotaHints(
  l: UnclaimedLimits,
  workspaceCpuMinutesPerDay: number,
): UnclaimedQuotaHints {
  return {
    ttlDays: l.ttlDays,
    ciMinutesPerDay: l.ci.minutesPerDay,
    ciMinutesPerRun: l.ci.minutesPerRun,
    storageMb: Math.round(l.storageBytes / MiB),
    artifactsOpsPerDay: l.artifactsOpsPerDay,
    workspaceCpuMinutesPerDay,
    requestsPerMinute: l.requestsPerMinute,
    createsPerIpPerHour: l.creation.ipHour.capacity,
  };
}
