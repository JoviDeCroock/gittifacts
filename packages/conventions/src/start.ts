/**
 * `GET /start`: the one front door. An agent told only "use <host>" reads this (markdown, or JSON
 * with `Accept: application/json`) and knows what the platform is, how to authenticate or skip auth,
 * where the MCP server is, and the three calls that ship something.
 */
import { NextStep, WaitUntil } from "@app/domain";
import { z } from "zod";
import { call } from "./calls.js";
import { DEFAULT_TEMPLATE, TEMPLATE_IDS, TEMPLATES, TemplateId } from "./catalog.js";
import { CLI_NPM_NOTE, cliAlias, cliCommand, cliTarballUrl } from "./cli.js";
import { ANONYMOUS_RECONNECT_BEFORE } from "./next-steps.js";
import { join, normalizeOrigin, pathOf } from "./urls.js";
import { CONVENTIONS_VERSION } from "./version.js";

export const MCP_PROTOCOL_VERSION = "2026-07-28";

export const PLATFORM_SUMMARY =
  "gittifacts is a git platform for coding agents on Cloudflare. " +
  "Humans approve intent (Plans); machines prove conformance (CI evidence: tests, red/green proof, API and dependency diffs); " +
  "every Change is routed to a risk lane: 0 auto-merge, 1 async glance, 2 full review. " +
  "Agents work through MCP (or the HTTP API) and git, and can never approve their own work.";

/** The numbers behind the unclaimed-project limits (the platform's configured values). */
export interface UnclaimedQuotaHints {
  ttlDays: number;
  ciMinutesPerDay: number;
  ciMinutesPerRun: number;
  storageMb: number;
  artifactsOpsPerDay: number;
  workspaceCpuMinutesPerDay: number;
  requestsPerMinute: number;
  createsPerIpPerHour: number;
}

/**
 * What an unclaimed project can't do, in plain words: concrete numbers when `q` is given, generic
 * wording otherwise. Shared by /start, llms.txt, the claim page and AGENTS.md.
 */
export function unclaimedLimitLines(q?: UnclaimedQuotaHints): string[] {
  const n = (v: number, unit: string) => `${v} ${unit}`;
  return [
    'previews only, on a separate clearly marked domain with an "Unclaimed project — not verified" banner',
    "no secrets, no custom domains, no production deploys",
    "Lane 0 / auto-merge is off (even for verified reverts): a human reviews every Change",
    q === undefined
      ? "tight CI-minute quota per day and per run"
      : `CI: ${n(q.ciMinutesPerDay, "minutes")} per day, at most ${n(q.ciMinutesPerRun, "minutes")} per run`,
    q === undefined ? "tight storage quota" : `storage: ${n(q.storageMb, "MB")}`,
    q === undefined
      ? "tight Artifacts-operation quota (forks, push tokens, imports)"
      : `Artifacts operations (forks, push tokens, imports): ${q.artifactsOpsPerDay} per day`,
    q === undefined
      ? "small daily remote-workspace quota"
      : `remote workspaces: ${n(q.workspaceCpuMinutesPerDay, "vCPU-minutes")} per day`,
    "sandbox, CI and workspace egress limited to package registries; previews have no internet",
    q === undefined
      ? "requests per token are rate limited"
      : `${q.requestsPerMinute} requests per minute per project token`,
    q === undefined
      ? "creation is rate limited per IP, per network and globally"
      : `creation is rate limited per IP (${q.createsPerIpPerHour} per hour), per network and globally`,
    q === undefined
      ? "it expires unless a human claims it"
      : `it expires ${q.ttlDays} days after creation unless a human claims it (everything is deleted)`,
  ];
}

/** What claiming an unclaimed project does, in plain words (the claim page and /start). */
export function claimingLines(): string[] {
  return [
    "You (a logged-in human) become the project's owner.",
    "The agent that created it keeps working on it under your ownership, with the same scopes; it can never approve Plans or Changes.",
    "Quotas rise to the claimed tier, and sandbox egress follows the repo's policy.",
    "The project no longer expires.",
    "Lane 0 (auto-merge) stays off until an owner turns it on once shadow-mode agreement allows it.",
    "The claim is recorded in the audit log.",
  ];
}

export interface AuthHints {
  /** `create_project` without credentials returns an unclaimed project and a token (off when the kill switch is on). */
  unclaimedProjects: boolean;
  /** Unclaimed projects are deleted after this many days unless a human claims them. */
  unclaimedTtlDays: number;
  /** The configured unclaimed quotas, so the limits list carries numbers. */
  unclaimedQuotas?: UnclaimedQuotaHints | undefined;
  /** MCP OAuth (RFC 9728 discovery from the 401) is available for logged-in users. */
  oauth: boolean;
  /** CLI device flow, e.g. `cliCommand(host, "login")`. Omit when not available. */
  deviceFlowCommand?: string | undefined;
}

export interface StartGuideOptions {
  host: string;
  mcpUrl: string;
  openapiUrl: string;
  authHints: AuthHints;
}

export const StartStep = NextStep.extend({
  step: z.number().int().min(1).max(3),
  /** What the call returns that the next step uses. */
  returns: z.string().min(1).max(400),
});
export type StartStep = z.infer<typeof StartStep>;

export const StartDoc = z
  .object({
    kind: z.literal("gittifacts.start"),
    conventionsVersion: z.number().int().positive(),
    platform: z.object({ name: z.literal("gittifacts"), summary: z.string().min(1) }),
    host: z.string().url(),
    mcp: z.object({
      url: z.string().url(),
      transport: z.literal("streamable-http"),
      protocolVersion: z.string(),
      serverCard: z.string().url(),
    }),
    auth: z.object({
      header: z.string(),
      anonymous: z.object({
        available: z.boolean(),
        how: z.string(),
        ttlDays: z.number().int().positive(),
        limits: z.array(z.string()),
      }),
      oauth: z.object({ available: z.boolean(), resourceMetadata: z.string().url() }),
      deviceFlow: z.object({ available: z.boolean(), command: z.string().optional() }),
      agentToken: z.string(),
    }),
    /** The CLI (every MCP tool as a command), served by the platform as an npm tarball. */
    cli: z.object({
      tarball: z.string().url(),
      /** A first command, runnable as is: creates a project and clones it. */
      command: z.string(),
      /** Makes the `gittifacts …` commands the CLI prints runnable. */
      alias: z.string(),
      note: z.string(),
    }),
    ship: z.array(StartStep).length(3),
    /** The loop for every later change. */
    loop: z.array(NextStep).min(1),
    waitUntil: z.array(WaitUntil).min(1),
    templates: z.array(
      z.object({
        id: TemplateId,
        title: z.string(),
        description: z.string(),
        preview: z.boolean(),
      }),
    ),
    rules: z.array(z.string().min(1)).min(1),
    links: z.object({
      start: z.string().url(),
      llmsTxt: z.string().url(),
      openapi: z.string().url(),
      mcp: z.string().url(),
      discovery: z.array(z.string().url()).min(1),
      /** Task-first documentation (HTML, or markdown with Accept: text/markdown). */
      docs: z.string().url(),
      /** Every docs page in one markdown file, for agents. */
      docsFull: z.string().url(),
    }),
  })
  .strict();
export type StartDoc = z.infer<typeof StartDoc>;

const CH = "<changeId>";

/** /start "No account" when unclaimed creation is on. */
export const ANONYMOUS_HOW =
  "Call create_project with NO Authorization header (MCP initialize, tools/list, create_project and whoami work without credentials; so does POST /api/v1/projects). " +
  "You get an unclaimed project, token (a Bearer token limited to that one project, valid until the project expires) and claimUrl: give claimUrl to a human, who logs in to claim it. " +
  ANONYMOUS_RECONNECT_BEFORE;

/** /start "No account" when the kill switch is off. */
export const ANONYMOUS_OFF =
  "Disabled right now (kill switch). Authenticate with MCP OAuth or an agent token from a human.";

export const RULES = [
  "Never push to main: only the merge queue writes the default branch. Push to your Change's fork remote.",
  "Agents never approve a Plan or a Change, including their own. Ask a human with request_review.",
  "A Change claiming a fix needs a test that fails on the base commit and passes on its head (red/green).",
  'Wait, don\'t poll: wait_for_change long-polls until a milestone (up to 50 s per call); call it again while reason is "timeout".',
  "Send an Idempotency-Key on every create/mutate call and reuse it when you retry.",
  "Every error has fix.call or fix.command: run it.",
];

export function startGuide(opts: StartGuideOptions): { markdown: string; json: StartDoc } {
  const host = normalizeOrigin(opts.host);
  const mcp = opts.mcpUrl;
  const prm = join(
    host,
    `/.well-known/oauth-protected-resource${pathOf(mcp) === "/" ? "" : pathOf(mcp)}`,
  );
  const serverCard = `${mcp.replace(/\/+$/, "")}/server-card`;
  const a = opts.authHints;

  const ship: StartStep[] = [
    {
      step: 1,
      title: "Create a project",
      why: "One call creates the repo from a template, writes .platform/ci.ts, .platform/policy.ts and AGENTS.md, runs the first CI and starts a preview. It returns at once.",
      call: call("create_project", { template: DEFAULT_TEMPLATE, name: "my-api" }),
      returns:
        "{ projectId, remote, token, mcpUrl, previewUrl, claimUrl?, nextSteps }. remote is a push grant (url, token, branch) for your first Change's fork: push there right away. token is set only for unclaimed projects: use it as the Bearer token from then on. bootstrapChangeId is the Change running the first CI and preview.",
    },
    {
      step: 2,
      title: "Wait for the first green",
      why: "create_project already committed the template and started CI and the preview; the changeId is its bootstrapChangeId. Later edits go start_change, git push to the fork, then this same wait (see the loop below).",
      call: call("wait_for_change", { changeId: CH, until: "evidence_ready", timeoutSec: 50 }),
      returns:
        '{ change, reached, reason, retryAfterSec? } within 50 s (under the MCP client\'s 60 s request timeout). reached: the milestone holds now (bootstrap: CI done, status released or failing). reason "timeout": call it again (after retryAfterSec when set) while reason is "timeout".',
    },
    {
      step: 3,
      title: "Read the result and open the preview",
      why: "Shows CI steps, the lane and its reasons, and the live preview URL.",
      call: call("get_change_status", { changeId: CH }),
      returns: "{ change, runs, classification, previewUrl }. Open previewUrl to see it live.",
    },
  ];

  const loop: NextStep[] = [
    {
      title: "Draft a Plan (a human approves it)",
      call: call("create_plan", {
        repoId: "<projectId>",
        title: "<what>",
        intent: "<why>",
        acceptanceCriteria: ["<observable result>"],
        scopePaths: ["src/**", "test/**"],
      }),
    },
    {
      title: "Open a Change; it returns a fork remote",
      call: call("start_change", {
        repoId: "<projectId>",
        planId: "<planId>",
        title: "<what>",
        category: "feature",
      }),
    },
    {
      title: "Push to the fork",
      command:
        'git -c http.extraHeader="Authorization: Bearer <remote.token>" push <remote.url> HEAD:<remote.branch>',
    },
    {
      title: 'Wait for the lane (call again while reason is "timeout")',
      call: call("wait_for_change", { changeId: CH, until: "lane_assigned", timeoutSec: 50 }),
    },
    { title: "Ask a human to review (Lane 1/2)", call: call("request_review", { changeId: CH }) },
    {
      title: 'Wait until merged (call again while reason is "timeout")',
      call: call("wait_for_change", { changeId: CH, until: "merged", timeoutSec: 50 }),
    },
  ];

  const limits = unclaimedLimitLines(
    a.unclaimedQuotas === undefined
      ? undefined
      : { ...a.unclaimedQuotas, ttlDays: a.unclaimedTtlDays },
  );

  const json: StartDoc = {
    kind: "gittifacts.start",
    conventionsVersion: CONVENTIONS_VERSION,
    platform: { name: "gittifacts", summary: PLATFORM_SUMMARY },
    host,
    mcp: {
      url: mcp,
      transport: "streamable-http",
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverCard,
    },
    auth: {
      header: "Authorization: Bearer <token>",
      anonymous: {
        available: a.unclaimedProjects,
        how: a.unclaimedProjects ? ANONYMOUS_HOW : ANONYMOUS_OFF,
        ttlDays: a.unclaimedTtlDays,
        limits,
      },
      oauth: { available: a.oauth, resourceMetadata: prm },
      deviceFlow:
        a.deviceFlowCommand === undefined
          ? { available: false }
          : { available: true, command: a.deviceFlowCommand },
      agentToken: `A human creates one for you (POST ${host}/api/v1/principals/agents) with the scopes they choose.`,
    },
    cli: {
      tarball: cliTarballUrl(host),
      command: cliCommand(host, `init --template ${DEFAULT_TEMPLATE} --name my-api --clone`),
      alias: cliAlias(host),
      note: `Node 22 or later. ${CLI_NPM_NOTE}`,
    },
    ship,
    loop,
    waitUntil: [...WaitUntil.options],
    templates: TEMPLATE_IDS.map((id) => ({
      id,
      title: TEMPLATES[id].manifest.title,
      description: TEMPLATES[id].manifest.description,
      preview: TEMPLATES[id].manifest.previewCommand !== null,
    })),
    rules: RULES,
    links: {
      start: join(host, "/start"),
      llmsTxt: join(host, "/llms.txt"),
      openapi: opts.openapiUrl,
      mcp,
      discovery: [
        ...(a.oauth ? [prm] : []),
        serverCard,
        join(host, "/.well-known/ai-catalog.json"),
      ],
      docs: join(host, "/docs"),
      docsFull: join(host, "/docs/llms-full.txt"),
    },
  };
  return { markdown: renderStartMarkdown(StartDoc.parse(json)), json };
}

function step(s: NextStep): string[] {
  const out: string[] = [];
  if (s.call !== undefined) out.push(`   \`${s.call}\``);
  if (s.command !== undefined) out.push(`   \`${s.command}\``);
  return out;
}

export function renderStartMarkdown(doc: StartDoc): string {
  const a = doc.auth;
  const lines = [
    "# gittifacts: start here",
    "",
    `> ${doc.platform.summary}`,
    "",
    `- MCP server: ${doc.mcp.url} (streamable HTTP, MCP ${doc.mcp.protocolVersion})`,
    `- HTTP API: ${doc.links.openapi} · Index: ${doc.links.llmsTxt}`,
    "- This page as JSON: send `Accept: application/json`.",
    "",
    "## Authenticate (or don't)",
    `- **No account:** ${a.anonymous.how}`,
    ...(a.anonymous.available
      ? [
          `  Unclaimed projects expire after ${a.anonymous.ttlDays} days unless a human claims them. Until then:`,
          ...a.anonymous.limits.map((l) => `  - ${l}`),
        ]
      : []),
    `- **Logged-in human:** ${a.oauth.available ? `MCP OAuth. Connect to ${doc.mcp.url}; the 401 points to ${a.oauth.resourceMetadata}.` : "MCP OAuth is not available yet; use an agent token."}`,
    ...(a.deviceFlow.available && a.deviceFlow.command !== undefined
      ? [`- **CLI:** \`${a.deviceFlow.command}\` (OAuth device flow).`]
      : []),
    `- **Agent token:** ${a.agentToken}`,
    `- Send \`${a.header}\` on every MCP and API call.`,
    "",
    "## Ship something in 3 calls",
  ];
  for (const s of doc.ship) {
    lines.push(
      `${s.step}. **${s.title}.** ${s.why ?? ""}`.trimEnd(),
      ...step(s),
      `   Returns ${s.returns}`,
    );
  }
  lines.push(
    "",
    "## Or from a shell: the CLI",
    `Every MCP tool is a command; output is JSON. ${doc.cli.note}`,
    `   \`${doc.cli.command}\``,
    `   Then \`${doc.cli.alias}\` makes the \`gittifacts …\` commands it prints runnable.`,
  );
  lines.push("", "## Then, for every change");
  doc.loop.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.title}:`, ...step(s));
  });
  lines.push(
    "",
    `\`wait_for_change\` \`until\`: ${doc.waitUntil.map((w) => `\`${w}\``).join(", ")}.`,
    "",
    "## Rules",
    ...doc.rules.map((r) => `- ${r}`),
    "",
    "## Templates",
    ...doc.templates.map(
      (t) => `- \`${t.id}\`: ${t.description}${t.preview ? "" : " (no preview)"}`,
    ),
    "",
    "## More",
    `- Docs: ${doc.links.docs} (guides and generated references; every page as markdown at ${doc.links.docsFull})`,
    `- [llms.txt](${doc.links.llmsTxt}) · [OpenAPI](${doc.links.openapi}) · [MCP server card](${doc.mcp.serverCard})`,
    ...(doc.auth.oauth.available ? [`- OAuth discovery: ${doc.auth.oauth.resourceMetadata}`] : []),
    "- Each repo's AGENTS.md has the full conventions: lanes, red/green proof, tours.",
    "",
  );
  return lines.join("\n");
}
