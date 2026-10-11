/**
 * `npx gittifacts`: the agent-native git platform from a shell. Bundled into dist/cli.mjs.
 * It first runs a newer build the platform serves, when there is one (src/self-update.ts).
 */
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { processIo } from "./io.js";
import { runCli } from "./main.js";
import { runBuild, selfUpdate } from "./self-update.js";

const argv = process.argv.slice(2);
const newer = await selfUpdate({
  argv,
  env: process.env,
  cwd: process.cwd(),
  home: homedir(),
  selfFile: fileURLToPath(import.meta.url),
  fetch: (input, init) => fetch(input, init),
  now: Date.now(),
  stderr: process.stderr,
});
const delegated = newer === null ? null : await runBuild(newer, argv, process.env);

const code = delegated ?? (await runCli(argv, processIo()));
process.exitCode = code;
// Exit once stdout has flushed (pipes are async on macOS), without waiting on idle keep-alive sockets.
process.stdout.write("", () => process.exit(code));
