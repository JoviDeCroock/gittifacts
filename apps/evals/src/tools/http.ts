/** `http_fetch`: any URL, any method; the model sees status, key headers and a truncated body. */
import { z } from "zod";
import { truncate } from "../agent/messages.js";
import type { FetchLike } from "./probe.js";
import { RESULT_MAX_CHARS } from "./specs.js";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

/** Lenient on purpose: models send headers as numbers and bodies as objects. */
export const HttpFetchArgs = z.object({
  url: z.string().url(),
  method: z
    .string()
    .transform((m) => m.toUpperCase())
    .pipe(z.enum(METHODS))
    .optional(),
  headers: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .transform((h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, String(v)])))
    .optional(),
  body: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
});

/** Response headers worth showing an agent. */
const SHOWN_HEADERS = [
  "content-type",
  "location",
  "www-authenticate",
  "retry-after",
  "link",
  "idempotency-key",
  "idempotent-replayed",
  "ratelimit",
  "ratelimit-policy",
  "x-ratelimit-remaining",
  "mcp-session-id",
];

const MAX_RAW = 1024 * 1024;

export interface HttpResult {
  /** What the model sees. */
  text: string;
  /** The full body (≤ 1 MiB), for harvesting ids. */
  raw: string;
  status: number | null;
  isError: boolean;
}

export async function httpFetch(
  fetcher: FetchLike,
  rawArgs: Record<string, unknown>,
  opts: { timeoutMs: number; extraHeaders?: (url: URL) => Record<string, string> },
): Promise<HttpResult> {
  const parsed = HttpFetchArgs.safeParse(rawArgs);
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`);
    return {
      text: `Error: invalid arguments (${why.join("; ")})`,
      raw: "",
      status: null,
      isError: true,
    };
  }
  const a = parsed.data;
  const url = new URL(a.url);
  const method = a.method ?? "GET";
  const headers = new Headers(a.headers ?? {});
  let body: string | undefined;
  if (a.body !== undefined && method !== "GET" && method !== "HEAD") {
    body = typeof a.body === "string" ? a.body : JSON.stringify(a.body);
    if (typeof a.body !== "string" && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
  }
  for (const [k, v] of Object.entries(opts.extraHeaders?.(url) ?? {})) {
    if (!headers.has(k)) headers.set(k, v);
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1000, opts.timeoutMs));
  try {
    const res = await fetcher(url.toString(), {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: "follow",
      signal: ac.signal,
    });
    const raw = method === "HEAD" ? "" : (await res.text()).slice(0, MAX_RAW);
    const lines = [`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`];
    if (res.url && res.url !== url.toString()) lines.push(`(final URL: ${res.url})`);
    for (const h of SHOWN_HEADERS) {
      const v = res.headers.get(h);
      if (v !== null) lines.push(`${h}: ${v}`);
    }
    const head = `${lines.join("\n")}\n\n`;
    const text = head + truncate(raw, Math.max(1000, RESULT_MAX_CHARS - head.length));
    return { text, raw, status: res.status, isError: res.status >= 400 };
  } catch (e) {
    const msg = ac.signal.aborted
      ? `timed out after ${Math.round(opts.timeoutMs / 1000)} s`
      : e instanceof Error
        ? e.message
        : String(e);
    return { text: `Error: request failed: ${msg}`, raw: "", status: null, isError: true };
  } finally {
    clearTimeout(timer);
  }
}
