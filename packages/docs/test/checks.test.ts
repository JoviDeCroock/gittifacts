/**
 * The docs quality gates: the real content passes them, and each gate catches what it exists for.
 */
import { describe, expect, it } from "vitest";
import { staleGenerated } from "../generate/index.js";
import { checkPages, KNOWN_ISSUES, runChecks } from "../src/check/index.js";
import { formatProblem, type Problem } from "../src/check/problem.js";
import { loadPages, type Page, parsePage } from "../src/content.js";

const fm = (title: string) =>
  `---\ntitle: ${title}\ndescription: A test page.\norder: 1\naudience: agents\n---\n\n# ${title}\n\n`;

function problemsFor(body: string, extra: Page[] = []): Problem[] {
  const page = parsePage("guides/sample.md", fm("Sample") + body);
  const target = parsePage("concepts/target.md", `${fm("Target")}## Real heading\n`);
  return checkPages([page, target, ...extra]).filter((p) => p.file === "guides/sample.md");
}

const messages = (body: string) => problemsFor(body).map((p) => `[${p.rule}] ${p.message}`);

describe("docs content", () => {
  it("passes every link, sample, length and style check", () => {
    const problems = checkPages(loadPages()).filter(
      (p) => !KNOWN_ISSUES.some((k) => k.file === p.file && k.message === p.message),
    );
    expect(problems.map(formatProblem)).toEqual([]);
  });

  it("has generated reference pages that match the code", async () => {
    expect(await staleGenerated()).toEqual({ stale: [], orphaned: [] });
  });

  it("runs as one command", async () => {
    const r = await runChecks();
    expect(r.pages).toBeGreaterThan(50);
  });
});

describe("tool-call samples", () => {
  it("accept real tools with schema-valid arguments and placeholders", () => {
    expect(
      messages('```text\nws_exec({ workspaceId: "<workspaceId>", command: "ls" })\n```\n'),
    ).toEqual([]);
    expect(
      messages('Call `wait_for_change({ changeId: "ch_1", until: "merged", timeoutSec: 50 })`.\n'),
    ).toEqual([]);
  });

  it("catch unknown tools, malformed calls and invalid arguments", () => {
    expect(messages('```text\nstart_chnage({ repoId: "rp_1" })\n```\n')).toEqual([
      "[tool-call] start_chnage(…) is not an MCP tool",
    ]);
    expect(messages("Use `create_project({ template })`.\n")[0]).toContain("does not parse");
    expect(
      messages('```text\nwait_for_change({ changeId: "ch_1", until: "done" })\n```\n')[0],
    ).toContain("until must be equal to one of the allowed values");
    expect(messages('```text\nstart_change({ repoId: "rp_1", title: "x" })\n```\n')[0]).toContain(
      "must have required property 'category'",
    );
  });

  it("check calls inside JSON strings and skip verbatim quotes", () => {
    expect(messages('```json\n{ "call": "get_tour({ changeId: 1 })" }\n```\n')[0]).toContain(
      "must be string",
    );
    expect(messages("```text verbatim\ncreate_project({ template })\n```\n")).toEqual([]);
  });
});

describe("CLI samples", () => {
  it("accept real commands, flags and positionals", () => {
    const ok =
      "```sh\ngittifacts wait ch_1 --until merged\nnpx gittifacts --host https://<host> login --no-wait\n```\n";
    expect(messages(ok)).toEqual([]);
  });

  it("catch unknown commands, unknown flags, bad values and missing arguments", () => {
    expect(messages("```sh\ngittifacts deploy ch_1\n```\n")).toEqual([
      "[cli] unknown command: gittifacts deploy",
    ]);
    expect(messages("```sh\ngittifacts start-change --repo rp_1\n```\n")[0]).toContain(
      "unknown flag for start-change: --repo",
    );
    expect(messages("```sh\ngittifacts wait ch_1 --until done\n```\n")[0]).toContain(
      "--until expects one of",
    );
    expect(messages("```sh\ngittifacts get-change-status\n```\n")[0]).toContain(
      "missing required --change-id",
    );
  });
});

describe("JSON samples", () => {
  it("must parse, and validate when they name a schema", () => {
    expect(messages('```json\n{ "a": 1, }\n```\n')[0]).toContain("invalid JSON");
    expect(
      messages('```json schema=policy\n{ "thresholds": { "mutationScore": 2 } }\n```\n')[0],
    ).toContain("policy: thresholds.mutationScore");
    expect(messages('```json schema=policy\n{ "lane0Enabled": false }\n```\n')).toEqual([]);
    expect(messages("```json schema=nope\n{}\n```\n")).toEqual(['[json] unknown schema "nope"']);
  });
});

describe("links", () => {
  it("resolve to pages and headings", () => {
    expect(
      messages("[ok](/docs/concepts/target#real-heading) [rel](../concepts/target.md)\n"),
    ).toEqual([]);
    expect(messages("[gone](/docs/concepts/missing)\n")[0]).toContain(
      "no docs page at /docs/concepts/missing",
    );
    expect(messages("[anchor](/docs/concepts/target#nope)\n")[0]).toContain("no heading #nope");
    expect(messages("[site](/not-a-route)\n")[0]).toContain("unknown site path /not-a-route");
  });
});

describe("style", () => {
  it("flags filler words, long paragraphs and long pages", () => {
    expect(messages("You just push.\n")).toEqual(['[style] filler word "just"']);
    expect(messages("One. Two. Three. Four. Five.\n")[0]).toContain("paragraph of 5 sentences");
    expect(messages("Use e.g. version 1.2 here. Then stop.\n")).toEqual([]);
    expect(messages("line\n\n".repeat(160))[0]).toContain("split the page");
  });
});
