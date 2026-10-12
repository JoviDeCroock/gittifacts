/**
 * One file's text in the Diff Excerpt's box (DESIGN.md): the path in the sheet header, a pinned
 * line-number gutter, syntax-light tokens, the fade at the right edge and the Wrap toggle. Long
 * files render their first lines and offer the rest, so a phone never lays out 10,000 rows at once.
 */
import { useSignal } from "@preact/signals";
import { splitLines } from "../lib/code.js";
import { splitPath, usesHashComments } from "../lib/diff.js";
import { Code, useOverflow } from "./DiffExcerpt.js";
import { Icon } from "./Icon.js";
import { Button } from "./ui.js";

/** Lines drawn before "Show all". */
export const FIRST_LINES = 3000;

export function CodeView({ path, text, meta }: { path: string; text: string; meta?: string }) {
  const lines = splitLines(text);
  const all = useSignal(false);
  const wrap = useSignal(false);
  const box = useOverflow();
  const shown = all.value ? lines : lines.slice(0, FIRST_LINES);
  const hash = usesHashComments(path);
  const { dir, name } = splitPath(path);
  return (
    <figure class={`excerpt code-view ${wrap.value ? "is-wrapped" : ""}`} data-testid="code-view">
      <figcaption class="excerpt__head">
        <Icon name="file-code" size={15} />
        <span class="excerpt__path" title={path}>
          <span class="excerpt__dir">{dir}</span>
          <span class="excerpt__name">{name}</span>
        </span>
        <span class="excerpt__range tnum">{meta ?? `${lines.length} lines`}</span>
        {box.overflows || wrap.value ? (
          <button
            type="button"
            class="excerpt__wrap"
            aria-pressed={wrap.value}
            onClick={() => (wrap.value = !wrap.value)}
          >
            Wrap
          </button>
        ) : null}
      </figcaption>
      <div class="excerpt__body" data-more={box.more && !wrap.value ? "" : undefined}>
        <section
          class="excerpt__code scroll-x"
          ref={box.ref}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable code box must be keyboard-focusable (axe scrollable-region-focusable)
          tabIndex={0}
          aria-label={`${path}, ${lines.length} lines`}
        >
          <table class="diff code-view__table">
            <tbody>
              {shown.map((line, i) => (
                <tr key={i} class="diff__line">
                  <td class="diff__no tnum">
                    <span class="code-view__no">{i + 1}</span>
                  </td>
                  <td class="diff__text">
                    <Code text={line} hash={hash} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
      {shown.length < lines.length ? (
        <div class="code-view__more">
          <Button variant="quiet" size="sm" onClick={() => (all.value = true)}>
            Show all {lines.length.toLocaleString()} lines
          </Button>
        </div>
      ) : null}
    </figure>
  );
}
