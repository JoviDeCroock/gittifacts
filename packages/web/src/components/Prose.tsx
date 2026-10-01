/**
 * Plain text from agents, with Markdown-style `code spans` rendered as code.
 * Nothing else is interpreted: no HTML, no links, no emphasis.
 */
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
