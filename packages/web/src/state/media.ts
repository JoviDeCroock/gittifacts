import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";

/** Reactive media query. Layout stays CSS-driven; this is only for choosing which control to mount. */
export function useMedia(query: string): boolean {
  const matches = useSignal(
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const on = () => {
      matches.value = mql.matches;
    };
    on();
    mql.addEventListener("change", on);
    return () => mql.removeEventListener("change", on);
  }, [query, matches]);
  return matches.value;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
