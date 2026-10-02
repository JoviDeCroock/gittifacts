/** One failed check, located in a content file. */
export interface Problem {
  /** Path under content/. */
  file: string;
  line: number;
  rule: "links" | "tool-call" | "cli" | "json" | "length" | "style" | "generated" | "front-matter";
  message: string;
}

export function formatProblem(p: Problem): string {
  return `content/${p.file}:${p.line}  [${p.rule}] ${p.message}`;
}
