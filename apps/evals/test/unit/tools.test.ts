import { describe, expect, it } from "vitest";
import type { ShellResult } from "../../src/sandbox.js";
import { HarnessTools } from "../../src/tools/executor.js";
import { errorCodes, harvest } from "../../src/tools/harvest.js";
import { httpFetch } from "../../src/tools/http.js";
import { currentIsoTimestamp } from "../../src/tools/probe.js";
import { fakeMcpServer } from "../fake-mcp.js";

const SUFFIX = "-pv.resynapse.dev";
const NOW = Date.parse("2026-10-03T03:00:00Z");

describe("harvest", () => {
  it("finds ids, bootstrap and fork changes, and preview URLs", () => {
    const text = JSON.stringify({
      projectId: "r1abc",
      remote: { url: "https://acct.artifacts.cloudflare.net/git/ns/task-k3j4h5g6f7d8s9a0q1w2.git" },
      previewUrl: "https://p-bs-r1abc-pv.resynapse.dev",
      nextSteps: [{ call: 'wait_for_change({ changeId: "bs-r1abc" })' }],
      change: { id: "zzzz1111", planId: "plan9" },
    });
    const h = harvest(`${text}\nsee https://other.example.com/x`, SUFFIX);
    expect(h.repoIds).toEqual(["r1abc"]);
    expect(h.changeIds).toEqual(
      expect.arrayContaining(["zzzz1111", "k3j4h5g6f7d8s9a0q1w2", "bs-r1abc"]),
    );
    expect(h.planIds).toEqual(["plan9"]);
    expect(h.previewUrls).toEqual(["https://p-bs-r1abc-pv.resynapse.dev"]);
  });

  it("reads platform error codes from the API and MCP error shapes", () => {
    expect(errorCodes('{"error":{"code":"rate-limited","message":"slow down"}}')).toEqual([
      "rate-limited",
    ]);
    expect(errorCodes('{"code":"repo-not-granted","message":"no","fix":{}}')).toEqual([
      "repo-not-granted",
    ]);
    expect(errorCodes("all good")).toEqual([]);
  });
});

describe("currentIsoTimestamp", () => {
  it("accepts a current timestamp in any zone and rejects stale or zone-less ones", () => {
    expect(currentIsoTimestamp('{"now":"2026-10-03T03:01:02.123Z"}', NOW)).toBe(
      "2026-10-03T03:01:02.123Z",
    );
    expect(currentIsoTimestamp('{"time":"2026-10-02T23:30:00-03:30"}', NOW)).not.toBeNull();
    expect(currentIsoTimestamp('{"now":"2020-01-01T00:00:00Z"}', NOW)).toBeNull();
    expect(currentIsoTimestamp("2026-10-03 03:00", NOW)).toBeNull();
  });
});

describe("http_fetch", () => {
  it("shows status, key headers and a truncated body; 4xx is a tool error", async () => {
    const seen: Request[] = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return new Response(`{"error":{"code":"unauthorized"}}${"x".repeat(50_000)}`, {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": "Bearer x",
          "x-secret": "no",
        },
      });
    };
    const r = await httpFetch(
      fetcher,
      { url: "https://p.example/api", method: "post", body: { a: 1 } },
      { timeoutMs: 5000, extraHeaders: () => ({ "x-gittifacts-eval-run": "r1" }) },
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^HTTP 401/);
    expect(r.text).toContain("www-authenticate: Bearer x");
    expect(r.text).not.toContain("x-secret");
    expect(r.text.length).toBeLessThanOrEqual(12_000);
    expect(r.raw.length).toBeGreaterThan(50_000);
    expect(seen[0]!.method).toBe("POST");
    expect(await seen[0]!.text()).toBe('{"a":1}');
    expect(seen[0]!.headers.get("content-type")).toBe("application/json");
    expect(seen[0]!.headers.get("x-gittifacts-eval-run")).toBe("r1");
  });

  it("rejects arguments without a URL", async () => {
    const r = await httpFetch(
      async () => new Response("x"),
      { method: "GET" },
      { timeoutMs: 1000 },
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/invalid arguments/);
  });
});

function shellOk(output: string, exitCode = 0): ShellResult {
  return {
    exitCode,
    output,
    outputBytes: output.length,
    truncated: false,
    timedOut: false,
    durationMs: 5,
    error: null,
  };
}

function tools(
  opts: { fetcher?: (r: Request) => Promise<Response>; shell?: ShellResult; probes?: boolean } = {},
) {
  const shellCalls: { command: string; secs: number }[] = [];
  const t = new HarnessTools(["http_fetch", "mcp_connect", "mcp_list_tools", "mcp_call", "shell"], {
    fetcher: async (i, init) =>
      (opts.fetcher ?? (async () => new Response("ok")))(new Request(i, init)),
    shell: async (command, secs) => {
      shellCalls.push({ command, secs });
      return opts.shell ?? shellOk("hi\n");
    },
    previewSuffix: SUFFIX,
    evalHeaders: () => ({}),
    probes: opts.probes ?? false,
    probeIntervalMs: 20,
  });
  return { t, shellCalls };
}

describe("HarnessTools", () => {
  it("refuses tools the task does not offer", async () => {
    const t = new HarnessTools(["http_fetch"], {
      fetcher: fetch,
      shell: async () => shellOk(""),
      previewSuffix: SUFFIX,
      evalHeaders: () => ({}),
      probes: false,
    });
    const o = await t.execute(
      { id: "1", name: "shell", args: { command: "ls" } },
      { remainingMs: 60_000 },
    );
    expect(o.isError).toBe(true);
    expect(o.content).toMatch(/unknown tool "shell"/);
    expect(t.specs().map((s) => s.name)).toEqual(["http_fetch"]);
  });

  it("runs shell with a clamped timeout; non-zero exits are results, not errors", async () => {
    const { t, shellCalls } = tools({ shell: shellOk("1 failed", 1) });
    const o = await t.execute(
      { id: "1", name: "shell", args: { command: "pnpm test", timeout_sec: 9999 } },
      { remainingMs: 100_000 },
    );
    expect(shellCalls[0]).toEqual({ command: "pnpm test", secs: 95 });
    expect(o.isError).toBe(false);
    expect(o.content).toBe("exit code: 1\n1 failed");
  });

  it("connects, lists and calls MCP tools, carrying the token and the connection state", async () => {
    const mcp = fakeMcpServer({
      token: "tok",
      tools: { whoami: () => ({ principal: "agent-1", repoId: "r1abc" }) },
    });
    const { t } = tools({ fetcher: mcp.handler });
    const denied = await t.execute(
      { id: "1", name: "mcp_connect", args: { url: "https://p.example/mcp" } },
      { remainingMs: 30_000 },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("401");
    expect(denied.content).toContain("resource_metadata");
    expect(denied.errorCodes).toEqual(["unauthorized"]);
    t.observe(denied);
    const ok = await t.execute(
      { id: "2", name: "mcp_connect", args: { url: "https://p.example/mcp", token: "tok" } },
      { remainingMs: 30_000 },
    );
    expect(ok.isError).toBe(false);
    expect(ok.content).toContain("fake-platform");
    expect(ok.content).toContain("whoami");
    t.observe(ok);
    const list = await t.execute(
      { id: "3", name: "mcp_list_tools", args: {} },
      { remainingMs: 30_000 },
    );
    expect(list.content).toContain("- whoami: the whoami tool");
    const call = await t.execute(
      { id: "4", name: "mcp_call", args: { name: "whoami" } },
      { remainingMs: 30_000 },
    );
    expect(call.isError).toBe(false);
    expect(call.content).toContain('"principal":"agent-1"');
    expect(call.meta.mcpTool).toBe("whoami");
    expect(call.meta.harvest?.repoIds).toEqual(["r1abc"]);
    expect(
      mcp.calls.filter((c) => c.method === "tools/call").every((c) => c.auth === "Bearer tok"),
    ).toBe(true);
    await t.close();
  });

  it("times the first green preview while a long call is in flight", async () => {
    let previewReady = false;
    const fetcher = async (req: Request) => {
      const url = new URL(req.url);
      if (url.hostname.endsWith(SUFFIX)) {
        return previewReady
          ? Response.json({ now: new Date().toISOString() })
          : new Response("Building…", { status: 503 });
      }
      if (url.pathname === "/create") {
        return Response.json({
          projectId: "r1abc",
          previewUrl: "https://p-bs-r1abc-pv.resynapse.dev",
        });
      }
      // A long poll that returns after the preview turned green.
      setTimeout(() => {
        previewReady = true;
      }, 60);
      await new Promise((r) => setTimeout(r, 200));
      return Response.json({ reached: true });
    };
    const { t } = tools({ fetcher, probes: true });
    const created = await t.execute(
      { id: "1", name: "http_fetch", args: { url: "https://p.example/create" } },
      { remainingMs: 30_000 },
    );
    expect(created.meta.firstGreen).toBeUndefined();
    t.observe(created);
    const waited = await t.execute(
      { id: "2", name: "http_fetch", args: { url: "https://p.example/wait" } },
      { remainingMs: 30_000 },
    );
    expect(waited.meta.firstGreen?.url).toBe("https://p-bs-r1abc-pv.resynapse.dev");
    expect(waited.meta.firstGreen!.at).toBeLessThanOrEqual(waited.at);
    t.observe(waited);
    expect(t.collected().firstGreen?.url).toBe("https://p-bs-r1abc-pv.resynapse.dev");
  });
});
