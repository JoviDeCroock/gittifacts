/**
 * /settings/github — GitHub mode: the platform's GitHub App (registered by hand, read from Worker
 * config), its install link, and the installations you linked with their repos.
 */
import { useSignal } from "@preact/signals";
import { useLocation } from "preact-iso";
import { inlineError } from "../api/client.js";
import { FLOW_ERRORS, type GithubApp, type GithubInstallation, githubApi } from "../api/github.js";
import { Icon } from "../components/Icon.js";
import { Page } from "../components/Shell.js";
import { EmptyState, ErrorState, LinkButton, Loading } from "../components/ui.js";
import { relative } from "../lib/time.js";
import { minuteClock } from "../state/clock.js";
import { useResource } from "../state/resource.js";
import "../styles/integrations.css";
import "../styles/github.css";

function AppRow({ app }: { app: GithubApp }) {
  return (
    <div class="gh-app">
      <div class="gh-app__main">
        <h3 class="inst__name">{app.slug}</h3>
        <p class="inst__by">
          <a href={app.htmlUrl} target="_blank" rel="noopener noreferrer">
            github.com/apps/{app.slug}
          </a>
        </p>
        <p class="gh-shadow">
          <Icon name="eye" size={16} />
          <span>
            Report-only: one <code>gittifacts/lane</code> check run per pull request head, and for a
            linked installation the walkthrough as one review plus a summary comment. It never
            blocks, approves or merges.
          </span>
        </p>
      </div>
      <LinkButton href={app.installUrl} variant="primary" size="sm" icon="external-link">
        Install on GitHub
      </LinkButton>
    </div>
  );
}

/** A repo of an installation; once graded, its PR-writes switch (owners). */
function RepoLine({ repo }: { repo: GithubInstallation["repos"][number] }) {
  const on = useSignal(repo.prWrites === "on");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const repoId = repo.repoId;
  async function toggle() {
    if (repoId === null || busy.value) return;
    busy.value = true;
    error.value = null;
    try {
      const out = await githubApi.setPrWrites(repoId, on.value ? "off" : "on");
      on.value = out.prWrites === "on";
    } catch (err) {
      error.value = inlineError(err);
    } finally {
      busy.value = false;
    }
  }
  return (
    <li class="gh-repo">
      <span class="gh-repo__name">
        <Icon name={repo.private ? "lock" : "git-branch"} size={14} />
        {repoId !== null ? (
          <a href={`/repos/${repoId}`} class="mono">
            {repo.fullName}
          </a>
        ) : (
          <a
            href={`https://github.com/${repo.fullName}`}
            target="_blank"
            rel="noopener noreferrer"
            class="mono"
          >
            {repo.fullName}
          </a>
        )}
      </span>
      {repoId !== null ? (
        <label class="gh-repo__switch">
          <input
            type="checkbox"
            role="switch"
            aria-checked={on.value}
            checked={on.value}
            disabled={busy.value}
            onChange={toggle}
          />
          <span>
            Walkthrough review and summary on PRs
            {/* Every row has this switch: its name says which repository it is for. */}
            <span class="sr-only"> for {repo.fullName}</span>
          </span>
        </label>
      ) : (
        <span class="gh-repo__wait">graded from its next pull request</span>
      )}
      {error.value ? (
        <p class="field__error" role="alert">
          {error.value}
        </p>
      ) : null}
    </li>
  );
}

function InstallationItem({ inst }: { inst: GithubInstallation }) {
  const now = minuteClock.value;
  return (
    <li class="inst gh-inst">
      <div class="inst__main">
        <h3 class="inst__name">{inst.account.login}</h3>
        <p class="inst__by">
          {inst.account.type === "Organization" ? "Organization" : "Personal account"} · linked{" "}
          {relative(inst.linkedAt, now)} as {inst.linkedAs}
          {inst.suspended ? " · suspended on GitHub" : ""}
        </p>
        <p class="inst__repos">
          <Icon name="layers" size={16} />
          <span>
            {inst.repositorySelection === "all" ? "All repositories" : "Selected repositories"} ·{" "}
            <span class="tnum">{inst.repos.length}</span>
          </span>
        </p>
        {inst.repos.length > 0 ? (
          <ul class="gh-repos">
            {inst.repos.map((r) => (
              <RepoLine key={r.id} repo={r} />
            ))}
          </ul>
        ) : null}
      </div>
      <div class="inst__actions">
        <LinkButton
          href={inst.manageUrl}
          variant="secondary"
          size="sm"
          target="_blank"
          rel="noopener noreferrer"
        >
          Manage on GitHub
        </LinkButton>
      </div>
    </li>
  );
}

function Notice() {
  const { query } = useLocation();
  if (query.error) {
    return (
      <p class="int-notice gh-notice--error" role="alert">
        <Icon name="triangle-alert" size={16} /> {FLOW_ERRORS[query.error] ?? FLOW_ERRORS.internal}
      </p>
    );
  }
  const msg = query.linked
    ? "Installation linked. Its pull requests are graded, report-only, from now on."
    : query.requested
      ? "GitHub sent your install request to the organization's owners. It shows up here once they approve and link it."
      : null;
  return msg ? (
    <p class="int-notice" role="status">
      <Icon name="check-circle" size={16} /> {msg}
    </p>
  ) : null;
}

export function GithubSettings() {
  const res = useResource(() => githubApi.overview(), []);
  const st = res.state.value;
  const reader = st.status === "ok" ? st.data.app : null;
  return (
    <Page
      title="GitHub"
      meta={
        <span>
          Grade pull requests where your code already lives. Nothing moves; report-only mode never
          blocks, approves or merges.
        </span>
      }
    >
      <Notice />
      {st.status === "loading" ? <Loading label="Loading GitHub setup" lines={6} /> : null}
      {st.status === "error" ? (
        <ErrorState error={st.error} what="the GitHub setup" onRetry={res.reload} />
      ) : null}
      {st.status === "ok" ? (
        <>
          {reader ? (
            <section aria-label="The GitHub App">
              <h2 class="int-section__title">The GitHub App</h2>
              <AppRow app={reader} />
            </section>
          ) : (
            <EmptyState icon="plug" title="GitHub mode isn't set up on this platform">
              <p>
                Whoever runs this platform registers its GitHub App once and sets the App's values
                in the Worker's config (<a href="/docs/guides/github-mode">how</a>). Still missing:
              </p>
              <ul class="gh-missing">
                {st.data.missing.map((n) => (
                  <li key={n}>
                    <code>{n}</code>
                  </li>
                ))}
              </ul>
            </EmptyState>
          )}
          <h2 class="int-section__title">
            Your installations <span class="tnum int-n">{st.data.installations.length}</span>
          </h2>
          {st.data.installations.length === 0 ? (
            <p class="gh-lede">
              {reader
                ? "Install the App on GitHub. GitHub sends you back here, you confirm with your GitHub account, and the installation shows up with its repositories."
                : "Nothing installed yet."}
            </p>
          ) : (
            <ul class="insts">
              {st.data.installations.map((i) => (
                <InstallationItem key={i.id} inst={i} />
              ))}
            </ul>
          )}
        </>
      ) : null}
      <p class="int-foot">
        <Icon name="shield-check" size={16} />
        <span>
          We link an installation only after GitHub confirms your account can see it. The App's keys
          live in the platform's secrets, never in the database or this page.
        </span>
      </p>
    </Page>
  );
}
