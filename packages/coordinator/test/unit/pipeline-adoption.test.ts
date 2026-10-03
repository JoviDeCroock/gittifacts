import { describe, expect, it } from "vitest";
import { CI_PIPELINE_PATH, pipelineShaFor } from "../../src/pipeline-adoption.js";

/** readFile over a map of sha → files. */
function git(files: Record<string, string[]>) {
  const reads: string[] = [];
  return {
    reads,
    readFile: async (_repo: string, ref: string, path: string) => {
      reads.push(`${ref}:${path}`);
      return (files[ref] ?? []).includes(path) ? new Uint8Array([1]) : null;
    },
  };
}

describe("pipelineShaFor (which commit's CI judges a Change)", () => {
  it("is the base whenever the base adopted a pipeline, even if the Change edits it", async () => {
    const g = git({ base: [CI_PIPELINE_PATH], head: [CI_PIPELINE_PATH] });
    expect(await pipelineShaFor(g, "task-1", "base", "head")).toBe("base");
    expect(g.reads).toEqual([`base:${CI_PIPELINE_PATH}`]); // the head is never consulted
  });

  it("is the head when the Change adopts the repo's first .platform/ci.ts", async () => {
    expect(await pipelineShaFor(git({ head: [CI_PIPELINE_PATH] }), "task-1", "base", "head")).toBe(
      "head",
    );
  });

  it("stays at the base (detected defaults) when neither side has one, or for a bootstrap", async () => {
    expect(await pipelineShaFor(git({}), "task-1", "base", "head")).toBe("base");
    expect(await pipelineShaFor(git({ base: [] }), "task-1", "same", "same")).toBe("same");
  });
});
