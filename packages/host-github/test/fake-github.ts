/**
 * A recorded-fixture GitHub: the REST answers and webhook bodies are GitHub's own examples
 * (OAS `components.examples`, octokit/webhooks payload-examples) with the ids, shas and names of
 * the scenario substituted in. Git objects live in the fake Artifacts host under
 * `github.com/<owner>/<repo>`, so a mirror fetch is an object copy, and PR heads (fork PRs too)
 * are reachable from the base repo the way GitHub serves `refs/pull/<n>/head`.
 */
import { readFileSync } from "node:fs";
import type { FakeGitHost, Files } from "@app/coordinator/fakes";

const load = (dir: string, name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/${dir}/${name}.json`, import.meta.url), "utf8"));
const clone = <T>(v: T): T => structuredClone(v);

export interface FakeRepo {
  id: number;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
}

export interface FakePull {
  number: number;
  title: string;
  body: string;
  labels: string[];
  user: { login: string; id: number; type: string };
  head: { ref: string; sha: string; repo: FakeRepo };
  base: { ref: string; sha: string };
  state: "open" | "closed";
  merged: boolean;
}

export interface FakeCheckRun {
  id: number;
  head_sha: string;
  name: string;
  status: string;
  conclusion: string | null;
  output: { title?: string; summary?: string };
  actions?: unknown[];
  updates: number;
}

const fullName = (r: FakeRepo) => `${r.owner}/${r.name}`;
export const gitName = (r: FakeRepo) => `github.com/${fullName(r)}`;

export class FakeGithub {
  readonly pulls = new Map<number, FakePull>();
  readonly checkRuns = new Map<number, FakeCheckRun>();
  readonly tokens = { minted: 0, revoked: 0, scopes: [] as unknown[] };
  readonly writes: string[] = [];
  private nextId = 1000;

  constructor(
    readonly git: FakeGitHost,
    readonly repo: FakeRepo,
    readonly installationId = 4242,
  ) {}

  seed(files: Files): string {
    return this.git.seed(gitName(this.repo), files, { defaultBranch: this.repo.defaultBranch });
  }

  /** A fork of the repo owned by someone else (its objects start as the base's). */
  fork(owner: string): FakeRepo {
    const f: FakeRepo = { ...this.repo, id: this.repo.id + 7, owner };
    void this.git.forkRepo(gitName(this.repo), gitName(f));
    return f;
  }

  /** Commit on a branch of `repo` (on top of `from` when given: a force-push). */
  commit(repo: FakeRepo, branch: string, changes: Record<string, string | null>, from?: string): string {
    const r = this.git.repo(gitName(repo));
    const ref = `refs/heads/${branch}`;
    if (from !== undefined) r.refs.set(ref, from);
    else if (!r.refs.has(ref)) r.refs.set(ref, r.refs.get(`refs/heads/${repo.defaultBranch}`) ?? "");
    return this.git.commit(gitName(repo), branch, changes);
  }

  /** What GitHub does with a PR head: `refs/pull/<n>/head` in the base repo. */
  setHead(pr: FakePull, sha: string): void {
    pr.head.sha = sha;
    this.git.copyObjects(gitName(this.repo), sha);
    this.git.repo(gitName(this.repo)).refs.set(`refs/pull/${pr.number}/head`, sha);
  }

  repoJson(r: FakeRepo = this.repo): Record<string, unknown> {
    const base = clone(load("rest", "full-repository"));
    const owner = { ...(base.owner as object), login: r.owner, id: r.id * 10, type: "Organization" };
    return { ...base, id: r.id, name: r.name, full_name: fullName(r), owner, private: r.private, default_branch: r.defaultBranch, html_url: `https://github.com/${fullName(r)}` };
  }

  pullJson(pr: FakePull): Record<string, unknown> {
    const base = clone(load("rest", "pull-request"));
    const branch = (b: Record<string, unknown>, ref: string, sha: string, repo: FakeRepo) => ({
      ...b, ref, sha, label: `${repo.owner}:${ref}`, repo: this.repoJson(repo),
    });
    return {
      ...base,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      draft: false,
      merged: pr.merged,
      merge_commit_sha: pr.merged ? pr.head.sha : null,
      html_url: `https://github.com/${fullName(this.repo)}/pull/${pr.number}`,
      user: { ...(base.user as object), ...pr.user },
      labels: pr.labels.map((name, i) => ({ id: i + 1, name, color: "ededed", default: false })),
      head: branch(base.head as Record<string, unknown>, pr.head.ref, pr.head.sha, pr.head.repo),
      base: branch(base.base as Record<string, unknown>, pr.base.ref, pr.base.sha, this.repo),
      maintainer_can_modify: false,
    };
  }

  /** A recorded `pull_request` delivery with this PR substituted in. */
  pullRequestDelivery(action: "opened" | "synchronize" | "closed" | "reopened", pr: FakePull, before?: string) {
    const payload = clone(load("webhooks", `pull_request_${action}`));
    Object.assign(payload, {
      action,
      number: pr.number,
      pull_request: this.pullJson(pr),
      repository: this.repoJson(),
      installation: { id: this.installationId, node_id: "MDIz" },
      ...(action === "synchronize" ? { before, after: pr.head.sha } : {}),
    });
    return { event: "pull_request", payload };
  }

  /** The merge base: the newest ancestor of `head` that is also an ancestor of `base`. */
  mergeBase(base: string, head: string): string {
    const ofBase = this.git.reachable(base);
    return this.git.ancestry(head).find((s) => ofBase.has(s)) ?? base;
  }

  /** api.github.com, as a `fetch`. */
  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const auth = req.headers.get("authorization") ?? "";
    if (req.headers.get("x-github-api-version") !== "2026-03-10") return Response.json({ message: "version" }, { status: 400 });
    if (!auth.startsWith("Bearer ")) return Response.json({ message: "Requires authentication" }, { status: 401 });
    const body = method === "GET" || method === "DELETE" ? null : ((await req.json()) as Record<string, unknown>);
    const repoPath = `/repos/${fullName(this.repo)}`;
    let m: RegExpExecArray | null;
    if (method === "POST" && (m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path))) {
      this.tokens.minted++;
      this.tokens.scopes.push(body);
      const t = load("rest", "installation-token");
      return Response.json({ ...t, token: `ghs_fake_${this.tokens.minted}`, expires_at: "2030-01-01T00:00:00Z" }, { status: 201 });
    }
    if (method === "DELETE" && path === "/installation/token") {
      this.tokens.revoked++;
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && (m = new RegExp(`^${repoPath}/pulls/(\\d+)$`).exec(path))) {
      const pr = this.pulls.get(Number(m[1]));
      return pr === undefined ? Response.json({ message: "Not Found" }, { status: 404 }) : Response.json(this.pullJson(pr), { headers: { etag: `"${pr.head.sha}"` } });
    }
    if (method === "GET" && (m = new RegExp(`^${repoPath}/compare/([0-9a-f]{40})\\.\\.\\.([0-9a-f]{40})$`).exec(path))) {
      const c = clone(load("rest", "commit-comparison"));
      const sha = this.mergeBase(m[1] as string, m[2] as string);
      return Response.json({ ...c, merge_base_commit: { ...(c.merge_base_commit as object), sha } });
    }
    if (method === "POST" && path === `${repoPath}/check-runs`) {
      this.writes.push("POST check-runs");
      const run: FakeCheckRun = { ...(clone(load("rest", "check-run")) as object), ...(body as object), id: this.nextId++, updates: 0 } as FakeCheckRun;
      run.conclusion ??= null;
      this.checkRuns.set(run.id, run);
      return Response.json(run, { status: 201 });
    }
    if (method === "PATCH" && (m = new RegExp(`^${repoPath}/check-runs/(\\d+)$`).exec(path))) {
      this.writes.push("PATCH check-runs");
      const run = this.checkRuns.get(Number(m[1]));
      if (run === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
      Object.assign(run, body, { updates: run.updates + 1 });
      return Response.json(run);
    }
    return Response.json({ message: `fake GitHub has no ${method} ${path}` }, { status: 404 });
  }) as typeof fetch;

  /** The completed `gittifacts/lane` run for a head, if any. */
  laneRun(headSha: string): FakeCheckRun | null {
    return [...this.checkRuns.values()].find((r) => r.head_sha === headSha && r.name === "gittifacts/lane") ?? null;
  }
}
