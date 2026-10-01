/**
 * Idempotency keys for every create/mutate call (onboarding §5), shared by the HTTP middleware
 * (`Idempotency-Key` header) and mutating MCP tools (`idempotencyKey` argument).
 *
 * (principal, key) → SHA-256 of the request fingerprint + the response, kept 24 h.
 * - same key, same request, finished  → the stored response is replayed
 * - same key, different request       → 409 idempotency-key-reuse
 * - same key, first request in flight → 409 idempotency-key-in-flight
 * - only successful (2xx/3xx) results are remembered: an error releases the key, so the agent can
 *   retry with the same key (even with a corrected body), like Stripe's "only if it executed".
 */
import { IDEMPOTENCY_HEADER } from "@app/domain";
import { sha256Hex } from "@app/evidence";
import { and, eq, lt } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, Services } from "./app-env.js";
import { callerOf } from "./auth/middleware.js";
import { idempotencyKeys } from "./db/schema.js";
import { ApiError } from "./errors.js";

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const KEY_SHAPE = /^[\x21-\x7e]{1,200}$/;

export type IdempotencyBegin =
  | { kind: "fresh" }
  | { kind: "disabled" }
  | { kind: "replay"; status: number; body: unknown };

export function validateKey(key: string): void {
  if (!KEY_SHAPE.test(key)) {
    throw new ApiError(
      400,
      "invalid-request",
      "Idempotency-Key must be 1-200 printable ASCII characters",
    );
  }
}

export async function fingerprint(method: string, path: string, body: string): Promise<string> {
  return sha256Hex(`${method.toUpperCase()} ${path}\n${body}`);
}

/** Claim (principal, key) for this request or find what to replay. */
export async function beginIdempotent(
  svc: Services,
  principalId: string,
  key: string | undefined,
  requestHash: string,
): Promise<IdempotencyBegin> {
  if (key === undefined) return { kind: "disabled" };
  validateKey(key);
  const db = svc.store.db;
  const now = svc.clock.now();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString();
  const where = and(eq(idempotencyKeys.principalId, principalId), eq(idempotencyKeys.key, key));

  // Expired entries are free to reuse.
  await db.delete(idempotencyKeys).where(and(where, lt(idempotencyKeys.expiresAt, nowIso)));
  const inserted = await db
    .insert(idempotencyKeys)
    .values({
      principalId,
      key,
      requestHash,
      status: null,
      response: null,
      createdAt: nowIso,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });
  if (inserted.length > 0) {
    if (Math.random() < 0.01) svc.waitUntil(purgeExpired(svc, nowIso));
    return { kind: "fresh" };
  }
  const row = await db.select().from(idempotencyKeys).where(where).get();
  if (!row) return { kind: "fresh" }; // raced with a release; run normally
  if (row.requestHash !== requestHash) {
    throw new ApiError(
      409,
      "idempotency-key-reuse",
      `Idempotency-Key "${key}" was already used for a different request`,
    );
  }
  if (row.status === null || row.response === null) {
    throw new ApiError(
      409,
      "idempotency-key-in-flight",
      `a request with Idempotency-Key "${key}" is still running`,
    );
  }
  return { kind: "replay", status: row.status, body: JSON.parse(row.response) as unknown };
}

export async function completeIdempotent(
  svc: Services,
  principalId: string,
  key: string,
  status: number,
  body: unknown,
): Promise<void> {
  await svc.store.db
    .update(idempotencyKeys)
    .set({ status, response: JSON.stringify(body) })
    .where(and(eq(idempotencyKeys.principalId, principalId), eq(idempotencyKeys.key, key)));
}

export async function releaseIdempotent(
  svc: Services,
  principalId: string,
  key: string,
): Promise<void> {
  await svc.store.db
    .delete(idempotencyKeys)
    .where(and(eq(idempotencyKeys.principalId, principalId), eq(idempotencyKeys.key, key)));
}

async function purgeExpired(svc: Services, nowIso: string): Promise<void> {
  await svc.store.db.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, nowIso));
}

/** Run `fn` at most once per (principal, key); used by MCP tools. */
export async function runIdempotent<T>(
  svc: Services,
  principalId: string,
  key: string | undefined,
  request: { method: string; path: string; body: unknown },
  fn: () => Promise<T>,
): Promise<T> {
  const hash = await fingerprint(
    request.method,
    request.path,
    JSON.stringify(request.body ?? null),
  );
  const begin = await beginIdempotent(svc, principalId, key, hash);
  if (begin.kind === "replay") return begin.body as T;
  try {
    const out = await fn();
    if (begin.kind === "fresh" && key !== undefined)
      await completeIdempotent(svc, principalId, key, 200, out);
    return out;
  } catch (e) {
    if (begin.kind === "fresh" && key !== undefined) await releaseIdempotent(svc, principalId, key);
    throw e;
  }
}

/** HTTP middleware for create/mutate routes. Place it after `requirePrincipal`. */
export function idempotent(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = c.req.header(IDEMPOTENCY_HEADER) ?? undefined;
    if (key === undefined) return next();
    const svc = c.get("services");
    const principalId = callerOf(c).principal.id;
    const url = new URL(c.req.url);
    const hash = await fingerprint(c.req.method, url.pathname + url.search, await c.req.text());
    const begin = await beginIdempotent(svc, principalId, key, hash);
    if (begin.kind === "replay") {
      c.header("idempotent-replayed", "true");
      return c.json(begin.body, begin.status as 200);
    }
    try {
      await next();
    } catch (e) {
      await releaseIdempotent(svc, principalId, key);
      throw e;
    }
    const res = c.res;
    if (res.status >= 400 || c.error) {
      await releaseIdempotent(svc, principalId, key);
      return;
    }
    let body: unknown = null;
    try {
      body = await res.clone().json();
    } catch {
      body = null;
    }
    await completeIdempotent(svc, principalId, key, res.status, body);
  };
}
