import { describe, expect, it } from "vitest";
import { type EvalConfig, evalHeaderFn } from "../../src/env.js";

const cfg = {
  host: "https://platform.example",
  previewSuffix: "-pv.example.dev",
} as EvalConfig;

describe("evalHeaderFn", () => {
  it("signs traffic to the platform only; previews get the run id, other hosts nothing", async () => {
    const headers = await evalHeaderFn(cfg, "run-1", "secret");
    const platform = headers(new URL("https://platform.example/mcp"));
    expect(platform["x-gittifacts-eval-run"]).toBe("run-1");
    expect(platform["x-gittifacts-eval-sig"]).toMatch(/^[0-9a-f]{64}$/);
    // A preview runs project code: it could capture and replay the signature.
    expect(headers(new URL("https://abc-pv.example.dev/"))).toEqual({ "x-gittifacts-eval-run": "run-1" });
    expect(headers(new URL("https://elsewhere.example/"))).toEqual({});
  });
});
