/** Workers declared in the tree (wrangler.jsonc / wrangler.json / wrangler.toml). */
import { z } from "zod";
import { isTestSupportFile } from "./classify.js";
import { parseJsonc } from "./jsonc.js";
import { baseName, dirOf, joinPath } from "./paths.js";

export interface WorkerConfig {
  /** wrangler `name`. */
  name: string;
  /** Repo-relative directory of the config (the Worker's package). */
  dir: string;
  config: string;
  /** Entry module (repo path), when declared. */
  main: string | null;
  /** Static assets directory (repo path), when declared. */
  assets: string | null;
  /** Build contexts of the Worker's container images (repo paths). */
  containers: string[];
}

const ImageSource = z
  .object({
    dockerfile: z.string().optional(),
    build_context: z.string().optional(),
    image: z.string().optional(),
  })
  .passthrough();

const WranglerJson = z
  .object({
    name: z.string().min(1),
    main: z.string().optional(),
    assets: z.object({ directory: z.string().optional() }).passthrough().optional(),
    site: z.object({ bucket: z.string().optional() }).passthrough().optional(),
    containers: z
      .array(
        z
          .object({
            image: z.string().optional(),
            image_build_context: z.string().optional(),
            images: z.record(z.string(), ImageSource).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/** Local build context of a container image reference (null for registry images). */
function contextOf(
  dir: string,
  source: {
    dockerfile?: string | undefined;
    build_context?: string | undefined;
    image?: string | undefined;
  },
): string | null {
  if (source.build_context !== undefined) return joinPath(dir, source.build_context);
  const file = source.dockerfile ?? source.image;
  if (file === undefined || !/^\.{0,2}\/|Dockerfile/.test(file) || file.includes(":")) return null;
  const full = joinPath(dir, file);
  return full === null ? null : /Dockerfile[^/]*$/.test(full) ? dirOf(full) : full;
}

const WRANGLER = /^wrangler\.(?:jsonc|json|toml)$/;

/** Top-level `key = "value"` and `[section] key = "value"` pairs of a simple TOML file. */
function parseTomlStrings(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const sec = /^\[+([^\]]+)\]+$/.exec(line);
    if (sec !== null) {
      section = (sec[1] ?? "").trim();
      continue;
    }
    const kv = /^([\w.-]+)\s*=\s*["']([^"']*)["']/.exec(line);
    if (kv !== null && kv[1] !== undefined && kv[2] !== undefined)
      out.set(section === "" ? kv[1] : `${section}.${kv[1]}`, kv[2]);
  }
  return out;
}

export interface WorkerDiscovery {
  workers: WorkerConfig[];
  /** Configs that could not be read (no name, unparseable). */
  problems: string[];
}

/**
 * Deployable Workers: every wrangler config outside test-support directories (test pools'
 * wrangler configs describe test harnesses, not deployments).
 */
export function discoverWorkers(
  files: readonly string[],
  read: (path: string) => string | null,
): WorkerDiscovery {
  const workers: WorkerConfig[] = [];
  const problems: string[] = [];
  for (const f of files) {
    if (!WRANGLER.test(baseName(f)) || isTestSupportFile(f) || f.includes("node_modules/"))
      continue;
    const text = read(f);
    if (text === null) {
      problems.push(`${f}: unreadable`);
      continue;
    }
    const dir = dirOf(f);
    let name: string | undefined;
    let main: string | undefined;
    let assets: string | undefined;
    const containers: string[] = [];
    if (f.endsWith(".toml")) {
      const kv = parseTomlStrings(text);
      name = kv.get("name");
      main = kv.get("main");
      assets = kv.get("assets.directory") ?? kv.get("site.bucket");
    } else {
      const parsed = WranglerJson.safeParse(parseJsonc(text));
      if (parsed.success) {
        name = parsed.data.name;
        main = parsed.data.main;
        assets = parsed.data.assets?.directory ?? parsed.data.site?.bucket;
        for (const c of parsed.data.containers ?? []) {
          const sources = [
            { image: c.image, build_context: c.image_build_context },
            ...Object.values(c.images ?? {}),
          ];
          for (const src of sources) {
            const ctx = contextOf(dir, src);
            if (ctx !== null && !containers.includes(ctx)) containers.push(ctx);
          }
        }
      }
    }
    if (name === undefined || name === "") {
      problems.push(`${f}: no Worker name`);
      continue;
    }
    workers.push({
      name,
      dir,
      config: f,
      main: main === undefined ? null : joinPath(dir, main),
      assets: assets === undefined ? null : joinPath(dir, assets),
      containers,
    });
  }
  return { workers, problems };
}

/** wrangler/manifest file contents that `discoverWorkers` needs. */
export function isWorkerConfigFile(path: string): boolean {
  return WRANGLER.test(baseName(path));
}
