// biome-ignore-all lint/suspicious/noAssignInExpressions: the router matches `(m = re.exec(path))` per route
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
  output: { title?: string; summary?: string; text?: string };
  actions?: unknown[];
  updates: number;
  /** Every state the run showed, in order (status, conclusion, title). */
  history: { status: string; conclusion: string | null; title: string | null }[];
}

const fullName = (r: FakeRepo) => `${r.owner}/${r.name}`;
export const gitName = (r: FakeRepo) => `github.com/${fullName(r)}`;

export interface FakeReview {
  id: number;
  node_id: string;
  commit_id: string;
  body: string;
  event: string;
  comments: {
    id: number;
    node_id: string;
    path: string;
    line: number;
    side: string;
    body: string;
    minimized: boolean;
  }[];
  minimized: boolean;
}

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  user: { login: string; id: number; type: string };
  labels: string[];
  events: {
    event: string;
    label: { name: string };
    actor: { login: string; id: number; type: string };
    created_at: string;
  }[];
}

export class FakeGithub {
  readonly pulls = new Map<number, FakePull>();
  readonly checkRuns = new Map<number, FakeCheckRun>();
  readonly reviews = new Map<number, FakeReview>();
  readonly comments = new Map<number, { id: number; body: string; edits: number }>();
  readonly reactions: { commentId: number; content: string }[] = [];
  readonly issues = new Map<number, FakeIssue>();
  /** Merged PRs (what GraphQL `pullRequests(states: MERGED)` answers; the backtest's listing). */
  readonly merged: {
    number: number;
    title: string;
    body: string | null;
    createdAt: string;
    mergedAt: string;
    headRefName: string;
    author: { login: string; id: number; type: string };
    mergeSha: string;
    files: string[];
    labels: string[];
  }[] = [];
  /** login → GitHub permission ("admin" | "write" | "read" | "none"). */
  readonly permissions = new Map<string, string>();
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
  commit(
    repo: FakeRepo,
    branch: string,
    changes: Record<string, string | null>,
    from?: string,
  ): string {
    const r = this.git.repo(gitName(repo));
    const ref = `refs/heads/${branch}`;
    if (from !== undefined) r.refs.set(ref, from);
    else if (!r.refs.has(ref))
      r.refs.set(ref, r.refs.get(`refs/heads/${repo.defaultBranch}`) ?? "");
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
    const owner = {
      ...(base.owner as object),
      login: r.owner,
      id: r.id * 10,
      type: "Organization",
    };
    return {
      ...base,
      id: r.id,
      name: r.name,
      full_name: fullName(r),
      owner,
      private: r.private,
      default_branch: r.defaultBranch,
      html_url: `https://github.com/${fullName(r)}`,
    };
  }

  pullJson(pr: FakePull): Record<string, unknown> {
    const base = clone(load("rest", "pull-request"));
    const branch = (b: Record<string, unknown>, ref: string, sha: string, repo: FakeRepo) => ({
      ...b,
      ref,
      sha,
      label: `${repo.owner}:${ref}`,
      repo: this.repoJson(repo),
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
  pullRequestDelivery(
    action: "opened" | "synchronize" | "closed" | "reopened",
    pr: FakePull,
    before?: string,
  ) {
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
    if (req.headers.get("x-github-api-version") !== "2026-03-10")
      return Response.json({ message: "version" }, { status: 400 });
    if (!auth.startsWith("Bearer "))
      return Response.json({ message: "Requires authentication" }, { status: 401 });
    const body =
      method === "GET" || method === "DELETE"
        ? null
        : ((await req.json()) as Record<string, unknown>);
    const repoPath = `/repos/${fullName(this.repo)}`;
    let m: RegExpExecArray | null;
    if (method === "POST" && (m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path))) {
      this.tokens.minted++;
      this.tokens.scopes.push(body);
      const t = load("rest", "installation-token");
      return Response.json(
        { ...t, token: `ghs_fake_${this.tokens.minted}`, expires_at: "2030-01-01T00:00:00Z" },
        { status: 201 },
      );
    }
    if (method === "DELETE" && path === "/installation/token") {
      this.tokens.revoked++;
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && (m = new RegExp(`^${repoPath}/pulls/(\\d+)$`).exec(path))) {
      const pr = this.pulls.get(Number(m[1]));
      return pr === undefined
        ? Response.json({ message: "Not Found" }, { status: 404 })
        : Response.json(this.pullJson(pr), { headers: { etag: `"${pr.head.sha}"` } });
    }
    if (
      method === "GET" &&
      (m = new RegExp(`^${repoPath}/compare/([0-9a-f]{40})\\.\\.\\.([0-9a-f]{40})$`).exec(path))
    ) {
      const c = clone(load("rest", "commit-comparison"));
      const sha = this.mergeBase(m[1] as string, m[2] as string);
      return Response.json({
        ...c,
        merge_base_commit: { ...(c.merge_base_commit as object), sha },
      });
    }
    if (method === "POST" && (m = new RegExp(`^${repoPath}/pulls/(\\d+)/reviews$`).exec(path))) {
      this.writes.push("POST reviews");
      const b = body as {
        commit_id: string;
        body: string;
        event: string;
        comments: { path: string; line: number; side: string; body: string }[];
      };
      const pr = this.pulls.get(Number(m[1]));
      // GitHub refuses a review whose comments aren't on lines of the diff (422).
      if (pr === undefined || b.comments.some((c) => c.line < 1))
        return Response.json({ message: "Unprocessable" }, { status: 422 });
      const id = this.nextId++;
      const review: FakeReview = {
        id,
        node_id: `PRR_${id}`,
        commit_id: b.commit_id,
        body: b.body,
        event: b.event,
        minimized: false,
        comments: b.comments.map((c) => {
          const cid = this.nextId++;
          return { ...c, id: cid, node_id: `PRRC_${cid}`, minimized: false };
        }),
      };
      this.reviews.set(id, review);
      return Response.json({
        ...clone(load("rest", "pull-request")),
        id,
        node_id: review.node_id,
        body: b.body,
        commit_id: b.commit_id,
        state: "COMMENTED",
      });
    }
    if (
      method === "GET" &&
      (m = new RegExp(`^${repoPath}/pulls/\\d+/reviews/(\\d+)/comments$`).exec(path))
    ) {
      return Response.json(this.reviews.get(Number(m[1]))?.comments ?? []);
    }
    if (
      method === "PUT" &&
      (m = new RegExp(`^${repoPath}/pulls/\\d+/reviews/(\\d+)$`).exec(path))
    ) {
      this.writes.push("PUT review");
      const r = this.reviews.get(Number(m[1]));
      if (r === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
      r.body = String((body as { body: string }).body);
      return Response.json({ id: r.id, body: r.body });
    }
    if (method === "PATCH" && (m = new RegExp(`^${repoPath}/pulls/comments/(\\d+)$`).exec(path))) {
      this.writes.push("PATCH review comment");
      for (const r of this.reviews.values()) {
        const c = r.comments.find((x) => x.id === Number(m?.[1]));
        if (c !== undefined) c.body = String((body as { body: string }).body);
      }
      return Response.json({ id: Number(m[1]) });
    }
    if (
      method === "POST" &&
      path === "/graphql" &&
      String((body as { query: string }).query).includes("pullRequests(states: MERGED")
    ) {
      // One page, newest update first, in GitHub's response shape.
      const nodes = [...this.merged].reverse().map((m) => ({
        number: m.number,
        title: m.title,
        body: m.body,
        createdAt: m.createdAt,
        mergedAt: m.mergedAt,
        updatedAt: m.mergedAt,
        headRefName: m.headRefName,
        baseRefName: this.repo.defaultBranch,
        author: {
          __typename: m.author.type === "Bot" ? "Bot" : "User",
          login: m.author.login,
          databaseId: m.author.id,
        },
        mergeCommit: { oid: m.mergeSha },
        files: { nodes: m.files.map((path) => ({ path, additions: 1, deletions: 1 })) },
        labels: { nodes: m.labels.map((name) => ({ name })) },
        closingIssuesReferences: { nodes: [] },
      }));
      return Response.json({
        data: {
          repository: {
            pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
          },
          rateLimit: { cost: 1, remaining: 4999 },
        },
      });
    }
    if (
      method === "POST" &&
      path === "/graphql" &&
      String((body as { query: string }).query).includes("defaultBranchRef")
    ) {
      return Response.json({
        data: {
          repository: { defaultBranchRef: { target: { oid: this.git.head(gitName(this.repo)) } } },
        },
      });
    }
    if (method === "POST" && path === "/graphql") {
      this.writes.push("POST graphql");
      const id = (body as { variables: { id: string } }).variables.id;
      for (const r of this.reviews.values()) {
        if (r.node_id === id) r.minimized = true;
        for (const c of r.comments) if (c.node_id === id) c.minimized = true;
      }
      return Response.json({
        data: { minimizeComment: { minimizedComment: { isMinimized: true } } },
      });
    }
    if (method === "POST" && (m = new RegExp(`^${repoPath}/issues/\\d+/comments$`).exec(path))) {
      this.writes.push("POST issue comment");
      const id = this.nextId++;
      this.comments.set(id, { id, body: String((body as { body: string }).body), edits: 0 });
      return Response.json({ id }, { status: 201 });
    }
    if (
      method === "POST" &&
      (m = new RegExp(`^${repoPath}/issues/comments/(\\d+)/reactions$`).exec(path))
    ) {
      this.writes.push("POST reaction");
      this.reactions.push({
        commentId: Number(m[1]),
        content: String((body as { content: string }).content),
      });
      return Response.json({ id: this.nextId++ }, { status: 201 });
    }
    if (method === "PATCH" && (m = new RegExp(`^${repoPath}/issues/comments/(\\d+)$`).exec(path))) {
      this.writes.push("PATCH issue comment");
      const c = this.comments.get(Number(m[1]));
      if (c === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
      c.body = String((body as { body: string }).body);
      c.edits++;
      return Response.json({ id: c.id });
    }
    if (
      method === "GET" &&
      (m = new RegExp(`^${repoPath}/collaborators/([^/]+)/permission$`).exec(path))
    ) {
      const permission = this.permissions.get(decodeURIComponent(m[1] as string)) ?? "none";
      return Response.json({ permission, role_name: permission, user: { login: m[1] } });
    }
    if (method === "GET" && (m = new RegExp(`^${repoPath}/issues/(\\d+)$`).exec(path))) {
      const i = this.issues.get(Number(m[1]));
      if (i === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json({
        number: i.number,
        title: i.title,
        body: i.body,
        user: i.user,
        labels: i.labels.map((name) => ({ name })),
      });
    }
    if (method === "GET" && (m = new RegExp(`^${repoPath}/issues/(\\d+)/events$`).exec(path))) {
      return Response.json(this.issues.get(Number(m[1]))?.events ?? []);
    }
    if (method === "POST" && path === `${repoPath}/check-runs`) {
      this.writes.push("POST check-runs");
      const run: FakeCheckRun = {
        ...(clone(load("rest", "check-run")) as object),
        ...(body as object),
        id: this.nextId++,
        updates: 0,
      } as FakeCheckRun;
      // The recorded run is a completed one: a run created without a conclusion has none.
      run.conclusion = (body as { conclusion?: string }).conclusion ?? null;
      run.history = [
        { status: run.status, conclusion: run.conclusion, title: run.output.title ?? null },
      ];
      this.checkRuns.set(run.id, run);
      return Response.json(run, { status: 201 });
    }
    if (method === "GET" && (m = new RegExp(`^${repoPath}/check-runs/(\\d+)$`).exec(path))) {
      const run = this.checkRuns.get(Number(m[1]));
      return run === undefined
        ? Response.json({ message: "Not Found" }, { status: 404 })
        : Response.json(run);
    }
    if (method === "PATCH" && (m = new RegExp(`^${repoPath}/check-runs/(\\d+)$`).exec(path))) {
      this.writes.push("PATCH check-runs");
      const run = this.checkRuns.get(Number(m[1]));
      if (run === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
      Object.assign(run, body, { updates: run.updates + 1 });
      run.history.push({
        status: run.status,
        conclusion: run.conclusion ?? null,
        title: run.output.title ?? null,
      });
      return Response.json(run);
    }
    return Response.json({ message: `fake GitHub has no ${method} ${path}` }, { status: 404 });
  }) as typeof fetch;

  /** Recorded `pull_request_review` (submitted) delivery for a review by `user` at `commitId`. */
  reviewDelivery(
    pr: FakePull,
    user: { login: string; id: number; type: string },
    state: "approved" | "changes_requested" | "commented",
    commitId: string,
  ) {
    const payload = clone(load("webhooks", "pull_request_review_submitted"));
    const review = {
      ...(payload.review as object),
      id: this.nextId++,
      state,
      commit_id: commitId,
      user: { ...user, node_id: "U" },
    };
    Object.assign(payload, {
      action: "submitted",
      review,
      pull_request: this.pullJson(pr),
      repository: this.repoJson(),
      installation: { id: this.installationId },
    });
    return { event: "pull_request_review", payload };
  }

  /** A `check_run` requested_action delivery: someone pressed a button on our run. */
  buttonDelivery(
    runId: number,
    identifier: "approve_tour" | "full_review" | "run_qa",
    sender: { login: string; id: number; type: string },
  ) {
    const run = this.checkRuns.get(runId);
    return {
      event: "check_run",
      payload: {
        action: "requested_action",
        check_run: { ...run, id: runId, app: { id: 1180001 } },
        requested_action: { identifier },
        repository: this.repoJson(),
        sender,
        installation: { id: this.installationId },
      },
    };
  }

  /** `issue_comment` created on a pull request (or on a plain issue with `onIssue`). */
  commentDelivery(
    pr: FakePull,
    user: { login: string; id: number; type: string },
    body: string,
    opts: { onIssue?: boolean } = {},
  ) {
    const issue = { number: pr.number, ...(opts.onIssue ? {} : { pull_request: { url: "x" } }) };
    const comment = { id: this.nextId++, body, user };
    return {
      event: "issue_comment",
      payload: {
        action: "created",
        issue,
        comment,
        repository: this.repoJson(),
        sender: user,
        installation: { id: this.installationId },
      },
    };
  }

  /** `pull_request` edited / labeled delivery (the PR object is the current one). */
  editDelivery(pr: FakePull, action: "edited" | "labeled", changes: Record<string, unknown> = {}) {
    const payload = clone(load("webhooks", "pull_request_opened"));
    Object.assign(payload, {
      action,
      number: pr.number,
      changes,
      pull_request: this.pullJson(pr),
      repository: this.repoJson(),
      installation: { id: this.installationId },
    });
    return { event: "pull_request", payload };
  }

  /** `issues` labeled delivery. */
  issueLabelDelivery(issue: FakeIssue, label: string) {
    return {
      event: "issues",
      payload: {
        action: "labeled",
        issue: { number: issue.number },
        label: { name: label },
        repository: this.repoJson(),
        installation: { id: this.installationId },
      },
    };
  }

  /** The completed `gittifacts/lane` run for a head, if any. */
  laneRun(headSha: string): FakeCheckRun | null {
    return (
      [...this.checkRuns.values()].find(
        (r) => r.head_sha === headSha && r.name === "gittifacts/lane",
      ) ?? null
    );
  }
}
