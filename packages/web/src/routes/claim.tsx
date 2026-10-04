/**
 * /claim/:token — a person takes ownership of a project an agent created without an account
 * (onboarding O3). The agent hands over the claim link; this page says what the project is, who
 * made it, when it will be deleted, what claiming changes, and asks for one decision.
 *
 * Readable signed out (the link itself is the secret). Claiming needs a signed-in person and a
 * passed Turnstile check; the server records it in the audit log. One owner per project: the same
 * person may repeat a claim (idempotent), anyone else gets "already claimed".
 */
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { ApiError, api, newIdempotencyKey } from "../api/client.js";
import type { ClaimResult, ClaimView } from "../api/types.js";
import { ConsentFrame, ConsentOutcome } from "../components/ConsentPanel.js";
import { Icon } from "../components/Icon.js";
import { Turnstile } from "../components/Turnstile.js";
import { Avatar, Button, ErrorState, LinkButton, Loading } from "../components/ui.js";
import {
  type ClaimFailure,
  claimFailure,
  claimStage,
  expiryInfo,
  signInHref,
} from "../lib/claim.js";
import { formatDateTime, relative } from "../lib/time.js";
import { minuteClock } from "../state/clock.js";
import { useResource } from "../state/resource.js";
import { principal, session, userName } from "../state/session.js";
import "../styles/claim.css";

export function ClaimPage({ token }: { token: string }) {
  const res = useResource(() => api.claim(token), [token]);
  const done = useSignal<ClaimResult | null>(null);

  useEffect(() => {
    const st = res.state.value;
    document.title =
      st.status === "ok"
        ? `Claim ${st.data.project.name} · gittifacts`
        : "Claim a repo · gittifacts";
  }, [res.state.value]);

  const st = res.state.value;
  const s = session.value;
  return (
    <ConsentFrame class="claim-frame">
      {st.status === "loading" || s.status === "loading" ? (
        <Loading label="Loading the repo" lines={8} />
      ) : null}
      {st.status === "error" ? <LoadFailed error={st.error} onRetry={res.reload} /> : null}
      {st.status === "ok" && s.status !== "loading" ? (
        done.value ? (
          <Claimed
            name={done.value.project.name}
            already={done.value.alreadyClaimed}
            repoPath={done.value.next.repoPath}
          />
        ) : (
          <ClaimStageView
            token={token}
            view={st.data}
            onClaimed={(r) => {
              done.value = r;
            }}
            onStale={res.reload}
          />
        )
      ) : null}
    </ConsentFrame>
  );
}

function LoadFailed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (error instanceof ApiError && error.status === 404) {
    return (
      <ConsentOutcome tone="neutral" title="This claim link doesn't work">
        <p>
          {error.fix?.explanation ??
            "Check you copied the whole link, or ask the agent for a new one."}
        </p>
      </ConsentOutcome>
    );
  }
  return <ErrorState error={error} what="this repo" onRetry={onRetry} />;
}

function Claimed({
  name,
  already,
  repoPath,
}: {
  name: string;
  already: boolean;
  repoPath: string;
}) {
  return (
    <ConsentOutcome
      tone="ok"
      title={already ? `You already own ${name}` : `You own ${name} now`}
      action={
        <LinkButton href={repoPath} variant="primary" icon="arrow-up-right">
          Open the repo
        </LinkButton>
      }
    >
      <p>It no longer expires, and its limits are lifted to those of any repo you own.</p>
      <p>
        The agent that made it keeps working on it, now accountable to you. You review its Changes;
        auto-merge stays off until you turn it on.
      </p>
      <p class="claim__audit">
        <Icon name="scroll-text" size={14} /> Recorded in the audit log.
      </p>
    </ConsentOutcome>
  );
}

function ClaimStageView({
  token,
  view,
  onClaimed,
  onStale,
}: {
  token: string;
  view: ClaimView;
  onClaimed: (r: ClaimResult) => void;
  onStale: () => void;
}) {
  const me = principal.value;
  const stage = claimStage(view, { signedIn: me !== null, principalId: me?.id ?? null });
  const name = view.project.name;
  if (stage === "yours") {
    return <Claimed name={name} already repoPath={`/repos/${view.project.id}`} />;
  }
  if (stage === "taken") {
    return (
      <ConsentOutcome tone="neutral" title={`${name} already has an owner`}>
        <p>
          {view.claimedBy?.name ?? "Someone"} claimed it
          {view.claimedAt
            ? ` ${relative(view.claimedAt, minuteClock.value)} (${formatDateTime(view.claimedAt)})`
            : ""}
          . A repo has one owner; claim links work once.
        </p>
        <p>
          If you need access, ask its owner. If this was your agent's repo, ask the agent to make
          a new one.
        </p>
      </ConsentOutcome>
    );
  }
  if (stage === "expired") {
    return (
      <ConsentOutcome tone="neutral" title={`${name} expired`}>
        <p>Nobody claimed it in time, so it was deleted with its previews and history.</p>
        <p>Ask the agent to create the repo again and send you the new claim link right away.</p>
      </ConsentOutcome>
    );
  }
  return (
    <ClaimForm
      token={token}
      view={view}
      signedIn={stage === "ready"}
      onClaimed={onClaimed}
      onStale={onStale}
    />
  );
}

function ClaimForm({
  token,
  view,
  signedIn,
  onClaimed,
  onStale,
}: {
  token: string;
  view: ClaimView;
  signedIn: boolean;
  onClaimed: (r: ClaimResult) => void;
  onStale: () => void;
}) {
  const check = useSignal<string | null>(null);
  const resetKey = useSignal(0);
  const busy = useSignal(false);
  const failure = useSignal<ClaimFailure | null>(null);
  // One key per attempt with a given check token; a new token is a new request.
  const key = useSignal(newIdempotencyKey());
  const now = minuteClock.value;
  const p = view.project;
  const expiry = expiryInfo(p.expiresAt, now);

  async function claim(e: Event) {
    e.preventDefault();
    const turnstileToken = check.value;
    if (busy.value || turnstileToken === null) return;
    busy.value = true;
    failure.value = null;
    try {
      onClaimed(await api.claimProject(token, turnstileToken, key.value));
    } catch (err) {
      const f = claimFailure(err);
      failure.value = f;
      if (f.kind === "turnstile") {
        check.value = null;
        key.value = newIdempotencyKey();
        resetKey.value += 1;
      }
      // Someone else won, or it expired meanwhile: show what is true now.
      if (f.kind === "taken" || f.kind === "expired") onStale();
    } finally {
      busy.value = false;
    }
  }

  return (
    <form class="claim" onSubmit={claim} aria-labelledby="claim-title" noValidate>
      <div class="claim__body">
        <section class="claim__ask">
          <h1 id="claim-title" class="claim__title">
            Claim {p.name}
          </h1>
          <p class="claim__meta">
            {p.template ? `${p.template} template` : "Empty repo"} · made{" "}
            {relative(p.createdAt, now)}
          </p>
          <div class="claim__who">
            <Avatar kind="agent" name={view.createdBy.name} size={32} />
            <p class="claim__who-text">
              <span class="claim__agent">{view.createdBy.name}</span>
              <span class="claim__noacct">
                The agent that made it. No person's account is behind it yet.
              </span>
            </p>
          </div>
          {expiry ? (
            <p class={`claim__expiry ${expiry.urgent ? "claim__expiry--urgent" : ""}`}>
              <Icon name="timer" size={16} />
              <span>
                Deleted <b>{expiry.relative}</b>{" "}
                <span class="claim__when">({expiry.absolute})</span> unless someone claims it.
              </span>
            </p>
          ) : null}
          {p.previewUrl ? (
            <a class="claim__preview" href={p.previewUrl} target="_blank" rel="noopener noreferrer">
              See its preview <Icon name="external-link" size={14} />
            </a>
          ) : null}
        </section>

        <section class="claim__does" aria-labelledby="claim-does">
          <h2 id="claim-does" class="claim__h2">
            What claiming does
          </h2>
          <ul class="claim__can">
            {view.claiming.map((line) => (
              <li key={line}>
                <Icon name="check" size={16} />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </section>

        <section class="claim__limits" aria-labelledby="claim-limits">
          <h2 id="claim-limits" class="claim__h2">
            <Icon name="shield-alert" size={16} /> Until it's claimed
          </h2>
          <ul>
            {view.limits.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      </div>

      <aside class="claim__decide" aria-labelledby="claim-decide">
        <h2 id="claim-decide" class="claim__decide-title">
          Become the owner
        </h2>
        <p class="claim__owner">
          Claiming makes <b>you</b> the owner: you become accountable for this repo and the agent
          working on it. The claim is recorded in the audit log.
        </p>

        {signedIn ? (
          <fieldset class="claim__check">
            <legend class="claim__h2">Confirm you're a person</legend>
            <Turnstile
              siteKey={view.turnstile.siteKey}
              resetKey={resetKey.value}
              onToken={(t) => {
                // The failure stays until the next attempt, so a quick re-check can't hide it.
                check.value = t;
              }}
            />
          </fieldset>
        ) : null}

        {failure.value ? (
          <div class="claim__failure" role="alert">
            <p class="claim__failure-title">{failure.value.title}</p>
            <p>{failure.value.detail}</p>
            {failure.value.kind === "signin" ? <a href={signInHref(token)}>Sign in again</a> : null}
          </div>
        ) : null}

        <div class="consent-bar claim-bar">
          <p class="consent-bar__time">
            {signedIn ? (
              <>
                <Icon name="user" size={14} /> Claiming as {userName.value}
              </>
            ) : (
              <>
                <Icon name="info" size={14} /> You'll come straight back here after signing in.
              </>
            )}
          </p>
          <div class="claim-bar__actions">
            {signedIn ? (
              <Button
                type="submit"
                variant="primary"
                icon="check"
                busy={busy.value}
                busyLabel="Claiming…"
                disabled={check.value === null}
                aria-describedby={check.value === null ? "claim-missing" : undefined}
              >
                Claim this repo
              </Button>
            ) : (
              <LinkButton href={signInHref(token)} variant="primary" icon="user">
                Sign in to claim
              </LinkButton>
            )}
          </div>
          {signedIn && check.value === null && !busy.value ? (
            <p class="consent-bar__missing" id="claim-missing">
              Finish the check above to claim.
            </p>
          ) : null}
        </div>
      </aside>
    </form>
  );
}
