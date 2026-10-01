/**
 * Minimal Cloudflare v4 REST client: bearer auth, the `{ result, success, errors }` envelope,
 * zod-validated results. Shared by the Flagship, Workers deployments and telemetry adapters.
 */
import { z } from "zod";

export interface CfApiOptions {
  accountId: string;
  apiToken: string;
  fetch?: typeof fetch;
  /** Default https://api.cloudflare.com/client/v4 */
  baseUrl?: string;
}

const Envelope = z
  .object({
    success: z.boolean().optional(),
    result: z.unknown().optional(),
    errors: z
      .array(
        z.object({ code: z.number().optional(), message: z.string().optional() }).passthrough(),
      )
      .optional(),
  })
  .passthrough();

export class CfApiError extends Error {
  override name = "CfApiError";
  constructor(
    readonly status: number,
    readonly errors: Array<{ code?: number; message?: string }>,
    message: string,
  ) {
    super(message);
  }
  hasCode(code: number): boolean {
    return this.errors.some((e) => e.code === code);
  }
}

export interface CfRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path below /accounts/{accountId}, starting with "/". */
  path: string;
  query?: Record<string, string>;
  json?: unknown;
  form?: FormData;
}

export async function cfRequest<T>(
  opts: CfApiOptions,
  req: CfRequest,
  schema: z.ZodType<T>,
): Promise<T> {
  const base = (opts.baseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
  const qs = req.query ? `?${new URLSearchParams(req.query).toString()}` : "";
  const url = `${base}/accounts/${opts.accountId}${req.path}${qs}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${opts.apiToken}` };
  let body: BodyInit | undefined;
  if (req.form !== undefined) body = req.form;
  else if (req.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(req.json);
  }
  const res = await (opts.fetch ?? fetch)(url, {
    method: req.method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  const envelope = Envelope.safeParse(parsed);
  const errors = envelope.success ? (envelope.data.errors ?? []) : [];
  if (!res.ok || (envelope.success && envelope.data.success === false)) {
    const detail =
      errors.map((e) => `${e.code ?? "?"}: ${e.message ?? ""}`).join("; ") || text.slice(0, 300);
    throw new CfApiError(
      res.status,
      errors,
      `${req.method} ${req.path} → ${res.status}: ${detail}`,
    );
  }
  const result = schema.safeParse(envelope.success ? envelope.data.result : parsed);
  if (!result.success) {
    throw new CfApiError(
      res.status,
      [],
      `${req.method} ${req.path}: unexpected response: ${result.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  return result.data;
}
