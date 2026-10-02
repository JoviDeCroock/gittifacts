/**
 * What the checks look at in a page: code blocks (with their info string), inline code, links
 * and prose paragraphs, each with the line it starts on.
 */
import { Lexer, type Token, type Tokens } from "marked";
import type { Page } from "../content.js";

export interface Located {
  line: number;
}
export interface CodeBlock extends Located {
  lang: string;
  /** Words after the language in the fence's info string (`json schema=policy`). */
  info: string[];
  text: string;
}
export interface InlineCode extends Located {
  text: string;
}
export interface Link extends Located {
  href: string;
}
export interface Paragraph extends Located {
  /** Plain text with code spans and link URLs removed. */
  text: string;
}

export interface Extracted {
  blocks: CodeBlock[];
  inline: InlineCode[];
  links: Link[];
  paragraphs: Paragraph[];
}

/** Line (1-based, in the file) where `raw` first appears at or after `from` in the body. */
function locator(page: Page) {
  const offset = page.raw.length - page.body.length;
  const lineOf = (index: number) => page.raw.slice(0, offset + index).split("\n").length;
  let cursor = 0;
  return (raw: string): number => {
    const i = page.body.indexOf(raw, cursor);
    if (i < 0) return lineOf(cursor);
    cursor = i;
    return lineOf(i);
  };
}

function inlineText(tokens: readonly Token[] | undefined): string {
  return (tokens ?? [])
    .map((t) => {
      if (t.type === "codespan") return "`code`";
      if ("tokens" in t && Array.isArray(t.tokens)) return inlineText(t.tokens as Token[]);
      return "text" in t && typeof t.text === "string" ? t.text : "";
    })
    .join("");
}

export function extract(page: Page): Extracted {
  const out: Extracted = { blocks: [], inline: [], links: [], paragraphs: [] };
  const at = locator(page);
  const tokens = new Lexer({ gfm: true }).lex(page.body);
  const visitInline = (list: readonly Token[] | undefined, line: number) => {
    for (const t of list ?? []) {
      if (t.type === "codespan") out.inline.push({ line, text: (t as Tokens.Codespan).text });
      if (t.type === "link") out.links.push({ line, href: (t as Tokens.Link).href });
      if ("tokens" in t && Array.isArray(t.tokens)) visitInline(t.tokens as Token[], line);
    }
  };
  const visit = (list: readonly Token[]) => {
    for (const t of list) {
      const line = at(t.raw.split("\n")[0] ?? t.raw);
      switch (t.type) {
        case "code": {
          const [lang = "", ...info] = ((t as Tokens.Code).lang ?? "").split(/\s+/).filter(Boolean);
          out.blocks.push({ line, lang, info, text: (t as Tokens.Code).text });
          break;
        }
        case "paragraph":
          out.paragraphs.push({ line, text: inlineText((t as Tokens.Paragraph).tokens) });
          visitInline((t as Tokens.Paragraph).tokens, line);
          break;
        case "heading":
          visitInline((t as Tokens.Heading).tokens, line);
          break;
        case "table": {
          const table = t as Tokens.Table;
          for (const cell of [...table.header, ...table.rows.flat()])
            visitInline(cell.tokens, line);
          break;
        }
        case "list":
          for (const item of (t as Tokens.List).items) visit(item.tokens);
          break;
        case "blockquote":
          visit((t as Tokens.Blockquote).tokens);
          break;
        case "text":
          if ("tokens" in t && Array.isArray(t.tokens)) {
            out.paragraphs.push({ line, text: inlineText(t.tokens as Token[]) });
            visitInline(t.tokens as Token[], line);
          }
          break;
        default:
          break;
      }
    }
  };
  visit(tokens);
  return out;
}
