import { describe, expect, it } from "vitest";
import { bundledCommands } from "../src/tools/commands.js";
import { levenshtein, searchCommands, suggest } from "../src/tools/search.js";
import { harness, run } from "./support/io.js";

const top = (q: string, n = 3) => searchCommands(q, bundledCommands(), n).map((h) => h.command);

describe("search-tools (local fuzzy search)", () => {
  it("ranks by name, then title, then description", () => {
    expect(top("wait")[0]).toBe("wait-for-change");
    expect(top("change status")[0]).toBe("get-change-status");
    expect(top("review")).toEqual(expect.arrayContaining(["request-review", "get-tour"]));
    expect(top("push token")[0]).toBe("refresh-push-token");
    expect(top("production errors")[0]).toBe("list-issues-for-change");
    expect(top("evidnce")[0]).toBe("get-evidence");
  });

  it("returns nothing for nothing", () => {
    expect(searchCommands("", bundledCommands())).toEqual([]);
    expect(searchCommands("kubernetes helm", bundledCommands())).toEqual([]);
  });

  it("suggests close spellings", () => {
    expect(
      suggest(
        "get-chnge-status",
        bundledCommands().map((c) => c.command),
      ),
    ).toEqual(["get-change-status"]);
    expect(suggest("wiat", ["wait", "init", "login"])[0]).toBe("wait");
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });

  it("is a command that includes the local ones", async () => {
    const h = harness();
    const r = await run(h, ["search-tools", "wait", "for", "evidence"]);
    expect(r.code).toBe(0);
    const doc = r.json() as { query: string; results: { command: string; usage: string }[] };
    expect(doc.query).toBe("wait for evidence");
    expect(
      doc.results
        .map((x) => x.command)
        .slice(0, 2)
        .sort(),
    ).toEqual(["wait", "wait-for-change"]);
    expect(doc.results[0]?.usage).toMatch(/^gittifacts wait/);
    const none = await run(h, ["search-tools"]);
    expect(none.code).toBe(2);
    h.cleanup();
  });

  it("`help <command>` describes one command", async () => {
    const h = harness();
    const r = await run(h, ["help", "wait"]);
    expect(r.json()).toMatchObject({
      command: "wait",
      tool: "wait_for_change",
      usage:
        "gittifacts wait <changeId> --until <evidence_ready|lane_assigned|tour_ready|merged|reverted> [--timeout <integer>]",
      examples: expect.any(Array),
    });
    const text = await run(h, ["help", "init", "--human"]);
    expect(text.stdout).toMatch(
      /^gittifacts init \[--template <workers-api\|preact-app\|ts-library\|static-site>\]/,
    );
    h.cleanup();
  });
});
