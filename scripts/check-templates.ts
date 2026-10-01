/**
 * Verifies every launch template for real, the way the platform will run it:
 *
 *   pnpm tsx scripts/check-templates.ts [ids...] [--cold] [--keep] [--json]
 *
 * For each template (default: all) it
 *   1. copies templates/<id> to a temp dir and renders the {{placeholders}} (as create_project does),
 *   2. runs `pnpm install --frozen-lockfile` (--cold: with an empty pnpm store, so everything downloads),
 *   3. runs the lint, typecheck, test and build scripts and checks template.json's buildOutput exists,
 *   4. for templates with a previewCommand, starts it (with the monorepo's wrangler standing in for the
 *      sandbox's global one) and fetches every template.json route,
 * and prints how long each phase took. Exits 1 if anything fails.
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderPlaceholders,
  TEMPLATE_IDS,
  type TemplateId,
  TemplateManifest,
} from "../packages/conventions/src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const PHASES = ["install", "lint", "typecheck", "test", "build"] as const;
type Phase = (typeof PHASES)[number] | "preview";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const cold = flags.has("--cold");
const keep = flags.has("--keep");
const asJson = flags.has("--json");
const selected = args.filter((a) => !a.startsWith("--"));
for (const id of selected) {
  if (!(TEMPLATE_IDS as readonly string[]).includes(id))
    throw new Error(`unknown template "${id}" (have: ${TEMPLATE_IDS.join(", ")})`);
}
const ids = (selected.length > 0 ? selected : [...TEMPLATE_IDS]) as TemplateId[];

// ---------------------------------------------------------------- helpers

interface RunResult {
  code: number;
  output: string;
  ms: number;
}

function run(
  command: string,
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  const start = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, argv, {
      cwd,
      env: { ...process.env, CI: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d: Buffer) => {
      output += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      output += d.toString();
    });
    child.on("error", (err) =>
      resolve({ code: 127, output: `${output}${err.message}`, ms: performance.now() - start }),
    );
    child.on("close", (code) =>
      resolve({ code: code ?? 1, output, ms: performance.now() - start }),
    );
  });
}

function tail(text: string, lines = 25): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Renders placeholders in every text file, like create_project does. */
function renderTree(dir: string, values: Record<string, string>): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === "node_modules" || entry === "dist" || entry === ".wrangler") continue;
    if (statSync(path).isDirectory()) {
      renderTree(path, values);
      continue;
    }
    const text = readFileSync(path, "utf8");
    if (text.includes("\uFFFD") || !text.includes("{{")) continue;
    writeFileSync(path, renderPlaceholders(text, values));
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

/** Template-specific checks on a route's response body. */
const ROUTE_CHECKS: Partial<Record<TemplateId, Record<string, (body: string) => string | null>>> = {
  "workers-api": {
    "/": (body) => {
      const now = (JSON.parse(body) as { now?: unknown }).now;
      return typeof now === "string" && new Date(now).toISOString() === now
        ? null
        : `expected { now: <ISO time> }, got ${body}`;
    },
    "/health": (body) =>
      (JSON.parse(body) as { ok?: unknown }).ok === true
        ? null
        : `expected { ok: true }, got ${body}`,
  },
  "preact-app": {
    "/": (body) =>
      body.includes('<div id="app">') && body.includes("/app.js")
        ? null
        : "index.html without the app mount",
  },
  "static-site": {
    "/": (body) =>
      body.includes("<title>check-static-site</title>") ? null : "placeholders were not rendered",
  },
};

interface PreviewResult {
  ok: boolean;
  readyMs: number;
  detail: string;
}

async function checkPreview(
  id: TemplateId,
  dir: string,
  manifest: TemplateManifest,
): Promise<PreviewResult> {
  const command = manifest.previewCommand;
  if (command === null) return { ok: true, readyMs: 0, detail: "no preview" };
  const port = await freePort();
  // The sandbox has wrangler on PATH; here the monorepo's copy stands in. Bind to loopback only.
  const argv = command
    .replace(/^wrangler\s+/, "")
    .replace("$PORT", String(port))
    .replace("0.0.0.0", "127.0.0.1")
    .split(/\s+/);
  const start = performance.now();
  const child = spawn(process.execPath, [WRANGLER, ...argv], {
    cwd: dir,
    detached: true,
    env: { ...process.env, PORT: String(port), WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (d: Buffer) => {
    log += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    log += d.toString();
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    const first = manifest.routes[0] ?? "/";
    let readyMs = -1;
    while (performance.now() - start < 90_000) {
      if (child.exitCode !== null)
        return { ok: false, readyMs: -1, detail: `wrangler dev exited:\n${tail(log)}` };
      try {
        const res = await fetch(`${base}${first}`);
        await res.arrayBuffer();
        readyMs = performance.now() - start;
        break;
      } catch {
        await sleep(200);
      }
    }
    if (readyMs < 0)
      return { ok: false, readyMs: -1, detail: `not ready after 90 s:\n${tail(log)}` };
    const problems: string[] = [];
    for (const route of manifest.routes) {
      const res = await fetch(`${base}${route}`);
      const body = await res.text();
      if (res.status !== 200) {
        problems.push(`${route}: HTTP ${res.status}`);
        continue;
      }
      const check = ROUTE_CHECKS[id]?.[route];
      const problem = check === undefined ? null : check(body);
      if (problem !== null) problems.push(`${route}: ${problem}`);
    }
    return problems.length === 0
      ? { ok: true, readyMs, detail: `${manifest.routes.join(", ")} → 200` }
      : { ok: false, readyMs, detail: problems.join("\n") };
  } finally {
    killTree(child);
  }
}

// ---------------------------------------------------------------- main

interface TemplateReport {
  id: TemplateId;
  ok: boolean;
  ms: Partial<Record<Phase, number>>;
  /** install + the slowest of the parallel CI steps (what .platform/ci.ts runs). */
  ciCriticalPathMs: number;
  failures: string[];
}

async function checkTemplate(id: TemplateId, workRoot: string): Promise<TemplateReport> {
  const source = join(ROOT, "templates", id);
  const dir = join(workRoot, id);
  cpSync(source, dir, {
    recursive: true,
    filter: (src) => !/(^|\/)(node_modules|dist|\.wrangler)$/.test(relative(source, src)),
  });
  renderTree(dir, {
    projectName: `check-${id}`,
    host: "https://gittifacts.example",
    mcpUrl: "https://gittifacts.example/mcp",
    repoId: `rep_check_${id}`,
  });
  const manifest = TemplateManifest.parse(
    JSON.parse(readFileSync(join(dir, "template.json"), "utf8")),
  );
  const report: TemplateReport = { id, ok: true, ms: {}, ciCriticalPathMs: 0, failures: [] };

  const installArgs = [
    "install",
    "--frozen-lockfile",
    ...(cold ? ["--store-dir", join(workRoot, `store-${id}`)] : []),
  ];
  const steps: [Phase, string[]][] = [
    ["install", installArgs],
    ["lint", ["run", "lint"]],
    ["typecheck", ["run", "typecheck"]],
    ["test", ["run", "test"]],
    ["build", ["run", "build"]],
  ];
  for (const [phase, argv] of steps) {
    const result = await run("pnpm", argv, dir);
    report.ms[phase] = result.ms;
    if (result.code !== 0) {
      report.ok = false;
      report.failures.push(`${phase} failed (exit ${result.code}):\n${tail(result.output)}`);
      if (phase === "install") return report;
    }
  }
  if (!existsSync(join(dir, manifest.buildOutput))) {
    report.ok = false;
    report.failures.push(`build output ${manifest.buildOutput}/ is missing`);
  }
  const parallel = ["lint", "typecheck", "test", "build"] as const;
  report.ciCriticalPathMs =
    (report.ms.install ?? 0) + Math.max(...parallel.map((p) => report.ms[p] ?? 0));

  if (report.ok) {
    const preview = await checkPreview(id, dir, manifest);
    if (manifest.previewCommand !== null) report.ms.preview = preview.readyMs;
    if (!preview.ok) {
      report.ok = false;
      report.failures.push(`preview: ${preview.detail}`);
    }
  }
  return report;
}

const fmt = (ms: number | undefined) =>
  ms === undefined || ms < 0 ? "-" : `${(ms / 1000).toFixed(1)}s`;

async function main(): Promise<void> {
  const workRoot = mkdtempSync(join(tmpdir(), "gittifacts-templates-"));
  const reports: TemplateReport[] = [];
  try {
    for (const id of ids) {
      if (!asJson) process.stdout.write(`checking ${id}${cold ? " (cold store)" : ""}...\n`);
      reports.push(await checkTemplate(id, workRoot));
    }
  } finally {
    if (keep) console.error(`kept ${workRoot}`);
    else rmSync(workRoot, { recursive: true, force: true });
  }

  if (asJson) {
    console.log(JSON.stringify({ cold, reports }, null, 2));
  } else {
    const header = [
      "template",
      "install",
      "lint",
      "typecheck",
      "test",
      "build",
      "CI path",
      "preview ready",
      "result",
    ];
    const rows = reports.map((r) => [
      r.id,
      fmt(r.ms.install),
      fmt(r.ms.lint),
      fmt(r.ms.typecheck),
      fmt(r.ms.test),
      fmt(r.ms.build),
      fmt(r.ciCriticalPathMs),
      fmt(r.ms.preview),
      r.ok ? "ok" : "FAIL",
    ]);
    const widths = header.map((h, i) =>
      Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)),
    );
    const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
    console.log(`\n${line(header)}\n${rows.map(line).join("\n")}`);
    console.log(
      "\nCI path = install + the slowest of lint/typecheck/test/build (they run in parallel in .platform/ci.ts).",
    );
    for (const r of reports) for (const f of r.failures) console.error(`\n[${r.id}] ${f}`);
  }
  if (reports.some((r) => !r.ok)) process.exit(1);
}

await main();
