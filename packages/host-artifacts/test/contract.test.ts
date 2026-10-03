/**
 * The host contract suite against the native adapter (M1). The GitHub adapter runs the same
 * suite in M2 (recorded webhook/API fixtures every commit, a live test org nightly).
 */
import { runContractSuite } from "@app/host-contract";
import { nativeContractHost } from "./native-host.js";

runContractSuite(nativeContractHost);
