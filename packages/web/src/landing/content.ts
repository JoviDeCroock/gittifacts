/**
 * Landing page content that is data rather than prose: the example change (demo data, labeled
 * on the page), live measurements (STATUS.md, "Live, verified on the deployed platform") and
 * the agent calls (quoted from the /start guide in @app/conventions).
 */

/** The deployed origin, used in the static HTML; the Worker rewrites it to the request origin. */
export const DEFAULT_ORIGIN = "https://gittifacts.decroockjovi.workers.dev";
/** The CLI tarball the platform serves (not on npm yet): `npx -y <origin>/cli/gittifacts.tgz`. */
export const CLI_PATH = "/cli/gittifacts.tgz";

/**
 * A URL split where a line may break: after "//" and each "." of the host, and before each "/"
 * of the path. Rendered with <wbr> between parts so long hosts never break mid-word on phones.
 */
export function urlParts(url: string): string[] {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(.*)$/i.exec(url);
  if (!m) return [url];
  const [, scheme = "", host = "", path = ""] = m;
  return [scheme, ...host.split(/(?<=\.)/), ...path.split(/(?=\/)/)].filter(Boolean);
}

/** Measured on the live platform (2026-10-02). Never round these up. */
export const MEASURED = {
  firstGreen: "36 to 48 seconds",
  pushToEvidence: "~50 s",
  tourCost: "~$0.015",
} as const;

export type Mark = "proven" | "lane1";

export interface EvidenceRow {
  label: string;
  value: string;
  /** `lane1`: the signal that keeps the Lane 1 strip attached. */
  mark: Mark;
}

/** One change carried through the whole page (hero tag, then every loop station). */
export const EXAMPLE = {
  repo: "billing-api",
  id: "chg_fx2r7",
  title: "Cache FX rates for 60 seconds when totalling invoices",
  agent: "fleet-coder-07",
  owner: "Maya Okafor",
  approver: "Dev Patel",
  head: "19c18b6",
  rows: [
    { label: "Intent", value: "Plan approved by Dev Patel", mark: "proven" },
    { label: "Tests", value: "418 passed, none failing", mark: "proven" },
    { label: "Coverage", value: "91% of changed lines", mark: "proven" },
    { label: "Public API", value: "No change", mark: "proven" },
    { label: "Dependencies", value: "None added or bumped", mark: "proven" },
    { label: "Sensitive paths", value: "None touched", mark: "proven" },
    { label: "Model check", value: "Rates may be up to 60 s old", mark: "lane1" },
  ] satisfies EvidenceRow[],
} as const;

/** What changes and what stays when a team moves from pull requests to changes. */
export const SHIFTS: { before: string; after: string; detail: string }[] = [
  {
    before: "Pull request",
    after: "Change",
    detail: "Intent, diff and evidence travel together as one unit.",
  },
  {
    before: "Review the diff",
    after: "Approve the intent",
    detail: "A person signs off on the plan before the work starts.",
  },
  {
    before: "CI badge",
    after: "Signed evidence",
    detail: "Red/green proof, coverage, mutation score, API and dependency diffs, signed.",
  },
  {
    before: "Merge button",
    after: "Risk lane and merge queue",
    detail: "Evidence decides who looks; the queue keeps main green.",
  },
  {
    before: "Deploy, then revert by hand",
    after: "Flag, gradual rollout, automatic revert",
    detail: "Every change ships behind its own switch.",
  },
];

/** What a team keeps when it moves over. */
export const STAYS: { what: string; how: string; detail: string }[] = [
  {
    what: "git",
    how: "Same commands, new remote",
    detail: "Clone, branch, commit and push the way you do today.",
  },
  {
    what: "Your history",
    how: "Comes with you",
    detail: "Importing a repository brings its full history.",
  },
  {
    what: "Your tools",
    how: "Keep working",
    detail: "Editors, scripts and any git client; agents add MCP and a CLI on top.",
  },
];

/** The three calls from /start (conventions/src/start.ts). */
export const SHIP_CALLS = [
  `create_project({ template: "workers-api", name: "my-api" })`,
  `wait_for_change({ changeId, until: "evidence_ready" })`,
  `get_change_status({ changeId })`,
] as const;

/** A real error envelope: an agent trying to approve a plan (apps/platform/src/services/plans.ts). */
export const ERROR_EXAMPLE = `{
  "error": {
    "code": "forbidden",
    "message": "only a human may approve or reject a plan",
    "fix": {
      "explanation": "Humans approve intent: agents can draft plans but never approve or reject them. Share the plan id with the human who owns you."
    }
  }
}`;
