/**
 * Where the report and gates scripts read a matrix from:
 * - the evals Worker's API (`--url` or EVALS_URL, with EVALS_READ_TOKEN), the default; or
 * - a local JSON file (`--file`), as `GET /matrices/:id` returns it.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { MatrixView } from "../src/results.js";

export interface SourceArgs {
  url?: string | undefined;
  file?: string | undefined;
  matrix?: string | undefined;
  trigger?: string | undefined;
  incomplete?: boolean | undefined;
}

export const SOURCE_OPTIONS = {
  url: { type: "string" },
  file: { type: "string" },
  matrix: { type: "string" },
  trigger: { type: "string" },
  incomplete: { type: "boolean" },
} as const;

export function args<T extends Record<string, { type: "string" | "boolean"; multiple?: boolean }>>(
  options: T,
) {
  // `pnpm --filter … gates -- --flag` passes a literal "--" first.
  const argv = process.argv.slice(2).filter((a, i) => !(i === 0 && a === "--"));
  return parseArgs({ args: argv, options: { ...SOURCE_OPTIONS, ...options }, strict: true }).values;
}

export async function loadView(a: SourceArgs): Promise<MatrixView> {
  if (a.file) return MatrixView.parse(JSON.parse(await readFile(a.file, "utf8")));
  const base = (a.url ?? process.env.EVALS_URL ?? "").replace(/\/+$/, "");
  const token = process.env.EVALS_READ_TOKEN ?? process.env.EVALS_API_TOKEN;
  if (!base)
    throw new Error("set --url or EVALS_URL (the gittifacts-evals Worker), or pass --file");
  if (!token) throw new Error("set EVALS_READ_TOKEN");
  let path: string;
  if (a.matrix) path = `/matrices/${encodeURIComponent(a.matrix)}`;
  else {
    const q = new URLSearchParams();
    if (!a.incomplete) q.set("complete", "1");
    q.set("trigger", a.trigger ?? "cron");
    path = `/matrices/latest?${q}`;
  }
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return MatrixView.parse(await res.json());
}
