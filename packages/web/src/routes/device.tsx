/**
 * /device[?user_code=ABCD-2345] — RFC 8628 verification page for CLI logins.
 *
 * The CLI prints a code and this URL. You enter (or confirm) the code, see what the CLI is asking
 * for in plain words, pick repositories, scopes and a session length, and approve or deny. The CLI
 * then receives an agent token for a new agent principal you own; never your own session.
 */
import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { useLocation } from "preact-iso";
import { type ConsentView, oauthApi } from "../api/oauth.js";
import {
  ConsentFrame,
  ConsentOutcome,
  ConsentPanel,
  ConsentReceipt,
  type Granted,
} from "../components/ConsentPanel.js";
import { CopyLine } from "../components/CopyLine.js";
import { Button, ErrorState, Loading } from "../components/ui.js";
import { cliCommand } from "../lib/cli.js";
import { formatUserCode } from "../lib/consent-copy.js";
import { useResource } from "../state/resource.js";

function EnterCode({ initial, onSubmit }: { initial: string; onSubmit: (code: string) => void }) {
  const code = useSignal(formatUserCode(initial));
  const error = useSignal<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Straight to the field with a keyboard at hand; on touch, the keyboard would cover the help.
  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) input.current?.focus();
  }, []);
  return (
    <form
      class="device-entry"
      onSubmit={(e) => {
        e.preventDefault();
        const clean = code.value.replace(/[^a-zA-Z0-9]/g, "");
        if (clean.length < 6) {
          error.value = "Enter the code your terminal shows, like ABCD-2345.";
          input.current?.focus();
          return;
        }
        onSubmit(formatUserCode(clean));
      }}
      noValidate
    >
      <h1 class="device-entry__title">Connect the gittifacts CLI</h1>
      <p class="device-entry__lede">
        The CLI is asking to act as a new agent you're accountable for. Enter the code it shows;
        you'll see what it asks for before anything is granted.
      </p>
      <label class="field">
        <span class="field__label">Code</span>
        <input
          ref={input}
          class="input device-entry__input"
          name="user_code"
          value={code.value}
          onInput={(e) => {
            code.value = formatUserCode(e.currentTarget.value);
            error.value = null;
          }}
          inputMode="text"
          enterKeyHint="go"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellcheck={false}
          maxLength={12}
          aria-invalid={error.value ? "true" : undefined}
          aria-describedby={error.value ? "code-error" : "code-hint"}
          data-testid="device-code"
        />
        {error.value ? (
          <span class="field__error" id="code-error" role="alert">
            {error.value}
          </span>
        ) : (
          <span class="field__hint" id="code-hint">
            Eight letters and digits, like ABCD-2345. Dashes and capitals don't matter; codes
            last 15 minutes.
          </span>
        )}
      </label>
      <Button type="submit" variant="primary" wide>
        Continue
      </Button>
      <div class="device-entry__how">
        <p>No code yet? In your terminal, run:</p>
        <CopyLine text={cliCommand("login")} label="Copy the login command" />
        <p class="device-entry__agent">
          An agent can run it too, then hand you the URL and code it prints.
        </p>
      </div>
    </form>
  );
}

type Decision = { kind: "approved"; granted: Granted } | { kind: "denied" };

function Decided({ view, decision }: { view: ConsentView; decision: Decision }) {
  return decision.kind === "approved" ? (
    <ConsentOutcome
      tone="ok"
      title={`${decision.granted.name} is connected`}
      action={<a href="/agents">See it on the Agents page</a>}
    >
      <ConsentReceipt granted={decision.granted} />
      <p>
        Go back to your terminal: {view.client.name} picks up its token within a few seconds and
        can call <code>whoami</code> to see what it may do. Revoke it any time on the Agents page.
      </p>
    </ConsentOutcome>
  ) : (
    <ConsentOutcome tone="neutral" title="Access denied">
      <p>{view.client.name} will report that access was refused. Nothing was granted.</p>
    </ConsentOutcome>
  );
}

function Expired() {
  return (
    <ConsentOutcome
      tone="neutral"
      title="This code expired"
      action={<a href="/device">Enter a new code</a>}
    >
      <p>Codes last 15 minutes. Run the login again in your terminal to get a fresh one.</p>
    </ConsentOutcome>
  );
}

export function DeviceView() {
  const { query, route } = useLocation();
  const userCode = query.user_code ?? "";
  const decided = useSignal<Decision | null>(null);
  const res = useResource(
    () => (userCode ? oauthApi.device(userCode) : Promise.resolve(null)),
    [userCode],
  );

  // An outcome names the tab itself (ConsentOutcome).
  useEffect(() => {
    const st = res.state.value;
    if (!userCode || st.status === "loading") document.title = "Connect the CLI · gittifacts";
    else if (st.status === "ok" && st.data?.consent.status === "pending" && !decided.value)
      document.title = `${st.data.consent.client.name} wants access · gittifacts`;
  }, [userCode, res.state.value]);

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
          <Decided view={st.data.consent} decision={decided.value} />
        ) : st.data.consent.status === "expired" ? (
          <Expired />
        ) : st.data.consent.status !== "pending" ? (
          <ConsentOutcome tone="neutral" title={`This login was already ${st.data.consent.status}`}>
            <p>
              Each code can be decided once. Run the login again if the CLI still needs access.
            </p>
          </ConsentOutcome>
        ) : (
          <ConsentPanel
            view={st.data.consent}
            expired={<Expired />}
            onApprove={async (d, key, granted) => {
              await oauthApi.approveDevice(userCode, d, key);
              decided.value = { kind: "approved", granted };
            }}
            onDeny={async (key) => {
              await oauthApi.denyDevice(userCode, key);
              decided.value = { kind: "denied" };
            }}
          />
        )
      ) : null}
    </ConsentFrame>
  );
}
