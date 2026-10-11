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
import {
  ConsentFrame,
  ConsentOutcome,
  ConsentPanel,
  ConsentReceipt,
  type Granted,
} from "../components/ConsentPanel.js";
import { ErrorState, Loading } from "../components/ui.js";
import { useResource } from "../state/resource.js";

type Done =
  | { kind: "approved"; redirectTo: string; granted: Granted }
  | { kind: "denied"; redirectTo: string };

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
      title={`${done.granted.name} is connected`}
      action={<a href="/agents">See it on the Agents page</a>}
    >
      <ConsentReceipt granted={done.granted} />
      <p>
        {isMockMode()
          ? `In a real connection your browser now returns to ${host} with a one-time code, and ${view.client.name} can call list_repos.`
          : `Sending you back to ${host}… ${view.client.name} can then call list_repos.`}{" "}
        Revoke it any time on the Agents page.
      </p>
    </ConsentOutcome>
  ) : (
    <ConsentOutcome tone="neutral" title="Access denied">
      <p>
        {isMockMode()
          ? `In a real connection your browser now returns to ${host}.`
          : `Sending you back to ${host}…`}{" "}
        Nothing was granted.
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

  // An outcome names the tab itself (ConsentOutcome); this covers loading and the open decision.
  useEffect(() => {
    const st = res.state.value;
    if (st.status === "loading") document.title = "Connect an agent · gittifacts";
    else if (st.status === "ok" && st.data?.consent.status === "pending" && !done.value)
      document.title = `${st.data.consent.client.name} wants access · gittifacts`;
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
            expired={<NotPending view={{ ...st.data.consent, status: "expired" }} />}
            onApprove={async (d, key, granted) => {
              const { redirectTo } = await oauthApi.approve(requestId, d, key);
              done.value = { kind: "approved", redirectTo, granted };
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
