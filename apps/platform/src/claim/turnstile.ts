/**
 * Turnstile for the claim flow: the claim page renders the widget with `TURNSTILE_SITE_KEY`, and
 * the server verifies the token with Siteverify and `TURNSTILE_SECRET_KEY` before a project
 * changes hands.
 *
 * Without configured keys (local dev, tests) the platform uses Cloudflare's documented test keys:
 * site key `1x00000000000000000000AA` and secret `1x0000000000000000000000000000000AA` (always
 * passes). Cloudflare's documented test secrets are answered locally, exactly as Siteverify
 * answers them (`1x…AA` passes, `2x…AA` fails, `3x…AA` "already spent"), so tests never reach the
 * network; any other secret is verified with Siteverify.
 * https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 */

export const TEST_SITE_KEY = "1x00000000000000000000AA";
export const TEST_SECRET_PASS = "1x0000000000000000000000000000000AA";
export const TEST_SECRET_FAIL = "2x0000000000000000000000000000000AA";
export const TEST_SECRET_SPENT = "3x0000000000000000000000000000000AA";
/** What Cloudflare's test site keys hand the browser. */
export const TEST_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileEnv {
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}

export function turnstileSiteKey(env: TurnstileEnv): string {
  return env.TURNSTILE_SITE_KEY || TEST_SITE_KEY;
}

export interface TurnstileResult {
  success: boolean;
  errorCodes: string[];
  /** True when the platform used Cloudflare's test keys (no real widget configured). */
  testKeys: boolean;
}

export async function verifyTurnstile(
  env: TurnstileEnv,
  input: { token: string; remoteIp: string | null; idempotencyKey?: string },
  fetcher: typeof fetch = fetch,
): Promise<TurnstileResult> {
  const secret = env.TURNSTILE_SECRET_KEY || TEST_SECRET_PASS;
  const testKeys = !env.TURNSTILE_SECRET_KEY;
  if (input.token.length === 0 || input.token.length > 2048) {
    return { success: false, errorCodes: ["invalid-input-response"], testKeys };
  }
  if (secret === TEST_SECRET_PASS) return { success: true, errorCodes: [], testKeys: true };
  if (secret === TEST_SECRET_FAIL) {
    return { success: false, errorCodes: ["invalid-input-response"], testKeys: true };
  }
  if (secret === TEST_SECRET_SPENT) {
    return { success: false, errorCodes: ["timeout-or-duplicate"], testKeys: true };
  }
  const body = new FormData();
  body.set("secret", secret);
  body.set("response", input.token);
  if (input.remoteIp) body.set("remoteip", input.remoteIp);
  if (input.idempotencyKey) body.set("idempotency_key", input.idempotencyKey);
  try {
    const res = await fetcher(SITEVERIFY, { method: "POST", body });
    const out = (await res.json()) as { success?: unknown; "error-codes"?: unknown };
    const codes = Array.isArray(out["error-codes"])
      ? out["error-codes"].filter((c): c is string => typeof c === "string")
      : [];
    return { success: out.success === true, errorCodes: codes, testKeys };
  } catch (e) {
    // Siteverify unreachable: not verified (fail closed).
    return { success: false, errorCodes: [`siteverify-unreachable: ${String(e)}`], testKeys };
  }
}
