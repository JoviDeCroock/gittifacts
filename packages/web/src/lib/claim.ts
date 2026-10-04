/**
 * Claim links (onboarding O3): which stage a visitor is at, how urgent the expiry is, and what a
 * failed claim means in plain words. Pure: `now` is passed in so tests are deterministic.
 */
import { ApiError } from "../api/client.js";
import type { ClaimView } from "../api/types.js";
import { relative } from "./time.js";

/** Cloudflare's documented dummy token: what the test site keys (and the mock widget) yield. */
export const DUMMY_TURNSTILE_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const DAY = 86_400_000;

export type ClaimStage = "signed-out" | "ready" | "yours" | "taken" | "expired";

/** What the page shows: the server's status first, then who is looking. */
export function claimStage(
  view: ClaimView,
  me: { signedIn: boolean; principalId: string | null },
): ClaimStage {
  if (view.status === "expired") return "expired";
  if (view.status === "claimed") {
    const mine =
      view.viewer.isClaimer ||
      (me.principalId !== null &&
        view.claimedBy !== null &&
        view.claimedBy.principalId === me.principalId);
    return mine ? "yours" : "taken";
  }
  return me.signedIn ? "ready" : "signed-out";
}

export interface ExpiryInfo {
  /** "in 6 days", "in 5 hours". */
  relative: string;
  /** "Fri, Oct 9, 14:00" in the viewer's time zone. */
  absolute: string;
  /** Less than a day left: say it loudly. */
  urgent: boolean;
  passed: boolean;
}

const absoluteFormat = new Intl.DateTimeFormat("en", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function expiryInfo(expiresAt: string | null, now: number): ExpiryInfo | null {
  if (expiresAt === null) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  const left = at - now;
  return {
    relative: relative(expiresAt, now),
    absolute: absoluteFormat.format(new Date(at)),
    urgent: left < DAY,
    passed: left <= 0,
  };
}

/** Where "Sign in to claim" goes: the sign-in screen, then straight back to this link. */
export function signInHref(token: string): string {
  return `/signin?next=${encodeURIComponent(`/claim/${encodeURIComponent(token)}`)}`;
}

export type ClaimFailureKind =
  | "turnstile"
  | "signin"
  | "agent"
  | "taken"
  | "expired"
  | "not-found"
  | "retry";

export interface ClaimFailure {
  kind: ClaimFailureKind;
  title: string;
  detail: string;
}

/** A failed POST in plain words. The server's `fix.explanation` wins when it has one. */
export function claimFailure(err: unknown): ClaimFailure {
  if (!(err instanceof ApiError)) {
    return {
      kind: "retry",
      title: "The claim didn't go through",
      detail: err instanceof Error ? err.message : "Something went wrong. Try again.",
    };
  }
  const fix = err.fix?.explanation;
  if (err.code === "turnstile-failed") {
    return {
      kind: "turnstile",
      title: "The human check didn't pass",
      detail: fix ?? "It may have expired. Complete the check again, then claim.",
    };
  }
  if (err.status === 401) {
    return {
      kind: "signin",
      title: "Sign in first",
      detail: fix ?? "Your session ended. Sign in, then claim.",
    };
  }
  if (err.status === 403) {
    return {
      kind: "agent",
      title: "Only a person can claim a repo",
      detail: fix ?? err.message,
    };
  }
  if (err.status === 404) {
    return { kind: "not-found", title: "This claim link doesn't work", detail: fix ?? err.message };
  }
  if (err.status === 409) {
    return { kind: "taken", title: "Someone else claimed it first", detail: fix ?? err.message };
  }
  if (err.status === 410) {
    return { kind: "expired", title: "This repo expired", detail: fix ?? err.message };
  }
  return {
    kind: "retry",
    title: err.message || "The claim didn't go through",
    detail:
      fix ??
      (err.status === 0 ? "Check your connection, then try again." : "Try again in a moment."),
  };
}
