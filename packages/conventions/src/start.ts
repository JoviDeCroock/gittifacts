/**
 * `GET /start`: the one front door. An agent told only "use <host>" reads this (markdown, or JSON
 * with `Accept: application/json`) and knows what the platform is, how to authenticate or skip auth,
 * where the MCP server is, and the three calls that ship something.
 */
import { NextStep, WaitUntil } from "@app/domain";
import { z } from "zod";
import { call } from "./calls.js";
import { DEFAULT_TEMPLATE, TEMPLATE_IDS, TEMPLATES, TemplateId } from "./catalog.js";
import { join, normalizeOrigin, pathOf } from "./urls.js";
import { CONVENTIONS_VERSION } from "./version.js";

export const MCP_PROTOCOL_VERSION = "2026-07-28";

export const PLATFORM_SUMMARY =
  "gittifacts is a git platform for coding agents on Cloudflare. " +
  "Humans approve intent (Plans); machines prove conformance (CI evidence: tests, red/green proof, API and dependency diffs); " +
  "every Change is routed to a risk lane: 0 auto-merge, 1 async glance, 2 full review. " +
  "Agents work through MCP (or the HTTP API) and git, and can never approve their own work.";

export interface AuthHints {
  /** `create_project` without credentials returns an unclaimed project and a token (off when the kill switch is on). */
  unclaimedProjects: boolean;
  /** Unclaimed projects are deleted after this many days unless a human claims them. */
  unclaimedTtlDays: number;
  /** MCP OAuth (RFC 9728 discovery from the 401) is available for logged-in users. */
  oauth: boolean;
  /** CLI device flow, e.g. `npx gittifacts login`. Omit when not available. */
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
    }),
  })
  .strict();
export type StartDoc = z.infer<typeof StartDoc>;

const CH = "<changeId>";

export const RULES = [
  "Never push to main: only the merge queue writes the default branch. Push to your Change's fork remote.",
  "Agents never approve a Plan or a Change, including their own. Ask a human with request_review.",
  "A Change claiming a fix needs a test that fails on the base commit and passes on its head (red/green).",
  "Wait, don't poll: wait_for_change long-polls until a milestone.",
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
        "{ projectId, remote, token, mcpUrl, previewUrl, claimUrl?, nextSteps }. Use token as the Bearer token from now on; nextSteps[0] names the first Change.",
    },
    {
      step: 2,
      title: "Wait for the first green",
      why: "create_project already committed the template and started CI and the preview; the changeId is in nextSteps[0]. Later edits go start_change, git push to the fork, then this same wait (see the loop below).",
      call: call("wait_for_change", { changeId: CH, until: "evidence_ready", timeoutSec: 120 }),
      returns: '{ change, reached, reason }. reason "timeout": call again.',
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
      title: "Wait for the lane",
      call: call("wait_for_change", { changeId: CH, until: "lane_assigned", timeoutSec: 300 }),
    },
    { title: "Ask a human to review (Lane 1/2)", call: call("request_review", { changeId: CH }) },
    {
      title: "Wait until merged",
      call: call("wait_for_change", { changeId: CH, until: "merged", timeoutSec: 600 }),
    },
  ];

  const limits = [
    "previews only, on a separate clearly marked domain",
    "no secrets, no custom domains, no production deploys",
    "Lane 0 (auto-merge) is off",
    "tight CI-minute, storage and request quotas (see capabilities)",
    "sandbox egress limited to package registries",
  ];

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
        how: a.unclaimedProjects
          ? "Call create_project with no credentials. You get an unclaimed project, a short-lived token for it, and a claimUrl to give to a human."
          : "Disabled right now. Authenticate with OAuth or an agent token.",
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
          `  Unclaimed projects expire after ${a.anonymous.ttlDays} days unless claimed. Limits: ${a.anonymous.limits.join("; ")}.`,
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
    `- [llms.txt](${doc.links.llmsTxt}) · [OpenAPI](${doc.links.openapi}) · [MCP server card](${doc.mcp.serverCard})`,
    ...(doc.auth.oauth.available ? [`- OAuth discovery: ${doc.auth.oauth.resourceMetadata}`] : []),
    "- Each repo's AGENTS.md has the full conventions: lanes, red/green proof, tours.",
    "",
  );
  return lines.join("\n");
}
