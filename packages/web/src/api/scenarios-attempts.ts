/**
 * Three agents attempt the same approved plan on edge-router (plan_ratelimit), so the plan page
 * has attempts to compare: one green and small inside the plan's scope (Lane 1, the plan declares
 * a risk), one green but drifting outside scopePaths (Lane 2), one with failing tests. Synthetic,
 * like everything in mock mode; mock-attempts.ts ranks them with the domain's rankAttempts.
 */
import { partialRun, sha } from "./fixture-kit.js";
import { apiNone, coverage, depsNone, file, hunk, reason, redGreen, scenario, sensitive, stop, testRun, type Scenario } from "./scenario-kit.js";

const EDGE = "repo_edge";
export const ATTEMPTS_PLAN = "plan_ratelimit";

const TESTS = [
  { file: "test/ratelimit/bucket.test.ts", name: "a key over its budget gets 429 with Retry-After" },
  { file: "test/ratelimit/bucket.test.ts", name: "the budget refills one token per second" },
];

const MIDDLEWARE = hunk(4, 4, `
 import { cors } from "./cors.js";
+import { rateLimit } from "../ratelimit/bucket.js";

 export const middleware = [
   cors,
+  rateLimit({ perSecond: 1, burst: 60 }),
 ];`);

const BUCKET = hunk(0, 1, `
+export interface Budget { perSecond: number; burst: number }
+
+/** One token bucket per API key, kept in the isolate; the edge is the only writer. */
+export function rateLimit(budget: Budget) {
+  const buckets = new Map<string, { tokens: number; at: number }>();
+  return async (req: Request, next: () => Promise<Response>) => {
+    const key = req.headers.get("x-api-key");
+    if (!key) return next();
+    const now = Date.now();
+    const b = buckets.get(key) ?? { tokens: budget.burst, at: now };
+    b.tokens = Math.min(budget.burst, b.tokens + ((now - b.at) / 1000) * budget.perSecond);
+    b.at = now;
+    buckets.set(key, b);
+    if (b.tokens < 1) {
+      const wait = Math.ceil((1 - b.tokens) / budget.perSecond);
+      return new Response("Too many requests", { status: 429, headers: { "retry-after": String(wait) } });
+    }
+    b.tokens -= 1;
+    return next();
+  };
+}`);

const BUCKET_TEST = hunk(0, 1, `
+import { expect, test, vi } from "vitest";
+import { rateLimit } from "../../src/ratelimit/bucket.js";
+
+test("a key over its budget gets 429 with Retry-After", async () => {
+  const limit = rateLimit({ perSecond: 1, burst: 1 });
+  const req = new Request("https://x/", { headers: { "x-api-key": "k" } });
+  await limit(req, async () => new Response("ok"));
+  const res = await limit(req, async () => new Response("ok"));
+  expect(res.status).toBe(429);
+  expect(res.headers.get("retry-after")).toBe("1");
+});
+
+test("the budget refills one token per second", async () => {
+  vi.useFakeTimers();
+  const limit = rateLimit({ perSecond: 1, burst: 1 });
+  const req = new Request("https://x/", { headers: { "x-api-key": "k" } });
+  await limit(req, async () => new Response("ok"));
+  vi.advanceTimersByTime(1000);
+  expect((await limit(req, async () => new Response("ok"))).status).toBe(200);
+});`);

const small = scenario({
  id: "chg_rl1k4",
  repoId: EDGE,
  planId: ATTEMPTS_PLAN,
  title: "Per-key token bucket in the edge middleware",
  category: "feature",
  authorId: "prn_coder12",
  status: "awaiting-review",
  computedLane: 1,
  lane: 1,
  createdMin: 48,
  updatedMin: 36,
  reasons: [
    reason("ci.passed", 0, "CI passed on the pushed head."),
    reason("tests.passed", 0, "36 tests pass.", "test-run:unit"),
    reason("red-green.proven", 0, "2 new tests fail on main and pass on this change.", "red-green"),
    reason("scope.within", 0, "Every file is inside the plan's scopePaths."),
    reason("api.none", 0, "No public API change.", "public-api"),
    reason("plan.risk-declared", 1, "The plan declares a risk (paying customers throttled), so a person glances."),
  ],
  files: [file("src/middleware/index.ts", "modified", [MIDDLEWARE]), file("src/ratelimit/bucket.ts", "added", [BUCKET]), file("test/ratelimit/bucket.test.ts", "added", [BUCKET_TEST])],
  tour: {
    stops: [
      stop("intent", "proven", "A token bucket per API key, in front of every route", "Requests with an x-api-key spend a token; an empty bucket answers 429 with Retry-After. Requests without a key pass through, as the plan says.", [{ file: "src/ratelimit/bucket.ts", startLine: 4, endLine: 21 }], ["red-green"]),
      stop("risk", "unproven", "Buckets live in one isolate", "Each isolate keeps its own buckets, so a key spread over many isolates gets more than its budget. The plan accepts this for a first cut.", [{ file: "src/ratelimit/bucket.ts", startLine: 5, endLine: 5 }]),
    ],
    leastConfident: ["How far over budget a key can go when its traffic spreads across isolates."],
    notDone: ["No per-plan budgets yet; every key gets 60 requests of burst."],
  },
  items: [testRun("chg_rl1k4", 36, [], 0), redGreen("chg_rl1k4", TESTS, "proven"), coverage(31, 29, [{ path: "src/ratelimit/bucket.ts", changed: 19, covered: 18, uncoveredLines: [8] }]), apiNone(), depsNone(), sensitive([])],
});

const drift = scenario({
  id: "chg_rl2d7",
  repoId: EDGE,
  planId: ATTEMPTS_PLAN,
  title: "Rate-limit API keys and exempt the billing webhooks",
  category: "feature",
  authorId: "prn_coder07",
  status: "awaiting-review",
  computedLane: 2,
  lane: 2,
  createdMin: 52,
  updatedMin: 30,
  reasons: [
    reason("ci.passed", 0, "CI passed on the pushed head."),
    reason("tests.passed", 0, "38 tests pass.", "test-run:unit"),
    reason("red-green.proven", 0, "2 new tests fail on main and pass on this change.", "red-green"),
    reason("scope.drift", 2, "Files outside the plan's scopePaths: src/routes/billing.ts"),
    reason("api.none", 0, "No public API change.", "public-api"),
  ],
  files: [
    file("src/middleware/index.ts", "modified", [MIDDLEWARE]),
    file("src/ratelimit/bucket.ts", "added", [BUCKET]),
    file("src/routes/billing.ts", "modified", [hunk(12, 12, `
 export const billingRoutes = new Hono()
-  .post("/webhooks/stripe", verifyStripe, handleStripe)
+  // Exempt: the provider retries on 429 and would double-deliver.
+  .post("/webhooks/stripe", skipRateLimit, verifyStripe, handleStripe)
+  .post("/webhooks/paddle", skipRateLimit, verifyPaddle, handlePaddle)
   .get("/invoices/:id", auth, getInvoice);`)]),
    file("test/ratelimit/bucket.test.ts", "added", [BUCKET_TEST]),
  ],
  tour: {
    stops: [
      stop("intent", "proven", "The same per-key bucket as the plan asks", "API keys spend tokens and get 429 with Retry-After when empty.", [{ file: "src/ratelimit/bucket.ts", startLine: 4, endLine: 21 }], ["red-green"]),
      stop("risk", "risk", "Edits billing routes the plan didn't name", "It exempts the payment webhooks from the limit, in src/routes/billing.ts, outside the plan's scopePaths. Reasonable, but nobody approved it.", [{ file: "src/routes/billing.ts", startLine: 13, endLine: 15 }]),
    ],
    leastConfident: ["Whether the webhook exemption belongs in this plan at all."],
    notDone: ["The exemption has no test of its own."],
  },
  items: [testRun("chg_rl2d7", 38, [], 0), redGreen("chg_rl2d7", TESTS, "proven"), coverage(36, 29, [{ path: "src/routes/billing.ts", changed: 3, covered: 0, uncoveredLines: [13, 14, 15] }]), apiNone(), depsNone(), sensitive([])],
});

const failing = scenario({
  id: "chg_rl3f2",
  repoId: EDGE,
  planId: ATTEMPTS_PLAN,
  title: "Sliding-window rate limit per API key",
  category: "feature",
  authorId: "prn_coder09",
  status: "failing",
  computedLane: 2,
  lane: 2,
  createdMin: 45,
  updatedMin: 21,
  reasons: [
    reason("ci.failed", 2, "The unit tests step failed."),
    reason("tests.failing", 2, "2 tests fail on the pushed head.", "test-run:unit"),
    reason("scope.within", 0, "Every file is inside the plan's scopePaths."),
  ],
  files: [
    file("src/middleware/index.ts", "modified", [MIDDLEWARE]),
    file("src/ratelimit/window.ts", "added", [hunk(0, 1, `
+/** Requests per key in the last 60 seconds, as a sorted list of timestamps. */
+export function slidingWindow(limit: number) {
+  const seen = new Map<string, number[]>();
+  return async (req: Request, next: () => Promise<Response>) => {
+    const key = req.headers.get("x-api-key") ?? "anonymous";
+    const now = Date.now();
+    const recent = (seen.get(key) ?? []).filter((t) => now - t < 60_000);
+    if (recent.length > limit) return new Response("Too many requests", { status: 429 });
+    seen.set(key, [...recent, now]);
+    return next();
+  };
+}`)]),
    file("test/ratelimit/window.test.ts", "added", [hunk(0, 1, `
+import { expect, test } from "vitest";
+import { slidingWindow } from "../../src/ratelimit/window.js";
+
+test("a key over its budget gets 429 with Retry-After", async () => {
+  const limit = slidingWindow(1);
+  const req = new Request("https://x/", { headers: { "x-api-key": "k" } });
+  await limit(req, async () => new Response("ok"));
+  const res = await limit(req, async () => new Response("ok"));
+  expect(res.status).toBe(429);
+  expect(res.headers.get("retry-after")).not.toBeNull();
+});`)]),
  ],
  runs: [partialRun("chg_rl3f2", sha("chg_rl3f2:head"), 24, 2, "failed")],
  items: [
    testRun("chg_rl3f2", 34, [
      { name: "a key over its budget gets 429 with Retry-After", message: "expected 200 to be 429 (off by one: the window allows limit + 1)" },
      { name: "requests without a key pass through", message: "expected 429 to be 200 (keyless requests share one 'anonymous' bucket)" },
    ], 0),
    apiNone(),
    depsNone(),
    sensitive([]),
  ],
});

export const ATTEMPT_SCENARIOS: Scenario[] = [small, drift, failing];
