/**
 * A repo's code at a ref (default: its default branch, what has landed): a directory with its
 * entries and README (`/repos/:repoId/tree/<path>`), or one file (`/repos/:repoId/blob/<path>`).
 * Agents read the same through `list_repo_files` and `read_repo_file`.
 */
import { useLocation } from "preact-iso";
import { ApiError, api } from "../api/client.js";
import { type CodeTree, codeApi, rawUrl } from "../api/code.js";
import { CodeView } from "../components/CodeView.js";
import { Icon, type IconId } from "../components/Icon.js";
import { Markdown } from "../components/Markdown.js";
import { paletteRepos } from "../components/Palette.js";
import { RepoTabs } from "../components/RepoTabs.js";
import { Page } from "../components/Shell.js";
import { Command, EmptyState, ErrorState, LinkButton, Loading } from "../components/ui.js";
import {
  blobHref,
  commitHref,
  formatBytes,
  isImagePath,
  isMarkdownPath,
  parentPath,
  pathCrumbs,
  shortSha,
  treeHref,
} from "../lib/code.js";
import { cloneCommand } from "../lib/start.js";
import { shortAge } from "../lib/time.js";
import { minuteClock } from "../state/clock.js";
import { useResource } from "../state/resource.js";
import "../styles/tour.css";
import "../styles/code.css";

const KIND_ICON: Record<CodeTree["entries"][number]["kind"], IconId> = {
  dir: "folder",
  file: "file-text",
  symlink: "arrow-up-right",
  submodule: "package",
};

/** The repo's name for the title while the rest loads (the sidebar already knows it). */
export function useRepoName(repoId: string): string {
  const repo = useResource(() => api.repo(repoId), [repoId]);
  const st = repo.state.value;
  if (st.status === "ok") return st.data.repo.name;
  return paletteRepos.value.find((r) => r.id === repoId)?.name ?? "Repository";
}

/** "repo / src / lib / a.ts", each part a link but the last. */
export function PathBar({
  repoId,
  repoName,
  path,
  refName,
}: {
  repoId: string;
  repoName: string;
  path: string;
  refName?: string;
}) {
  const crumbs = pathCrumbs(path);
  return (
    <nav class="path-bar" aria-label="Path">
      <ol>
        <li>
          {crumbs.length === 0 ? (
            <span aria-current="page">{repoName}</span>
          ) : (
            <a href={treeHref(repoId, "", refName)}>{repoName}</a>
          )}
        </li>
        {crumbs.map((c, i) => (
          <li key={c.path}>
            {i === crumbs.length - 1 ? (
              <span aria-current="page">{c.name}</span>
            ) : (
              <a href={treeHref(repoId, c.path, refName)}>{c.name}</a>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** The latest commit at this ref: what you are looking at, and who landed it. */
function LastCommit({ repoId, refName }: { repoId: string; refName?: string }) {
  const res = useResource(
    () => codeApi.commits(repoId, { ref: refName, limit: 1 }),
    [repoId, refName],
  );
  const st = res.state.value;
  const c = st.status === "ok" ? st.data.commits[0] : undefined;
  if (!c) return null;
  const at = c.committer.at ?? c.author.at;
  return (
    <a class="last-commit" href={commitHref(repoId, c.sha)} data-testid="last-commit">
      <Icon name="git-commit" size={16} />
      <span class="last-commit__title">{c.title}</span>
      <span class="last-commit__meta">
        {c.landedBy ? c.landedBy.authorName : c.author.name}
        {at ? ` · ${shortAge(at, minuteClock.value)}` : ""}
      </span>
      <code class="last-commit__sha">{shortSha(c.sha)}</code>
    </a>
  );
}

function RefChip({ refName, fallback }: { refName: string | undefined; fallback: string }) {
  return (
    <span class="ref-chip" title="Branch, tag or commit">
      <Icon name="git-branch" size={15} />
      <span>{refName ?? fallback}</span>
    </span>
  );
}

function isEmptyRepo(error: unknown): boolean {
  return error instanceof ApiError && error.code === "empty-repo";
}

export function NothingLanded({ repoId }: { repoId: string }) {
  return (
    <EmptyState icon="code" title="Nothing has landed yet">
      <p>
        The code shows here once the first commit lands on the default branch. Push one from a
        clone, or tell your agent what to build: its Change lands through the merge queue.
      </p>
      <div class="code-empty__cmd">
        <Command text={cloneCommand(window.location.origin, repoId)} />
      </div>
    </EmptyState>
  );
}

/** `filePath`, not `path`: preact-iso passes every route its own `path` (the URL's). */
export function CodeTreeView({
  repoId,
  filePath: path = "",
}: {
  repoId: string;
  filePath?: string;
}) {
  const { query } = useLocation();
  const refName = query.ref || undefined;
  const repoName = useRepoName(repoId);
  const res = useResource(() => codeApi.tree(repoId, path, refName), [repoId, path, refName]);
  const st = res.state.value;
  const crumbs = [{ href: "/dashboard", label: "Dashboard" }];
  const title = path === "" ? repoName : (pathCrumbs(path).at(-1)?.name ?? repoName);

  return (
    <Page
      title={title}
      wide
      crumbs={path === "" ? crumbs : [...crumbs, { href: treeHref(repoId), label: repoName }]}
    >
      <RepoTabs repoId={repoId} current="code" />
      {st.status === "loading" ? <Loading label="Loading files" lines={8} /> : null}
      {st.status === "error" && isEmptyRepo(st.error) ? <NothingLanded repoId={repoId} /> : null}
      {st.status === "error" && !isEmptyRepo(st.error) ? (
        <ErrorState error={st.error} what="this directory" onRetry={res.reload} />
      ) : null}
      {st.status === "ok" ? (
        <>
          <div class="code-bar">
            <RefChip refName={refName} fallback={st.data.ref} />
            <PathBar repoId={repoId} repoName={repoName} path={path} refName={refName} />
          </div>
          <LastCommit repoId={repoId} refName={refName} />
          <ul class="tree-list" aria-label={`Files in ${path || repoName}`} data-testid="tree-list">
            {path !== "" ? (
              <li>
                <a class="tree-row" href={treeHref(repoId, parentPath(path), refName)}>
                  <Icon name="folder" size={18} class="tree-row__icon" />
                  <span class="tree-row__name">..</span>
                  <span class="sr-only">Up to the parent directory</span>
                </a>
              </li>
            ) : null}
            {st.data.entries.map((e) => (
              <li key={e.path}>
                <a
                  class={`tree-row tree-row--${e.kind}`}
                  href={
                    e.kind === "dir"
                      ? treeHref(repoId, e.path, refName)
                      : blobHref(repoId, e.path, refName)
                  }
                >
                  <Icon name={KIND_ICON[e.kind]} size={18} class="tree-row__icon" />
                  <span class="tree-row__name">{e.name}</span>
                  {e.kind === "submodule" || e.kind === "symlink" ? (
                    <span class="tree-row__kind">{e.kind}</span>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
          {st.data.readme?.text ? (
            <section class="readme" aria-labelledby="readme-title" data-testid="readme">
              <h2 id="readme-title" class="readme__title">
                <Icon name="file-text" size={16} />
                {st.data.readme.path.split("/").pop()}
              </h2>
              {isMarkdownPath(st.data.readme.path) ? (
                <Markdown source={st.data.readme.text} />
              ) : (
                <pre class="readme__plain">{st.data.readme.text}</pre>
              )}
            </section>
          ) : null}
        </>
      ) : null}
    </Page>
  );
}

/** `filePath`, not `path`: preact-iso passes every route its own `path` (the URL's). */
export function CodeFileView({
  repoId,
  filePath: path = "",
}: {
  repoId: string;
  filePath?: string;
}) {
  const { query } = useLocation();
  const refName = query.ref || undefined;
  const repoName = useRepoName(repoId);
  const res = useResource(() => codeApi.file(repoId, path, refName), [repoId, path, refName]);
  const st = res.state.value;
  const name = pathCrumbs(path).at(-1)?.name ?? path;
  const raw = rawUrl(repoId, path, refName);
  const parent = parentPath(path);

  return (
    <Page
      title={name}
      wide
      crumbs={[
        { href: "/dashboard", label: "Dashboard" },
        { href: treeHref(repoId, parent, refName), label: parent === "" ? repoName : parent },
      ]}
      actions={
        raw ? (
          <LinkButton href={raw} size="sm" icon="external-link" target="_blank" rel="noopener">
            Raw
          </LinkButton>
        ) : null
      }
    >
      <RepoTabs repoId={repoId} current="code" />
      {st.status === "loading" ? <Loading label="Loading the file" lines={12} /> : null}
      {st.status === "error" && isEmptyRepo(st.error) ? <NothingLanded repoId={repoId} /> : null}
      {st.status === "error" && !isEmptyRepo(st.error) ? (
        <ErrorState error={st.error} what="this file" onRetry={res.reload} />
      ) : null}
      {st.status === "ok" ? (
        <>
          <div class="code-bar">
            <RefChip refName={refName} fallback={st.data.ref} />
            <PathBar repoId={repoId} repoName={repoName} path={path} refName={refName} />
          </div>
          {st.data.file.kind === "text" && st.data.file.text !== null ? (
            <CodeView path={path} text={st.data.file.text} />
          ) : isImagePath(path) && raw ? (
            <figure class="file-image">
              <img src={raw} alt={name} />
              <figcaption class="tnum">{formatBytes(st.data.file.size)}</figcaption>
            </figure>
          ) : (
            <EmptyState
              icon="archive"
              title={st.data.file.kind === "binary" ? "A binary file" : "Too large to show here"}
              action={
                raw && st.data.file.size <= 10 * 1024 * 1024 ? (
                  <LinkButton
                    href={raw}
                    size="sm"
                    icon="external-link"
                    target="_blank"
                    rel="noopener"
                  >
                    Download
                  </LinkButton>
                ) : null
              }
            >
              <p>
                {formatBytes(st.data.file.size)}.{" "}
                {st.data.file.kind === "binary"
                  ? "Its bytes are not text, so there is nothing to read here."
                  : "Files over 512 KB are not shown in the browser; clone the repo to read it."}
              </p>
            </EmptyState>
          )}
          <p class="code-foot">
            At{" "}
            <a href={commitHref(repoId, st.data.commitSha)}>
              <code>{shortSha(st.data.commitSha)}</code>
            </a>
          </p>
        </>
      ) : null}
    </Page>
  );
}
