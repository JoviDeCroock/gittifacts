/**
 * pnpm --filter @sim/merge-queue sim -- --scenario <name> --seed <n> [--mode <mode>] [--json]
 * pnpm --filter @sim/merge-queue gates [-- --seeds 1,2,3]
 */
import { writeFileSync } from "node:fs";
import { QueueConfig } from "@app/merge-queue";
import { join } from "node:path";
import { runGates } from "./gates.js";
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

function main(): number {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  if (args[0] === "gates") {
    const seeds = (arg(args, "seeds") ?? "1,2,3").split(",").map(Number);
    const result = runGates({ seeds, log: (s) => process.stdout.write(`${s}\n`) });
    const out = arg(args, "out") ?? join(import.meta.dirname, "..", "report.md");
    writeFileSync(out, renderReport(result));
    process.stdout.write(`\nreport: ${out}\n`);
    for (const g of result.gates) process.stdout.write(`${g.pass ? "PASS" : "FAIL"}  ${g.name}: ${g.detail}\n`);
    return result.gates.every((g) => g.pass) ? 0 : 1;
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
  process.exitCode = main();
}

function args0IsList(): boolean {
  return process.argv.slice(2).filter((a) => a !== "--")[0] === "list";
}
