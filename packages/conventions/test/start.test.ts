import { NextStep } from "@app/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ANONYMOUS_RECONNECT_BEFORE,
  claimingLines,
  cliCommand,
  PLATFORM_SUMMARY,
  StartDoc,
  startGuide,
  TEMPLATE_IDS,
  type UnclaimedQuotaHints,
  unclaimedLimitLines,
} from "../src/index.js";
import { callsIn, expectValidCall, HOST, MCP_URL } from "./helpers.js";

const opts = {
  host: `${HOST}/`,
  mcpUrl: MCP_URL,
  openapiUrl: `${HOST}/openapi.json`,
  authHints: {
    unclaimedProjects: true,
    unclaimedTtlDays: 7,
    oauth: true,
    deviceFlowCommand: cliCommand(HOST, "login"),
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
    expect(json.ship.every((s) => s.command === undefined)).toBe(true);
    expect(json.loop.find((s) => s.command !== undefined)?.command).toMatch(
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
    expect(json.auth.deviceFlow).toEqual({
      available: true,
      command: `npx -y ${HOST}/cli/v2/gittifacts.tgz --host ${HOST} login`,
    });
    const off = startGuide({
      ...opts,
      authHints: { unclaimedProjects: false, unclaimedTtlDays: 7, oauth: false },
    }).json;
    expect(off.auth.anonymous.available).toBe(false);
    expect(off.auth.anonymous.how).toMatch(/Disabled/);
    expect(off.auth.deviceFlow).toEqual({ available: false });
    expect(off.links.discovery).toEqual([
      `${MCP_URL}/server-card`,
      `${HOST}/.well-known/ai-catalog.json`,
    ]);
    const offMd = startGuide({ ...opts, authHints: { ...opts.authHints, oauth: false } }).markdown;
    expect(offMd).not.toContain("OAuth discovery");
    expect(offMd).toContain("MCP OAuth is not available yet");
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
      docs: `${HOST}/docs`,
      docsFull: `${HOST}/docs/llms-full.txt`,
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

describe("startGuide no-account path", () => {
  it("says to reconnect with the token right after create_project, in one line", () => {
    const { json, markdown } = startGuide(opts);
    expect(json.auth.anonymous.how).toContain(ANONYMOUS_RECONNECT_BEFORE);
    const line = markdown.split("\n").find((l) => l.startsWith("- **No account:**")) ?? "";
    expect(line).toContain(ANONYMOUS_RECONNECT_BEFORE);
  });
});

describe("startGuide CLI", () => {
  const { json, markdown } = startGuide(opts);
  const tarball = `${HOST}/cli/v2/gittifacts.tgz`;

  it("runs the CLI from the platform's tarball (not on npm yet), with the host passed", () => {
    expect(json.cli.tarball).toBe(tarball);
    expect(json.cli.command).toBe(
      `npx -y ${tarball} --host ${HOST} init --template workers-api --name my-api --clone`,
    );
    expect(json.cli.alias).toBe(`alias gittifacts="npx -y ${tarball}"`);
    // Never a bare `npx gittifacts`: that npm name isn't ours, so the note warns against it.
    expect(json.cli.note).toContain("always run it from that URL");
    expect(json.cli.note).not.toMatch(/will work once|once (it|the package) is published/);
    expect(json.auth.deviceFlow.command).toBe(`npx -y ${tarball} --host ${HOST} login`);
    expect(markdown).toContain(`\`${json.cli.command}\``);
    expect(markdown).toContain(json.cli.alias);
    expect(markdown).not.toMatch(/npx gittifacts (login|init)/);
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
    for (const url of [
      json.links.llmsTxt,
      json.links.openapi,
      json.mcp.serverCard,
      json.links.docs,
      json.links.docsFull,
    ])
      expect(markdown).toContain(url);
  });
});

const QUOTAS: UnclaimedQuotaHints = {
  ttlDays: 7,
  ciMinutesPerDay: 60,
  ciMinutesPerRun: 10,
  storageMb: 250,
  artifactsOpsPerDay: 200,
  workspaceCpuMinutesPerDay: 30,
  requestsPerMinute: 120,
  createsPerIpPerHour: 3,
};

describe("unclaimed projects (O3)", () => {
  it("lists every limit, with the configured numbers when known", () => {
    const generic = unclaimedLimitLines();
    const concrete = unclaimedLimitLines(QUOTAS);
    expect(concrete).toHaveLength(generic.length);
    const all = concrete.join("\n");
    for (const needle of [
      "Unclaimed repo — not verified",
      "no secrets, no custom domains, no production deploys",
      "even for verified reverts",
      "60 minutes per day, at most 10 minutes per run",
      "250 MB",
      "200 per day",
      "30 vCPU-minutes per day",
      "package registries; previews have no internet",
      "120 requests per minute",
      "per IP (3 per hour)",
    ]) {
      expect(all).toContain(needle);
    }
    // The expiry is said once, next to the list (ttlDays, the guide's lead-in), not inside it.
    expect(all).not.toContain("expires");
    expect(generic.join("\n")).not.toMatch(/\d+ (minutes|MB|per|requests|days)/);
  });

  it("explains what claiming does without promising approvals", () => {
    const lines = claimingLines().join("\n");
    expect(lines).toMatch(/become the repo's owner/);
    expect(lines).toMatch(/can never approve/);
    expect(lines).toMatch(/no longer expires/);
    expect(lines).toMatch(/audit log/);
  });

  it("says how to work without an account when enabled, with numbers", () => {
    const { json, markdown } = startGuide({
      ...opts,
      authHints: { ...opts.authHints, unclaimedQuotas: QUOTAS },
    });
    expect(json.auth.anonymous.how).toMatch(/NO Authorization header/);
    expect(json.auth.anonymous.how).toMatch(/initialize, tools\/list, create_project and whoami/);
    expect(json.auth.anonymous.how).toMatch(/claimUrl/);
    expect(json.auth.anonymous.limits).toEqual(unclaimedLimitLines(QUOTAS));
    expect(markdown).toContain("Unclaimed repos expire after 7 days unless a human claims them");
    expect(markdown).toContain("  - CI: 60 minutes per day, at most 10 minutes per run");
    expect(markdown.split("\n").length).toBeLessThan(90);
  });

  it("says it's switched off when the kill switch is on", () => {
    const { json, markdown } = startGuide({
      ...opts,
      authHints: { ...opts.authHints, unclaimedProjects: false, unclaimedQuotas: QUOTAS },
    });
    expect(json.auth.anonymous.how).toMatch(/Disabled right now \(kill switch\)/);
    expect(markdown).not.toContain("Unclaimed repos expire after");
  });
});
