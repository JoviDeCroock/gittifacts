/**
 * Six more agents at work on billing-api, one change each, so mission control has an agent at
 * every stage: merged today, grading, sent back, in review, lane assigned and approved. Synthetic,
 * like everything in mock mode. `mock-mission.ts` then moves some of them on while you watch.
 */
import { partialRun, sha } from "./fixture-kit.js";
import { apiNone, depsNone, file, hunk, reason, scenario, sensitive, stop, testRun, type Scenario } from "./scenario-kit.js";

const BILLING = "repo_billing";

const runbook = scenario({
  id: "chg_ds4n1",
  repoId: BILLING,
  planId: null,
  title: "Document the dunning retry schedule in the runbook",
  category: "docs",
  authorId: "prn_scribe",
  status: "merged",
  computedLane: 0,
  lane: 1,
  createdMin: 70,
  updatedMin: 26,
  merged: true,
  reasons: [reason("docs.only", 0, "Only documentation changed."), reason("lane0.calibrating", 1, "Auto-merge is calibrating in this repo, so a person reviews it.")],
  files: [file("docs/runbook/dunning.md", "modified", [hunk(12, 12, `
 ## Retries
-Failed payments are retried by the provider.
+Failed payments are retried by the provider on day 1, 3 and 7.
+Dunning emails go out on day 1, 4 and 10 and stop when a payment succeeds.`)])],
  items: [testRun("chg_ds4n1", 412), apiNone(), depsNone(), sensitive([])],
});

const zod = scenario({
  id: "chg_db7z2",
  repoId: BILLING,
  planId: null,
  title: "Bump zod from 4.6.4 to 4.6.5",
  category: "dependency",
  authorId: "prn_bumper",
  status: "running",
  computedLane: null,
  lane: null,
  createdMin: 3,
  updatedMin: 1,
  reasons: [],
  files: [file("package.json", "modified", [hunk(18, 18, `
-    "zod": "^4.6.4",
+    "zod": "^4.6.5",`)])],
  runs: [partialRun("chg_db7z2", sha("chg_db7z2:head"), 1, 3, "running")],
});

const rounding = scenario({
  id: "chg_tg3p5",
  repoId: BILLING,
  planId: "plan_refunds",
  title: "Cover refund rounding with property tests",
  category: "chore",
  authorId: "prn_gardener",
  status: "awaiting-push",
  computedLane: 1,
  lane: 1,
  createdMin: 55,
  updatedMin: 8,
  reasons: [reason("tests.only", 1, "Only tests changed; a person checks they test the right thing.")],
  files: [file("test/refunds/rounding.test.ts", "added", [hunk(0, 1, `
+import { fc, test } from "@fast-check/vitest";
+test.prop([fc.integer({ min: 1, max: 10_000_00 })])("a partial refund never exceeds the captured total", (cents) => {
+  expect(refundable(cents, cents)).toBeLessThanOrEqual(cents);
+});`)])],
  items: [testRun("chg_tg3p5", 418), apiNone(), depsNone(), sensitive([])],
});

const index = scenario({
  id: "chg_sm6i8",
  repoId: BILLING,
  planId: null,
  title: "Index invoices by customer and due date",
  category: "feature",
  authorId: "prn_migrator",
  status: "awaiting-review",
  computedLane: 2,
  lane: 2,
  createdMin: 40,
  updatedMin: 14,
  reasons: [reason("sensitive.path", 2, "Touches migrations/**, which the policy marks sensitive.", "sensitive-paths")],
  files: [file("migrations/0042_invoice_due_index.sql", "added", [hunk(0, 1, `
+CREATE INDEX invoices_customer_due ON invoices (customer_id, due_at);`)])],
  tour: {
    stops: [
      stop("intent", "proven", "One index for the overdue-invoices query", "The dunning job looks invoices up by customer and due date; this index serves that query.", [{ file: "migrations/0042_invoice_due_index.sql", startLine: 1, endLine: 1 }], ["test-run:unit"]),
      stop("risk", "unproven", "Building it locks the table on a large tenant", "CREATE INDEX without CONCURRENTLY blocks writes while it builds. No measurement of the build time on production-sized data.", [{ file: "migrations/0042_invoice_due_index.sql", startLine: 1, endLine: 1 }], ["sensitive-paths"]),
    ],
    leastConfident: ["How long the index takes to build on the largest tenant."],
    notDone: ["No CONCURRENTLY variant was tried."],
  },
  items: [testRun("chg_sm6i8", 409), apiNone(), depsNone(), sensitive([{ path: "migrations/0042_invoice_due_index.sql", pattern: "**/migrations/**" }])],
});

const taxCache = scenario({
  id: "chg_pt2c9",
  repoId: BILLING,
  planId: null,
  title: "Cache tax rates per region for five minutes",
  category: "feature",
  authorId: "prn_perf",
  status: "running",
  computedLane: 1,
  lane: 1,
  createdMin: 22,
  updatedMin: 2,
  reasons: [reason("plan.missing", 1, "No approved Plan is linked, so Lane 0 is not available.")],
  files: [file("src/tax/rates.ts", "modified", [hunk(3, 3, `
-export const rateFor = (region: string) => fetchRate(region);
+const cache = new TtlCache<string, number>(5 * 60_000);
+export const rateFor = (region: string) => cache.getOrLoad(region, fetchRate);`)])],
  items: [testRun("chg_pt2c9", 415), apiNone(), depsNone(), sensitive([])],
});

const webhooks = scenario({
  id: "chg_fc9w3",
  repoId: BILLING,
  planId: "plan_webhooks",
  title: "Retry webhook deliveries with jitter",
  category: "fix",
  authorId: "prn_coder09",
  status: "approved",
  computedLane: 1,
  lane: 1,
  createdMin: 90,
  updatedMin: 1,
  reasons: [reason("proof.red-green", 0, "1 new test fails on main and passes on this change."), reason("lane0.calibrating", 1, "Auto-merge is calibrating in this repo, so a person reviews it.")],
  files: [file("src/webhooks/retry.ts", "modified", [hunk(8, 8, `
-  const delay = 2 ** attempt * 1000;
+  const delay = 2 ** attempt * 1000 * (0.5 + Math.random() / 2);`)])],
  tour: {
    stops: [stop("intent", "proven", "Retries spread out instead of arriving together", "Each retry waits between half and all of the backoff, so a recovering endpoint isn't hit by every delivery at once.", [{ file: "src/webhooks/retry.ts", startLine: 8, endLine: 8 }], ["test-run:unit"])],
    leastConfident: ["The jitter range was not compared against the provider's rate limits."],
    notDone: ["No change to the maximum number of attempts."],
  },
  items: [testRun("chg_fc9w3", 420), apiNone(), depsNone(), sensitive([])],
});

export const MISSION_SCENARIOS: Scenario[] = [runbook, zod, rounding, index, taxCache, webhooks];
