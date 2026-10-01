import { NextStep } from "@app/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PLATFORM_SUMMARY, StartDoc, startGuide, TEMPLATE_IDS } from "../src/index.js";
import { callsIn, expectValidCall, HOST, MCP_URL } from "./helpers.js";

const opts = {
  host: `${HOST}/`,
  mcpUrl: MCP_URL,
  openapiUrl: `${HOST}/openapi.json`,
  authHints: {
    unclaimedProjects: true,
    unclaimedTtlDays: 7,
    oauth: true,
    deviceFlowCommand: "npx gittifacts login",
  },
};

describe("startGuide JSON", () => {
  const { json } = startGuide(opts);

  it("validates against StartDoc", () => {
    expect(() => StartDoc.parse(json)).not.toThrow();
    expect(json.host).toBe(HOST);
  });

  it("converts to a JSON Schema the platform can publish", () => {
    const schema = z.toJSONSchema(StartDoc) as {
      type: string;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(
      expect.arrayContaining(["platform", "auth", "mcp", "ship", "links"]),
    );
    expect(Object.keys(schema.properties)).toContain("ship");
  });

  it("explains the platform in three sentences", () => {
    expect(json.platform.summary).toBe(PLATFORM_SUMMARY);
    expect(json.platform.summary.split(/(?<=\.)\s+/).filter(Boolean)).toHaveLength(3);
  });

  it("ships something in exactly 3 calls: create_project → wait_for_change → get_change_status", () => {
    expect(json.ship.map((s) => s.call?.split("(")[0])).toEqual([
      "create_project",
      "wait_for_change",
      "get_change_status",
    ]);
    expect(json.ship.map((s) => s.step)).toEqual([1, 2, 3]);
    expect(json.ship[1]?.command).toMatch(
      /^git -c http\.extraHeader="Authorization: Bearer <remote\.token>" push /,
    );
    for (const s of [...json.ship, ...json.loop]) {
      expect(() => NextStep.parse(s)).not.toThrow();
      expect(s.call ?? s.command).toBeDefined();
      if (s.call !== undefined) expectValidCall(s.call);
    }
  });

  it("covers auth with and without an account", () => {
    expect(json.auth.anonymous).toMatchObject({ available: true, ttlDays: 7 });
    expect(json.auth.oauth.resourceMetadata).toBe(
      `${HOST}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(json.auth.deviceFlow).toEqual({ available: true, command: "npx gittifacts login" });
    const off = startGuide({
      ...opts,
      authHints: { unclaimedProjects: false, unclaimedTtlDays: 7, oauth: false },
    }).json;
    expect(off.auth.anonymous.available).toBe(false);
    expect(off.auth.anonymous.how).toMatch(/Disabled/);
    expect(off.auth.deviceFlow).toEqual({ available: false });
  });

  it("links llms.txt, OpenAPI and MCP discovery", () => {
    expect(json.links).toEqual({
      start: `${HOST}/start`,
      llmsTxt: `${HOST}/llms.txt`,
      openapi: `${HOST}/openapi.json`,
      mcp: MCP_URL,
      discovery: [
        `${HOST}/.well-known/oauth-protected-resource/mcp`,
        `${MCP_URL}/server-card`,
        `${HOST}/.well-known/ai-catalog.json`,
      ],
    });
    expect(json.templates.map((t) => t.id)).toEqual([...TEMPLATE_IDS]);
    expect(json.waitUntil).toEqual([
      "evidence_ready",
      "lane_assigned",
      "tour_ready",
      "merged",
      "reverted",
    ]);
  });
});

describe("startGuide markdown", () => {
  const { markdown, json } = startGuide(opts);

  it("is short and carries the same content as the JSON", () => {
    expect(markdown.split("\n").length).toBeLessThan(80);
    expect(markdown.startsWith("# gittifacts")).toBe(true);
    expect(markdown).toContain(MCP_URL);
    expect(markdown).toContain("## Ship something in 3 calls");
    for (const s of json.ship) expect(markdown).toContain(s.call ?? "");
    for (const r of json.rules) expect(markdown).toContain(r);
    for (const c of callsIn(markdown)) expectValidCall(c);
  });

  it("mentions the JSON variant and every link", () => {
    expect(markdown).toContain("Accept: application/json");
    for (const url of [json.links.llmsTxt, json.links.openapi, json.mcp.serverCard])
      expect(markdown).toContain(url);
  });
});
