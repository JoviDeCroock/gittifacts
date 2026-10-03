/**
 * The host contract suite against the GitHub adapter, on recorded fixtures (every commit). The
 * live test org runs the same scenarios nightly (scripts/github-live-contract.ts).
 */
import { runContractSuite } from "@app/host-contract";
import { githubContractHost } from "./github-host.js";

runContractSuite(githubContractHost);
