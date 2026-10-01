/**
 * A cited hunk excerpt. Syntax-light, line numbers stay pinned while the code scrolls
 * horizontally inside its own box; the page itself never scrolls sideways.
 */
import type { HunkRef } from "@app/domain";
import type { ChangeDiff } from "../api/types.js";
import { type Excerpt, excerptForRef, rangeLabel, splitPath, tokenize, usesHashComments } from "../lib/diff.js";
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

function ExcerptView({ ex }: { ex: Excerpt }) {
  const { dir, name } = splitPath(ex.file.path);
  const hash = usesHashComments(ex.file.path);
  const side = ex.ref.side ?? "head";
  return (
    <figure class="excerpt">
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
      </figcaption>
      {ex.missing ? (
        <p class="excerpt__missing">The cited lines are not part of this diff. Check the tour against the current head.</p>
      ) : (
        <div class="excerpt__code scroll-x" tabIndex={0} role="region" aria-label={`${ex.file.path} ${rangeLabel(ex.ref)}`}>
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
                    <td class="diff__no tnum">{row.line.kind === "del" ? row.line.oldNo : row.line.newNo}</td>
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
