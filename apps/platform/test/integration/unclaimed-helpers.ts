/**
 * Helpers for the O3 tests (unclaimed projects): requests that look like they came from a given
 * IP and network, an env with the kill switch's flag on (the real FLAGS binding has no local
 * Flagship, so it fails closed), and raw MCP JSON-RPC without credentials.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ProjectCreated } from "@app/mcp";
import { expect } from "vitest";
import type { FlagReader } from "../../src/limits/kill-switch.js";
import { ORIGIN, type TestApp } from "../http.js";

export const flagOn: FlagReader = {
  getBooleanDetails: async () => ({ value: true, reason: "TARGETING_MATCH" }),
};
export const flagOff: FlagReader = {
  getBooleanDetails: async () => ({ value: false, reason: "TARGETING_MATCH" }),
};
export const flagDown: FlagReader = {
  getBooleanDetails: async () => {
    throw new Error("Flagship unreachable");
  },
};

export type EnvOver = Record<string, unknown>;

export interface From {
  /** cf-connecting-ip; default a fresh address per call so tests don't share a bucket. */
  ip?: string;
  asn?: number;
}

let n = 0;
export function freshIp(): string {
  n++;
  return `198.51.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

/** Durable Object storage outlives a test: clear the limiter keys tests share. */
export async function resetSharedLimiters(asns: number[] = []): Promise<void> {
  for (const key of ["global", ...asns.map((a) => `asn:${a}`)]) {
    await env.ABUSE_LIMITER.getByName(key).reset();
  }
}

export function testEnv(over: EnvOver = {}): Env {
  return { ...env, FLAGS: flagOn, ...over } as unknown as Env;
}

export interface Req {
  env?: EnvOver;
  token?: string;
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
  from?: From;
}

export async function request(app: TestApp, method: string, path: string, o: Req = {}) {
  const headers = new Headers(o.headers);
  if (o.token) headers.set("authorization", `Bearer ${o.token}`);
  if (o.cookie) headers.set("cookie", o.cookie);
  headers.set("cf-connecting-ip", o.from?.ip ?? freshIp());
  if (method !== "GET" && !headers.has("origin")) headers.set("origin", ORIGIN);
  let body: string | undefined;
  if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  const init = {
    method,
    headers,
    body,
    ...(o.from?.asn === undefined ? {} : { cf: { asn: o.from.asn } }),
  } as RequestInit;
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, init), testEnv(o.env), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** A fetch for `createPlatformClient` that runs the app with `over` applied to the env. */
export function fetchWith(app: TestApp, over: EnvOver = {}) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(input, init), testEnv(over), ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
}

/** Credential-less POST /api/v1/projects; asserts 201. */
export async function createUnclaimed(
  app: TestApp,
  body: Record<string, unknown> = { template: "workers-api" },
  o: Omit<Req, "body" | "token" | "cookie"> = {},
): Promise<ProjectCreated> {
  const res = await request(app, "POST", "/api/v1/projects", { ...o, body });
  const out = (await res.json()) as ProjectCreated & { error?: unknown };
  expect(res.status, JSON.stringify(out.error)).toBe(201);
  return out;
}

/** One raw JSON-RPC message to /mcp; parses JSON or SSE answers. */
export async function rpc(
  app: TestApp,
  message: Record<string, unknown>,
  o: Omit<Req, "body"> = {},
): Promise<{ status: number; headers: Headers; body: Record<string, unknown> | null }> {
  const res = await request(app, "POST", "/mcp", {
    ...o,
    headers: { accept: "application/json, text/event-stream", ...(o.headers ?? {}) },
    body: { jsonrpc: "2.0", ...message },
  });
  const text = await res.text();
  if (text.trim() === "") return { status: res.status, headers: res.headers, body: null };
  const data = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .at(-1)
    : text;
  return {
    status: res.status,
    headers: res.headers,
    body: JSON.parse(data ?? "null") as Record<string, unknown>,
  };
}

/** `tools/call` result content: structuredContent, or the error envelope of a tool error. */
export function toolResult(body: Record<string, unknown> | null): {
  ok: boolean;
  value: Record<string, unknown>;
} {
  const result = (body?.result ?? {}) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: Array<{ text?: string }>;
  };
  if (result.isError) {
    return { ok: false, value: JSON.parse(result.content?.[0]?.text ?? "{}") };
  }
  return { ok: true, value: result.structuredContent ?? {} };
}
