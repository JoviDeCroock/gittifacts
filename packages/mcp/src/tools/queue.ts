/**
 * The merge-queue tools (docs/prompts/03-merge-queue.md §5) and `search_tools` (onboarding §5:
 * discovery once there are more than 15 tools).
 *
 * - `enqueue` records options (priority, stack, plan group, land mode) and says where the Change
 *   stands. It never bypasses review: the Change joins when it is approved (or auto-merges).
 * - `queue_status`, `wait_for_merge` (long-poll ≤ 55 s), `dequeue`, `reprioritize` (incident
 *   needs a human or an approved incident Plan), `queue_overview`.
 * - Ejections carry `ejectReason.fix.call` (e.g. `open_workspace({ changeId })`) and the
 *   upstream Change behind a conflict.
 */
import { defineTool } from "mcp-tada-server";
import { z } from "zod";
import type { McpBackend, McpCaller, MutationOptions } from "../backend.js";
import { buildTools } from "../tools.js";
import type { ToolKit } from "./workspace.js";

// ---------------------------------------------------------------- backend contract

export interface QueueEjectReason {
  code: string;
  message: string;
  fix: { explanation: string; call?: string | undefined; command?: string | undefined };
  evidenceRefs: string[];
  failingTests: string[];
  upstream: string[];
}

/** One Change in the queue (the coordinator's QueueEntryView). */
export interface QueueEntry {
  changeId: string;
  title: string | null;
  authorId: string;
  priority: string;
  lane: number;
  state: string;
  hold: string | null;
  trackId: string | null;
  batch: { id: string; state: string; size: number; chainPosition: number } | null;
  position: number | null;
  etaSeconds: number | null;
  blocking: string[];
  reason: string;
  predictedPassProbability: number | null;
  frozen: boolean;
  enqueuedAt: number;
  dependsOn: string[];
  plangroup: string | null;
  ejectReason: QueueEjectReason | null;
  mergedSha: string | null;
}

export interface EnqueueView {
  changeId: string;
  admitted: boolean;
  state: string;
  position: number;
  track: string | null;
  etaSeconds: number;
  predictedPassProbability: number;
  reason: string;
}

export interface QueueOverview {
  repoId: string;
  mainSha: string;
  frozen: boolean;
  freezeReasons: { kind: string; at: number; message: string; changeId: string | null }[];
  halted: { code: string; message: string; at: number } | null;
  tracks: {
    id: string;
    express: boolean;
    batches: { id: string; state: string; kind: string; entries: string[] }[];
  }[];
  landing: { id: string; state: string; members: string[] }[];
  entries: QueueEntry[];
  waiting: number;
  resolving: number;
  throughputPerHour: number;
  timeInQueueMs: { p50: number | null; p95: number | null };
  ciDurationMs: number;
  quarantined: string[];
  flakeRates: Record<string, number>;
}

export interface QueueToolsBackend {
  enqueue(
    caller: McpCaller,
    input: {
      changeId: string;
      priority?: "normal" | "security" | "incident" | undefined;
      dependsOn?: string[] | undefined;
      plangroup?: string | null | undefined;
      landTogether?: boolean | undefined;
      groupSize?: number | null | undefined;
      landMode?: "atomic" | "incremental" | undefined;
      incidentPlanId?: string | null | undefined;
    },
    opts: MutationOptions,
  ): Promise<EnqueueView>;
  queueStatus(caller: McpCaller, changeId: string): Promise<QueueEntry | null>;
  waitForMerge(
    caller: McpCaller,
    changeId: string,
    timeoutMs: number,
  ): Promise<{ reason: string; status: QueueEntry | null; frozen: boolean }>;
  dequeue(
    caller: McpCaller,
    changeId: string,
    opts: MutationOptions,
  ): Promise<{ status: QueueEntry | null; removed: boolean }>;
  reprioritize(
    caller: McpCaller,
    input: {
      changeId: string;
      priority: "normal" | "security" | "incident";
      incidentPlanId?: string | null | undefined;
    },
    opts: MutationOptions,
  ): Promise<{ status: QueueEntry | null }>;
  queueOverview(caller: McpCaller, repoId: string): Promise<QueueOverview>;
}

// ---------------------------------------------------------------- JSON Schemas

const str = { type: "string" } as const;
const nstr = { type: ["string", "null"] } as const;
const num = { type: "number" } as const;
const nnum = { type: ["number", "null"] } as const;
const bool = { type: "boolean" } as const;
const strs = { type: "array", items: str } as const;
const changeId = { type: "string", minLength: 1, maxLength: 64 } as const;
const idempotencyKey = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  description:
    "Optional. Retrying with the same key returns the first result instead of acting twice.",
} as const;

const NextSteps = {
  type: "array",
  description: "What to do next, as concrete tool calls (call) or shell commands (command).",
  items: {
    type: "object",
    properties: { title: str, call: str, command: str, why: str },
    required: ["title"],
  },
} as const;

const EjectReasonSchema = {
  type: ["object", "null"],
  description: "Why it left the queue and exactly what to do next (fix.call).",
  properties: {
    code: str,
    message: str,
    fix: {
      type: "object",
      properties: { explanation: str, call: str, command: str },
      required: ["explanation"],
    },
    evidenceRefs: strs,
    failingTests: strs,
    upstream: {
      ...strs,
      description: "Upstream Changes involved (the culprit of a conflict first).",
    },
  },
  required: ["code", "message", "fix", "evidenceRefs", "failingTests", "upstream"],
} as const;

const ENTRY_REQUIRED = [
  "changeId",
  "title",
  "authorId",
  "priority",
  "lane",
  "state",
  "hold",
  "trackId",
  "batch",
  "position",
  "etaSeconds",
  "blocking",
  "reason",
  "predictedPassProbability",
  "frozen",
  "enqueuedAt",
  "dependsOn",
  "plangroup",
  "ejectReason",
  "mergedSha",
] as const;

const EntryProperties = {
  changeId: str,
  title: nstr,
  authorId: str,
  priority: { type: "string", description: "revert | incident | security | normal" },
  lane: num,
  state: {
    type: "string",
    description: "waiting | speculating | resolving | passed | merged | ejected | dequeued",
  },
  hold: { type: ["string", "null"], description: "affected | dependency | group | approval" },
  trackId: nstr,
  batch: {
    type: ["object", "null"],
    properties: { id: str, state: str, size: num, chainPosition: num },
    required: ["id", "state", "size", "chainPosition"],
  },
  position: { type: ["number", "null"], description: "Among waiting entries (0 = next)." },
  etaSeconds: nnum,
  blocking: { ...strs, description: "Changes this one waits behind or on." },
  reason: { type: "string", description: "Why it waits, in words." },
  predictedPassProbability: nnum,
  frozen: bool,
  enqueuedAt: { type: "number", description: "Epoch milliseconds." },
  dependsOn: strs,
  plangroup: nstr,
  ejectReason: EjectReasonSchema,
  mergedSha: nstr,
} as const;

const EntrySchema = {
  type: "object",
  properties: EntryProperties,
  required: ENTRY_REQUIRED,
} as const;
const NullableEntry = {
  type: ["object", "null"],
  properties: EntryProperties,
  required: ENTRY_REQUIRED,
} as const;

export const EnqueueInput = {
  type: "object",
  properties: {
    changeId,
    priority: {
      enum: ["normal", "security", "incident"],
      description: "Default normal (ranked by lane). incident needs a human or incidentPlanId.",
    },
    dependsOn: {
      type: "array",
      items: changeId,
      maxItems: 50,
      description: "Changes this one is stacked on (they land first).",
    },
    plangroup: { type: ["string", "null"], minLength: 1, maxLength: 64 },
    landTogether: {
      type: "boolean",
      description: "Plan-group members merge in one CAS or not at all.",
    },
    groupSize: { type: ["integer", "null"], minimum: 1, maximum: 100 },
    landMode: {
      enum: ["atomic", "incremental"],
      description: "A stack lands as one unit or one by one.",
    },
    incidentPlanId: { type: ["string", "null"], minLength: 1, maxLength: 64 },
    idempotencyKey,
  },
  required: ["changeId"],
  additionalProperties: false,
} as const;

export const EnqueueOutput = {
  type: "object",
  properties: {
    changeId: str,
    admitted: {
      type: "boolean",
      description: "In the queue now; false = registered, joins on approval.",
    },
    state: str,
    position: num,
    track: nstr,
    etaSeconds: num,
    predictedPassProbability: num,
    reason: str,
    nextSteps: NextSteps,
  },
  required: [
    "changeId",
    "admitted",
    "state",
    "position",
    "track",
    "etaSeconds",
    "predictedPassProbability",
    "reason",
    "nextSteps",
  ],
} as const;

export const ChangeOnlyInput = {
  type: "object",
  properties: { changeId },
  required: ["changeId"],
  additionalProperties: false,
} as const;

export const QueueStatusOutput = {
  type: "object",
  properties: { queued: bool, status: NullableEntry, nextSteps: NextSteps },
  required: ["queued", "status", "nextSteps"],
} as const;

export const WaitForMergeInput = {
  type: "object",
  properties: {
    changeId,
    timeoutSec: {
      type: "integer",
      minimum: 1,
      maximum: 55,
      description:
        'Default 50 (your MCP client times out at 60 s). Call again while reason is "timeout".',
    },
  },
  required: ["changeId"],
  additionalProperties: false,
} as const;

export const WaitForMergeOutput = {
  type: "object",
  properties: {
    reason: { enum: ["merged", "ejected", "dequeued", "frozen", "timeout", "not-queued"] },
    frozen: bool,
    status: NullableEntry,
    nextSteps: NextSteps,
  },
  required: ["reason", "frozen", "status", "nextSteps"],
} as const;

export const DequeueInput = {
  type: "object",
  properties: { changeId, idempotencyKey },
  required: ["changeId"],
  additionalProperties: false,
} as const;

export const DequeueOutput = {
  type: "object",
  properties: { removed: bool, status: NullableEntry },
  required: ["removed", "status"],
} as const;

export const ReprioritizeInput = {
  type: "object",
  properties: {
    changeId,
    priority: { enum: ["normal", "security", "incident"] },
    incidentPlanId: {
      type: ["string", "null"],
      minLength: 1,
      maxLength: 64,
      description:
        "An approved incident Plan (required for the incident class unless you are human).",
    },
    idempotencyKey,
  },
  required: ["changeId", "priority"],
  additionalProperties: false,
} as const;

export const ReprioritizeOutput = {
  type: "object",
  properties: { status: NullableEntry },
  required: ["status"],
} as const;

export const QueueOverviewInput = {
  type: "object",
  properties: { repoId: { type: "string", minLength: 1, maxLength: 64 } },
  required: ["repoId"],
  additionalProperties: false,
} as const;

export const QueueOverviewOutput = {
  type: "object",
  properties: {
    repoId: str,
    mainSha: str,
    frozen: bool,
    freezeReasons: {
      type: "array",
      items: {
        type: "object",
        properties: { kind: str, at: num, message: str, changeId: nstr },
        required: ["kind", "at", "message", "changeId"],
      },
    },
    halted: {
      type: ["object", "null"],
      description: "The queue stopped on an invariant violation (an operator must resume it).",
      properties: { code: str, message: str, at: num },
      required: ["code", "message", "at"],
    },
    tracks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: str,
          express: bool,
          batches: {
            type: "array",
            items: {
              type: "object",
              properties: { id: str, state: str, kind: str, entries: strs },
              required: ["id", "state", "kind", "entries"],
            },
          },
        },
        required: ["id", "express", "batches"],
      },
    },
    landing: {
      type: "array",
      items: {
        type: "object",
        properties: { id: str, state: str, members: strs },
        required: ["id", "state", "members"],
      },
    },
    entries: { type: "array", items: EntrySchema },
    waiting: num,
    resolving: num,
    throughputPerHour: num,
    timeInQueueMs: {
      type: "object",
      properties: { p50: nnum, p95: nnum },
      required: ["p50", "p95"],
    },
    ciDurationMs: num,
    quarantined: strs,
    flakeRates: { type: "object", additionalProperties: num },
  },
  required: [
    "repoId",
    "mainSha",
    "frozen",
    "freezeReasons",
    "halted",
    "tracks",
    "landing",
    "entries",
    "waiting",
    "resolving",
    "throughputPerHour",
    "timeInQueueMs",
    "ciDurationMs",
    "quarantined",
    "flakeRates",
  ],
} as const;

export const SearchToolsInput = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: 'What you want to do, e.g. "merge my change" or "workspace exec".',
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

export const SearchToolsOutput = {
  type: "object",
  properties: {
    tools: {
      type: "array",
      items: {
        type: "object",
        properties: { name: str, description: str, example: str },
        required: ["name", "description", "example"],
      },
    },
  },
  required: ["tools"],
} as const;

// ---------------------------------------------------------------- shaping

const q = (s: string) => JSON.stringify(s);
type NextStep = { title: string; call?: string; why?: string };

function entryOut(e: QueueEntry | null) {
  if (e === null) return null;
  const r = e.ejectReason;
  return {
    ...e,
    ejectReason:
      r === null
        ? null
        : {
            ...r,
            fix: {
              explanation: r.fix.explanation,
              ...(r.fix.call === undefined ? {} : { call: r.fix.call }),
              ...(r.fix.command === undefined ? {} : { command: r.fix.command }),
            },
          },
  };
}

/** What an agent should do next for a Change in the queue. */
export function queueNextSteps(changeId: string, e: QueueEntry | null): NextStep[] {
  if (e === null)
    return [
      {
        title: "Not in the queue: it joins once approved (Lane 0 joins automatically)",
        call: `wait_for_change({ changeId: ${q(changeId)}, until: "merged" })`,
      },
    ];
  switch (e.state) {
    case "merged":
      return [
        {
          title: "Merged: watch production",
          call: `list_issues_for_change({ changeId: ${q(changeId)} })`,
        },
      ];
    case "ejected":
      return [
        {
          title: `Ejected (${e.ejectReason?.code ?? "unknown"}): fix it and enqueue again`,
          ...(e.ejectReason?.fix.call === undefined ? {} : { call: e.ejectReason.fix.call }),
          ...(e.ejectReason === null ? {} : { why: e.ejectReason.fix.explanation }),
        },
      ];
    case "dequeued":
      return [
        {
          title: "Dequeued: enqueue again when ready",
          call: `enqueue({ changeId: ${q(changeId)} })`,
        },
      ];
    default:
      return [
        {
          title:
            e.hold === "approval"
              ? "A human must approve it again (see reason)"
              : "Wait for the merge",
          call: `wait_for_merge({ changeId: ${q(changeId)} })`,
          why: e.reason,
        },
      ];
  }
}

// ---------------------------------------------------------------- search_tools

interface ToolSummary {
  name: string;
  description: string;
  example: string;
}

/** Hand-written examples `search_tools` returns (tested against each tool's input schema). */
export const TOOL_EXAMPLES: Readonly<Record<string, string>> = {
  create_project: 'create_project({ template: "workers-api" })',
  start_change: 'start_change({ repoId: "<repoId>", title: "<what>", category: "fix" })',
  create_plan:
    'create_plan({ repoId: "<repoId>", title: "<title>", intent: "<why>", acceptanceCriteria: ["<done when>"] })',
  wait_for_change: 'wait_for_change({ changeId: "<changeId>", until: "merged" })',
  enqueue: 'enqueue({ changeId: "<changeId>", priority: "normal" })',
  wait_for_merge: 'wait_for_merge({ changeId: "<changeId>" })',
  queue_overview: 'queue_overview({ repoId: "<repoId>" })',
  ws_exec: 'ws_exec({ workspaceId: "<workspaceId>", command: "pnpm test" })',
  search_tools: 'search_tools({ query: "merge my change" })',
};

/**
 * `name({ required: "<required>" })` from a tool's input schema; a required enum gets its first
 * value (a placeholder would not validate).
 */
export function exampleCall(name: string, inputSchema: unknown): string {
  const known = TOOL_EXAMPLES[name];
  if (known !== undefined) return known;
  const schema = inputSchema as {
    required?: readonly string[];
    properties?: Record<string, { enum?: readonly unknown[] }>;
  } | null;
  const required = schema?.required ?? [];
  if (required.length === 0) return `${name}({})`;
  const value = (r: string) => {
    const options = schema?.properties?.[r]?.enum;
    return options !== undefined && options.length > 0 ? JSON.stringify(options[0]) : `"<${r}>"`;
  };
  return `${name}({ ${required.map((r) => `${r}: ${value(r)}`).join(", ")} })`;
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
}

/** Is `needle` a subsequence of `hay` (fuzzy: "wfm" ~ "wait_for_merge")? */
function subsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i++;
  return i === needle.length;
}

/** Fuzzy rank of tools for a query: names first, then descriptions; best 8. */
export function searchTools(query: string, tools: readonly ToolSummary[]): ToolSummary[] {
  const terms = words(query);
  const compact = query.toLowerCase().replace(/[^a-z0-9]/g, "");
  const scored = tools.map((t) => {
    const name = t.name.toLowerCase();
    const desc = words(t.description);
    let score = name === query.trim().toLowerCase() ? 100 : 0;
    for (const w of terms) {
      const segments = name.split("_");
      if (segments.includes(w)) score += 12;
      else if (segments.some((g) => g.startsWith(w))) score += 8;
      // Inside a word ("run" in "rerun_ci") is a weaker hint than a word or its start.
      else if (name.includes(w)) score += 4;
      if (desc.includes(w)) score += 3;
      else if (desc.some((d) => d.startsWith(w) || (w.length > 3 && w.startsWith(d.slice(0, 4)))))
        score += 1;
    }
    if (compact.length > 1 && subsequence(compact, name.replaceAll("_", ""))) score += 4;
    return { t, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (a.t.name < b.t.name ? -1 : 1))
    .slice(0, 8)
    .map((s) => s.t);
}

/** One line: the first sentence of a description. */
function firstSentence(s: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(s);
  return (m?.[1] ?? s).slice(0, 300);
}

// ---------------------------------------------------------------- tools

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

const ChangeArgs = z.object({ changeId: z.string().min(1).max(64) });
const Priority = z.enum(["normal", "security", "incident"]);

export function queueTools(backend: McpBackend, kit: ToolKit) {
  return [
    defineTool({
      name: "enqueue",
      title: "Enqueue a Change for merge",
      description:
        "Joins your Change to the merge queue with options (priority, dependsOn for stacks, plangroup + landTogether, landMode). It never skips review: an unapproved Change is registered and joins once approved (Lane 0 joins automatically). Returns position, track, ETA and the predicted pass probability.",
      inputSchema: EnqueueInput,
      outputSchema: EnqueueOutput,
      annotations: WRITE,
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "change:create");
        const { idempotencyKey, ...rest } = args;
        const v = kit.parse(
          ChangeArgs.extend({
            priority: Priority.optional(),
            dependsOn: z.array(z.string().min(1).max(64)).max(50).optional(),
            plangroup: z.string().min(1).max(64).nullable().optional(),
            landTogether: z.boolean().optional(),
            groupSize: z.number().int().min(1).max(100).nullable().optional(),
            landMode: z.enum(["atomic", "incremental"]).optional(),
            incidentPlanId: z.string().min(1).max(64).nullable().optional(),
          }),
          rest,
        );
        const r = await kit.run(backend, () => backend.enqueue(caller, v, { idempotencyKey }));
        const nextSteps: NextStep[] = r.admitted
          ? [
              {
                title: "Wait for the merge",
                call: `wait_for_merge({ changeId: ${q(r.changeId)} })`,
                why: r.reason,
              },
            ]
          : [
              {
                title: "Registered: it joins the queue once approved",
                call: `wait_for_change({ changeId: ${q(r.changeId)}, until: "merged" })`,
                why: r.reason,
              },
            ];
        return { ...r, nextSteps };
      },
    }),
    defineTool({
      name: "queue_status",
      title: "Where is my Change in the merge queue",
      description:
        'State, track, batch, position, ETA, the Changes it waits on and why (e.g. "waiting on conflicting Change X in track 2"), and for an ejected Change the reason with fix.call.',
      inputSchema: ChangeOnlyInput,
      outputSchema: QueueStatusOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "repo:read");
        const { changeId } = kit.parse(ChangeArgs, args);
        const s = await kit.run(backend, () => backend.queueStatus(caller, changeId));
        return { queued: s !== null, status: entryOut(s), nextSteps: queueNextSteps(changeId, s) };
      },
    }),
    defineTool({
      name: "wait_for_merge",
      title: "Wait for the merge",
      description:
        'Long-polls until the Change merges, is ejected or dequeued, or the queue freezes (timeoutSec ≤ 55). Prefer this to polling; call again while reason is "timeout".',
      inputSchema: WaitForMergeInput,
      outputSchema: WaitForMergeOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "repo:read");
        const v = kit.parse(
          ChangeArgs.extend({ timeoutSec: z.number().int().min(1).max(55).default(50) }),
          args,
        );
        const r = await kit.run(backend, () =>
          backend.waitForMerge(caller, v.changeId, v.timeoutSec * 1000),
        );
        const reason = WaitReason.parse(r.reason);
        const nextSteps: NextStep[] =
          reason === "timeout"
            ? [
                {
                  title: "Still in the queue: call again",
                  call: `wait_for_merge({ changeId: ${q(v.changeId)} })`,
                },
              ]
            : queueNextSteps(v.changeId, r.status);
        return { reason, frozen: r.frozen, status: entryOut(r.status), nextSteps };
      },
    }),
    defineTool({
      name: "dequeue",
      title: "Take a Change out of the merge queue",
      description:
        "Removes your Change from the merge queue (stack dependents leave with it). A Change that is landing right now leaves after its CAS settles.",
      inputSchema: DequeueInput,
      outputSchema: DequeueOutput,
      annotations: WRITE,
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "change:create");
        const { changeId } = kit.parse(ChangeArgs, { changeId: args.changeId });
        const r = await kit.run(backend, () =>
          backend.dequeue(caller, changeId, { idempotencyKey: args.idempotencyKey }),
        );
        return { removed: r.removed, status: entryOut(r.status) };
      },
    }),
    defineTool({
      name: "reprioritize",
      title: "Change a queued Change's priority",
      description:
        "Sets the priority class (normal, security, incident). The incident class needs a human or an approved incident Plan (incidentPlanId); reverts are prioritized automatically.",
      inputSchema: ReprioritizeInput,
      outputSchema: ReprioritizeOutput,
      annotations: WRITE,
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "change:create");
        const { idempotencyKey, ...rest } = args;
        const v = kit.parse(
          ChangeArgs.extend({
            priority: Priority,
            incidentPlanId: z.string().min(1).max(64).nullable().optional(),
          }),
          rest,
        );
        const r = await kit.run(backend, () => backend.reprioritize(caller, v, { idempotencyKey }));
        return { status: entryOut(r.status) };
      },
    }),
    defineTool({
      name: "queue_overview",
      title: "The repo's merge queue",
      description:
        "Tracks (independent parallel queues) with their speculative batches, the landing pipeline, freeze state, throughput, p50/p95 time in queue, quarantined tests and every entry with its reason and ETA.",
      inputSchema: QueueOverviewInput,
      outputSchema: QueueOverviewOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "repo:read");
        const { repoId } = kit.parse(z.object({ repoId: z.string().min(1).max(64) }), args);
        const o = await kit.run(backend, () => backend.queueOverview(caller, repoId));
        return {
          repoId: o.repoId,
          mainSha: o.mainSha,
          frozen: o.frozen,
          freezeReasons: o.freezeReasons.map((f) => ({
            kind: f.kind,
            at: f.at,
            message: f.message,
            changeId: f.changeId,
          })),
          halted: o.halted,
          tracks: o.tracks,
          landing: o.landing.map((l) => ({ id: l.id, state: l.state, members: l.members })),
          entries: o.entries.map((e) => entryOut(e) as QueueEntry),
          waiting: o.waiting,
          resolving: o.resolving,
          throughputPerHour: o.throughputPerHour,
          timeInQueueMs: o.timeInQueueMs,
          ciDurationMs: o.ciDurationMs,
          quarantined: o.quarantined,
          flakeRates: o.flakeRates,
        };
      },
    }),
    defineTool({
      name: "search_tools",
      title: "Find the right tool",
      description:
        "Fuzzy search over every gittifacts tool's name and description. Returns matching tool names, a one-line description and an example call.",
      inputSchema: SearchToolsInput,
      outputSchema: SearchToolsOutput,
      annotations: READ,
      handler: async (args): Promise<{ tools: ToolSummary[] }> => {
        const { query } = kit.parse(z.object({ query: z.string().min(1).max(200) }), args);
        return { tools: searchTools(query, catalog(backend)) };
      },
    }),
  ] as const;
}

const WaitReason = z.enum(["merged", "ejected", "dequeued", "frozen", "timeout", "not-queued"]);

/** Every tool's name, one-line description and example call (built from the live definitions). */
function catalog(backend: McpBackend): ToolSummary[] {
  const build = buildTools as unknown as (
    b: McpBackend,
  ) => Record<string, { name: string; description?: string; inputSchema?: unknown }>;
  return Object.values(build(backend)).map((t) => ({
    name: t.name,
    description: firstSentence(t.description ?? ""),
    example: exampleCall(t.name, t.inputSchema),
  }));
}
