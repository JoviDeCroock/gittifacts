/**
 * The palette's commands (lib/commands.ts) against the MCP contract: every agent twin names a
 * tool the server lists, with arguments that tool takes and every argument it requires, and every
 * act a product rule keeps human says so instead of offering a twin. A palette that told a person
 * "hand this to your agent" with a call the server rejects would teach the wrong boundary.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Command, cliArgs, commandsFor, contextOf, forMode, jumpCommand, match, mcpText, objectCommands } from "../src/lib/commands.js";

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
const REPOS = [{ id: "repo_billing", name: "billing-api" }, { id: "gh-1", name: "acme/web", hosted: true }];
const PATHS = ["/dashboard", "/repos/repo_billing", "/repos/repo_billing/queue", "/repos/repo_billing/members", "/repos/repo_billing/mission", "/repos/gh-1", "/plans/plan_1", "/changes/chg_1", "/changes/chg_1/evidence", "/changes/chg_1/rollout", "/agents", "/audit"];
const OBJECTS = {
  changes: [{ id: "chg_fx2r7", title: "Jittered backoff for webhook retries", repoId: "repo_billing", status: "awaiting-review" }],
  plans: [{ id: "plan_tz", title: "Store timestamps in UTC", repoId: "repo_billing", status: "draft" }],
  agents: [{ id: "prn_coder07", name: "fleet-coder-07" }],
};
const every: Command[] = [
  ...PATHS.flatMap((p) => commandsFor(p, REPOS)),
  ...commandsFor("/changes/chg_1", REPOS, { status: "queued" }),
  ...commandsFor("/plans/plan_1", REPOS, { status: "draft", mine: true }),
  ...objectCommands(OBJECTS, REPOS),
  ...["chg_1", "plan_1", "repo_billing", "/audit"].flatMap((q) => jumpCommand(q, "https://x.test") ?? []),
];

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

  // The Twin Rule (DESIGN.md, Palette): a twin, a person-only rule, or a reason there is none.
  it.each(every.map((c) => [c.id, c] as const))("%s has exactly one of a twin, a person-only rule or a twinless reason", (_id, c) => {
    const said = [c.twin !== null, c.personOnly !== undefined, c.twinless !== undefined].filter(Boolean).length;
    expect(said, `${c.id}: give it a twin, a personOnly rule or a twinless reason (exactly one)`).toBe(1);
    // A person-only row without an act (no screen does it yet) still shows the boundary to agents.
    expect(c.act !== null || c.twin !== null || c.personOnly !== undefined, `${c.id} does nothing for anyone`).toBe(true);
  });

  it("never offers a twin for an act a product rule keeps human", () => {
    const approve = every.find((c) => c.id === "change.approve");
    expect(approve?.personOnly).toMatch(/person/i);
    expect(every.find((c) => c.id === "plan.approve")?.twin).toBeNull();
    expect(every.find((c) => c.id === "change.kill")?.twin).toBeNull();
    // Picking an attempt approves it: person-only; comparing them is an agent's read.
    expect(every.find((c) => c.id === "plan.pick")).toMatchObject({ twin: null, personOnly: expect.stringMatching(/person/i) });
    expect(every.find((c) => c.id === "plan.attempts")?.twin).toMatchObject({ tool: "compare_attempts", args: { planId: "plan_1" } });
    for (const id of ["go.agents", "agents.add", "agents.revoke", "repo.membership", "repo.lane0", "queue.freeze", "plan.reject"]) {
      expect(every.find((c) => c.id === id)?.personOnly, `${id} is a person's act`).toMatch(/person/i);
    }
  });

  it("names the walkthrough's own tool, and the agent's hand-offs on a change", () => {
    const cmds = commandsFor("/changes/chg_1", REPOS);
    expect(cmds.find((c) => c.id === "change.tour")?.twin?.tool).toBe("get_tour");
    for (const tool of ["request_review", "close_change", "queue_status", "get_qa", "get_change_status"]) expect(cmds.map((c) => c.twin?.tool)).toContain(tool);
    expect(cmds.map((c) => c.id)).not.toContain("change.dequeue");
    expect(commandsFor("/changes/chg_1", REPOS, { status: "queued" }).find((c) => c.id === "change.dequeue")?.twin?.tool).toBe("dequeue");
    expect(commandsFor("/changes/chg_1/rollout", REPOS).find((c) => c.id === "change.issues")?.twin?.tool).toBe("list_issues_for_change");
    expect(cmds.find((c) => c.id === "change.rollout")?.twin?.tool).toBe("get_rollout");
    expect(commandsFor("/dashboard", REPOS).find((c) => c.id === "go.audit")?.twin?.tool).toBe("list_audit_events");
  });

  it("lets a person reach plan approval from the palette, which signs nothing itself", () => {
    const me = forMode(commandsFor("/plans/plan_1", REPOS), "me", "/plans/plan_1");
    expect(me.find((c) => c.id === "plan.approve")?.act).toEqual({ kind: "go", href: "/plans/plan_1#sign" });
    expect(me.find((c) => c.id === "plan.reject")?.act).toEqual({ kind: "go", href: "/plans/plan_1#sign" });
    // Withdrawing is for the author's own draft only; the page confirms it on #withdraw.
    expect(me.map((c) => c.id)).not.toContain("plan.withdraw");
    const mine = forMode(commandsFor("/plans/plan_1", REPOS, { status: "draft", mine: true }), "me", "/plans/plan_1");
    expect(mine.find((c) => c.id === "plan.withdraw")?.act).toEqual({ kind: "go", href: "/plans/plan_1#withdraw" });
    expect(forMode(commandsFor("/plans/plan_1", REPOS, { status: "approved", mine: true }), "me", "/plans/plan_1").map((c) => c.id)).not.toContain("plan.withdraw");
  });

  it("offers no merge queue on a GitHub-mode repo (GitHub merges)", () => {
    expect(commandsFor("/repos/gh-1", REPOS).map((c) => c.id)).not.toContain("repo.queue");
    expect(commandsFor("/repos/repo_billing", REPOS).map((c) => c.id)).toContain("repo.queue");
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
    expect(agent.map((c) => c.id)).not.toContain("change.next-stop");
    // Places no tool reads yet stay listed, with the reason, instead of vanishing.
    const audit = forMode(commandsFor("/dashboard", REPOS), "agent", "/dashboard").find((c) => c.id === "go.audit");
    expect(audit?.twin ?? audit?.twinless).toBeTruthy();
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
    expect(contextOf("/repos/r1/queue")).toEqual({ kind: "repo", id: "r1", sub: "queue" });
    expect(contextOf("/audit")).toEqual({ kind: "audit" });
    expect(contextOf("/settings/integrations")).toBeNull();
  });

  it("finds changes, plans and agents by title or id, with one heading per group", () => {
    const cmds = [...commandsFor("/dashboard", REPOS), ...objectCommands(OBJECTS, REPOS)];
    expect(match(cmds, "jittered backoff")[0]?.id).toBe("open.change.chg_fx2r7");
    expect(match(cmds, "chg_fx2r7")[0]?.id).toBe("open.change.chg_fx2r7");
    expect(match(cmds, "utc")[0]?.id).toBe("open.plan.plan_tz");
    expect(match(cmds, "fleet-coder")[0]?.id).toBe("open.agent.prn_coder07");
    const groups = match(cmds, "a").map((c) => c.group);
    expect(groups.filter((g, i) => g !== groups[i - 1])).toEqual([...new Set(groups)]);
  });

  it("jumps to a pasted id or app address", () => {
    expect(jumpCommand("chg_zz9", "https://x.test")?.act).toEqual({ kind: "go", href: "/changes/chg_zz9" });
    expect(jumpCommand("https://x.test/plans/plan_1#sign", "https://x.test")?.act).toEqual({ kind: "go", href: "/plans/plan_1#sign" });
    expect(jumpCommand("backoff", "https://x.test")).toBeNull();
  });
});
