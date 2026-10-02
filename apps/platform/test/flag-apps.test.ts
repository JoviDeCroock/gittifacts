/**
 * One Flagship app per project: the repo row records it with compare-and-set (two projects never
 * share one), unrelated updates never clobber it, and setting a deploy target creates it.
 */
import type { Repo } from "@app/domain";
import { describe, expect, it, vi } from "vitest";
import { deployScriptName } from "../src/services/repos.js";
import { repoFixture, store } from "./fixtures.js";
import { call, json, makeApp, signUpHuman } from "./http.js";

describe("repos.flagship_app_id", () => {
  it("is set once (compare-and-set), survives unrelated updates, and is unique", async () => {
    const s = store();
    const a = repoFixture();
    const b = repoFixture();
    await s.insertRepo(a);
    await s.insertRepo(b);
    expect((await s.getRepo(a.id))?.flagshipAppId ?? null).toBeNull();

    expect(await s.setRepoFlagshipApp(a.id, "app-a")).toBe("app-a");
    // A second writer loses and learns the recorded app.
    expect(await s.setRepoFlagshipApp(a.id, "app-a2")).toBe("app-a");
    // An update built from a row read before the app was recorded does not erase it.
    await s.updateRepo(a.id, { deployTarget: "gf-x-api" });
    expect((await s.getRepo(a.id))?.flagshipAppId).toBe("app-a");
    // Two projects can never record the same app.
    await expect(s.setRepoFlagshipApp(b.id, "app-a")).rejects.toThrow();
    expect((await s.getRepo(b.id))?.flagshipAppId ?? null).toBeNull();
  });
});

describe("PATCH deploy-target creates the project's own Flagship app", () => {
  async function world(ensureProjectFlags: (actor: unknown, repoId: string) => Promise<Repo>) {
    const spy = vi.fn(ensureProjectFlags);
    const { app } = makeApp({ ensureProjectFlags: spy });
    const human = await signUpHuman(app);
    const repo = repoFixture({
      claim: { status: "claimed", ownerId: human.principal.id, expiresAt: null },
    });
    await store().insertRepo(repo);
    return { app, human, repo, spy };
  }
  const path = (id: string) => `/api/v1/repos/${id}/deploy-target`;

  it("asks the coordinator for the app once a target is set, and returns it", async () => {
    const { app, human, repo, spy } = await world(async (_actor, repoId) => {
      await store().setRepoFlagshipApp(repoId, `app-${repoId}`);
      return (await store().getRepo(repoId)) as Repo;
    });
    const set = await json<{ repo: Repo; script: string }>(
      await call(app, "PATCH", path(repo.id), { cookie: human.cookie, body: { script: "api" } }),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(set.script).toBe(deployScriptName(repo.id, "api"));
    expect(set.repo.flagshipAppId).toBe(`app-${repo.id}`);
    // Setting it again (or another script) keeps the same app; clearing keeps it too.
    await call(app, "PATCH", path(repo.id), { cookie: human.cookie, body: { script: "web" } });
    const cleared = await json<{ repo: Repo }>(
      await call(app, "PATCH", path(repo.id), { cookie: human.cookie, body: { script: null } }),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(cleared.repo.flagshipAppId).toBe(`app-${repo.id}`);
  });

  it("still sets the target when Flagship is down (the first deploy creates the app)", async () => {
    const { app, human, repo, spy } = await world(async () => {
      throw new Error("Flagship unavailable");
    });
    const res = await call(app, "PATCH", path(repo.id), {
      cookie: human.cookie,
      body: { script: "api" },
    });
    expect(res.status).toBe(200);
    const body = await json<{ repo: Repo }>(res);
    expect(body.repo.deployTarget).toBe(deployScriptName(repo.id, "api"));
    expect(body.repo.flagshipAppId ?? null).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
