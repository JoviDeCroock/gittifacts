/**
 * The GitHub host for the contract suite (recorded fixtures): the whole coordinator in memory
 * (the same fakes as the native host), a recorded-fixture GitHub (fake-github.ts), and GitHub's
 * real event path: a recorded webhook body → `GithubSync` (mirror fetch, Change, check run) →
 * ChangeCoordinator → ChangeWorkflow → `@app/core` `gradeChange` → the `gittifacts/lane` run.
 */
import { createFakeEnvironment, type FakeEnvironment, portsForRole, principal } from "@app/coordinator/fakes";
import type { GradeReviewer } from "@app/core";
import { RepoPolicy } from "@app/domain";
import { type ChangeRef, laneZeroAction, type LaneAction } from "@app/host";
import type { ContractHost, ContractHostFactory, ContractScenario, Observed, OpenInput } from "@app/host-contract";
import { memoryCheckRunIndex, GitHubHost } from "../src/adapter.js";
import { GithubApi } from "../src/api.js";
import { changeIdFor, principalIdFor } from "../src/ids.js";
import { GithubSync } from "../src/sync.js";
import { InstallationTokens, JobToken } from "../src/tokens.js";
import { FakeGithub, type FakePull, gitName } from "./fake-github.js";
import { TEST_APP_PEM } from "./keys.js";

const REPO = { id: 9001, owner: "gittifacts-test", name: "fixture-lib", defaultBranch: "main", private: true };
const APP_ID = 1180001;

export class GithubContractHost implements ContractHost {
  readonly env: FakeEnvironment = createFakeEnvironment();
  readonly gh: FakeGithub;
  readonly adapter: GitHubHost;
  readonly sync: GithubSync;
  private ciItems: ContractScenario["ciItems"] | null = null;
  private pr: FakePull | null = null;
  /** The job token the adapter's API calls share (released after each delivery, like a queue job). */
  readonly job: JobToken;

  constructor(reviewer: GradeReviewer) {
    const { ports, bindings } = this.env;
    ports.reviewer.judge = (input) => reviewer.judge(input);
    ports.reviewer.tour = (input) => reviewer.tour(input);
    ports.ci.outcome = (req) => ({
      status: "passed",
      evidence: this.ciItems?.({ baseSha: req.baseSha, headSha: req.headSha }) ?? [],
      bundleRef: `bundle/${req.runId}`,
    });
    this.gh = new FakeGithub(ports.git, REPO);
    const tokens = new InstallationTokens({ appId: APP_ID, clientId: "Iv23contract", privateKey: TEST_APP_PEM }, { fetch: this.gh.fetch });
    const scope = { repositoryIds: [REPO.id], permissions: { checks: "write" as const, contents: "read" as const, pull_requests: "read" as const } };
    this.job = new JobToken(tokens, this.gh.installationId, scope);
    const job = this.job;
    const api = new GithubApi({ token: () => job.value(), fetch: this.gh.fetch });
    const githubPorts = portsForRole(ports, "github");
    const repoHost = { kind: "github" as const, owner: REPO.owner, repo: REPO.name, githubRepoId: REPO.id, installationId: this.gh.installationId, appId: APP_ID, private: true };
    this.adapter = new GitHubHost({
      repoId: `gh-${REPO.id}`, mirror: `ghm-${REPO.id}`, repo: repoHost, api,
      ports: githubPorts, checks: memoryCheckRunIndex(), origin: "https://gittifacts.test",
    });
    // The platform's runtime hands the ChangeWorkflow this adapter for GitHub changes.
    bindings.hosts = { github: () => this.adapter };
    this.sync = new GithubSync({
      ports: githubPorts,
      coordinator: (id) => bindings.changeCoordinator(id),
      host: this.adapter,
      installationId: this.gh.installationId,
      appId: APP_ID,
      source: async () => {
        const t = await tokens.mint(this.gh.installationId, { repositoryIds: [REPO.id], permissions: { contents: "read" } });
        return {
          remote: { url: `https://${gitName(REPO)}.git`, auth: { basic: { username: "x-access-token", password: t.value() } } },
          release: async () => void (await tokens.revoke(t)),
        };
      },
      authorPrincipal: async (who) => {
        const id = principalIdFor(Number(who.id));
        if ((await ports.store.getPrincipal(id)) === null) {
          ports.store.addPrincipal(principal({ id, kind: who.kind === "human" ? "human" : "agent", name: who.login }));
        }
        return id;
      },
    });
  }

  async open({ scenario, base, push, title }: OpenInput) {
    const { ports } = this.env;
    this.ciItems = scenario.ciItems;
    const baseSha = this.gh.seed(base);
    // As if an earlier delivery created the repo: the mirror, and the policy read from base.
    const repo = await this.sync.ensureRepo(this.gh.repoJson() as never);
    await ports.git.fetchExternal(
      { url: `https://${gitName(REPO)}.git`, auth: { basic: { username: "x-access-token", password: "seed" } } },
      repo.artifactsName,
      { sha: baseSha, toRef: "refs/heads/main" },
    );
    await ports.store.setRepoPolicy(repo.id, RepoPolicy.parse({ ...scenario.policy }), baseSha);
    let body = "Opened by the contract suite.";
    if (scenario.plan !== null) {
      const planId = `plan-${repo.id}`;
      ports.store.addPlan({ ...scenario.plan, id: planId, repoId: repo.id });
      body += `\n\ngittifacts-plan: ${planId}\n`;
    }
    // Fork PRs come from someone else's copy of the repo.
    const headRepo = scenario.kind === "fork" ? this.gh.fork("outside-contributor") : REPO;
    const head = this.gh.commit(headRepo, "change", push);
    this.pr = {
      number: 1, title: title.slice(0, 200), body, labels: [`gittifacts:${scenario.category}`],
      user: { login: "octo-author", id: 4711, type: "User" },
      head: { ref: "change", sha: head, repo: headRepo }, base: { ref: "main", sha: baseSha },
      state: "open", merged: false,
    };
    this.gh.pulls.set(1, this.pr);
    this.gh.setHead(this.pr, head);
    await this.sync.handle(this.gh.pullRequestDelivery("opened", this.pr));
    await this.job.release();
    return { ref: this.ref(), headSha: head };
  }

  private ref(): Extract<ChangeRef, { host: "github" }> {
    return { host: "github", owner: REPO.owner, repo: REPO.name, number: 1 };
  }

  async push(_ref: ChangeRef, changes: Record<string, string | null>, opts: { force: boolean }) {
    const pr = this.pr;
    if (pr === null) throw new Error("no PR open");
    const before = pr.head.sha;
    const sha = this.gh.commit(pr.head.repo, pr.head.ref, changes, opts.force ? pr.base.sha : undefined);
    this.gh.setHead(pr, sha);
    await this.sync.handle(this.gh.pullRequestDelivery("synchronize", pr, before));
    await this.job.release();
    return sha;
  }

  async holdRuns(hold: boolean) {
    const { ci } = this.env.ports;
    ci.autoFinish = !hold;
    if (hold) return;
    for (const [runId, run] of ci.runs) {
      if (run.status.status === "running") await ci.finish(runId);
    }
  }

  async settle() {
    await this.env.settle();
    await this.job.release();
  }

  /** What GitHub shows: the completed check run's conclusion, read back as a routing action. */
  private actionOf(headSha: string): LaneAction | null {
    const run = this.gh.laneRun(headSha);
    if (run === null || run.status !== "completed") return null;
    if ((run.output.title ?? "").includes("Blocked")) return "blocked";
    if (run.conclusion === "success") return laneZeroAction(this.adapter.capabilities()).action;
    return run.conclusion === "neutral" || run.conclusion === "action_required" ? "request-review" : null;
  }

  async observe(ref: ChangeRef, headSha: string): Promise<Observed> {
    if (ref.host !== "github") throw new Error("not a GitHub ref");
    const { store, signer, ci } = this.env.ports;
    const changeId = changeIdFor(REPO.id, ref.number);
    const [cls, evidence] = await Promise.all([
      store.getClassification(changeId, headSha),
      store.getEvidence(changeId, headSha),
    ]);
    const tour = [...store.tours.values()].find((t) => t.changeId === changeId && t.headSha === headSha) ?? null;
    const runs = [...ci.runs.values()].filter((r) => r.request.changeId === changeId && r.request.headSha === headSha);
    return {
      verdict:
        cls === null
          ? null
          : {
              headSha,
              lane: cls.lane,
              computedLane: cls.computedLane,
              shadow: cls.shadow,
              blocked: cls.blocked,
              requiresHumanApproval: cls.requiresHumanApproval,
              reasons: cls.reasons.map((r) => r.code),
            },
      action: this.actionOf(headSha),
      evidence:
        evidence === null
          ? null
          : { kinds: [...new Set(evidence.items.map((i) => i.kind))].sort(), verified: (await signer.verifyEvidence(evidence)).ok },
      tour,
      run: runs.at(-1)?.status.status ?? null,
    };
  }

  async verdictHeads(ref: ChangeRef): Promise<string[]> {
    if (ref.host !== "github") throw new Error("not a GitHub ref");
    const subject = `change:${changeIdFor(REPO.id, ref.number)}`;
    const { audit } = this.env.ports;
    return audit.events.flatMap((e, i) =>
      e.subject === subject && e.action === "change.classified" ? [(audit.payloads[i] as { headSha: string }).headSha] : [],
    );
  }
}

export const githubContractHost: ContractHostFactory = {
  name: "github (recorded fixtures)",
  create: async ({ reviewer }) => new GithubContractHost(reviewer),
};
