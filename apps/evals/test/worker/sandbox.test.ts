import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TestEvalSandbox } from "./entry.js";

const ns = (env as unknown as { EVAL_SANDBOX: DurableObjectNamespace<TestEvalSandbox> })
  .EVAL_SANDBOX;

describe("EvalSandbox", () => {
  it("starts the sandbox image lazily, once, with internet, and runs sh -c under timeout as the runner user", async () => {
    const sb = ns.getByName("run-sandbox-1");
    expect((await sb.inspect()).starts).toBe(0);
    const a = await sb.exec("echo hi", 30, "m-1--t1--kimi--r1");
    expect(a).toMatchObject({ exitCode: 0, timedOut: false, error: null });
    expect(a.output).toContain("ran: exec timeout --kill-after=10 30 sh -c 'echo hi'");
    const b = await sb.exec("pnpm test; exit 3", 600, "m-1--t1--kimi--r1");
    expect(b.exitCode).toBe(3);
    const seen = await sb.inspect();
    expect(seen.starts).toBe(1);
    expect(JSON.parse(seen.lastStart)).toMatchObject({
      image: "registry.test/gittifacts-sandbox:abc",
      enableInternet: true,
      instance: "standard-1",
      labels: { "gf-eval-run": "m-1--t1--kimi--r1" },
    });
    // The readiness probe, then the two commands.
    expect(seen.execs.map((e) => e.cmd[0])).toEqual(["true", "sh", "sh"]);
    expect(seen.execs[1]).toMatchObject({ user: "10001:10001", cwd: "/workspace" });
    expect(seen.execs[1]!.cmd).toEqual([
      "sh",
      "-c",
      "exec timeout --kill-after=10 30 sh -c 'echo hi'",
    ]);
  });

  it("destroys the container at the end of the run (and is a no-op when nothing ran)", async () => {
    const idle = ns.getByName("run-sandbox-idle");
    await idle.destroy();
    expect((await idle.inspect()).destroyed).toBe(0);
    const sb = ns.getByName("run-sandbox-2");
    await sb.exec("true", 5);
    await sb.destroy();
    expect(await sb.inspect()).toMatchObject({ running: false, destroyed: 1 });
  });
});
