/**
 * The dashboard's first-run checklist: three one-action paths (connect your agent, try it now,
 * bring a repo), each ticked from real state (GET /api/v1/me/getting-started). All done, it
 * collapses to one slim line that can be dismissed per user. The first green check gets one quiet
 * line with its preview link.
 */
import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { describeError } from "../api/client.js";
import { gettingStartedApi, type GettingStarted as State } from "../api/getting-started.js";
import {
  agentPrompt,
  type ChecklistView,
  durationLabel,
  type StepId,
  type StepState,
} from "../lib/getting-started.js";
import { useTick } from "../state/clock.js";
import { Icon, type IconId } from "./Icon.js";
import { Button, Command, LinkButton } from "./ui.js";
import "../styles/getting-started.css";

/** Templates with a preview (ts-library has none), fastest first. */
const TEMPLATES = [
  { id: "static-site", label: "Static site" },
  { id: "preact-app", label: "Preact app" },
  { id: "workers-api", label: "Workers API" },
] as const;

const MARK: Record<StepState, { icon: IconId; label: string }> = {
  done: { icon: "check-circle", label: "Done" },
  running: { icon: "loader", label: "Running" },
  failed: { icon: "x-circle", label: "Failed" },
  todo: { icon: "circle-dashed", label: "To do" },
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
  const stateOf = (id: StepId) => view.steps.find((s) => s.id === id)?.state ?? "todo";
  return (
    <section class="gs" aria-labelledby="gs-title">
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
      <ol class="gs__steps">
        <Step state={stateOf("agent")} title="Connect your agent">
          <AgentBody state={state} primary={next === "agent"} />
        </Step>
        <Step state={stateOf("try")} title="Try it now">
          <TryBody
            state={state}
            stepState={stateOf("try")}
            primary={next === "try"}
            onChanged={onChanged}
          />
        </Step>
        <Step state={stateOf("repo")} title="Bring a repo">
          <RepoBody state={state} primary={next === "repo"} onChanged={onChanged} />
        </Step>
      </ol>
    </section>
  );
}

function Step({
  state,
  title,
  children,
}: {
  state: StepState;
  title: string;
  children: ComponentChildren;
}) {
  const mark = MARK[state];
  return (
    <li class="gs-step" data-state={state}>
      <span class="gs-step__mark">
        <Icon name={mark.icon} size={20} class={state === "running" ? "spin" : undefined} />
        <span class="sr-only">{mark.label}: </span>
      </span>
      <div class="gs-step__body">
        <h3 class="gs-step__title">{title}</h3>
        {children}
      </div>
    </li>
  );
}

function AgentBody({ state, primary }: { state: State; primary: boolean }) {
  if (state.agent.connected) {
    return (
      <p class="gs-step__line">
        <b>{state.agent.name ?? "Your agent"}</b> is connected. <a href="/agents">Manage agents</a>
      </p>
    );
  }
  return (
    <>
      <p class="gs-step__line">Tell your agent:</p>
      <div class={`gs-step__cmd ${primary ? "is-next" : ""}`}>
        <Command text={agentPrompt(window.location.origin)} />
      </div>
      <p class="gs-step__aside">
        It reads the guide, then sends you a link to approve it or to claim its first project. Or{" "}
        <a href="/agents">create a token</a> yourself.
      </p>
    </>
  );
}

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
      Creating <b>{b.projectName}</b>: first check running, <span class="tnum">{sec} s</span>.{" "}
      {b.changeId ? <a href={`/changes/${b.changeId}`}>Watch the run</a> : null}
    </p>
  );
}

function TryBody({
  state,
  stepState,
  primary,
  onChanged,
}: {
  state: State;
  stepState: StepState;
  primary: boolean;
  onChanged: () => void;
}) {
  const template = useSignal<string>(TEMPLATES[0].id);
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  if (stepState === "done" && state.firstGreen) return <GreenLine green={state.firstGreen} />;
  const b = state.latestBootstrap;
  if (stepState === "running" && b) return <Running b={b} />;
  async function create(e: Event) {
    e.preventDefault();
    if (busy.value) return;
    busy.value = true;
    error.value = null;
    try {
      await gettingStartedApi.createProject({ template: template.value });
      onChanged();
    } catch (err) {
      const copy = describeError(err, "the project");
      error.value = `${copy.title}. ${copy.detail}`;
    } finally {
      busy.value = false;
    }
  }
  return (
    <>
      {stepState === "failed" && b ? (
        <p class="gs-step__line gs-step__line--failed">
          The first check on <b>{b.projectName}</b> failed.{" "}
          {b.changeId ? <a href={`/changes/${b.changeId}`}>See why</a> : null}
        </p>
      ) : (
        <p class="gs-step__line">
          Create a project from a template. Its first check runs and a live preview comes up.
        </p>
      )}
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
          Create project
        </Button>
      </form>
      {error.value ? (
        <p class="field__error" role="alert">
          {error.value}
        </p>
      ) : null}
    </>
  );
}

const VIA: Record<NonNullable<State["repo"]["via"]>, string> = {
  "github-app": "The GitHub App is connected.",
  "github-mirror": "A GitHub repository is mirrored here.",
  import: "A repository is imported.",
};

function RepoBody({
  state,
  primary,
  onChanged,
}: {
  state: State;
  primary: boolean;
  onChanged: () => void;
}) {
  const url = useSignal("");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  if (state.repo.connected && state.repo.via) {
    return (
      <p class="gs-step__line">
        {VIA[state.repo.via]} <a href="/settings/github">GitHub settings</a>
      </p>
    );
  }
  async function importRepo(e: Event) {
    e.preventDefault();
    if (busy.value) return;
    const from = url.value.trim();
    if (!/^https:\/\/\S+$/.test(from)) {
      error.value = "Paste the repository's https URL, like https://github.com/you/repo.";
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
      <p class="gs-step__line">
        Grade your GitHub pull requests with the GitHub App, or import a public repository.
      </p>
      <div class="gs-repo">
        <LinkButton
          href="/settings/github"
          variant={primary ? "primary" : "secondary"}
          icon="git-branch"
        >
          Connect GitHub
        </LinkButton>
        <details class="gs-repo__import">
          <summary>Import by URL</summary>
          <form class="gs-try" onSubmit={importRepo} noValidate>
            <label class="field gs-try__field gs-try__field--wide">
              <span class="field__label">Public repository URL</span>
              <input
                class="input"
                type="url"
                inputMode="url"
                placeholder="https://github.com/you/repo"
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
        </details>
      </div>
    </>
  );
}

/** All three done: one slim line, dismissible. */
function DoneBanner({ state, onDismiss }: { state: State; onDismiss: () => void }) {
  const green = state.firstGreen;
  return (
    <div class="gs-banner" role="status">
      <Icon name="check-circle" size={18} />
      <p class="gs-banner__text">
        You're set up: your agent is connected
        {green ? (
          <>
            , <a href={`/repos/${green.projectId}`}>{green.projectName}</a> went green
          </>
        ) : null}{" "}
        and a repo is connected.
        {green?.previewUrl ? (
          <>
            {" "}
            <a href={green.previewUrl} class="gs-ext" target="_blank" rel="noopener noreferrer">
              Preview
              <Icon name="arrow-up-right" size={14} />
            </a>
          </>
        ) : null}
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
