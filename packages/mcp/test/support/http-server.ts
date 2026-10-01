/**
 * Serve the MCP handler on a local port (node:http ↔ web Request/Response), with a fake bearer
 * verifier: `Bearer <principalId>|<scope,scope>`.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type AuthInfo, createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpServer, type McpBackend } from "../../src/index.js";

export const ALL_AGENT_SCOPES = ["repo:read", "plan:create", "change:create"];

export function bearerFor(principalId: string, scopes: string[] = ALL_AGENT_SCOPES): string {
  return `${principalId}|${scopes.join(",")}`;
}

function authInfoOf(req: IncomingMessage): AuthInfo | undefined {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  if (!m?.[1]) return undefined;
  const [principalId, scopes = ""] = m[1].split("|");
  return {
    token: m[1],
    clientId: principalId ?? "",
    scopes: scopes.split(",").filter(Boolean),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

async function readBody(req: IncomingMessage): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length > 0 ? new Uint8Array(Buffer.concat(chunks)) : undefined;
}

export async function serveMcp(
  backend: McpBackend,
): Promise<{ url: string; close: () => Promise<void> }> {
  const handler = createMcpHandler(() => createMcpServer(backend));
  const server: Server = createServer(async (req, res) => {
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) for (const x of v) headers.append(k, x);
        else if (v !== undefined) headers.set(k, v);
      }
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
      const request = new Request(`http://127.0.0.1${req.url ?? "/"}`, {
        method: req.method,
        headers,
        body,
      });
      const authInfo = authInfoOf(req);
      const response = await handler.fetch(request, authInfo ? { authInfo } : {});
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        for await (const chunk of response.body) res.write(chunk);
      }
      res.end();
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
