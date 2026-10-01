/**
 * Mock mode: the UI runs against an in-browser backend with synthetic data.
 * On with `VITE_MOCK=1` at build/dev time, or `?mock` in the URL (remembered for the tab).
 * `?mock=0` turns a remembered session off again.
 */
const KEY = "gf:mock";

function readFlag(): boolean {
  if (import.meta.env.VITE_MOCK === "1") return true;
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has("mock")) {
      const on = params.get("mock") !== "0";
      if (on) window.sessionStorage.setItem(KEY, "1");
      else window.sessionStorage.removeItem(KEY);
      return on;
    }
    return window.sessionStorage.getItem(KEY) === "1";
  } catch {
    return new URLSearchParams(window.location.search).has("mock");
  }
}

const enabled = readFlag();

export function isMockMode(): boolean {
  return enabled;
}
