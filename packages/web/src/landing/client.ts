/**
 * The landing page's only script: copy buttons, the torn strip's timing (it plays in view), the
 * theme switch (same storage key as the app),
 * the start URL on hosts the Worker did not rewrite (local preview), and the nav's "Sign in" /
 * "Open dashboard" link and the "Create an account" / "Open dashboard" CTAs (one session check). The page works without it.
 */
const DEFAULT_ORIGIN = "https://gittifacts.decroockjovi.workers.dev";
const THEME_KEY = "gf:theme";
type Theme = "system" | "light" | "dark";

/** Same break points as the prerender (content.ts urlParts): after "//" and host dots, before "/". */
function urlParts(url: string): string[] {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(.*)$/i.exec(url);
  if (!m) return [url];
  const [, scheme = "", host = "", path = ""] = m;
  return [scheme, ...host.split(/(?<=\.)/), ...path.split(/(?=\/)/)].filter(Boolean);
}

function fixOrigin(): void {
  const origin = window.location.origin;
  if (origin === DEFAULT_ORIGIN || !/^https?:/.test(origin)) return;
  for (const el of document.querySelectorAll<HTMLElement>("[data-origin-text]")) {
    if (!el.textContent?.startsWith(DEFAULT_ORIGIN)) continue;
    const url = `${origin}${el.dataset.originText ?? ""}`;
    const parts = urlParts(url);
    el.replaceChildren(
      ...parts.flatMap((p, i) => (i > 0 ? [document.createElement("wbr"), p] : [p])),
    );
  }
}

function announce(text: string): void {
  const status = document.getElementById("copy-status");
  if (status) status.textContent = text;
}

function wireCopy(): void {
  if (!navigator.clipboard) return;
  for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
    btn.hidden = false;
    btn.addEventListener("click", async () => {
      // innerText keeps line breaks (the three calls copy as three lines).
      const text = document.getElementById(btn.dataset.copy ?? "")?.innerText.trim();
      if (!text) return;
      const bubble = btn.querySelector<HTMLElement>(".copyline__done");
      try {
        await navigator.clipboard.writeText(text);
        if (bubble) bubble.textContent = "Copied";
        btn.dataset.state = "done";
        announce(`Copied ${text}`);
      } catch {
        if (bubble) bubble.textContent = "Copy failed: select the text";
        btn.dataset.state = "failed";
        announce("Copying failed. Select the text and copy it instead.");
      }
      window.setTimeout(() => delete btn.dataset.state, 2000);
    });
  }
}

function readTheme(): Theme {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** Screenshots follow a forced theme: dark sources match always (dark) or never (light). */
function pointPictures(theme: Theme): void {
  for (const src of document.querySelectorAll<HTMLSourceElement>("source[data-theme-src='dark']")) {
    src.dataset.media ??= src.media;
    const narrow = src.hasAttribute("data-narrow");
    src.media =
      theme === "system"
        ? (src.dataset.media ?? "")
        : theme === "dark"
          ? narrow
            ? "(max-width: 639px)"
            : "all"
          : "not all";
  }
}

const THEME_COLOR = { light: "#f7fafc", dark: "#0c1118" } as const;

/** The browser chrome follows a forced theme too. */
function pointThemeColor(theme: Theme): void {
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.dataset.content ??= meta.content;
    meta.content = theme === "system" ? (meta.dataset.content ?? "") : THEME_COLOR[theme];
  }
}

function applyTheme(theme: Theme): void {
  pointThemeColor(theme);
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  pointPictures(theme);
  try {
    if (theme === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage unavailable: the choice lasts for this page */
  }
}

function wireTheme(): void {
  const current = readTheme();
  if (current !== "system") {
    pointPictures(current);
    pointThemeColor(current);
  }
  const group = document.querySelector<HTMLFieldSetElement>(".footer__theme");
  if (!group) return;
  for (const input of group.querySelectorAll<HTMLInputElement>("input[name='theme']")) {
    input.checked = input.value === current;
    input.addEventListener("change", () => applyTheme(input.value as Theme));
  }
  group.hidden = false;
}

/** The phone menu is a <details>; close it once a section is chosen. */
function wireMenu(): void {
  const menu = document.querySelector<HTMLDetailsElement>(".topbar__menu");
  menu?.addEventListener("click", (e) => {
    if ((e.target as Element).closest("a")) menu.open = false;
  });
}

const AUTHED_HINT = "gf:authed";

/** Signed in: the nav's session links and the hero/closing CTAs say "Open dashboard" and go to /dashboard. */
function showSession(authed: boolean): void {
  const root = document.documentElement;
  if (authed) root.setAttribute("data-authed", "");
  else root.removeAttribute("data-authed");
  for (const a of document.querySelectorAll<HTMLAnchorElement>("a[data-session-link]")) {
    a.setAttribute("href", authed ? "/dashboard" : "/signin");
  }
  for (const a of document.querySelectorAll<HTMLAnchorElement>("a[data-session-cta]")) {
    a.setAttribute("href", authed ? "/dashboard" : "/signin?mode=signup");
  }
  try {
    if (authed) window.localStorage.setItem(AUTHED_HINT, "1");
    else window.localStorage.removeItem(AUTHED_HINT);
  } catch {
    /* storage unavailable: the check runs again on the next visit */
  }
}

/**
 * The one data fetch: better-auth's session endpoint (null without a session; the cookie is
 * HttpOnly, so the page can't tell by itself). Unknown (offline, an error) keeps what the hint said.
 */
async function wireSession(): Promise<void> {
  if (document.documentElement.hasAttribute("data-authed")) showSession(true);
  try {
    const res = await fetch("/api/auth/get-session", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!res.ok) return;
    const body: unknown = await res.json();
    showSession(typeof body === "object" && body !== null && "session" in body);
  } catch {
    /* unknown: leave the link as it is */
  }
}

/**
 * The torn strip is the landing's one focal moment, so it plays when it can be seen: the marks
 * settle when the tag comes into view, the strip tears once it is in view and the marks are done.
 * On load it would play below the fold on phones (and mostly on desktop). Reduced motion: never
 * armed, the tag stays settled.
 */
function wireCase(): void {
  const tag = document.querySelector<HTMLElement>(".case");
  const strip = tag?.querySelector<HTMLElement>(".case__strip--2");
  if (!tag || !strip || typeof IntersectionObserver === "undefined") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  tag.dataset.armed = "";
  let marksAt: number | null = null;
  const marks = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return;
      marks.disconnect();
      marksAt = performance.now();
      tag.dataset.marks = "";
    },
    { threshold: 0.2 },
  );
  const tear = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return;
      tear.disconnect();
      // The marks settle first (about 1.1 s); the tear waits for them.
      const wait = Math.max(0, (marksAt ?? performance.now()) + 1050 - performance.now());
      window.setTimeout(() => {
        tag.dataset.play = "";
      }, wait);
    },
    { threshold: 0.75 },
  );
  marks.observe(tag.querySelector(".case__tag") ?? tag);
  tear.observe(strip);
}

fixOrigin();
wireCase();
wireCopy();
wireTheme();
wireMenu();
void wireSession();
