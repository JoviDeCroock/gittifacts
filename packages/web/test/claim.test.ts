import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../src/api/client.js";
import { createClaimMock, type MockViewer, TEST_SITE_KEY } from "../src/api/mock-claim.js";
import type { ClaimResult, ClaimView } from "../src/api/types.js";
import {
  claimFailure,
  claimStage,
  DUMMY_TURNSTILE_TOKEN,
  expiryInfo,
  signInHref,
} from "../src/lib/claim.js";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const HOUR = 3_600_000;

function view(over: Partial<ClaimView> = {}): ClaimView {
  return {
    status: "unclaimed",
    project: {
      id: "r_1",
      name: "time-api",
      template: "workers-api",
      createdAt: "2026-10-02T11:00:00Z",
      expiresAt: "2026-10-09T11:00:00Z",
      previewUrl: null,
    },
    createdBy: { kind: "agent", principalId: "ag_1", name: "Unclaimed agent (time-api)" },
    claimedBy: null,
    claimedAt: null,
    claiming: ["You become the owner."],
    limits: ["No secrets"],
    turnstile: { siteKey: TEST_SITE_KEY },
    viewer: { signedIn: false, principalId: null, isClaimer: false },
    ...over,
  };
}

describe("claimStage", () => {
  const out = { signedIn: false, principalId: null };
  const maya = { signedIn: true, principalId: "prn_maya" };

  it("asks signed-out visitors to sign in and signed-in people to claim", () => {
    expect(claimStage(view(), out)).toBe("signed-out");
    expect(claimStage(view(), maya)).toBe("ready");
  });

  it("tells the claimer it is theirs and everyone else it is taken", () => {
    const claimed = view({
      status: "claimed",
      claimedBy: { principalId: "prn_maya", name: "Maya" },
      claimedAt: "2026-10-02T11:30:00Z",
    });
    expect(claimStage(claimed, maya)).toBe("yours");
    expect(claimStage(claimed, { signedIn: true, principalId: "prn_dev" })).toBe("taken");
    expect(claimStage(claimed, out)).toBe("taken");
    expect(
      claimStage(
        { ...claimed, viewer: { signedIn: true, principalId: "x", isClaimer: true } },
        out,
      ),
    ).toBe("yours");
  });

  it("expired wins over everything", () => {
    expect(claimStage(view({ status: "expired" }), maya)).toBe("expired");
  });
});

describe("expiryInfo", () => {
  it("is calm with days left and urgent under a day", () => {
    const week = expiryInfo(new Date(NOW + 6 * 24 * HOUR).toISOString(), NOW);
    expect(week).toMatchObject({ relative: "in 6 days", urgent: false, passed: false });
    expect(week?.absolute).toMatch(/\d{2}:\d{2}/);
    expect(expiryInfo(new Date(NOW + 5 * HOUR).toISOString(), NOW)).toMatchObject({
      relative: "in 5 hours",
      urgent: true,
      passed: false,
    });
    expect(expiryInfo(new Date(NOW - HOUR).toISOString(), NOW)).toMatchObject({
      urgent: true,
      passed: true,
    });
  });

  it("has nothing to say without an expiry", () => {
    expect(expiryInfo(null, NOW)).toBeNull();
    expect(expiryInfo("not a date", NOW)).toBeNull();
  });
});

describe("signInHref", () => {
  it("returns to the claim link after signing in", () => {
    expect(signInHref("gtc_a/b")).toBe("/signin?next=%2Fclaim%2Fgtc_a%252Fb");
    const next = new URLSearchParams(signInHref("abc").split("?")[1]).get("next");
    expect(next).toBe("/claim/abc");
  });
});

describe("claimFailure", () => {
  const fix = { explanation: "Do the check again." };
  it("maps each server answer to a kind, preferring the server's fix", () => {
    expect(claimFailure(new ApiError(403, "turnstile-failed", "no", undefined, fix))).toMatchObject(
      { kind: "turnstile", detail: "Do the check again." },
    );
    expect(claimFailure(new ApiError(401, "unauthorized", "sign in")).kind).toBe("signin");
    expect(claimFailure(new ApiError(403, "forbidden", "agents can't")).kind).toBe("agent");
    expect(claimFailure(new ApiError(404, "not-found", "gone")).kind).toBe("not-found");
    expect(claimFailure(new ApiError(409, "conflict", "taken")).kind).toBe("taken");
    expect(claimFailure(new ApiError(410, "invalid-state", "expired")).kind).toBe("expired");
    expect(claimFailure(new ApiError(0, "network", "offline")).kind).toBe("retry");
    expect(claimFailure(new Error("boom"))).toMatchObject({ kind: "retry", detail: "boom" });
  });
});

describe("claim mock", () => {
  function mock(initial: MockViewer) {
    let viewer = initial;
    const m = createClaimMock({ viewer: () => viewer, now: () => NOW });
    return {
      as(v: MockViewer) {
        viewer = v;
      },
      get: (t: string) => m.handle("GET", `/api/v1/claims/${t}`),
      post: (t: string, turnstileToken: string = DUMMY_TURNSTILE_TOKEN) =>
        m.handle("POST", `/api/v1/claims/${t}`, { turnstileToken }),
    };
  }
  const out: MockViewer = { signedIn: false, principalId: null, name: null };
  const maya: MockViewer = { signedIn: true, principalId: "prn_maya", name: "Maya Okafor" };
  const dev: MockViewer = { signedIn: true, principalId: "prn_dev", name: "Dev Patel" };
  const code = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;

  it("serves the contract to signed-out visitors", () => {
    const m = mock(out);
    const r = m.get("mock-unclaimed");
    expect(r.status).toBe(200);
    const v = r.body as ClaimView;
    expect(v).toMatchObject({
      status: "unclaimed",
      createdBy: { kind: "agent" },
      claimedBy: null,
      turnstile: { siteKey: TEST_SITE_KEY },
      viewer: { signedIn: false, isClaimer: false },
    });
    expect(Date.parse(v.project.expiresAt ?? "") - NOW).toBeGreaterThan(6 * 24 * HOUR);
    expect(v.claiming.length).toBeGreaterThan(0);
    expect(v.limits.length).toBeGreaterThan(0);
    expect(m.get("nope").status).toBe(404);
  });

  it("claims once per person: 401 signed out, 403 bad check, 200, then idempotent, 409 for others", () => {
    const m = mock(out);
    expect(m.post("mock-unclaimed").status).toBe(401);
    m.as(maya);
    const bad = m.post("mock-unclaimed", "wrong");
    expect([bad.status, code(bad)]).toEqual([403, "turnstile-failed"]);
    const first = m.post("mock-unclaimed");
    expect(first.status).toBe(200);
    expect(first.body as ClaimResult).toMatchObject({
      status: "claimed",
      ownerId: "prn_maya",
      alreadyClaimed: false,
      next: { repoPath: "/repos/r_unclaimed" },
    });
    expect((m.post("mock-unclaimed").body as ClaimResult).alreadyClaimed).toBe(true);
    expect(m.get("mock-unclaimed").body as ClaimView).toMatchObject({
      status: "claimed",
      project: { expiresAt: null },
      viewer: { isClaimer: true },
    });
    m.as(dev);
    const taken = m.post("mock-unclaimed");
    expect([taken.status, code(taken)]).toEqual([409, "conflict"]);
  });

  it("answers 410 for expired projects and fails the first check on mock-turnstile-fail", () => {
    const m = mock(maya);
    const gone = m.post("mock-expired");
    expect([gone.status, code(gone)]).toEqual([410, "invalid-state"]);
    expect(m.post("mock-turnstile-fail").status).toBe(403);
    expect(m.post("mock-turnstile-fail").status).toBe(200);
    expect((m.get("mock-yours").body as ClaimView).viewer.isClaimer).toBe(true);
  });
});

describe("api.claim / api.claimProject", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the link with GET and claims with a POST carrying the check token and an idempotency key", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(init.method === "GET" ? view() : { status: "claimed" }), {
        status: 200,
      });
    });
    await api.claim("gtc_a/b");
    await api.claimProject("gtc_a/b", "tok", "key-1");
    expect(calls[0]).toMatchObject({
      url: "/api/v1/claims/gtc_a%2Fb",
      init: { method: "GET", credentials: "include" },
    });
    expect(calls[1]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ turnstileToken: "tok" });
    const headers = (calls[1]?.init.headers ?? {}) as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("key-1");
  });

  it("turns the error envelope into an ApiError with the server's fix", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "turnstile-failed",
              message: "check failed",
              fix: { explanation: "Try the check again." },
            },
          }),
          { status: 403 },
        ),
    );
    const err = await api.claimProject("t", "bad").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 403,
      code: "turnstile-failed",
      fix: { explanation: "Try the check again." },
    });
  });
});
