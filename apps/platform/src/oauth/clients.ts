/**
 * Who is asking. MCP 2026-07-28 prefers Client ID Metadata Documents (CIMD, draft-ietf-oauth-
 * client-id-metadata-document-00): the `client_id` is an HTTPS URL serving the client's metadata,
 * so the domain vouches for the client. Dynamic Client Registration is deprecated and not offered.
 * The platform's own CLI is the one pre-registered (first-party) client.
 *
 * Only public clients are supported (`token_endpoint_auth_method: "none"`); PKCE S256 binds the code.
 */
import { z } from "zod";

export interface ResolvedClient {
  clientId: string;
  name: string;
  uri: string | null;
  logoUri: string | null;
  redirectUris: string[];
  kind: "first-party" | "cimd";
  /** The host that vouches for a CIMD client (shown on the consent screen); null for first-party. */
  host: string | null;
}

export type ClientResult = { ok: true; client: ResolvedClient } | { ok: false; message: string };

/** The gittifacts CLI: device flow, or the code flow on a loopback redirect (any port, RFC 8252 §7.3). */
export const CLI_CLIENT_ID = "gittifacts-cli";

const FIRST_PARTY: Record<string, ResolvedClient> = {
  [CLI_CLIENT_ID]: {
    clientId: CLI_CLIENT_ID,
    name: "gittifacts CLI",
    uri: null,
    logoUri: null,
    redirectUris: ["http://127.0.0.1/callback", "http://localhost/callback"],
    kind: "first-party",
    host: null,
  },
};

const MAX_DOCUMENT_BYTES = 16 * 1024;
const FETCH_TIMEOUT_MS = 5000;

const CimdDocument = z
  .object({
    client_id: z.string(),
    client_name: z.string().min(1).max(200).optional(),
    client_uri: z.string().url().optional(),
    logo_uri: z.string().url().optional(),
    redirect_uris: z.array(z.string().min(1).max(2048)).min(1).max(20),
    token_endpoint_auth_method: z.string().optional(),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
    client_secret: z.unknown().optional(),
    client_secret_expires_at: z.unknown().optional(),
  })
  .passthrough();

/** CIMD §3: an https URL with a path, no fragment, no credentials, no dot segments. */
export function isCimdClientId(clientId: string): boolean {
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username !== "" || u.password !== "" || clientId.includes("#")) return false;
  if (u.pathname === "/" || u.pathname === "") return false;
  if (/(^|\/)\.\.?(\/|$)/.test(clientId.replace(/^https:\/\/[^/]+/, ""))) return false;
  const host = u.hostname.toLowerCase();
  // SSRF hygiene: no IP literals, no local names. (Workers can't reach private networks anyway.)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[") || host.includes(":")) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host.endsWith(".internal") || !host.includes(".")) return false;
  return true;
}

async function readLimited(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_DOCUMENT_BYTES) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_DOCUMENT_BYTES) return null;
  return new TextDecoder().decode(buf);
}

async function fetchCimd(clientId: string): Promise<ClientResult> {
  let res: Response;
  try {
    res = await fetch(clientId, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, message: `could not fetch the client metadata document at ${clientId}` };
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    return {
      ok: false,
      message: `the client metadata document at ${clientId} answered ${res.status} (redirects are not followed)`,
    };
  }
  const text = await readLimited(res);
  if (text === null) {
    return {
      ok: false,
      message: `the client metadata document is larger than ${MAX_DOCUMENT_BYTES} bytes`,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, message: "the client metadata document is not JSON" };
  }
  const doc = CimdDocument.safeParse(json);
  if (!doc.success) {
    return {
      ok: false,
      message: `invalid client metadata document: ${doc.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    };
  }
  const d = doc.data;
  if (d.client_id !== clientId) {
    return {
      ok: false,
      message: "the document's client_id does not equal the URL it was fetched from",
    };
  }
  if (d.client_secret !== undefined || d.client_secret_expires_at !== undefined) {
    return { ok: false, message: "client metadata documents must not carry a client secret" };
  }
  if (d.token_endpoint_auth_method !== undefined && d.token_endpoint_auth_method !== "none") {
    return {
      ok: false,
      message: `token_endpoint_auth_method "${d.token_endpoint_auth_method}" is not supported; only public clients ("none") with PKCE`,
    };
  }
  for (const r of d.redirect_uris) {
    if (!isValidRedirectUri(r)) return { ok: false, message: `invalid redirect_uri "${r}"` };
  }
  const host = new URL(clientId).host;
  return {
    ok: true,
    client: {
      clientId,
      name: (d.client_name ?? host).slice(0, 120),
      uri: d.client_uri ?? null,
      logoUri: d.logo_uri ?? null,
      redirectUris: d.redirect_uris,
      kind: "cimd",
      host,
    },
  };
}

/** Resolve a `client_id`: the first-party CLI or a CIMD URL. Anything else is unknown. */
export async function resolveClient(clientId: string | null | undefined): Promise<ClientResult> {
  if (!clientId) return { ok: false, message: "client_id is required" };
  const fp = FIRST_PARTY[clientId];
  if (fp) return { ok: true, client: fp };
  if (!isCimdClientId(clientId)) {
    return {
      ok: false,
      message:
        "unknown client_id. Use an https URL that serves a Client ID Metadata Document (MCP 2026-07-28); dynamic client registration is not offered",
    };
  }
  return fetchCimd(clientId);
}

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** Absolute https URI, or http on a loopback host (native apps), or a private-use scheme; no fragment. */
export function isValidRedirectUri(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (raw.includes("#")) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname);
  // Private-use URI schemes for native apps (RFC 8252 §7.1), e.g. com.example.app:/cb
  return /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/.test(u.protocol);
}

/**
 * Exact match against the registered URIs (RFC 9700 §2.1), except that a loopback registration
 * accepts any port (RFC 8252 §7.3).
 */
export function redirectAllowed(client: ResolvedClient, requested: string): boolean {
  if (!isValidRedirectUri(requested)) return false;
  if (client.redirectUris.includes(requested)) return true;
  let r: URL;
  try {
    r = new URL(requested);
  } catch {
    return false;
  }
  if (r.protocol !== "http:" || !LOOPBACK.has(r.hostname)) return false;
  return client.redirectUris.some((reg) => {
    try {
      const g = new URL(reg);
      return (
        g.protocol === "http:" &&
        g.hostname === r.hostname &&
        g.pathname === r.pathname &&
        g.search === r.search
      );
    } catch {
      return false;
    }
  });
}
