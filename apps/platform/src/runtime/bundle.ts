/**
 * `loadBundle` for the `WorkersDeployer`: a CI build artifact in R2 → Worker modules + metadata.
 *
 * Build artifacts are `tar -cz` of a step's declared paths, stored by the CI engine at
 * `ci-artifacts/<runId>/<step>/<name>.tgz` (`RunKeys.artifact`). Only keys in that layout are
 * accepted, so nothing but a CI-produced artifact can ever be uploaded as a Worker version.
 *
 * The archive's single top-level directory (e.g. `dist/`) is stripped. Modules are the `.js`,
 * `.mjs`, `.cjs` and `.wasm` files; the main module is `wrangler.json`'s `main` when the build
 * wrote one next to the bundle, else `index.js`/`index.mjs`/`worker.js`/`_worker.js`, else the
 * only JS file. Metadata (`compatibility_date`, `compatibility_flags`, `bindings`) comes from that
 * `wrangler.json` too, falling back to the platform's compatibility date.
 */
import type { WorkerBundle, WorkerModule } from "@app/coordinator/adapters";
import { z } from "zod";

/** `RunKeys.artifact(runId, step, name)` from @app/ci-engine. */
export const BUNDLE_REF = /^ci-artifacts\/[A-Za-z0-9][A-Za-z0-9_-]{0,99}\/[A-Za-z0-9._:-]{1,100}\/[A-Za-z0-9._-]{1,100}\.tgz$/;

/** Decompressed size cap (zip-bomb guard). Workers scripts are far smaller than this. */
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 2000;

export interface TarEntry {
  path: string;
  data: Uint8Array;
}

export class BundleError extends Error {
  override readonly name = "BundleError";
}

const decoder = new TextDecoder();

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

function octal(bytes: Uint8Array): number {
  const text = cString(bytes).trim();
  if (text === "") return 0;
  const n = Number.parseInt(text, 8);
  if (!Number.isFinite(n) || n < 0) throw new BundleError(`corrupt tar header (size "${text}")`);
  return n;
}

/** pax extended header records: `<len> <key>=<value>\n`. */
function paxPath(data: Uint8Array): string | null {
  const text = decoder.decode(data);
  for (const line of text.split("\n")) {
    const m = /^\d+ path=(.*)$/.exec(line);
    if (m?.[1] !== undefined) return m[1];
  }
  return null;
}

/** Regular files of a (ustar / pax / GNU) tar archive. Directories, links and devices are skipped. */
export function parseTar(archive: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let nextPath: string | null = null;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] ?? 0);
    const magic = cString(header.subarray(257, 263));
    const prefix = magic.startsWith("ustar") ? cString(header.subarray(345, 500)) : "";
    const name = cString(header.subarray(0, 100));
    const start = offset + 512;
    const end = start + size;
    if (end > archive.length) throw new BundleError("truncated tar archive");
    const data = archive.subarray(start, end);
    offset = start + Math.ceil(size / 512) * 512;

    if (type === "x") {
      nextPath = paxPath(data) ?? nextPath;
      continue;
    }
    if (type === "L") {
      nextPath = cString(data);
      continue;
    }
    if (type === "g") continue;
    const path = nextPath ?? (prefix ? `${prefix}/${name}` : name);
    nextPath = null;
    if (type !== "0" && type !== "\0" && type !== "7") continue;
    entries.push({ path, data });
    if (entries.length > MAX_FILES) throw new BundleError(`more than ${MAX_FILES} files in bundle`);
  }
  return entries;
}

/** Safe relative path (no absolute paths, no `..`), with a leading `./` removed. */
function normalize(path: string): string | null {
  const p = path.replace(/^(\.\/)+/, "");
  if (p === "" || p.startsWith("/") || p.split("/").some((s) => s === ".." || s === "")) return null;
  return p;
}

function stripCommonRoot(entries: TarEntry[]): TarEntry[] {
  const first = entries[0]?.path.split("/")[0];
  if (first === undefined) return entries;
  const allUnder = entries.every((e) => e.path.startsWith(`${first}/`));
  return allUnder ? entries.map((e) => ({ ...e, path: e.path.slice(first.length + 1) })) : entries;
}

const Manifest = z
  .object({
    main: z.string().min(1).optional(),
    compatibility_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    compatibility_flags: z.array(z.string()).optional(),
    bindings: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();

const MODULE = /\.(m?js|cjs|wasm)$/;
const MAIN_CANDIDATES = ["index.js", "index.mjs", "worker.js", "_worker.js"];

export function bundleFromEntries(
  raw: TarEntry[],
  opts: { compatibilityDate: string },
): WorkerBundle {
  const files: TarEntry[] = [];
  for (const e of raw) {
    const path = normalize(e.path);
    if (path === null) throw new BundleError(`unsafe path in bundle: ${e.path}`);
    files.push({ path, data: e.data });
  }
  const entries = stripCommonRoot(files);
  const manifestEntry = entries.find((e) => e.path === "wrangler.json");
  let manifest: z.infer<typeof Manifest> = {};
  if (manifestEntry !== undefined) {
    const parsed = Manifest.safeParse(JSON.parse(decoder.decode(manifestEntry.data)) as unknown);
    if (!parsed.success) throw new BundleError("wrangler.json in the bundle is not valid");
    manifest = parsed.data;
  }
  const modules: WorkerModule[] = entries
    .filter((e) => MODULE.test(e.path))
    .map((e) => ({ name: e.path, content: e.data }));
  if (modules.length === 0) throw new BundleError("the bundle contains no JavaScript modules");

  const names = new Set(modules.map((m) => m.name));
  const fromManifest = manifest.main?.replace(/^(\.\/)+/, "").replace(/^dist\//, "");
  const mainModule =
    (fromManifest !== undefined && names.has(fromManifest) ? fromManifest : undefined) ??
    MAIN_CANDIDATES.find((c) => names.has(c)) ??
    (modules.filter((m) => /\.m?js$/.test(m.name)).length === 1
      ? modules.find((m) => /\.m?js$/.test(m.name))?.name
      : undefined);
  if (mainModule === undefined) {
    throw new BundleError(
      `cannot tell the main module apart (${[...names].slice(0, 10).join(", ")}): name it index.js or write a wrangler.json with "main"`,
    );
  }
  return {
    mainModule,
    modules,
    metadata: {
      compatibility_date: manifest.compatibility_date ?? opts.compatibilityDate,
      ...(manifest.compatibility_flags ? { compatibility_flags: manifest.compatibility_flags } : {}),
      ...(manifest.bindings ? { bindings: manifest.bindings } : {}),
    },
  };
}

async function gunzip(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BUNDLE_BYTES) {
      await reader.cancel();
      throw new BundleError(`bundle is larger than ${MAX_BUNDLE_BYTES} bytes uncompressed`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** `WorkersDeployerOptions.loadBundle` over the CI bucket. */
export function r2BundleLoader(
  bucket: Pick<R2Bucket, "get">,
  opts: { compatibilityDate: string },
): (bundleRef: string) => Promise<WorkerBundle> {
  return async (bundleRef) => {
    if (!BUNDLE_REF.test(bundleRef) || bundleRef.includes("..")) {
      throw new BundleError(`not a CI build artifact: ${bundleRef}`);
    }
    const obj = await bucket.get(bundleRef);
    if (obj === null) throw new BundleError(`bundle ${bundleRef} not found`);
    const tar = await gunzip(obj.body);
    return bundleFromEntries(parseTar(tar), opts);
  };
}
