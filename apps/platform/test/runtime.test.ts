/**
 * The Cloudflare Ports wiring (src/runtime): role-scoped git writes, the sandbox jobs speaking the
 * ci-engine Runner's RPC contract, the lazy signer and CI engine, and rollout bundles from R2.
 */
import { env } from "cloudflare:workers";
import { PlanJob, RunnerJob } from "@app/ci-engine";
import { GitWriteForbiddenError } from "@app/coordinator/adapters";
import { describe, expect, it } from "vitest";
import { BundleError, bundleFromEntries, parseTar, r2BundleLoader } from "../src/runtime/bundle.js";
import { buildPorts, LazySigner, lazyCiEngine, type PortsEnv } from "../src/runtime/ports.js";

const SHA = "c".repeat(40);

// ---------------------------------------------------------------- tar.gz helpers

function header(name: string, size: number, type = "0"): Uint8Array {
  const h = new Uint8Array(512);
  const enc = new TextEncoder();
  h.set(enc.encode(name).subarray(0, 100), 0);
  h.set(enc.encode("0000644\0"), 100);
  h.set(enc.encode("0000000\0"), 108);
  h.set(enc.encode("0000000\0"), 116);
  h.set(enc.encode(`${size.toString(8).padStart(11, "0")}\0`), 124);
  h.set(enc.encode("00000000000\0"), 136);
  h.set(enc.encode("        "), 148);
  h[156] = type.charCodeAt(0);
  h.set(enc.encode("ustar\0"), 257);
  h.set(enc.encode("00"), 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return h;
}

function tar(files: Record<string, string>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, text] of Object.entries(files)) {
    const data = new TextEncoder().encode(text);
    parts.push(header(name, data.length));
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    parts.push(padded);
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------------------------------------------------------------- tests

describe("buildPorts", () => {
  it("gives only the merge-queue role a GitHost that may write main repos", async () => {
    const regular = buildPorts(env, "default");
    await expect(regular.git.writeNote("app", SHA, "note")).rejects.toBeInstanceOf(
      GitWriteForbiddenError,
    );
    await expect(regular.git.mintToken("app", "write", 300)).rejects.toBeInstanceOf(
      GitWriteForbiddenError,
    );
    await expect(regular.git.deleteRepo("app")).rejects.toBeInstanceOf(GitWriteForbiddenError);
    // Forks are writable by everyone; main repos only by the merge queue.
    const deleted: string[] = [];
    const artifacts = {
      ...env,
      ARTIFACTS: {
        delete: async (name: string) => {
          deleted.push(name);
          return true;
        },
      },
    } as unknown as PortsEnv;
    await buildPorts(artifacts, "default").git.deleteRepo("task-abc");
    const queue = buildPorts(artifacts, "merge-queue");
    await queue.git.deleteRepo("app");
    expect(deleted).toEqual(["task-abc", "app"]);
    expect(queue.git.remoteOf("app")).toBe(
      `https://${env.CF_ACCOUNT_ID}.artifacts.cloudflare.net/git/gittifacts-eu/app.git`,
    );
  });

  it("sends sandbox jobs the Runner accepts (PlanJob / RunnerJob) and reads their markers", async () => {
    const jobs: Array<{ op: string; job: unknown }> = [];
    const runner = {
      async plan(job: unknown) {
        jobs.push({ op: "plan", job: PlanJob.parse(job) });
        return {
          ok: true,
          stdout: `building\n::plan::${JSON.stringify({ version: 1, steps: [] })}\n`,
          stderr: "",
          exitCode: 0,
          computeMs: 10,
        };
      },
      async run(job: unknown) {
        jobs.push({ op: "run", job: RunnerJob.parse(job) });
        const doc = { kind: "policy", status: "ok", source: "default", policy: null, issues: [] };
        return {
          ok: true,
          exitCode: 0,
          timedOut: false,
          tail: `::evidence::${JSON.stringify(doc)}\n`,
        };
      },
    };
    const withRunner = {
      ...env,
      RUNNER: { getByName: () => runner },
    } as unknown as PortsEnv;
    const ports = buildPorts(withRunner, "default");

    expect(await ports.sandbox.planPipeline({ repo: "task-abc", sha: SHA })).toEqual({
      version: 1,
      steps: [],
    });
    expect(await ports.sandbox.evaluatePolicy({ repo: "app", sha: SHA })).toBeNull();
    expect(jobs.map((j) => j.op)).toEqual(["plan", "run"]);
    expect(jobs[0]?.job).toMatchObject({
      artifactsRepo: "task-abc",
      sha: SHA,
      file: ".platform/ci.ts",
    });
    expect(jobs[1]?.job).toMatchObject({
      artifactsRepo: "app",
      headSha: SHA,
      command: `gittifacts-runner policy --base ${SHA}`,
      logKey: expect.stringMatching(/^ci-logs\/job-policy-[^/]+\/policy\.log$/),
    });
  });

  it("signs with the platform key on first use", async () => {
    const signer = new LazySigner(env);
    expect(() => signer.keyId).toThrow(/not loaded/);
    const signature = await signer.signDocument({ hello: "world" });
    expect(signature.length).toBeGreaterThan(20);
    expect(signer.keyId).toMatch(/.+/);
  });

  it("picks the CI engine from CI_ENGINE on first use, refusing unknown and opt-in engines", async () => {
    const run = {
      runId: "r",
      changeId: "c",
      repo: { remote: "https://x", tokenProvider: "artifacts" as const },
      artifactsRepo: "task-c",
      headSha: SHA,
      baseSha: SHA,
    };
    await expect(
      lazyCiEngine({ ...env, CI_ENGINE: "jenkins" } as PortsEnv).start(run),
    ).rejects.toThrow(/not a known engine/);
    await expect(
      lazyCiEngine({ ...env, CI_ENGINE: "cloudflare-ci" } as PortsEnv).start(run),
    ).rejects.toThrow(/opt-in/);
    expect(env.CI_ENGINE).toBe("workflows");
  });
});

describe("rollout bundles (r2BundleLoader)", () => {
  it("loads a CI build artifact: strips dist/, finds the main module, keeps wasm", async () => {
    const key = "ci-artifacts/run-abc-123456789012/build/bundle.tgz";
    await env.CI_BUCKET.put(
      key,
      await gzip(
        tar({
          "dist/index.js": "export default { fetch() { return new Response('hi') } }",
          "dist/chunk-1.js": "export const x = 1;",
          "dist/index.js.map": "{}",
          "dist/lib.wasm": "\0asm",
        }),
      ),
    );
    const bundle = await r2BundleLoader(env.CI_BUCKET, { compatibilityDate: "2026-09-30" })(key);
    expect(bundle.mainModule).toBe("index.js");
    expect(bundle.modules.map((m) => m.name).sort()).toEqual([
      "chunk-1.js",
      "index.js",
      "lib.wasm",
    ]);
    expect(bundle.metadata).toEqual({ compatibility_date: "2026-09-30" });
  });

  it("takes main, compatibility settings and bindings from a wrangler.json in the bundle", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const bundle = bundleFromEntries(
      [
        { path: "./out/worker.mjs", data: enc("export default {}") },
        { path: "./out/util.mjs", data: enc("export {}") },
        {
          path: "./out/wrangler.json",
          data: enc(
            JSON.stringify({
              main: "./worker.mjs",
              compatibility_date: "2026-01-01",
              compatibility_flags: ["nodejs_compat"],
              bindings: [{ type: "plain_text", name: "X", text: "1" }],
            }),
          ),
        },
      ],
      { compatibilityDate: "2026-09-30" },
    );
    expect(bundle).toMatchObject({
      mainModule: "worker.mjs",
      metadata: {
        compatibility_date: "2026-01-01",
        compatibility_flags: ["nodejs_compat"],
        bindings: [{ name: "X" }],
      },
    });
  });

  it("refuses anything that is not a CI artifact, unsafe paths and ambiguous mains", async () => {
    const load = r2BundleLoader(env.CI_BUCKET, { compatibilityDate: "2026-09-30" });
    await expect(load("repos/x/secret.tgz")).rejects.toBeInstanceOf(BundleError);
    await expect(load("ci-artifacts/run-1/build/../../x.tgz")).rejects.toBeInstanceOf(BundleError);
    await expect(load("ci-artifacts/run-missing/build/bundle.tgz")).rejects.toThrow(/not found/);
    const enc = new TextEncoder();
    expect(() =>
      bundleFromEntries([{ path: "../evil.js", data: enc.encode("x") }], {
        compatibilityDate: "2026-09-30",
      }),
    ).toThrow(/unsafe path/);
    expect(() =>
      bundleFromEntries(
        [
          { path: "a.js", data: enc.encode("x") },
          { path: "b.js", data: enc.encode("y") },
        ],
        { compatibilityDate: "2026-09-30" },
      ),
    ).toThrow(/main module/);
    expect(parseTar(tar({ "a/b.txt": "hello" }))).toEqual([
      { path: "a/b.txt", data: enc.encode("hello") },
    ]);
  });
});
