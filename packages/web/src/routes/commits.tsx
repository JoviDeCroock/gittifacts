/**
 * A repo's history (`/repos/:repoId/commits`): first-parent commits from a ref, newest first,
 * grouped by the day they landed, each naming the Change that landed it (and its lane); and one
 * commit (`/repos/:repoId/commits/:sha`) with its message and diff. Agents: `list_commits`,
 * `get_commit`.
 */
import type { CommitSummary } from "@app/domain";
import { useSignal } from "@preact/signals";
import { useLocation } from "preact-iso";
import { ApiError } from "../api/client.js";
import { codeApi } from "../api/code.js";
import { WholeDiff } from "../components/DiffExcerpt.js";
import { Icon } from "../components/Icon.js";
import { RepoTabs } from "../components/RepoTabs.js";
import { Page } from "../components/Shell.js";
import { Button, CopyButton, ErrorState, LaneTag, Loading, Who } from "../components/ui.js";
import {
  commitHref,
  commitsByDay,
  commitsHref,
  commitTime,
  dayLabel,
  shortSha,
  treeHref,
} from "../lib/code.js";
import { formatDateTime, shortAge } from "../lib/time.js";
import { plural } from "../lib/vocab.js";
import { minuteClock } from "../state/clock.js";
import { useResource } from "../state/resource.js";
import { NothingLanded, useRepoName } from "./code.js";
import "../styles/tour.css";
import "../styles/code.css";

/** Who a commit is by: the Change's author when one landed it (agent or person), else git's author. */
function CommitBy({ c }: { c: CommitSummary }) {
  if (c.landedBy)
    return <Who kind={c.landedBy.authorKind} name={c.landedBy.authorName} size={20} compact />;
  return <span class="commit-row__author">{c.author.name || "Unknown"}</span>;
}

function CommitRow({ repoId, c, now }: { repoId: string; c: CommitSummary; now: number }) {
  const at = commitTime(c);
  return (
    <li class="commit-row">
      <a class="commit-row__title" href={commitHref(repoId, c.sha)}>
        {c.title}
      </a>
      <span class="commit-row__meta">
        <CommitBy c={c} />
        {c.landedBy ? (
          <a
            class="commit-row__change"
            href={`/changes/${encodeURIComponent(c.landedBy.changeId)}`}
          >
            <LaneTag lane={c.landedBy.lane} size="sm" />
            <span>via its Change</span>
          </a>
        ) : null}
        {at ? (
          <time dateTime={at} title={formatDateTime(at)} class="tnum">
            {shortAge(at, now)}
          </time>
        ) : null}
      </span>
      <code class="commit-row__sha">{shortSha(c.sha)}</code>
    </li>
  );
}

export function CommitsView({ repoId }: { repoId: string }) {
  const { query } = useLocation();
  const refName = query.ref || undefined;
  const repoName = useRepoName(repoId);
  const more = useSignal<CommitSummary[]>([]);
  const next = useSignal<number | null | undefined>(undefined);
  const loading = useSignal(false);
  const moreError = useSignal<unknown>(null);
  const res = useResource(async () => {
    more.value = [];
    next.value = undefined;
    return codeApi.commits(repoId, { ref: refName });
  }, [repoId, refName]);
  const st = res.state.value;
  const now = minuteClock.value;

  async function loadMore(offset: number) {
    loading.value = true;
    moreError.value = null;
    try {
      const page = await codeApi.commits(repoId, { ref: refName, offset });
      more.value = [...more.value, ...page.commits];
      next.value = page.nextOffset;
    } catch (e) {
      moreError.value = e;
    } finally {
      loading.value = false;
    }
  }

  const commits = st.status === "ok" ? [...st.data.commits, ...more.value] : [];
  const nextOffset =
    next.value === undefined && st.status === "ok" ? st.data.nextOffset : (next.value ?? null);

  return (
    <Page title={repoName} wide crumbs={[{ href: "/dashboard", label: "Dashboard" }]}>
      <RepoTabs repoId={repoId} current="commits" />
      {st.status === "loading" ? <Loading label="Loading commits" lines={8} /> : null}
      {st.status === "error" ? (
        <ErrorState error={st.error} what="the history" onRetry={res.reload} />
      ) : null}
      {st.status === "ok" && st.data.headSha === null ? <NothingLanded repoId={repoId} /> : null}
      {st.status === "ok" && st.data.headSha !== null ? (
        <section aria-labelledby="commits-title" data-testid="commit-list">
          <h2 id="commits-title" class="code-section__title">
            Commits on <code>{st.data.ref}</code>
          </h2>
          {commitsByDay(commits).map((g) => (
            <section
              key={g.date ?? "unknown"}
              class="commit-day"
              aria-label={g.date ? dayLabel(g.date) : "Date unknown"}
            >
              <h3 class="commit-day__title">
                <Icon name="git-commit" size={16} />
                {g.date ? dayLabel(g.date) : "Date unknown"}
              </h3>
              <ul class="commit-list">
                {g.commits.map((c) => (
                  <CommitRow key={c.sha} repoId={repoId} c={c} now={now} />
                ))}
              </ul>
            </section>
          ))}
          {moreError.value ? <ErrorState error={moreError.value} what="older commits" /> : null}
          {nextOffset !== null ? (
            <div class="commit-more">
              <Button
                variant="secondary"
                size="sm"
                busy={loading.value}
                busyLabel="Loading…"
                onClick={() => loadMore(nextOffset)}
              >
                Load older commits
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}
    </Page>
  );
}

/** The message after its title line, if any. */
function messageBody(message: string): string {
  return message.trimStart().split("\n").slice(1).join("\n").trim();
}

export function CommitView({ repoId, sha }: { repoId: string; sha: string }) {
  const repoName = useRepoName(repoId);
  const res = useResource(() => codeApi.commit(repoId, sha), [repoId, sha]);
  const st = res.state.value;
  const crumbs = [
    { href: "/dashboard", label: "Dashboard" },
    { href: commitsHref(repoId), label: `${repoName} commits` },
  ];
  if (st.status !== "ok") {
    const missing =
      st.status === "error" && st.error instanceof ApiError && st.error.status === 404;
    return (
      <Page title={`Commit ${shortSha(sha)}`} wide crumbs={crumbs}>
        <RepoTabs repoId={repoId} current="commits" />
        {st.status === "loading" ? <Loading label="Loading the commit" lines={10} /> : null}
        {st.status === "error" ? (
          <ErrorState
            error={st.error}
            what={missing ? "this commit" : "the commit"}
            onRetry={res.reload}
          />
        ) : null}
      </Page>
    );
  }
  const { commit: c, diff } = st.data;
  const body = messageBody(c.message);
  const at = commitTime(c);
  const files = diff.files.length;
  return (
    <Page
      title={c.title}
      wide
      crumbs={crumbs}
      meta={
        <>
          <span>
            {c.author.name || "Unknown"}
            {c.committer.name && c.committer.name !== c.author.name
              ? `, committed by ${c.committer.name}`
              : ""}
          </span>
          {at ? (
            <span>
              <time dateTime={at}>{formatDateTime(at)}</time>
            </span>
          ) : null}
          <span class="commit-sha">
            <code title={c.sha}>{shortSha(c.sha)}</code>
            <CopyButton text={c.sha} label="Copy sha" />
          </span>
        </>
      }
      actions={
        <a class="btn btn--secondary btn--sm" href={treeHref(repoId, "", c.sha)}>
          <Icon name="code" />
          <span>Browse files</span>
        </a>
      }
    >
      <RepoTabs repoId={repoId} current="commits" />
      {c.landedBy ? (
        <a
          class="landed-by"
          href={`/changes/${encodeURIComponent(c.landedBy.changeId)}`}
          data-testid="landed-by"
        >
          <LaneTag lane={c.landedBy.lane} size="md" label="name" />
          <span class="landed-by__text">
            Landed by the Change <b>{c.landedBy.title}</b>
          </span>
          <Who kind={c.landedBy.authorKind} name={c.landedBy.authorName} size={20} compact />
          <Icon name="chevron-right" size={16} />
        </a>
      ) : (
        <p class="landed-by landed-by--none">
          No Change landed this commit: it was pushed or imported directly, without a plan, evidence
          or a review on the platform.
        </p>
      )}
      {body ? <pre class="commit-message">{body}</pre> : null}
      <p class="commit-parents">
        {c.parents.length === 0
          ? "The first commit: compared with an empty repository."
          : c.parents.map((p, i) => (
              <span key={p}>
                {i === 0 ? "Parent " : ", "}
                <a href={commitHref(repoId, p)}>
                  <code>{shortSha(p)}</code>
                </a>
              </span>
            ))}
      </p>
      <section aria-labelledby="diff-title" data-testid="commit-diff">
        <h2 id="diff-title" class="code-section__title tnum">
          {plural(files, "file")} changed{" "}
          <span class="diffstat diffstat--add">+{diff.additions}</span>{" "}
          <span class="diffstat diffstat--del">−{diff.deletions}</span>
        </h2>
        {diff.complete ? null : (
          <p class="code-note" role="note">
            This commit changes more files than a commit page reads. Files past the first 300 are
            listed without their lines, and the totals count only the files read.
          </p>
        )}
        <WholeDiff
          diff={{
            baseSha: diff.parentSha ?? "0".repeat(40),
            headSha: c.sha,
            files: diff.files,
            additions: diff.additions,
            deletions: diff.deletions,
          }}
        />
      </section>
    </Page>
  );
}
