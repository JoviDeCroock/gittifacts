/** A README rendered from `markdownBlocks` as JSX (no HTML from the repo reaches the DOM). */
import { type Inline, markdownBlocks } from "../lib/markdown.js";

function Runs({ runs }: { runs: Inline[] }) {
  return (
    <>
      {runs.map((r, i) => {
        if (r.kind === "code") return <code key={i}>{r.text}</code>;
        if (r.kind === "strong") return <strong key={i}>{r.text}</strong>;
        if (r.kind === "em") return <em key={i}>{r.text}</em>;
        if (r.kind === "link")
          return (
            <a key={i} href={r.href} rel="noopener noreferrer nofollow" target="_blank">
              {r.text}
            </a>
          );
        return r.text;
      })}
    </>
  );
}

export function Markdown({ source }: { source: string }) {
  return (
    <div class="markdown">
      {markdownBlocks(source).map((b, i) => {
        switch (b.kind) {
          case "heading": {
            const H = `h${b.level + 1}` as "h2" | "h3" | "h4" | "h5";
            return (
              <H key={i}>
                <Runs runs={b.text} />
              </H>
            );
          }
          case "p":
            return (
              <p key={i}>
                <Runs runs={b.text} />
              </p>
            );
          case "ul":
          case "ol": {
            const L = b.kind;
            return (
              <L key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Runs runs={it} />
                  </li>
                ))}
              </L>
            );
          }
          case "code":
            return (
              <pre key={i} class="markdown__code scroll-x">
                <code>{b.text}</code>
              </pre>
            );
          case "quote":
            return (
              <blockquote key={i}>
                <Runs runs={b.text} />
              </blockquote>
            );
          default:
            return <hr key={i} />;
        }
      })}
    </div>
  );
}
