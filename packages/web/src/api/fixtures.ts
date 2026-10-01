/**
 * Synthetic demo data for mock mode (VITE_MOCK=1 or ?mock). Nothing here is real: people,
 * repositories, metrics and hashes are invented. Times are relative to page load.
 */
import { RepoPolicy } from "@app/domain";
import { NOW, PLATFORM_KEY_ID, ago, ahead, b64u, sha } from "./fixture-kit.js";
import type { Scenario } from "./scenario-kit.js";
import { SCENARIOS } from "./scenarios.js";
import type { AuditEvent, Plan, Principal, PrincipalRef, Repo, SessionUser, ShadowStats } from "./types.js";

// ---------------------------------------------------------------- principals

const ALL_HUMAN_SCOPES: Principal["scopes"] = [
  "repo:read",
  "repo:admin",
  "plan:create",
  "plan:approve",
  "change:create",
  "change:review",
  "policy:admin",
];

function key(seed: string, createdMin: number, revokedMin: number | null = null) {
  return {
    id: `key_${b64u(seed, 8)}`,
    alg: "Ed25519" as const,
    publicKey: b64u(`${seed}:pub`, 43),
    createdAt: ago(createdMin),
    revokedAt: revokedMin === null ? null : ago(revokedMin),
  };
}

export const ME = "prn_maya";

export function principals(): Principal[] {
  return [
    { id: "prn_maya", kind: "human", name: "Maya Okafor", ownerId: null, keys: [key("maya", 90_000)], scopes: ALL_HUMAN_SCOPES },
    { id: "prn_dev", kind: "human", name: "Dev Patel", ownerId: null, keys: [key("dev", 80_000)], scopes: ALL_HUMAN_SCOPES },
    { id: "prn_lena", kind: "human", name: "Lena Brandt", ownerId: null, keys: [key("lena", 70_000)], scopes: ["repo:read", "plan:create", "plan:approve", "change:create", "change:review"] },
    {
      id: "prn_coder07",
      kind: "agent",
      name: "fleet-coder-07",
      ownerId: "prn_maya",
      keys: [key("coder07", 40_000), key("coder07-old", 60_000, 40_000)],
      scopes: ["repo:read", "plan:create", "change:create"],
    },
    { id: "prn_coder12", kind: "agent", name: "fleet-coder-12", ownerId: "prn_dev", keys: [key("coder12", 30_000)], scopes: ["repo:read", "change:create"] },
    { id: "prn_planner", kind: "agent", name: "planner-02", ownerId: "prn_maya", keys: [key("planner", 20_000)], scopes: ["repo:read", "plan:create"] },
    { id: "prn_triage", kind: "agent", name: "issue-triager", ownerId: "prn_maya", keys: [key("triage", 9_000, 2_000)], scopes: ["repo:read"] },
    { id: "prn_reviewer", kind: "system", name: "Reviewer agent", ownerId: null, keys: [], scopes: [] },
    { id: "prn_platform", kind: "system", name: "gittifacts platform", ownerId: null, keys: [], scopes: [] },
  ];
}

export const USER: SessionUser = { id: "usr_maya", email: "maya@acme.dev", name: "Maya Okafor", image: null };

export function principalRef(all: Principal[], id: string): PrincipalRef {
  const p = all.find((x) => x.id === id);
  if (!p) return { id, kind: "system", name: id, ownerId: null, ownerName: null };
  const owner = p.ownerId ? all.find((x) => x.id === p.ownerId) : undefined;
  return { id: p.id, kind: p.kind, name: p.name, ownerId: p.ownerId, ownerName: owner?.name ?? null };
}

// ---------------------------------------------------------------- repos

interface RepoRecord {
  repo: Repo;
  shadow: ShadowStats;
}

function repo(
  id: string,
  name: string,
  opts: {
    jurisdiction: Repo["jurisdiction"];
    lane0: boolean;
    deployTarget: string | null;
    importedFrom?: string;
    createdMin: number;
    unclaimedForMin?: number;
    template?: string;
  },
): Repo {
  return {
    id,
    namespace: "acme",
    artifactsName: `acme-${name}`,
    name,
    defaultBranch: "main",
    jurisdiction: opts.jurisdiction,
    importedFrom: opts.importedFrom ?? null,
    policy: RepoPolicy.parse({ lane0Enabled: opts.lane0, planlessLane0: ["verified-transform", "pure-revert"] }),
    policySha: sha(`${id}:policy`),
    deployTarget: opts.deployTarget,
    claim:
      opts.unclaimedForMin === undefined
        ? { status: "claimed", ownerId: "prn_maya", expiresAt: null }
        : { status: "unclaimed", ownerId: null, expiresAt: ahead(opts.unclaimedForMin) },
    template: opts.template ?? null,
    createdAt: ago(opts.createdMin),
  };
}

export function repos(): RepoRecord[] {
  return [
    {
      repo: repo("repo_billing", "billing-api", { jurisdiction: "eu", lane0: false, deployTarget: "billing-api", createdMin: 120_000 }),
      shadow: { samples: 44, agreed: 41, ratio: 41 / 44, needed: 0, threshold: 0.95, eligibleToEnableLane0: false },
    },
    {
      repo: repo("repo_edge", "edge-router", { jurisdiction: "unrestricted", lane0: true, deployTarget: "edge-router", createdMin: 150_000 }),
      shadow: { samples: 61, agreed: 59, ratio: 59 / 61, needed: 0, threshold: 0.95, eligibleToEnableLane0: true },
    },
    {
      repo: repo("repo_dashboard", "web-dashboard", { jurisdiction: "us", lane0: false, deployTarget: "web-dashboard", createdMin: 60_000 }),
      shadow: { samples: 18, agreed: 18, ratio: null, needed: 7, threshold: 0.95, eligibleToEnableLane0: false },
    },
    {
      repo: repo("repo_ios", "ios-sdk", { jurisdiction: "us", lane0: false, deployTarget: null, importedFrom: "https://github.com/acme/ios-sdk", createdMin: 900 }),
      shadow: { samples: 0, agreed: 0, ratio: null, needed: 25, threshold: 0.95, eligibleToEnableLane0: false },
    },
    {
      repo: repo("repo_widget", "invoice-widget", {
        jurisdiction: "unrestricted",
        lane0: false,
        deployTarget: null,
        createdMin: 300,
        unclaimedForMin: 3 * 24 * 60 - 300,
        template: "workers-hono",
      }),
      shadow: { samples: 0, agreed: 0, ratio: null, needed: 25, threshold: 0.95, eligibleToEnableLane0: false },
    },
  ];
}

// ---------------------------------------------------------------- plans

function plan(p: Omit<Plan, "approvalSignature" | "supersedes" | "approvedAt" | "createdAt"> & { createdMin: number; approvedMin?: number }): Plan {
  const { createdMin, approvedMin, ...rest } = p;
  return {
    ...rest,
    approvedAt: approvedMin === undefined ? null : ago(approvedMin),
    approvalSignature: rest.approvedBy ? b64u(`${rest.id}:approval`, 86) : null,
    supersedes: null,
    createdAt: ago(createdMin),
  };
}

export function plans(): Plan[] {
  return [
    plan({
      id: "plan_dunning",
      repoId: "repo_billing",
      title: "Dunning emails for failed card payments",
      intent:
        "When a card payment fails, customers currently hear nothing until their account is suspended 14 days later. Send a sequence of three dunning emails (day 1, day 4, day 10) with a link to update the card, and stop the sequence as soon as a payment succeeds.",
      acceptanceCriteria: [
        "A failed card payment schedules three emails on day 1, day 4 and day 10 after the failure.",
        "A successful payment, refund or manual write-off cancels every pending dunning email for that invoice.",
        "Each email links to the hosted card-update page with a single-use token that expires in 72 hours.",
        "Emails use the customer's locale, falling back to the account locale, then en-US.",
        "No customer receives more than one dunning email per 24 hours across all their invoices.",
      ],
      outOfScope: [
        "Changing the 14-day suspension rule.",
        "SMS or in-app notifications.",
        "Retrying the charge itself; the payment provider already retries.",
      ],
      riskDeclarations: [
        { area: "Customer communication", description: "A bug could email paying customers about a failure that did not happen. Sends must key off the payment provider's failure event, never off our own status field." },
        { area: "Token security", description: "Card-update links grant access to billing details; tokens must be single use and short lived." },
      ],
      scopePaths: ["src/dunning/**", "src/emails/templates/dunning-*.tsx", "test/dunning/**", "migrations/00*_dunning.sql"],
      affectedRoutes: ["/billing/update-card"],
      status: "draft",
      authorId: "prn_coder12",
      approvedBy: null,
      createdMin: 35,
    }),
    plan({
      id: "plan_refunds",
      repoId: "repo_billing",
      title: "Partial refunds from the admin console",
      intent: "Support can refund part of an invoice from the admin console instead of asking engineering to run a script. Refunds post to the ledger and send a receipt.",
      acceptanceCriteria: [
        "An admin with the refunds role can refund any amount up to the paid total, per line item.",
        "Every refund writes a ledger entry and an audit event with the reason.",
      ],
      outOfScope: ["Refunds to a different payment method."],
      riskDeclarations: [{ area: "Money movement", description: "Refund amounts must be validated server-side against what was actually captured." }],
      scopePaths: ["src/admin/refunds/**", "src/ledger/refunds.ts", "test/admin/refunds/**"],
      affectedRoutes: ["/admin/invoices/:id"],
      status: "draft",
      authorId: "prn_maya",
      approvedBy: null,
      createdMin: 130,
    }),
    plan({
      id: "plan_tz",
      repoId: "repo_billing",
      title: "Invoice time-zone correctness",
      intent:
        "Due dates and statement periods are computed in UTC, so customers far from UTC see dates that are a day off. Compute every customer-facing calendar date in the customer's billing time zone.",
      acceptanceCriteria: [
        "A net-N invoice is due on the local calendar day N days after the local issue day.",
        "Statement periods start and end at local midnight.",
        "Customers without a billing time zone keep today's UTC behavior.",
      ],
      outOfScope: ["Backfilling stored due dates on existing invoices.", "A UI for customers to change their time zone."],
      riskDeclarations: [{ area: "Daylight saving", description: "Day arithmetic must be correct across DST transitions in both hemispheres." }],
      scopePaths: ["src/invoices/**", "src/statements/**", "src/time/**", "test/invoices/**", "test/statements/**", "test/time/**"],
      affectedRoutes: ["/invoices/:id"],
      status: "approved",
      authorId: "prn_planner",
      approvedBy: "prn_dev",
      createdMin: 4_400,
      approvedMin: 4_300,
    }),
    plan({
      id: "plan_receipts",
      repoId: "repo_billing",
      title: "Receipt email reliability",
      intent: "Receipt emails fail for customers created through the partner API. Make receipt rendering tolerate missing optional customer fields.",
      acceptanceCriteria: ["Receipts render for customers with no locale.", "Each fixed failure has a regression test."],
      outOfScope: ["Redesigning receipt templates."],
      riskDeclarations: [],
      scopePaths: ["src/emails/**", "test/emails/**"],
      affectedRoutes: [],
      status: "approved",
      authorId: "prn_dev",
      approvedBy: "prn_maya",
      createdMin: 3_000,
      approvedMin: 2_950,
    }),
    plan({
      id: "plan_sdk3",
      repoId: "repo_billing",
      title: "SDK v3: pagination and the amount field",
      intent: "Ship @acme/billing-sdk 3.0: cursor pagination on list calls, and remove the deprecated total field in favour of amount.",
      acceptanceCriteria: ["listInvoices supports cursor pagination without breaking 2.x callers.", "Invoice.total is removed after the deprecation window.", "The release is a major version."],
      outOfScope: ["Pagination for payments and customers (later steps)."],
      riskDeclarations: [{ area: "Public API", description: "Removing total breaks consumers who did not migrate; it must ship as 3.0." }],
      scopePaths: ["packages/sdk/**", "src/reports/**"],
      affectedRoutes: [],
      status: "approved",
      authorId: "prn_maya",
      approvedBy: "prn_lena",
      createdMin: 9_000,
      approvedMin: 8_800,
    }),
    plan({
      id: "plan_pdf",
      repoId: "repo_billing",
      title: "Invoice PDF export",
      intent: "Customers can download any invoice as a PDF that matches the web view, logo included.",
      acceptanceCriteria: ["PDF output matches the web invoice for line items, totals and logo."],
      outOfScope: ["Bulk export."],
      riskDeclarations: [{ area: "Runtime", description: "The service runs on Workers; any rendering library must run there." }],
      scopePaths: ["src/invoices/**", "test/invoices/**", "package.json", "pnpm-lock.yaml"],
      affectedRoutes: [],
      status: "approved",
      authorId: "prn_planner",
      approvedBy: "prn_maya",
      createdMin: 7_000,
      approvedMin: 6_900,
    }),
    plan({
      id: "plan_session",
      repoId: "repo_billing",
      title: "Session hardening",
      intent: "Reduce the blast radius of a stolen session: shorter lifetime, and no session survives a role change.",
      acceptanceCriteria: ["Sessions expire after 12 hours.", "A role change invalidates every session of that user."],
      outOfScope: ["Mobile refresh tokens."],
      riskDeclarations: [{ area: "Support tooling", description: "Support staff hold long sessions today." }],
      scopePaths: ["src/auth/**", "test/auth/**"],
      affectedRoutes: [],
      status: "approved",
      authorId: "prn_lena",
      approvedBy: "prn_maya",
      createdMin: 5_000,
      approvedMin: 4_900,
    }),
    plan({
      id: "plan_thresholds",
      repoId: "repo_billing",
      title: "Stricter proof thresholds for billing",
      intent: "Two September reverts both passed at a 60% mutation score. Raise billing's thresholds so fewer weakly-proven changes reach Lane 0.",
      acceptanceCriteria: ["Mutation threshold 70%, changed-line coverage 85%."],
      outOfScope: ["Other repositories."],
      riskDeclarations: [],
      scopePaths: [".platform/policy.ts"],
      affectedRoutes: [],
      status: "approved",
      authorId: "prn_dev",
      approvedBy: "prn_lena",
      createdMin: 600,
      approvedMin: 560,
    }),
    plan({
      id: "plan_webhooks",
      repoId: "repo_billing",
      title: "Webhook delivery reliability",
      intent: "Spread webhook retries with jittered backoff and add per-endpoint retry budgets.",
      acceptanceCriteria: ["Retries use full-jitter exponential backoff capped at 60 s.", "Per-endpoint retry budgets."],
      outOfScope: ["Changing the webhook signature scheme."],
      riskDeclarations: [],
      scopePaths: ["src/webhooks/**", "test/webhooks/**"],
      affectedRoutes: [],
      status: "approved",
      authorId: "prn_planner",
      approvedBy: "prn_maya",
      createdMin: 2_000,
      approvedMin: 1_950,
    }),
    plan({
      id: "plan_fx",
      repoId: "repo_billing",
      title: "FX rate caching",
      intent: "Cut FX lookups per invoice total to one per currency per minute.",
      acceptanceCriteria: ["Rates cached for at most 60 seconds."],
      outOfScope: ["Persisted rate history."],
      riskDeclarations: [{ area: "Accuracy", description: "Totals may use a rate up to 60 s old; finance accepted this." }],
      scopePaths: ["src/fx/**", "test/fx/**"],
      affectedRoutes: [],
      status: "approved",
      authorId: "prn_coder07",
      approvedBy: "prn_dev",
      createdMin: 3_200,
      approvedMin: 3_100,
    }),
    plan({
      id: "plan_ledger",
      repoId: "repo_billing",
      title: "Per-tenant ledger batching",
      intent: "Batch ledger writes per tenant to cut D1 write volume.",
      acceptanceCriteria: ["One write per tenant per flush."],
      outOfScope: [],
      riskDeclarations: [],
      scopePaths: ["src/ledger/**", "test/ledger/**"],
      affectedRoutes: [],
      status: "approved",
      authorId: "prn_planner",
      approvedBy: "prn_maya",
      createdMin: 4_000,
      approvedMin: 3_900,
    }),
    plan({
      id: "plan_numbering",
      repoId: "repo_billing",
      title: "Per-tenant invoice numbering",
      intent: "Invoice numbers become gapless per tenant instead of global.",
      acceptanceCriteria: ["Numbers are gapless per tenant."],
      outOfScope: ["Renumbering existing invoices."],
      riskDeclarations: [],
      scopePaths: ["src/invoices/numbering/**", "migrations/**"],
      affectedRoutes: [],
      status: "approved",
      authorId: "prn_maya",
      approvedBy: "prn_lena",
      createdMin: 300,
      approvedMin: 200,
    }),
    plan({
      id: "plan_cors",
      repoId: "repo_edge",
      title: "Edge API access for the new dashboard",
      intent: "Let dashboard.acme.dev call the edge API.",
      acceptanceCriteria: ["CORS allows the new origin in production."],
      outOfScope: [],
      riskDeclarations: [],
      scopePaths: ["src/cors.ts", "test/cors.test.ts"],
      affectedRoutes: [],
      status: "approved",
      authorId: "prn_maya",
      approvedBy: "prn_dev",
      createdMin: 400,
      approvedMin: 380,
    }),
    plan({
      id: "plan_dash_lanes",
      repoId: "repo_dashboard",
      title: "Lane tags in the dashboard",
      intent: "Show each change's lane in the dashboard list.",
      acceptanceCriteria: ["Lane tags carry the numeral, not only a color."],
      outOfScope: [],
      riskDeclarations: [],
      scopePaths: ["src/components/**"],
      affectedRoutes: ["/changes"],
      status: "approved",
      authorId: "prn_maya",
      approvedBy: "prn_lena",
      createdMin: 1_000,
      approvedMin: 900,
    }),
    plan({
      id: "plan_dash_theme",
      repoId: "repo_dashboard",
      title: "Dark mode",
      intent: "Follow the OS dark-mode setting.",
      acceptanceCriteria: ["Dark palette under prefers-color-scheme."],
      outOfScope: ["A manual toggle."],
      riskDeclarations: [],
      scopePaths: ["src/styles/**", "test/**"],
      affectedRoutes: ["/"],
      status: "approved",
      authorId: "prn_dev",
      approvedBy: "prn_maya",
      createdMin: 500,
      approvedMin: 450,
    }),
  ];
}

// ---------------------------------------------------------------- audit (hash-chained)

const GENESIS = "A".repeat(43);

type RawEvent = [minutesAgo: number, principalId: string, action: string, subject: string];

function baseEvents(): RawEvent[] {
  const ev: RawEvent[] = [
    [130_000, "prn_maya", "repo.created", "repo:repo_edge"],
    [120_000, "prn_maya", "repo.created", "repo:repo_billing"],
    [60_000, "prn_maya", "repo.created", "repo:repo_dashboard"],
    [40_000, "prn_maya", "principal.created", "principal:prn_coder07"],
    [30_000, "prn_dev", "principal.created", "principal:prn_coder12"],
    [20_000, "prn_maya", "principal.created", "principal:prn_planner"],
    [9_000, "prn_maya", "principal.created", "principal:prn_triage"],
    [4_400, "prn_planner", "plan.created", "plan:plan_tz"],
    [4_300, "prn_dev", "plan.approved", "plan:plan_tz"],
    [4_000, "prn_planner", "plan.created", "plan:plan_ledger"],
    [3_900, "prn_maya", "plan.approved", "plan:plan_ledger"],
    [3_200, "prn_coder07", "plan.created", "plan:plan_fx"],
    [3_100, "prn_dev", "plan.approved", "plan:plan_fx"],
    [2_950, "prn_maya", "plan.approved", "plan:plan_receipts"],
    [2_900, "prn_coder12", "change.created", "change:chg_lg8b0"],
    [2_000, "prn_maya", "tokens.revoked", "principal:prn_triage"],
    [1_950, "prn_maya", "plan.approved", "plan:plan_webhooks"],
    [1_440, "prn_coder07", "change.created", "change:chg_fx2r7"],
    [900, "prn_coder12", "change.created", "change:chg_un2d6"],
    [880, "prn_platform", "change.classified", "change:chg_un2d6"],
    [870, "prn_platform", "merge.completed", "change:chg_un2d6"],
    [800, "prn_platform", "rollout.released", "change:chg_un2d6"],
    [900, "prn_maya", "repo.imported", "repo:repo_ios"],
    [560, "prn_lena", "plan.approved", "plan:plan_thresholds"],
    [520, "prn_lena", "change.created", "change:chg_ss4h8"],
    [410, "prn_coder12", "change.created", "change:chg_pd2n6"],
    [300, "prn_coder07", "change.created", "change:chg_pg5q1"],
    [260, "prn_coder07", "change.created", "change:chg_br8w4"],
    [245, "prn_maya", "review.approved", "change:chg_lg8b0"],
    [230, "prn_coder12", "change.created", "change:chg_dr1x5"],
    [228, "prn_platform", "merge.completed", "change:chg_lg8b0"],
    [226, "prn_platform", "rollout.stage.started", "change:chg_lg8b0"],
    [216, "prn_platform", "rollout.stage.completed", "change:chg_lg8b0"],
    [216, "prn_platform", "rollout.stage.started", "change:chg_lg8b0"],
    [209, "prn_platform", "rollout.check.failed", "change:chg_lg8b0"],
    [209, "prn_platform", "flag.disabled", "change:chg_lg8b0"],
    [209, "prn_platform", "rollout.rolled-back", "change:chg_lg8b0"],
    [208, "prn_platform", "revert.opened", "change:chg_rv8b1"],
    [206, "prn_platform", "merge.completed", "change:chg_rv8b1"],
    [175, "prn_platform", "rollout.released", "change:chg_rv8b1"],
    [180, "prn_dev", "change.created", "change:chg_pl9c2"],
    [140, "prn_coder07", "change.created", "change:chg_tz7k2"],
    [130, "prn_maya", "plan.created", "plan:plan_refunds"],
    [95, "prn_coder12", "change.created", "change:chg_lc3m9"],
    [64, "prn_reviewer", "tour.generated", "change:chg_pd2n6"],
    [52, "prn_reviewer", "tour.generated", "change:chg_lc3m9"],
    [48, "prn_coder07", "change.created", "change:chg_cm6t3"],
    [41, "prn_platform", "pipeline.failed", "change:chg_wr5p8"],
    [40, "prn_platform", "evidence.signed", "change:chg_tz7k2"],
    [38, "prn_reviewer", "tour.generated", "change:chg_tz7k2"],
    [35, "prn_coder12", "plan.created", "plan:plan_dunning"],
    [34, "prn_dev", "review.approved", "change:chg_lt4v9"],
    [33, "prn_platform", "merge.completed", "change:chg_lt4v9"],
    [32, "prn_platform", "rollout.stage.started", "change:chg_lt4v9"],
    [22, "prn_platform", "rollout.stage.completed", "change:chg_lt4v9"],
    [22, "prn_platform", "rollout.stage.started", "change:chg_lt4v9"],
    [17, "prn_maya", "review.approved", "change:chg_fx2r7"],
    [17, "prn_platform", "merge.completed", "change:chg_fx2r7"],
    [16, "prn_platform", "rollout.stage.started", "change:chg_fx2r7"],
    [15, "prn_platform", "evidence.signed", "change:chg_dr1x5"],
    [12, "prn_platform", "rollout.stage.completed", "change:chg_lt4v9"],
    [12, "prn_platform", "rollout.stage.started", "change:chg_lt4v9"],
    [12, "prn_platform", "rollout.watch.started", "change:chg_lt4v9"],
    [12, "prn_coder07", "change.created", "change:chg_nm3k4"],
    [11, "prn_platform", "rollout.check.passed", "change:chg_fx2r7"],
    [6, "prn_platform", "rollout.stage.completed", "change:chg_fx2r7"],
    [6, "prn_platform", "rollout.stage.started", "change:chg_fx2r7"],
    [1, "prn_platform", "rollout.check.passed", "change:chg_fx2r7"],
    [1, "prn_platform", "rollout.check.passed", "change:chg_lt4v9"],
  ];
  return ev.sort((a, b) => b[0] - a[0]);
}

export function chainEvents(raw: RawEvent[], startSeq = 0, prev = GENESIS): AuditEvent[] {
  let prevHash = prev;
  return raw.map(([min, principalId, action, subject], i) => {
    const seq = startSeq + i;
    const hash = b64u(`${seq}:${action}:${subject}:${prevHash}`, 43);
    const event: AuditEvent = {
      seq,
      at: ago(min),
      principalId,
      action,
      subject,
      payloadHash: b64u(`${seq}:payload`, 43),
      prevHash,
      hash,
      signature: b64u(`${seq}:signature`, 86),
      keyId: PLATFORM_KEY_ID,
    };
    prevHash = hash;
    return event;
  });
}

export function audit(): AuditEvent[] {
  return chainEvents(baseEvents());
}

// ---------------------------------------------------------------- database

export interface MockDb {
  me: string;
  user: SessionUser;
  principals: Principal[];
  repos: RepoRecord[];
  plans: Plan[];
  scenarios: Scenario[];
  audit: AuditEvent[];
}

export function createDb(): MockDb {
  return structuredClone({
    me: ME,
    user: USER,
    principals: principals(),
    repos: repos(),
    plans: plans(),
    scenarios: SCENARIOS,
    audit: audit(),
  });
}

export { NOW, GENESIS };
