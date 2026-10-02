/**
 * A minimal streamable-HTTP MCP server as a fetch function (JSON responses, stateless), enough
 * for `@modelcontextprotocol/client`: initialize, tools/list, tools/call.
 */

export interface FakeMcpOptions {
  /** Bearer token required on every request (401 + WWW-Authenticate without it). */
  token?: string;
  tools?: Record<string, (args: Record<string, unknown>) => unknown>;
}

interface Rpc {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export function fakeMcpServer(opts: FakeMcpOptions = {}) {
  const calls: { method: string; auth: string | null }[] = [];
  const tools = opts.tools ?? {};
  const handler = async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const auth = req.headers.get("authorization");
    if (opts.token !== undefined && auth !== `Bearer ${opts.token}`) {
      return Response.json(
        {
          error: {
            code: "unauthorized",
            message: "authentication required",
            fix: { explanation: "Send a token." },
          },
        },
        {
          status: 401,
          headers: { "www-authenticate": 'Bearer resource_metadata="https://x/.well-known/prm"' },
        },
      );
    }
    const msg = (await req.json()) as Rpc;
    calls.push({ method: msg.method, auth });
    if (msg.id === undefined) return new Response(null, { status: 202 });
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
      case "initialize":
        return ok({
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-platform", version: "9.9.9" },
          instructions: "Read /start.",
        });
      case "tools/list":
        return ok({
          tools: Object.keys(tools).map((name) => ({
            name,
            description: `the ${name} tool`,
            inputSchema: { type: "object", properties: {} },
          })),
        });
      case "tools/call": {
        const name = String(msg.params?.name);
        const fn = tools[name];
        if (!fn) {
          return ok({ content: [{ type: "text", text: `unknown tool ${name}` }], isError: true });
        }
        const out = fn((msg.params?.arguments as Record<string, unknown>) ?? {});
        return ok({
          content: [{ type: "text", text: JSON.stringify(out) }],
          structuredContent: out,
        });
      }
      default:
        return Response.json({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "not found" },
        });
    }
  };
  return { handler, calls };
}
