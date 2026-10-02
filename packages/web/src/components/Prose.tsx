/**
 * Plain text from agents, with Markdown-style `code spans` rendered as code.
 * Nothing else is interpreted: no HTML, no links, no emphasis.
 */
import { Fragment } from "preact";
import { proseBlocks } from "../lib/prose.js";

export function Prose({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.length > 2 && p.startsWith("`") && p.endsWith("`") ? (
          <code key={i} class="inline-code">
            {p.slice(1, -1)}
          </code>
        ) : (
          p
        ),
      )}
    </>
  );
}

/**
 * Multi-line text from agents (a plan's intent): blank lines separate paragraphs, "- " lines
 * become a list, other line breaks are kept. Inline `code` as in Prose; nothing else.
 */
export function ProseBlocks({ text, class: cls = "" }: { text: string; class?: string }) {
  return (
    <div class={`prose-blocks ${cls}`}>
      {proseBlocks(text).map((b, i) =>
        b.kind === "ul" ? (
          <ul key={i}>
            {b.items.map((it, j) => (
              <li key={j}>
                <Prose text={it} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={i}>
            {b.lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 ? <br /> : null}
                <Prose text={l} />
              </Fragment>
            ))}
          </p>
        ),
      )}
    </div>
  );
}
