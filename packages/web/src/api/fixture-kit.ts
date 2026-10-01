/**
 * Helpers for synthetic demo data. Deterministic: the same seed always yields the same SHA or
 * hash, so screenshots and tests are stable. Times are relative to module load, so countdowns
 * in the demo are always live.
 */
import type { PipelineRun } from "./types.js";

export const NOW = Date.now();

export function ago(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

export function ahead(minutes: number): string {
  return new Date(NOW + minutes * 60_000).toISOString();
}

function fnv(seed: string, salt: number): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** 40-char lowercase hex, valid for the `Sha` schema. */
export function sha(seed: string): string {
  let out = "";
  for (let i = 0; out.length < 40; i++) out += fnv(seed, i).toString(16).padStart(8, "0");
  return out.slice(0, 40);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url-looking string of `len` chars (43 = SHA-256, 86 = Ed25519 signature, 22 = 16 bytes). */
export function b64u(seed: string, len = 43): string {
  let out = "";
  for (let i = 0; out.length < len; i++) {
    let n = fnv(seed, i);
    for (let k = 0; k < 5 && out.length < len; k++) {
      out += B64[n & 63];
      n >>>= 6;
    }
  }
  return out;
}

export const PLATFORM_KEY_ID = b64u("platform-key-2026", 22);

const STANDARD_STEPS: [name: string, kind: "user" | "evidence", ms: number][] = [
  ["install", "user", 9_400],
  ["typecheck", "user", 6_100],
  ["unit tests", "user", 21_800],
  ["coverage", "evidence", 4_200],
  ["mutation", "evidence", 96_000],
  ["public API diff", "evidence", 3_300],
  ["preview deploy", "evidence", 14_500],
  ["screenshots", "evidence", 11_900],
  ["sign evidence", "evidence", 400],
];

const slug = (name: string) => name.replace(/\s+/g, "-");

export function passedRun(changeId: string, headSha: string, finishedMinutesAgo: number): PipelineRun {
  const total = STANDARD_STEPS.reduce((s, [, , d]) => s + d, 0);
  return {
    id: `run_${changeId.slice(4)}`,
    changeId,
    headSha,
    engine: "cloudflare-ci",
    status: "passed",
    startedAt: new Date(NOW - finishedMinutesAgo * 60_000 - total).toISOString(),
    finishedAt: ago(finishedMinutesAgo),
    steps: STANDARD_STEPS.map(([name, kind, durationMs]) => ({ name, kind, status: "passed", durationMs, logRef: `logs/${changeId}/${slug(name)}` })),
  };
}

export function partialRun(
  changeId: string,
  headSha: string,
  startedMinutesAgo: number,
  doneSteps: number,
  current: "running" | "failed",
): PipelineRun {
  return {
    id: `run_${changeId.slice(4)}`,
    changeId,
    headSha,
    engine: "cloudflare-ci",
    status: current,
    startedAt: ago(startedMinutesAgo),
    finishedAt: current === "failed" ? ago(Math.max(0, startedMinutesAgo - 2)) : null,
    steps: STANDARD_STEPS.map(([name, kind, durationMs], i) => ({
      name,
      kind,
      status: i < doneSteps ? "passed" : i === doneSteps ? current : "pending",
      durationMs: i < doneSteps ? durationMs : i === doneSteps ? Math.round(durationMs / 2) : null,
      logRef: i <= doneSteps ? `logs/${changeId}/${slug(name)}` : null,
    })),
  };
}
