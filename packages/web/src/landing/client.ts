/**
 * The landing page's only script: copy buttons, the theme switch (same storage key as the app),
 * and the start URL on hosts the Worker did not rewrite (local preview). The page works without it.
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

fixOrigin();
wireCopy();
wireTheme();
wireMenu();
