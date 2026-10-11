/**
 * Synthetic demo changes. Every name, path, number and trace here is invented for the mock
 * backend. Nine canonical scenarios plus the changes a real repo would have around them.
 */
import { ago, ahead, partialRun, sha } from "./fixture-kit.js";
import {
  apiNone,
  coverage,
  depsNone,
  file,
  hunk,
  judgment,
  preview,
  reason,
  redGreen,
  type Scenario,
  scenario,
  sensitive,
  stop,
  testRun,
  trace,
} from "./scenario-kit.js";
import { ATTEMPT_SCENARIOS } from "./scenarios-attempts.js";
import { MISSION_SCENARIOS } from "./scenarios-mission.js";
import { RESOLUTION_SCENARIOS } from "./scenarios-resolution.js";
import { TRAIN_SCENARIOS } from "./scenarios-trains.js";

const BILLING = "repo_billing";
const DASH = "repo_dashboard";
const EDGE = "repo_edge";

// ================================================================ 1. proven bug fix (shadow 0 → 1)

const tz = scenario({
  id: "chg_tz7k2",
  repoId: BILLING,
  planId: "plan_tz",
  title: "Fix invoice due dates drifting a day for customers far from UTC",
  category: "fix",
  summary: "Compute due dates in the customer's billing time zone.",
  authorId: "prn_coder07",
  status: "awaiting-review",
  computedLane: 0,
  lane: 1,
  createdMin: 140,
  updatedMin: 38,
  reasons: [
    reason("proof.red-green", 0, "2 new tests fail on main and pass on this change.", "red-green"),
    reason("coverage.changed-lines", 0, "97% of changed lines covered (policy: 80%).", "coverage"),
    reason("mutation.score", 0, "Mutation score 86% on changed lines (policy: 60%).", "mutation"),
    reason("size.small", 0, "34 changed lines in 3 files (Lane 0 allows 150 lines, 8 files)."),
    reason("plan.in-scope", 0, "Every file is inside the plan's scope paths."),
    reason(
      "shadow.lane0-disabled",
      1,
      "Lane 0 is in shadow mode for this repo, so the change is routed to Lane 1.",
    ),
  ],
  files: [
    file("src/invoices/due-date.ts", "modified", [
      hunk(
        1,
        1,
        `
 import type { Customer } from "../customers/types.js";
+import { addDaysInZone, startOfDayInZone } from "../time/zoned.js";

 /**
  * Due date for an invoice issued at \`issuedAt\` with \`netDays\` payment terms.
- * Computed in UTC.
+ * Computed in the customer's billing time zone, so a net-30 invoice
+ * lands on the same local calendar day wherever the customer is.
  */
 export function dueDate(issuedAt: Date, netDays: number, customer: Customer): Date {
-  const due = new Date(issuedAt.getTime() + netDays * 86_400_000);
-  due.setUTCHours(0, 0, 0, 0);
-  return due;
+  const zone = customer.billingTimeZone ?? "UTC";
+  const issuedDay = startOfDayInZone(issuedAt, zone);
+  return addDaysInZone(issuedDay, netDays, zone);
 }`,
      ),
    ]),
    file("src/time/zoned.ts", "added", [
      hunk(
        0,
        1,
        `
+/** Calendar arithmetic in an IANA time zone, without a date library. */
+const partsFormatter = (zone: string) =>
+  new Intl.DateTimeFormat("en-US", {
+    timeZone: zone,
+    year: "numeric", month: "2-digit", day: "2-digit",
+    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
+  });
+
+/** Offset of \`zone\` from UTC at instant \`at\`, in minutes. */
+export function offsetMinutes(at: Date, zone: string): number {
+  const p = Object.fromEntries(partsFormatter(zone).formatToParts(at).map((x) => [x.type, x.value]));
+  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
+  return Math.round((asUtc - at.getTime()) / 60_000);
+}
+
+export function startOfDayInZone(at: Date, zone: string): Date {
+  const local = new Date(at.getTime() + offsetMinutes(at, zone) * 60_000);
+  local.setUTCHours(0, 0, 0, 0);
+  return new Date(local.getTime() - offsetMinutes(local, zone) * 60_000);
+}
+
+export function addDaysInZone(day: Date, days: number, zone: string): Date {
+  const naive = new Date(day.getTime() + days * 86_400_000);
+  const drift = offsetMinutes(day, zone) - offsetMinutes(naive, zone);
+  // Offsets differ across a DST change; shift back onto local midnight.
+  if (drift === 0) return naive;
+  return new Date(naive.getTime() + drift * 60_000);
+}`,
      ),
    ]),
    file("test/invoices/due-date.test.ts", "modified", [
      hunk(
        30,
        30,
        `
 });

+describe("dueDate in the customer's zone", () => {
+  it("lands on the local calendar day for UTC−8 customers", () => {
+    const issued = new Date("2026-10-01T05:30:00Z"); // Sep 30, 21:30 in Pitcairn
+    const due = dueDate(issued, 30, customer({ billingTimeZone: "Pacific/Pitcairn" }));
+    expect(localDay(due, "Pacific/Pitcairn")).toBe("2026-10-30");
+  });
+
+  it("lands on the local calendar day for UTC+13 customers", () => {
+    const issued = new Date("2026-10-01T11:30:00Z"); // Oct 2, 00:30 in Tongatapu
+    const due = dueDate(issued, 30, customer({ billingTimeZone: "Pacific/Tongatapu" }));
+    expect(localDay(due, "Pacific/Tongatapu")).toBe("2026-11-01");
+  });
+});`,
      ),
    ]),
  ],
  tour: {
    stops: [
      stop(
        "intent",
        "proven",
        "Due dates follow the customer's billing time zone",
        "The plan asks that a net-30 invoice is due on the same local calendar day for every customer. Main truncated the due date to UTC midnight, so the printed date was a day off for customers far from UTC. The model check found the change matches that intent and nothing else.",
        [{ file: "src/invoices/due-date.ts", startLine: 4, endLine: 13 }],
        ["llm-judgment:plan-conformance"],
      ),
      stop(
        "behavior",
        "proven",
        "Invoice inv_2041 now says due Oct 30, not Oct 31",
        'For a customer in Pacific/Pitcairn (UTC−8), an invoice issued on Sep 30 at 21:30 local time printed "Due Oct 31". It now prints "Due Oct 30". Both new tests pin the local day, one on each side of UTC.',
        [],
        ["red-green", "screenshots"],
      ),
      stop(
        "risk",
        "risk",
        "Offset arithmetic in addDaysInZone",
        "Adding days inside a time zone is where daylight-saving bugs live. The function re-reads the offset after adding days and shifts back onto local midnight, which is the right approach. But the shift on line 27 never runs in any test: both test zones have a fixed offset.",
        [{ file: "src/time/zoned.ts", startLine: 22, endLine: 28 }],
        ["coverage", "mutation"],
      ),
      stop(
        "proof",
        "proven",
        "Two new tests fail on main and pass here",
        "Both tests were run against main (red) and this change (green) in a clean sandbox. The full unit suite also passes: 412 tests.",
        [{ file: "test/invoices/due-date.test.ts", startLine: 32, endLine: 44 }],
        ["red-green", "test-run:unit"],
      ),
      stop(
        "uncovered",
        "unproven",
        "Daylight-saving transitions are not exercised",
        "No test issues an invoice whose term crosses a DST change. A surviving mutant shows that replacing the drift check with `true` goes unnoticed.",
        [{ file: "src/time/zoned.ts", startLine: 26, endLine: 27 }],
        ["mutation"],
      ),
    ],
    leastConfident: [
      "Whether addDaysInZone lands on local midnight when a term crosses the November DST change. Line 27 never ran in tests, and a mutant on line 26 survived.",
      "Customers without billingTimeZone fall back to UTC, which keeps the old behavior for them. I did not check how many customers that is.",
    ],
    notDone: [
      "No test for a payment term that crosses a daylight-saving change.",
      "Invoices already issued keep their stored due dates; the plan puts backfilling out of scope.",
    ],
  },
  items: [
    redGreen(
      "chg_tz7k2",
      [
        {
          file: "test/invoices/due-date.test.ts",
          name: "dueDate in the customer's zone › lands on the local calendar day for UTC−8 customers",
        },
        {
          file: "test/invoices/due-date.test.ts",
          name: "dueDate in the customer's zone › lands on the local calendar day for UTC+13 customers",
        },
      ],
      "proven",
    ),
    testRun("chg_tz7k2", 412),
    coverage(34, 33, [
      { path: "src/invoices/due-date.ts", changed: 6, covered: 6, uncoveredLines: [] },
      { path: "src/time/zoned.ts", changed: 28, covered: 27, uncoveredLines: [27] },
    ]),
    {
      id: "mutation",
      kind: "mutation",
      status: "ok",
      tool: "Stryker 9",
      files: ["src/invoices/due-date.ts", "src/time/zoned.ts"],
      killed: 19,
      survived: 1,
      timedOut: 0,
      noCoverage: 2,
      score: 19 / 22,
      survivors: [
        {
          file: "src/time/zoned.ts",
          line: 26,
          mutator: "ConditionalExpression",
          replacement: "if (true) return naive;",
        },
      ],
    },
    apiNone(),
    depsNone(),
    sensitive([]),
    preview("chg_tz7k2", "billing-api"),
    {
      id: "screenshots",
      kind: "screenshots",
      status: "ok",
      shots: [
        {
          route: "/invoices/inv_2041",
          viewport: "mobile",
          beforeRef: "shot:invoice-before",
          afterRef: "shot:invoice-after",
          diffRatio: 0.012,
        },
      ],
    },
    trace("chg_tz7k2"),
    judgment(
      "plan-conformance",
      "no-concern",
      "The diff implements the plan's first acceptance criterion (due dates computed in the billing time zone) and touches only files under src/invoices, src/time and test/invoices.",
    ),
    judgment("scope-drift", "no-concern", "All three files are inside the declared scope paths."),
  ],
});

// ================================================================ 2. bug fix without a test

const locale = scenario({
  id: "chg_lc3m9",
  repoId: BILLING,
  planId: "plan_receipts",
  title: "Fall back to en-US when a customer's receipt locale is missing",
  category: "fix",
  authorId: "prn_coder12",
  status: "awaiting-review",
  computedLane: 1,
  lane: 1,
  createdMin: 95,
  updatedMin: 52,
  reasons: [
    reason("proof.no-tests", 1, "No new or changed tests. Nothing proves the fix.", "red-green"),
    reason("coverage.changed-lines", 1, "40% of changed lines covered (policy: 80%).", "coverage"),
    reason(
      "signal.missing.mutation",
      1,
      "Mutation testing skipped: no tests reach the changed lines.",
      "mutation",
    ),
    reason("size.small", 0, "6 changed lines in 1 file."),
  ],
  files: [
    file("src/emails/receipt.ts", "modified", [
      hunk(
        18,
        18,
        `
 export function renderReceipt(invoice: Invoice, customer: Customer): Email {
-  const fmt = new Intl.NumberFormat(customer.locale, {
+  const locale = customer.locale ?? customer.account?.locale ?? "en-US";
+  const fmt = new Intl.NumberFormat(locale, {
     style: "currency",
     currency: invoice.amount.currency,
   });
-  const date = new Intl.DateTimeFormat(customer.locale, { dateStyle: "long" });
+  const date = new Intl.DateTimeFormat(locale, { dateStyle: "long" });
   return {
     to: customer.email,`,
      ),
    ]),
  ],
  tour: {
    stops: [
      stop(
        "intent",
        "proven",
        "Receipts no longer depend on a customer locale being set",
        'The plan lists "receipt emails fail for customers created through the partner API" as the first bug. Those customers have no locale, and Intl throws a RangeError on undefined in some runtimes.',
        [{ file: "src/emails/receipt.ts", startLine: 19, endLine: 20 }],
        ["llm-judgment:plan-conformance"],
      ),
      stop(
        "risk",
        "unproven",
        "The fallback chain: customer, then account, then en-US",
        "The fix reads the account locale before defaulting. That is reasonable, but nothing exercises either fallback: there is no test with a missing locale, and the crash itself was never reproduced.",
        [{ file: "src/emails/receipt.ts", startLine: 19, endLine: 24 }],
        ["coverage"],
      ),
      stop(
        "uncovered",
        "unproven",
        "No test reproduces the original crash",
        "The claim that this fixes the partner-API receipts rests on matching a stack trace, not on a failing test. Red → green found no new or changed tests.",
        [],
        ["red-green", "mutation"],
      ),
    ],
    leastConfident: [
      "That this is the crash customers hit. I matched the stack trace in issue group #4411 but could not reproduce it.",
      "Whether `customer.account` is always loaded when receipts render; if it is lazy, the middle fallback is always undefined.",
    ],
    notDone: [
      "No regression test with a missing locale.",
      "Dunning and refund emails use the same lookup and were not changed.",
    ],
  },
  items: [
    redGreen("chg_lc3m9", [], "no-tests"),
    testRun("chg_lc3m9", 409),
    coverage(5, 2, [
      { path: "src/emails/receipt.ts", changed: 5, covered: 2, uncoveredLines: [19, 20, 24] },
    ]),
    {
      id: "mutation",
      kind: "mutation",
      status: "skipped",
      note: "No tests reach the changed lines, so there are no mutants to kill.",
      tool: "Stryker 9",
      files: ["src/emails/receipt.ts"],
      killed: 0,
      survived: 0,
      timedOut: 0,
      noCoverage: 4,
      score: 0,
      survivors: [],
    },
    apiNone(),
    depsNone(),
    sensitive([]),
    trace("chg_lc3m9"),
    judgment("plan-conformance", "no-concern", "Matches the plan's first listed bug."),
    judgment(
      "hidden-behavior-change",
      "unsure",
      "Customers whose locale was previously undefined but whose account locale is set will see receipts formatted differently from before. That may be intended.",
    ),
  ],
});

// ================================================================ 3. additive API change

const paginate = scenario({
  id: "chg_pg5q1",
  repoId: BILLING,
  planId: "plan_sdk3",
  title: "Add cursor pagination to listInvoices in the SDK",
  category: "feature",
  authorId: "prn_coder07",
  status: "awaiting-review",
  computedLane: 1,
  lane: 1,
  createdMin: 300,
  updatedMin: 75,
  reasons: [
    reason(
      "api.additive",
      1,
      "Public API grows: 2 added and 1 widened symbol in @acme/billing-sdk.",
      "public-api",
    ),
    reason("proof.red-green", 0, "2 new tests fail on main and pass on this change.", "red-green"),
    reason("coverage.changed-lines", 0, "100% of changed lines covered.", "coverage"),
    reason("size.small", 0, "41 changed lines in 2 files."),
  ],
  files: [
    file("packages/sdk/src/invoices.ts", "modified", [
      hunk(
        38,
        38,
        `
 import type { Client } from "./client.js";

-export async function listInvoices(client: Client): Promise<Invoice[]> {
-  const res = await client.get("/v2/invoices");
-  return res.data;
+export interface ListInvoicesOptions {
+  /** Opaque cursor from a previous page's \`nextCursor\`. */
+  cursor?: string;
+  /** Page size, 1 to 100. Defaults to 50. */
+  limit?: number;
+}
+
+export interface Page<T> {
+  items: T[];
+  nextCursor: string | null;
+}
+
+export async function listInvoices(
+  client: Client,
+  options: ListInvoicesOptions = {},
+): Promise<Invoice[] & Page<Invoice>> {
+  const res = await client.get("/v2/invoices", { query: { cursor: options.cursor, limit: options.limit ?? 50 } });
+  // Still an array, so existing callers keep working.
+  return Object.assign(res.data, { items: res.data, nextCursor: res.nextCursor ?? null });
 }`,
      ),
    ]),
    file("packages/sdk/test/invoices.test.ts", "modified", [
      hunk(
        12,
        12,
        `
 });

+it("returns the next cursor when more invoices exist", async () => {
+  const page = await listInvoices(fakeClient({ total: 120 }), { limit: 50 });
+  expect(page.items).toHaveLength(50);
+  expect(page.nextCursor).toBe("c_50");
+});
+
+it("stops with a null cursor on the last page", async () => {
+  const page = await listInvoices(fakeClient({ total: 120 }), { cursor: "c_100", limit: 50 });
+  expect(page.items).toHaveLength(20);
+  expect(page.nextCursor).toBeNull();
+});`,
      ),
    ]),
  ],
  tour: {
    stops: [
      stop(
        "intent",
        "proven",
        "listInvoices pages through results with a cursor",
        "The SDK v3 plan asks for cursor pagination on every list call, starting with invoices. This change adds it without breaking existing callers.",
        [{ file: "packages/sdk/src/invoices.ts", startLine: 40, endLine: 50 }],
        ["llm-judgment:plan-conformance"],
      ),
      stop(
        "behavior",
        "proven",
        "A 120-invoice account now comes back in pages of 50",
        "The first call returns 50 invoices and cursor c_50; the last returns 20 and a null cursor.",
        [{ file: "packages/sdk/test/invoices.test.ts", startLine: 14, endLine: 24 }],
        ["red-green"],
      ),
      stop(
        "risk",
        "proven",
        "The return type widens instead of changing",
        "Existing callers that treat the result as Invoice[] keep compiling and keep working, because the result is still that array with two extra fields. The API diff classifies this as additive.",
        [{ file: "packages/sdk/src/invoices.ts", startLine: 52, endLine: 59 }],
        ["public-api"],
      ),
      stop(
        "uncovered",
        "unproven",
        "The 100-item limit is not enforced in the SDK",
        "The docstring says 1 to 100, but the SDK passes any number through. The server clamps it; no test checks what the SDK does with 500.",
        [{ file: "packages/sdk/src/invoices.ts", startLine: 43, endLine: 44 }],
      ),
    ],
    leastConfident: [
      "Whether returning an array with extra properties survives JSON serialization in callers that cache results; the extra fields would be dropped.",
    ],
    notDone: [
      "No pagination for listCustomers or listPayments yet; the plan sequences them later.",
      "README examples still show the unpaginated call.",
    ],
  },
  items: [
    redGreen(
      "chg_pg5q1",
      [
        {
          file: "packages/sdk/test/invoices.test.ts",
          name: "returns the next cursor when more invoices exist",
        },
        {
          file: "packages/sdk/test/invoices.test.ts",
          name: "stops with a null cursor on the last page",
        },
      ],
      "proven",
    ),
    testRun("chg_pg5q1", 188),
    coverage(19, 19, [
      { path: "packages/sdk/src/invoices.ts", changed: 19, covered: 19, uncoveredLines: [] },
    ]),
    {
      id: "mutation",
      kind: "mutation",
      status: "ok",
      tool: "Stryker 9",
      files: ["packages/sdk/src/invoices.ts"],
      killed: 9,
      survived: 0,
      timedOut: 0,
      noCoverage: 0,
      score: 1,
      survivors: [],
    },
    {
      id: "public-api",
      kind: "public-api",
      status: "ok",
      classification: "additive",
      packages: [
        {
          name: "@acme/billing-sdk",
          entry: "packages/sdk/src/index.ts",
          added: [
            {
              symbol: "ListInvoicesOptions",
              after: "interface ListInvoicesOptions { cursor?: string; limit?: number }",
            },
            {
              symbol: "Page",
              after: "interface Page<T> { items: T[]; nextCursor: string | null }",
            },
          ],
          removed: [],
          changed: [
            {
              symbol: "listInvoices",
              before: "listInvoices(client: Client): Promise<Invoice[]>",
              after:
                "listInvoices(client: Client, options?: ListInvoicesOptions): Promise<Invoice[] & Page<Invoice>>",
            },
          ],
        },
      ],
    },
    depsNone(),
    sensitive([]),
    trace("chg_pg5q1"),
    judgment("plan-conformance", "no-concern", "Implements the first SDK v3 acceptance criterion."),
  ],
});

// ================================================================ 4. BREAKING API change

const breaking = scenario({
  id: "chg_br8w4",
  repoId: BILLING,
  planId: "plan_sdk3",
  title: "Remove the deprecated Invoice.total field from the SDK",
  category: "refactor",
  authorId: "prn_coder07",
  status: "awaiting-review",
  computedLane: 2,
  lane: 2,
  createdMin: 260,
  updatedMin: 22,
  reasons: [
    reason(
      "api.breaking",
      2,
      "Breaking change to @acme/billing-sdk: 1 removed field, 1 narrowed signature.",
      "public-api",
    ),
    reason("proof.red-green", 0, "Type tests fail on main and pass on this change.", "red-green"),
    reason("coverage.changed-lines", 0, "92% of changed lines covered.", "coverage"),
    reason("size.small", 0, "27 changed lines in 3 files."),
  ],
  files: [
    file("packages/sdk/src/invoice.ts", "modified", [
      hunk(
        12,
        12,
        `
 export interface Invoice {
   id: string;
   customerId: string;
-  /** @deprecated Use \`amount\`. Removed in 3.0. */
-  total: number;
   amount: Money;
   status: InvoiceStatus;
   issuedAt: string;`,
      ),
      hunk(
        41,
        39,
        `
-export function formatInvoice(invoice: Invoice, opts: { useTotal?: boolean } = {}): string {
-  const value = opts.useTotal ? invoice.total : invoice.amount.value;
-  return \`\${invoice.id}: \${formatMoney({ ...invoice.amount, value })}\`;
+export function formatInvoice(invoice: Invoice): string {
+  return \`\${invoice.id}: \${formatMoney(invoice.amount)}\`;
 }`,
      ),
    ]),
    file("src/reports/revenue.ts", "modified", [
      hunk(
        27,
        27,
        `
 export function monthlyRevenue(invoices: Invoice[]): number {
-  return invoices.reduce((sum, inv) => sum + inv.total, 0);
+  return invoices.reduce((sum, inv) => sum + inv.amount.value, 0);
 }`,
      ),
    ]),
    file("packages/sdk/test/types.test-d.ts", "modified", [
      hunk(
        8,
        8,
        `
 expectTypeOf<Invoice>().toHaveProperty("amount");
+expectTypeOf<Invoice>().not.toHaveProperty("total");
+expectTypeOf(formatInvoice).parameters.toEqualTypeOf<[Invoice]>();`,
      ),
    ]),
  ],
  tour: {
    stops: [
      stop(
        "intent",
        "proven",
        "Finish the v3 migration from total to amount",
        "The SDK v3 plan removes Invoice.total after its deprecation window. `total` has been deprecated since 2.14.0, released 41 days ago.",
        [],
        ["llm-judgment:plan-conformance"],
      ),
      stop(
        "risk",
        "risk",
        "Breaking: Invoice.total is removed from the public SDK",
        "Any consumer that reads invoice.total stops compiling in TypeScript and silently reads undefined in JavaScript. formatInvoice also loses its useTotal option, so calls that pass it fail to compile. This repo's own callers were migrated; callers outside the repo were not checked, and nothing in this change bumps the major version.",
        [
          { file: "packages/sdk/src/invoice.ts", startLine: 15, endLine: 16, side: "base" },
          { file: "packages/sdk/src/invoice.ts", startLine: 39, endLine: 41 },
        ],
        ["public-api"],
      ),
      stop(
        "behavior",
        "proven",
        "Revenue reports now sum amount.value",
        "monthlyRevenue was the last internal reader of total. The revenue report test still passes with the same numbers.",
        [{ file: "src/reports/revenue.ts", startLine: 27, endLine: 29 }],
        ["test-run:unit"],
      ),
      stop(
        "proof",
        "proven",
        "Type tests pin the new shape",
        "Two type-level tests fail on main (total exists, useTotal accepted) and pass here.",
        [{ file: "packages/sdk/test/types.test-d.ts", startLine: 9, endLine: 10 }],
        ["red-green"],
      ),
      stop(
        "uncovered",
        "unproven",
        "Consumers outside this repository",
        "The platform can only see this repository. Partner integrations and the mobile app pin @acme/billing-sdk separately and may still read total.",
        [],
        [],
      ),
    ],
    leastConfident: [
      "Whether any partner integration still reads total. The SDK has no usage telemetry, so this is a guess from the deprecation date alone.",
      'The changelog entry says "removed", but the package version stays 2.x. Publishing this as a minor release would break consumers on a caret range.',
    ],
    notDone: [
      "No major version bump of @acme/billing-sdk.",
      "No codemod or migration note for SDK consumers.",
    ],
  },
  items: [
    redGreen(
      "chg_br8w4",
      [
        { file: "packages/sdk/test/types.test-d.ts", name: "Invoice has no total property" },
        {
          file: "packages/sdk/test/types.test-d.ts",
          name: "formatInvoice takes exactly one parameter",
        },
      ],
      "proven",
    ),
    testRun("chg_br8w4", 190),
    coverage(12, 11, [
      { path: "packages/sdk/src/invoice.ts", changed: 4, covered: 4, uncoveredLines: [] },
      { path: "src/reports/revenue.ts", changed: 1, covered: 1, uncoveredLines: [] },
    ]),
    {
      id: "mutation",
      kind: "mutation",
      status: "ok",
      tool: "Stryker 9",
      files: ["packages/sdk/src/invoice.ts", "src/reports/revenue.ts"],
      killed: 6,
      survived: 0,
      timedOut: 0,
      noCoverage: 0,
      score: 1,
      survivors: [],
    },
    {
      id: "public-api",
      kind: "public-api",
      status: "ok",
      classification: "breaking",
      packages: [
        {
          name: "@acme/billing-sdk",
          entry: "packages/sdk/src/index.ts",
          added: [],
          removed: [{ symbol: "Invoice.total", before: "total: number" }],
          changed: [
            {
              symbol: "formatInvoice",
              before: "formatInvoice(invoice: Invoice, opts?: { useTotal?: boolean }): string",
              after: "formatInvoice(invoice: Invoice): string",
            },
          ],
        },
      ],
    },
    depsNone(),
    sensitive([]),
    trace("chg_br8w4"),
    judgment("plan-conformance", "no-concern", "Removing `total` is listed in the SDK v3 plan."),
    judgment(
      "hidden-behavior-change",
      "concern",
      "formatInvoice previously honoured useTotal; callers passing it get a compile error rather than a behavior change, which is the safer failure. Flagged so a human confirms the release plan.",
    ),
  ],
});

// ================================================================ 5. new dependency with install script

const pdf = scenario({
  id: "chg_pd2n6",
  repoId: BILLING,
  planId: "plan_pdf",
  title: "Render invoice PDFs with pdf-lib and sharp",
  category: "feature",
  authorId: "prn_coder12",
  status: "awaiting-review",
  computedLane: 2,
  lane: 2,
  createdMin: 410,
  updatedMin: 64,
  reasons: [
    reason(
      "deps.install-script",
      2,
      "New dependency sharp runs an install script.",
      "dependencies",
    ),
    reason("deps.added", 1, "2 new runtime dependencies.", "dependencies"),
    reason(
      "proof.red-green",
      0,
      "1 new test fails on main and passes on this change.",
      "red-green",
    ),
    reason("coverage.changed-lines", 0, "88% of changed lines covered.", "coverage"),
  ],
  files: [
    file("package.json", "modified", [
      hunk(
        14,
        14,
        `
   "dependencies": {
     "hono": "^4.9.0",
+    "pdf-lib": "^1.17.1",
+    "sharp": "^0.34.4",
     "zod": "^4.6.5"
   },`,
      ),
    ]),
    file("src/invoices/pdf.ts", "added", [
      hunk(
        0,
        1,
        `
+import { PDFDocument, StandardFonts } from "pdf-lib";
+import sharp from "sharp";
+import type { Invoice } from "./types.js";
+
+export async function renderInvoicePdf(invoice: Invoice, logoSvg: Uint8Array): Promise<Uint8Array> {
+  const doc = await PDFDocument.create();
+  const page = doc.addPage([595, 842]);
+  const font = await doc.embedFont(StandardFonts.Helvetica);
+  const logoPng = await sharp(logoSvg).resize(160).png().toBuffer();
+  page.drawImage(await doc.embedPng(logoPng), { x: 48, y: 760, width: 160, height: 40 });
+  page.drawText(\`Invoice \${invoice.number}\`, { x: 48, y: 720, size: 18, font });
+  return doc.save();
+}`,
      ),
    ]),
  ],
  tour: {
    stops: [
      stop(
        "intent",
        "proven",
        "Customers can download a PDF of any invoice",
        "The PDF export plan asks for a downloadable invoice that matches the web view, logo included.",
        [{ file: "src/invoices/pdf.ts", startLine: 5, endLine: 13 }],
        ["llm-judgment:plan-conformance"],
      ),
      stop(
        "risk",
        "risk",
        "sharp is a native module, and this service runs on Workers",
        "sharp ships prebuilt native binaries and runs an install script to fetch them. The deploy target is a Cloudflare Worker, which cannot load native modules, so line 9 will fail in production even though tests pass in Node.",
        [
          { file: "src/invoices/pdf.ts", startLine: 2, endLine: 2 },
          { file: "src/invoices/pdf.ts", startLine: 9, endLine: 9 },
        ],
        ["dependencies"],
      ),
      stop(
        "behavior",
        "proven",
        "A sample invoice renders to a one-page PDF",
        "The new test renders inv_2041 and checks the page count and title text.",
        [],
        ["red-green", "screenshots"],
      ),
      stop(
        "uncovered",
        "unproven",
        "The PDF was never rendered in the Workers runtime",
        "The preview deploy built, but no screenshot or test hit the PDF route in the preview.",
        [],
        ["preview"],
      ),
    ],
    leastConfident: [
      "Whether sharp can be replaced by embedding the logo as a pre-rendered PNG, which would remove the native dependency entirely.",
    ],
    notDone: [
      "No route exposes the PDF yet; the plan's download button is a follow-up.",
      "Fonts are Helvetica only; non-Latin customer names will not render.",
    ],
  },
  items: [
    redGreen(
      "chg_pd2n6",
      [
        {
          file: "test/invoices/pdf.test.ts",
          name: "renders a one-page PDF with the invoice number",
        },
      ],
      "proven",
    ),
    testRun("chg_pd2n6", 413),
    coverage(17, 15, [
      { path: "src/invoices/pdf.ts", changed: 13, covered: 11, uncoveredLines: [10, 11] },
    ]),
    {
      id: "mutation",
      kind: "mutation",
      status: "ok",
      tool: "Stryker 9",
      files: ["src/invoices/pdf.ts"],
      killed: 7,
      survived: 2,
      timedOut: 0,
      noCoverage: 1,
      score: 0.7,
      survivors: [
        { file: "src/invoices/pdf.ts", line: 10, mutator: "ObjectLiteral", replacement: "{}" },
        { file: "src/invoices/pdf.ts", line: 11, mutator: "StringLiteral", replacement: "``" },
      ],
    },
    apiNone(),
    {
      id: "dependencies",
      kind: "dependencies",
      status: "ok",
      added: [
        { name: "pdf-lib", version: "1.17.1", dev: false, manifest: "package.json" },
        { name: "sharp", version: "0.34.4", dev: false, manifest: "package.json" },
      ],
      removed: [],
      changed: [],
      newInstallScripts: [{ name: "sharp", script: "install", command: "node install/check.js" }],
      lockfileChanged: true,
    },
    sensitive([]),
    preview("chg_pd2n6", "billing-api"),
    {
      id: "screenshots",
      kind: "screenshots",
      status: "skipped",
      note: "The plan declares no affected routes for this change.",
      shots: [],
    },
    trace("chg_pd2n6"),
    judgment("plan-conformance", "no-concern", "Implements PDF rendering as described."),
  ],
});

// ================================================================ 6. auth change (human author)

const session = scenario({
  id: "chg_ss4h8",
  repoId: BILLING,
  planId: "plan_session",
  title: "Shorten sessions to 12 hours and rotate them on role change",
  category: "feature",
  authorId: "prn_lena",
  status: "awaiting-review",
  computedLane: 2,
  lane: 2,
  agentTrace: false,
  createdMin: 520,
  updatedMin: 110,
  reasons: [
    reason(
      "sensitive.path",
      2,
      "Touches src/auth/session.ts (matches **/auth/**).",
      "sensitive-paths",
    ),
    reason("proof.red-green", 0, "2 new tests fail on main and pass on this change.", "red-green"),
    reason("coverage.changed-lines", 0, "100% of changed lines covered.", "coverage"),
    reason("size.small", 0, "22 changed lines in 2 files."),
  ],
  files: [
    file("src/auth/session.ts", "modified", [
      hunk(
        8,
        8,
        `
-const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
+const SESSION_TTL_SECONDS = 12 * 60 * 60;

 export async function onRoleChange(db: Db, userId: string): Promise<void> {
-  await db.audit.insert({ userId, action: "role.changed" });
+  await db.audit.insert({ userId, action: "role.changed" });
+  // A role change invalidates every live session for that user.
+  await db.sessions.deleteWhere({ userId });
 }`,
      ),
    ]),
  ],
  tour: {
    stops: [
      stop(
        "intent",
        "proven",
        "Shorter sessions, and none survive a role change",
        "The session-hardening plan sets a 12-hour lifetime and requires that a demoted user loses access immediately.",
        [{ file: "src/auth/session.ts", startLine: 8, endLine: 8 }],
        [],
      ),
      stop(
        "risk",
        "risk",
        "Every session older than 12 hours ends at deploy",
        "Sessions are validated against the new TTL on their next request. Anyone signed in for more than 12 hours, which today includes most of support, is signed out the moment this rolls out.",
        [{ file: "src/auth/session.ts", startLine: 8, endLine: 8 }],
        ["sensitive-paths"],
      ),
      stop(
        "behavior",
        "proven",
        "Role changes now sign the user out everywhere",
        "The second new test demotes a user with two live sessions and checks both are rejected.",
        [{ file: "src/auth/session.ts", startLine: 10, endLine: 14 }],
        ["red-green"],
      ),
      stop(
        "uncovered",
        "unproven",
        "Requests in flight during a role change",
        "A request authenticated just before the delete can still complete with the old role. The plan does not say whether that window matters.",
        [],
        [],
      ),
    ],
    leastConfident: [
      "Whether support's tooling handles a forced sign-out gracefully; it holds sessions for days today.",
    ],
    notDone: [
      "No announcement or banner before the forced sign-out.",
      "Refresh tokens for the mobile app are unchanged.",
    ],
  },
  items: [
    redGreen(
      "chg_ss4h8",
      [
        { file: "test/auth/session.test.ts", name: "expires sessions after 12 hours" },
        { file: "test/auth/session.test.ts", name: "rejects every session after a role change" },
      ],
      "proven",
    ),
    testRun("chg_ss4h8", 414),
    coverage(4, 4, [{ path: "src/auth/session.ts", changed: 4, covered: 4, uncoveredLines: [] }]),
    {
      id: "mutation",
      kind: "mutation",
      status: "ok",
      tool: "Stryker 9",
      files: ["src/auth/session.ts"],
      killed: 5,
      survived: 0,
      timedOut: 0,
      noCoverage: 0,
      score: 1,
      survivors: [],
    },
    apiNone(),
    depsNone(),
    sensitive([{ path: "src/auth/session.ts", pattern: "**/auth/**" }]),
    judgment(
      "hidden-behavior-change",
      "concern",
      "Existing long-lived sessions end on deploy. The plan approves the shorter TTL but does not mention the forced sign-out.",
    ),
  ],
});

// ================================================================ 7. verified codemod (shadow 0 → 1)

const codemod = scenario({
  id: "chg_cm6t3",
  repoId: BILLING,
  planId: null,
  title: "Rename fetchInvoice to getInvoice across the service",
  category: "transform",
  authorId: "prn_coder07",
  status: "awaiting-review",
  computedLane: 0,
  lane: 1,
  createdMin: 48,
  updatedMin: 31,
  reasons: [
    reason(
      "transform.verified",
      0,
      "Re-running rename-symbol on main reproduced all 23 files byte for byte.",
      "transform",
    ),
    reason("plan.planless-allowed", 0, "Repo policy allows verified transforms without a plan."),
    reason("api.none", 0, "No change to the public API.", "public-api"),
    reason(
      "shadow.lane0-disabled",
      1,
      "Lane 0 is in shadow mode for this repo, so the change is routed to Lane 1.",
    ),
  ],
  files: [
    file(
      "src/invoices/repository.ts",
      "modified",
      [
        hunk(
          22,
          22,
          `
-export async function fetchInvoice(db: Db, id: string): Promise<Invoice | null> {
+export async function getInvoice(db: Db, id: string): Promise<Invoice | null> {
   return db.invoices.find(id);`,
        ),
      ],
      { transformVerified: true },
    ),
    file(
      "src/routes/invoices.ts",
      "modified",
      [
        hunk(
          9,
          9,
          `
-import { fetchInvoice } from "../invoices/repository.js";
+import { getInvoice } from "../invoices/repository.js";`,
        ),
        hunk(
          31,
          31,
          `
-  const invoice = await fetchInvoice(c.env.DB, c.req.param("id"));
+  const invoice = await getInvoice(c.env.DB, c.req.param("id"));`,
        ),
      ],
      { transformVerified: true },
    ),
    file(
      "src/emails/receipt-job.ts",
      "modified",
      [
        hunk(
          4,
          4,
          `
-import { fetchInvoice } from "../invoices/repository.js";
+import { getInvoice } from "../invoices/repository.js";`,
        ),
      ],
      { transformVerified: true },
    ),
  ],
  tour: {
    stops: [
      stop(
        "intent",
        "proven",
        "A mechanical rename, nothing else",
        "Renames fetchInvoice to getInvoice to match the repository naming convention. The author declared it a transform, and the platform checked that claim instead of trusting it.",
        [],
        ["transform"],
      ),
      stop(
        "transform",
        "proven",
        "Verified transform: 23 files, 61 call sites",
        "The platform re-ran `.platform/transforms/rename-symbol.ts fetchInvoice getInvoice` on main in a clean sandbox and got byte-identical output for all 23 files. There is nothing else in the diff.",
        [{ file: "src/invoices/repository.ts", startLine: 22, endLine: 23 }],
        ["transform", "test-run:unit"],
      ),
      stop(
        "uncovered",
        "unproven",
        "String-keyed lookups are outside the transform",
        'A rename tool rewrites identifiers, not strings. A text search found no `"fetchInvoice"` literals, but generated clients under gen/ were not searched.',
        [],
        [],
      ),
    ],
    leastConfident: [
      "Generated code under gen/ is excluded from the transform and from the text search.",
    ],
    notDone: ["Two docs pages still mention fetchInvoice."],
  },
  items: [
    {
      id: "transform",
      kind: "transform",
      status: "ok",
      transform: ".platform/transforms/rename-symbol.ts",
      command: "pnpm platform transform rename-symbol fetchInvoice getInvoice",
      verified: true,
      files: [
        "src/invoices/repository.ts",
        "src/routes/invoices.ts",
        "src/emails/receipt-job.ts",
        "src/emails/dunning-job.ts",
        "src/reports/revenue.ts",
        "src/reports/aging.ts",
        "src/webhooks/invoice-paid.ts",
        "src/webhooks/invoice-voided.ts",
        "src/admin/invoices.ts",
        "src/admin/refunds.ts",
        "src/jobs/reconcile.ts",
        "src/jobs/close-month.ts",
        "test/invoices/repository.test.ts",
        "test/routes/invoices.test.ts",
        "test/emails/receipt-job.test.ts",
        "test/emails/dunning-job.test.ts",
        "test/reports/revenue.test.ts",
        "test/reports/aging.test.ts",
        "test/webhooks/invoice-paid.test.ts",
        "test/webhooks/invoice-voided.test.ts",
        "test/admin/invoices.test.ts",
        "test/jobs/reconcile.test.ts",
        "test/jobs/close-month.test.ts",
      ],
      mismatchedFiles: [],
    },
    testRun("chg_cm6t3", 412),
    apiNone(),
    depsNone(),
    sensitive([]),
    trace("chg_cm6t3"),
  ],
});

// ================================================================ 8. policy change

const policy = scenario({
  id: "chg_pl9c2",
  repoId: BILLING,
  planId: "plan_thresholds",
  title: "Raise billing's mutation threshold to 70% and coverage to 85%",
  category: "chore",
  authorId: "prn_dev",
  status: "awaiting-review",
  computedLane: 2,
  lane: 2,
  agentTrace: false,
  createdMin: 180,
  updatedMin: 90,
  reasons: [
    reason(
      "policy.modified",
      2,
      "Changes .platform/policy.ts. Policy changes always need a full review by someone other than the author.",
      "sensitive-paths",
    ),
    reason("size.small", 0, "4 changed lines in 1 file."),
  ],
  files: [
    file(".platform/policy.ts", "modified", [
      hunk(
        11,
        11,
        `
   thresholds: {
-    changedLineCoverage: 0.8,
-    mutationScore: 0.6,
+    changedLineCoverage: 0.85,
+    mutationScore: 0.7,
     lane0MaxDiffLines: 150,
     lane0MaxFiles: 8,`,
      ),
    ]),
  ],
  tour: {
    stops: [
      stop(
        "intent",
        "proven",
        "Stricter proof before anything reaches Lane 0",
        "The plan raises the bar for billing after two reverted changes in September both passed at 60% mutation score.",
        [{ file: ".platform/policy.ts", startLine: 12, endLine: 13 }],
        [],
      ),
      stop(
        "behavior",
        "risk",
        "3 of the last 20 changes would have needed a human",
        "Replaying the classifier over the last 20 billing changes with the new thresholds moves 3 from Lane 0 to Lane 1. That is the intended cost, but it slows shadow-mode agreement too.",
        [],
        [],
      ),
      stop(
        "other",
        "proven",
        "The new policy applies from the merge commit onward",
        "Policy is always read from main. Changes already in flight keep the policy of their base commit until they rebase.",
        [],
        [],
      ),
    ],
    leastConfident: [
      "Whether 85% changed-line coverage is reachable for the PDF work, which has native-module code paths that are hard to test.",
    ],
    notDone: ["The same thresholds were not proposed for edge-router."],
  },
  items: [
    testRun("chg_pl9c2", 412),
    apiNone(),
    depsNone(),
    sensitive([{ path: ".platform/policy.ts", pattern: ".platform/**" }]),
  ],
});

// ================================================================ 9. scope drift

const drift = scenario({
  id: "chg_dr1x5",
  repoId: BILLING,
  planId: "plan_webhooks",
  title: "Add jittered backoff to webhook retries",
  category: "feature",
  authorId: "prn_coder12",
  status: "awaiting-review",
  computedLane: 2,
  lane: 2,
  createdMin: 230,
  updatedMin: 15,
  reasons: [
    reason("scope.drift", 2, "1 file outside the plan's scope: src/auth/signing-keys.ts."),
    reason(
      "sensitive.path",
      2,
      "Touches src/auth/signing-keys.ts (matches **/auth/**).",
      "sensitive-paths",
    ),
    reason(
      "llm.scope-drift",
      2,
      "The model found a change unrelated to the plan's intent.",
      "llm-judgment:scope-drift",
    ),
    reason("proof.red-green", 0, "2 new tests fail on main and pass on this change.", "red-green"),
  ],
  files: [
    file("src/webhooks/retry.ts", "modified", [
      hunk(
        5,
        5,
        `
 export function nextDelayMs(attempt: number): number {
-  return Math.min(60_000, 1_000 * 2 ** attempt);
+  const ceiling = Math.min(60_000, 1_000 * 2 ** attempt);
+  // Full jitter: spread retries so a recovering endpoint is not stampeded.
+  return Math.floor(Math.random() * ceiling);
 }`,
      ),
    ]),
    file("src/auth/signing-keys.ts", "modified", [
      hunk(
        3,
        3,
        `
-const KEY_CACHE_TTL_MS = 60 * 60 * 1000;
+const KEY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;`,
      ),
    ]),
  ],
  tour: {
    stops: [
      stop(
        "intent",
        "proven",
        "Retries spread out instead of arriving in waves",
        "The webhook reliability plan asks for jittered exponential backoff so recovering customer endpoints are not hit by synchronized retries.",
        [{ file: "src/webhooks/retry.ts", startLine: 5, endLine: 9 }],
        ["llm-judgment:plan-conformance"],
      ),
      stop(
        "risk",
        "risk",
        "Out of scope: signing keys are now cached for 24 hours",
        "The plan covers webhook retries. This hunk changes how long webhook signing keys are cached, from 1 hour to 24. A rotated or revoked key would keep verifying for up to a day. Nothing in the plan, the tests or the author's summary mentions it.",
        [{ file: "src/auth/signing-keys.ts", startLine: 3, endLine: 3 }],
        ["sensitive-paths", "llm-judgment:scope-drift"],
      ),
      stop(
        "proof",
        "proven",
        "Jitter stays within the exponential ceiling",
        "Both new tests fail on main and pass here: delays never exceed the ceiling, and two clients with the same attempt number get different delays.",
        [],
        ["red-green"],
      ),
      stop(
        "uncovered",
        "unproven",
        "The TTL change has no test and no stated reason",
        "If the longer cache was deliberate it belongs in its own change with its own plan.",
        [],
        [],
      ),
    ],
    leastConfident: [
      "Why the signing-key TTL changed. The agent trace shows it was edited while debugging a flaky test and never reverted.",
    ],
    notDone: ["Retry budgets per endpoint, which the plan lists as a second step."],
  },
  items: [
    redGreen(
      "chg_dr1x5",
      [
        {
          file: "test/webhooks/retry.test.ts",
          name: "never waits longer than the exponential ceiling",
        },
        { file: "test/webhooks/retry.test.ts", name: "spreads two clients on the same attempt" },
      ],
      "proven",
    ),
    testRun("chg_dr1x5", 414),
    coverage(4, 3, [
      { path: "src/webhooks/retry.ts", changed: 3, covered: 3, uncoveredLines: [] },
      { path: "src/auth/signing-keys.ts", changed: 1, covered: 0, uncoveredLines: [3] },
    ]),
    apiNone(),
    depsNone(),
    sensitive([{ path: "src/auth/signing-keys.ts", pattern: "**/auth/**" }]),
    trace("chg_dr1x5"),
    judgment("plan-conformance", "no-concern", "The retry change matches the plan."),
    judgment(
      "scope-drift",
      "concern",
      "src/auth/signing-keys.ts is outside the plan's scope paths (src/webhooks/**, test/webhooks/**) and changes key-rotation behavior, which the plan does not mention.",
    ),
  ],
});

// ================================================================ 10. rollout mid-flight (25%)

const fx = scenario({
  id: "chg_fx2r7",
  repoId: BILLING,
  planId: "plan_fx",
  title: "Cache FX rates for 60 seconds when totalling invoices",
  category: "feature",
  authorId: "prn_coder07",
  status: "rolling-out",
  computedLane: 1,
  lane: 1,
  createdMin: 1_440,
  updatedMin: 6,
  flagKey: "chg_fx2r7.cache-fx-rates",
  merged: true,
  rolloutState: {
    status: "rolling",
    versionId: "v-7f3c2a1",
    previousVersionId: "v-5d81e09",
    stages: [
      { percent: 5, startedAt: ago(16), completedAt: ago(6) },
      { percent: 25, startedAt: ago(6), completedAt: null },
      { percent: 100, startedAt: null, completedAt: null },
    ],
    watchUntil: null,
    flagKey: "chg_fx2r7.cache-fx-rates",
    lastCheck: {
      at: ago(0.5),
      errorRate: 0.0042,
      baselineErrorRate: 0.0039,
      requests: 18_240,
      newIssueGroups: 0,
    },
  },
  reasons: [
    reason("api.none", 0, "No change to the public API.", "public-api"),
    reason("coverage.changed-lines", 0, "91% of changed lines covered.", "coverage"),
    reason(
      "llm.hidden-behavior-change",
      1,
      "Totals can use a rate up to 60 seconds old.",
      "llm-judgment:hidden-behavior-change",
    ),
  ],
  files: [
    file("src/fx/rates.ts", "modified", [
      hunk(
        6,
        6,
        `
-export async function rateFor(currency: string, env: Env): Promise<number> {
-  return fetchRate(currency, env);
+const cache = new Map<string, { rate: number; at: number }>();
+
+export async function rateFor(currency: string, env: Env, now = Date.now()): Promise<number> {
+  const hit = cache.get(currency);
+  if (hit && now - hit.at < 60_000) return hit.rate;
+  const rate = await fetchRate(currency, env);
+  cache.set(currency, { rate, at: now });
+  return rate;
 }`,
      ),
    ]),
  ],
  tour: {
    stops: [
      stop(
        "intent",
        "proven",
        "Fewer FX lookups per invoice total",
        "Totalling a 200-line invoice made 200 rate lookups. The plan caps that at one per currency per minute.",
        [{ file: "src/fx/rates.ts", startLine: 6, endLine: 15 }],
        [],
      ),
      stop(
        "risk",
        "unproven",
        "Totals can use a rate up to 60 seconds old",
        "Accepted in the plan as a trade-off.",
        [],
        ["llm-judgment:hidden-behavior-change"],
      ),
    ],
    leastConfident: [
      "The cache is per isolate, so hit rates in production will be lower than in tests.",
    ],
    notDone: ["No metric for cache hit rate."],
  },
  items: [
    testRun("chg_fx2r7", 418),
    coverage(11, 10, [{ path: "src/fx/rates.ts", changed: 11, covered: 10, uncoveredLines: [12] }]),
    apiNone(),
    depsNone(),
    sensitive([]),
    judgment(
      "hidden-behavior-change",
      "concern",
      "Invoice totals may use a rate up to 60 seconds stale.",
    ),
  ],
});

// ================================================================ 11. auto-reverted change + its verified revert

const ledger = scenario({
  id: "chg_lg8b0",
  repoId: BILLING,
  planId: "plan_ledger",
  title: "Batch ledger writes per tenant",
  category: "refactor",
  authorId: "prn_coder12",
  status: "reverted",
  computedLane: 1,
  lane: 1,
  createdMin: 2_900,
  updatedMin: 190,
  flagKey: "chg_lg8b0.batch-ledger",
  merged: true,
  revertedBy: "chg_rv8b1",
  rolloutState: {
    status: "rolled-back",
    versionId: "v-c41e9b2",
    previousVersionId: "v-7a0d3f4",
    stages: [
      { percent: 5, startedAt: ago(226), completedAt: ago(216) },
      { percent: 25, startedAt: ago(216), completedAt: null },
      { percent: 100, startedAt: null, completedAt: null },
    ],
    watchUntil: null,
    flagKey: "chg_lg8b0.batch-ledger",
    lastCheck: {
      at: ago(209),
      errorRate: 0.031,
      baselineErrorRate: 0.004,
      requests: 9_812,
      newIssueGroups: 2,
    },
  },
  issues: [
    {
      id: "iss_4518",
      changeId: "chg_lg8b0",
      title: "TypeError: Cannot read properties of undefined (reading 'tenantId') at flushBatch",
      count: 214,
      firstSeen: ago(215),
      lastSeen: ago(209),
      versionId: "v-c41e9b2",
      url: "https://dash.cloudflare.com/",
    },
    {
      id: "iss_4519",
      changeId: "chg_lg8b0",
      title: "D1_ERROR: too many SQL variables at insertLedgerRows",
      count: 37,
      firstSeen: ago(213),
      lastSeen: ago(209),
      versionId: "v-c41e9b2",
      url: "https://dash.cloudflare.com/",
    },
  ],
  reasons: [
    reason("proof.red-green", 0, "3 new tests fail on main and pass on this change.", "red-green"),
    reason("size.medium", 1, "212 changed lines in 6 files (Lane 0 allows 150)."),
  ],
  files: [
    file("src/ledger/writer.ts", "modified", [
      hunk(
        10,
        10,
        `
-export async function writeEntry(db: Db, entry: LedgerEntry): Promise<void> {
-  await db.ledger.insert(entry);
+export async function writeEntry(batcher: Batcher<LedgerEntry>, entry: LedgerEntry): Promise<void> {
+  batcher.add(entry.tenantId, entry);
 }`,
      ),
    ]),
  ],
  tour: {
    stops: [
      stop(
        "intent",
        "proven",
        "One D1 write per tenant per flush",
        "Ledger writes were one statement per entry. Batching cuts write volume by about 40× in staging.",
        [],
        ["test-run:unit"],
      ),
      stop(
        "risk",
        "risk",
        "Batch size is not bounded by D1's variable limit",
        "A large tenant can exceed 100 bound variables per statement.",
        [],
        [],
      ),
    ],
    leastConfident: ["Behavior for tenants with thousands of entries per second."],
    notDone: ["No limit on batch size."],
  },
  items: [testRun("chg_lg8b0", 421), apiNone(), depsNone(), sensitive([])],
});

const ledgerRevert = scenario({
  id: "chg_rv8b1",
  repoId: BILLING,
  planId: null,
  title: "Revert “Batch ledger writes per tenant”",
  category: "revert",
  authorId: "prn_platform",
  status: "released",
  computedLane: 0,
  lane: 0,
  createdMin: 208,
  updatedMin: 160,
  merged: true,
  revertOf: "chg_lg8b0",
  agentTrace: false,
  rolloutState: {
    status: "released",
    versionId: "v-7a0d3f4",
    previousVersionId: "v-c41e9b2",
    stages: [{ percent: 100, startedAt: ago(205), completedAt: ago(205) }],
    watchUntil: ago(175),
    flagKey: null,
    lastCheck: {
      at: ago(175),
      errorRate: 0.0038,
      baselineErrorRate: 0.004,
      requests: 61_002,
      newIssueGroups: 0,
    },
  },
  reasons: [
    reason(
      "revert.verified",
      0,
      "Exact inverse of merged change chg_lg8b0. Policy auto-merges verified reverts, even in shadow mode.",
    ),
  ],
  files: [
    file("src/ledger/writer.ts", "modified", [
      hunk(
        10,
        10,
        `
-export async function writeEntry(batcher: Batcher<LedgerEntry>, entry: LedgerEntry): Promise<void> {
-  batcher.add(entry.tenantId, entry);
+export async function writeEntry(db: Db, entry: LedgerEntry): Promise<void> {
+  await db.ledger.insert(entry);
 }`,
      ),
    ]),
  ],
  tour: {
    stops: [
      stop(
        "intent",
        "proven",
        "Restore the last approved ledger writer",
        "Opened automatically when the 25% stage of chg_lg8b0 crossed the error-rate limit: 3.1% against a 0.4% baseline, with a 1.0-point allowance.",
        [],
        [],
      ),
      stop(
        "transform",
        "proven",
        "The diff is the exact inverse of the reverted change",
        "The platform checked that applying this diff to main yields the tree of the commit before chg_lg8b0 merged.",
        [{ file: "src/ledger/writer.ts", startLine: 10, endLine: 12 }],
        [],
      ),
    ],
    leastConfident: [
      "Ledger rows written in batched form during the 21 minutes at 5–25% stay batched; the revert does not rewrite them.",
    ],
    notDone: ["Data written by the reverted version was not migrated back."],
  },
  items: [testRun("chg_rv8b1", 418), apiNone(), depsNone(), sensitive([])],
});

// ================================================================ in-flight pipelines

const numbering = scenario({
  id: "chg_nm3k4",
  repoId: BILLING,
  planId: "plan_numbering",
  title: "Per-tenant invoice number sequences",
  category: "feature",
  authorId: "prn_coder07",
  status: "running",
  computedLane: null,
  lane: null,
  createdMin: 12,
  updatedMin: 2,
  reasons: [],
  files: [],
  runs: [partialRun("chg_nm3k4", sha("chg_nm3k4:head"), 4, 4, "running")],
});

const wrangler = scenario({
  id: "chg_wr5p8",
  repoId: BILLING,
  planId: null,
  title: "Upgrade wrangler to 4.42",
  category: "dependency",
  authorId: "prn_coder12",
  status: "failing",
  computedLane: null,
  lane: null,
  createdMin: 70,
  updatedMin: 41,
  reasons: [],
  files: [],
  runs: [partialRun("chg_wr5p8", sha("chg_wr5p8:head"), 45, 1, "failed")],
});

// ================================================================ edge-router (Lane 0 enabled)

const undici = scenario({
  id: "chg_un2d6",
  repoId: EDGE,
  planId: null,
  title: "Bump undici 6.21.1 → 6.21.2",
  category: "dependency",
  authorId: "prn_coder12",
  status: "released",
  computedLane: 0,
  lane: 0,
  createdMin: 900,
  updatedMin: 760,
  merged: true,
  rolloutState: {
    status: "released",
    versionId: "v-19ab0c3",
    previousVersionId: "v-0f7e2d1",
    stages: [
      { percent: 5, startedAt: ago(850), completedAt: ago(840) },
      { percent: 25, startedAt: ago(840), completedAt: ago(830) },
      { percent: 100, startedAt: ago(830), completedAt: ago(830) },
    ],
    watchUntil: ago(800),
    flagKey: null,
    lastCheck: {
      at: ago(800),
      errorRate: 0.0011,
      baselineErrorRate: 0.0012,
      requests: 402_118,
      newIssueGroups: 0,
    },
  },
  reasons: [
    reason(
      "deps.patch-bump",
      0,
      "Semver patch bump of an existing dependency; allowed in Lane 0.",
      "dependencies",
    ),
  ],
  files: [
    file("package.json", "modified", [
      hunk(
        9,
        9,
        `
-    "undici": "6.21.1",
+    "undici": "6.21.2",`,
      ),
    ]),
  ],
  tour: {
    stops: [
      stop(
        "intent",
        "proven",
        "Patch release of undici",
        "Fixes a header-parsing bug upstream. No API or install-script changes.",
        [],
        ["dependencies"],
      ),
    ],
    leastConfident: [
      "Upstream changelog lists one fix; no transitive changes were inspected beyond the lockfile.",
    ],
    notDone: ["None beyond the bump."],
  },
  items: [
    testRun("chg_un2d6", 233),
    {
      id: "dependencies",
      kind: "dependencies",
      status: "ok",
      added: [],
      removed: [],
      changed: [
        {
          name: "undici",
          from: "6.21.1",
          to: "6.21.2",
          bump: "patch",
          dev: false,
          manifest: "package.json",
        },
      ],
      newInstallScripts: [],
      lockfileChanged: true,
    },
    sensitive([]),
  ],
});

const cors = scenario({
  id: "chg_co7r1",
  repoId: EDGE,
  planId: "plan_cors",
  title: "Allow the new dashboard origin in CORS",
  category: "feature",
  authorId: "prn_coder07",
  status: "awaiting-review",
  computedLane: 1,
  lane: 1,
  createdMin: 55,
  updatedMin: 27,
  reasons: [
    reason("coverage.changed-lines", 1, "67% of changed lines covered (policy: 80%).", "coverage"),
    reason(
      "proof.red-green",
      0,
      "1 new test fails on main and passes on this change.",
      "red-green",
    ),
  ],
  files: [
    file("src/cors.ts", "modified", [
      hunk(
        3,
        3,
        `
 const ALLOWED = new Set([
   "https://app.acme.dev",
+  "https://dashboard.acme.dev",
 ]);`,
      ),
    ]),
  ],
  tour: {
    stops: [
      stop(
        "intent",
        "proven",
        "The new dashboard can call the edge API",
        "Adds one origin to the allow-list, as the plan describes.",
        [{ file: "src/cors.ts", startLine: 3, endLine: 6 }],
        ["red-green"],
      ),
      stop(
        "uncovered",
        "unproven",
        "Preflight caching is unchanged and untested",
        "Browsers may cache the old preflight response for up to 10 minutes.",
        [],
        ["coverage"],
      ),
    ],
    leastConfident: ["Whether staging should also be allowed; the plan names only production."],
    notDone: ["No allow-list entry for the staging dashboard."],
  },
  items: [
    redGreen(
      "chg_co7r1",
      [{ file: "test/cors.test.ts", name: "allows dashboard.acme.dev" }],
      "proven",
    ),
    testRun("chg_co7r1", 231),
    coverage(3, 2, [{ path: "src/cors.ts", changed: 3, covered: 2, uncoveredLines: [7] }]),
    apiNone(),
    depsNone(),
    sensitive([]),
  ],
});

// ================================================================ web-dashboard

const laneTags = scenario({
  id: "chg_lt4v9",
  repoId: DASH,
  planId: "plan_dash_lanes",
  title: "Show lane tags in the change list",
  category: "feature",
  authorId: "prn_coder07",
  status: "rolling-out",
  computedLane: 1,
  lane: 1,
  createdMin: 600,
  updatedMin: 12,
  merged: true,
  flagKey: "chg_lt4v9.lane-tags",
  rolloutState: {
    status: "watching",
    versionId: "v-3e6a4d0",
    previousVersionId: "v-2b9c1f7",
    stages: [
      { percent: 5, startedAt: ago(32), completedAt: ago(22) },
      { percent: 25, startedAt: ago(22), completedAt: ago(12) },
      { percent: 100, startedAt: ago(12), completedAt: ago(12) },
    ],
    watchUntil: ahead(18),
    flagKey: "chg_lt4v9.lane-tags",
    lastCheck: {
      at: ago(0.4),
      errorRate: 0.0009,
      baselineErrorRate: 0.0011,
      requests: 52_910,
      newIssueGroups: 0,
    },
  },
  reasons: [
    reason("coverage.changed-lines", 1, "72% of changed lines covered (policy: 80%).", "coverage"),
  ],
  files: [
    file("src/components/ChangeRow.tsx", "modified", [
      hunk(
        14,
        14,
        `
   <li class="change-row">
+    <LaneTag lane={change.lane} />
     <a href={href}>{change.title}</a>`,
      ),
    ]),
  ],
  tour: {
    stops: [
      stop(
        "intent",
        "proven",
        "Lane tags beside each change",
        "Matches the dashboard plan.",
        [],
        [],
      ),
    ],
    leastConfident: [
      "Color-only lane encoding on the old list style; the tag includes the numeral.",
    ],
    notDone: ["No filter by lane yet."],
  },
  items: [
    testRun("chg_lt4v9", 120),
    coverage(7, 5, [
      { path: "src/components/ChangeRow.tsx", changed: 7, covered: 5, uncoveredLines: [19, 20] },
    ]),
    apiNone(),
    depsNone(),
    sensitive([]),
  ],
});

const darkMode = scenario({
  id: "chg_dk6m2",
  repoId: DASH,
  planId: "plan_dash_theme",
  title: "Follow the system dark-mode setting",
  category: "feature",
  authorId: "prn_coder12",
  status: "awaiting-review",
  computedLane: 0,
  lane: 1,
  createdMin: 85,
  updatedMin: 44,
  reasons: [
    reason(
      "proof.red-green",
      0,
      "1 new test fails on main and passes on this change.",
      "red-green",
    ),
    reason("size.small", 0, "18 changed lines in 2 files."),
    reason(
      "shadow.lane0-disabled",
      1,
      "Lane 0 is in shadow mode for this repo, so the change is routed to Lane 1.",
    ),
  ],
  files: [
    file("src/styles/theme.css", "modified", [
      hunk(
        1,
        1,
        `
+@media (prefers-color-scheme: dark) {
+  :root { --bg: oklch(18% 0.02 258); --fg: oklch(94% 0.01 250); }
+}`,
      ),
    ]),
  ],
  tour: {
    stops: [
      stop(
        "intent",
        "proven",
        "The dashboard follows the OS theme",
        "Adds a dark palette under prefers-color-scheme.",
        [{ file: "src/styles/theme.css", startLine: 1, endLine: 3 }],
        ["red-green"],
      ),
    ],
    leastConfident: ["Chart colors were not checked for contrast on the dark ground."],
    notDone: ["No manual theme override."],
  },
  items: [
    redGreen(
      "chg_dk6m2",
      [{ file: "test/theme.test.ts", name: "uses the dark palette when the OS prefers dark" }],
      "proven",
    ),
    testRun("chg_dk6m2", 121),
    apiNone(),
    depsNone(),
    sensitive([]),
  ],
});

// ================================================================ acme/widgets (GitHub mode, shadow)

const ghTotal = scenario({
  id: "gh-31337-7",
  repoId: "gh-31337",
  planId: null,
  title: "fix: total() drops the last cent",
  category: "fix",
  summary: "Fixes the rounding in total().",
  authorId: "prn_coder12",
  status: "awaiting-review",
  computedLane: 1,
  lane: 1,
  createdMin: 14,
  updatedMin: 12,
  agentTrace: false,
  host: {
    kind: "github",
    number: 7,
    headBranch: "gittifacts/pr/7",
    fork: false,
    headRepo: "acme/widgets",
    baseRef: "main",
    author: { login: "octo-dev", id: 5150, kind: "human" },
    url: "https://github.com/acme/widgets/pull/7",
  },
  reasons: [
    reason(
      "proof.red-green",
      0,
      "1 new test fails on main and passes on this change.",
      "red-green",
    ),
    reason("plan.missing", 1, "No approved Plan is linked, so Lane 0 is not available."),
  ],
  files: [
    file("src/total.ts", "modified", [
      hunk(
        1,
        1,
        `
-export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
+export const total = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0));`,
      ),
    ]),
  ],
  tour: {
    stops: [
      stop(
        "intent",
        "proven",
        "total() rounds the sum once",
        "The sum is rounded at the end, not per item.",
        [{ file: "src/total.ts", startLine: 1, endLine: 1 }],
        ["red-green"],
      ),
    ],
    leastConfident: ["Negative totals were not covered by the new test."],
    notDone: ["No change to the currency formatting."],
  },
  items: [
    redGreen("gh-31337-7", [{ file: "test/total.test.ts", name: "keeps the last cent" }], "proven"),
    testRun("gh-31337-7", 34),
    apiNone(),
    depsNone(),
    sensitive([]),
  ],
});

export const SCENARIOS: Scenario[] = [
  tz,
  locale,
  paginate,
  breaking,
  pdf,
  session,
  codemod,
  policy,
  drift,
  fx,
  ledger,
  ledgerRevert,
  numbering,
  wrangler,
  undici,
  cors,
  laneTags,
  darkMode,
  ghTotal,
  ...TRAIN_SCENARIOS,
  ...RESOLUTION_SCENARIOS,
  ...MISSION_SCENARIOS,
  ...ATTEMPT_SCENARIOS,
];
