/**
 * A generic streamable-HTTP MCP client for the agent (`mcp_connect`, `mcp_list_tools`,
 * `mcp_call`), on `@modelcontextprotocol/client`. Nothing here knows the platform: the agent
 * finds the MCP URL itself.
 *
 * The connection is described by an `McpState` that lives in Workflow step results, so a resumed
 * run reconnects (re-initializing, or reusing the server's session id when it issued one). The
 * live client is cached per run for the isolate's lifetime.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { truncate } from "../agent/messages.js";
import type { McpState } from "../agent/tool-outcome.js";
import type { FetchLike } from "./probe.js";
import { LIST_TOOLS_MAX_CHARS, RESULT_MAX_CHARS } from "./specs.js";

export interface McpResult {
  text: string;
  raw: string;
  isError: boolean;
  /** mcp_connect only: the new state (null after a failed connect). */
  state?: McpState | null;
}

interface HttpFailure {
  status: number;
  wwwAuthenticate: string | null;
  body: string;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class McpSessions {
  private live: { key: string; client: Client; transport: StreamableHTTPClientTransport } | null =
    null;
  private lastFailure: HttpFailure | null = null;

  constructor(
    private readonly fetcher: FetchLike,
    private readonly extraHeaders: (url: URL) => Record<string, string> = () => ({}),
  ) {}

  /** fetch that remembers the last non-2xx answer, so errors can show the server's body. */
  private readonly recordingFetch: FetchLike = async (input, init) => {
    const res = await this.fetcher(input, init);
    if (!res.ok) {
      const body = await res
        .clone()
        .text()
        .catch(() => "");
      this.lastFailure = {
        status: res.status,
        wwwAuthenticate: res.headers.get("www-authenticate"),
        body: body.slice(0, 4000),
      };
    }
    return res;
  };

  private failureText(e: unknown): string {
    const f = this.lastFailure;
    const lines = [`Error: ${errText(e)}`];
    if (f) {
      lines.push(`Last HTTP response: ${f.status}`);
      if (f.wwwAuthenticate) lines.push(`www-authenticate: ${f.wwwAuthenticate}`);
      if (f.body) lines.push(f.body);
    }
    return truncate(lines.join("\n"), RESULT_MAX_CHARS);
  }

  private async open(state: McpState, timeoutMs: number) {
    const key = JSON.stringify([state.url, state.token, state.sessionId]);
    if (this.live?.key === key) return this.live;
    await this.close();
    const url = new URL(state.url);
    const headers: Record<string, string> = { ...this.extraHeaders(url) };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
      fetch: this.recordingFetch,
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      ...(state.protocolVersion ? { protocolVersion: state.protocolVersion } : {}),
    });
    const client = new Client({ name: "gittifacts-eval-agent", version: "1.0.0" });
    await withTimeout(client.connect(transport), timeoutMs, "connecting");
    this.live = { key, client, transport };
    return this.live;
  }

  async close(): Promise<void> {
    const l = this.live;
    this.live = null;
    if (l) await l.client.close().catch(() => {});
  }

  async connect(url: string, token: string | null, timeoutMs: number): Promise<McpResult> {
    this.lastFailure = null;
    const state: McpState = { url, token, sessionId: null, protocolVersion: null };
    try {
      new URL(url);
    } catch {
      return { text: `Error: not a URL: ${url}`, raw: "", isError: true, state: null };
    }
    try {
      const { client, transport } = await this.open(state, timeoutMs);
      const next: McpState = {
        ...state,
        sessionId: transport.sessionId ?? null,
        protocolVersion: transport.protocolVersion ?? null,
      };
      this.live = {
        key: JSON.stringify([next.url, next.token, next.sessionId]),
        client,
        transport,
      };
      const info = client.getServerVersion();
      const tools = await withTimeout(client.listTools(), timeoutMs, "listing tools");
      const names = tools.tools.map((t) => t.name);
      const instructions = client.getInstructions();
      const text = [
        `Connected to ${info?.name ?? "the MCP server"}${info?.version ? ` ${info.version}` : ""}${next.protocolVersion ? ` (protocol ${next.protocolVersion})` : ""}.`,
        instructions ? `Server instructions:\n${truncate(instructions, 3000)}` : null,
        `${names.length} tools: ${names.join(", ")}. Call mcp_list_tools for their schemas.`,
      ]
        .filter((l): l is string => l !== null)
        .join("\n");
      return { text, raw: text, isError: false, state: next };
    } catch (e) {
      await this.close();
      const text = this.failureText(e);
      return { text, raw: text, isError: true, state: null };
    }
  }

  async listTools(state: McpState | null, timeoutMs: number): Promise<McpResult> {
    if (!state) return notConnected();
    this.lastFailure = null;
    try {
      const { client } = await this.open(state, timeoutMs);
      const { tools } = await withTimeout(client.listTools(), timeoutMs, "listing tools");
      const text = tools
        .map((t) => {
          const desc = (t.description ?? "").replace(/\s+/g, " ").trim();
          return `- ${t.name}: ${desc}\n  input: ${JSON.stringify(t.inputSchema)}`;
        })
        .join("\n");
      return {
        text: truncate(text || "(no tools)", LIST_TOOLS_MAX_CHARS),
        raw: text,
        isError: false,
      };
    } catch (e) {
      await this.close();
      const text = this.failureText(e);
      return { text, raw: text, isError: true };
    }
  }

  async call(
    state: McpState | null,
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<McpResult> {
    if (!state) return notConnected();
    this.lastFailure = null;
    try {
      const { client } = await this.open(state, timeoutMs);
      const res = await client.callTool(
        { name, arguments: args },
        { timeout: timeoutMs, maxTotalTimeout: timeoutMs },
      );
      const texts = res.content.flatMap((c) =>
        c.type === "text" ? [c.text] : [`[${c.type} content]`],
      );
      const joined = texts.join("\n");
      const structured =
        res.structuredContent === undefined ? null : JSON.stringify(res.structuredContent);
      const dup = structured !== null && sameJson(joined, res.structuredContent);
      const parts = [res.isError ? "isError: true" : null, joined || null];
      if (structured !== null && !dup) parts.push(`structuredContent: ${structured}`);
      const raw = parts.filter((p): p is string => p !== null).join("\n");
      return {
        text: truncate(raw || "(empty result)", RESULT_MAX_CHARS),
        raw,
        isError: res.isError === true,
      };
    } catch (e) {
      // A transport failure leaves the cached client in an unknown state: reconnect next time.
      await this.close();
      const text = this.failureText(e);
      return { text, raw: text, isError: true };
    }
  }
}

function notConnected(): McpResult {
  return {
    text: "Error: not connected to an MCP server. Call mcp_connect first.",
    raw: "",
    isError: true,
  };
}

function sameJson(text: string, value: unknown): boolean {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(value);
  } catch {
    return false;
  }
}
