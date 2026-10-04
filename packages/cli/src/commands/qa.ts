/**
 * `gittifacts qa <changeId> [--github owner/repo#n] [--force] [--wait] [--timeout <sec>]`: ask for
 * QA in a browser on the change's current head (`request_qa`), and with `--wait` poll `get_qa`
 * until the run finishes. Exit 0 when every criterion passed, 1 when one failed or the run could
 * not test, 3 when --wait timed out (the run keeps going; read it later with `get-qa`).
 */
import { withCommands } from "../calls.js";
import { cliError, EXIT } from "../errors.js";
import { bundledCommands } from "../tools/commands.js";
import { type Builtin, bool, builtinSpec, int, positionalOr, str } from "./builtin.js";
import { toolFailure } from "./tool.js";

const POLL_MS = 5_000;
const DEFAULT_TIMEOUT_SEC = 600;

const spec = builtinSpec({
  command: "qa",
  tool: "request_qa",
  title: "Ask for QA in a browser",
  description:
    "Ask an agent to test the app built from the change's head in a real browser against the Plan's acceptance criteria (screenshots, a replay, a verdict per criterion). Idempotent per head; --wait prints the verdicts when it finishes.",
  properties: {
    changeId: { type: "string", description: "The change (or pass --github)." },
    github: { type: "string", description: "GitHub mode: the pull request as owner/repo#123." },
    force: {
      type: "boolean",
      description: "Run again although this head already has a finished run.",
    },
    wait: { type: "boolean", description: "Wait for the run to finish and print the verdicts." },
    timeout: {
      type: "integer",
      description: `With --wait: overall seconds (default ${DEFAULT_TIMEOUT_SEC}).`,
    },
  },
  positional: "changeId",
  mutating: true,
});

type Run = { status: string; summary: { failed?: number; couldntTest?: number } | null };

const finished = (r: Run) => r.status === "done" || r.status === "failed";
const exitOf = (r: Run) =>
  r.status === "done" && (r.summary?.failed ?? 1) === 0 && (r.summary?.couldntTest ?? 1) === 0
    ? EXIT.ok
    : 1;

export const qa: Builtin = {
  spec,
  examples: ["gittifacts qa chg_123 --wait", "gittifacts qa --github acme/web#42 --wait --human"],
  async run(ctx, parsed) {
    const changeId = positionalOr(spec, parsed, "changeId");
    const github = str(parsed, "github");
    if ((changeId === undefined) === (github === undefined)) {
      throw cliError(
        "usage",
        "pass a change id or --github owner/repo#123 (exactly one)",
        { explanation: "Name the change to test.", command: "gittifacts qa --help" },
        { exitCode: EXIT.usage },
      );
    }
    const ref = changeId !== undefined ? { changeId } : { github: github as string };
    const timeoutSec = int(parsed, "timeout") ?? DEFAULT_TIMEOUT_SEC;
    const target = ctx.target();
    const result = await ctx.withConnection(target, "qa", {}, async ({ mcp }) => {
      const asked = await mcp.tools.request_qa({
        ...ref,
        ...(bool(parsed, "force") ? { force: true } : {}),
      });
      if (asked.isError) throw toolFailure(spec, asked);
      let doc: Record<string, unknown> & { run: Run & { id: string } } = asked.structuredContent;
      if (!bool(parsed, "wait") || finished(doc.run)) return doc;
      const deadline = ctx.io.now() + timeoutSec * 1000;
      while (ctx.io.now() < deadline) {
        ctx.out.progress(
          `QA ${doc.run.id}: ${doc.run.status}${(doc.run as { progress?: string | null }).progress ? ` (${(doc.run as { progress?: string }).progress})` : ""}`,
        );
        await ctx.io.sleep(POLL_MS);
        const got = await mcp.tools.get_qa(ref);
        if (got.isError) throw toolFailure(spec, got);
        const latest = got.structuredContent.runs.find((r) => r.id === doc.run.id);
        if (latest !== undefined)
          doc = { ...doc, run: latest, nextSteps: got.structuredContent.nextSteps };
        if (finished(doc.run)) return doc;
      }
      return { ...doc, timedOut: true };
    });
    const run = (result as { run: Run & { id: string } }).run;
    ctx.out.result(withCommands(result, bundledCommands()), {
      title: `QA ${run.id}: ${run.status}`,
    });
    if ((result as { timedOut?: boolean }).timedOut === true) return EXIT.notReached;
    return finished(run) ? exitOf(run) : EXIT.ok;
  },
};
