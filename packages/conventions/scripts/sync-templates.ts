/**
 * Writes the generated files (template.json, .platform/ci.ts, .platform/policy.ts, AGENTS.md) into
 * every templates/<id>/ directory. Run after changing the generators:
 *
 *   pnpm --filter @app/conventions sync-templates [--check]
 *
 * `--check` writes nothing and exits 1 when a file is out of date (the vitest suite checks the same).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TEMPLATE_IDS, templateFilesOnDisk } from "../src/index.js";

const TEMPLATES_DIR = join(import.meta.dirname, "..", "..", "..", "templates");
const check = process.argv.includes("--check");

let stale = 0;
for (const id of TEMPLATE_IDS) {
  for (const [path, text] of Object.entries(templateFilesOnDisk(id))) {
    const file = join(TEMPLATES_DIR, id, path);
    let current: string | null = null;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      current = null;
    }
    if (current === text) continue;
    stale += 1;
    if (check) {
      console.error(`out of date: templates/${id}/${path}`);
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    console.log(`wrote templates/${id}/${path}`);
  }
}
if (check && stale > 0) process.exit(1);
console.log(stale === 0 ? "templates are up to date" : `${stale} file(s) ${check ? "out of date" : "written"}`);
