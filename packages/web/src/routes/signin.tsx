import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { isMockMode } from "../api/mode.js";
import { GitHubMark, Icon } from "../components/Icon.js";
import { BrandMark } from "../components/Shell.js";
import { TriageChart } from "../components/TriageChart.js";
import { Button } from "../components/ui.js";
import { session, signInWithEmail, signInWithGitHub, signUpWithEmail } from "../state/session.js";
import "../styles/signin.css";

const SAMPLE = [
  { code: "api.breaking", lane: 2 as const, message: "Removes Invoice.total from the public SDK." },
  { code: "proof.red-green", lane: 0 as const, message: "2 new tests fail on main, pass here." },
  { code: "coverage.changed-lines", lane: 0 as const, message: "92% of changed lines covered." },
];

export function SignIn() {
  const mode = useSignal<"signin" | "signup">("signin");
  const busy = useSignal<"github" | "email" | null>(null);
  const error = useSignal<string | null>(null);
  const name = useSignal("");
  const email = useSignal(isMockMode() ? "maya@acme.dev" : "");
  const password = useSignal(isMockMode() ? "demo-password" : "");

  useEffect(() => {
    document.title = "Sign in · gittifacts";
  }, []);

  const s = session.value;
  const notice = s.status === "anon" && s.reason === "expired" ? "Your session ended. Sign in again to pick up where you left off." : s.status === "error" ? `The server could not check your session: ${s.message}` : null;

  async function submit(e: Event) {
    e.preventDefault();
    if (busy.value) return;
    error.value = null;
    busy.value = "email";
    const res = mode.value === "signin" ? await signInWithEmail(email.value.trim(), password.value) : await signUpWithEmail(name.value.trim(), email.value.trim(), password.value);
    busy.value = null;
    if (!res.ok) error.value = res.message ?? "Sign-in failed.";
  }

  async function github() {
    if (busy.value) return;
    error.value = null;
    busy.value = "github";
    const res = await signInWithGitHub();
    busy.value = null;
    if (!res.ok) error.value = res.message ?? "GitHub sign-in did not start.";
  }

  return (
    <div class="signin">
      <main class="signin__main" id="main">
        <div class="signin__brand">
          <BrandMark size={26} />
          <span class="brand__word">gittifacts</span>
        </div>
        <h1 class="signin__title">{mode.value === "signin" ? "Sign in to review" : "Create your account"}</h1>
        <p class="signin__lede">Approve plans, read tours, and watch rollouts for the changes your agents write.</p>

        {notice ? (
          <p class="signin__notice" role="status">
            <Icon name="info" size={16} />
            {notice}
          </p>
        ) : null}

        <Button variant="secondary" wide class="signin__github" busy={busy.value === "github"} busyLabel="Opening GitHub…" onClick={github}>
          <GitHubMark />
          Continue with GitHub
        </Button>

        <div class="signin__or" role="separator">
          <span>or with email</span>
        </div>

        <form class="signin__form" onSubmit={submit} noValidate>
          {mode.value === "signup" ? (
            <label class="field">
              <span class="field__label">Name</span>
              <input class="input" name="name" autoComplete="name" required value={name.value} onInput={(e) => (name.value = e.currentTarget.value)} />
            </label>
          ) : null}
          <label class="field">
            <span class="field__label">Email</span>
            <input
              class="input"
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              required
              value={email.value}
              onInput={(e) => (email.value = e.currentTarget.value)}
              aria-invalid={error.value ? "true" : undefined}
              aria-describedby={error.value ? "signin-error" : undefined}
            />
          </label>
          <label class="field">
            <span class="field__label">Password</span>
            <input
              class="input"
              type="password"
              name="password"
              autoComplete={mode.value === "signin" ? "current-password" : "new-password"}
              required
              minLength={8}
              value={password.value}
              onInput={(e) => (password.value = e.currentTarget.value)}
              aria-invalid={error.value ? "true" : undefined}
              aria-describedby={error.value ? "signin-error" : undefined}
            />
          </label>
          {error.value ? (
            <p class="field__error" id="signin-error" role="alert">
              {error.value}
            </p>
          ) : null}
          <Button type="submit" variant="primary" wide busy={busy.value === "email"} busyLabel={mode.value === "signin" ? "Signing in…" : "Creating account…"}>
            {mode.value === "signin" ? "Sign in" : "Create account"}
          </Button>
        </form>

        <p class="signin__switch">
          {mode.value === "signin" ? "New to gittifacts?" : "Already have an account?"}{" "}
          <button
            type="button"
            class="linklike"
            onClick={() => {
              mode.value = mode.value === "signin" ? "signup" : "signin";
              error.value = null;
            }}
          >
            {mode.value === "signin" ? "Create an account" : "Sign in instead"}
          </button>
        </p>

        {isMockMode() ? (
          <p class="demo-note">
            <Icon name="info" size={14} />
            Demo mode: any email signs you in as Maya Okafor. All data is synthetic.
          </p>
        ) : null}
      </main>

      <aside class="signin__specimen" aria-label="Example: how a change is routed">
        <div class="signin__specimen-inner">
          <p class="signin__specimen-title">Every change arrives with the reason for its lane.</p>
          <div class="panel">
            <TriageChart reasons={SAMPLE} computedLane={2} lane={2} caption="Example: why a breaking SDK change needs a full review" />
          </div>
          <p class="signin__specimen-note">Example from a synthetic breaking API change. Lane 2 means a person reads the diff.</p>
        </div>
      </aside>
    </div>
  );
}
