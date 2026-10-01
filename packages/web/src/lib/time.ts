/**
 * Time formatting. Pure: every function takes `now` explicitly so tests are deterministic.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact age for lists: "now", "4m", "3h", "2d", "5w". */
export function shortAge(iso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(iso));
  if (ms < MINUTE) return "now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  if (ms < 14 * DAY) return `${Math.floor(ms / DAY)}d`;
  return `${Math.floor(ms / (7 * DAY))}w`;
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "long" });

/** Readable relative time for prose and aria labels: "3 hours ago", "in 12 minutes". */
export function relative(iso: string, now: number): string {
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  if (abs < MINUTE) return diff < 0 ? "just now" : "in under a minute";
  if (abs < HOUR) return rtf.format(Math.round(diff / MINUTE), "minute");
  if (abs < DAY) return rtf.format(Math.round(diff / HOUR), "hour");
  return rtf.format(Math.round(diff / DAY), "day");
}

/**
 * Countdown clock for a deadline: "18:42", "1:02:05", or "0:00" once passed.
 * Rounds up, so the clock never shows 0:00 while time remains.
 */
export function countdown(untilIso: string, now: number): string {
  const ms = Date.parse(untilIso) - now;
  if (!(ms > 0)) return "0:00";
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Spoken form of a countdown for screen readers, minute precision: "18 minutes left". */
export function countdownWords(untilIso: string, now: number): string {
  const ms = Date.parse(untilIso) - now;
  if (!(ms > 0)) return "time is up";
  const minutes = Math.ceil(ms / MINUTE);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} left`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h} ${h === 1 ? "hour" : "hours"}${m ? ` ${m} min` : ""} left`;
}

/** Fraction of a window elapsed, clamped to 0..1. */
export function elapsedFraction(startIso: string, endIso: string, now: number): number {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!(end > start)) return 1;
  return Math.min(1, Math.max(0, (now - start) / (end - start)));
}

export function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * MINUTE).toISOString();
}

const dateTime = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const timeOnly = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hour12: false });

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

export function formatTime(iso: string): string {
  return timeOnly.format(new Date(iso));
}

export function durationLabel(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return rest ? `${m} min ${rest} s` : `${m} min`;
}

/** Time of day for today's events, date and time otherwise. */
export function formatWhen(iso: string, now: number): string {
  const d = new Date(iso);
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? formatTime(iso) : formatDateTime(iso);
}
