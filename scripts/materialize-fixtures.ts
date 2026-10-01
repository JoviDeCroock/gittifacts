/**
 * Materializes fixture repositories into real git repos.
 *
 *   pnpm fixtures:materialize                 # all fixtures → fixtures/.materialized/<name>
 *   pnpm fixtures:materialize scope-drift     # just one
 *   pnpm fixtures:materialize --out /tmp/fx   # somewhere else
 */
import { relative } from "node:path";
import { listFixtureNames, materializeFixture, REPO_ROOT } from "./lib/fixtures.js";

function parseArgs(argv: string[]): { names: string[]; outDir: string | undefined } {
  const names: string[] = [];
  let outDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--out" || arg === "-o") {
      outDir = argv[++i];
      if (outDir === undefined) throw new Error(`${arg} needs a directory`);
    } else if (arg.startsWith("--out=")) {
      outDir = arg.slice("--out=".length);
    } else if (arg === "--") {
      // pnpm may forward a literal separator
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      names.push(arg);
    }
  }
  return { names, outDir };
}

async function main(): Promise<void> {
  const { names, outDir } = parseArgs(process.argv.slice(2));
  const selected = names.length > 0 ? names : listFixtureNames();
  for (const name of selected) {
    const result = await materializeFixture(name, outDir === undefined ? {} : { outDir });
    console.log(`${name}`);
    console.log(`  dir   ${relative(process.cwd(), result.dir) || "."}`);
    console.log(`  base  ${result.baseSha}  (main)`);
    console.log(`  head  ${result.headSha}  (change)`);
  }
  if (selected.length > 1)
    console.log(`\nmaterialized ${selected.length} fixtures from ${REPO_ROOT}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
