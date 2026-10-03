import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/app-env.js";
import { repoAllowed } from "../src/github/allowlist.js";
import { handleGithubEvent } from "../src/github/consumer.js";
import { adoptInstallation } from "../src/github/grading.js";
import { runGithubRedeliveries } from "../src/github/redeliver.js";
import { getInstallation, reposOf } from "../src/github/store.js";
import type { GithubEventMessage } from "../src/github/webhook.js";
import { D1Store } from "../src/store/d1-store.js";
import { store } from "./fixtures.js";
import { APP_ID, jsonRes, stubGithub } from "./github-helpers.js";

afterEach(() => vi.restoreAllMocks());

const ALLOW = { GITHUB_REPO_ALLOWLIST: "ReSynapse/fixture-lib" };
let nextInst = 6_000_000 + Math.floor(Math.random() * 100_000);
const installation = (id: number) => ({
  id,
  app_id: APP_ID,
  account: { login: "ReSynapse", id: 4242, type: "Organization" },
  repository_selection: "all",
  permissions: { metadata: "read" },
  events: ["pull_request"],
  suspended_at: null,
});
const msg = (
  event: string,
  payload: unknown,
  installationId: number | null = null,
): GithubEventMessage => ({
  v: 1,
  deliveryId: crypto.randomUUID(),
  appId: APP_ID,
  event,
  action: null,
  installationId,
  receivedAt: new Date().toISOString(),
  payload,
});

describe("GITHUB_REPO_ALLOWLIST", () => {
  it("matches owner/repo case-insensitively; unset allows everything, set refuses unknowns", () => {
    expect(repoAllowed({}, "acme/widgets")).toBe(true);
    expect(repoAllowed(ALLOW, "resynapse/Fixture-Lib")).toBe(true);
    expect(repoAllowed(ALLOW, "ReSynapse/website")).toBe(false);
    expect(repoAllowed(ALLOW, undefined)).toBe(false);
    expect(repoAllowed({ GITHUB_REPO_ALLOWLIST: " a/b , c/d " }, "C/D")).toBe(true);
  });

  it("an 'All repositories' installation records, backtests and grades only allowed repos", async () => {
    const seen = stubGithub({});
    const id = nextInst++;
    const deps = {
      db: store().db,
      blobs: env.BLOBS,
      now: () => new Date(),
      env: { ...(env as Bindings), ...ALLOW },
    };
    await handleGithubEvent(
      deps,
      msg("installation", {
        action: "created",
        installation: installation(id),
        repositories: [
          { id: 11, full_name: "ReSynapse/website", private: true },
          { id: 12, full_name: "ReSynapse/fixture-lib", private: true },
        ],
      }),
    );
    expect((await getInstallation(store().db, id))?.accountLogin).toBe("ReSynapse");
    expect((await reposOf(store().db, id)).map((r) => r.fullName)).toEqual([
      "ReSynapse/fixture-lib",
    ]);
    // A pull request in another repo of the installation: nothing fetched, nothing written.
    const repository = {
      id: 11,
      name: "website",
      full_name: "ReSynapse/website",
      private: true,
      default_branch: "main",
      owner: { login: "ReSynapse", id: 4242, type: "Organization" },
    };
    await handleGithubEvent(
      deps,
      msg("pull_request", { action: "opened", number: 1, installation: { id }, repository }, id),
    );
    expect(seen).toEqual([]);
  });

  it("the redelivery cron skips deliveries for repos outside the allowlist", async () => {
    const id = nextInst++;
    const deps = {
      db: store().db,
      blobs: env.BLOBS,
      now: () => new Date(),
      env: { ...(env as Bindings), ...ALLOW },
    };
    await handleGithubEvent(
      deps,
      msg("installation", {
        action: "created",
        installation: installation(id),
        repositories: [{ id: 912, full_name: "ReSynapse/fixture-lib", private: true }],
      }),
    );
    const now = new Date();
    const at = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
    const asked: number[] = [];
    stubGithub({
      "GET https://api.github.com/app/hook/deliveries": () =>
        jsonRes([
          {
            id: 3,
            guid: `g3-${id}`,
            delivered_at: at(1),
            redelivery: false,
            status_code: 500,
            event: "push",
            repository_id: 911,
          },
          {
            id: 2,
            guid: `g2-${id}`,
            delivered_at: at(2),
            redelivery: false,
            status_code: 500,
            event: "push",
            repository_id: 912,
          },
          {
            id: 1,
            guid: `g1-${id}`,
            delivered_at: at(3),
            redelivery: false,
            status_code: 500,
            event: "installation",
            repository_id: null,
          },
        ]),
      ...Object.fromEntries(
        [1, 2, 3].map((n) => [
          `POST https://api.github.com/app/hook/deliveries/${n}/attempts`,
          () => (asked.push(n), jsonRes({}, 202)),
        ]),
      ),
    });
    expect(await runGithubRedeliveries({ ...(env as Bindings), ...ALLOW }, now)).toBe(2);
    // Oldest first: the installation event, then the allowed repo's push.
    expect(asked).toEqual([1, 2]);
  });
});

describe("a change event for an installation we never recorded", () => {
  const repo = {
    id: 1403085431,
    name: "fixture-lib",
    full_name: "ReSynapse/fixture-lib",
    private: true,
    default_branch: "main",
    owner: { login: "ReSynapse", id: 4242, type: "Organization" },
  };
  const s = () => new D1Store(env.DB, env.BLOBS, () => new Date());
  const cfg = { ...(env as Bindings), ...ALLOW };

  it("is recorded from GitHub (App JWT) with only the event's repo, not dropped", async () => {
    const id = nextInst++;
    const seen = stubGithub({
      [`GET https://api.github.com/app/installations/${id}`]: (req) =>
        req.headers.get("authorization")?.startsWith("Bearer ey") ? jsonRes(installation(id)) : jsonRes({}, 401),
    });
    const row = await adoptInstallation(cfg, s(), id, APP_ID, repo);
    expect(row).toMatchObject({ id, appId: APP_ID, accountLogin: "ReSynapse", deletedAt: null });
    expect((await reposOf(store().db, id)).map((r) => r.fullName)).toEqual(["ReSynapse/fixture-lib"]);
    expect(seen.map((c) => c.method)).toEqual(["GET"]);
  });

  it("GitHub doesn't know it: nothing recorded; another App's: not even asked", async () => {
    const id = nextInst++;
    const seen = stubGithub({
      [`GET https://api.github.com/app/installations/${id}`]: () => jsonRes({ message: "Not Found" }, 404),
    });
    expect(await adoptInstallation(cfg, s(), id, APP_ID, repo)).toBeNull();
    expect(await getInstallation(store().db, id)).toBeNull();
    expect(await adoptInstallation(cfg, s(), id, APP_ID + 1, repo)).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it("a GitHub error throws, so the queue retries the delivery", async () => {
    const id = nextInst++;
    stubGithub({ [`GET https://api.github.com/app/installations/${id}`]: () => jsonRes({}, 502) });
    await expect(adoptInstallation(cfg, s(), id, APP_ID, repo)).rejects.toThrow(/502/);
    expect(await getInstallation(store().db, id)).toBeNull();
  });
});
