import type { LaneReason, RepoPolicy } from "@app/domain";
import type { EvidenceItem } from "@app/evidence";
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { api } from "../api/client.js";
import type { Change, EvidenceResponse, RepoDetail } from "../api/types.js";
import { RedGreenList, ShotPair, kindIcon } from "../components/EvidenceBits.js";
import { Icon } from "../components/Icon.js";
import { Page } from "../components/Shell.js";
import { Command, CopyButton, ErrorState, Hash, Loading, Meter } from "../components/ui.js";
import { compressLines } from "../lib/diff.js";
import { itemAnchor, itemTitle, summarize, unmeasuredEffect, verifyCommand } from "../lib/evidence.js";
import { gitNoteLine } from "../lib/evidence-note.js";
import { pct } from "../lib/lanes.js";
import { durationLabel, formatDateTime } from "../lib/time.js";
import { num, plural, shortSha } from "../lib/vocab.js";
import { useResource } from "../state/resource.js";
import "../styles/evidence.css";

type Item<K extends EvidenceItem["kind"]> = Extract<EvidenceItem, { kind: K }>;

function Attestation({ ev, change }: { ev: EvidenceResponse; change: Change }) {
  const raw = useSignal(false);
  const a = ev.evidence.attestation;
  const ok = ev.verification.ok;
  const payload = JSON.stringify({ changeId: ev.evidence.changeId, headSha: ev.evidence.headSha, items: ev.evidence.items }, null, 2);
  const headMatches = ev.evidence.headSha === change.headSha;
  const note = gitNoteLine(ev.evidence, change);
  return (
    <section class={`attest ${ok ? "attest--ok" : "attest--bad"}`} aria-labelledby="attest-title">
      <div class="attest__head">
        <Icon name={ok ? "shield-check" : "shield-alert"} size={26} />
        <div>
          <h2 id="attest-title" class="attest__title">
            {ok ? "Signed and verified" : "Signature does not verify"}
          </h2>
          <p class="attest__line">
            {ok
              ? `Every item below is covered by one Ed25519 signature from ${a.signer}, checked against the platform's published key.`
              : `${ev.verification.reason ?? "The signature did not match."} The classifier treats every item as unknown, which escalates the lane.`}
          </p>
        </div>
      </div>
      <dl class="attest__facts">
        <dt>Key</dt>
        <dd>
          <Hash value={a.keyId} full /> <span class="attest__alg">{a.alg}</span>
        </dd>
        <dt>Signed</dt>
        <dd class="tnum">{formatDateTime(a.signedAt)}</dd>
        <dt>Head</dt>
        <dd>
          <Hash value={ev.evidence.headSha} head={12} tail={0} />
          {headMatches ? null : <span class="tone--warn"> · older than the change's current head {shortSha(change.headSha)}</span>}
        </dd>
        <dt>Digest</dt>
        <dd>
          <Hash value={a.payloadDigest} head={14} tail={6} />
        </dd>
        <dt>Git note</dt>
        <dd class={note.tone === "warn" ? "tone--warn" : undefined}>
          {note.text}
          {note.tone === "warn" ? (
            <>
              {" "}
              <a href={`/audit?subject=${encodeURIComponent(`change:${change.id}`)}`}>Audit log</a>
            </>
          ) : null}
        </dd>
      </dl>
      <div class="attest__actions">
        <button type="button" class="btn btn--quiet btn--sm" aria-expanded={raw.value} onClick={() => (raw.value = !raw.value)}>
          <Icon name="file-code" />
          <span>{raw.value ? "Hide signed payload" : "View signed payload"}</span>
        </button>
        {raw.value ? <CopyButton text={payload} label="Copy JSON" /> : null}
      </div>
      {raw.value ? (
        <pre class="attest__raw scroll-x" tabIndex={0}>
          {payload}
        </pre>
      ) : null}
      <div class="attest__verify">
        <p>Verify it outside the platform, from a clone of the repository:</p>
        <Command text={verifyCommand(ev.evidence.headSha, window.location.origin)} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- per-kind bodies

function TestRunBody({ item }: { item: Item<"test-run"> }) {
  return (
    <>
      <p class="ev-stats tnum">
        <span>
          <b class="tone--ok">{num.format(item.passed)}</b> passed
        </span>
        <span>
          <b class={item.failed ? "tone--danger" : ""}>{num.format(item.failed)}</b> failed
        </span>
        <span>
          <b>{num.format(item.skipped)}</b> skipped
        </span>
        <span>{durationLabel(item.durationMs)}</span>
        <span>
          {item.runner} on <code>{shortSha(item.sha)}</code>
        </span>
      </p>
      {item.failures.length > 0 ? (
        <ul class="failures">
          {item.failures.map((f) => (
            <li key={f.name}>
              <b>{f.name}</b>
              <pre class="scroll-x">{f.message}</pre>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function CoverageBody({ item, policy }: { item: Item<"coverage">; policy: RepoPolicy }) {
  const t = policy.thresholds.changedLineCoverage;
  return (
    <>
      <div class="ev-measure">
        <p>
          <b class="ev-big tnum">{pct(item.ratio)}</b> of changed lines covered ({item.coveredChangedLines} of {item.changedLines})
        </p>
        <Meter value={item.ratio} threshold={t} thresholdLabel={`Lane 0 needs ${pct(t)}`} tone={item.ratio >= t ? "ok" : "warn"} label={`Coverage ${pct(item.ratio)}, policy ${pct(t)}`} />
      </div>
      <table class="ev-table">
        <thead>
          <tr>
            <th scope="col">File</th>
            <th scope="col">Covered</th>
            <th scope="col">Uncovered lines</th>
          </tr>
        </thead>
        <tbody>
          {item.files.map((f) => (
            <tr key={f.path}>
              <th scope="row">
                <code>{f.path}</code>
              </th>
              <td class="tnum">
                {f.covered}/{f.changed}
              </td>
              <td>
                {f.uncoveredLines.length === 0 ? (
                  <span class="tone--ok">none</span>
                ) : (
                  <span class="lines">
                    {compressLines(f.uncoveredLines).map((r) => (
                      <code key={r}>L{r}</code>
                    ))}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {item.unmeasuredFiles && item.unmeasuredFiles.length > 0 ? (
        <p class="ev-warn">
          <Icon name="triangle-alert" size={15} /> Not in the coverage report at all, probably never loaded by a test: {item.unmeasuredFiles.join(", ")}
        </p>
      ) : null}
    </>
  );
}

function MutationBody({ item, policy }: { item: Item<"mutation">; policy: RepoPolicy }) {
  const t = policy.thresholds.mutationScore;
  return (
    <>
      <div class="ev-measure">
        <p>
          <b class="ev-big tnum">{pct(item.score)}</b> mutation score on changed lines ({item.tool})
        </p>
        <Meter value={item.score} threshold={t} thresholdLabel={`Lane 0 needs ${pct(t)}`} tone={item.score >= t ? "ok" : "warn"} label={`Mutation score ${pct(item.score)}, policy ${pct(t)}`} />
      </div>
      <p class="ev-stats tnum">
        <span>
          <b>{item.killed}</b> killed
        </span>
        <span>
          <b class={item.survived ? "tone--warn" : ""}>{item.survived}</b> survived
        </span>
        <span>
          <b>{item.timedOut}</b> timed out
        </span>
        <span>
          <b class={item.noCoverage ? "tone--warn" : ""}>{item.noCoverage}</b> not covered
        </span>
      </p>
      {item.survivors.length > 0 ? (
        <table class="ev-table">
          <caption>Mutants that no test caught</caption>
          <thead>
            <tr>
              <th scope="col">Where</th>
              <th scope="col">Mutation</th>
            </tr>
          </thead>
          <tbody>
            {item.survivors.map((s) => (
              <tr key={`${s.file}:${s.line}:${s.mutator}`}>
                <th scope="row">
                  <code>
                    {s.file}:{s.line}
                  </code>
                </th>
                <td>
                  <span class="ev-sub">{s.mutator}</span>
                  {s.replacement ? <code class="ev-code">{s.replacement}</code> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}

function ApiBody({ item }: { item: Item<"public-api"> }) {
  if (item.packages.length === 0) return <p class="ev-sub">No exported symbol changed in any public entry point.</p>;
  return (
    <>
      {item.packages.map((p) => (
        <div key={p.name} class="api-pkg">
          <p class="api-pkg__name">
            <code>{p.name}</code> <span class="ev-sub">from {p.entry}</span>
          </p>
          {(
            [
              ["removed", "Removed", p.removed, "minus"],
              ["changed", "Changed", p.changed, "undo"],
              ["added", "Added", p.added, "plus"],
            ] as const
          ).map(([key, label, list, icon]) =>
            list.length > 0 ? (
              <div key={key} class={`api-group api-group--${key}`}>
                <h3 class="api-group__title">
                  <Icon name={icon} size={15} /> {label} <span class="tnum">{list.length}</span>
                </h3>
                <ul class="api-list">
                  {list.map((s) => (
                    <li key={s.symbol}>
                      <code class="api-list__sym">{s.symbol}</code>
                      {s.before ? (
                        <pre class="api-sig api-sig--before scroll-x">
                          <span class="api-sig__mark" aria-label="before">
                            −
                          </span>
                          {s.before}
                        </pre>
                      ) : null}
                      {s.after ? (
                        <pre class="api-sig api-sig--after scroll-x">
                          <span class="api-sig__mark" aria-label="after">
                            +
                          </span>
                          {s.after}
                        </pre>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </div>
      ))}
    </>
  );
}

function DepsBody({ item }: { item: Item<"dependencies"> }) {
  const none = item.added.length + item.removed.length + item.changed.length === 0;
  return (
    <>
      {item.newInstallScripts.length > 0 ? (
        <div class="ev-danger">
          <p class="ev-danger__title">
            <Icon name="triangle-alert" size={16} /> {plural(item.newInstallScripts.length, "new install script")} will run on every install
          </p>
          <ul>
            {item.newInstallScripts.map((s) => (
              <li key={`${s.name}:${s.script}`}>
                <b>{s.name}</b> <span class="ev-sub">{s.script}</span>
                <pre class="scroll-x">{s.command}</pre>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {none ? <p class="ev-sub">No dependency was added, removed or changed.</p> : null}
      {item.added.length + item.removed.length + item.changed.length > 0 ? (
        <table class="ev-table">
          <thead>
            <tr>
              <th scope="col">Package</th>
              <th scope="col">Change</th>
              <th scope="col">Kind</th>
            </tr>
          </thead>
          <tbody>
            {item.added.map((d) => (
              <tr key={`a${d.name}`}>
                <th scope="row">
                  <code>{d.name}</code>
                </th>
                <td>
                  <span class="tone--warn">added</span> <code>{d.version}</code>
                </td>
                <td class="ev-sub">{d.dev ? "dev" : "runtime"}</td>
              </tr>
            ))}
            {item.changed.map((d) => (
              <tr key={`c${d.name}`}>
                <th scope="row">
                  <code>{d.name}</code>
                </th>
                <td>
                  <code>{d.from}</code> → <code>{d.to}</code> <span class="ev-sub">{d.bump}</span>
                </td>
                <td class="ev-sub">{d.dev ? "dev" : "runtime"}</td>
              </tr>
            ))}
            {item.removed.map((d) => (
              <tr key={`r${d.name}`}>
                <th scope="row">
                  <code>{d.name}</code>
                </th>
                <td>
                  <span class="ev-sub">removed</span> <code>{d.version}</code>
                </td>
                <td class="ev-sub">{d.dev ? "dev" : "runtime"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p class="ev-sub">Lockfile {item.lockfileChanged ? "changed" : "unchanged"}.</p>
    </>
  );
}

function ItemBody({ item, policy }: { item: EvidenceItem; policy: RepoPolicy }) {
  switch (item.kind) {
    case "red-green":
      return (
        <>
          <p class="ev-sub">
            {item.verdict === "proven"
              ? "Each new or changed test failed on main and passes on this change."
              : item.verdict === "no-tests"
                ? "No new or changed tests, so nothing proves the change does what it claims."
                : "Tests exist, but they do not fail on main and pass here."}
          </p>
          <RedGreenList item={item} />
        </>
      );
    case "test-run":
      return <TestRunBody item={item} />;
    case "coverage":
      return <CoverageBody item={item} policy={policy} />;
    case "mutation":
      return <MutationBody item={item} policy={policy} />;
    case "public-api":
      return <ApiBody item={item} />;
    case "dependencies":
      return <DepsBody item={item} />;
    case "sensitive-paths":
      return item.hits.length === 0 ? (
        <p class="ev-sub">No changed file matches the repo's {plural(item.patterns.length, "sensitive pattern")}.</p>
      ) : (
        <>
          <ul class="hits">
            {item.hits.map((h) => (
              <li key={h.path}>
                <Icon name="lock" size={15} />
                <code>{h.path}</code>
                <span class="ev-sub">matches {h.pattern}</span>
              </li>
            ))}
          </ul>
          <p class="ev-sub">Sensitive paths always force at least Lane 2.</p>
        </>
      );
    case "preview":
      return item.url ? (
        <p>
          <a href={item.url} target="_blank" rel="noreferrer" class="ev-link">
            {item.url} <Icon name="external-link" size={14} />
          </a>
          {item.versionId ? <span class="ev-sub"> · version {item.versionId}</span> : null}
        </p>
      ) : (
        <p class="ev-sub">No preview URL.</p>
      );
    case "screenshots":
      return item.shots.length === 0 ? (
        <p class="ev-sub">No routes captured.</p>
      ) : (
        <div class="ev-shots">
          {item.shots.map((s) => (
            <ShotPair key={`${s.route}:${s.viewport}`} shot={s} />
          ))}
        </div>
      );
    case "agent-trace":
      return (
        <p>
          {item.provider} trace <code>{item.traceId}</code>
          {item.url ? (
            <>
              {" · "}
              <a href={item.url} target="_blank" rel="noreferrer" class="ev-link">
                Open trace <Icon name="external-link" size={14} />
              </a>
            </>
          ) : null}
        </p>
      );
    case "transform":
      return (
        <>
          <dl class="kv">
            <dt>Transform</dt>
            <dd>
              <code>{item.transform}</code>
            </dd>
            <dt>Command</dt>
            <dd>
              <code>{item.command}</code>
            </dd>
            <dt>Result</dt>
            <dd class={item.verified ? "tone--ok" : "tone--danger"}>
              {item.verified ? `Reproduced all ${item.files.length} files byte for byte in a clean sandbox` : `${item.mismatchedFiles.length} files did not reproduce`}
            </dd>
          </dl>
          <details class="disclosure">
            <summary>
              {plural(item.files.length, "file")} <Icon name="chevron-down" class="disclosure__chev" />
            </summary>
            <ul class="file-list">
              {item.files.map((f) => (
                <li key={f} class={item.mismatchedFiles.includes(f) ? "tone--danger" : ""}>
                  <code>{f}</code>
                </li>
              ))}
            </ul>
          </details>
        </>
      );
    case "llm-judgment":
      return (
        <>
          <p class="ev-prose">{item.rationale}</p>
          <p class="ev-sub">
            {item.model}. Model judgments can only raise a lane, never lower it.
          </p>
        </>
      );
    case "conflict-resolution":
      return (
        <>
          <p class="ev-prose">{item.rationale}</p>
          <p class="ev-sub">
            Resolved by {item.resolver.principalId} ({item.resolver.model}) against {item.upstreamChanges.map((u) => u.changeId).join(", ") || "no upstream change"}.
            {item.semanticConflictWith !== null ? ` Semantic conflict caused by ${item.semanticConflictWith}.` : ""}
            {item.touchesOutsideConflictHunks ? " Edits lines outside the conflict hunks." : " Only edits lines inside the conflict hunks."}
          </p>
        </>
      );
    case "quarantine":
      return (
        <p class="ev-sub">
          {plural(item.tests.length, "quarantined test")}; {item.inAffectedSet.length} in this change's affected set. Quarantined tests never count as passing.
        </p>
      );
  }
}

function ItemSection({ item, policy, reasons }: { item: EvidenceItem; policy: RepoPolicy; reasons: readonly LaneReason[] }) {
  const s = summarize(item);
  return (
    <section class="ev-item" id={itemAnchor(item.id)} aria-labelledby={`${itemAnchor(item.id)}-t`} tabIndex={-1}>
      <header class="ev-item__head">
        <Icon name={kindIcon(item.kind)} size={20} />
        <h2 class="ev-item__title" id={`${itemAnchor(item.id)}-t`}>
          {itemTitle(item)}
        </h2>
        <span class={`ev-item__value tone--${s.tone}`}>{s.value}</span>
      </header>
      {item.status !== "ok" ? (
        <p class={`ev-status ev-status--${item.status}`}>
          <Icon name={item.status === "error" ? "x-circle" : "circle-dashed"} size={15} />
          {item.status === "error" ? "Measurement failed" : "Not measured"}
          {item.note ? `: ${item.note.replace(/\.$/, "")}.` : "."} {unmeasuredEffect(item.id, reasons)}
        </p>
      ) : (
        <div class="ev-item__body">
          <ItemBody item={item} policy={policy} />
        </div>
      )}
      <p class="ev-item__id">
        id <code>{item.id}</code>
        {item.logRef ? (
          <>
            {" "}
            · log <code>{item.logRef}</code>
          </>
        ) : null}
      </p>
    </section>
  );
}

export function EvidenceView({ changeId }: { changeId: string }) {
  const res = useResource(async () => {
    const detail = await api.change(changeId);
    const [ev, repo] = await Promise.all([api.evidence(changeId), api.repo(detail.change.repoId)]);
    return { change: detail.change, ev, repo: repo as RepoDetail };
  }, [changeId]);
  const st = res.state.value;

  useEffect(() => {
    if (st.status !== "ok" || !window.location.hash) return;
    const el = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
    if (el) {
      el.scrollIntoView({ block: "start" });
      el.focus({ preventScroll: true });
    }
  }, [st.status]);

  const crumbs = [{ href: "/", label: "Repositories" }];
  if (st.status === "loading") {
    return (
      <Page title="Evidence" crumbs={crumbs}>
        <Loading label="Loading evidence" lines={8} />
      </Page>
    );
  }
  if (st.status === "error") {
    return (
      <Page title="Evidence" crumbs={[...crumbs, { href: `/changes/${changeId}`, label: "Change" }]}>
        <ErrorState error={st.error} what="the evidence for this change" onRetry={res.reload} />
      </Page>
    );
  }
  const { change, ev, repo } = st.data;
  const items = ev.evidence.items;
  return (
    <Page
      title="Evidence"
      wide
      class="evidence-page"
      crumbs={[...crumbs, { href: `/repos/${repo.repo.id}`, label: repo.repo.name }, { href: `/changes/${change.id}`, label: change.title }]}
      meta={<span>{change.title}</span>}
    >
      <div class="ev-layout">
        <nav class="ev-index" aria-label="Evidence items">
          <ul>
            {items.map((i) => {
              const s = summarize(i);
              return (
                <li key={i.id}>
                  <a href={`#${itemAnchor(i.id)}`}>
                    <Icon name={kindIcon(i.kind)} size={15} />
                    <span class="ev-index__label">{s.label}</span>
                    <span class={`ev-index__value tone--${s.tone}`}>{s.value}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
        <div class="ev-main">
          <Attestation ev={ev} change={change} />
          {items.map((i) => (
            <ItemSection key={i.id} item={i} policy={repo.repo.policy} reasons={change.laneReasons} />
          ))}
        </div>
      </div>
    </Page>
  );
}
