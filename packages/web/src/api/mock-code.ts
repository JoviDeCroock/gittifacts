/**
 * Demo backend for a repo's code and history (api/code.ts in mock mode): a small billing-api tree,
 * ~26 weeks of commits dated relative to now (deterministic counts), the newest landed by the demo
 * Changes so their links open. Any repo id answers with the same repo.
 */
import type { CommitDetail, CommitSummary } from "@app/domain";
import { classifyFile, commitActivity, readmeOf, sortTreeEntries } from "@app/domain";
import { hunkFromText } from "../lib/diff.js";
import { ApiError } from "./client.js";

const FILES: Record<string, string> = {
  "README.md":
    "# billing-api\n\nInvoices, refunds and dunning for the billing product.\n\n## Develop\n\n- `pnpm install`\n- `pnpm test` runs the Workers suite\n\nChanges land through the merge queue: **agents** propose, people approve the plan.\n",
  "package.json":
    '{\n  "name": "billing-api",\n  "private": true,\n  "scripts": { "test": "vitest run", "deploy": "wrangler deploy" }\n}\n',
  "wrangler.jsonc":
    '{\n  "name": "billing-api",\n  "main": "src/index.ts",\n  "compatibility_date": "2026-09-30"\n}\n',
  "src/index.ts":
    'import { Hono } from "hono";\nimport { invoices } from "./invoices.js";\nimport { refunds } from "./refunds.js";\n\nconst app = new Hono();\napp.route("/invoices", invoices);\napp.route("/refunds", refunds);\n\nexport default app;\n',
  "src/invoices.ts":
    '// Invoice totals are computed in minor units; FX rates are cached for 60 seconds.\nimport { Hono } from "hono";\nimport { dueDate } from "./lib/dates.js";\nimport { fxRate } from "./lib/fx.js";\n\nexport const invoices = new Hono();\n\ninvoices.get("/:id", async (c) => {\n  const id = c.req.param("id");\n  const rate = await fxRate("EUR", "USD");\n  return c.json({ id, due: dueDate(new Date(), "Pacific/Auckland"), rate });\n});\n',
  "src/refunds.ts":
    'import { Hono } from "hono";\n\nexport const refunds = new Hono();\n\nrefunds.post("/", async (c) => {\n  const { amount } = await c.req.json<{ amount: number }>();\n  if (amount <= 0) return c.json({ error: "amount must be positive" }, 400);\n  return c.json({ ok: true, amount }, 201);\n});\n',
  "src/lib/dates.ts":
    '/** The due date in the customer\'s own time zone, 30 days out. */\nexport function dueDate(from: Date, timeZone: string): string {\n  const d = new Date(from.getTime() + 30 * 86_400_000);\n  return d.toLocaleDateString("en-CA", { timeZone });\n}\n',
  "src/lib/fx.ts":
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the file's own template literal
    "const cache = new Map<string, { rate: number; until: number }>();\n\nexport async function fxRate(from: string, to: string): Promise<number> {\n  const key = `${from}:${to}`;\n  const hit = cache.get(key);\n  if (hit && hit.until > Date.now()) return hit.rate;\n  const rate = 1.08;\n  cache.set(key, { rate, until: Date.now() + 60_000 });\n  return rate;\n}\n",
  "test/invoices.test.ts":
    'import { describe, expect, it } from "vitest";\nimport { dueDate } from "../src/lib/dates.js";\n\ndescribe("dueDate", () => {\n  it("uses the customer\'s time zone", () => {\n    expect(dueDate(new Date("2026-01-01T20:00:00Z"), "Pacific/Auckland")).toBe("2026-02-01");\n  });\n});\n',
};

const TITLES = [
  "Tighten refund amount validation",
  "Document the dunning schedule",
  "Retry receipt e-mails with backoff",
  "Rename invoice line fields",
  "Add a test for zero-amount refunds",
  "Bump hono to 4.9",
  "Log FX cache misses",
  "Split invoice routes by tenant",
];
const PEOPLE = [
  { name: "Ada Okafor", email: "ada@billing.example" },
  { name: "Forge-12", email: "forge-12@agents.gittifacts.dev" },
  { name: "Pilot-02", email: "pilot-02@agents.gittifacts.dev" },
];
const LANDED: Array<CommitSummary["landedBy"]> = [
  {
    changeId: "chg_fx2r7",
    title: "Cache FX rates for 60 seconds when totalling invoices",
    lane: 1,
    authorKind: "agent",
    authorName: "Forge-12",
  },
  {
    changeId: "chg_tz7k2",
    title: "Fix invoice due dates drifting a day for customers far from UTC",
    lane: 2,
    authorKind: "agent",
    authorName: "Pilot-02",
  },
  {
    changeId: "chg_wr5p8",
    title: "Upgrade wrangler to 4.42",
    lane: 0,
    authorKind: "agent",
    authorName: "Forge-12",
  },
];

const hex = (n: number) => ((n * 2654435761) >>> 0).toString(16).padStart(8, "0");
const shaOf = (i: number) => `${hex(i + 1)}${hex(i + 7)}${hex(i + 13)}${hex(i + 29)}${hex(i + 31)}`;

/** Newest first: a deterministic count per day over 182 days, at most 4 a day. */
function history(nowMs: number): CommitSummary[] {
  const out: CommitSummary[] = [];
  const day = 86_400_000;
  for (let d = 0; d < 182; d++) {
    const n = ((d * 7 + 3) % 11) % 5 === 0 ? 0 : (((d * 13) % 7) % 4) + (d % 9 === 0 ? 2 : 0);
    for (let k = 0; k < n; k++) {
      const i = out.length;
      const at = new Date(nowMs - d * day - (k + 1) * 47 * 60_000).toISOString();
      const landedBy = LANDED[i] ?? null;
      const who = landedBy
        ? (PEOPLE.find((p) => p.name === landedBy.authorName) ?? PEOPLE[0])
        : PEOPLE[i % 3];
      const title = landedBy?.title ?? TITLES[i % TITLES.length] ?? "Change";
      const person = { name: who?.name ?? "Ada Okafor", email: who?.email ?? "", at };
      out.push({
        sha: shaOf(i),
        title,
        message: `${title}\n`,
        author: person,
        committer: person,
        parents: [],
        landedBy,
      });
    }
  }
  const root = {
    name: "Ada Okafor",
    email: "ada@billing.example",
    at: new Date(nowMs - 200 * day).toISOString(),
  };
  out.push({
    sha: shaOf(out.length),
    title: "Initial commit",
    message: "Initial commit\n\nThe billing-api skeleton.\n",
    author: root,
    committer: root,
    parents: [],
    landedBy: null,
  });
  return out.map((c, i) => ({ ...c, parents: out[i + 1] ? [out[i + 1]?.sha ?? ""] : [] }));
}

/** A small, plausible diff for any demo commit: one file, a few lines. */
function diffFor(c: CommitSummary): Omit<CommitDetail["diff"], "parentSha" | "complete"> {
  if (c.parents.length === 0) {
    const files = Object.entries(FILES).map(([path, text]) => {
      const lines = text.replace(/\n$/, "").split("\n");
      const hunk = hunkFromText(0, 1, lines.map((l) => `+${l}`).join("\n"));
      return {
        path,
        previousPath: null,
        status: "added" as const,
        additions: lines.length,
        deletions: 0,
        binary: false,
        transformVerified: false,
        hunks: [hunk],
        truncated: false,
      };
    });
    return { files, additions: files.reduce((n, f) => n + f.additions, 0), deletions: 0 };
  }
  const path = c.title.includes("FX")
    ? "src/lib/fx.ts"
    : c.title.includes("due date")
      ? "src/lib/dates.ts"
      : "src/refunds.ts";
  const hunk = hunkFromText(
    4,
    4,
    `  const key = \`\${from}:\${to}\`;\n  const hit = cache.get(key);\n-  if (hit) return hit.rate;\n+  if (hit && hit.until > Date.now()) return hit.rate;\n   const rate = 1.08;`,
  );
  return {
    files: [
      {
        path,
        previousPath: null,
        status: "modified",
        additions: 1,
        deletions: 1,
        binary: false,
        transformVerified: false,
        hunks: [hunk],
        truncated: false,
      },
    ],
    additions: 1,
    deletions: 1,
  };
}

let cache: { at: number; commits: CommitSummary[] } | null = null;
function commits(): CommitSummary[] {
  const now = Date.now();
  if (!cache || now - cache.at > 60_000) cache = { at: now, commits: history(now) };
  return cache.commits;
}

const notFound = (what: string) => new ApiError(404, "not-found", `${what} not found`);

function tree(path: string) {
  const prefix = path === "" ? "" : `${path}/`;
  const names = new Map<string, "dir" | "file">();
  for (const p of Object.keys(FILES)) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf("/");
    names.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? "file" : "dir");
  }
  if (names.size === 0) throw notFound(path);
  return sortTreeEntries(
    [...names].map(([name, kind]) => ({
      name,
      path: `${prefix}${name}`,
      kind,
      mode: kind === "dir" ? "40000" : "100644",
      sha: shaOf(name.length * 97),
    })),
  );
}

export async function handle(url: string): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 120));
  const u = new URL(url, "http://mock");
  const m = /^\/api\/v1\/repos\/[^/]+\/(tree|file|commits|activity)(?:\/([0-9a-f]{40}))?$/.exec(
    u.pathname,
  );
  if (!m) throw notFound(u.pathname);
  const path = (u.searchParams.get("path") ?? "").replace(/^\/+|\/+$/g, "");
  const ref = u.searchParams.get("ref") ?? "main";
  const all = commits();
  const head = all[0]?.sha ?? "";
  if (m[1] === "tree") {
    if (FILES[path] !== undefined) throw new ApiError(400, "not-a-directory", `${path} is a file`);
    const entries = tree(path);
    const r = readmeOf(entries);
    const text = r ? (FILES[r.path] ?? null) : null;
    return {
      ref,
      commitSha: head,
      path,
      entries,
      readme:
        r && text ? { path: r.path, sha: r.sha, size: text.length, kind: "text", text } : null,
    };
  }
  if (m[1] === "file") {
    const text = FILES[path];
    if (text === undefined) throw notFound(path);
    const { kind } = classifyFile(new TextEncoder().encode(text));
    return {
      ref,
      commitSha: head,
      file: { path, sha: shaOf(path.length), size: text.length, kind, text },
    };
  }
  if (m[1] === "commits" && m[2]) {
    const c = all.find((x) => x.sha === m[2]);
    if (!c) throw notFound(`commit ${m[2]}`);
    const diff = diffFor(c);
    return {
      commit: c,
      diff: { parentSha: c.parents[0] ?? null, ...diff, complete: true },
    } satisfies CommitDetail;
  }
  if (m[1] === "commits") {
    const offset = Number(u.searchParams.get("offset") ?? 0);
    const limit = Number(u.searchParams.get("limit") ?? 30);
    const page = all.slice(offset, offset + limit);
    return {
      ref,
      headSha: head,
      commits: page,
      nextOffset: offset + limit < all.length ? offset + limit : null,
    };
  }
  const weeks = Number(u.searchParams.get("weeks") ?? 26);
  const rows = all.map((c) => ({
    at: c.committer.at ? Date.parse(c.committer.at) / 1000 : null,
    author: c.author.name,
  }));
  return {
    ref,
    headSha: head,
    ...commitActivity(rows, { nowMs: Date.now(), weeks, capped: false }),
  };
}
