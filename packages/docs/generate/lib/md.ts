/**
 * Markdown helpers for generated reference pages. Output must be deterministic: no dates, no
 * environment, stable ordering (the check regenerates and diffs).
 */

export interface GeneratedPage {
  /** Path under content/ (`reference/mcp-tools.md`). */
  file: string;
  content: string;
}

export interface PageMeta {
  title: string;
  description: string;
  order: number;
  nav?: string;
  audience?: "agents" | "humans" | "both" | "integrators";
}

const yamlString = (s: string) => JSON.stringify(s);

/** Front matter + H1 + the "generated from" note. `sources` are repo-relative paths. */
export function header(meta: PageMeta, sources: readonly string[], lede?: string): string {
  const fm = [
    "---",
    `title: ${yamlString(meta.title)}`,
    ...(meta.nav === undefined ? [] : [`nav: ${yamlString(meta.nav)}`]),
    `description: ${yamlString(meta.description)}`,
    `order: ${meta.order}`,
    `audience: ${meta.audience ?? "both"}`,
    "generated: true",
    "---",
    "",
    `# ${meta.title}`,
    "",
  ];
  if (lede !== undefined) fm.push(lede, "");
  const from = sources.map((s) => `\`${s}\``).join(", ");
  fm.push(
    `> Generated from ${from} by \`pnpm --filter @app/docs generate\`. Don't edit this page by hand: change the code and regenerate.`,
    "",
  );
  return fm.join("\n");
}

/** A table cell: pipes escaped (also inside code spans), newlines flattened. */
export function cell(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  return s
    .replaceAll("|", "\\|")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

export function code(value: string): string {
  if (value === "") return "";
  const ticks = value.includes("`") ? "``" : "`";
  const pad = ticks === "``" ? " " : "";
  return `${ticks}${pad}${value}${pad}${ticks}`;
}

export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

export function fence(lang: string, body: string): string {
  return `\`\`\`${lang}\n${body.replace(/\n+$/, "")}\n\`\`\``;
}

/** First sentence of a description (tables). */
export function firstSentence(s: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(s.trim());
  return (m?.[1] ?? s).trim();
}

/** `a/b` → `A/b`-style title case for the first letter only. */
export function capital(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

export function join(...blocks: (string | false | null | undefined)[]): string {
  return `${blocks
    .filter((b): b is string => typeof b === "string" && b.trim() !== "")
    .map((b) => b.trim())
    .join("\n\n")}\n`;
}
