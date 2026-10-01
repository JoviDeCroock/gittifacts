/**
 * Smoke benchmark: analyze this monorepo (the HEAD tree) for a few synthetic one-file changes.
 *
 *   pnpm --filter @app/affected bench [--scope packages/] [--rev HEAD] [--json]
 *
 * Timings: loading blobs (git cat-file --batch), building the graph (scan + resolve), and the
 * per-change computation. The "change" is the file at HEAD compared with itself plus a marker
 * comment, so nothing needs to be committed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { computeAffectedSet, contentNeeded, type RepoTree } from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { values } = parseArgs({
  options: {
    scope: { type: "string", default: "" },
    rev: { type: "string", default: "HEAD" },
    json: { type: "boolean", default: false },
  },
});
const scope = values.scope ?? "";
const rev = values.rev ?? "HEAD";

function git(args: string[], input?: string): Buffer {
  return execFileSync("git", ["-C", ROOT, ...args], {
    input,
    maxBuffer: 1024 * 1024 * 1024,
  });
}

const t0 = performance.now();
const entries = git(["ls-tree", "-r", "-z", "--full-tree", rev])
  .toString("utf8")
  .split("\0")
  .filter((r) => r !== "")
  .map((r) => {
    const tab = r.indexOf("\t");
    const [, type, oid] = r.slice(0, tab).split(" ");
    return { type, oid: oid ?? "", path: r.slice(tab + 1) };
  })
  .filter((e) => e.type === "blob" && (scope === "" || e.path.startsWith(scope)));
const files = entries.map((e) => e.path).sort();
const wanted = entries.filter((e) => contentNeeded(e.path));
const batch = spawnSync("git", ["-C", ROOT, "cat-file", "--batch"], {
  input: wanted.map((e) => e.oid).join("\n") + "\n",
  maxBuffer: 1024 * 1024 * 1024,
});
const out = batch.stdout;
const contents = new Map<string, string>();
let pos = 0;
for (const e of wanted) {
  const nl = out.indexOf(10, pos);
  const header = out.subarray(pos, nl).toString("utf8");
  const size = Number(header.split(" ")[2]);
  contents.set(e.path, out.subarray(nl + 1, nl + 1 + size).toString("utf8"));
  pos = nl + 1 + size + 1;
}
const tLoad = performance.now();

const headTree = (overrides: Map<string, string>): RepoTree => ({
  files,
  read: (p) => overrides.get(p) ?? contents.get(p) ?? null,
});
const baseTree: RepoTree = { files, read: (p) => contents.get(p) ?? null };

const samples = [
  "packages/domain/src/model.ts",
  "packages/evidence/src/producers/coverage.ts",
  "packages/classifier/src/classify.ts",
  "packages/web/src/lib/vocab.ts",
  "packages/affected/src/scan.ts",
  "apps/sandbox/src/lib/git.ts",
  "README.md",
].filter((p) => files.includes(p));

const rows: Array<Record<string, unknown>> = [];
for (const path of samples) {
  const overrides = new Map([[path, `${contents.get(path) ?? ""}\n// bench\n`]]);
  const s0 = performance.now();
  const set = computeAffectedSet({
    head: headTree(overrides),
    base: baseTree,
    changes: [{ status: "modified", path }],
  });
  const ms = performance.now() - s0;
  rows.push({
    change: path,
    ms: Math.round(ms),
    complete: set.complete,
    modules: set.modules.length,
    tests:
      set.testTargets.length === 1 && set.testTargets[0] === "*" ? "*" : set.testTargets.length,
    publicApi: set.publicApi,
    deploysTo: set.deploysTo.join(",") || "-",
    note: set.analyzers
      .filter((a) => a.name === "ts-js" || a.name === "affected")
      .map((a) => a.note ?? "")
      .filter((n) => n !== "")
      .join(" | "),
  });
}

const summary = {
  scope: scope === "" ? "(whole repo)" : scope,
  files: files.length,
  loaded: wanted.length,
  bytes: [...contents.values()].reduce((n, c) => n + c.length, 0),
  loadMs: Math.round(tLoad - t0),
};
if (values.json) {
  process.stdout.write(`${JSON.stringify({ summary, rows }, null, 2)}\n`);
} else {
  console.log(summary);
  console.table(rows.map(({ note, ...r }) => r));
  for (const r of rows) console.log(`${r.change}: ${r.note}`);
}
