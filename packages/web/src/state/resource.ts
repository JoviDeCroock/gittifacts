/**
 * Async data in signals. A route calls `useResource(loader, deps)` and renders from the
 * returned signal. Stale responses from an earlier dep set are dropped.
 */
import { type Signal, useSignal } from "@preact/signals";
import { useCallback, useEffect, useRef } from "preact/hooks";
import { ApiError } from "../api/client.js";
import { sessionExpired } from "./session.js";

export type Resource<T> =
  | { status: "loading"; data?: undefined }
  | { status: "ok"; data: T }
  | { status: "error"; error: unknown; data?: undefined };

export interface ResourceHandle<T> {
  state: Signal<Resource<T>>;
  reload: () => void;
  /** Replace the data after a mutation the server confirmed. */
  set: (data: T) => void;
}

export function useResource<T>(load: () => Promise<T>, deps: unknown[]): ResourceHandle<T> {
  const state = useSignal<Resource<T>>({ status: "loading" });
  const token = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback((keepData: boolean) => {
    const mine = ++token.current;
    if (!keepData || state.peek().status !== "ok") state.value = { status: "loading" };
    loadRef.current().then(
      (data) => {
        if (token.current === mine) state.value = { status: "ok", data };
      },
      (error: unknown) => {
        if (token.current !== mine) return;
        if (error instanceof ApiError && error.status === 401) sessionExpired();
        state.value = { status: "error", error };
      },
    );
  }, [state]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's cache key
  useEffect(() => {
    run(false);
  }, deps);

  return {
    state,
    reload: () => run(true),
    set: (data: T) => {
      token.current++;
      state.value = { status: "ok", data };
    },
  };
}
