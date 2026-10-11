/**
 * The dashboard's first-run checklist: the golden path (DECISIONS 2026-10-11) in five steps, each
 * ticked from real state (GET /api/v1/me/getting-started) and each with exactly one action:
 *
 *   1. Create a repo        a template (with a small first plan), or an import
 *   2. Connect your agent   its MCP client setup, copy-paste
 *   3. Approve your plan    the sample plan the platform drafted (a person approves intent)
 *   4. Review the Change    the prompt that has the agent build it, then the Change to review
 *   5. First merge          the merge queue lands it; the time from repo to merge
 *
 * All done, it collapses to one slim line that can be dismissed per user.
 */
import { GITHUB_SURFACES } from "@app/domain/surfaces";
import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { describeError } from "../api/client.js";
import { gettingStartedApi, type GettingStarted as State } from "../api/getting-started.js";
import {
  buildPrompt,
  type ChecklistView,
  durationLabel,
  type StepId,
  type StepState,
} from "../lib/getting-started.js";
import { useTick } from "../state/clock.js";
import { Icon, type IconId } from "./Icon.js";
import { McpSetup } from "./McpSetup.js";
import { Button, Command, LinkButton } from "./ui.js";
import "../styles/getting-started.css";
// McpSetup's styles (.mcp-setup) live with the agents screen.
import "../styles/agents.css";

/** Templates, each with a small first plan; the ones with a preview first, fastest first. */
const TEMPLATES = [
  { id: "static-site", label: "Static site" },
  { id: "preact-app", label: "Preact app" },
  { id: "workers-api", label: "Workers API" },
  { id: "ts-library", label: "TypeScript library" },
] as const;

const MARK: Record<StepState, { icon: IconId; label: string }> = {
  done: { icon: "check-circle", label: "Done" },
  running: { icon: "loader", label: "Running" },
  failed: { icon: "x-circle", label: "Failed" },
  todo: { icon: "circle-dashed", label: "To do" },
};

const TITLES: Record<StepId, string> = {
  repo: "Create a repo",
  agent: "Connect your agent",
  plan: "Approve your first plan",
  review: "Review your first Change",
  merge: "First merge",
};

interface Props {
  state: State;
  view: ChecklistView;
  onDismiss: () => void;
  /** Re-read the state (and the repository list) after an action. */
  onChanged: () => void;
}

export function GettingStarted({ state, view, onDismiss, onChanged }: Props) {
  if (view.mode === "hidden") return null;
  if (view.mode === "banner") return <DoneBanner state={state} onDismiss={onDismiss} />;
  // The next step to do carries the primary action; the others stay quiet.
  const next = view.steps.find((s) => s.state !== "done")?.id;
  const body = (id: StepId): ComponentChildren => {
    const primary = next === id;
    switch (id) {
      case "repo":
        return <RepoBody state={state} primary={primary} onChanged={onChanged} />;
      case "agent":
        return <AgentBody state={state} />;
      case "plan":
        return <PlanBody state={state} primary={primary} />;
      case "review":
        return <ReviewBody state={state} primary={primary} />;
      case "merge":
        return <MergeBody state={state} />;
    }
  };
  return (
    <section class="gs" aria-labelledby="gs-title" data-testid="first-run-checklist">
      <div class="gs__head">
        <h2 class="gs__title" id="gs-title">
          Get started
        </h2>
        <span class="gs__count tnum">
          {view.done} of {view.steps.length} done
        </span>
        <button type="button" class="btn btn--quiet btn--sm gs__hide" onClick={onDismiss}>
          Hide
        </button>
      </div>
      <p class="gs__lead">
        From a repo to your first merge: you approve the plan and the Change, your agent does the
        work, and the merge queue lands it.
      </p>
      <ol class="gs__steps">
        {view.steps.map((s) => (
          <Step key={s.id} id={s.id} state={s.state}>
            {body(s.id)}
          </Step>
        ))}
      </ol>
    </section>
  );
}

function Step({
  id,
  state,
  children,
}: {
  id: StepId;
  state: StepState;
  children: ComponentChildren;
}) {
  const mark = MARK[state];
  return (
    <li class="gs-step" data-state={state} data-step={id}>
      <span class="gs-step__mark">
        <Icon name={mark.icon} size={20} class={state === "running" ? "spin" : undefined} />
        <span class="sr-only">{mark.label}: </span>
      </span>
      <div class="gs-step__body">
        <h3 class="gs-step__title">{TITLES[id]}</h3>
        {children}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- 1. a repo

/** The quiet line for a first green: where, how fast, and the preview. */
function GreenLine({ green }: { green: NonNullable<State["firstGreen"]> }) {
  return (
    <p class="gs-step__line gs-green">
      <a href={`/repos/${green.projectId}`}>{green.projectName}</a> went green
      {green.msToFirstGreen !== null ? (
        <>
          {" "}
          in <span class="tnum">{durationLabel(green.msToFirstGreen)}</span>
        </>
      ) : null}
      .{" "}
      {green.previewUrl ? (
        <a href={green.previewUrl} class="gs-ext" target="_blank" rel="noopener noreferrer">
          Open the preview
          <Icon name="arrow-up-right" size={14} />
        </a>
      ) : (
        <a href={`/changes/${green.changeId}`}>See the check</a>
      )}
    </p>
  );
}

function Running({ b }: { b: NonNullable<State["latestBootstrap"]> }) {
  const now = useTick(1000);
  const sec = Math.max(0, Math.round((now.value - Date.parse(b.createdAt)) / 1000));
  return (
    <p class="gs-step__line" role="status">
      <a href={`/repos/${b.projectId}`}>{b.projectName}</a> is ready; its first check is running,{" "}
      <span class="tnum">{sec} s</span>.{" "}
      {b.changeId ? <a href={`/changes/${b.changeId}`}>Watch the run</a> : null}
    </p>
  );
}

function RepoDone({ state }: { state: State }) {
  const b = state.latestBootstrap;
  if (state.firstGreen) return <GreenLine green={state.firstGreen} />;
  if (b?.status === "running") return <Running b={b} />;
  if (b && b.status !== "green") {
    return (
      <p class="gs-step__line gs-step__line--failed">
        The first check on <b>{b.projectName}</b> failed.{" "}
        {b.changeId ? <a href={`/changes/${b.changeId}`}>See why</a> : null}
      </p>
    );
  }
  return (
    <p class="gs-step__line">
      You have <span class="tnum">{state.projects}</span> {state.projects === 1 ? "repo" : "repos"}.
    </p>
  );
}

function RepoBody({
  state,
  primary,
  onChanged,
}: {
  state: State;
  primary: boolean;
  onChanged: () => void;
}) {
  const template = useSignal<string>(TEMPLATES[0].id);
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  if (state.projects > 0) return <RepoDone state={state} />;
  async function create(e: Event) {
    e.preventDefault();
    if (busy.value) return;
    busy.value = true;
    error.value = null;
    try {
      await gettingStartedApi.createProject({ template: template.value });
      onChanged();
    } catch (err) {
      const copy = describeError(err, "the repo");
      error.value = `${copy.title}. ${copy.detail}`;
    } finally {
      busy.value = false;
    }
  }
  return (
    <>
      <p class="gs-step__line">
        From a template: its first check runs, and it comes with a small first plan to approve.
      </p>
      <form class="gs-try" onSubmit={create}>
        <label class="field gs-try__field">
          <span class="field__label">Template</span>
          <select
            class="input"
            value={template.value}
            onChange={(e) => (template.value = e.currentTarget.value)}
          >
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="submit"
          variant={primary ? "primary" : "secondary"}
          icon="rocket"
          busy={busy.value}
          busyLabel="Creating…"
        >
          Create repo
        </Button>
      </form>
      {error.value ? (
        <p class="field__error" role="alert">
          {error.value}
        </p>
      ) : null}
      <details class="gs-repo__import">
        <summary>Or import a public repository</summary>
        <ImportForm onChanged={onChanged} />
      </details>
    </>
  );
}

const EXAMPLE_URL = GITHUB_SURFACES
  ? "https://github.com/you/repo"
  : "https://git.example.com/you/repo";

function ImportForm({ onChanged }: { onChanged: () => void }) {
  const url = useSignal("");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  async function importRepo(e: Event) {
    e.preventDefault();
    if (busy.value) return;
    const from = url.value.trim();
    if (!/^https:\/\/\S+$/.test(from)) {
      error.value = `Paste the repository's https URL, like ${EXAMPLE_URL}.`;
      return;
    }
    busy.value = true;
    error.value = null;
    try {
      await gettingStartedApi.createProject({ from });
      url.value = "";
      onChanged();
    } catch (err) {
      const copy = describeError(err, "that repository");
      error.value = `${copy.title}. ${copy.detail}`;
    } finally {
      busy.value = false;
    }
  }
  return (
    <>
      <form class="gs-try" onSubmit={importRepo} noValidate>
        <label class="field gs-try__field gs-try__field--wide">
          <span class="field__label">Public repository URL</span>
          <input
            class="input"
            type="url"
            inputMode="url"
            placeholder={EXAMPLE_URL}
            value={url.value}
            onInput={(e) => (url.value = e.currentTarget.value)}
            aria-invalid={error.value ? "true" : undefined}
            aria-describedby={error.value ? "gs-import-error" : undefined}
          />
        </label>
        <Button
          type="submit"
          variant="secondary"
          icon="git-merge"
          busy={busy.value}
          busyLabel="Importing…"
        >
          Import
        </Button>
      </form>
      {error.value ? (
        <p class="field__error" id="gs-import-error" role="alert">
          {error.value}
        </p>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- 2. the agent

function AgentBody({ state }: { state: State }) {
  if (state.agent.connected) {
    return (
      <p class="gs-step__line">
        <b>{state.agent.name ?? "Your agent"}</b> is connected. <a href="/agents">Manage agents</a>
      </p>
    );
  }
  return (
    <>
      <p class="gs-step__line">
        Add this platform to your agent's MCP client. It signs in on first use and you approve it.
      </p>
      <McpSetup idPrefix="gs-mcp" />
    </>
  );
}

// ---------------------------------------------------------------- 3. the plan

function PlanBody({ state, primary }: { state: State; primary: boolean }) {
  const p = state.plan;
  if (p?.approved) {
    return (
      <p class="gs-step__line">
        You approved <a href={`/plans/${p.planId}`}>{p.title}</a> in {p.repoName}.
      </p>
    );
  }
  if (p === null) {
    return (
      <p class="gs-step__line">
        A plan says what should change and why; a person approves it before an agent builds it. A
        template repo comes with a small one.
      </p>
    );
  }
  return (
    <>
      <p class="gs-step__line">
        {p.sample ? "The platform drafted a first task for " : "A plan waits for your approval in "}
        <b>{p.repoName}</b>: <b>{p.title}</b>.
      </p>
      <div>
        <LinkButton
          href={`/plans/${p.planId}`}
          variant={primary ? "primary" : "secondary"}
          icon="file-text"
        >
          Read and approve the plan
        </LinkButton>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- 4. the review

function ReviewBody({ state, primary }: { state: State; primary: boolean }) {
  const r = state.review;
  const p = state.plan;
  if (r?.approved) {
    return (
      <p class="gs-step__line">
        You approved <a href={`/changes/${r.changeId}`}>{r.title}</a>.
      </p>
    );
  }
  if (r !== null) {
    return (
      <>
        <p class="gs-step__line">
          Your agent built <b>{r.title}</b>. The evidence is signed and the Change waits for your
          review.
        </p>
        <div>
          <LinkButton
            href={`/changes/${r.changeId}`}
            variant={primary ? "primary" : "secondary"}
            icon="eye"
          >
            Review the Change
          </LinkButton>
        </div>
      </>
    );
  }
  if (p?.approved) {
    return (
      <>
        <p class="gs-step__line">Tell your agent to build it:</p>
        <div class={`gs-step__cmd ${primary ? "is-next" : ""}`} data-testid="gs-build-prompt">
          <Command text={buildPrompt(window.location.origin, p.repoId, p.planId)} />
        </div>
        <p class="gs-step__aside">
          It starts a Change on the plan and pushes. CI runs and the evidence is signed; then it
          asks you to review.
        </p>
      </>
    );
  }
  return (
    <p class="gs-step__line">
      Once you approve the plan, your agent builds it and asks you to review the Change.
    </p>
  );
}

// ---------------------------------------------------------------- 5. the merge

function MergeBody({ state }: { state: State }) {
  const m = state.firstMerge;
  if (m !== null) {
    return (
      <p class="gs-step__line gs-merged">
        <a href={`/changes/${m.changeId}`}>{m.title}</a> landed on main in{" "}
        <a href={`/repos/${m.projectId}`}>{m.projectName}</a>
        {m.msToFirstMerge !== null ? (
          <>
            , <span class="tnum">{durationLabel(m.msToFirstMerge)}</span> after the repo was created
          </>
        ) : null}
        .
      </p>
    );
  }
  const r = state.review;
  if (r?.approved) {
    return (
      <p class="gs-step__line" role="status">
        The merge queue is testing <b>{r.title}</b> on main and lands it.{" "}
        <a href={`/changes/${r.changeId}`}>Watch it land</a>
      </p>
    );
  }
  return (
    <p class="gs-step__line">
      After your approval the merge queue tests it on main and lands it, with a signed note on why
      it exists.
    </p>
  );
}

/** All five done: one slim line, dismissible. */
function DoneBanner({ state, onDismiss }: { state: State; onDismiss: () => void }) {
  const m = state.firstMerge;
  return (
    <div class="gs-banner" role="status">
      <Icon name="check-circle" size={18} />
      <p class="gs-banner__text">
        You're set up: your agent built a plan you approved, and{" "}
        {m ? <a href={`/changes/${m.changeId}`}>{m.title}</a> : "your first Change"} landed
        {m?.msToFirstMerge != null ? (
          <>
            {" "}
            <span class="tnum">{durationLabel(m.msToFirstMerge)}</span> after the repo was created
          </>
        ) : null}
        .
      </p>
      <button
        type="button"
        class="icon-btn gs-banner__close"
        aria-label="Dismiss getting started"
        onClick={onDismiss}
      >
        <Icon name="x" size={18} />
      </button>
    </div>
  );
}
