/**
 * Browsing a repo's code and history (workerd: the platform's HTTP + MCP over D1; Artifacts is
 * the fake GitHost). A person and an agent read the same things: an empty repo answers
 * `empty-repo` (tree) and an empty history; then the tree (directories first, the README inlined),
 * files (text, binary, raw and inert), traversal refused, the first-parent log paged, each commit
 * linked to the Change that landed it, one commit's diff (a root commit against the empty tree),
 * and commit activity. Someone without access to the repo sees none of it (404).
 */

import { env } from "cloudflare:workers";
import { createPlatformClient } from "@app/mcp/client";
import { beforeEach, describe, expect, it } from "vitest";
import { call, json, ORIGIN, signUpHuman } from "../http.js";
import { type IntegrationFakes, resetIntegrationFakes } from "./fakes.js";
import { fetchVia, platformApp } from "./harness.js";

let fakes: IntegrationFakes;

beforeEach(() => {
  fakes = resetIntegrationFakes();
});

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

describe("code browsing (workerd)", () => {
  it("a person and an agent read the tree, files, history, commits and activity", async () => {
    const app = platformApp();
    const ada = await signUpHuman(app, "Ada");
    const created = await call(app, "POST", "/api/v1/repos", {
      cookie: ada.cookie,
      body: { name: `browse-${Date.now().toString(36)}` },
    });
    expect(created.status).toBe(201);
    const { repo } = await json<{ repo: { id: string; artifactsName: string } }>(created);
    const get = (path: string, cookie = ada.cookie) =>
      call(app, "GET", `/api/v1/repos/${repo.id}${path}`, { cookie });

    // Nothing has landed yet: the tree says so with a fix, history and activity are empty.
    fakes.git.repos.set(repo.artifactsName, {
      name: repo.artifactsName,
      defaultBranch: "main",
      refs: new Map(),
      objects: new Set(),
      notes: new Map(),
    });
    const empty = await get("/tree");
    expect(empty.status).toBe(404);
    const emptyBody = await json<{ error: { code: string; fix: { command?: string } } }>(empty);
    expect(emptyBody.error.code).toBe("empty-repo");
    expect(emptyBody.error.fix.command).toBe(`gittifacts clone ${repo.id}`);
    expect(await json(await get("/commits"))).toEqual({
      ref: "main",
      headSha: null,
      commits: [],
      nextOffset: null,
    });
    expect(await json(await get("/activity?weeks=2"))).toMatchObject({ headSha: null, total: 0 });

    // History: a root commit 30 days ago, a direct push 3 days ago, a Change landed today.
    const ada0 = { name: "Ada", email: "ada@example.test" };
    const root = fakes.git.seed(
      repo.artifactsName,
      {
        "README.md": "# Billing\n\nSplits the bill.\n",
        "src/money.ts": "export const round = (n: number) => Math.round(n);\n",
        "src/lib/cents.ts": "export const cents = 100;\n",
        "logo.png": "\u0089PNG\u0000\u0001",
      },
      { message: "Initial commit\n\nThe skeleton.", author: ada0, at: now() - 30 * DAY },
    );
    const pushed = fakes.git.commit(
      repo.artifactsName,
      "main",
      { "docs/notes.md": "notes\n" },
      "Add notes",
      { author: ada0, at: now() - 3 * DAY },
    );
    const agent = await call(app, "POST", "/api/v1/principals/agents", {
      cookie: ada.cookie,
      body: { name: "agent-7", scopes: ["repo:read", "plan:create", "change:create"] },
    });
    expect(agent.status).toBe(201);
    const { token } = await json<{ token: string }>(agent);
    const mcp = await createPlatformClient(`${ORIGIN}/mcp`, token, { fetch: fetchVia(app) });
    const started = await mcp.tools.start_change({
      repoId: repo.id,
      title: "Round half up",
      category: "fix",
    });
    if (started.isError) throw new Error(JSON.stringify(started.content));
    const changeId = started.structuredContent.change.id;
    // What the merge queue does on landing: a commit on main, recorded as the Change's mergedSha.
    const landed = fakes.git.commit(
      repo.artifactsName,
      "main",
      { "src/money.ts": "export const round = (n: number) => Math.floor(n + 0.5);\n" },
      "Round half up",
      { author: { name: "agent-7", email: "agent-7@agents.test" }, at: now() - 60 },
    );
    await env.DB.prepare("UPDATE changes SET status = 'merged', merged_sha = ? WHERE id = ?")
      .bind(landed, changeId)
      .run();

    // The tree: directories first, then files, the README inlined.
    const tree = await json<{
      commitSha: string;
      entries: Array<{ name: string; path: string; kind: string }>;
      readme: { path: string; text: string } | null;
    }>(await get("/tree"));
    expect(tree.commitSha).toBe(landed);
    expect(tree.entries.map((e) => [e.name, e.kind])).toEqual([
      ["docs", "dir"],
      ["src", "dir"],
      ["README.md", "file"],
      ["logo.png", "file"],
    ]);
    expect(tree.readme).toMatchObject({
      path: "README.md",
      text: "# Billing\n\nSplits the bill.\n",
    });
    const src = await json<{ entries: Array<{ path: string }> }>(await get("/tree?path=src/"));
    expect(src.entries.map((e) => e.path)).toEqual(["src/lib", "src/money.ts"]);
    // An older ref still reads, and a file is not a directory.
    const atRoot = await json<{ entries: Array<{ name: string }> }>(await get(`/tree?ref=${root}`));
    expect(atRoot.entries.map((e) => e.name)).toEqual(["src", "README.md", "logo.png"]);
    expect((await get("/tree?path=src/money.ts")).status).toBe(400);
    expect((await get("/tree?path=src/../..")).status).toBe(400);
    expect((await get("/tree?ref=nope")).status).toBe(404);
    expect((await get("/tree?ref=main..x")).status).toBe(400);

    // Files: text, binary without content, raw bytes served inert.
    const file = await json<{ file: { kind: string; text: string | null; size: number } }>(
      await get("/file?path=src/money.ts"),
    );
    expect(file.file).toMatchObject({ kind: "text", text: expect.stringContaining("+ 0.5") });
    expect(
      (await json<{ file: { kind: string; text: null } }>(await get("/file?path=logo.png"))).file,
    ).toMatchObject({ kind: "binary", text: null });
    expect((await get("/file?path=src")).status).toBe(400);
    expect((await get("/file?path=nope.ts")).status).toBe(404);
    const raw = await get("/raw?path=README.md");
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(raw.headers.get("content-security-policy")).toMatch(/^default-src 'none'; sandbox\b/);
    expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await raw.text()).toContain("Splits the bill");
    expect((await get("/raw?path=logo.png")).headers.get("content-type")).toBe("image/png");

    // History, paged; the landed commit names its Change.
    type Log = {
      commits: Array<{ sha: string; title: string; landedBy: { changeId: string } | null }>;
      nextOffset: number | null;
    };
    const page1 = await json<Log>(await get("/commits?limit=2"));
    expect(page1.commits.map((c) => c.sha)).toEqual([landed, pushed]);
    expect(page1.commits[0]?.landedBy).toMatchObject({
      changeId,
      title: "Round half up",
      authorKind: "agent",
      authorName: "agent-7",
    });
    expect(page1.commits[1]?.landedBy).toBeNull();
    expect(page1.nextOffset).toBe(2);
    const page2 = await json<Log>(await get("/commits?limit=2&offset=2"));
    expect(page2.commits.map((c) => [c.sha, c.title])).toEqual([[root, "Initial commit"]]);
    expect(page2.nextOffset).toBeNull();

    // One commit: its diff against the first parent; a root commit against the empty tree.
    type Detail = {
      commit: { message: string; author: { name: string; at: string | null } };
      diff: {
        parentSha: string | null;
        complete: boolean;
        files: Array<{ path: string; status: string; additions: number; deletions: number }>;
      };
    };
    const change = await json<Detail>(await get(`/commits/${landed}`));
    expect(change.diff.parentSha).toBe(pushed);
    expect(change.diff.files).toEqual([
      expect.objectContaining({
        path: "src/money.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
      }),
    ]);
    const first = await json<Detail>(await get(`/commits/${root}`));
    expect(first.commit.message).toBe("Initial commit\n\nThe skeleton.");
    expect(first.commit.author.name).toBe("Ada");
    expect(first.diff.parentSha).toBeNull();
    expect(first.diff.complete).toBe(true);
    expect(first.diff.files.map((f) => [f.path, f.status])).toEqual([
      ["README.md", "added"],
      ["logo.png", "added"],
      ["src/lib/cents.ts", "added"],
      ["src/money.ts", "added"],
    ]);
    expect((await get(`/commits/${"f".repeat(40)}`)).status).toBe(404);
    expect((await get("/commits/HEAD")).status).toBe(400);

    // Activity over whole Monday-aligned weeks: two weeks reach back 7 to 13 days (the push, not
    // the root commit, whatever the weekday); six weeks reach 35 or more.
    const week = await json<{
      total: number;
      authors: unknown;
      truncated: boolean;
      days: unknown[];
    }>(await get("/activity?weeks=2"));
    expect(week.total).toBe(2);
    expect(week.truncated).toBe(false);
    const all = await json<{ total: number; authors: unknown }>(await get("/activity?weeks=6"));
    expect(all.total).toBe(3);
    expect(all.authors).toEqual([
      { name: "Ada", commits: 2 },
      { name: "agent-7", commits: 1 },
    ]);

    // The agent reads the same through MCP, with the page to hand a person.
    const files = await mcp.tools.list_repo_files({ repoId: repo.id, path: "src" });
    if (files.isError) throw new Error(JSON.stringify(files.content));
    expect(files.structuredContent.entries.map((e) => e.path)).toEqual(["src/lib", "src/money.ts"]);
    expect(files.structuredContent.url).toBe(`${ORIGIN}/repos/${repo.id}/tree/src`);
    const read = await mcp.tools.read_repo_file({
      repoId: repo.id,
      path: "src/money.ts",
      ref: root,
    });
    if (read.isError) throw new Error(JSON.stringify(read.content));
    expect(read.structuredContent.text).toContain("Math.round");
    const log = await mcp.tools.list_commits({ repoId: repo.id, limit: 1 });
    if (log.isError) throw new Error(JSON.stringify(log.content));
    expect(log.structuredContent.commits[0]?.landedBy?.changeId).toBe(changeId);
    expect(log.structuredContent.nextOffset).toBe(1);
    const one = await mcp.tools.get_commit({ repoId: repo.id, sha: landed });
    if (one.isError) throw new Error(JSON.stringify(one.content));
    expect(one.structuredContent.files[0]?.patch).toContain(
      "+export const round = (n: number) => Math.floor(n + 0.5);",
    );
    expect(one.structuredContent.commit.url).toBe(`${ORIGIN}/repos/${repo.id}/commits/${landed}`);
    const act = await mcp.tools.get_commit_activity({ repoId: repo.id, weeks: 6 });
    if (act.isError) throw new Error(JSON.stringify(act.content));
    expect(act.structuredContent.total).toBe(3);
    const missing = await mcp.tools.read_repo_file({ repoId: repo.id, path: "src" });
    expect(missing.isError).toBe(true);
    await mcp.client.close();

    // Without access to the repo, none of it exists.
    const eve = await signUpHuman(app, "Eve");
    for (const path of [
      "/tree",
      "/file?path=README.md",
      "/raw?path=README.md",
      "/commits",
      `/commits/${root}`,
      "/activity",
    ])
      expect((await get(path, eve.cookie)).status, path).toBe(404);
  });
});
