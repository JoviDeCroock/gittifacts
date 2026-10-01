/**
 * R2 cache pointers: `ci-cache/<key>.json` → the container snapshot a step produced.
 * Container snapshots can't be listed and expire after 30 days, so the pointer is the only way to
 * find one again; anything older than 25 days is treated as a miss to stay clear of expiry.
 */
import { z } from "zod";
import { type ObjectStore, readJson, writeJson } from "../storage.js";

export const CACHE_PREFIX = "ci-cache/";
export const SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CACHE_MAX_AGE_MS = 25 * 24 * 60 * 60 * 1000;

export const CachePointer = z
  .object({
    v: z.literal(1),
    key: z.string().regex(/^[0-9a-f]{64}$/),
    snapshotId: z.string().min(1).max(512),
    step: z.string().min(1).max(200),
    scope: z.string().min(1).max(500),
    producedBySha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
    runId: z.string().min(1).max(200),
    createdAt: z.string().datetime(),
    /** Template id when the snapshot came from a `seedCache()` run. */
    seededBy: z.string().min(1).max(100).optional(),
  })
  .strict();
export type CachePointer = z.infer<typeof CachePointer>;

export function cachePointerKey(key: string): string {
  return `${CACHE_PREFIX}${key}.json`;
}

export function isFresh(pointer: CachePointer, nowMs: number): boolean {
  const age = nowMs - Date.parse(pointer.createdAt);
  return age >= 0 && age <= CACHE_MAX_AGE_MS;
}

/** The pointer for `key` if present, valid and fresh; otherwise null (a miss). */
export async function readCachePointer(
  store: ObjectStore,
  key: string,
  nowMs: number,
): Promise<CachePointer | null> {
  const parsed = CachePointer.safeParse(await readJson(store, cachePointerKey(key)));
  if (!parsed.success || parsed.data.key !== key) return null;
  return isFresh(parsed.data, nowMs) ? parsed.data : null;
}

/** First fresh pointer among `keys` (in priority order). */
export async function lookupCache(
  store: ObjectStore,
  keys: readonly string[],
  nowMs: number,
): Promise<CachePointer | null> {
  for (const key of keys) {
    const pointer = await readCachePointer(store, key, nowMs);
    if (pointer !== null) return pointer;
  }
  return null;
}

export async function writeCachePointer(store: ObjectStore, pointer: CachePointer): Promise<void> {
  await writeJson(store, cachePointerKey(pointer.key), CachePointer.parse(pointer));
}

export async function deleteCachePointer(store: ObjectStore, key: string): Promise<void> {
  await store.delete(cachePointerKey(key));
}
