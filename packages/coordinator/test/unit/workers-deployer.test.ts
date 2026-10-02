import { describe, expect, it } from "vitest";
import {
  BundleBindingError,
  DEPLOY_OBSERVABILITY,
  deployBindings,
  hyphenateUuid,
  WorkersDeployer,
} from "../../src/adapters/workers-deployer.js";

interface Call {
  method: string;
  url: string;
  body: unknown;
  form?: FormData;
}

type Route = [RegExp, (call: Call) => { status?: number; body: unknown }];

function mockFetch(routes: Route[]) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const call: Call = {
      method,
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      ...(init?.body instanceof FormData ? { form: init.body } : {}),
    };
    calls.push(call);
    const route = routes.find(([re]) => re.test(`${method} ${url}`));
    const { status = 200, body } = route?.[1](call) ?? {
      status: 599,
      body: { success: false, errors: [{ code: 1, message: `no route for ${method} ${url}` }] },
    };
    return new Response(JSON.stringify(body), { status });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const ok = (result: unknown) => ({ body: { success: true, errors: [], result } });
const notFound = () => ({
  status: 404,
  body: {
    success: false,
    errors: [{ code: 10007, message: "This Worker does not exist on your account." }],
  },
});

const bundle = (bindings?: unknown[]) => ({
  mainModule: "index.js",
  modules: [
    { name: "index.js", content: "export default { fetch() { return new Response('ok') } }" },
  ],
  metadata: {
    compatibility_date: "2026-09-30",
    ...(bindings === undefined ? {} : { bindings }),
  },
});

const input = {
  script: "gf-r1-api",
  changeId: "c1",
  sha: "a".repeat(40),
  bundleRef: "ci-artifacts/run/build/bundle.tgz",
  message: "change c1",
  flagshipAppId: "app-1",
};

async function metadataOf(call: Call | undefined): Promise<Record<string, unknown>> {
  const form = call?.form;
  if (form === undefined) throw new Error("expected a multipart upload");
  return JSON.parse(await (form.get("metadata") as Blob).text()) as Record<string, unknown>;
}

const PLATFORM_BINDINGS = [
  { type: "flagship", name: "FLAGS", app_id: "app-1" },
  { type: "version_metadata", name: "VERSION" },
];

describe("WorkersDeployer first deploy", () => {
  it("creates a missing script at 100%, turns workers.dev on and observability on", async () => {
    const { fetch, calls } = mockFetch([
      [/^POST .*\/workers\/scripts\/gf-r1-api\/versions$/, notFound],
      [
        /^PUT .*\/workers\/scripts\/gf-r1-api\?excludeScript=true$/,
        () => ok({ id: "gf-r1-api", deployment_id: "0123456789abcdef0123456789abcdef" }),
      ],
      [/^POST .*\/workers\/scripts\/gf-r1-api\/subdomain$/, () => ok({ enabled: true })],
      [/^PATCH .*\/workers\/scripts\/gf-r1-api\/script-settings$/, () => ok({})],
    ]);
    const d = new WorkersDeployer({
      accountId: "acc",
      apiToken: "tok",
      fetch,
      loadBundle: async () => bundle(),
    });
    expect(await d.uploadVersion(input)).toEqual({
      versionId: "01234567-89ab-cdef-0123-456789abcdef",
    });
    expect(calls.map((c) => c.method)).toEqual(["POST", "PUT", "POST", "PATCH"]);
    const created = await metadataOf(calls[1]);
    expect(created).toMatchObject({
      main_module: "index.js",
      compatibility_date: "2026-09-30",
      bindings: PLATFORM_BINDINGS,
      observability: DEPLOY_OBSERVABILITY,
      annotations: { "workers/tag": "c1", "workers/commit_sha": "a".repeat(40) },
    });
    expect(calls[2]?.body).toEqual({ enabled: true, previews_enabled: false });
    expect(calls[3]?.body).toEqual({ observability: DEPLOY_OBSERVABILITY });
  });

  it("falls back to the newest deployment when the create response has no deployment_id", async () => {
    const { fetch } = mockFetch([
      [/^POST .*\/versions$/, notFound],
      [/^PUT /, () => ok({ id: "gf-r1-api" })],
      [/^POST .*\/subdomain$/, () => ok({})],
      [/^PATCH /, () => ok({})],
      [
        /^GET .*\/deployments$/,
        () =>
          ok({
            deployments: [
              {
                created_on: "2026-10-02T00:00:00Z",
                versions: [{ version_id: "v1", percentage: 100 }],
              },
            ],
          }),
      ],
    ]);
    const d = new WorkersDeployer({
      accountId: "acc",
      apiToken: "tok",
      fetch,
      workersDev: true,
      loadBundle: async () => bundle(),
    });
    expect(await d.uploadVersion(input)).toEqual({ versionId: "v1" });
  });

  it("reads a missing script as no live versions", async () => {
    const { fetch } = mockFetch([[/^GET .*\/deployments$/, notFound]]);
    const d = new WorkersDeployer({
      accountId: "acc",
      apiToken: "tok",
      fetch,
      loadBundle: async () => bundle(),
    });
    expect(await d.currentVersions("gf-r1-api")).toEqual([]);
  });
});

describe("WorkersDeployer later uploads", () => {
  it("uploads a version to an existing script with the platform bindings and the bundle's vars", async () => {
    const { fetch, calls } = mockFetch([
      [/^POST .*\/workers\/scripts\/gf-r1-api\/versions$/, () => ok({ id: "ver-2" })],
      [/^PATCH .*\/script-settings$/, () => ok({})],
    ]);
    const d = new WorkersDeployer({
      accountId: "acc",
      apiToken: "tok",
      fetch,
      loadBundle: async () => bundle([{ type: "plain_text", name: "GREETING", text: "hi" }]),
    });
    expect(await d.uploadVersion(input)).toEqual({ versionId: "ver-2" });
    // No create, no workers.dev toggle: only the version and the (idempotent) settings.
    expect(calls.map((c) => c.method)).toEqual(["POST", "PATCH"]);
    expect((await metadataOf(calls[0])).bindings).toEqual([
      { type: "plain_text", name: "GREETING", text: "hi" },
      ...PLATFORM_BINDINGS,
    ]);
  });

  it("does not create a script on other upload errors", async () => {
    const { fetch, calls } = mockFetch([
      [
        /^POST .*\/versions$/,
        () => ({
          status: 400,
          body: { success: false, errors: [{ code: 10021, message: "bad" }] },
        }),
      ],
    ]);
    const d = new WorkersDeployer({
      accountId: "acc",
      apiToken: "tok",
      fetch,
      loadBundle: async () => bundle(),
    });
    await expect(d.uploadVersion(input)).rejects.toThrow(/10021/);
    expect(calls).toHaveLength(1);
  });

  it("refuses a bundle that binds resources, before any API call", async () => {
    const { fetch, calls } = mockFetch([]);
    const d = new WorkersDeployer({
      accountId: "acc",
      apiToken: "tok",
      fetch,
      loadBundle: async () => bundle([{ type: "d1", name: "DB", id: "platform-db" }]),
    });
    await expect(d.uploadVersion(input)).rejects.toBeInstanceOf(BundleBindingError);
    expect(calls).toHaveLength(0);
  });
});

describe("deployBindings", () => {
  it.each([
    ["service", { type: "service", name: "PLATFORM", service: "gittifacts" }],
    ["r2", { type: "r2_bucket", name: "B", bucket_name: "gittifacts-blobs" }],
    ["kv", { type: "kv_namespace", name: "KV", namespace_id: "x" }],
    ["durable object", { type: "durable_object_namespace", name: "DO", class_name: "X" }],
    ["secret", { type: "secret_text", name: "S", text: "x" }],
    ["no type", { name: "X" }],
  ])("refuses a %s binding", (_label, binding) => {
    expect(() => deployBindings([binding], "app-1")).toThrow(BundleBindingError);
  });

  it("refuses the platform's binding names", () => {
    expect(() => deployBindings([{ type: "plain_text", name: "FLAGS", text: "x" }], "app")).toThrow(
      /reserved/,
    );
    expect(() => deployBindings([{ type: "json", name: "VERSION", json: {} }], "app")).toThrow(
      /reserved/,
    );
  });

  it("binds FLAGS to the project's own app (required) and VERSION", () => {
    expect(deployBindings(undefined, "app-1")).toEqual(PLATFORM_BINDINGS);
    expect(() => deployBindings([], "")).toThrow(BundleBindingError);
    // A bundle cannot bind any Flagship app itself (another project's, or the platform's).
    expect(() =>
      deployBindings([{ type: "flagship", name: "OTHER", app_id: "platform-app" }], "app-1"),
    ).toThrow(BundleBindingError);
  });

  it("two projects' Workers bind two different apps, each only its own", async () => {
    const { fetch, calls } = mockFetch([
      [/^POST .*\/versions$/, () => ok({ id: "v" })],
      [/^PATCH .*\/script-settings$/, () => ok({})],
    ]);
    const d = new WorkersDeployer({
      accountId: "acc",
      apiToken: "tok",
      fetch,
      loadBundle: async () => bundle(),
    });
    await d.uploadVersion({ ...input, script: "gf-r1-api", flagshipAppId: "app-r1" });
    await d.uploadVersion({ ...input, script: "gf-r2-api", flagshipAppId: "app-r2" });
    const flagsOf = async (i: number) =>
      ((await metadataOf(calls[i])).bindings as Array<Record<string, unknown>>).filter(
        (b) => b.type === "flagship",
      );
    expect(await flagsOf(0)).toEqual([{ type: "flagship", name: "FLAGS", app_id: "app-r1" }]);
    expect(await flagsOf(2)).toEqual([{ type: "flagship", name: "FLAGS", app_id: "app-r2" }]);
  });

  it("deletes a project's Worker with force; a missing one is fine", async () => {
    const { fetch, calls } = mockFetch([
      [/^DELETE .*\/workers\/scripts\/gf-r1-api\?force=true$/, () => ok(null)],
      [/^DELETE .*\/workers\/scripts\/gf-gone-api\?force=true$/, notFound],
    ]);
    const d = new WorkersDeployer({
      accountId: "acc",
      apiToken: "tok",
      fetch,
      loadBundle: async () => bundle(),
    });
    await d.deleteScript("gf-r1-api");
    await d.deleteScript("gf-gone-api");
    expect(calls.map((c) => c.method)).toEqual(["DELETE", "DELETE"]);
  });

  it("hyphenates bare UUIDs only", () => {
    expect(hyphenateUuid("0123456789abcdef0123456789abcdef")).toBe(
      "01234567-89ab-cdef-0123-456789abcdef",
    );
    expect(hyphenateUuid("01234567-89ab-cdef-0123-456789abcdef")).toBe(
      "01234567-89ab-cdef-0123-456789abcdef",
    );
  });
});
