/**
 * A cited hunk excerpt. Syntax-light, line numbers stay pinned while the code scrolls
 * horizontally inside its own box; the page itself never scrolls sideways.
 */
import type { HunkRef } from "@app/domain";
import { useSignal } from "@preact/signals";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { ChangeDiff } from "../api/types.js";
import { type Excerpt, excerptForRef, rangeLabel, splitPath, tokenize, usesHashComments, wholeFileRefs } from "../lib/diff.js";
import { Icon } from "./Icon.js";

function Code({ text, hash }: { text: string; hash: boolean }) {
  if (text === "") return <span> </span>;
  return (
    <>
      {tokenize(text, { hashComments: hash }).map((t, i) =>
        t.kind === "plain" ? (
          t.text
        ) : (
          <span key={i} class={`tok-${t.kind}`}>
            {t.text}
          </span>
        ),
      )}
    </>
  );
}

/**
 * Whether the code runs past the box's right edge: the edge fades to say "more", and the Wrap
 * toggle appears. Re-measured on scroll and resize; a wrapped box never overflows.
 */
function useOverflow() {
  const ref = useRef<HTMLDivElement>(null);
  const overflows = useSignal(false);
  const more = useSignal(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const over = el.scrollWidth > el.clientWidth + 1;
      if (over) overflows.value = true;
      more.value = over && el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, [overflows, more]);
  return { ref, overflows: overflows.value, more: more.value };
}

/** The gutter as spoken: one number, the side the line lives on. */
function spokenLine(oldNo: number | null | undefined, newNo: number | null | undefined): string {
  if (newNo != null) return `line ${newNo}`;
  return oldNo != null ? `old line ${oldNo}` : "";
}

function ExcerptView({ ex }: { ex: Excerpt }) {
  const { dir, name } = splitPath(ex.file.path);
  const hash = usesHashComments(ex.file.path);
  const side = ex.ref.side ?? "head";
  const wrap = useSignal(false);
  const box = useOverflow();
  return (
    <figure class={`excerpt ${wrap.value ? "is-wrapped" : ""}`}>
      <figcaption class="excerpt__head">
        <Icon name="file-code" size={15} />
        <span class="excerpt__path" title={ex.file.path}>
          <span class="excerpt__dir">{dir}</span>
          <span class="excerpt__name">{name}</span>
        </span>
        <span class="excerpt__range tnum">
          {side === "base" ? "main " : ""}
          {rangeLabel(ex.ref)}
        </span>
        {ex.file.status !== "modified" ? <span class="excerpt__status">{ex.file.status}</span> : null}
        {box.overflows || wrap.value ? (
          <button type="button" class="excerpt__wrap" aria-pressed={wrap.value} onClick={() => (wrap.value = !wrap.value)} data-testid="excerpt-wrap">
            Wrap
          </button>
        ) : null}
      </figcaption>
      {ex.missing ? (
        <p class="excerpt__missing">The cited lines are not part of this diff. Check the walkthrough against the current head.</p>
      ) : (
        <div class="excerpt__body" data-more={box.more && !wrap.value ? "" : undefined}>
          <div class="excerpt__code scroll-x" ref={box.ref} tabIndex={0} role="region" aria-label={`${ex.file.path} ${rangeLabel(ex.ref)}`}>
            <table class="diff">
              <tbody>
                {ex.rows.map((row, i) =>
                  row.type === "gap" ? (
                    <tr key={`g${i}`} class="diff__gap">
                      <td class="diff__no" />
                      <td class="diff__sign" />
                      <td class="diff__text">
                        {row.skipped} unchanged {row.skipped === 1 ? "line" : "lines"}
                      </td>
                    </tr>
                  ) : (
                    <tr key={i} class={`diff__line diff__line--${row.line.kind} ${row.cited ? "is-cited" : ""}`}>
                      <td class="diff__no tnum">
                        {/* Both numbers on wide screens, one on phones (CSS); spoken once, not as "3838". */}
                        <span class="diff__o" aria-hidden="true">
                          {row.line.oldNo ?? ""}
                        </span>
                        <span class="diff__n" aria-hidden="true">
                          {row.line.newNo ?? ""}
                        </span>
                        <span class="sr-only">{spokenLine(row.line.oldNo, row.line.newNo)}</span>
                      </td>
                      <td class="diff__sign" aria-label={row.line.kind === "add" ? "added" : row.line.kind === "del" ? "removed" : undefined}>
                        {row.line.kind === "add" ? "+" : row.line.kind === "del" ? "−" : ""}
                      </td>
                      <td class="diff__text">
                        <Code text={row.line.text} hash={hash} />
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </figure>
  );
}

export function DiffExcerpt({ diff, refs }: { diff: ChangeDiff; refs: HunkRef[] }) {
  return (
    <div class="excerpts">
      {refs.map((ref, i) => {
        const ex = excerptForRef(diff, ref);
        if (!ex) {
          return (
            <p key={i} class="excerpt__missing">
              <code>{ref.file}</code> is cited but not in this diff.
            </p>
          );
        }
        return <ExcerptView key={`${ref.file}:${ref.startLine}`} ex={ex} />;
      })}
    </div>
  );
}

/** Past this many files the page stops rendering code; the rest are listed by path. */
const WHOLE_DIFF_MAX = 20;

/** Every changed file, for a change that has no tour to cite hunks. */
export function WholeDiff({ diff }: { diff: ChangeDiff }) {
  const shown = { ...diff, files: diff.files.slice(0, WHOLE_DIFF_MAX) };
  const rest = diff.files.slice(WHOLE_DIFF_MAX);
  const noText = shown.files.filter((f) => f.hunks.length === 0);
  return (
    <>
      <DiffExcerpt diff={shown} refs={wholeFileRefs(shown)} />
      {noText.length > 0 || rest.length > 0 ? (
        <ul class="whole-diff__rest">
          {noText.map((f) => (
            <li key={f.path}>
              <code>{f.path}</code> {f.binary ? "binary file" : f.truncated ? "too large to show" : "no text changes"}, {f.status}
            </li>
          ))}
          {rest.map((f) => (
            <li key={f.path}>
              <code>{f.path}</code> {f.status}, +{f.additions} −{f.deletions}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
