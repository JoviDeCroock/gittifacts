/**
 * A fake RFC 8628 authorization server shaped like better-auth's device-authorization plugin:
 * POST /api/auth/device/code, POST /api/auth/device/token (scripted answers), optional
 * /start and /.well-known/oauth-authorization-server documents.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Scripted {
  status: number;
  body: unknown;
}

export interface FakeOAuth {
  host: string;
  /** Answers for successive token polls; the last one repeats. */
  tokenAnswers: Scripted[];
  requests: { method: string; path: string; form: Record<string, string> }[];
  start?: unknown;
  metadata?: unknown;
  deviceCodeStatus?: number;
  deviceCodeBody?: unknown;
  close(): Promise<void>;
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function fakeOAuthServer(init: Partial<Pick<FakeOAuth, "tokenAnswers" | "start" | "metadata">> = {}): Promise<FakeOAuth> {
  const state: Omit<FakeOAuth, "host" | "close"> = {
    tokenAnswers: init.tokenAnswers ?? [],
    requests: [],
    start: init.start,
    metadata: init.metadata,
  };
  let polls = 0;
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const text = await body(req);
    const form = Object.fromEntries(new URLSearchParams(text));
    state.requests.push({ method: req.method ?? "", path: url.pathname, form });
    const json = (status: number, b: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    if (req.method === "GET" && url.pathname === "/start" && state.start !== undefined) return json(200, state.start);
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server" && state.metadata !== undefined) {
      return json(200, state.metadata);
    }
    if (req.method === "POST" && /\/device\/code$/.test(url.pathname)) {
      if (state.deviceCodeStatus) return json(state.deviceCodeStatus, state.deviceCodeBody ?? {});
      return json(200, {
        device_code: "dev_123",
        user_code: "ABCD-EFGH",
        verification_uri: "/device",
        verification_uri_complete: "/device?user_code=ABCD-EFGH",
        expires_in: 1800,
        interval: 5,
      });
    }
    if (req.method === "POST" && /\/device\/token$/.test(url.pathname)) {
      const answer = state.tokenAnswers[Math.min(polls, state.tokenAnswers.length - 1)];
      polls += 1;
      if (!answer) return json(500, { error: "server_error" });
      return json(answer.status, answer.body);
    }
    json(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const fake = state as FakeOAuth;
  fake.host = `http://127.0.0.1:${port}`;
  fake.close = () =>
    new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((e) => (e ? reject(e) : resolve()));
    });
  return fake;
}

export const pending: Scripted = {
  status: 400,
  body: { error: "authorization_pending", error_description: "Authorization pending" },
};
export const slowDown: Scripted = { status: 400, body: { error: "slow_down", error_description: "Polling too frequently" } };
export const granted: Scripted = {
  status: 200,
  body: { access_token: "sess_abc", token_type: "Bearer", expires_in: 3600, scope: "repo:read change:create" },
};
