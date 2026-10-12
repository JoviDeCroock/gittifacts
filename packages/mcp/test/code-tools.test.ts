import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPlatformClient, type PlatformClient } from "../src/client.js";
import { PATCH_BUDGET } from "../src/tools/code.js";
import { fakeBackend } from "./support/fake-backend.js";
import { bearerFor, serveMcp } from "./support/http-server.js";

const backend = fakeBackend();
let server: Awaited<ReturnType<typeof serveMcp>>;
let mcp: PlatformClient;

beforeAll(async () => {
  server = await serveMcp(backend);
  mcp = await createPlatformClient(server.url, bearerFor("ag_1"));
});

afterAll(async () => {
  await mcp.client.close();
  await server.close();
});

describe("code tools", () => {
  it("get_commit returns unified patches within the budget, the rest without one", async () => {
    const res = await mcp.tools.get_commit({ repoId: "repo_1", sha: "b".repeat(40) });
    if (res.isError) throw new Error(JSON.stringify(res.content));
    const r = res.structuredContent;
    expect(r.commit.landedBy?.changeId).toBe("chg_1");
    expect(r.commit.message).toContain("body");
    const [a, b] = r.files;
    expect(a?.patch?.startsWith("@@ -0,0 +1 @@\n+xxx")).toBe(true);
    expect((a?.patch?.length ?? 0) <= PATCH_BUDGET).toBe(true);
    // The second 150k-character patch would overrun the 200k budget: listed, no patch.
    expect(b).toMatchObject({ path: "b.ts", additions: 1, patch: null });
  });

  it("hands a person the same view (url) and passes paths through", async () => {
    const files = await mcp.tools.list_repo_files({ repoId: "repo_1", path: "src" });
    if (files.isError) throw new Error(JSON.stringify(files.content));
    expect(files.structuredContent.url).toBe("https://gittifacts.test/repos/repo_1/tree/src");
    expect(backend.calls).toContain("listRepoFiles:repo_1:src");
    const res = await mcp.tools.list_commits({ repoId: "repo_1" });
    if (res.isError) throw new Error(JSON.stringify(res.content));
    const log = res.structuredContent;
    expect(log.commits.map((c) => c.title)).toEqual(["Round totals", "initial"]);
    expect(log.commits[0]?.url).toBe(
      `https://gittifacts.test/repos/repo_1/commits/${"b".repeat(40)}`,
    );
    const act = await mcp.tools.get_commit_activity({ repoId: "repo_1" });
    if (act.isError) throw new Error(JSON.stringify(act.content));
    expect(act.structuredContent.total).toBe(2);
  });
});
