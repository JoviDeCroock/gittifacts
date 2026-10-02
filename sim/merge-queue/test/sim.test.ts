/**
 * Simulator tests: determinism and the safety gates on short runs (the full gate suite is
 * `pnpm --filter @sim/merge-queue gates`).
 */
import { describe, expect, it } from "vitest";
import { summarizeGates } from "../src/gates.js";
import { modeConfig } from "../src/modes.js";
import { renderReport } from "../src/report.js";
import { getScenario } from "../src/scenarios.js";
import { type RunMetrics, simulate } from "../src/sim.js";
import { generate } from "../src/workload.js";

function short(name: string, seed: number, hours: number, mode = "full", invariantEvery = 0): RunMetrics {
  const w = generate({ ...getScenario(name), hours, drainHours: 4 }, seed);
  return simulate(w, { mode, config: modeConfig(mode), invariantEvery });
}

const stable = (m: RunMetrics) => ({ ...m, wallMs: 0 });

describe("simulator", () => {
  it("is deterministic: same seed ⇒ identical metrics and report", () => {
    const a = short("gate-200", 7, 0.5);
    const b = short("gate-200", 7, 0.5);
    expect(stable(a)).toEqual(stable(b));
    const ra = renderReport(summarizeGates([7], [stable(a)], []));
    const rb = renderReport(summarizeGates([7], [stable(b)], []));
    expect(ra).toBe(rb);
    const c = short("gate-200", 8, 0.5);
    expect(stable(c)).not.toEqual(stable(a));
  });

  it.each(["gate-200", "incidents", "flaky-storm", "stacks-groups", "conflict-heavy"])(
    "%s (short): main never red, every regression attributed, no violation, no leaked ref",
    (name) => {
      const m = short(name, 3, 1, "full", 40);
      expect(m.invariantViolations).toEqual([]);
      expect(m.mainRedEvents).toBe(0);
      expect(m.attributionFailures).toBe(0);
      expect(m.refsLeaked).toBe(0);
      expect(m.resolver.laneDecreases).toBe(0);
      expect(m.unfinished).toBe(0);
    },
  );

  it("the serial baseline runs the same core and is far slower", () => {
    const full = short("low-50", 2, 1);
    const serial = short("low-50", 2, 1, "serial");
    expect(serial.mainRedEvents).toBe(0);
    expect(serial.timeInQueueMin.p95).toBeGreaterThan(full.timeInQueueMin.p95);
  });
});
