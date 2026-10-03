/**
 * `@app/coordinator/fakes`: in-memory fakes for every port, plus in-process stand-ins for the
 * coordinator's Durable Objects and Workflows. `createFakeEnvironment()` wires them together with
 * the real service, cores and workflow bodies — an end-to-end coordinator with no Cloudflare.
 */
import type { Plan, Principal, Repo, Scope } from "@app/domain";
import { defaultPolicy, RepoPolicy, type RepoPolicyInput } from "@app/domain";
import type { CoordinatorApi } from "../api.js";
import { isForkName } from "../ids.js";
import type { MergeQueueOptions } from "../merge-queue.js";
import { withChangeNotifications } from "../milestones.js";
import { isGithubMirrorRepo, type Ports, type PortsRole } from "../ports.js";
import { createRunSink } from "../run-sink.js";
import { type CoordinatorOptions, createCoordinator } from "../service.js";
import { FakeGitHost, type Files } from "./git-host.js";
import { FakeCiEngine, FakeSandboxJobs } from "./jobs.js";
import { FakeBindings } from "./runtime.js";
import {
  FakeAudit,
  FakeClock,
  FakeDeployer,
  FakeFlags,
  FakeNotifier,
  FakeReviewer,
  FakeSigner,
  FakeTelemetry,
} from "./services.js";
import { FakeStore } from "./store.js";

export * from "./git-host.js";
export * from "./jobs.js";
export * from "./queue.js";
export * from "./runtime.js";
export * from "./services.js";
export * from "./store.js";

export interface FakePorts extends Ports {
  store: FakeStore;
  git: FakeGitHost;
  sandbox: FakeSandboxJobs;
  ci: FakeCiEngine;
  reviewer: FakeReviewer;
  signer: FakeSigner;
  deployer: FakeDeployer;
  flags: FakeFlags;
  telemetry: FakeTelemetry;
  audit: FakeAudit;
  notifier: FakeNotifier;
  clock: FakeClock;
}

export function createFakePorts(opts: { namespace?: string } = {}): FakePorts {
  const clock = new FakeClock();
  const git = new FakeGitHost(opts.namespace === undefined ? {} : { namespace: opts.namespace });
  return {
    store: new FakeStore(clock),
    git,
    sandbox: new FakeSandboxJobs(git),
    ci: new FakeCiEngine(),
    reviewer: new FakeReviewer(),
    signer: new FakeSigner(),
    deployer: new FakeDeployer(),
    flags: new FakeFlags(),
    telemetry: new FakeTelemetry(),
    audit: new FakeAudit(clock),
    notifier: new FakeNotifier(),
    clock,
  };
}

/** The merge-queue role's GitHost may write main repos; every other role only forks. */
export function portsForRole(ports: FakePorts, role: PortsRole): Ports {
  if (role === "merge-queue") return ports;
  return {
    ...ports,
    git: forkOnlyGit(ports.git, role === "github" ? isGithubMirrorRepo : () => false),
  };
}

function forkOnlyGit(git: FakeGitHost, alsoWritable: (repo: string) => boolean): FakeGitHost {
  return new Proxy(git, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      const guarded = new Set(["writeNote", "updateRef", "commitTree", "deleteRepo"]);
      return (...args: unknown[]) => {
        const name = String(prop);
        const repo = name === "transferObjects" || name === "fetchExternal" ? args[1] : args[0];
        const writes =
          guarded.has(name) ||
          name === "transferObjects" ||
          name === "fetchExternal" ||
          (name === "mintToken" && args[1] === "write");
        if (writes && typeof repo === "string" && !isForkName(repo) && !alsoWritable(repo)) {
          throw new Error(`forbidden: ${name} on main repo ${repo} outside the merge queue`);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

let principalCounter = 0;

export function principal(overrides: Partial<Principal> & { kind: Principal["kind"] }): Principal {
  const scopes: Scope[] =
    overrides.kind === "human"
      ? [
          "repo:read",
          "repo:admin",
          "plan:create",
          "plan:approve",
          "change:create",
          "change:review",
          "policy:admin",
        ]
      : ["repo:read", "change:create"];
  return {
    id: `${overrides.kind}-${++principalCounter}`,
    name: `${overrides.kind} ${principalCounter}`,
    ownerId: null,
    keys: [],
    scopes,
    ...overrides,
  };
}

export function approvedPlan(repoId: string, overrides: Partial<Plan> = {}): Plan {
  return {
    id: `plan-${repoId}`,
    repoId,
    title: "Fix the thing",
    intent: "Fix the thing so that it works for everyone.",
    acceptanceCriteria: ["it works"],
    outOfScope: [],
    riskDeclarations: [],
    scopePaths: ["src/**", "test/**"],
    affectedRoutes: [],
    status: "approved",
    authorId: "someone",
    approvedBy: "approver",
    approvedAt: "2026-10-01T10:00:00.000Z",
    approvalSignature: "c2ln",
    supersedes: null,
    createdAt: "2026-10-01T09:00:00.000Z",
    ...overrides,
  };
}

export interface FakeEnvironment {
  ports: FakePorts;
  bindings: FakeBindings;
  coordinator: CoordinatorApi;
  /** Seed a repo row + its Artifacts repo with one commit. */
  seedRepo(input?: {
    name?: string;
    files?: Files;
    policy?: RepoPolicyInput;
    deployTarget?: string | null;
    claim?: Repo["claim"];
  }): Promise<Repo>;
  /** Wait until workflows, queues and CI deliveries are quiet. */
  settle(): Promise<void>;
}

export function createFakeEnvironment(
  opts: {
    coordinator?: CoordinatorOptions;
    queue?: Partial<MergeQueueOptions>;
    runWorkflows?: boolean;
  } = {},
): FakeEnvironment {
  const ports = createFakePorts();
  const bindings = new FakeBindings((role) => portsForRole(ports, role), {
    pollMs: 0,
    ...opts.queue,
  });
  if (opts.runWorkflows !== false) bindings.runWorkflows();
  // Rollout waits ("issue" for one minute) time out at once and move the fake clock.
  bindings.rolloutWorkflow.stepOptions = {
    timeout: (_name, type) => type === "issue",
    onElapse: (ms) => ports.clock.advance(ms),
  };
  ports.ci.sink = createRunSink(withChangeNotifications(ports, bindings), bindings);
  const coordinator = createCoordinator(portsForRole(ports, "default"), bindings, opts.coordinator);
  let repoCounter = 0;

  return {
    ports,
    bindings,
    coordinator,
    async seedRepo(input = {}) {
      const n = ++repoCounter;
      const name = input.name ?? `repo${n}`;
      const head = ports.git.seed(
        name,
        input.files ?? { "src/a.ts": "export const a = 1;\n", "README.md": "# repo\n" },
      );
      const policy = RepoPolicy.parse({ ...input.policy });
      const repo: Repo = {
        id: `r${n}`,
        namespace: ports.git.namespace,
        artifactsName: name,
        name,
        defaultBranch: "main",
        jurisdiction: "eu",
        importedFrom: null,
        policy: input.policy === undefined ? defaultPolicy() : policy,
        policySha: head,
        deployTarget: input.deployTarget ?? null,
        claim: input.claim ?? { status: "claimed", ownerId: "owner", expiresAt: null },
        template: null,
        createdAt: "2026-10-01T09:00:00.000Z",
      };
      await ports.store.insertRepo(repo);
      return repo;
    },
    async settle() {
      // Quiet = no CI delivery or queue drain pending and every workflow either finished or
      // parked on waitForEvent, twice in a row.
      let quiet = 0;
      for (let i = 0; i < 1000 && quiet < 2; i++) {
        await ports.ci.settle();
        await bindings.settle();
        await new Promise((r) => setTimeout(r, 2));
        const busy =
          ports.ci.pendingDeliveries > 0 ||
          bindings.pendingDrains > 0 ||
          [
            ...bindings.changeWorkflow.instances.values(),
            ...bindings.rolloutWorkflow.instances.values(),
          ].some((inst) => inst.state === "running" && inst.waiting.length === 0);
        quiet = busy ? 0 : quiet + 1;
      }
    },
  };
}
