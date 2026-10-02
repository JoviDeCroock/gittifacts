/**
 * Syntax-light highlighting (DESIGN.md "Diff Excerpt"): comments, strings, numbers and keywords
 * only. Runs at build time, so pages ship no highlighter.
 */

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

type Rule = [kind: "c" | "s" | "n" | "k", pattern: string];

const STRINGS = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'`;
const NUMBER = String.raw`\b\d+(?:\.\d+)?\b`;
const TS_KEYWORDS = String.raw`\b(?:const|let|await|async|export|default|import|from|return|if|else|function|type|interface|new|true|false|null|undefined)\b`;

const RULES: Record<string, Rule[]> = {
  sh: [
    ["c", String.raw`(?:^|(?<=\s))#[^\n]*`],
    ["s", STRINGS],
  ],
  ts: [
    ["c", String.raw`//[^\n]*|/\*[\s\S]*?\*/`],
    ["s", `${STRINGS}|\`(?:[^\`\\\\]|\\\\.)*\``],
    ["k", TS_KEYWORDS],
    ["n", NUMBER],
  ],
  json: [
    ["c", String.raw`//[^\n]*`],
    ["s", STRINGS],
    ["k", String.raw`\b(?:true|false|null)\b`],
    ["n", String.raw`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b`],
  ],
};

const ALIASES: Record<string, keyof typeof RULES> = {
  sh: "sh",
  bash: "sh",
  shell: "sh",
  console: "sh",
  ts: "ts",
  typescript: "ts",
  js: "ts",
  javascript: "ts",
  mjs: "ts",
  json: "json",
  jsonc: "json",
};

const CLASS = { c: "tok-c", s: "tok-s", n: "tok-n", k: "tok-k" } as const;

/** Escaped HTML for a code block, with `<span class="tok-*">` around recognized tokens. */
export function highlight(code: string, lang: string | undefined): string {
  const key = ALIASES[(lang ?? "").toLowerCase()];
  const rules = key === undefined ? undefined : RULES[key];
  if (rules === undefined) return escapeHtml(code);
  const re = new RegExp(rules.map(([, p]) => `(${p})`).join("|"), "gm");
  let out = "";
  let last = 0;
  for (const m of code.matchAll(re)) {
    const index = m.index ?? 0;
    if (m[0] === "") continue;
    out += escapeHtml(code.slice(last, index));
    const group = m.slice(1).findIndex((g) => g !== undefined);
    const rule = rules[group];
    out +=
      rule === undefined
        ? escapeHtml(m[0])
        : `<span class="${CLASS[rule[0]]}">${escapeHtml(m[0])}</span>`;
    last = index + m[0].length;
  }
  return out + escapeHtml(code.slice(last));
}
