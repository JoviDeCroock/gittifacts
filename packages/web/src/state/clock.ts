/**
 * Time as signals. `minuteClock` drives list ages (cheap, shared); `useTick` gives one
 * component a per-second clock only while it is mounted (countdowns).
 */
import { signal, useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";

export const minuteClock = signal(Date.now());

if (typeof window !== "undefined") {
  window.setInterval(() => {
    minuteClock.value = Date.now();
  }, 30_000);
}

export function useTick(ms = 1000) {
  const now = useSignal(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      now.value = Date.now();
    }, ms);
    return () => window.clearInterval(id);
  }, [ms, now]);
  return now;
}
