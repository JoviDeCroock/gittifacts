/**
 * /device[?user_code=ABCD-2345] — RFC 8628 verification page for CLI logins.
 *
 * The CLI prints a code and this URL. You enter (or confirm) the code, see what the CLI is asking
 * for in plain words, pick repositories, scopes and a session length, and approve or deny. The CLI
 * then receives an agent token for a new agent principal you own; never your own session.
 */
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { useLocation } from "preact-iso";
import { type ConsentView, oauthApi } from "../api/oauth.js";
import { ConsentFrame, ConsentOutcome, ConsentPanel } from "../components/ConsentPanel.js";
import { Button, ErrorState, Loading } from "../components/ui.js";
import { formatUserCode } from "../lib/consent-copy.js";
import { useResource } from "../state/resource.js";

function EnterCode({ initial, onSubmit }: { initial: string; onSubmit: (code: string) => void }) {
  const code = useSignal(formatUserCode(initial));
  const error = useSignal<string | null>(null);
  return (
    <form
      class="device-entry"
      onSubmit={(e) => {
        e.preventDefault();
        const clean = code.value.replace(/[^a-zA-Z0-9]/g, "");
        if (clean.length < 6) {
          error.value = "Enter the code your terminal shows, like ABCD-2345.";
          return;
        }
        onSubmit(formatUserCode(clean));
      }}
      noValidate
    >
      <h1 class="device-entry__title">Connect a device</h1>
      <p class="device-entry__lede">
        Enter the code your command-line tool is showing. You'll see what it asks for before
        anything is granted.
      </p>
      <label class="field">
        <span class="field__label">Code</span>
        <input
          class="input device-entry__input"
          value={code.value}
          onInput={(e) => {
            code.value = formatUserCode(e.currentTarget.value);
            error.value = null;
          }}
          placeholder="ABCD-2345"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellcheck={false}
          maxLength={12}
          aria-invalid={error.value ? "true" : undefined}
          aria-describedby={error.value ? "code-error" : "code-hint"}
        />
        {error.value ? (
          <span class="field__error" id="code-error" role="alert">
            {error.value}
          </span>
        ) : (
          <span class="field__hint" id="code-hint">
            Dashes and capitals don't matter. Codes last 15 minutes.
          </span>
        )}
      </label>
      <Button type="submit" variant="primary" wide>
        Continue
      </Button>
      <div class="device-entry__how">
        <span>No code yet? On the device, run</span>
        <code>npx gittifacts login</code>
      </div>
    </form>
  );
}

function Decided({ view, kind }: { view: ConsentView; kind: "approved" | "denied" }) {
  return kind === "approved" ? (
    <ConsentOutcome
      tone="ok"
      title="Device connected"
      action={<a href="/agents">See your agent sessions</a>}
    >
      <p>Go back to your terminal. {view.client.name} picks up its token within a few seconds.</p>
      <p>It acts as a new agent you are accountable for. Revoke it any time on the Agents page.</p>
    </ConsentOutcome>
  ) : (
    <ConsentOutcome tone="neutral" title="Access denied">
      <p>{view.client.name} will report that access was refused. Nothing was granted.</p>
    </ConsentOutcome>
  );
}

export function DeviceView() {
  const { query, route } = useLocation();
  const userCode = query.user_code ?? "";
  const decided = useSignal<"approved" | "denied" | null>(null);
  const res = useResource(
    () => (userCode ? oauthApi.device(userCode) : Promise.resolve(null)),
    [userCode],
  );

  useEffect(() => {
    document.title = "Connect a device · gittifacts";
  }, []);

  if (!userCode) {
    return (
      <ConsentFrame>
        <EnterCode
          initial=""
          onSubmit={(c) => route(`/device?user_code=${encodeURIComponent(c)}`)}
        />
      </ConsentFrame>
    );
  }

  const st = res.state.value;
  return (
    <ConsentFrame>
      {st.status === "loading" ? <Loading label="Looking up the code" lines={8} /> : null}
      {st.status === "error" ? (
        <>
          <ErrorState error={st.error} what="this code" onRetry={res.reload} />
          <p>
            <a href="/device">Enter a different code</a>
          </p>
        </>
      ) : null}
      {st.status === "ok" && st.data ? (
        decided.value ? (
          <Decided view={st.data.consent} kind={decided.value} />
        ) : st.data.consent.status === "expired" ? (
          <ConsentOutcome
            tone="neutral"
            title="This code expired"
            action={<a href="/device">Enter a new code</a>}
          >
            <p>Run the login again on the device to get a fresh code.</p>
          </ConsentOutcome>
        ) : st.data.consent.status !== "pending" ? (
          <ConsentOutcome tone="neutral" title={`This login was already ${st.data.consent.status}`}>
            <p>
              Each code can be decided once. Run the login again if the device still needs access.
            </p>
          </ConsentOutcome>
        ) : (
          <ConsentPanel
            view={st.data.consent}
            onApprove={async (d, key) => {
              await oauthApi.approveDevice(userCode, d, key);
              decided.value = "approved";
            }}
            onDeny={async (key) => {
              await oauthApi.denyDevice(userCode, key);
              decided.value = "denied";
            }}
          />
        )
      ) : null}
    </ConsentFrame>
  );
}
