/**
 * The merge queue's resolution of a Change: what lands instead of the head the agent pushed.
 * Journey 06: a person re-approving saw only the agent's tour and diff; the resolved line was
 * nowhere. Here every conflict region shows what main had, what the Change had, and what lands,
 * with each landed line tagged by where it came from and the resolver's own lines marked.
 */
import type { ResolutionView } from "../api/resolution.js";
import {
  type LandedLine,
  type LineOrigin,
  parseResolution,
  type ResolvedFile,
  resolverLineCount,
} from "../lib/resolution.js";
import { plural, shortSha } from "../lib/vocab.js";
import { Icon } from "./Icon.js";
import "../styles/resolution.css";

const ORIGIN: Record<LineOrigin, string> = {
  upstream: "main",
  change: "change",
  both: "both",
  base: "base",
  resolver: "resolver",
};

function Lines({ lines, empty }: { lines: string[]; empty: string }) {
  if (lines.length === 0) return <p class="res-lines res-lines--empty">{empty}</p>;
  return (
    <pre class="res-lines">
      {lines.map((l, i) => (
        <span key={i} class="res-line">
          {l === "" ? " " : l}
        </span>
      ))}
    </pre>
  );
}

function Landed({ lines, hidden }: { lines: LandedLine[]; hidden: number }) {
  if (lines.length === 0)
    return <p class="res-lines res-lines--empty">Nothing: the region was removed.</p>;
  return (
    <ol class="res-lines res-landed">
      {lines.map((l, i) => (
        <li key={i} class={`res-line res-line--${l.origin}`}>
          <span class="res-tag">
            {l.origin === "resolver" ? <Icon name="bot" size={13} /> : null}
            {ORIGIN[l.origin]}
          </span>
          <code class="res-text">{l.text === "" ? " " : l.text}</code>
        </li>
      ))}
      {hidden > 0 ? (
        <li class="res-line res-line--hidden">{plural(hidden, "unchanged line")} not shown</li>
      ) : null}
    </ol>
  );
}

function FileRegions({ f, upstreamName }: { f: ResolvedFile; upstreamName: string }) {
  return (
    <div class="res-file">
      {f.regions.map((r, i) => (
        <div key={i} class="res-region">
          <h3 class="res-region__title">
            <code>{f.path}</code>
            {f.regions.length > 1 ? (
              <span class="res-dim">
                {" "}
                · conflict {i + 1} of {f.regions.length}
              </span>
            ) : null}
          </h3>
          <div class="res-sides">
            <div class="res-side">
              <p class="res-label">Main had ({upstreamName})</p>
              <Lines lines={r.upstream} empty="Nothing (main removed it)" />
            </div>
            <div class="res-side">
              <p class="res-label">This change had</p>
              <Lines lines={r.change} empty="Nothing (the change removed it)" />
            </div>
          </div>
          <div class="res-lands">
            <p class="res-label res-label--lands">Lands on main</p>
            <Landed lines={r.lands} hidden={r.hidden} />
          </div>
          {r.base !== null ? (
            <details class="disclosure res-base">
              <summary>
                Common base before both{" "}
                <Icon name="chevron-down" size={16} class="disclosure__chev" />
              </summary>
              <Lines lines={r.base} empty="Nothing" />
            </details>
          ) : null}
        </div>
      ))}
      {f.outside.length > 0 ? (
        <div class="res-outside" role="note">
          <p class="res-outside__title">
            <Icon name="triangle-alert" size={16} /> Edited outside the conflict in{" "}
            <code>{f.path}</code>: no one approved these lines
          </p>
          <ol class="res-lines">
            {f.outside.map((o, i) => (
              <li key={i} class={`res-line res-line--${o.kind}`}>
                <span class="res-tag">{o.kind === "add" ? "added" : "removed"}</span>
                <code class="res-text">{o.text === "" ? " " : o.text}</code>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

export function ResolutionPanel({ r, awaiting }: { r: ResolutionView; awaiting: boolean }) {
  const item = r.item;
  const files = item ? parseResolution(item.resolutionDiff) : [];
  const written = files.length > 0 ? resolverLineCount(files) : (item?.novelLines ?? 0);
  const outside = item?.touchesOutsideConflictHunks ?? false;
  const upstream = r.upstream[0];
  const upstreamName = r.upstream.length === 1 && upstream ? upstream.changeId : "upstream";
  const ask = awaiting && r.approvalRequested;
  return (
    <section
      class={`resolution ${ask ? "resolution--ask" : ""}`}
      aria-labelledby="resolution-title"
    >
      <h2 id="resolution-title" class="resolution__title">
        <Icon name="git-merge" size={20} />
        {ask
          ? "Approve the resolution, not only the diff"
          : "The merge queue resolved a conflict in this change"}
      </h2>
      <p class="resolution__lede">
        What lands is the resolver agent's version (head <code>{shortSha(r.headSha)}</code>), not
        the head the agent pushed (<code>{shortSha(r.originalHeadSha)}</code>)
        {r.approvalRequested ? ", so the earlier approval no longer covers it" : ""}. It resolved a{" "}
        {r.kind} conflict with{" "}
        {r.upstream.length === 0
          ? "upstream changes"
          : r.upstream.map((u, i) => (
              <span key={u.changeId}>
                {i > 0 ? ", " : null}
                <a href={`/changes/${u.changeId}`}>{u.title ?? u.changeId}</a>
              </span>
            ))}
        .
      </p>
      <ul class="resolution__facts">
        <li class={written > 0 ? "tone--warn" : "tone--ok"}>
          <Icon name={written > 0 ? "bot" : "check"} size={16} />
          {written > 0
            ? `${plural(written, "line")} written by the resolver (found on neither side)`
            : "Every landed line comes from one of the sides"}
        </li>
        <li class={outside ? "tone--danger" : "tone--ok"}>
          <Icon name={outside ? "triangle-alert" : "check"} size={16} />
          {outside ? "Edits outside the conflict hunks" : "Only the conflict hunks changed"}
        </li>
      </ul>
      {item === null ? (
        <p class="res-dim">
          The resolution's evidence could not be read, so its lines can't be shown. Treat it as
          unreviewed.
        </p>
      ) : files.length === 0 ? (
        <p class="res-dim">
          The resolution has no line diff to show (it changed no text, or the diff could not be
          read).
        </p>
      ) : (
        files.map((f) => <FileRegions key={f.path} f={f} upstreamName={upstreamName} />)
      )}
      {item?.truncated ? (
        <p class="res-dim">The resolution diff was cut at 64 KB; the rest is in the evidence.</p>
      ) : null}
      {item && item.rationale.trim() !== "" ? (
        <blockquote class="resolution__why">
          <p>{item.rationale}</p>
          <footer>
            The resolver's own explanation ({item.resolver.model}). It is model text: it can only
            raise risk.
          </footer>
        </blockquote>
      ) : null}
    </section>
  );
}
