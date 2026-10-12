/**
 * Enough Markdown for a README, parsed to blocks and inline runs that the UI renders as JSX (never
 * as HTML, so repo content cannot inject markup): headings, paragraphs, lists, fenced code, quotes
 * and rules; inline code, bold, emphasis and links (http(s) only; anything else stays text).
 * Raw HTML is shown as text. Pure.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "link"; text: string; href: string };

export type MdBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4; text: Inline[] }
  | { kind: "p"; text: Inline[] }
  | { kind: "ul" | "ol"; items: Inline[][] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "quote"; text: Inline[] }
  | { kind: "hr" };

const INLINE =
  /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  INLINE.lastIndex = 0;
  for (let m = INLINE.exec(text); m !== null; m = INLINE.exec(text)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    const [whole, code, strong, strong2, em, label, href] = m;
    if (code !== undefined) out.push({ kind: "code", text: code });
    else if (strong !== undefined || strong2 !== undefined)
      out.push({ kind: "strong", text: strong ?? strong2 ?? "" });
    else if (em !== undefined) out.push({ kind: "em", text: em });
    else if (whole.startsWith("!")) out.push({ kind: "text", text: label ?? "" });
    else if (href !== undefined && /^https?:\/\//i.test(href))
      out.push({ kind: "link", text: label ?? href, href });
    else out.push({ kind: "text", text: label ?? whole });
    last = m.index + whole.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

export function markdownBlocks(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) blocks.push({ kind: "p", text: inline(para.join(" ")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !(lines[i] ?? "").trim().startsWith(fence[1] ?? "```"); i++)
        body.push(lines[i] ?? "");
      blocks.push({ kind: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      const level = Math.min(heading[1]?.length ?? 1, 4) as 1 | 2 | 3 | 4;
      blocks.push({ kind: "heading", level, text: inline(heading[2] ?? "") });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ kind: "hr" });
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const kind = /\d/.test(item[1] ?? "") ? "ol" : "ul";
      const prev = blocks.at(-1);
      if (prev && prev.kind === kind) prev.items.push(inline(item[2] ?? ""));
      else blocks.push({ kind, items: [inline(item[2] ?? "")] });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      const prev = blocks.at(-1);
      const text = inline(quote[1] ?? "");
      if (prev?.kind === "quote") prev.text.push({ kind: "text", text: " " }, ...text);
      else blocks.push({ kind: "quote", text });
      continue;
    }
    if (line.trim() === "") flush();
    else para.push(line.trim());
  }
  flush();
  return blocks;
}
