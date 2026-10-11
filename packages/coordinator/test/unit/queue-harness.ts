/**
 * The agent-native merge queue over fakes: the real `MergeQueueService` (store on node:sqlite,
 * the real loop, real command handlers, the real pure core), the real BatchRunWorkflow body, the
 * fake CI engine (red iff the tested tree holds `src/bad.ts`), file-level merges in the scratch
 * repo, and a scripted resolver (its scope scripted, or computed mechanically from the merge
 * document like the real resolver does: `scope.mechanical`). Changes are admitted the way the ChangeWorkflow admits them.
 */
import { DatabaseSync } from "node:sqlite";
import type { Change, Repo } from "@app/domain";
import { conflictResolutionItem, type ResolutionScope, resolutionScope } from "@app/evidence";
import type { QueueConfigInput } from "@app/merge-queue";
import type { ConflictResolver, ResolutionOutcome, ResolverInput } from "@app/resolver";
import {
  createFakeEnvironment,
  type FakeEnvironment,
  FakeQueueJobs,
  type Files,
  portsForRole,
} from "../../src/fakes/index.js";
import { forkNameFor } from "../../src/ids.js";
import type { SqlLike } from "../../src/merge-queue.js";
import { MergeQueueService } from "../../src/queue/service.js";

export function sqlite(): { sql: SqlLike; transact: <T>(fn: () => T) => T } {
  const db = new DatabaseSync(":memory:");
  const sql: SqlLike = {
    exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
  const transact = <T>(fn: () => T): T => {
    db.exec("BEGIN");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  return { sql, transact };
}

export interface ScriptedScope {
  novelLines?: number;
  droppedLines?: number;
  touchesOutsideConflictHunks?: boolean;
  /** Compute the scope with `resolutionScope` from the merge document (overrides the counts). */
  mechanical?: boolean;
}

interface MergeDocFile {
  path: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  merged_with_markers: string | null;
}

/** What the real resolver computes: `resolutionScope` over the merged and resolved texts. */
function mechanicalScope(
  input: ResolverInput,
  files: Record<string, string | null>,
): ResolutionScope {
  const doc = input.merge as {
    files: MergeDocFile[];
    markers: { size: number; ours?: string; base?: string; theirs?: string };
  };
  return resolutionScope(
    doc.files.map((f) => ({
      path: f.path,
      merged: f.merged_with_markers,
      resolved: f.path in files ? (files[f.path] ?? null) : f.merged_with_markers,
      conflicted: true,
      sides: { ours: f.ours, base: f.base, theirs: f.theirs },
    })),
    doc.markers,
  );
}

/** A scripted resolver: textual conflicts get `resolve(files)`, semantic ones "not-a-conflict". */
export function scriptedResolver(
  resolve: (input: ResolverInput) => Record<string, string | null> | null,
  scope: ScriptedScope = {},
): ConflictResolver {
  return {
    principalId: "system:resolver",
    async resolve(input: ResolverInput): Promise<ResolutionOutcome> {
      const merge = input.merge as { status: string; conflictSha?: string; newSha?: string };
      const files = input.semantic === undefined ? resolve(input) : null;
      const computed =
        scope.mechanical === true && files !== null ? mechanicalScope(input, files) : null;
      const common = {
        costUsd: 0,
        budgetExceeded: false,
        diagnostics: {} as ResolutionOutcome["diagnostics"],
      };
      const evidence = conflictResolutionItem({
        upstreamChanges: input.upstream.map((u) => ({ changeId: u.changeId, sha: u.sha })),
        scope: {
          // One region per resolved file (what the real resolver computes mechanically).
          conflictHunks: Object.keys(files ?? {}).map((file) => ({
            file,
            startLine: 1,
            endLine: 1,
          })),
          touchesOutsideConflictHunks: scope.touchesOutsideConflictHunks ?? false,
          novelLines: computed?.novelLines ?? scope.novelLines ?? 0,
          droppedLines: computed?.droppedLines ?? scope.droppedLines ?? 0,
        },
        resolutionDiff: files === null ? "" : JSON.stringify(files),
        semanticConflictWith: null,
        rationale: "scripted",
        resolver: { model: "scripted", principalId: "system:resolver", promptVersion: "test" },
        attempts: 1,
      });
      if (files === null) {
        const cause = input.semantic === undefined ? "declined" : "not-a-conflict";
        return {
          ...common,
          status: "ejected",
          evidence,
          eject: {
            code: input.semantic === undefined ? "textual-conflict" : "tests-failed",
            cause,
            message: `scripted resolver: ${cause}`,
            fix: {
              explanation: "fix it yourself",
              call: `open_workspace({ changeId: "${input.change.id}" })`,
            },
            evidenceRefs: [],
            failingTests: [],
            upstream: input.upstream.map((u) => u.changeId),
          },
        };
      }
      return {
        ...common,
        status: "resolved",
        patch: JSON.stringify({ files }),
        applyOnto: merge.conflictSha ?? merge.newSha ?? "",
        files: Object.entries(files).map(([path, content]) => ({ path, content })),
        scope: computed ?? {
          files: [],
          conflictHunks: [],
          outsideHunks: [],
          touchesOutsideConflictHunks: scope.touchesOutsideConflictHunks ?? false,
          outsideFiles: [],
          unresolvedFiles: [],
          novelLines: scope.novelLines ?? 0,
          droppedLines: scope.droppedLines ?? 0,
          regions: 1,
        },
        evidence,
        semanticConflictWith: null,
        rationale: "scripted",
      };
    },
  };
}

export interface QueueEnv extends FakeEnvironment {
  repo: Repo;
  jobs: FakeQueueJobs;
  queue(): MergeQueueService;
  /** Every sha the default branch pointed at, in order (genesis first). */
  mainHistory: string[];
  /** A Change on its own fork: `files` committed on top of main as it is now. */
  change(id: string, files: Record<string, string | null>, lane?: 0 | 1 | 2): Promise<Change>;
  /** Admit like the ChangeWorkflow does (approved head, lane, what the approval covers). */
  admit(change: Change): Promise<void>;
  /** Run the queue (outbox, batch runs, CI, alarms with the clock moving) until it is idle. */
  drive(maxRounds?: number): Promise<void>;
}

export interface QueueEnvOptions {
  config?: QueueConfigInput;
  files?: Files;
  resolver?: (input: ResolverInput) => Record<string, string | null> | null;
  /** Override the scripted resolver's scope (e.g. novel lines). */
  scope?: ScriptedScope;
  /** Deploy merged Changes in trains (the platform default). */
  trains?: boolean;
}

export async function queueEnv(opts: QueueEnvOptions = {}): Promise<QueueEnv> {
  const env = createFakeEnvironment();
  const repo = await env.seedRepo({
    name: "app",
    files: opts.files ?? { "src/a.ts": "export const a = 1;\n", "README.md": "# app\n" },
  });
  return attachAgentQueue(env, repo, opts);
}

/** Use the agent-native queue in `env` (repo `app`); the rest of the environment is untouched. */
export function attachAgentQueue(
  env: FakeEnvironment,
  repo: Repo,
  opts: QueueEnvOptions = {},
): QueueEnv {
  const { git, ci, clock } = env.ports;
  const jobs = new FakeQueueJobs(git);
  const alarm = { at: null as number | null };
  env.bindings.useAgentQueue((repoId) => {
    const { sql, transact } = sqlite();
    return new MergeQueueService({
      repoId,
      ports: portsForRole(env.ports, "merge-queue"),
      bindings: env.bindings,
      sql,
      transact,
      jobs,
      batchRuns: env.bindings.batchRuns,
      ...(opts.resolver === undefined
        ? {}
        : { resolver: () => scriptedResolver(opts.resolver ?? (() => null), opts.scope) }),
      config: { batchHoldMs: 0, ...opts.config },
      ...(opts.trains === true ? { trains: true } : {}),
      alarm: {
        get: async () => alarm.at,
        set: async (at) => {
          alarm.at = at;
        },
      },
    });
  });
  // CI is red iff the tested tree holds src/bad.ts (a Change that breaks on the queue's tree).
  const green = ci.outcome;
  ci.outcome = (req) => {
    const o = green(req);
    return git.filesAt(req.headSha)["src/bad.ts"] === undefined ? o : { ...o, status: "failed" };
  };
  // Record every move of the default branch (main-never-red is checked against this).
  const mainHistory = [git.head("app") ?? ""];
  const inner = git.updateRef.bind(git);
  git.updateRef = async (r, ref, oldSha, newSha) => {
    const res = await inner(r, ref, oldSha, newSha);
    if (res.ok && r === "app" && ref === "refs/heads/main") mainHistory.push(newSha);
    return res;
  };
  let n = 0;
  return {
    ...env,
    repo,
    jobs,
    mainHistory,
    queue: () => env.bindings.agentQueue(repo.id),
    async change(id, files, lane = 0) {
      const fork = forkNameFor(id);
      await git.forkRepo("app", fork);
      const baseSha = git.head("app") ?? "";
      git.repo(fork).refs.set("refs/heads/main", baseSha);
      const headSha = git.commit(fork, "main", files, `${id}: change`);
      const now = clock.now().toISOString();
      const c: Change = {
        id,
        repoId: repo.id,
        planId: null,
        title: `Change ${id} (${++n})`,
        claim: { category: "fix", summary: null },
        baseSha,
        headSha,
        forkName: fork,
        authorId: `agent-${id}`,
        status: "queued",
        computedLane: lane,
        lane,
        laneReasons: [],
        evidenceId: null,
        tourId: null,
        flagKey: null,
        mergedSha: null,
        rolloutState: null,
        revertOf: null,
        revertedBy: null,
        agentTraceId: null,
        createdAt: now,
        updatedAt: now,
      };
      await env.ports.store.insertChange(c);
      return c;
    },
    async admit(c) {
      await env.bindings.mergeQueue(repo.id).enqueue({
        repoId: repo.id,
        changeId: c.id,
        headSha: c.headSha ?? "",
        workflowInstanceId: `wf-${c.id}`,
        lane: c.lane ?? 0,
        approvedLane: c.lane ?? 0,
        via: c.lane === 0 ? "lane-0" : "review",
      });
    },
    async drive(maxRounds = 400) {
      const svc = env.bindings.agentQueue(repo.id);
      for (let i = 0; i < maxRounds; i++) {
        await env.settle();
        await env.bindings.batchRuns.settle();
        await svc.loop.settle();
        const s = svc.loop.state;
        const active = Object.values(s.entries).some(
          (e) => !["merged", "ejected", "dequeued"].includes(e.state),
        );
        if (!active && svc.store.pendingCommands() === 0 && env.bindings.pendingDrains === 0)
          return;
        clock.advance(20_000);
        await svc.alarm();
      }
      const stuck = Object.values(svc.loop.state.entries)
        .filter((e) => !["merged", "ejected", "dequeued"].includes(e.state))
        .map((e) => ({
          id: e.changeId,
          state: e.state,
          hold: e.hold,
          batch: e.batchId,
          resolution: e.resolution,
        }));
      const outbox = svc.store.dueCommands(Number.MAX_SAFE_INTEGER, 20).map((r) => ({
        type: (r.command as { type: string }).type,
        attempts: r.attempts,
        error: r.lastError,
      }));
      throw new Error(
        `queue did not settle: ${JSON.stringify({ stuck, outbox, audit: env.ports.audit.actions().slice(-15) })}`,
      );
    },
  };
}
