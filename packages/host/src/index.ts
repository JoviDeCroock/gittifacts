/**
 * `@app/host`: the host boundary. The `HostAdapter` interface, host capabilities and the
 * degradation helpers, normalized events, `ChangeRef`, and the `LaneVerdict` hosts publish.
 * Types and small pure helpers only; implementations live in `@app/host-*`.
 */
export * from "./adapter.js";
export * from "./capabilities.js";
export * from "./events.js";
export * from "./ref.js";
export * from "./verdict.js";
