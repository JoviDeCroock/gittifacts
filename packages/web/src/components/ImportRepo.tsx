/**
 * "Import a private repo" on the dashboard: name it, get the exact `git push` with a one-time
 * grant, and watch for the push. Humans only (the grant writes the new repo's default branch,
 * the one exception to "only the merge queue writes main"), so the palette lists it with a
 * person-only rule. The grant closes at the first push, the first Change or after 30 minutes.
 */
import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { inlineError, newIdempotencyKey } from "../api/client.js";
import {
  type ImportGrant,
  type ImportGrantStatus,
  importApi,
  pushCommands,
} from "../api/import.js";
import { formatDateTime } from "../lib/time.js";
import { Icon } from "./Icon.js";
import { Button, CopyButton, LinkButton } from "./ui.js";
import "../styles/import.css";

const POLL_MS = 3000;

type Step =
  | { kind: "name" }
  | {
      kind: "push";
      repoId: string;
      name: string;
      grant: ImportGrant;
      status: ImportGrantStatus | null;
    };

function closedCopy(s: ImportGrantStatus): string {
  switch (s.closeReason) {
    case "expired":
      return "The grant expired before a push arrived.";
    case "change-started":
      return "A Change was started before the history arrived, which closed the grant.";
    case "closed-by-owner":
      return "The grant was closed before a push arrived.";
    default:
      return "The push closed the grant, but the default branch is missing.";
  }
}

export function ImportRepo({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const step = useSignal<Step>({ kind: "name" });
  const name = useSignal("");
  const branch = useSignal("main");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const key = useRef(newIdempotencyKey());
  const input = useRef<HTMLInputElement>(null);
  const s = step.value;
  const st = s.kind === "push" ? s.status : null;
  const waiting = s.kind === "push" && (st === null || st.status !== "closed");

  useEffect(() => input.current?.focus(), []);

  // Wait for the push: the grant closes and the default branch appears.
  useEffect(() => {
    if (s.kind !== "push" || !waiting) return;
    const id = window.setInterval(async () => {
      try {
        const { grant } = await importApi.status(s.repoId);
        if (step.value.kind !== "push") return;
        step.value = { ...step.value, status: grant };
        if (grant?.imported) onImported();
      } catch {
        /* the next poll asks again */
      }
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [s.kind, waiting, s.kind === "push" ? s.repoId : ""]);

  async function start(e: Event) {
    e.preventDefault();
    if (busy.value) return;
    const n = name.value.trim();
    if (n.length < 2) {
      error.value = "Give the repo a name of at least 2 characters.";
      return;
    }
    busy.value = true;
    error.value = null;
    try {
      const res = await importApi.start(n, key.current);
      step.value = {
        kind: "push",
        repoId: res.projectId,
        name: res.name,
        grant: res.importGrant,
        status: null,
      };
    } catch (err) {
      error.value = inlineError(err);
    } finally {
      busy.value = false;
    }
  }

  async function reopen() {
    if (s.kind !== "push" || busy.value) return;
    busy.value = true;
    error.value = null;
    try {
      const res = await importApi.reopen(s.repoId, newIdempotencyKey());
      step.value = { ...s, grant: res.grant, status: res.status };
    } catch (err) {
      error.value = inlineError(err);
    } finally {
      busy.value = false;
    }
  }

  return (
    <section
      class="import"
      aria-labelledby="import-title"
      id="import"
      data-testid="import-repo"
      data-repo-id={s.kind === "push" ? s.repoId : undefined}
    >
      <div class="import__head">
        <h2 id="import-title" class="import__title">
          Import a private repo
        </h2>
        <button type="button" class="icon-btn" aria-label="Close the import" onClick={onClose}>
          <Icon name="x" size={18} />
        </button>
      </div>
      {s.kind === "name" ? (
        <form class="import__form" onSubmit={start} noValidate>
          <p class="import__lede">
            You get an empty repo and a one-time grant to push its whole history from your machine.
            Agents can't do this; public repos they can import on their own.
          </p>
          <label class="field">
            <span class="field__label">Repo name</span>
            <input
              ref={input}
              class="input"
              name="name"
              value={name.value}
              onInput={(e) => (name.value = e.currentTarget.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellcheck={false}
              placeholder="billing-api"
              aria-invalid={error.value ? "true" : undefined}
              data-testid="import-name"
            />
          </label>
          {error.value ? (
            <p class="field__error" role="alert">
              {error.value}
            </p>
          ) : null}
          <div class="import__actions">
            <Button
              type="submit"
              variant="primary"
              icon="upload"
              busy={busy.value}
              busyLabel="Creating the repo…"
              data-testid="import-start"
            >
              Create and get the push command
            </Button>
          </div>
        </form>
      ) : (
        <PushStep
          s={s}
          branch={branch.value}
          onBranch={(b) => (branch.value = b)}
          busy={busy.value}
          error={error.value}
          onReopen={reopen}
        />
      )}
    </section>
  );
}

function PushStep({
  s,
  branch,
  onBranch,
  busy,
  error,
  onReopen,
}: {
  s: Extract<Step, { kind: "push" }>;
  branch: string;
  onBranch: (b: string) => void;
  busy: boolean;
  error: string | null;
  onReopen: () => void;
}) {
  const st = s.status;
  const cmd = pushCommands(s.grant, branch.trim() || "main");
  if (st?.imported) {
    return (
      <div class="import__done" role="status" data-testid="import-done">
        <p>
          <Icon name="check-circle" size={18} class="tone--ok" /> <b>{s.name}</b> is imported. The
          platform is now proposing its setup (<code>.platform/*</code>) as a Plan for you to
          approve.
        </p>
        <LinkButton
          href={`/repos/${encodeURIComponent(s.repoId)}`}
          variant="primary"
          icon="chevron-right"
          data-testid="import-open"
        >
          Open {s.name}
        </LinkButton>
      </div>
    );
  }
  const closed = st?.status === "closed";
  return (
    <div class="import__push">
      <p class="import__lede">
        <b>{s.name}</b> exists and is empty. From your clone, run this once. The token writes the
        repo, so treat it like a password: it lives in an environment variable, never in the remote
        URL.
      </p>
      <label class="field import__branch">
        <span class="field__label">Your local branch</span>
        <input
          class="input"
          value={branch}
          onInput={(e) => onBranch(e.currentTarget.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellcheck={false}
        />
      </label>
      <div class="import__cmd">
        <pre class="scroll-x" tabIndex={0} data-testid="import-command">
          <code>{cmd}</code>
        </pre>
        <CopyButton text={cmd} label="Copy commands" />
      </div>
      {closed ? (
        <div class="import__closed" role="alert">
          <p>{st ? closedCopy(st) : null} Open a new grant to try again.</p>
          <Button variant="secondary" size="sm" busy={busy} busyLabel="Opening…" onClick={onReopen}>
            Open a new grant
          </Button>
        </div>
      ) : (
        <p class="import__wait" role="status" data-testid="import-waiting">
          <Icon name="loader" size={16} class="spin" /> Waiting for your push. The grant closes at
          the first push or {formatDateTime(s.grant.expiresAt)}, whichever comes first.
        </p>
      )}
      {error ? (
        <p class="field__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
