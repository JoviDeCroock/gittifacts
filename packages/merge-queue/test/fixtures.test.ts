/**
 * The fixtures/queue corpus (computed by @app/affected from real git trees) driven through the
 * core: each scenario's affected sets, conflict matrix, git-merge outcomes and test outcomes become
 * the harness's ground truth.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AffectedSet, type CommandOf, conflicts } from "../src/index.js";
import { type TestChange, World } from "./harness.js";

interface Scenario {
  name: string;
  changes: { id: string; dependsOn: string | null }[];
  flaky?: { test: string };
  expected: {
    affected: Record<string, Omit<AffectedSet, "analyzers">>;
    conflicts: { pair: [string, string]; reasons: string[] }[];
    merges: { changes: string[]; clean: boolean }[];
    outcomes: { changes: string[]; pass: boolean; failing?: string[]; env?: Record<string, string> }[];
  };
}

const ROOT = join(import.meta.dirname, "..", "..", "..", "fixtures", "queue");
const scenarios: Scenario[] = existsSync(ROOT)
  ? readdirSync(ROOT)
      .filter((d) => existsSync(join(ROOT, d, "scenario.json")))
      .map((d) => JSON.parse(readFileSync(join(ROOT, d, "scenario.json"), "utf8")) as Scenario)
  : [];

function toChanges(s: Scenario): TestChange[] {
  const passesAlone = (id: string) => !s.expected.outcomes.some((o) => !o.pass && o.env === undefined && o.changes.length === 1 && o.changes[0] === id);
  return s.changes.map((c): TestChange => {
    const textual = s.expected.merges.filter((m) => !m.clean && m.changes.includes(c.id)).flatMap((m) => m.changes.filter((x) => x !== c.id));
    const semantic = s.expected.outcomes
      .filter((o) => !o.pass && o.env === undefined && o.changes.length === 2 && o.changes.includes(c.id) && o.changes.every(passesAlone))
      .flatMap((o) => o.changes.filter((x) => x !== c.id));
    const a = s.expected.affected[c.id];
    return {
      id: c.id,
      affected: a === undefined ? null : { ...a, analyzers: [] },
      textualWith: textual,
      semanticWith: semantic,
      dependsOn: c.dependsOn === null ? [] : [c.dependsOn],
      lane: 0,
    };
  });
}

const cmds = <T extends string>(w: World, type: T) => w.commands.filter((c) => c.type === type) as CommandOf<T & CommandOf<never>["type"]>[];

describe.skipIf(scenarios.length === 0)("fixtures/queue corpus", () => {
  it.each(scenarios.map((s) => [s.name, s] as const))("%s: conflict matrix matches the core's conflict relation", (_name, s) => {
    for (const c of s.expected.conflicts) {
      const [x, y] = c.pair;
      const ax = s.expected.affected[x];
      const ay = s.expected.affected[y];
      if (ax === undefined || ay === undefined) continue;
      expect(conflicts({ ...ax, analyzers: [] }, { ...ay, analyzers: [] }), `${x}/${y}`).toBe(c.reasons.length > 0);
    }
  });

  it.each(scenarios.map((s) => [s.name, s] as const))("%s: everything lands, main never red", (_name, s) => {
    const flakyTests = s.flaky === undefined ? [] : [s.flaky.test];
    const w = new World({ precompute: true, flakyTests, flakeRate: s.flaky === undefined ? 0 : 1, flakeRepeat: 1 });
    const changes = toChanges(s);
    // Textual conflicts only happen against changes authored before the other landed.
    for (const c of changes) w.enqueue(c);
    const parallel = Object.keys(w.state.tracks).length;
    w.drain();
    expect(w.violations).toEqual([]);
    expect(new Set(w.merged)).toEqual(new Set(changes.map((c) => c.id)));
    expect([...w.refs]).toEqual([]);
    const resolutions = w.commands.filter((c) => c.type === "RequestResolution");
    switch (s.name) {
      case "independent":
        expect(parallel).toBe(3);
        break;
      case "textual-conflict":
        expect(parallel).toBe(1);
        expect(resolutions.map((r) => r.type === "RequestResolution" && r.kind)).toContain("textual");
        break;
      case "semantic-conflict": {
        expect(parallel).toBe(1);
        const semantic = resolutions.find((r) => r.type === "RequestResolution" && r.kind === "semantic");
        expect(semantic?.type === "RequestResolution" && semantic.changeId).toBe("b");
        expect(semantic?.type === "RequestResolution" && semantic.upstream).toContain("a");
        const ready = w.commands.find((c) => c.type === "Emit" && c.event.type === "resolution_ready");
        expect(ready?.type === "Emit" && ready.event.type === "resolution_ready" && ready.event.blamedUpstream).toBe("a");
        break;
      }
      case "stack":
        expect(w.merged.indexOf("a")).toBeLessThan(w.merged.indexOf("b"));
        break;
      case "flaky-test": {
        // Fails in the batch and on main's head: quarantined (audited + Plan), not ejected; a is raised to Lane 1.
        expect(w.ejected.size).toBe(0);
        expect(cmds(w, "OpenPlan").length).toBe(1);
        expect(w.state.entries.a?.lane).toBe(1);
        expect(w.state.entries.b?.lane).toBe(0);
        break;
      }
      default:
        break;
    }
  });
});
