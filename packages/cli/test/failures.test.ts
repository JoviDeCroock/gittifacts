/**
 * Transport failures from the real MCP SDK client, mapped to envelopes with a `fix`.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import { type FailureContext, toCliError } from "../src/failures.js";
import { callAnyTool, connectMcp } from "../src/mcp.js";
import { harness, run } from "./support/io.js";
import { bearerFor, fakeBackend, hostOf, serveMcp } from "./support/mcp.js";

let status: { code: number; body: string; headers?: Record<string, string> } = {
  code: 500,
  body: "",
};
let http: Server;
let httpHost: string;
let mcp: Awaited<ReturnType<typeof serveMcp>>;

beforeAll(async () => {
  http = createServer((_req, res) => {
    res.writeHead(status.code, { "content-type": "application/json", ...status.headers });
    res.end(status.body);
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  httpHost = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  mcp = await serveMcp(fakeBackend());
});

afterAll(async () => {
  http.closeAllConnections();
  await new Promise<void>((r) => http.close(() => r()));
  await mcp.close();
});

async function failWith(code: number, body: string, headers?: Record<string, string>) {
  status = { code, body, ...(headers ? { headers } : {}) };
  const h = harness({ env: { GITTIFACTS_HOST: httpHost } });
  const r = await run(h, ["whoami"]);
  h.cleanup();
  expect(r.code).toBe(1);
  return (
    r.json() as {
      error: { code: string; message: string; fix: { command?: string; explanation: string } };
    }
  ).error;
}

describe("HTTP failures from the MCP endpoint", () => {
  it("401 → unauthorized, with the login command", async () => {
    const e = await failWith(
      401,
      JSON.stringify({ error: "invalid_token", error_description: "missing bearer" }),
      {
        "www-authenticate": 'Bearer resource_metadata="x"',
      },
    );
    expect(e).toMatchObject({
      code: "unauthorized",
      fix: { command: `gittifacts login --host ${httpHost}` },
    });
    expect(e.fix.explanation).toMatch(/gittifacts init/);
  });

  it("a platform envelope in the body wins", async () => {
    const env = {
      error: {
        code: "rate-limited",
        message: "slow down",
        fix: { explanation: "Wait 10s.", command: "sleep 10" },
      },
    };
    expect(await failWith(429, JSON.stringify(env))).toEqual(env.error);
  });

  it("404 → no MCP endpoint at that host", async () => {
    expect(await failWith(404, "{}")).toMatchObject({
      code: "not-found",
      message: expect.stringContaining(`${httpHost}/mcp`),
    });
  });

  it("403, 429 and 5xx get fixes too", async () => {
    expect(await failWith(403, "{}")).toMatchObject({
      code: "forbidden",
      fix: { command: "gittifacts whoami" },
    });
    expect(await failWith(429, "{}")).toMatchObject({ code: "rate-limited" });
    expect(await failWith(502, "bad gateway")).toMatchObject({ code: "upstream" });
  });
});

describe("protocol failures", () => {
  it("an unknown tool name → unknown-tool", async () => {
    const conn = await connectMcp({ mcpUrl: mcp.url, token: bearerFor("ag_1") });
    const ctx: FailureContext = {
      host: hostOf(mcp.url),
      mcpUrl: mcp.url,
      command: "x",
      tokenSource: "env",
    };
    try {
      await callAnyTool(conn.mcp, "no_such_tool", {});
      throw new Error("expected a failure");
    } catch (e) {
      const err = toCliError(e, ctx);
      expect(err).toBeInstanceOf(CliError);
      expect(err.body).toMatchObject({
        code: "unknown-tool",
        fix: { command: "gittifacts tools --remote" },
      });
    } finally {
      await conn.close();
    }
  });

  it("a schema violation caught by the server → invalid-request with details", async () => {
    const h = harness({
      env: { GITTIFACTS_HOST: hostOf(mcp.url), GITTIFACTS_TOKEN: bearerFor("ag_1") },
    });
    const r = await run(h, ["get-change-status", "--json", '{"changeId":"c","bogus":1}']);
    expect(r.code).toBe(1);
    expect(r.json()).toMatchObject({
      error: {
        code: "invalid-request",
        fix: { command: "gittifacts get-change-status --help" },
        details: [expect.stringContaining("bogus")],
      },
    });
    h.cleanup();
  });
});
