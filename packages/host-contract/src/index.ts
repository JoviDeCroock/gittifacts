/**
 * `@app/host-contract`: one set of scenarios, run against every `HostAdapter`. Lanes, evidence
 * and tours must match exactly across hosts (docs/prompts/06-two-modes.md §2).
 *
 *   import { runContractSuite } from "@app/host-contract";
 *   runContractSuite({ name: "artifacts (fakes)", create: async ({ reviewer }) => … });
 */
export * from "./fixtures.js";
export * from "./harness.js";
export { contractReviewer, riskiestFile } from "./reviewer.js";
export * from "./scenarios.js";
export { CONTRACT_TIMEOUT_MS, expectedAction, runContractSuite } from "./suite.js";
