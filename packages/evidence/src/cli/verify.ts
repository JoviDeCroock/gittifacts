#!/usr/bin/env node
/**
 * Standalone entry: `pnpm verify-attestation ...` (tsx) or `node dist/verify-attestation.mjs ...`.
 * See run-verify.ts for options.
 */
import { runVerify } from "./run-verify.js";

process.exitCode = await runVerify(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
});
