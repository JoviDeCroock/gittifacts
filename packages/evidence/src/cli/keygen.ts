#!/usr/bin/env node
/** Standalone entry: `tsx packages/evidence/src/cli/keygen.ts` or `node dist/keygen.mjs`. */
import { runKeygen } from "./run-keygen.js";

process.exitCode = await runKeygen(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
});
