/**
 * `pnpm --filter @app/docs build [--out <dir>]`: renders every page to static HTML plus its
 * markdown twin, llms.txt / llms-full.txt, index.json, search-index.json, sitemap.xml and assets.
 *
 * Default output: packages/web/dist/docs, inside the directory the platform Worker serves as
 * static assets (apps/platform/wrangler.jsonc `assets.directory`). Run it after the web build
 * (vite empties dist/); `apps/platform` `deploy:prepare` does both in that order.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadPages } from "./content.js";
import { buildSite } from "./site.js";

export const DEFAULT_OUT = resolve(import.meta.dirname, "..", "..", "web", "dist", "docs");

export function writeSite(outDir: string): number {
  const site = buildSite(loadPages());
  // Only ever delete the docs directory itself, never its parent.
  if (!/[\\/]docs$/.test(outDir)) throw new Error(`refusing to clean ${outDir}: expected a */docs directory`);
  rmSync(outDir, { recursive: true, force: true });
  for (const [path, contents] of site) {
    const file = join(outDir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return site.size;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const out = values.out === undefined ? DEFAULT_OUT : resolve(values.out);
  const t0 = Date.now();
  const n = writeSite(out);
  console.log(`docs: wrote ${n} files to ${out} in ${Date.now() - t0} ms`);
}
