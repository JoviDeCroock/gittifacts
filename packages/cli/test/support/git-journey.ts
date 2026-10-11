/**
 * A fake McpBackend whose Changes live in real git: each Change is a bare fork on the local git
 * server (support/git-server.ts), push tokens are minted there, and a Change's head, status and
 * lane follow what was actually pushed to its fork.
 */
import { execFileSync } from "node:child_process";
import type { Change, ChangeStatus, LaneReason } from "@app/domain";
import type { McpBackend } from "../../../mcp/src/index.js";
import { change, fakeBackend, NotFound } from "../../../mcp/test/support/fake-backend.js";
import type { GitServer } from "./git-server.js";

/** One reason sets Lane 1; two checks passed. */
export const JOURNEY_REASONS: LaneReason[] = [
  { code: "tests.pass", lane: 0, message: "all tests passed" },
  { code: "size.lane1", lane: 1, message: "40 changed lines" },
  { code: "coverage.ok", lane: 0, message: "coverage held" },
];

interface Tracked {
  title: string;
  base: string | null;
  /** Forced status (e.g. merged); else derived from the fork. */
  status: ChangeStatus | null;
}

/** `projectToken`: what create_project returns as the repo's own token (stored by init). */
export function journeyBackend(git: GitServer, opts: { projectToken: string | null }) {
  const changes = new Map<string, Tracked>();
  let next = 9;
  const open = (title: string): string => {
    const id = `chg_${next++}`;
    git.fork(`task-${id}`);
    changes.set(id, { title, base: git.head(`task-${id}`), status: null });
    return id;
  };
  const remoteFor = (id: string) => {
    const t = git.mint(`task-${id}`);
    return {
      url: `${git.artifacts}/task-${id}.git`,
      username: "x",
      token: t.token,
      expiresAt: t.expiresAt,
      branch: "main",
    };
  };
  const snapshot = (id: string): Change => {
    const t = changes.get(id);
    if (!t) throw new NotFound(`change ${id}`);
    const head = git.head(`task-${id}`);
    const pushed = head !== null && head !== t.base;
    const status: ChangeStatus = t.status ?? (pushed ? "awaiting-review" : "awaiting-push");
    return change({
      id,
      title: t.title,
      forkName: `task-${id}`,
      status,
      headSha: pushed ? head : null,
      lane: pushed ? 1 : null,
      computedLane: pushed ? 1 : null,
      laneReasons: pushed ? JOURNEY_REASONS : [],
    });
  };
  const backend = fakeBackend({
    async createProject(_caller, input) {
      const id = open("First Change");
      return {
        repoId: "repo_1",
        projectId: "repo_1",
        name: input.name ?? "app",
        template: input.template ?? null,
        defaultBranch: "main",
        remote: { ...remoteFor(id), changeId: id },
        token: opts.projectToken,
        mcpUrl: `${git.host}/mcp`,
        previewUrl: "https://p-repo-1.preview.test",
        claimUrl: "https://gittifacts.test/claim/abc",
        bootstrapChangeId: "bs-repo_1",
        nextSteps: [
          {
            title: "Wait for the first CI run and preview",
            call: 'wait_for_change({ changeId: "bs-repo_1", until: "evidence_ready" })',
          },
        ],
      };
    },
    async startChange(_caller, input) {
      const id = open(input.title);
      return {
        change: snapshot(id),
        remote: remoteFor(id),
        overlaps: null,
      };
    },
    async refreshPushToken(_caller, changeId) {
      snapshot(changeId);
      return remoteFor(changeId);
    },
    async getChangeStatus(_caller, changeId) {
      const c = snapshot(changeId);
      return {
        change: c,
        overlaps: null,
        reviews: [],
        runs: [],
        classification:
          c.lane === null
            ? null
            : {
                lane: c.lane,
                computedLane: c.lane,
                reasons: JOURNEY_REASONS,
                shadow: false,
                blocked: false,
                requiresHumanApproval: false,
              },
      };
    },
    async waitForChange(_caller, changeId) {
      const c = snapshot(changeId);
      const reached = c.headSha !== null;
      return { change: c, reached, reason: reached ? "reached" : "timeout" };
    },
  } satisfies Partial<McpBackend>);
  return {
    backend,
    changes,
    /** Lands a Change: main fast-forwards to its fork's head, and it reads as merged. */
    merge(id: string) {
      const t = changes.get(id);
      if (!t) return;
      execFileSync("git", ["push", "-q", git.repo("main"), "main:main"], {
        cwd: git.repo(`task-${id}`),
      });
      t.status = "merged";
    },
  };
}
