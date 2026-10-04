#!/usr/bin/env node
// Refuses to let a test report leave the runner if it contains a secret (docs/testing.md, "Secrets
// in reports"). Run before every report upload in workflows that hold real credentials.
//
//   SECRET_ENV=E2E_PASSWORD,E2E_AGENT_TOKEN node scripts/check-report-secrets.mjs [--allow-traces] <dir|file>...
//
// For each named env var with a value of 8+ characters, every file under the paths is searched
// for the value as-is, URL-encoded, JSON-escaped and base64-encoded. Trace archives (.zip) are
// refused outright: they are compressed, so their content can't be checked, and they hold request
// bodies (--allow-traces: the gate's traces hold only throwaway local accounts). On a hit it names the file and the variable (never the value), DELETES the paths so a
// later `if: always()` upload has nothing to send, and exits 1. Exits 0 when clean.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const names = (process.env.SECRET_ENV ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const args = process.argv.slice(2);
const allowTraces = args.includes("--allow-traces");
const paths = args.filter((a) => !a.startsWith("--") && existsSync(a));
const secrets = [];
for (const name of names) {
  const v = process.env[name] ?? "";
  if (v.length < 8) continue;
  const forms = new Set([v, encodeURIComponent(v), JSON.stringify(v).slice(1, -1), Buffer.from(v).toString("base64")]);
  for (const f of forms) secrets.push({ name, needle: Buffer.from(f) });
}

function* files(p) {
  const st = statSync(p);
  if (st.isFile()) {
    yield p;
    return;
  }
  for (const entry of readdirSync(p)) yield* files(join(p, entry));
}

const problems = [];
let scanned = 0;
for (const root of paths) {
  for (const file of files(root)) {
    scanned++;
    if (file.endsWith(".zip") && secrets.length > 0 && !allowTraces) {
      problems.push(`${file}: a trace archive in a report that ran with real credentials (traces must be off)`);
      continue;
    }
    const bytes = readFileSync(file);
    for (const s of secrets) {
      if (bytes.includes(s.needle)) {
        problems.push(`${file}: contains the value of ${s.name}`);
        break;
      }
    }
  }
}

const checked = [...new Set(secrets.map((s) => s.name))];
if (problems.length > 0) {
  for (const p of problems) console.error(`secret leak: ${p}`);
  for (const root of paths) rmSync(root, { recursive: true, force: true });
  console.error(`check-report-secrets: ${problems.length} problem(s); deleted ${paths.join(", ")} so nothing is uploaded`);
  process.exit(1);
}
console.log(`check-report-secrets: ${scanned} file(s) clean of ${checked.length ? checked.join(", ") : "no configured secrets"}`);
