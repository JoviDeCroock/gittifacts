/** Agent text structure, without rendering: paragraphs and "- " lists. Pure. */
export type ProseBlock = { kind: "p"; lines: string[] } | { kind: "ul"; items: string[] };

export function proseBlocks(text: string): ProseBlock[] {
  const blocks: ProseBlock[] = [];
  let current: ProseBlock | null = null;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const item = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (line.trim() === "") {
      current = null;
    } else if (item) {
      if (current?.kind !== "ul") blocks.push((current = { kind: "ul", items: [] }));
      current.items.push(item[1] ?? "");
    } else {
      if (current?.kind !== "p") blocks.push((current = { kind: "p", lines: [] }));
      current.lines.push(line.trim());
    }
  }
  return blocks;
}
