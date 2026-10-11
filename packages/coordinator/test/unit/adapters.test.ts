/** Request shapes of the Cloudflare adapters, against a mocked fetch / fake bindings. */
import * as gitwire from "@app/gitwire";
import { describe, expect, it } from "vitest";
import {
  type ArtifactsBindingLike,
  ArtifactsGitHost,
  type ArtifactsRepoLike,
  FORK_OBJECTS_REF,
  type GitWire,
  GitWriteForbiddenError,
} from "../../src/adapters/artifacts-git-host.js";
import { CfApiError } from "../../src/adapters/cf-api.js";
import {
  ContainerSandboxJobs,
  lastMarked,
  PLAN_CACHE_VERSION,
  planCacheKey,
  RESULT_PREFIX,
} from "../../src/adapters/container-sandbox-jobs.js";
import { FlagshipFlags } from "../../src/adapters/flagship-flags.js";
import { ObservabilityTelemetry } from "../../src/adapters/observability-telemetry.js";
import { diffTrees, type TreeEntryLike } from "../../src/adapters/tree-diff.js";
import { moduleContentType, WorkersDeployer } from "../../src/adapters/workers-deployer.js";
import { FakeClock, FakeStore } from "../../src/fakes/index.js";

interface Call {
  method: string;
  url: string;
  body: unknown;
  form?: FormData;
}

/** fetch mock: answers from `routes` (first match by "METHOD path-suffix"). */
function mockFetch(routes: Array<[RegExp, (call: Call) => { status?: number; body: unknown }]>) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: unknown = null;
    let form: FormData | undefined;
    if (init?.body instanceof FormData) form = init.body;
    else if (typeof init?.body === "string") body = JSON.parse(init.body);
    const call: Call = { method, url, body, ...(form ? { form } : {}) };
    calls.push(call);
    const route = routes.find(([re]) => re.test(`${method} ${url}`));
    if (route === undefined)
      return new Response(
        JSON.stringify({ success: false, errors: [{ code: 404, message: "no route" }] }),
        { status: 404 },
      );
    const { status = 200, body: out } = route[1](call);
    return new Response(JSON.stringify(out), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const ok = (result: unknown) => ({ body: { success: true, errors: [], result } });
const api = { accountId: "acc", apiToken: "tok" };

describe("FlagshipFlags", () => {
  it("creates change-<id> (on/off variations, match-all rule) when missing", async () => {
    const { fetch, calls } = mockFetch([
      [
        /^GET .*\/flags\/change-c1$/,
        () => ({
          status: 404,
          body: { success: false, errors: [{ code: 1000, message: "not found" }] },
        }),
      ],
      [/^POST .*\/flagship\/apps\/app-1\/flags$/, () => ok({})],
    ]);
    const flags = new FlagshipFlags({ ...api, fetch });
    expect(
      await flags.ensureChangeFlag("app-1", "c1", { enabled: true, description: "change c1" }),
    ).toBe("change-c1");
    expect(calls[1]).toMatchObject({
      method: "POST",
      url: "https://api.cloudflare.com/client/v4/accounts/acc/flagship/apps/app-1/flags",
      body: {
        key: "change-c1",
        enabled: true,
        variations: { on: true, off: false },
        default_variation: "off",
        rules: [{ priority: 1, serve_variation: "on", conditions: [] }],
      },
    });
  });

  it("kill switch: GET → enabled:false → full PUT without read-only fields", async () => {
    const existing = {
      id: "f1",
      key: "change-c1",
      enabled: true,
      description: "d",
      variations: { on: true, off: false },
      default_variation: "off",
      rules: [],
      created_at: "x",
      updated_at: "y",
    };
    const { fetch, calls } = mockFetch([
      [/^GET .*\/flags\/change-c1$/, () => ok(existing)],
      [/^PUT .*\/flags\/change-c1$/, () => ok({})],
    ]);
    await new FlagshipFlags({ ...api, fetch }).setEnabled("app-1", "change-c1", false);
    expect(calls.every((c) => c.url.includes("/flagship/apps/app-1/flags/change-c1"))).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
    expect(calls[1]?.body).toEqual({
      key: "change-c1",
      enabled: false,
      description: "d",
      variations: { on: true, off: false },
      default_variation: "off",
      rules: [],
    });
  });

  it("is idempotent and surfaces API errors", async () => {
    const same = {
      key: "change-c1",
      enabled: true,
      variations: { on: true, off: false },
      default_variation: "off",
      rules: [],
    };
    const { fetch, calls } = mockFetch([[/^GET /, () => ok(same)]]);
    const flags = new FlagshipFlags({ ...api, fetch });
    await flags.ensureChangeFlag("app-1", "c1", { enabled: true, description: "" });
    await flags.setEnabled("app-1", "change-c1", true);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    const broken = mockFetch([
      [
        /^GET /,
        () => ({ status: 500, body: { success: false, errors: [{ code: 7, message: "boom" }] } }),
      ],
    ]);
    await expect(
      new FlagshipFlags({ ...api, fetch: broken.fetch }).setEnabled("a", "k", false),
    ).rejects.toBeInstanceOf(CfApiError);
  });
});

describe("FlagshipFlags apps (one per project)", () => {
  it("reuses the oldest app with the name, else creates one; names are not unique", async () => {
    const apps = [
      { id: "newer", name: "gf-r1", created_at: "2026-10-02T10:00:00Z" },
      { id: "older", name: "gf-r1", created_at: "2026-10-01T10:00:00Z" },
      { id: "other", name: "gf-r2", created_at: "2026-09-01T10:00:00Z" },
    ];
    const { fetch, calls } = mockFetch([
      [/^GET .*\/flagship\/apps$/, () => ok(apps)],
      [
        /^POST .*\/flagship\/apps$/,
        (c) => ok({ id: "fresh", name: (c.body as { name: string }).name }),
      ],
    ]);
    const flags = new FlagshipFlags({ ...api, fetch });
    expect(await flags.ensureApp("gf-r1")).toBe("older");
    expect(await flags.ensureApp("gf-r3")).toBe("fresh");
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "POST"]);
    expect(calls[2]?.body).toEqual({ name: "gf-r3" });
  });

  it("deletes an app; a missing app is fine, a bound app (409) fails", async () => {
    const { fetch, calls } = mockFetch([
      [/^DELETE .*\/apps\/a1$/, () => ok({ id: "a1" })],
      [
        /^DELETE .*\/apps\/gone$/,
        () => ({
          status: 404,
          body: { success: false, errors: [{ code: 404, message: "App not found" }] },
        }),
      ],
      [
        /^DELETE .*\/apps\/bound$/,
        () => ({
          status: 409,
          body: { success: false, errors: [{ code: 409, message: "referenced by a Worker" }] },
        }),
      ],
    ]);
    const flags = new FlagshipFlags({ ...api, fetch });
    await flags.deleteApp("a1");
    await flags.deleteApp("gone");
    await expect(flags.deleteApp("bound")).rejects.toBeInstanceOf(CfApiError);
    expect(calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc/flagship/apps/a1",
    );
  });
});

describe("WorkersDeployer", () => {
  it("uploads a version as multipart with change annotations", async () => {
    const { fetch, calls } = mockFetch([
      [/^POST .*\/workers\/scripts\/api\/versions$/, () => ok({ id: "ver-9" })],
      [/^PATCH .*\/workers\/scripts\/api\/script-settings$/, () => ok({})],
    ]);
    const deployer = new WorkersDeployer({
      ...api,
      fetch,
      loadBundle: async (ref) => ({
        mainModule: "index.js",
        modules: [
          { name: "index.js", content: `export default {} // ${ref}` },
          { name: "lib.wasm", content: new Uint8Array([0, 97]) },
        ],
        metadata: { compatibility_date: "2026-09-30", bindings: [] },
      }),
    });
    const { versionId } = await deployer.uploadVersion({
      script: "api",
      changeId: "c1",
      sha: "a".repeat(40),
      bundleRef: "bundles/c1",
      message: "change c1",
      flagshipAppId: "app-of-r1",
    });
    expect(versionId).toBe("ver-9");
    const form = calls[0]?.form;
    if (form === undefined) throw new Error("expected a multipart upload");
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text()) as Record<
      string,
      unknown
    >;
    expect(metadata).toMatchObject({
      main_module: "index.js",
      compatibility_date: "2026-09-30",
      annotations: {
        "workers/tag": "c1",
        "workers/commit_sha": "a".repeat(40),
        "workers/message": "change c1",
      },
    });
    // FLAGS binds the deploying project's own app, and no other Flagship app.
    const bindings = metadata.bindings as Array<Record<string, unknown>>;
    expect(bindings.filter((x) => x.type === "flagship")).toEqual([
      { type: "flagship", name: "FLAGS", app_id: "app-of-r1" },
    ]);
    expect((form.get("index.js") as Blob).type).toBe("application/javascript+module");
    expect((form.get("lib.wasm") as Blob).type).toBe("application/wasm");
    expect(moduleContentType("x.map")).toBe("application/source-map");
  });

  it("reads the newest deployment, splits traffic, and rolls back with force on 10220", async () => {
    let attempts = 0;
    const { fetch, calls } = mockFetch([
      [
        /^GET .*\/deployments$/,
        () =>
          ok({
            deployments: [
              {
                created_on: "2026-09-01T00:00:00Z",
                versions: [{ version_id: "old", percentage: 100 }],
              },
              {
                created_on: "2026-10-01T00:00:00Z",
                versions: [
                  { version_id: "v2", percentage: 10 },
                  { version_id: "v1", percentage: 90 },
                ],
              },
            ],
          }),
      ],
      [
        /^POST .*\/deployments/,
        (c) => {
          const single = (c.body as { versions: unknown[] }).versions.length === 1;
          if (single && !c.url.includes("force=true") && attempts++ === 0) {
            return {
              status: 400,
              body: { success: false, errors: [{ code: 10220, message: "secrets changed" }] },
            };
          }
          return ok({});
        },
      ],
    ]);
    const d = new WorkersDeployer({
      ...api,
      fetch,
      loadBundle: async () => ({ mainModule: "", modules: [], metadata: {} }),
    });
    expect(await d.currentVersions("api")).toEqual([
      { versionId: "v2", percentage: 10 },
      { versionId: "v1", percentage: 90 },
    ]);
    await d.setSplit(
      "api",
      [
        { versionId: "v2", percentage: 25 },
        { versionId: "v1", percentage: 75 },
      ],
      "25%",
    );
    expect(calls[1]?.body).toEqual({
      strategy: "percentage",
      versions: [
        { version_id: "v2", percentage: 25 },
        { version_id: "v1", percentage: 75 },
      ],
      annotations: { "workers/message": "25%" },
    });
    await expect(d.setSplit("api", [{ versionId: "v2", percentage: 50 }], "bad")).rejects.toThrow(
      /total 100/,
    );
    await d.rollback("api", "v1", "auto-revert");
    const rollbackCalls = calls.filter((c) => c.method === "POST").slice(1);
    expect(rollbackCalls.map((c) => c.url.includes("force=true"))).toEqual([false, true]);
    expect(rollbackCalls[1]?.body).toMatchObject({
      versions: [{ version_id: "v1", percentage: 100 }],
    });
  });
});

describe("ObservabilityTelemetry", () => {
  it("queries by version × outcome (+ ok 5xx) and computes error rates; issues from the store", async () => {
    const outcomes = {
      calculations: [
        {
          aggregates: [
            {
              count: 900,
              groups: [
                { key: "$workers.scriptVersion.id", value: "new" },
                { key: "$workers.outcome", value: "ok" },
              ],
            },
            {
              count: 100,
              groups: [
                { key: "$workers.scriptVersion.id", value: "new" },
                { key: "$workers.outcome", value: "exception" },
              ],
            },
            {
              count: 2000,
              groups: [
                { key: "$workers.scriptVersion.id", value: "old" },
                { key: "$workers.outcome", value: "ok" },
              ],
            },
          ],
        },
      ],
    };
    const fivexx = {
      calculations: [
        {
          aggregates: [{ count: 20, groups: [{ key: "$workers.scriptVersion.id", value: "old" }] }],
        },
      ],
    };
    const { fetch, calls } = mockFetch([
      [/telemetry\/query$/, (c) => ok(JSON.stringify(c.body).includes("gte") ? fivexx : outcomes)],
    ]);
    const clock = new FakeClock("2026-10-01T12:10:00.000Z");
    const store = new FakeStore(clock);
    await store.putIssue({
      id: "i1",
      changeId: null,
      title: "t",
      count: 1,
      firstSeen: "2026-10-01T12:05:00.000Z",
      lastSeen: "2026-10-01T12:06:00.000Z",
      versionId: "new",
      url: null,
      scriptName: "api",
      raw: {},
    });
    await store.putIssue({
      id: "i0",
      changeId: null,
      title: "old",
      count: 9,
      firstSeen: "2026-09-01T00:00:00.000Z",
      lastSeen: "2026-10-01T12:06:00.000Z",
      versionId: "new",
      url: null,
      scriptName: "api",
      raw: {},
    });
    const t = new ObservabilityTelemetry({ ...api, fetch, store, clock });
    const r = await t.check({
      script: "api",
      versionId: "new",
      baselineVersionId: "old",
      since: "2026-10-01T12:00:00.000Z",
    });
    expect(r).toMatchObject({
      requests: 1000,
      errorRate: 0.1,
      baselineErrorRate: 0.01,
      newIssueGroups: 1,
    });
    expect(calls[0]?.body).toMatchObject({
      dry: true,
      view: "calculations",
      timeframe: {
        from: Date.parse("2026-10-01T12:00:00.000Z"),
        to: Date.parse("2026-10-01T12:10:00.000Z"),
      },
      parameters: {
        groupBys: [{ value: "$workers.scriptVersion.id" }, { value: "$workers.outcome" }],
        calculations: [{ operator: "count" }],
        filters: [{ key: "$workers.scriptName", operation: "eq", value: "api" }],
      },
    });
    // Versions come from the groups, never an `in` filter (its value shape is undocumented).
    expect(JSON.stringify(calls.map((c) => c.body))).not.toContain('"operation":"in"');
    // No traffic → unknown rate, never 0.
    const empty = mockFetch([[/telemetry\/query$/, () => ok({ calculations: [] })]]);
    const r2 = await new ObservabilityTelemetry({ ...api, fetch: empty.fetch, store, clock }).check(
      { script: "api", versionId: "x", baselineVersionId: null, since: "2026-10-01T12:00:00.000Z" },
    );
    expect(r2).toMatchObject({ requests: 0, errorRate: null, baselineErrorRate: null });
  });
});

describe("ObservabilityTelemetry.issueOccurrence", () => {
  it("reads the newest occurrence's Worker version (shape captured live 2026-10-02)", async () => {
    const live = {
      id: "01M3YMRH910000000000000001",
      timestamp: 1790956029217,
      error: {
        name: "Error",
        message: "probe boom 3",
        stack: "    at Object.fetch (index.js:6:13)",
      },
      worker: {
        scriptName: "gf-r1-api",
        executionModel: "stateless",
        scriptVersion: { id: "bd81c674-2417-4021-8fb8-c12b513abfb9" },
      },
    };
    const { fetch, calls } = mockFetch([[/occurrences/, () => ok([live])]]);
    const clock = new FakeClock();
    const t = new ObservabilityTelemetry({ ...api, fetch, store: new FakeStore(clock), clock });
    expect(await t.issueOccurrence("iss-1")).toEqual({
      scriptName: "gf-r1-api",
      versionId: "bd81c674-2417-4021-8fb8-c12b513abfb9",
      stack: "    at Object.fetch (index.js:6:13)",
      at: new Date(1790956029217).toISOString(),
    });
    expect(calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc/workers/observability/issues/iss-1/occurrences?per_page=5",
    );
    const none = mockFetch([[/occurrences/, () => ok([])]]);
    const empty = new ObservabilityTelemetry({
      ...api,
      fetch: none.fetch,
      store: new FakeStore(clock),
      clock,
    });
    expect(await empty.issueOccurrence("iss-2")).toBeNull();
  });
});

describe("ContainerSandboxJobs", () => {
  function setup(outcome: (job: Record<string, unknown>) => unknown) {
    const jobs: Array<{ name: string; kind: "run" | "plan"; job: Record<string, unknown> }> = [];
    const transfers: unknown[][] = [];
    const tokens: unknown[][] = [];
    const sandbox = new ContainerSandboxJobs({
      runner: (name) => ({
        run: async (job) => {
          jobs.push({ name, kind: "run", job });
          return outcome(job);
        },
        plan: async (job) => {
          jobs.push({ name, kind: "plan", job });
          return outcome(job);
        },
      }),
      git: {
        remoteOf: (r) => `https://git/${r}.git`,
        mintToken: async (...a) => {
          tokens.push(a);
          return { token: "fork-write-token", expiresAt: "x" };
        },
        transferObjects: async (...a) => void transfers.push(a),
      },
      logKey: (id, step) => `logs/${id}/${step}`,
      newJobId: () => "j1",
    });
    return { sandbox, jobs, transfers, tokens };
  }
  const ran = (tail: string) => ({
    ok: true,
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    log: null,
    tail,
    snapshot: null,
    evidence: null,
  });

  it("plans .platform/ci.ts through the Runner's plan RPC", async () => {
    const t = setup(() => ({
      ok: true,
      stdout: `noise\n::plan::{"version":1,"source":"file","steps":[]}\n`,
      stderr: "",
      exitCode: 0,
    }));
    expect(await t.sandbox.planPipeline({ repo: "task-1", sha: "a".repeat(40) })).toEqual({
      version: 1,
      source: "file",
      steps: [],
    });
    expect(t.jobs[0]).toMatchObject({
      name: "job-plan-j1:plan",
      kind: "plan",
      job: {
        artifactsRepo: "task-1",
        remote: "https://git/task-1.git",
        file: ".platform/ci.ts",
        logKey: "logs/job-plan-j1/plan",
      },
    });
    const failing = setup(() => ({ ok: false, code: "checkout", message: "nope", stderr: "" }));
    await expect(failing.sandbox.planPipeline({ repo: "r", sha: "a".repeat(40) })).rejects.toThrow(
      /checkout/,
    );
  });

  it("caches plans per repository and commit, with a TTL, never across repositories", async () => {
    // Security audit 2026-10-11 (M5): v1 keyed plans by the bytes of .platform/ci.ts alone, shared
    // by every tenant, so a repo that committed the same ci.ts with a hostile ./steps.ts first
    // decided another repo's pipeline.
    const store = new Map<string, unknown>();
    const plans: string[] = [];
    let clock = 1_000_000;
    const sandbox = new ContainerSandboxJobs({
      runner: () => ({
        run: async () => ({}),
        plan: async (job) => {
          plans.push(`${job.artifactsRepo}@${String(job.sha).slice(0, 1)}`);
          return {
            ok: true,
            stdout: `::plan::${JSON.stringify({ version: 1, from: job.artifactsRepo, n: plans.length })}`,
            stderr: "",
            exitCode: 0,
          };
        },
      }),
      git: {
        remoteOf: (r) => `https://git/${r}.git`,
        mintToken: async () => ({ token: "t", expiresAt: "x" }),
        transferObjects: async () => undefined,
      },
      planCache: {
        get: async (k) => store.get(k) ?? null,
        put: async (k, v) => void store.set(k, v),
      },
      planCacheTtlMs: 60_000,
      now: () => clock,
      logKey: (id, step) => `logs/${id}/${step}`,
      newJobId: () => "j1",
    });
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    // The attacker plans first; the victim (another repo, same ci.ts bytes) gets its own plan.
    expect(await sandbox.planPipeline({ repo: "evil", sha: a })).toMatchObject({ from: "evil" });
    expect(await sandbox.planPipeline({ repo: "victim", sha: b })).toMatchObject({
      from: "victim",
    });
    // Even the very same commit is planned again in another repository.
    expect(await sandbox.planPipeline({ repo: "victim", sha: a })).toMatchObject({
      from: "victim",
    });
    expect(plans).toEqual(["evil@a", "victim@b", "victim@a"]);
    // Forks of one main repository share a commit's plan through cacheScope.
    const fork1 = await sandbox.planPipeline({ repo: "task-1", sha: b, cacheScope: "app" });
    const fork2 = await sandbox.planPipeline({ repo: "task-2", sha: b, cacheScope: "app" });
    expect(fork2).toEqual(fork1);
    expect(plans).toHaveLength(4);
    expect(store.has(planCacheKey("app", b))).toBe(true);
    expect([...store.keys()].every((k) => k.startsWith(`${PLAN_CACHE_VERSION}/`))).toBe(true);
    expect(PLAN_CACHE_VERSION).toBe("v2");
    // Past the TTL the entry is planned again (and refreshed).
    clock += 60_001;
    await sandbox.planPipeline({ repo: "task-3", sha: b, cacheScope: "app" });
    expect(plans).toHaveLength(5);
    await sandbox.planPipeline({ repo: "task-3", sha: b, cacheScope: "app" });
    expect(plans).toHaveLength(5);
    // An entry from another format (v1 stored the bare spec) or a short sha is never trusted.
    store.set(planCacheKey("app", a), { version: 1, n: 99 });
    expect(await sandbox.planPipeline({ repo: "x", sha: a, cacheScope: "app" })).not.toMatchObject({
      n: 99,
    });
    await sandbox.planPipeline({ repo: "x", sha: "abc123" });
    await sandbox.planPipeline({ repo: "x", sha: "abc123" });
    expect(plans).toHaveLength(8);
  });

  it("evaluates the policy at a sha (no file → null; evaluation error → throws)", async () => {
    const doc = (o: object) =>
      `::evidence::${JSON.stringify({ kind: "policy", sha: "s", path: ".platform/policy.ts", resolved: null, platformChanged: false, platformPaths: [], policyChanged: false, issues: [], ...o })}`;
    const t = setup(() =>
      ran(doc({ status: "ok", source: "file", policy: { lane0Enabled: true } })),
    );
    expect(await t.sandbox.evaluatePolicy({ repo: "main", sha: "b".repeat(40) })).toEqual({
      lane0Enabled: true,
    });
    expect(t.jobs[0]?.job).toMatchObject({
      command: `gittifacts-runner policy --base ${"b".repeat(40)}`,
      headSha: "b".repeat(40),
      instance: "lite",
      snapshot: false,
    });
    expect(
      await setup(() =>
        ran(doc({ status: "ok", source: "default", policy: null })),
      ).sandbox.evaluatePolicy({ repo: "m", sha: "b".repeat(40) }),
    ).toBeNull();
    await expect(
      setup(() =>
        ran(doc({ status: "error", source: "file", policy: null, note: "syntax" })),
      ).sandbox.evaluatePolicy({ repo: "m", sha: "b".repeat(40) }),
    ).rejects.toThrow(/syntax/);
  });

  it("rebase: copies main into the fork, pushes with a fork-only token via git env, parses the result", async () => {
    const t = setup(() => ran(`${RESULT_PREFIX}{"status":"clean","newSha":"${"c".repeat(40)}"}`));
    const r = await t.sandbox.rebase({
      fork: "task-1",
      mainRepo: "main",
      headSha: "a".repeat(40),
      ontoSha: "b".repeat(40),
      branch: "gittifacts/rebased",
    });
    expect(r).toEqual({ status: "clean", newSha: "c".repeat(40) });
    expect(t.transfers[0]).toEqual(["main", "task-1", "b".repeat(40), "refs/gittifacts/onto"]);
    expect(t.tokens[0]).toEqual(["task-1", "write", 600]);
    const env = t.jobs[0]?.job.env as Record<string, string>;
    expect(env).toMatchObject({
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: "Authorization: Bearer fork-write-token",
      GJ_ONTO: "b".repeat(40),
      // Nothing repo code could configure runs while the write token is in env.
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: "/dev/null",
      GIT_CONFIG_KEY_2: "core.fsmonitor",
      GIT_CONFIG_VALUE_2: "false",
      GIT_CONFIG_KEY_3: "credential.helper",
      GIT_CONFIG_VALUE_3: "",
    });
    expect(String(t.jobs[0]?.job.command)).not.toContain("fork-write-token");
    const conflict = setup(() => ran(`${RESULT_PREFIX}{"status":"conflict","files":["src/a.ts"]}`));
    expect(
      await conflict.sandbox.revert({
        fork: "task-1",
        sha: "a".repeat(40),
        ontoSha: "b".repeat(40),
        branch: "main",
        message: "Revert",
      }),
    ).toEqual({ status: "conflict", files: ["src/a.ts"] });
    await expect(
      setup(() => ({ ...ran(""), exitCode: 2 })).sandbox.rebase({
        fork: "f",
        mainRepo: "m",
        headSha: "a".repeat(40),
        ontoSha: "b".repeat(40),
        branch: "x",
      }),
    ).rejects.toThrow(/exited 2/);
    expect(lastMarked("a\n::x::1\n::x::2\n", "::x::")).toBe(2);
  });
});

describe("ArtifactsGitHost", () => {
  const blobs: Record<string, string> = {
    b1: "one\ntwo\n",
    b2: "one\nTWO\n",
    b3: "same\n",
    bin: "\u0000\u0001",
  };
  const trees: Record<string, TreeEntryLike[]> = {
    root1: [
      { name: "a.txt", mode: "100644", hash: "b1", type: "blob" },
      { name: "src", mode: "40000", hash: "src1", type: "tree" },
      { name: "img.png", mode: "100644", hash: "bin", type: "blob" },
    ],
    root2: [
      { name: "a.txt", mode: "100644", hash: "b2", type: "blob" },
      { name: "lib", mode: "40000", hash: "lib2", type: "tree" },
    ],
    src1: [{ name: "keep.ts", mode: "100644", hash: "b3", type: "blob" }],
    lib2: [{ name: "keep.ts", mode: "100644", hash: "b3", type: "blob" }],
  };

  function host(opts: { canWrite?: (r: string) => boolean } = {}) {
    const created: string[] = [];
    const tokens: Array<[string, string | undefined, number | undefined]> = [];
    const wireCalls: string[] = [];
    const advertised = new Map<string, string>();
    const revoked: string[] = [];
    let revokeMisses = 0;
    let forkError: Error | null = null;
    const transfers: Array<{ sha: string; toRef: string; oldSha?: string; haves?: string[] }> = [];
    let transferOk = true;
    // Forks Artifacts reports as "being forked" (until deleted); `restick` keeps re-forks stuck too.
    const stuck = new Set<string>();
    let restick = false;
    const deleted: string[] = [];
    const repo = (name: string): ArtifactsRepoLike => ({
      createToken: async (scope, ttl) => {
        tokens.push([name, scope, ttl]);
        return {
          id: `id-${tokens.length}`,
          plaintext: `tok-${name}-${scope}`,
          expiresAt: "2030-01-01T00:00:00Z",
        };
      },
      revokeToken: async (id) => {
        if (revokeMisses > 0) {
          revokeMisses--;
          return false;
        }
        revoked.push(`${name}:${id}`);
        return true;
      },
      info: async () => ({
        defaultBranch: "main",
        remote: `https://acc.artifacts.cloudflare.net/git/ns/${name}.git`,
      }),
      readBlob: async (h) => (h in blobs ? new Blob([blobs[h] ?? ""]) : null),
      readTree: async (h) => trees[h] ?? null,
      readCommit: async (h) => ({
        hash: h,
        treeHash: h === "c1" ? "root1" : "root2",
        parents: h === "c2" ? ["c1"] : [],
      }),
      readFile: async () => new Blob(["file"]),
      log: async () => [{ hash: "c2" }],
      fork: async (target) => {
        if (forkError) throw forkError;
        if (restick) stuck.add(target);
        if (stuck.has(target))
          throw Object.assign(new Error("in progress"), { code: "FORK_IN_PROGRESS" });
        created.push(target);
        return { remote: target };
      },
    });
    const binding: ArtifactsBindingLike = {
      create: async (name) => ({ remote: name, defaultBranch: "main" }),
      get: async (name) => {
        if (stuck.has(name))
          throw Object.assign(new Error(`Repository "${name}" is currently being forked`), {
            code: "FORK_IN_PROGRESS",
          });
        return repo(name);
      },
      import: async () => ({ remote: "r", defaultBranch: "main" }),
      delete: async (name) => {
        deleted.push(name);
        stuck.delete(name);
        return true;
      },
    };
    const err = (name: string, reason: string) =>
      Object.assign(new Error(reason), { name, reason });
    const wire: GitWire = {
      readNote: async () => "note",
      writeNote: async () => void wireCalls.push("writeNote"),
      transferObjects: async (_f, _t, o) => {
        wireCalls.push(`transfer:${o.toRef}`);
        transfers.push(o);
        return { ref: o.toRef, ok: transferOk };
      },
      fastForward: async (_r, ref, old) => {
        wireCalls.push(`ff:${ref}`);
        if (old === "stale") throw err("StaleRefError", "stale ref");
        if (old === "missing") throw err("MissingObjectError", "missing object");
        return { ref, ok: true };
      },
      receivePack: async (_r, updates) => {
        wireCalls.push(`receive:${updates[0]?.ref}`);
        return { unpackOk: true, refs: [{ ref: updates[0]?.ref ?? "", ok: true }] };
      },
      assertRefUpdated: (report, ref) =>
        report.refs.find((r) => r.ref === ref) ?? { ref, ok: false },
      encodeTree: () => new Uint8Array(),
      encodeCommit: (c) => new TextEncoder().encode(`tree ${c.tree}\n\n${c.message}`),
      hashObject: async () => "d".repeat(40),
      buildPack: async () => new Uint8Array([1]),
      listRefs: async () => {
        wireCalls.push("listRefs");
        return advertised;
      },
    };
    const h = new ArtifactsGitHost({
      binding,
      wire,
      namespace: "ns",
      accountId: "acc",
      sleep: async () => undefined,
      ...opts,
    });
    return {
      h,
      created,
      tokens,
      wireCalls,
      advertised,
      revoked,
      missRevokes: (n: number) => (revokeMisses = n),
      setForkError: (e: Error) => (forkError = e),
      transfers,
      failTransfers: () => (transferOk = false),
      stuck,
      restickForks: () => (restick = true),
      deleted,
    };
  }

  it("mints an import grant only before the branch exists, from any role, TTL <= 30 min", async () => {
    // The default (fork-only) host: the import grant is the narrow exception it allows.
    const { h, tokens, wireCalls, advertised, revoked, missRevokes } = host();
    const grant = await h.mintImportToken("app", { branch: "main", ttlSeconds: 99_999 });
    expect(grant).toEqual({
      token: "tok-app-write",
      tokenId: "id-2",
      expiresAt: "2030-01-01T00:00:00Z",
    });
    // A read token to list the refs, then the write token with the TTL clamped to 1800 s.
    expect(tokens).toEqual([
      ["app", "read", 300],
      ["app", "write", 1800],
    ]);
    expect(wireCalls).toEqual(["listRefs"]);
    // Other refs don't matter; the default branch does.
    advertised.set("refs/heads/other", "a".repeat(40));
    await expect(
      h.mintImportToken("app", { branch: "main", ttlSeconds: 60 }),
    ).resolves.toBeTruthy();
    advertised.set("refs/heads/main", "b".repeat(40));
    await expect(
      h.mintImportToken("app", { branch: "main", ttlSeconds: 60 }),
    ).rejects.toBeInstanceOf(GitWriteForbiddenError);
    await expect(
      h.mintImportToken("task-1", { branch: "x", ttlSeconds: 60 }),
    ).rejects.toBeInstanceOf(GitWriteForbiddenError);
    // Revocation retries a miss (the token index is eventually consistent), then reports it.
    missRevokes(2);
    expect(await h.revokeToken("app", "id-2")).toBe(true);
    expect(revoked).toEqual(["app:id-2"]);
    missRevokes(9);
    expect(await h.revokeToken("app", "id-4")).toBe(false);
  });

  it("refuses main-repo writes unless built for the merge queue; caps token TTLs", async () => {
    const { h, tokens } = host();
    await expect(h.updateRef("main-repo", "refs/heads/main", "a", "b")).rejects.toBeInstanceOf(
      GitWriteForbiddenError,
    );
    await expect(h.mintToken("main-repo", "write", 60)).rejects.toBeInstanceOf(
      GitWriteForbiddenError,
    );
    await expect(h.deleteRepo("main-repo")).rejects.toBeInstanceOf(GitWriteForbiddenError);
    await expect(
      h.transferObjects("task-1", "main-repo", "a".repeat(40), "refs/x"),
    ).rejects.toBeInstanceOf(GitWriteForbiddenError);
    expect((await h.mintToken("task-1", "write", 99_999)).token).toBe("tok-task-1-write");
    expect(tokens.at(-1)).toEqual(["task-1", "write", 3600]);
    const queue = host({ canWrite: () => true });
    await queue.h.mintToken("main-repo", "write", 3600);
    expect(queue.tokens.at(-1)).toEqual(["main-repo", "write", 300]);
    expect(h.remoteOf("x")).toBe("https://acc.artifacts.cloudflare.net/git/ns/x.git");
  });

  it("writes an initial commit create-only (zero old SHA), from any role, with real git objects", async () => {
    const tokens: Array<[string, string | undefined, number | undefined]> = [];
    const pushes: Array<{ updates: Array<{ ref: string; oldSha: string }>; pack: Uint8Array }> = [];
    const binding = {
      get: async (name: string) =>
        ({
          createToken: async (scope?: "read" | "write", ttl?: number) => {
            tokens.push([name, scope, ttl]);
            return { plaintext: "tok", expiresAt: "2030-01-01T00:00:00Z" };
          },
        }) as unknown as ArtifactsRepoLike,
    } as unknown as ArtifactsBindingLike;
    const wire: GitWire = {
      ...gitwire,
      receivePack: async (_remote, updates, pack) => {
        pushes.push({ updates, pack: pack ?? new Uint8Array() });
        return { unpackOk: true, refs: updates.map((u) => ({ ref: u.ref, ok: true })) };
      },
    };
    // The default (fork-only) host: initial commits are the one main-repo write it allows.
    const h = new ArtifactsGitHost({ binding, wire, namespace: "ns", accountId: "acc" });
    const files = {
      "README.md": "# app\n",
      "src/index.ts": "export {};\n",
      "src/lib/a.ts": "export const a = 1;\n",
      ".platform/ci.ts": "export default async () => {};\n",
    };
    const out = await h.writeInitialCommit("app", { branch: "main", files, message: "init" });
    expect(tokens).toEqual([["app", "write", 300]]);
    expect(pushes[0]?.updates).toEqual([
      { ref: "refs/heads/main", oldSha: "0".repeat(40), newSha: out.sha },
    ]);
    const objects = await gitwire.parsePack(pushes[0]?.pack ?? new Uint8Array());
    const byId = new Map(objects.map((o) => [o.sha, o]));
    const commit = gitwire.decodeCommit(byId.get(out.sha)?.data ?? new Uint8Array());
    expect(commit).toMatchObject({ tree: out.treeSha, parents: [], message: "init\n" });
    // Walk the pushed tree back into files.
    const read = (treeSha: string, prefix: string): Record<string, string> => {
      const entries = gitwire.decodeTree(byId.get(treeSha)?.data ?? new Uint8Array());
      return Object.assign(
        {},
        ...entries.map((e) =>
          e.mode === "40000"
            ? read(e.sha, `${prefix}${e.name}/`)
            : { [`${prefix}${e.name}`]: new TextDecoder().decode(byId.get(e.sha)?.data) },
        ),
      ) as Record<string, string>;
    };
    expect(read(out.treeSha, "")).toEqual(files);
    for (const bad of ["../x", "/abs", "a//b", ".git/config", "a/./b"]) {
      await expect(
        h.writeInitialCommit("app", { branch: "main", files: { [bad]: "x" }, message: "m" }),
      ).rejects.toThrow(TypeError);
    }
  });

  it("maps CAS errors and uses short-lived internal tokens", async () => {
    const { h, tokens, wireCalls } = host({ canWrite: () => true });
    expect(await h.updateRef("main", "refs/heads/main", "a", "b")).toEqual({ ok: true });
    expect(await h.updateRef("main", "refs/heads/main", "stale", "b")).toEqual({
      ok: false,
      reason: "stale",
      detail: "stale ref",
    });
    expect(await h.updateRef("main", "refs/heads/main", "missing", "b")).toEqual({
      ok: false,
      reason: "missing-object",
      detail: "missing object",
    });
    expect(tokens.filter(([r]) => r === "main")).toEqual([["main", "write", 300]]); // cached
    await h.transferObjects("task-1", "main", "a".repeat(40), "refs/merge-queue/c1");
    expect(wireCalls).toContain("transfer:refs/merge-queue/c1");
    expect(
      await h.commitTree("task-1", {
        treeSha: "t".repeat(40),
        parents: ["p".repeat(40)],
        message: "Revert",
        branch: "main",
        expectedOld: "p".repeat(40),
      }),
    ).toEqual({ sha: "d".repeat(40) });
    expect(wireCalls).toContain("receive:refs/heads/main");
  });

  it("forks idempotently and reads heads, parents and trees through the binding", async () => {
    const { h, setForkError, advertised, transfers, failTransfers } = host();
    expect(await h.forkRepo("main", "task-1")).toEqual({
      remote: "https://acc.artifacts.cloudflare.net/git/ns/task-1.git",
    });
    expect(transfers).toEqual([]); // an empty fork inherited nothing
    // A fork gets its own full copy of the inherited history (haves: [], create-only ref): a fork
    // of a large repo cannot serve its parent's objects to a clone (Artifacts answers 500).
    advertised.set("refs/heads/main", "c".repeat(40));
    await h.forkRepo("main", "task-1");
    expect(transfers).toEqual([
      { sha: "c".repeat(40), toRef: FORK_OBJECTS_REF, oldSha: "0".repeat(40), haves: [] },
    ]);
    advertised.set(FORK_OBJECTS_REF, "c".repeat(40));
    setForkError(Object.assign(new Error("exists"), { code: "ALREADY_EXISTS" }));
    await expect(h.forkRepo("main", "task-1")).resolves.toBeDefined();
    expect(transfers).toHaveLength(1); // already hydrated: a reused fork costs one ls-refs
    advertised.delete(FORK_OBJECTS_REF);
    failTransfers();
    await expect(h.forkRepo("main", "task-1")).rejects.toThrow("hydrating fork task-1 failed");
    advertised.delete("refs/heads/main");
    setForkError(Object.assign(new Error("bad"), { code: "INVALID_REPO_NAME" }));
    await expect(h.forkRepo("main", "task-1")).rejects.toThrow("bad");
    expect(await h.branchHead("main", "main")).toBe("c2");
    expect(await h.commitParents("main", "c2")).toEqual(["c1"]);
    expect(await h.treeOf("main", "c1")).toBe("root1");
  });

  it("deletes a fork stuck in progress and forks it again (once)", async () => {
    // Live: a revert's fork stayed "being forked" for 40 minutes, so the revert never opened.
    const { h, stuck, deleted, created, restickForks } = host();
    stuck.add("task-rv-1");
    expect(await h.forkRepo("main", "task-rv-1")).toEqual({
      remote: "https://acc.artifacts.cloudflare.net/git/ns/task-rv-1.git",
    });
    expect(deleted).toEqual(["task-rv-1"]);
    expect(created).toEqual(["task-rv-1"]);
    // Still stuck after the second fork: give up (the caller retries), no delete loop.
    stuck.add("task-rv-2");
    restickForks();
    await expect(h.forkRepo("main", "task-rv-2")).rejects.toMatchObject({
      code: "FORK_IN_PROGRESS",
    });
    expect(deleted).toEqual(["task-rv-1", "task-rv-2"]);
  });

  it("diffs commits by walking trees: modified, binary, exact rename across directories", async () => {
    const { h } = host();
    const d = await h.diff("main", "c1", "c2");
    expect(
      d.files.map((f) => [f.path, f.status, f.previousPath, f.binary, f.additions, f.deletions]),
    ).toEqual([
      ["a.txt", "modified", null, false, 1, 1],
      ["img.png", "deleted", null, true, 0, 0],
      ["lib/keep.ts", "renamed", "src/keep.ts", false, 0, 0],
    ]);
    expect(d.files[0]?.hunks[0]?.header).toBe("@@ -1,2 +1,2 @@");
  });

  it("does not line-diff huge blobs but counts them (never under-reports)", async () => {
    const big = `${"x\n".repeat(100)}`;
    const reader = {
      readTree: async (h: string): Promise<TreeEntryLike[] | null> =>
        h === "t1" ? [] : [{ name: "big.txt", mode: "100644", hash: "big", type: "blob" }],
      readBlob: async () => ({
        size: big.length,
        bytes: async () => new TextEncoder().encode(big),
      }),
    };
    const d = await diffTrees(
      reader,
      { baseSha: "a".repeat(40), headSha: "b".repeat(40), baseTree: "t1", headTree: "t2" },
      { maxFileBytes: 10 },
    );
    expect(d.files[0]).toMatchObject({
      path: "big.txt",
      status: "added",
      truncated: true,
      additions: 100,
      hunks: [],
    });
  });
});
