/**
 * Cloudflare Turnstile, rendered explicitly (one script load per page, one widget per mount).
 * `onToken` gets the token when the check passes and `null` when it expires or errors, so the
 * caller can only submit with a live token. Bumping `resetKey` resets the widget (after the server
 * refused a token: tokens are single-use).
 *
 * Mock mode never loads Cloudflare's script: a stand-in yields Cloudflare's documented dummy
 * token, which only the test secret keys accept.
 */
import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { isMockMode } from "../api/mode.js";
import { DUMMY_TURNSTILE_TOKEN } from "../lib/claim.js";
import { themePref } from "../state/prefs.js";
import { Icon } from "./Icon.js";

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.async = true;
    s.defer = true;
    s.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not start."));
    s.onerror = () => {
      loading = null;
      reject(
        new Error(
          "Couldn't load the human check. Check your connection or content blockers, then reload.",
        ),
      );
    };
    document.head.appendChild(s);
  });
  return loading;
}

interface TurnstileProps {
  siteKey: string;
  onToken: (token: string | null) => void;
  resetKey: number;
}

export function Turnstile(props: TurnstileProps) {
  return isMockMode() ? <MockTurnstile {...props} /> : <RealTurnstile {...props} />;
}

function RealTurnstile({ siteKey, onToken, resetKey }: TurnstileProps) {
  const host = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const error = useSignal<string | null>(null);
  const cb = useRef(onToken);
  cb.current = onToken;

  useEffect(() => {
    let cancelled = false;
    loadTurnstile().then(
      (ts) => {
        if (cancelled || !host.current) return;
        widget.current = ts.render(host.current, {
          sitekey: siteKey,
          theme: themePref.value === "system" ? "auto" : themePref.value,
          size: "flexible",
          action: "claim",
          callback: (token: string) => cb.current(token),
          "expired-callback": () => cb.current(null),
          "error-callback": () => {
            cb.current(null);
            return false; // let the widget show its own retry
          },
        });
      },
      (e: unknown) => {
        if (!cancelled)
          error.value = e instanceof Error ? e.message : "Couldn't load the human check.";
      },
    );
    return () => {
      cancelled = true;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey, error]);

  useEffect(() => {
    if (resetKey === 0 || !widget.current || !window.turnstile) return;
    cb.current(null);
    window.turnstile.reset(widget.current);
  }, [resetKey]);

  return (
    <div class="turnstile">
      <div ref={host} class="turnstile__host" />
      {error.value ? (
        <p class="field__error" role="alert">
          {error.value}
        </p>
      ) : null}
    </div>
  );
}

/** The demo's stand-in: "verifying" for a moment, then a passed check with the dummy token. */
function MockTurnstile({ onToken, resetKey }: TurnstileProps) {
  const state = useSignal<"verifying" | "verified">("verifying");
  const cb = useRef(onToken);
  cb.current = onToken;

  useEffect(() => {
    state.value = "verifying";
    cb.current(null);
    const id = window.setTimeout(() => {
      state.value = "verified";
      cb.current(DUMMY_TURNSTILE_TOKEN);
    }, 700);
    return () => window.clearTimeout(id);
  }, [resetKey, state]);

  const verified = state.value === "verified";
  return (
    <div
      class={`turnstile turnstile--mock ${verified ? "turnstile--ok" : ""}`}
      role="status"
      aria-live="polite"
    >
      <span class="turnstile__mark" aria-hidden="true">
        <Icon
          name={verified ? "check" : "loader"}
          size={18}
          class={verified ? undefined : "spin"}
        />
      </span>
      <span class="turnstile__text">
        <span class="turnstile__state">{verified ? "Verified" : "Checking you're a person…"}</span>
        <span class="turnstile__note">Test mode · stand-in for Cloudflare Turnstile</span>
      </span>
    </div>
  );
}
