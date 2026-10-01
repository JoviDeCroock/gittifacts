/**
 * The committed `tools.introspection.d.ts` is the MCP contract. This test checks the live
 * `tools/list` against it with mcp-tada's `check`, so contract drift fails CI.
 * Regenerate after an intended change: `pnpm --filter @app/mcp snapshot`.
 */
import path from "node:path";
import { check, introspect } from "mcp-tada/cli";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import type { PlatformIntrospection } from "../src/index.js";
import type { introspection } from "../tools.introspection.js";
import { fakeBackend } from "./support/fake-backend.js";
import { bearerFor, serveMcp } from "./support/http-server.js";

const SNAPSHOT = path.join(import.meta.dirname, "..", "tools.introspection.d.ts");

let server: Awaited<ReturnType<typeof serveMcp>>;

beforeAll(async () => {
  server = await serveMcp(fakeBackend());
});

afterAll(async () => {
  await server.close();
});

describe("tools.introspection.d.ts", () => {
  it("matches the live tools/list", async () => {
    const target = {
      url: server.url,
      headers: { Authorization: `Bearer ${bearerFor("ag_snapshot")}` },
      timeoutMs: 10_000,
    };
    if (process.env.MCP_TADA_UPDATE === "1") {
      await introspect({ target, out: SNAPSHOT });
    }
    const { report, text } = await check({ target, against: SNAPSHOT });
    expect(report.identical, text).toBe(true);
  });

  it("agrees with the type derived from the tool definitions", () => {
    expectTypeOf<introspection["tools"]>().toEqualTypeOf<PlatformIntrospection["tools"]>();
  });
});
