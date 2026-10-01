// Codemod: rename the internal currency helper `requireCurrency` to `toCurrencyCode`.
//
// Run from the repository root:  node .platform/transforms/rename-helper.mjs
//
// The platform re-runs this script on a clean checkout of a change's base commit and
// requires the result to match the change's head byte-for-byte. So it is:
//   - deterministic: visits *.ts files under src/ and test/ in sorted order, and only
//     replaces whole-word occurrences (no clocks, no randomness, no network);
//   - byte-preserving: a file is rewritten only if its content changes;
//   - idempotent: once applied there is nothing left to rename, so a re-run is a no-op;
//   - safe: refuses to run if the new name already exists alongside the old one.
// Plain Node, no dependencies.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const FROM = "requireCurrency";
const TO = "toCurrencyCode";
const ROOTS = ["src", "test"];

const word = (name) => new RegExp(`\\b${name}\\b`, "g");

function listTsFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

const root = process.cwd();
const files = ROOTS.flatMap((dir) => listTsFiles(join(root, dir)));
const sources = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));

const usesOld = [...sources.values()].some((text) => word(FROM).test(text));
const usesNew = [...sources.values()].some((text) => word(TO).test(text));
if (usesOld && usesNew) {
  console.error(`rename-helper: both ${FROM} and ${TO} exist; refusing to merge two identifiers`);
  process.exit(1);
}

let rewritten = 0;
for (const [file, before] of sources) {
  const after = before.replace(word(FROM), TO);
  if (after !== before) {
    writeFileSync(file, after);
    rewritten += 1;
    console.log(`rewrote ${relative(root, file).split("\\").join("/")}`);
  }
}
console.log(`rename-helper: ${FROM} -> ${TO} in ${rewritten} file(s)`);
