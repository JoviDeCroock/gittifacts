import { WaitUntil } from "@app/domain";
import { describe, expect, it } from "vitest";
import {
  AGENTS_MD_MAX_LINES,
  type AgentsMdOptions,
  agentsMd,
  CONVENTIONS_MARKER,
  commandsFor,
  detectProject,
  isOutdated,
  TEMPLATE_IDS,
} from "../src/index.js";
import { callsIn, expectValidCall, HOST, MCP_URL } from "./helpers.js";

const base = { projectName: "my-api", host: HOST, mcpUrl: MCP_URL, repoId: "rep_123" };
const variants: AgentsMdOptions[] = [
  ...TEMPLATE_IDS.flatMap((template) => [true, false].map((claimed) => ({ ...base, template, claimed }))),
  { ...base, claimed: true },
  {
    ...base,
    claimed: false,
    commands: commandsFor(detectProject({ rootEntries: ["package.json", "yarn.lock", "wrangler.toml"], packageJson: { scripts: { test: "jest" } } }).features),
  },
];

describe.each(variants.map((v) => [`${v.template ?? (v.commands ? "import" : "none")}/${v.claimed ? "claimed" : "unclaimed"}`, v] as const))(
  "agentsMd %s",
  (_name, opts) => {
    const md = agentsMd(opts);
    const lines = md.split("\n");

    it(`stays under ${AGENTS_MD_MAX_LINES} lines`, () => {
      expect(lines.length).toBeLessThan(AGENTS_MD_MAX_LINES);
    });

    it("starts with the version marker and is current", () => {
      expect(lines[0]).toBe(CONVENTIONS_MARKER);
      expect(isOutdated(md)).toBe(false);
    });

    it("covers every required topic", () => {
      for (const heading of ["## The loop", "## Hard rules", "## Fixes need red/green proof", "## Lanes", "## Reading a tour", "## Waiting for results", "## Commands"]) {
        expect(md).toContain(heading);
      }
      for (const call of ["create_plan(", "start_change(", "wait_for_change(", "get_tour(", "request_review("]) expect(md).toContain(call);
      expect(md).toMatch(/Never push to main/);
      expect(md).toMatch(/Agents never approve/);
      expect(md).toMatch(/fails on the base commit and passes/);
      expect(md).toMatch(/shadow mode/i);
      for (const until of WaitUntil.options) expect(md).toContain(`\`${until}\``);
      for (const lane of ["| 0 |", "| 1 |", "| 2 |"]) expect(md).toContain(lane);
    });

    it("only uses calls that parse and name known tools", () => {
      const calls = callsIn(md);
      expect(calls.length).toBeGreaterThanOrEqual(8);
      for (const c of calls) expectValidCall(c);
    });

    it("names the project and its status", () => {
      expect(md).toContain("rep_123");
      expect(md).toContain(MCP_URL);
      expect(md).toContain(opts.claimed ? "**claimed**" : "**unclaimed**");
    });

    it("has no line wider than needed for a code sample", () => {
      for (const line of lines) if (!line.startsWith("   `") && !line.startsWith("|")) expect(line.length, line).toBeLessThanOrEqual(110);
    });
  },
);

describe("agentsMd commands", () => {
  it("uses the template's commands and the import's commands", () => {
    expect(agentsMd({ ...base, claimed: false, template: "workers-api" })).toContain("`wrangler dev`");
    expect(agentsMd({ ...base, claimed: false, template: "ts-library" })).not.toContain("wrangler dev");
    const yarn = agentsMd(variants.at(-1)!);
    expect(yarn).toContain("`yarn install --frozen-lockfile`");
    expect(yarn).toContain("`yarn jest test/<name>.test.ts`");
  });
});
