/**
 * /oauth/consent?request=<id> — an MCP client (OAuth authorization code + PKCE) asks to act for
 * you. The platform's /api/oauth/authorize validated the client and sent the browser here; the
 * decision returns the browser to the client with a one-time code (or access_denied).
 *
 * /oauth/consent?error=…&error_description=… — authorize refused the request before any
 * redirect was safe (unknown client, unregistered redirect URI).
 */
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { useLocation } from "preact-iso";
import { isMockMode } from "../api/mode.js";
import { type ConsentView, oauthApi } from "../api/oauth.js";
import { ConsentFrame, ConsentOutcome, ConsentPanel } from "../components/ConsentPanel.js";
import { ErrorState, Loading } from "../components/ui.js";
import { useResource } from "../state/resource.js";

type Done = { kind: "approved" | "denied"; redirectTo: string };

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the app";
  }
}

function Decided({ view, done }: { view: ConsentView; done: Done }) {
  useEffect(() => {
    // Real flow: hand the browser back to the client. The demo stays here.
    if (!isMockMode()) window.location.assign(done.redirectTo);
  }, [done.redirectTo]);
  const host = hostOf(done.redirectTo);
  return done.kind === "approved" ? (
    <ConsentOutcome
      tone="ok"
      title={`${view.client.name} is connected`}
      action={<a href="/agents">See your agent sessions</a>}
    >
      <p>
        {isMockMode()
          ? `In a real connection your browser now returns to ${host} with a one-time code.`
          : `Sending you back to ${host}…`}
      </p>
      <p>It acts as a new agent you are accountable for. Revoke it any time on the Agents page.</p>
    </ConsentOutcome>
  ) : (
    <ConsentOutcome tone="neutral" title="Access denied">
      <p>
        {isMockMode()
          ? `In a real connection your browser now returns to ${host}.`
          : `Sending you back to ${host}…`}
      </p>
    </ConsentOutcome>
  );
}

function NotPending({ view }: { view: ConsentView }) {
  if (view.status === "expired") {
    return (
      <ConsentOutcome tone="neutral" title="This request expired">
        <p>Requests last 10 minutes. Go back to {view.client.name} and connect again.</p>
      </ConsentOutcome>
    );
  }
  return (
    <ConsentOutcome
      tone="neutral"
      title={`This request was already ${view.status === "denied" ? "denied" : "approved"}`}
    >
      <p>
        Each request can be decided once. If {view.client.name} still needs access, connect again
        from it.
      </p>
    </ConsentOutcome>
  );
}

export function OAuthConsent() {
  const { query } = useLocation();
  const requestId = query.request ?? "";
  const done = useSignal<Done | null>(null);
  const res = useResource(
    () => (requestId ? oauthApi.consent(requestId) : Promise.resolve(null)),
    [requestId],
  );

  useEffect(() => {
    const st = res.state.value;
    document.title =
      st.status === "ok" && st.data
        ? `${st.data.consent.client.name} wants access · gittifacts`
        : "Connect an agent · gittifacts";
  }, [res.state.value]);

  if (query.error) {
    return (
      <ConsentFrame>
        <ConsentOutcome tone="danger" title="This connection can't continue">
          <p>{query.error_description ?? "The request was not valid."}</p>
          <p>
            Go back to your agent and connect again. If it keeps failing, its OAuth client setup
            needs fixing.
          </p>
        </ConsentOutcome>
      </ConsentFrame>
    );
  }
  if (!requestId) {
    return (
      <ConsentFrame>
        <ConsentOutcome tone="neutral" title="Nothing to approve here">
          <p>This page opens when an agent or MCP client asks to connect to your account.</p>
        </ConsentOutcome>
      </ConsentFrame>
    );
  }

  const st = res.state.value;
  return (
    <ConsentFrame>
      {st.status === "loading" ? <Loading label="Loading the request" lines={8} /> : null}
      {st.status === "error" ? (
        <ErrorState error={st.error} what="this request" onRetry={res.reload} />
      ) : null}
      {st.status === "ok" && st.data ? (
        done.value ? (
          <Decided view={st.data.consent} done={done.value} />
        ) : st.data.consent.status !== "pending" ? (
          <NotPending view={st.data.consent} />
        ) : (
          <ConsentPanel
            view={st.data.consent}
            onApprove={async (d, key) => {
              const { redirectTo } = await oauthApi.approve(requestId, d, key);
              done.value = { kind: "approved", redirectTo };
            }}
            onDeny={async (key) => {
              const { redirectTo } = await oauthApi.deny(requestId, key);
              done.value = { kind: "denied", redirectTo };
            }}
          />
        )
      ) : null}
    </ConsentFrame>
  );
}
