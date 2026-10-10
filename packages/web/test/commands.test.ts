/**
 * The palette's commands (lib/commands.ts) against the MCP contract: every agent twin names a
 * tool the server lists, with arguments that tool takes and every argument it requires, and every
 * act a product rule keeps human says so instead of offering a twin. A palette that told a person
 * "hand this to your agent" with a call the server rejects would teach the wrong boundary.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Command, cliArgs, commandsFor, contextOf, forMode, match, mcpText } from "../src/lib/commands.js";

/** Input schemas from the generated MCP contract snapshot (`pnpm --filter @app/mcp snapshot`). */
function contractInputs(): Map<string, { properties: Record<string, unknown>; required: string[] }> {
  const src = readFileSync(join(import.meta.dirname, "../../mcp/tools.introspection.d.ts"), "utf8");
  const out = new Map<string, { properties: Record<string, unknown>; required: string[] }>();
  for (const m of src.matchAll(/^ {4}"([a-z_]+)": \{\n {6}"inputSchema": /gm)) {
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    const schema = JSON.parse(src.slice(start, i + 1)) as { properties?: Record<string, unknown>; required?: string[] };
    out.set(m[1] ?? "", { properties: schema.properties ?? {}, required: schema.required ?? [] });
  }
  return out;
}

const TOOLS = contractInputs();
const REPOS = [{ id: "repo_billing", name: "billing-api" }];
const PATHS = ["/dashboard", "/repos/repo_billing", "/repos/repo_billing/queue", "/plans/plan_1", "/changes/chg_1", "/changes/chg_1/evidence", "/changes/chg_1/rollout", "/agents"];
const every: Command[] = PATHS.flatMap((p) => commandsFor(p, REPOS));

describe("agent twins", () => {
  it("read the contract snapshot", () => {
    expect(TOOLS.size).toBeGreaterThan(20);
    expect(Object.keys(TOOLS.get("get_change_status")?.properties ?? {})).toContain("changeId");
    expect(TOOLS.get("get_plan")?.required).toContain("planId");
  });

  it.each(every.filter((c) => c.twin).map((c) => [c.id, c] as const))("%s calls a real tool with its arguments", (_id, c) => {
    const twin = c.twin;
    if (!twin) return;
    const tool = TOOLS.get(twin.tool);
    expect(tool, `${twin.tool} is not in the MCP contract (packages/mcp/tools.introspection.d.ts)`).toBeDefined();
    if (!tool) return;
    const given = [...Object.keys(twin.args), ...(twin.fill ?? [])];
    for (const arg of given) expect(Object.keys(tool.properties), `${twin.tool} takes no "${arg}"`).toContain(arg);
    for (const req of tool.required) if (req !== "idempotencyKey") expect(given, `${twin.tool} requires "${req}"`).toContain(req);
    if (twin.positional) expect(Object.keys(twin.args)).toContain(twin.positional);
  });

  it("never offers a twin for an act a product rule keeps human", () => {
    for (const c of every) {
      if (c.personOnly) expect(c.twin, `${c.id} is person-only but has a twin`).toBeNull();
      expect(c.act !== null || c.twin !== null || c.personOnly !== undefined, `${c.id} does nothing`).toBe(true);
    }
    const approve = every.find((c) => c.id === "change.approve");
    expect(approve?.personOnly).toMatch(/person/i);
    expect(every.find((c) => c.id === "plan.approve")?.twin).toBeNull();
    expect(every.find((c) => c.id === "change.kill")?.twin).toBeNull();
  });
});

describe("modes", () => {
  it("lists runnable commands for a person, minus the screen in view", () => {
    const me = forMode(commandsFor("/changes/chg_1", REPOS), "me", "/changes/chg_1");
    expect(me.map((c) => c.id)).not.toContain("change.status");
    expect(me.map((c) => c.id)).toContain("change.approve");
    expect(me.every((c) => c.act !== null)).toBe(true);
  });

  it("lists twins and the human-only boundary for an agent", () => {
    const agent = forMode(commandsFor("/changes/chg_1", REPOS), "agent", "/changes/chg_1");
    expect(agent.map((c) => c.id)).toContain("change.rerun");
    expect(agent.map((c) => c.id)).toContain("change.approve");
    expect(agent.map((c) => c.id)).not.toContain("theme.dark");
  });
});

describe("text", () => {
  it("prints the MCP call and the CLI command the CLI derives from the same tool", () => {
    const c = commandsFor("/changes/chg_1", REPOS).find((x) => x.id === "change.evidence");
    if (!c?.twin) throw new Error("no twin");
    expect(mcpText(c.twin)).toBe('get_evidence({ "changeId": "chg_1" })');
    expect(cliArgs(c.twin)).toBe("get-evidence chg_1");
    expect(cliArgs({ tool: "create_plan", args: { repoId: "r 1" }, fill: ["title"] })).toBe("create-plan --repo-id 'r 1' --title <title>");
  });

  it("matches label prefixes first and tool names too", () => {
    const cmds = commandsFor("/changes/chg_1", REPOS);
    expect(match(cmds, "ev")[0]?.id).toBe("change.evidence");
    expect(match(cmds, "rerun_ci")[0]?.id).toBe("change.rerun");
    expect(match(cmds, "zzz")).toEqual([]);
  });

  it("reads the object in view from the path", () => {
    expect(contextOf("/changes/c%201/rollout")).toEqual({ kind: "change", id: "c 1", sub: "rollout" });
    expect(contextOf("/repos/r1/queue")).toEqual({ kind: "repo", id: "r1" });
    expect(contextOf("/audit")).toBeNull();
  });
});
