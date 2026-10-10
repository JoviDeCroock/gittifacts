/**
 * `list_changes`: a repo's changes, most recently updated first, filtered by status or to the ones
 * you started (`mine`), each with its page (url) to hand a person. The read twin of the web app's
 * change lists; it decides nothing.
 */
import type { Change, ChangeStatus } from "@app/domain";
import { defineTool } from "mcp-tada-server";
import { z } from "zod";
import type { McpBackend, McpCaller } from "../backend.js";
import { CHANGE_STATUSES, ChangeBrief } from "../schemas.js";
import { changeBrief } from "../tools.js";
import type { ToolKit } from "./workspace.js";

// ---------------------------------------------------------------- backend contract

/** A change in a list: the change, its plan's title and who started it. */
export type ChangeListItem = Change & {
  planTitle: string | null;
  authorName: string;
  authorKind: "human" | "agent" | "system" | "integration";
};

export interface ChangeListToolsBackend {
  /** A repo's changes, most recently updated first (at most 200; read access). */
  listChanges(
    caller: McpCaller,
    repoId: string,
    filter: { status?: ChangeStatus | undefined },
  ): Promise<ChangeListItem[]>;
}

// ---------------------------------------------------------------- schemas

const ListChangesInput = {
  type: "object",
  properties: {
    repoId: { type: "string", minLength: 1, maxLength: 64, description: "The repo." },
    status: { enum: CHANGE_STATUSES, description: "Only changes with this status." },
    mine: { type: "boolean", description: "Only changes you started." },
  },
  required: ["repoId"],
  additionalProperties: false,
} as const;

const ChangeListEntry = {
  type: "object",
  properties: {
    ...ChangeBrief.properties,
    authorId: { type: "string" },
    authorName: { type: "string" },
    authorKind: { enum: ["human", "agent", "system", "integration"] },
    planTitle: { type: ["string", "null"] },
    url: {
      type: "string",
      description: "The change's page on the platform: hand it to the person who reviews it.",
    },
  },
  required: [...ChangeBrief.required, "authorId", "authorName", "authorKind", "planTitle", "url"],
} as const;

const ListChangesOutput = {
  type: "object",
  properties: { changes: { type: "array", items: ChangeListEntry } },
  required: ["changes"],
} as const;

const ListChangesArgs = z.object({
  repoId: z.string().min(1).max(64),
  status: z.enum(CHANGE_STATUSES).optional(),
  mine: z.boolean().optional(),
});

// ---------------------------------------------------------------- tool

export function changeListTools(backend: McpBackend, kit: ToolKit) {
  return [
    defineTool({
      name: "list_changes",
      title: "List changes",
      description:
        "A repo's changes, most recently updated first (up to 200): status, lane, plan, who started it and its page (url). Filter by status (e.g. awaiting-review) or to the changes you started (mine: true). get_change_status has one change's details.",
      inputSchema: ListChangesInput,
      outputSchema: ListChangesOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "repo:read");
        const { repoId, status, mine } = kit.parse(ListChangesArgs, args);
        const items = await kit.run(backend, () =>
          backend.listChanges(caller, repoId, status === undefined ? {} : { status }),
        );
        return {
          changes: items
            .filter((c) => mine !== true || c.authorId === caller.principalId)
            .map((c) => ({
              ...changeBrief(c),
              authorId: c.authorId,
              authorName: c.authorName,
              authorKind: c.authorKind,
              planTitle: c.planTitle,
              url: backend.webUrl({ changeId: c.id }),
            })),
        };
      },
    }),
  ];
}
