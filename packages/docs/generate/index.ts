/**
 * `pnpm --filter @app/docs generate [--check]`: writes content/reference/*.md from the code.
 * `--check` writes nothing and exits 1 when a generated page differs from what is committed
 * (the docs check and the vitest suite run the same comparison).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CONTENT_DIR, splitFrontMatter } from "../src/content.js";
import { generateCatalogs } from "./catalogs.js";
import { generateCli } from "./cli.js";
import { generateConfig } from "./config.js";
import { generateHttp } from "./http.js";
import type { GeneratedPage } from "./lib/md.js";
import { generateMcp } from "./mcp.js";
import { generatePlatformRefs } from "./platform-ref.js";

export async function generateAll(): Promise<GeneratedPage[]> {
  const pages = [
    ...generateMcp(),
    ...generateCli(),
    ...(await generateHttp()),
    ...generateConfig(),
    ...generateCatalogs(),
    ...(await generatePlatformRefs()),
  ];
  return pages.sort((a, b) => a.file.localeCompare(b.file));
}

export interface StaleReport {
  /** Generated pages whose file is missing or differs. */
  stale: string[];
  /** Files marked `generated: true` that no generator produces any more. */
  orphaned: string[];
}

/** Compares generated pages with content/ on disk. */
export async function staleGenerated(contentDir: string = CONTENT_DIR): Promise<StaleReport> {
  const pages = await generateAll();
  const stale = pages
    .filter((p) => {
      const file = join(contentDir, p.file);
      return !existsSync(file) || readFileSync(file, "utf8") !== p.content;
    })
    .map((p) => p.file);
  const produced = new Set(pages.map((p) => p.file));
  const refDir = join(contentDir, "reference");
  const orphaned = existsSync(refDir)
    ? readdirSync(refDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => `reference/${f}`)
        .filter((f) => {
          const { data } = splitFrontMatter(readFileSync(join(contentDir, f), "utf8"));
          return (data as { generated?: boolean } | null)?.generated === true && !produced.has(f);
        })
    : [];
  return { stale, orphaned };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });
  if (values.check) {
    const { stale, orphaned } = await staleGenerated();
    for (const f of stale) console.error(`stale: content/${f} (run pnpm --filter @app/docs generate)`);
    for (const f of orphaned) console.error(`orphaned: content/${f} (no generator writes it; delete it)`);
    process.exit(stale.length + orphaned.length > 0 ? 1 : 0);
  }
  const pages = await generateAll();
  for (const p of pages) writeFileSync(join(CONTENT_DIR, p.file), p.content);
  console.log(`docs: generated ${pages.length} reference pages`);
}
