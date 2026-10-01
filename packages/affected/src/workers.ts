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
}

const WranglerJson = z
  .object({
    name: z.string().min(1),
    main: z.string().optional(),
    assets: z.object({ directory: z.string().optional() }).passthrough().optional(),
    site: z.object({ bucket: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

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
    });
  }
  return { workers, problems };
}

/** wrangler/manifest file contents that `discoverWorkers` needs. */
export function isWorkerConfigFile(path: string): boolean {
  return WRANGLER.test(baseName(path));
}
