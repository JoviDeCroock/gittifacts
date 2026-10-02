/**
 * pnpm --filter @sim/merge-queue sim -- --scenario <name> --seed <n> [--mode <mode>] [--json]
 *   [--set knob=json]... [--cfg queueConfigKey=json]...
 * pnpm --filter @sim/merge-queue gates [-- --seeds 1,2,3 --jobs 3 --out report.md]
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { QueueConfig } from "@app/merge-queue";
import { type GateJob, type GatesRun, gateJobs, runJob, summarizeGates } from "./gates.js";
import type { RunMetrics } from "./sim.js";
import { MODES, modeConfig } from "./modes.js";
import { renderReport } from "./report.js";
import { getScenario, type Scenario, SCENARIOS } from "./scenarios.js";
import { simulate } from "./sim.js";
import { generate } from "./workload.js";
import { formatRun } from "./format.js";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** `--set a.b=1` overrides scenario knobs (JSON values). */
function withOverrides(s: Scenario, args: string[]): Scenario {
  const out = structuredClone(s) as unknown as Record<string, unknown>;
  args.forEach((a, i) => {
    if (a !== "--set") return;
    const kv = args[i + 1] ?? "";
    const eq = kv.indexOf("=");
    const path = kv.slice(0, eq).split(".");
    let obj = out;
    for (const k of path.slice(0, -1)) obj = obj[k] as Record<string, unknown>;
    obj[path[path.length - 1] ?? ""] = JSON.parse(kv.slice(eq + 1));
  });
  return out as unknown as Scenario;
}

/** `--cfg maxSpeculationDepth=2` overrides queue config (JSON values; dotted paths). */
function configOverrides(c: QueueConfig, args: string[]): QueueConfig {
  const out = structuredClone(c) as unknown as Record<string, unknown>;
  args.forEach((a, i) => {
    if (a !== "--cfg") return;
    const kv = args[i + 1] ?? "";
    const eq = kv.indexOf("=");
    const path = kv.slice(0, eq).split(".");
    let obj = out;
    for (const k of path.slice(0, -1)) obj = obj[k] as Record<string, unknown>;
    obj[path[path.length - 1] ?? ""] = JSON.parse(kv.slice(eq + 1));
  });
  return QueueConfig.parse(out);
}

/** Run one job in a child process (same tsx loader), return its JSON result. */
function runChild(j: GateJob): Promise<ReturnType<typeof runJob>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1] ?? "", "one", "--scenario", j.scenario, "--seed", String(j.seed), "--mode", j.mode], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out) as ReturnType<typeof runJob>) : reject(new Error(`job ${JSON.stringify(j)} exited ${code}`))));
  });
}

async function gates(args: string[]): Promise<number> {
  const seeds = (arg(args, "seeds") ?? "1,2,3").split(",").map(Number);
  const jobs = gateJobs(seeds);
  const parallel = Math.max(1, Number(arg(args, "jobs") ?? "3"));
  const runs: RunMetrics[] = [];
  const workloads: GatesRun["workloads"] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let j = jobs[next++]; j !== undefined; j = jobs[next++]) {
      const r = await runChild(j);
      runs.push(r.metrics);
      workloads.push(r.workload);
      const m = r.metrics;
      process.stdout.write(`[${runs.length}/${jobs.length}] ${j.scenario} #${j.seed} ${j.mode}: merged ${m.merged}/${m.arrivals} p95 ${m.timeInQueueMin.p95.toFixed(1)}m ci ${m.ciRatio.toFixed(2)}x red ${m.mainRedEvents} (${(m.wallMs / 1000).toFixed(0)}s)\n`);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  const order = (r: RunMetrics) => jobs.findIndex((j) => j.scenario === r.scenario && j.seed === r.seed && j.mode === r.mode);
  runs.sort((a, b) => order(a) - order(b));
  const result = summarizeGates(seeds, runs, workloads);
  const out = arg(args, "out") ?? join(import.meta.dirname, "..", "report.md");
  writeFileSync(out, renderReport(result));
  process.stdout.write(`\nreport: ${out}\n`);
  for (const g of result.gates) process.stdout.write(`${g.pass ? "PASS" : "FAIL"}  ${g.name}: ${g.detail}\n`);
  return result.gates.every((g) => g.pass) ? 0 : 1;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  if (args[0] === "gates") return gates(args);
  if (args[0] === "one") {
    const r = runJob({ scenario: arg(args, "scenario") ?? "gate-200", seed: Number(arg(args, "seed") ?? "1"), mode: arg(args, "mode") ?? "full" });
    process.stdout.write(JSON.stringify(r));
    return 0;
  }
  const scenario = withOverrides(getScenario(arg(args, "scenario") ?? "gate-200"), args);
  const seed = Number(arg(args, "seed") ?? "1");
  const modes = (arg(args, "mode") ?? "full").split(",");
  const workload = generate(scenario, seed);
  for (const mode of modes) {
    if (MODES[mode] === undefined) throw new Error(`unknown mode ${mode}; known: ${Object.keys(MODES).join(", ")}`);
    const m = simulate(workload, { mode, config: configOverrides(modeConfig(mode), args), invariantEvery: Number(arg(args, "check") ?? "0") });
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(m, null, 2)}\n`);
    else process.stdout.write(`${formatRun(m, workload)}\n`);
  }
  return 0;
}

if (args0IsList()) {
  process.stdout.write(`scenarios: ${Object.keys(SCENARIOS).join(", ")}\nmodes: ${Object.keys(MODES).join(", ")}\n`);
} else {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
      process.exitCode = 2;
    },
  );
}

function args0IsList(): boolean {
  return process.argv.slice(2).filter((a) => a !== "--")[0] === "list";
}
