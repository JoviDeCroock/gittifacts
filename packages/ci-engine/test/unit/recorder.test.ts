import { describe, expect, it } from "vitest";
import {
  definePipeline,
  type PipelineCi,
  PlanError,
  recordPipeline,
  resolvePipelineExport,
} from "../../src/plan/recorder.js";
import type { PipelineSpec } from "../../src/plan/spec.js";

const shape = (spec: PipelineSpec) =>
  Object.fromEntries(spec.steps.map((s) => [s.name, { parent: s.parent, after: s.after }]));

describe("recordPipeline", () => {
  it("records the README example: install, three parallel checks, then build", async () => {
    const spec = await recordPipeline(async (ci: PipelineCi) => {
      const install = await ci.runner({
        name: "install",
        command: "pnpm install --frozen-lockfile",
        cache: { inputs: ["package.json", "pnpm-lock.yaml"] },
      });
      await Promise.all([
        install.runner({ name: "lint", command: "pnpm lint" }),
        install.runner({ name: "typecheck", command: "pnpm typecheck" }),
        install.runner({ name: "test", command: "pnpm test" }),
      ]);
      await install.runner({ name: "build", command: "pnpm build" });
    });
    expect(spec.source).toBe("file");
    expect(shape(spec)).toEqual({
      install: { parent: null, after: [] },
      lint: { parent: "install", after: [] },
      typecheck: { parent: "install", after: [] },
      test: { parent: "install", after: [] },
      build: { parent: "install", after: ["lint", "typecheck", "test"] },
    });
    expect(spec.steps[0]?.cache).toEqual({ inputs: ["package.json", "pnpm-lock.yaml"] });
  });

  it("records static, independent runners as parallel roots", async () => {
    const spec = await recordPipeline(async (ci) => {
      await Promise.all([
        ci.runner({ name: "a", command: "echo a" }),
        ci.runner({ name: "b", command: "echo b" }),
      ]);
    });
    expect(shape(spec)).toEqual({ a: { parent: null, after: [] }, b: { parent: null, after: [] } });
  });

  it("orders sequential awaits and reduces transitive edges", async () => {
    const spec = await recordPipeline(async (ci) => {
      await ci.runner({ name: "a", command: "echo a" });
      await ci.runner({ name: "b", command: "echo b" });
      await ci.runner({ name: "c", command: "echo c" });
    });
    expect(shape(spec)).toEqual({
      a: { parent: null, after: [] },
      b: { parent: null, after: ["a"] },
      c: { parent: null, after: ["b"] },
    });
  });

  it("records chains of snapshots (parent of a parent)", async () => {
    const spec = await recordPipeline(async (ci) => {
      const deps = await ci.runner({ name: "deps", command: "npm ci" });
      const built = await deps.runner({ name: "build", command: "npm run build" });
      await built.runner({ name: "e2e", command: "npm run e2e" });
    });
    expect(shape(spec)).toEqual({
      deps: { parent: null, after: [] },
      build: { parent: "deps", after: [] },
      e2e: { parent: "build", after: [] },
    });
  });

  it("does not order a runner after a promise that was only subscribed to, not delivered", async () => {
    const spec = await recordPipeline(async (ci) => {
      await Promise.all([
        ci.runner({ name: "a", command: "x" }).then((a) => a.runner({ name: "a2", command: "x" })),
        ci.runner({ name: "b", command: "y" }),
      ]);
    });
    expect(shape(spec).b).toEqual({ parent: null, after: [] });
    expect(shape(spec).a2).toEqual({ parent: "a", after: [] });
  });

  it("records conditional usage as plan mode executes it (every runner succeeds)", async () => {
    const spec = await recordPipeline(async (ci, ctx) => {
      const install = await ci.runner({ name: "install", command: "npm ci" });
      if (install.exitCode === 0) {
        await install.runner({ name: "test", command: "npm test" });
      } else {
        await ci.runner({ name: "never", command: "echo unreachable" });
      }
      if (ctx.mode === "plan" && ctx.sha === "abc")
        await ci.runner({ name: "sha-gated", command: "true" });
      try {
        await install.runner({ name: "deploy-preview", command: "true" });
      } catch {
        await ci.runner({ name: "on-failure", command: "true" });
      }
    });
    expect(spec.steps.map((s) => s.name)).toEqual(["install", "test", "deploy-preview"]);
  });

  it("passes the context through", async () => {
    const spec = await recordPipeline(
      async (ci, ctx) => {
        if (ctx.sha === "abc") await ci.runner({ name: "only-on-abc", command: "true" });
      },
      { context: { sha: "abc" } },
    );
    expect(spec.steps.map((s) => s.name)).toEqual(["only-on-abc"]);
  });

  it("records fire-and-forget chains started before the function returns", async () => {
    const spec = await recordPipeline((ci) => {
      void ci
        .runner({ name: "a", command: "x" })
        .then((a) => a.runner({ name: "b", command: "y" }));
    });
    expect(shape(spec)).toEqual({ a: { parent: null, after: [] }, b: { parent: "a", after: [] } });
  });

  it("maps @cloudflare/ci config fields and warns about ignored ones", async () => {
    const spec = await recordPipeline(async (ci) => {
      await ci.runner({
        name: "slow",
        command: "x",
        cwd: "./packages/app/",
        config: { timeout: 45 * 60_000, retries: { limit: 3, delay: 1 } },
      });
    });
    expect(spec.steps[0]).toMatchObject({ name: "slow", cwd: "packages/app", timeoutMinutes: 30 });
    expect(spec.warnings.join("\n")).toMatch(/clamped to 30 minutes/);
    expect(spec.warnings.join("\n")).toMatch(/retries is ignored/);
  });

  it("rejects secrets and credentials", async () => {
    await expect(
      recordPipeline(async (ci) => {
        await ci.runner({ name: "deploy", command: "wrangler deploy", secrets: ["CF_TOKEN"] });
      }),
    ).rejects.toThrow(/never receive platform credentials/);
    await expect(
      recordPipeline(async (ci) => {
        await ci.runner({ name: "deploy", command: "x", cloudflareCredentials: true });
      }),
    ).rejects.toBeInstanceOf(PlanError);
  });

  it("rejects duplicate and reserved names, bad env keys and absolute cwd", async () => {
    await expect(
      recordPipeline(async (ci) => {
        await ci.runner({ name: "a", command: "x" });
        await ci.runner({ name: "a", command: "y" });
      }),
    ).rejects.toThrow(/duplicate step name "a"/);
    await expect(
      recordPipeline((ci) => ci.runner({ name: "finalize", command: "x" })),
    ).rejects.toThrow(/reserved/);
    await expect(
      recordPipeline((ci) =>
        ci.runner({ name: "a", command: "x", env: { GITTIFACTS_TOKEN: "x" } }),
      ),
    ).rejects.toThrow(/reserved/);
    await expect(
      recordPipeline((ci) => ci.runner({ name: "a", command: "x", cwd: "/etc" })),
    ).rejects.toThrow(/relative/);
    await expect(
      recordPipeline((ci) => ci.runner({ name: "has space", command: "x" })),
    ).rejects.toThrow(/step names/);
  });

  it("wraps errors thrown by the pipeline function", async () => {
    await expect(
      recordPipeline(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow(/the pipeline function threw: boom/);
  });

  it("times out a pipeline function that waits on something else", async () => {
    await expect(recordPipeline(() => new Promise(() => {}), { timeoutMs: 50 })).rejects.toThrow(
      /did not finish/,
    );
  });

  it("refuses runner calls after the function finished", async () => {
    let late: PipelineCi | undefined;
    await recordPipeline((ci) => {
      late = ci;
    });
    expect(() => late?.runner({ name: "late", command: "x" })).toThrow(
      /after the pipeline function finished/,
    );
  });

  it("caps the number of steps", async () => {
    await expect(
      recordPipeline(async (ci) => {
        for (let i = 0; i < 60; i++) await ci.runner({ name: `s${i}`, command: "x" });
      }),
    ).rejects.toThrow(/at most 50 steps/);
  });

  it("supports catch/finally on runner promises", async () => {
    const order: string[] = [];
    const spec = await recordPipeline(async (ci) => {
      await ci
        .runner({ name: "a", command: "x" })
        .catch(() => order.push("catch"))
        .finally(() => order.push("finally"));
    });
    expect(order).toEqual(["finally"]);
    expect(spec.steps).toHaveLength(1);
  });
});

describe("resolvePipelineExport", () => {
  const fn = definePipeline(async () => {});
  it("accepts default, nested default and named pipeline exports", () => {
    expect(resolvePipelineExport({ default: fn })).toBe(fn);
    expect(resolvePipelineExport({ default: { default: fn } })).toBe(fn);
    expect(resolvePipelineExport({ pipeline: fn })).toBe(fn);
    expect(resolvePipelineExport(fn)).toBe(fn);
  });
  it("rejects modules without a function", () => {
    expect(() => resolvePipelineExport({ default: 1 })).toThrow(/export default/);
  });
});
