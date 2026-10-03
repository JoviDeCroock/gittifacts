/**
 * /settings/github — GitHub mode: create the gittifacts GitHub App (platform admins, once, via
 * GitHub's manifest flow), install it, and see the installations you linked with their repos.
 */
import { useSignal } from "@preact/signals";
import { useLocation } from "preact-iso";
import { inlineError } from "../api/client.js";
import { FLOW_ERRORS, type GithubApp, type GithubInstallation, githubApi, submitManifest } from "../api/github.js";
import { Icon } from "../components/Icon.js";
import { Page } from "../components/Shell.js";
import { Button, EmptyState, ErrorState, LinkButton, Loading } from "../components/ui.js";
import { relative } from "../lib/time.js";
import { minuteClock } from "../state/clock.js";
import { useResource } from "../state/resource.js";
import "../styles/integrations.css";
import "../styles/github.css";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

function CreateApp() {
  const target = useSignal<"user" | "org">("org");
  const org = useSignal("");
  const name = useSignal("gittifacts");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const orgBad = target.value === "org" && !LOGIN.test(org.value.trim());
  const nameBad = name.value.trim().length === 0 || name.value.trim().length > 34;

  async function go(e: Event) {
    e.preventDefault();
    if (busy.value || orgBad || nameBad) return;
    busy.value = true;
    error.value = null;
    try {
      const start = await githubApi.startManifest({
        kind: "reader",
        name: name.value.trim(),
        ...(target.value === "org" ? { org: org.value.trim() } : {}),
      });
      submitManifest(start);
    } catch (err) {
      error.value = inlineError(err);
      busy.value = false;
    }
  }

  return (
    <form class="gh-create" onSubmit={go} aria-labelledby="gh-create-title">
      <h2 class="int-section__title" id="gh-create-title">
        Create the GitHub App
      </h2>
      <p class="gh-lede">
        GitHub creates the App from a manifest we prepare; its keys come straight back here,
        encrypted. You confirm the name on GitHub. This happens once.
      </p>
      <div class="int-checks" role="radiogroup" aria-labelledby="gh-owner">
        <span class="field__label" id="gh-owner">Owner on GitHub</span>
        <label class="check">
          <input type="radio" name="gh-target" checked={target.value === "org"} onChange={() => (target.value = "org")} />
          <span>An organization</span>
          <span class="check__hint">You must be an owner of it.</span>
        </label>
        <label class="check">
          <input type="radio" name="gh-target" checked={target.value === "user"} onChange={() => (target.value = "user")} />
          <span>My GitHub account</span>
          <span class="check__hint">The account you're signed in to on github.com.</span>
        </label>
      </div>
      {target.value === "org" ? (
        <label class="field">
          <span class="field__label">Organization</span>
          <input class="input mono" autoCapitalize="off" spellcheck={false} value={org.value} onInput={(e) => (org.value = (e.target as HTMLInputElement).value)} placeholder="acme" aria-invalid={org.value && orgBad ? "true" : undefined} />
          <span class="field__hint">The organization's login, as in github.com/&lt;login&gt;.</span>
        </label>
      ) : null}
      <label class="field">
        <span class="field__label">App name</span>
        <input class="input" value={name.value} maxLength={34} onInput={(e) => (name.value = (e.target as HTMLInputElement).value)} aria-invalid={nameBad ? "true" : undefined} />
        <span class="field__hint">
          App names are unique across all of GitHub. If GitHub says it's taken, come back and pick
          another (at most 34 characters).
        </span>
      </label>
      <details class="disclosure gh-perms">
        <summary>
          <Icon name="chevron-down" class="disclosure__chev" size={16} />
          What the App may do
        </summary>
        <ul class="gh-perms__list">
          <li>Read code, metadata, issues, merge queues, deployments and commit statuses.</li>
          <li>Post one check run per pull request head (<code>gittifacts/lane</code>).</li>
          <li>Pull requests: write, for tours as review comments from M3. Shadow mode posts none.</li>
          <li>Never: administration, workflows, commit statuses (write), merging.</li>
        </ul>
      </details>
      {error.value ? (
        <p class="field__error" role="alert">
          {error.value}
        </p>
      ) : null}
      <div>
        <Button type="submit" variant="primary" busy={busy.value} busyLabel="Opening GitHub…" disabled={orgBad || nameBad} icon="external-link">
          Continue on GitHub
        </Button>
      </div>
    </form>
  );
}

function AppRow({ app }: { app: GithubApp }) {
  return (
    <div class="gh-app">
      <div class="gh-app__main">
        <h3 class="inst__name">{app.name}</h3>
        <p class="inst__by">
          {app.kind === "reader" ? "Reader App" : "Actor App"} · owned by {app.owner.login} ·{" "}
          <a href={app.htmlUrl} target="_blank" rel="noopener noreferrer">
            github.com/apps/{app.slug}
          </a>
        </p>
        <p class="gh-shadow">
          <Icon name="eye" size={16} />
          <span>
            Shadow mode: one <code>gittifacts/lane</code> check run per pull request head, and for a
            linked installation the tour as one review plus a summary comment. It never blocks,
            approves or merges.
          </span>
        </p>
      </div>
      <LinkButton href={app.installUrl} variant="primary" size="sm" icon="external-link" target="_blank" rel="noopener noreferrer">
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
          <a href={`https://github.com/${repo.fullName}`} target="_blank" rel="noopener noreferrer" class="mono">
            {repo.fullName}
          </a>
        )}
      </span>
      {repoId !== null ? (
        <label class="gh-repo__switch">
          <input type="checkbox" role="switch" checked={on.value} disabled={busy.value} onChange={toggle} />
          <span>Tour review and summary on PRs</span>
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
        <LinkButton href={inst.manageUrl} variant="secondary" size="sm" target="_blank" rel="noopener noreferrer">
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
  const msg = query.created
    ? `GitHub created ${query.created}. Next: install it on an organization and pick a repository or two.`
    : query.linked
      ? "Installation linked. Its pull requests are graded in shadow mode from now on."
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
  const reader = st.status === "ok" ? st.data.apps.find((a) => a.kind === "reader") : undefined;
  return (
    <Page
      title="GitHub"
      meta={<span>Grade pull requests where your code already lives. Nothing moves; shadow mode never blocks, approves or merges.</span>}
    >
      <Notice />
      {st.status === "loading" ? <Loading label="Loading GitHub setup" lines={6} /> : null}
      {st.status === "error" ? <ErrorState error={st.error} what="the GitHub setup" onRetry={res.reload} /> : null}
      {st.status === "ok" ? (
        <>
          {reader ? (
            <section aria-label="The GitHub App">
              <h2 class="int-section__title">The GitHub App</h2>
              <AppRow app={reader} />
            </section>
          ) : st.data.canCreateApps ? (
            <CreateApp />
          ) : (
            <EmptyState icon="plug" title="The GitHub App isn't set up yet">
              <p>A platform admin creates it once. Then you can install it on your organization.</p>
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
          We link an installation only after GitHub confirms your account can see it. App keys are
          stored encrypted; every App creation and link is in the <a href="/audit">audit log</a>.
        </span>
      </p>
    </Page>
  );
}
