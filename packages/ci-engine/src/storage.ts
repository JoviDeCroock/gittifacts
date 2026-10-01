/**
 * The subset of R2 the engine uses for small JSON records. `R2Bucket` satisfies it structurally;
 * unit tests use an in-memory implementation.
 */
export interface ObjectStore {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(options: {
    prefix: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}

/** Reads and JSON-parses a record; null when missing or not JSON. Validation is the caller's job. */
export async function readJson(store: ObjectStore, key: string): Promise<unknown> {
  const obj = await store.get(key);
  if (obj === null) return null;
  try {
    return JSON.parse(await obj.text()) as unknown;
  } catch {
    return null;
  }
}

export async function writeJson(store: ObjectStore, key: string, value: unknown): Promise<void> {
  await store.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
  });
}

/** All keys under `prefix` (follows cursors). */
export async function listKeys(store: ObjectStore, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const res = await store.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
    for (const o of res.objects) keys.push(o.key);
    if (!res.truncated || res.cursor === undefined) break;
    cursor = res.cursor;
  }
  return keys;
}
