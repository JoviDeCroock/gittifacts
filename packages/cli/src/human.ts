/**
 * `--human`: the same document as the JSON output, rendered as plain-text sections and tables.
 * Next steps and `fix` hints are called out; color only on a TTY (and never with NO_COLOR).
 */
import type { ErrorBody } from "./errors.js";
import { isRecord } from "./tools/schema.js";

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  green(s: string): string;
  cyan(s: string): string;
}

const sgr = (open: number, close: number) => (s: string) => `\u001b[${open}m${s}\u001b[${close}m`;

export function makeStyle(color: boolean): Style {
  if (!color) {
    const id = (s: string) => s;
    return { bold: id, dim: id, red: id, yellow: id, green: id, cyan: id };
  }
  return {
    bold: sgr(1, 22),
    dim: sgr(2, 22),
    red: sgr(31, 39),
    yellow: sgr(33, 39),
    green: sgr(32, 39),
    cyan: sgr(36, 39),
  };
}

export function useColor(
  stream: { isTTY?: boolean | undefined },
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0")
    return true;
  return stream.isTTY === true && env.TERM !== "dumb";
}

export interface RenderOptions {
  style: Style;
  /** Terminal width; tables shrink their widest columns to fit. */
  width: number;
  title?: string | undefined;
}

type Scalar = string | number | boolean | null | undefined;

function isScalar(v: unknown): v is Scalar {
  return v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);
}

function show(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** `laneReasons` → `Lane reasons`. */
export function humanize(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function truncate(s: string, width: number): string {
  const flat = s.replace(/\s+/g, " ");
  if (flat.length <= width) return flat;
  return width <= 1 ? flat.slice(0, width) : `${flat.slice(0, width - 1)}…`;
}

export function table(
  rows: readonly Record<string, unknown>[],
  opts: { style: Style; width: number; indent?: number; columns?: string[] },
): string[] {
  const indent = " ".repeat(opts.indent ?? 0);
  const columns =
    opts.columns ??
    [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) =>
      rows.some((r) => r[k] !== undefined),
    );
  if (columns.length === 0) return [];
  const cells = rows.map((r) => columns.map((c) => show(r[c]).replace(/\s+/g, " ")));
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...cells.map((row) => (row[i] ?? "").length)),
  );
  const gap = 2;
  const budget = Math.max(20, opts.width - indent.length);
  // Shrink the widest column until the row fits.
  while (widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1) > budget) {
    const max = Math.max(...widths);
    const i = widths.indexOf(max);
    if (max <= 8) break;
    widths[i] = max - 1;
  }
  const line = (vals: string[]) =>
    indent +
    vals
      .map((v, i) => truncate(v, widths[i] ?? v.length).padEnd(widths[i] ?? 0))
      .join(" ".repeat(gap))
      .trimEnd();
  return [
    opts.style.bold(line(columns.map((c) => humanize(c).toUpperCase()))),
    ...cells.map((row) => line(row)),
  ];
}

function keyValues(entries: [string, unknown][], opts: { style: Style; indent: number }): string[] {
  if (entries.length === 0) return [];
  const pad = Math.max(...entries.map(([k]) => humanize(k).length));
  const indent = " ".repeat(opts.indent);
  return entries.map(
    ([k, v]) => `${indent}${opts.style.dim(`${humanize(k)}:`.padEnd(pad + 1))} ${show(v)}`,
  );
}

function renderSteps(steps: unknown[], style: Style, indent: number): string[] {
  const pad = " ".repeat(indent);
  const out: string[] = [];
  steps.forEach((s, i) => {
    if (!isRecord(s)) return;
    out.push(`${pad}${i + 1}. ${style.bold(show(s.title))}`);
    if (typeof s.why === "string") out.push(`${pad}   ${style.dim(s.why)}`);
    if (typeof s.command === "string") out.push(`${pad}   ${style.cyan(`$ ${s.command}`)}`);
    if (typeof s.call === "string") out.push(`${pad}   ${style.dim(`mcp: ${s.call}`)}`);
    if (typeof s.docsUrl === "string") out.push(`${pad}   ${style.dim(`docs: ${s.docsUrl}`)}`);
  });
  return out;
}

const STEP_KEYS = new Set(["nextSteps", "loop"]);

function renderObject(
  obj: Record<string, unknown>,
  opts: RenderOptions,
  indent: number,
  depth: number,
): string[] {
  const { style } = opts;
  const out: string[] = [];
  const scalars = Object.entries(obj).filter(([, v]) => isScalar(v));
  out.push(...keyValues(scalars, { style, indent }));
  const pad = " ".repeat(indent);
  const complex = Object.entries(obj).filter(([k, v]) => !isScalar(v) && !STEP_KEYS.has(k));
  for (const [key, value] of complex) {
    if (out.length > 0) out.push("");
    out.push(`${pad}${style.bold(humanize(key))}`);
    if (Array.isArray(value)) {
      if (value.length === 0) out.push(`${pad}  (none)`);
      else if (value.every(isRecord)) {
        out.push(...table(value, { style, width: opts.width, indent: indent + 2 }));
      } else out.push(...value.map((v) => `${pad}  - ${show(v)}`));
    } else if (isRecord(value)) {
      if (depth >= 3)
        out.push(`${pad}  ${truncate(JSON.stringify(value), opts.width - indent - 2)}`);
      else out.push(...renderObject(value, opts, indent + 2, depth + 1));
    }
  }
  for (const key of STEP_KEYS) {
    const steps = obj[key];
    if (!Array.isArray(steps) || steps.length === 0) continue;
    if (out.length > 0) out.push("");
    out.push(`${pad}${style.bold(humanize(key))}`);
    out.push(...renderSteps(steps, style, indent + 2));
  }
  return out;
}

export function renderError(
  body: ErrorBody,
  opts: RenderOptions,
  extra: Record<string, unknown> = {},
): string {
  const { style } = opts;
  const out = [`${style.red(style.bold("Error"))} ${style.red(`[${body.code}]`)} ${body.message}`];
  const fix = body.fix;
  out.push("", `${style.yellow(style.bold("Fix:"))} ${style.yellow(fix.explanation)}`);
  if (fix.command) out.push(`  ${style.cyan(`$ ${fix.command}`)}`);
  if (fix.call) out.push(`  ${style.dim(`mcp: ${fix.call}`)}`);
  if (fix.docsUrl) out.push(`  ${style.dim(`docs: ${fix.docsUrl}`)}`);
  if (body.details !== undefined) {
    out.push("", style.dim("Details:"));
    if (Array.isArray(body.details) && body.details.every(isRecord)) {
      out.push(...table(body.details, { style, width: opts.width, indent: 2 }));
    } else if (isRecord(body.details)) {
      out.push(...renderObject(body.details, opts, 2, 1));
    } else out.push(`  ${show(body.details)}`);
  }
  const rest = Object.entries(extra).filter(([, v]) => v !== undefined);
  if (rest.length > 0) out.push("", ...keyValues(rest, { style, indent: 0 }));
  return `${out.join("\n")}\n`;
}

/** Renders any result document. */
export function renderHuman(doc: unknown, opts: RenderOptions): string {
  const out: string[] = [];
  if (opts.title) out.push(opts.style.bold(opts.title), "");
  if (isRecord(doc)) out.push(...renderObject(doc, opts, 0, 0));
  else if (Array.isArray(doc)) {
    out.push(
      ...(doc.every(isRecord)
        ? table(doc, { style: opts.style, width: opts.width })
        : doc.map(show)),
    );
  } else out.push(show(doc));
  return `${out.join("\n").trimEnd()}\n`;
}
