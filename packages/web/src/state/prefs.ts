/**
 * Per-viewer conveniences in localStorage: theme override and where you left a tour.
 * Every access is guarded; the app works the same when storage is unavailable.
 */
import { effect, signal } from "@preact/signals";

export type ThemePref = "system" | "light" | "dark";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: preference lasts for this page only */
  }
}

function initialTheme(): ThemePref {
  const v = read("gf:theme");
  return v === "light" || v === "dark" ? v : "system";
}

export const themePref = signal<ThemePref>(initialTheme());

effect(() => {
  const pref = themePref.value;
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
  write("gf:theme", pref === "system" ? null : pref);
});

export function cycleTheme(): void {
  const order: ThemePref[] = ["system", "light", "dark"];
  themePref.value = order[(order.indexOf(themePref.value) + 1) % order.length]!;
}

// ---------------------------------------------------------------- tour progress

export interface TourProgress {
  stop: number;
  headSha: string;
}

export function readTourProgress(changeId: string): TourProgress | null {
  const raw = read(`gf:tour:${changeId}`);
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === "object" && v !== null && "stop" in v && "headSha" in v) {
      const { stop, headSha } = v as { stop: unknown; headSha: unknown };
      if (typeof stop === "number" && typeof headSha === "string") return { stop, headSha };
    }
  } catch {
    /* ignore corrupt entries */
  }
  return null;
}

export function writeTourProgress(changeId: string, progress: TourProgress): void {
  write(`gf:tour:${changeId}`, JSON.stringify(progress));
}
