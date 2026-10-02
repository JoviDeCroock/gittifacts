/**
 * Signed eval traffic (O6, docs/prompts/02-onboarding.md §7; DECISIONS.md 2026-10-02).
 *
 * The onboarding eval's agents reach the platform from Cloudflare's Worker egress: shared
 * addresses in one network, so the per-IP and per-ASN creation buckets would give a whole
 * 40-run matrix the budget of one client. The evals Worker marks its agents' requests with
 * `x-gittifacts-eval-run: <runId>` and `x-gittifacts-eval-sig: hex(HMAC-SHA-256(EVAL_TRAFFIC_SECRET,
 * runId))` (apps/evals/src/env.ts `evalHeaderFn`). When the signature verifies against the
 * platform's copy of the secret, that run is its own creation client: `eval:<runId>` replaces the
 * IP and ASN keys (src/limits/creation.ts). The global bucket still applies, and nothing else
 * changes: eval projects are ordinary unclaimed projects (quotas, egress, TTL, no Lane 0, no
 * production).
 *
 * Fail closed to the normal keys: no secret configured (or a short one), a missing or malformed
 * header, or a signature that doesn't verify → the request is keyed by IP and ASN as usual.
 * Nothing is ever bypassed. A leaked (runId, signature) pair is worth one run's budget, under the
 * global cap; rotating the secret on both Workers revokes every pair.
 */
import { hexEncode } from "@app/evidence";

export const EVAL_RUN_HEADER = "x-gittifacts-eval-run";
export const EVAL_SIG_HEADER = "x-gittifacts-eval-sig";

/** Eval run ids: `<matrixId>--<task>--<model>--r<n>` (Workflow instance ids). */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SIG = /^[0-9a-f]{64}$/;
/** Shorter secrets are ignored: a guessable key would make every signature forgeable. */
export const MIN_EVAL_SECRET_LENGTH = 32;

export interface EvalTrafficEnv {
  /** Shared with the evals Worker (`wrangler secret put EVAL_TRAFFIC_SECRET` on both). */
  EVAL_TRAFFIC_SECRET?: string;
}

const enc = new TextEncoder();

/** hex(HMAC-SHA-256(secret, runId)), exactly as the evals Worker signs it. */
export async function evalRunSignature(secret: string, runId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hexEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(runId))));
}

function rejected(reason: string, runId: string | null): null {
  // Workers Logs only: unauthenticated input must not be able to write the audit chain.
  console.warn(
    JSON.stringify({
      event: "eval-traffic-unverified",
      reason,
      runId: runId === null ? null : runId.slice(0, 64),
    }),
  );
  return null;
}

/**
 * The eval run a request belongs to, when its signature verifies (constant time); otherwise
 * null, and the caller keys limits as for any other client.
 */
export async function verifiedEvalRun(
  request: Request,
  env: EvalTrafficEnv,
): Promise<string | null> {
  const runId = request.headers.get(EVAL_RUN_HEADER);
  const sig = request.headers.get(EVAL_SIG_HEADER);
  if (runId === null && sig === null) return null;
  const secret = env.EVAL_TRAFFIC_SECRET ?? "";
  if (secret.length < MIN_EVAL_SECRET_LENGTH)
    return rejected(secret === "" ? "no-secret" : "secret-too-short", runId);
  if (runId === null || !RUN_ID.test(runId)) return rejected("bad-run-id", runId);
  const given = sig?.trim().toLowerCase() ?? "";
  if (!SIG.test(given)) return rejected("bad-signature-format", runId);
  const expected = await evalRunSignature(secret, runId);
  // Both are 64 ASCII hex characters (checked above), so the comparison leaks nothing by length.
  const equal = crypto.subtle.timingSafeEqual(enc.encode(given), enc.encode(expected));
  return equal ? runId : rejected("signature-mismatch", runId);
}
