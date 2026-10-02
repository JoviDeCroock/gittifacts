/**
 * Mock backend for claim links (`/api/v1/claims/{token}`, onboarding O3). Synthetic data only;
 * a claim persists for the life of the tab. Mirrors the platform's rules: reading needs no
 * session, claiming needs a signed-in person and a passed human check, a claim is single-use
 * (the same person may repeat it; anyone else gets 409), and expired projects answer 410.
 *
 * Tokens: `mock-unclaimed`, `mock-expiring-soon`, `mock-claimed` (someone else),
 * `mock-yours`, `mock-expired`, `mock-turnstile-fail` (the first claim fails the check).
 * Anything else is 404.
 */
import { DUMMY_TURNSTILE_TOKEN } from "../lib/claim.js";
import type { ClaimResult, ClaimView } from "./types.js";

export interface MockViewer {
  signedIn: boolean;
  principalId: string | null;
  name: string | null;
}

export interface ClaimMockResponse {
  status: number;
  body: unknown;
}

/** Cloudflare's documented always-pass test site key. */
export const TEST_SITE_KEY = "1x00000000000000000000AA";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TTL = 7 * DAY;

export const MOCK_CLAIMING = [
  "You become the owner. It stops expiring and stays in your account.",
  "The agent that made it keeps working on this one project, now accountable to you.",
  "Normal limits: CI minutes, storage and sandbox network access of a claimed project.",
  "You review its Changes. Auto-merge (Lane 0) stays off until you turn it on.",
];

export const MOCK_LIMITS = [
  "Deleted 7 days after it was made, unless someone claims it",
  "Previews only, on a separate, marked domain: no production deploys",
  "No secrets and no custom domains",
  "Nothing merges on its own: auto-merge (Lane 0) is off",
  "Small CI-minute, storage and request quotas",
  "Sandboxes can reach package registries only",
];

interface Seed {
  name: string;
  template: string | null;
  /** Minutes since the agent created it. */
  ageMin: number;
  status: "unclaimed" | "claimed" | "expired";
  claimedBy?: { principalId: string; name: string; agoMin: number };
  preview: boolean;
}

const SEEDS: Record<string, Seed> = {
  "mock-unclaimed": {
    name: "time-api",
    template: "workers-api",
    ageMin: 18,
    status: "unclaimed",
    preview: true,
  },
  "mock-expiring-soon": {
    name: "launch-notes",
    template: "static-site",
    ageMin: 7 * 24 * 60 - 5 * 60,
    status: "unclaimed",
    preview: true,
  },
  "mock-claimed": {
    name: "invoice-ui",
    template: "preact-app",
    ageMin: 3 * 24 * 60,
    status: "claimed",
    claimedBy: { principalId: "prn_dev", name: "Dev Patel", agoMin: 2 * 60 },
    preview: true,
  },
  "mock-yours": {
    name: "money-lib",
    template: "ts-library",
    ageMin: 26 * 60,
    status: "claimed",
    claimedBy: { principalId: "prn_maya", name: "Maya Okafor", agoMin: 40 },
    preview: false,
  },
  "mock-expired": {
    name: "weather-bot",
    template: "workers-api",
    ageMin: 8 * 24 * 60,
    status: "expired",
    preview: false,
  },
  "mock-turnstile-fail": {
    name: "status-page",
    template: "static-site",
    ageMin: 55,
    status: "unclaimed",
    preview: true,
  },
};

const fail = (
  status: number,
  code: string,
  message: string,
  explanation: string,
): ClaimMockResponse => ({
  status,
  body: { error: { code, message, fix: { explanation } } },
});

function idFor(token: string): string {
  return `r_${token.replace(/^mock-/, "").replace(/[^a-z0-9]/g, "")}`;
}

export function createClaimMock(opts: { viewer: () => MockViewer; now?: () => number }) {
  const now = opts.now ?? (() => Date.now());
  const loadedAt = now();
  const claims = new Map<string, { principalId: string; name: string; at: number }>();
  const failedOnce = new Set<string>();
  const iso = (ms: number) => new Date(ms).toISOString();

  function view(token: string, seed: Seed): ClaimView {
    const created = loadedAt - seed.ageMin * MIN;
    const fresh = claims.get(token);
    const claimer =
      fresh ??
      (seed.claimedBy ? { ...seed.claimedBy, at: loadedAt - seed.claimedBy.agoMin * MIN } : null);
    const status = seed.status === "expired" ? "expired" : claimer ? "claimed" : "unclaimed";
    const viewer = opts.viewer();
    const id = idFor(token);
    return {
      status,
      project: {
        id,
        name: seed.name,
        template: seed.template,
        createdAt: iso(created),
        expiresAt: status === "claimed" ? null : iso(created + TTL),
        previewUrl:
          seed.preview && status !== "expired"
            ? `https://p-bs-${id.slice(2)}-pv.resynapse.dev`
            : null,
      },
      createdBy: {
        kind: "agent",
        principalId: `ag_${id.slice(2)}`,
        name: `Unclaimed agent (${seed.name})`,
      },
      claimedBy: claimer ? { principalId: claimer.principalId, name: claimer.name } : null,
      claimedAt: claimer ? iso(claimer.at) : null,
      claiming: MOCK_CLAIMING,
      limits: MOCK_LIMITS,
      turnstile: { siteKey: TEST_SITE_KEY },
      viewer: {
        signedIn: viewer.signedIn,
        principalId: viewer.signedIn ? viewer.principalId : null,
        isClaimer:
          viewer.signedIn && claimer !== null && claimer.principalId === viewer.principalId,
      },
    };
  }

  function claim(token: string, seed: Seed, body: unknown): ClaimMockResponse {
    const viewer = opts.viewer();
    if (!viewer.signedIn || viewer.principalId === null) {
      return fail(
        401,
        "unauthorized",
        "sign in to claim this project",
        "Sign in as a person, then open the claim link again.",
      );
    }
    const current = view(token, seed);
    if (current.status === "expired") {
      return fail(
        410,
        "invalid-state",
        `${seed.name} expired unclaimed`,
        "Unclaimed projects are deleted when they expire. Ask the agent to create a new project and send you its claim link.",
      );
    }
    if (current.status === "claimed") {
      if (current.claimedBy?.principalId !== viewer.principalId) {
        return fail(
          409,
          "conflict",
          `${seed.name} was already claimed by someone else`,
          "Each project has one owner. Ask its owner to add you, or ask the agent for a new project.",
        );
      }
      return { status: 200, body: result(current, viewer.principalId, true) };
    }
    const t =
      typeof body === "object" && body !== null
        ? (body as { turnstileToken?: unknown }).turnstileToken
        : undefined;
    const tokenOk = typeof t === "string" && t === DUMMY_TURNSTILE_TOKEN;
    if (!tokenOk || (token === "mock-turnstile-fail" && !failedOnce.has(token))) {
      failedOnce.add(token);
      return fail(
        403,
        "turnstile-failed",
        "the human check did not pass",
        "Complete the check again (it expires after a few minutes), then claim.",
      );
    }
    claims.set(token, { principalId: viewer.principalId, name: viewer.name ?? "you", at: now() });
    return { status: 200, body: result(view(token, seed), viewer.principalId, false) };
  }

  function result(v: ClaimView, ownerId: string, alreadyClaimed: boolean): ClaimResult {
    return {
      status: "claimed",
      project: { id: v.project.id, name: v.project.name },
      ownerId,
      claimedAt: v.claimedAt ?? new Date(now()).toISOString(),
      alreadyClaimed,
      next: { repoPath: `/repos/${v.project.id}` },
    };
  }

  return {
    handle(method: string, path: string, body?: unknown): ClaimMockResponse {
      const m = /^\/api\/v1\/claims\/([^/?#]+)$/.exec(path.split("?")[0] ?? "");
      if (!m) return fail(404, "not-found", "no such route", "Check the link.");
      const token = decodeURIComponent(m[1] ?? "");
      const seed = SEEDS[token];
      if (seed === undefined) {
        return fail(
          404,
          "not-found",
          "no project for this claim link",
          "Check you copied the whole link. If it is right, the project may have been deleted; ask the agent for a new one.",
        );
      }
      if (method === "GET") return { status: 200, body: structuredClone(view(token, seed)) };
      if (method === "POST") return structuredClone(claim(token, seed, body));
      return fail(
        405,
        "http-error",
        `${method} is not allowed here`,
        "Use GET to read a claim link and POST to claim.",
      );
    },
  };
}
