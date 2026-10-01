/**
 * `npx gittifacts`: the agent-native git platform from a shell. Bundled into dist/cli.mjs.
 */
import { processIo } from "./io.js";
import { runCli } from "./main.js";

const code = await runCli(process.argv.slice(2), processIo());
process.exitCode = code;
// Exit once stdout has flushed (pipes are async on macOS), without waiting on idle keep-alive sockets.
process.stdout.write("", () => process.exit(code));
