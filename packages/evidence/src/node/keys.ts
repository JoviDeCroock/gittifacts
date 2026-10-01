/** Node-only key-set loading for the verify CLI. */
import { readFile } from "node:fs/promises";
import { KeyError, type KeySet, parseKeySet } from "../keys.js";

export async function loadKeySetFile(path: string): Promise<KeySet> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    throw new KeyError(`cannot read key set ${path}: ${(e as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new KeyError(`key set ${path} is not JSON: ${(e as Error).message}`);
  }
  return parseKeySet(json);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Fetch a key set over HTTPS (plain HTTP only for loopback hosts — keys fetched over
 * an unauthenticated channel would make the signature check meaningless).
 */
export async function loadKeySetUrl(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<KeySet> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new KeyError(`invalid key set URL: ${url}`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) {
    throw new KeyError(`key set URL must use https: ${url}`);
  }
  let res: Response;
  try {
    res = await fetchImpl(u, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
  } catch (e) {
    throw new KeyError(`cannot fetch key set ${url}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new KeyError(`cannot fetch key set ${url}: HTTP ${res.status}`);
  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    throw new KeyError(`key set ${url} is not JSON: ${(e as Error).message}`);
  }
  return parseKeySet(json);
}
