/**
 * /integrations/install?request=<id> — an integration (a deploy platform's OAuth app) asks to be
 * installed on your repositories. The platform's authorize endpoint validated the client and sent
 * the browser here; the decision returns the browser to the integration (code or access_denied).
 */
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { useLocation } from "preact-iso";
import { ApiError } from "../api/client.js";
import { type InstallView, integrationsApi } from "../api/integrations.js";
import { isMockMode } from "../api/mode.js";
import { ConsentFrame, ConsentOutcome } from "../components/ConsentPanel.js";
import { InstallPanel } from "../components/InstallPanel.js";
import { Button, Loading } from "../components/ui.js";
import { hostOf } from "../lib/integrations.js";
import { useResource } from "../state/resource.js";

type Done = { kind: "approved" | "denied"; redirectTo: string };

function Decided({ view, done }: { view: InstallView; done: Done }) {
  useEffect(() => {
    // Real flow: hand the browser back to the integration. The demo stays here.
    if (!isMockMode()) window.location.assign(done.redirectTo);
  }, [done.redirectTo]);
  const host = hostOf(done.redirectTo, view.redirectHost);
  const back = isMockMode()
    ? `In a real installation your browser now returns to ${host}.`
    : `Sending you back to ${host}…`;
  const name = view.integration.name;
  if (done.kind === "denied") {
    return (
      <ConsentOutcome tone="neutral" title="Nothing was installed">
        <p>{back}</p>
        <p>{name} got no access. You can start again from its site any time.</p>
      </ConsentOutcome>
    );
  }
  return (
    <ConsentOutcome
      tone="ok"
      title={view.existing ? `${name} is updated` : `${name} is installed`}
      action={<a href="/settings/integrations">See your integrations</a>}
    >
      <p>{back}</p>
      <p>
        It can read the repositories you picked and report what it deployed. Uninstall it any time
        on the Integrations page; its tokens stop working at once.
      </p>
    </ConsentOutcome>
  );
}

function NotPending({ status, name }: { status: InstallView["status"] | "conflict"; name: string }) {
  if (status === "expired") {
    return (
      <ConsentOutcome tone="neutral" title="This request expired">
        <p>Requests last 10 minutes. Go back to {name} and connect again.</p>
      </ConsentOutcome>
    );
  }
  const word = status === "denied" ? "cancelled" : status === "conflict" ? "decided" : "approved";
  return (
    <ConsentOutcome tone="neutral" title={`This request was already ${word}`}>
      <p>Each request can be decided once. If {name} still needs access, connect again from it.</p>
    </ConsentOutcome>
  );
}

/** What failed, why (the server's fix), and how to recover. */
function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const api = error instanceof ApiError ? error : null;
  const fix = api?.fix?.explanation;
  if (api?.status === 404) {
    return (
      <ConsentOutcome tone="danger" title="We couldn't find this installation request">
        <p>{fix ?? "The link may be wrong, or the request was already used."}</p>
      </ConsentOutcome>
    );
  }
  return (
    <ConsentOutcome
      tone="danger"
      title="Couldn't load this request"
      action={
        <Button variant="secondary" size="sm" icon="undo" onClick={onRetry}>
          Retry
        </Button>
      }
    >
      <p>{fix ?? (error instanceof Error ? error.message : "Unknown error.")}</p>
    </ConsentOutcome>
  );
}

export function IntegrationInstall() {
  const { query } = useLocation();
  const requestId = query.request ?? "";
  const done = useSignal<Done | null>(null);
  const conflict = useSignal(false);
  const res = useResource(
    () => (requestId ? integrationsApi.install(requestId) : Promise.resolve(null)),
    [requestId],
  );
  const st = res.state.value;

  useEffect(() => {
    document.title =
      st.status === "ok" && st.data
        ? `Install ${st.data.install.integration.name} · gittifacts`
        : "Install an integration · gittifacts";
  }, [st]);

  /** A 409 means someone (or another tab) decided first: show that, not an inline error. */
  async function guard(fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        conflict.value = true;
        return;
      }
      throw err;
    }
  }

  if (query.error) {
    return (
      <ConsentFrame>
        <ConsentOutcome tone="danger" title="This installation can't continue">
          <p>{query.error_description ?? "The request was not valid."}</p>
          <p>Go back to the integration and connect again. If it keeps failing, its setup needs fixing.</p>
        </ConsentOutcome>
      </ConsentFrame>
    );
  }
  if (!requestId) {
    return (
      <ConsentFrame>
        <ConsentOutcome tone="neutral" title="Nothing to install here">
          <p>
            This page opens when a deploy platform or another app asks to connect to your
            repositories.
          </p>
        </ConsentOutcome>
      </ConsentFrame>
    );
  }

  return (
    <ConsentFrame wide>
      {st.status === "loading" ? <Loading label="Loading the installation request" lines={8} /> : null}
      {st.status === "error" ? <LoadError error={st.error} onRetry={res.reload} /> : null}
      {st.status === "ok" && st.data ? (
        done.value ? (
          <Decided view={st.data.install} done={done.value} />
        ) : conflict.value ? (
          <NotPending status="conflict" name={st.data.install.integration.name} />
        ) : st.data.install.status !== "pending" ? (
          <NotPending status={st.data.install.status} name={st.data.install.integration.name} />
        ) : (
          <InstallPanel
            view={st.data.install}
            onApprove={(d, key) =>
              guard(async () => {
                const { redirectTo } = await integrationsApi.approveInstall(requestId, d, key);
                done.value = { kind: "approved", redirectTo };
              })
            }
            onDeny={(key) =>
              guard(async () => {
                const { redirectTo } = await integrationsApi.denyInstall(requestId, key);
                done.value = { kind: "denied", redirectTo };
              })
            }
          />
        )
      ) : null}
    </ConsentFrame>
  );
}
