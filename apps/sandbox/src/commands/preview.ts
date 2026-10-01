/**
 * `preview [--port 8787]`: serve a built project with `wrangler dev` (workerd) inside the
 * container, for the preview gateway to proxy to.
 *
 * Detection, in the project directory:
 * - Worker (a wrangler config exists):
 *   - `.wrangler/deploy/config.json` (a build tool's redirected config, e.g. the Vite plugin)
 *     → `wrangler dev -c <redirected config>`;
 *   - else when the build output of `wrangler deploy --dry-run --outdir <dir>` holds exactly one
 *     module → `wrangler dev <dir>/<module> --no-bundle -c <config>` (serves what was built);
 *   - else → `wrangler dev -c <config>` (wrangler bundles from source).
 * - Static site (no wrangler config): the first of dist/ build/ out/ public/ _site/ site/ (or
 *   the root) that holds an index.html → `wrangler dev --assets <dir>`.
 *
 * Always local-only (`--local`), bound to `--ip`/`--port`, no interactive session, telemetry off,
 * no Cloudflare credentials in the environment. The global wrangler (on PATH, /opt/wrangler in
 * the image) is used unless `$GITTIFACTS_WRANGLER` points elsewhere.
 *
 * stdout: one `::preview::<json>` line when the server answers (or when it failed to start);
 * the process then lives as long as wrangler does and exits with its code.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { errorMessage, log } from "../lib/log.js";
import { run } from "../lib/proc.js";

export const WRANGLER_CONFIGS = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];
export const STATIC_DIRS = ["dist", "build", "out", "public", "_site", "site"];
const MODULE_EXT = new Set([".js", ".mjs", ".cjs", ".wasm", ".bin", ".txt", ".html", ".sql", ".py"]);

/** Compatibility date for assets-only previews (a static site has no config to carry one). */
export const STATIC_COMPATIBILITY_DATE = "2026-09-01";

export interface PreviewPlan {
  kind: "worker" | "static";
  /** How the entry was chosen, for logs and the ready document. */
  mode: "redirected-config" | "built-output" | "source" | "assets";
  /** wrangler arguments (after the binary). */
  args: string[];
  notes: string[];
}

export type PreviewDetection = { ok: true; plan: PreviewPlan } | { ok: false; error: string };

const RedirectedConfig = z.object({ configPath: z.string() }).passthrough();

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Module files in a dry-run outdir (ignoring source maps and the README wrangler writes). */
function builtModules(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => isFile(join(dir, f)))
      .filter((f) => MODULE_EXT.has(extname(f)) && !f.endsWith(".map"))
      .sort();
  } catch {
    return [];
  }
}

export interface DetectOptions {
  dir: string;
  ip: string;
  port: number;
  /** Explicit build output / assets directory (relative to `dir`). */
  outDir?: string;
  persistTo: string;
}

export function detectPreview(opts: DetectOptions): PreviewDetection {
  const common = [
    "--ip",
    opts.ip,
    "--port",
    String(opts.port),
    "--local",
    "--show-interactive-dev-session=false",
    "--persist-to",
    opts.persistTo,
    "--log-level",
    "info",
  ];
  const notes: string[] = [];
  const config = WRANGLER_CONFIGS.map((c) => join(opts.dir, c)).find(isFile);
  if (config !== undefined) {
    const redirected = join(opts.dir, ".wrangler", "deploy", "config.json");
    if (isFile(redirected)) {
      try {
        const parsed = RedirectedConfig.safeParse(JSON.parse(readFileSync(redirected, "utf8")));
        if (parsed.success) {
          const target = resolve(join(opts.dir, ".wrangler", "deploy"), parsed.data.configPath);
          if (isFile(target)) {
            return { ok: true, plan: { kind: "worker", mode: "redirected-config", args: ["dev", "-c", target, ...common], notes } };
          }
          notes.push(`redirected config ${parsed.data.configPath} does not exist; ignoring it`);
        }
      } catch (error) {
        notes.push(`unreadable .wrangler/deploy/config.json: ${errorMessage(error)}`);
      }
    }
    const outDir = join(opts.dir, opts.outDir ?? "dist");
    const modules = builtModules(outDir);
    const looksBuilt = isFile(join(outDir, "README.md")) && /built output/i.test(readFileSync(join(outDir, "README.md"), "utf8"));
    if (modules.length === 1 && (looksBuilt || opts.outDir !== undefined)) {
      const entry = join(outDir, modules[0] ?? "index.js");
      return {
        ok: true,
        plan: { kind: "worker", mode: "built-output", args: ["dev", entry, "--no-bundle", "-c", config, ...common], notes },
      };
    }
    if (modules.length > 1 && looksBuilt) {
      notes.push(`build output ${relative(opts.dir, outDir)} has ${modules.length} modules; letting wrangler bundle from source instead`);
    } else if (modules.length === 0) {
      notes.push(`no build output in ${relative(opts.dir, outDir) || "."}; wrangler bundles from source`);
    }
    return { ok: true, plan: { kind: "worker", mode: "source", args: ["dev", "-c", config, ...common], notes } };
  }
  const candidates = opts.outDir !== undefined ? [opts.outDir] : [...STATIC_DIRS, "."];
  const withIndex = candidates.find((d) => isFile(join(opts.dir, d, "index.html")));
  const assets = withIndex ?? (opts.outDir !== undefined && isDir(join(opts.dir, opts.outDir)) ? opts.outDir : undefined);
  if (assets === undefined) {
    return {
      ok: false,
      error: `nothing to preview in ${opts.dir}: no ${WRANGLER_CONFIGS.join("/")} and no index.html in ${candidates.join(", ")}`,
    };
  }
  const name = basename(resolve(opts.dir)).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "preview";
  return {
    ok: true,
    plan: {
      kind: "static",
      mode: "assets",
      args: ["dev", "--assets", join(opts.dir, assets), "--name", name, "--compatibility-date", STATIC_COMPATIBILITY_DATE, ...common],
      notes,
    },
  };
}

/** Environment for wrangler: local only, no telemetry, no credentials. */
export function wranglerEnv(stateDir: string): Record<string, string | undefined> {
  return {
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG_PATH: join(stateDir, "logs"),
    NO_UPDATE_NOTIFIER: "1",
    CLOUDFLARE_API_TOKEN: undefined,
    CLOUDFLARE_API_KEY: undefined,
    CLOUDFLARE_EMAIL: undefined,
    CLOUDFLARE_ACCOUNT_ID: undefined,
    CF_API_TOKEN: undefined,
    CF_ACCOUNT_ID: undefined,
    CI: "1",
  };
}

export interface PreviewOptions extends DetectOptions {
  /** Only print the plan. */
  dryRun: boolean;
  wrangler: string;
  readyTimeoutMs?: number;
  emit: (doc: unknown) => void;
}

async function waitForHttp(url: string, until: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !until()) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000), redirect: "manual" });
      await res.arrayBuffer().catch(() => undefined);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

export async function preview(opts: PreviewOptions): Promise<number> {
  const detected = detectPreview(opts);
  if (!detected.ok) {
    opts.emit({ status: "error", error: detected.error });
    return 1;
  }
  const { plan } = detected;
  const url = `http://${opts.ip === "0.0.0.0" ? "127.0.0.1" : opts.ip}:${opts.port}`;
  const base = { kind: plan.kind, mode: plan.mode, command: [opts.wrangler, ...plan.args], port: opts.port, notes: plan.notes };
  if (opts.dryRun) {
    opts.emit({ status: "planned", ...base });
    return 0;
  }
  for (const n of plan.notes) log(`preview: ${n}`);
  log(`preview: ${opts.wrangler} ${plan.args.join(" ")}`);
  let exited = false;
  const server = run(opts.wrangler, plan.args, {
    cwd: opts.dir,
    env: wranglerEnv(opts.persistTo),
    // Unbounded: the server runs until it is stopped.
    maxCapture: 64 * 1024,
  }).finally(() => {
    exited = true;
  });
  server.catch(() => undefined);
  const ready = await waitForHttp(url, () => exited, opts.readyTimeoutMs ?? 60_000);
  if (!ready) {
    if (exited) {
      const r = await server.catch((error: unknown) => ({ code: 127, stderr: errorMessage(error), stdout: "" }));
      opts.emit({ status: "error", ...base, error: `wrangler exited ${r.code} before serving: ${(r.stderr || r.stdout).trim().slice(-1500)}` });
      return r.code === 0 ? 1 : r.code;
    }
    opts.emit({ status: "error", ...base, error: `nothing answered on ${url} within ${(opts.readyTimeoutMs ?? 60_000) / 1000} s` });
    return 1;
  }
  opts.emit({ status: "ready", ...base, url: `http://${opts.ip}:${opts.port}` });
  try {
    const r = await server;
    log(`preview: wrangler exited ${r.code}`);
    return r.code;
  } catch (error) {
    log(`preview: ${errorMessage(error)}`);
    return 1;
  }
}

/** The wrangler binary: `$GITTIFACTS_WRANGLER`, else `wrangler` on PATH. */
export function wranglerBinary(): string {
  const env = process.env.GITTIFACTS_WRANGLER;
  if (env !== undefined && env !== "") return env;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir !== "" && existsSync(join(dir, "wrangler"))) return join(dir, "wrangler");
  }
  return "wrangler";
}
