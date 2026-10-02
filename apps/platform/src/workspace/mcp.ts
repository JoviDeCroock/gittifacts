/**
 * The workspace tools' slice of the platform `McpBackend` (packages/mcp/src/tools/workspace.ts).
 * Every call is repo-scoped first (a delegated agent only reaches workspaces of Changes in repos
 * it was granted), mutating calls are idempotent per (principal, idempotencyKey), and the rules
 * live in ./service.ts.
 */
import type { McpCaller, WorkspaceToolsBackend } from "@app/mcp";
import type { Caller, Services } from "../app-env.js";
import type { RepoTarget } from "../auth/repo-scope.js";
import { changeIdOfWorkspace } from "./model.js";
import {
  closeWorkspace,
  openWorkspace,
  wsCommitPush,
  wsDiff,
  wsExec,
  wsRead,
  wsWrite,
} from "./service.js";

/** What createPlatformMcpBackend shares with each tool family's backend. */
export interface McpBackendHelpers {
  /** The verified caller, after checking it may touch the repo the target names. */
  scoped(mc: McpCaller, target: RepoTarget): Promise<Caller>;
  /** Runs `fn` at most once per (principal, key). */
  idem<T>(
    caller: Caller,
    tool: string,
    key: string | undefined,
    body: unknown,
    fn: () => Promise<T>,
  ): Promise<T>;
}

const targetOf = (workspaceId: string): RepoTarget => ({
  changeId: changeIdOfWorkspace(workspaceId) ?? undefined,
});

export function createWorkspaceMcpBackend(
  svc: Services,
  h: McpBackendHelpers,
): WorkspaceToolsBackend {
  return {
    async openWorkspace(mc, input, opts) {
      const caller = await h.scoped(mc, { changeId: input.changeId });
      return h.idem(caller, "open_workspace", opts.idempotencyKey, input, () =>
        openWorkspace(svc, caller, input.changeId),
      );
    },

    async closeWorkspace(mc, workspaceId, opts) {
      const caller = await h.scoped(mc, targetOf(workspaceId));
      return h.idem(caller, "close_workspace", opts.idempotencyKey, { workspaceId }, () =>
        closeWorkspace(svc, caller, workspaceId),
      );
    },

    async wsExec(mc, input, opts) {
      const caller = await h.scoped(mc, targetOf(input.workspaceId));
      return h.idem(caller, "ws_exec", opts.idempotencyKey, input, () =>
        wsExec(svc, caller, input),
      );
    },

    async wsRead(mc, input) {
      const caller = await h.scoped(mc, targetOf(input.workspaceId));
      return wsRead(svc, caller, input);
    },

    async wsWrite(mc, input, opts) {
      const caller = await h.scoped(mc, targetOf(input.workspaceId));
      return h.idem(caller, "ws_write", opts.idempotencyKey, input, () =>
        wsWrite(svc, caller, input),
      );
    },

    async wsDiff(mc, workspaceId) {
      const caller = await h.scoped(mc, targetOf(workspaceId));
      return wsDiff(svc, caller, workspaceId);
    },

    async wsCommitPush(mc, input, opts) {
      const caller = await h.scoped(mc, targetOf(input.workspaceId));
      return h.idem(caller, "ws_commit_push", opts.idempotencyKey, input, () =>
        wsCommitPush(svc, caller, input),
      );
    },
  };
}
