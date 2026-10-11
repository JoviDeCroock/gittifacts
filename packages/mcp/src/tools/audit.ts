/**
 * `list_audit_events`: the signed audit log, newest first, as the `/audit` page shows it: who did
 * what to which subject, filtered by repo, subject, actor (one agent's trail) or action, with the
 * hash chain's verdict. Read-only; the caller sees the events of the repos it can read.
 */
import { defineTool } from "mcp-tada-server";
import { z } from "zod";
import type { McpBackend, McpCaller } from "../backend.js";
import type { ToolKit } from "./workspace.js";

// ---------------------------------------------------------------- backend contract

/** Who acted, with the accountable person for an agent (`ownerName`). */
export interface ActorData {
  id: string;
  name: string;
  kind: "human" | "agent" | "system" | "integration";
  ownerId: string | null;
  ownerName: string | null;
}

/** One audit event: a hash-chained, platform-signed fact, with a readable one-liner. */
export interface AuditEventData {
  seq: number;
  at: string;
  action: string;
  /** e.g. `change:<id>`, `plan:<id>`, `repo:<id>`, `principal:<id>`. */
  subject: string;
  summary: string;
  actor: ActorData;
  /** What the subject is called (a change or plan title and its repo); null when unknown. */
  about: { title: string; repoId: string | null; repoName: string | null } | null;
}

export interface AuditFilterData {
  repoId?: string | undefined;
  subject?: string | undefined;
  actor?: string | undefined;
  action?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

export interface AuditToolsBackend {
  /** A page of the audit log, newest first (only events the caller may read). */
  listAuditEvents(
    caller: McpCaller,
    filter: AuditFilterData,
  ): Promise<{
    events: AuditEventData[];
    nextCursor: string | null;
    chain: {
      verified: boolean;
      brokenAt?: number | undefined;
      verifiedThrough?: number | undefined;
      headSeq?: number | undefined;
      complete?: boolean | undefined;
    };
  }>;
  /** The `/audit` page with these filters, to hand a person. */
  auditUrl(filter: { subject?: string; actor?: string; action?: string }): string;
}

// ---------------------------------------------------------------- schemas

const str = { type: "string" } as const;
const nullableStr = { type: ["string", "null"] } as const;

export const Actor = {
  type: "object",
  description: "Who acted; for an agent, ownerName is the person accountable for it.",
  properties: {
    id: str,
    name: str,
    kind: { enum: ["human", "agent", "system", "integration"] },
    ownerId: nullableStr,
    ownerName: nullableStr,
  },
  required: ["id", "name", "kind", "ownerId", "ownerName"],
} as const;

export const AuditEvent = {
  type: "object",
  properties: {
    seq: { type: "integer" },
    at: str,
    action: {
      type: "string",
      description: "e.g. change.approved, plan.created, merge-queue.merged",
    },
    subject: { type: "string", description: "change:<id>, plan:<id>, repo:<id> or principal:<id>" },
    summary: str,
    actor: Actor,
    about: {
      type: ["object", "null"],
      description: "What the subject is called: a change or plan title and its repo.",
      properties: { title: str, repoId: nullableStr, repoName: nullableStr },
      required: ["title", "repoId", "repoName"],
    },
  },
  required: ["seq", "at", "action", "subject", "summary", "actor", "about"],
} as const;

const ListAuditEventsInput = {
  type: "object",
  properties: {
    repoId: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      description: "Only this repo's events (the repo, its plans and its changes).",
    },
    subject: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: "Only events about this subject, e.g. change:<id> or plan:<id>.",
    },
    actor: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      description: "Only events by this principal id (one agent's trail; whoami gives yours).",
    },
    action: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      description: "Only this exact action, e.g. change.approved.",
    },
    cursor: {
      type: "string",
      pattern: "^[1-9][0-9]{0,15}$",
      description: "nextCursor from the previous page.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: "Events per page (default 30).",
    },
  },
  additionalProperties: false,
} as const;

const ListAuditEventsOutput = {
  type: "object",
  properties: {
    events: { type: "array", items: AuditEvent },
    chain: {
      type: "object",
      description:
        "The hash chain's verdict. verified=true: every event up to headSeq checks out. brokenAt set: an event was altered or removed (the first bad seq). Neither, with complete=false: verified through verifiedThrough so far; reads check newer events a batch at a time, so treat later events as not yet verified.",
      properties: {
        verified: { type: "boolean" },
        brokenAt: { type: "integer" },
        verifiedThrough: {
          type: "integer",
          description: "Highest seq verified (it and every earlier event).",
        },
        headSeq: { type: "integer", description: "Newest seq when checked." },
        complete: { type: "boolean", description: "verifiedThrough reached headSeq." },
      },
      required: ["verified"],
    },
    nextCursor: {
      ...nullableStr,
      description: "Pass as cursor for older events; null on the last page.",
    },
    url: { type: "string", description: "The audit page with these filters, to hand a person." },
    nextSteps: {
      type: "array",
      items: {
        type: "object",
        properties: { title: str, call: str, why: str },
        required: ["title"],
      },
    },
  },
  required: ["events", "chain", "nextCursor", "url", "nextSteps"],
} as const;

const ListAuditEventsArgs = z.object({
  repoId: z.string().min(1).max(64).optional(),
  subject: z.string().min(1).max(200).optional(),
  actor: z.string().min(1).max(64).optional(),
  action: z.string().min(1).max(100).optional(),
  cursor: z
    .string()
    .regex(/^[1-9][0-9]{0,15}$/)
    .optional(),
  limit: z.number().int().min(1).max(100).default(30),
});

// ---------------------------------------------------------------- tool

export function auditTools(backend: McpBackend, kit: ToolKit) {
  return [
    defineTool({
      name: "list_audit_events",
      title: "Read the audit log",
      description:
        "The signed audit log, newest first: who did what (actor, with an agent's accountable person), to which subject, when, and whether the hash chain verifies. Filter by repoId, subject (change:<id>, plan:<id>), actor (a principal id: one agent's trail) or exact action (change.approved); page with nextCursor. Answers \"who approved this, and when\". Read-only.",
      inputSchema: ListAuditEventsInput,
      outputSchema: ListAuditEventsOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "repo:read");
        const filter = kit.parse(ListAuditEventsArgs, args);
        const page = await kit.run(backend, () => backend.listAuditEvents(caller, filter));
        const { subject, actor, action } = filter;
        const more = page.nextCursor;
        const c = page.chain;
        // Reads verify the chain a batch at a time (security M9): no break found, but not done yet.
        const pending = !c.verified && c.brokenAt === undefined && c.complete === false;
        return {
          events: page.events,
          chain: {
            verified: c.verified,
            ...(c.brokenAt === undefined ? {} : { brokenAt: c.brokenAt }),
            ...(c.verifiedThrough === undefined ? {} : { verifiedThrough: c.verifiedThrough }),
            ...(c.headSeq === undefined ? {} : { headSeq: c.headSeq }),
            ...(c.complete === undefined ? {} : { complete: c.complete }),
          },
          nextCursor: more,
          url: backend.auditUrl({
            ...(subject === undefined ? {} : { subject }),
            ...(actor === undefined ? {} : { actor }),
            ...(action === undefined ? {} : { action }),
          }),
          nextSteps: [
            ...(c.verified
              ? []
              : pending
                ? [
                    {
                      title: `The audit chain is verified through event ${c.verifiedThrough ?? 0} of ${c.headSeq ?? "?"} so far`,
                      why: "Newer events are checked a batch at a time: call again to continue, and until then treat events after that one as not yet verified.",
                    },
                  ]
                : [
                    {
                      title: `The audit chain does not verify (first bad event: ${c.brokenAt ?? "unknown"})`,
                      why: "Treat these events as untrusted and tell a person: hand them url.",
                    },
                  ]),
            ...(more === null
              ? []
              : [
                  {
                    title: "Older events",
                    call: `list_audit_events({ ${pagingArgs(filter, more)} })`,
                  },
                ]),
          ],
        };
      },
    }),
  ];
}

/** The same filters with the next cursor, as call arguments (limit only when it was set). */
function pagingArgs(f: z.output<typeof ListAuditEventsArgs>, cursor: string): string {
  const args: string[] = [];
  for (const k of ["repoId", "subject", "actor", "action"] as const) {
    const v = f[k];
    if (v !== undefined) args.push(`${k}: ${JSON.stringify(v)}`);
  }
  if (f.limit !== 30) args.push(`limit: ${f.limit}`);
  args.push(`cursor: ${JSON.stringify(cursor)}`);
  return args.join(", ");
}
