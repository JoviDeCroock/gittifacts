/**
 * `gittifacts wait <changeId> --until <milestone> [--timeout <sec>]`: wait, don't poll. Re-issues
 * the `wait_for_change` long-poll until the milestone is reached, can't be reached, or `--timeout`
 * passes. Each long-poll is kept under proxy idle limits; Ctrl-C stops cleanly.
 */
import type { WaitUntil } from "@app/domain";
import { withCommands } from "../calls.js";
import { cliError, EXIT } from "../errors.js";
import { isAbort, toCliError } from "../failures.js";
import { bundledCommands, findCommand, flagFor } from "../tools/commands.js";
import { type Builtin, builtinSpec, int, positionalOr, requireValue, str } from "./builtin.js";
import { toolFailure } from "./tool.js";

/** One long-poll stays under ~100s so proxies (e.g. Cloudflare) don't cut an idle response. */
export const MAX_WINDOW_SEC = 90;
export const DEFAULT_TIMEOUT_SEC = 600;
/** A long-poll that returns "timeout" much sooner than asked is retried no faster than this. */
const MIN_REISSUE_MS = 1000;
const MAX_TRANSIENT_RETRIES = 3;
/** Client-side margin over a long-poll's window before the request counts as lost. */
export const REQUEST_MARGIN_SEC = 15;

/** `until` values, read from the `wait_for_change` input schema this CLI was built against. */
function milestones(): string[] {
  const s = findCommand("wait_for_change")?.inputSchema.properties?.until;
  const values = s ? flagFor("until", s, true).values : undefined;
  return (values ?? []).map(String);
}

const spec = builtinSpec({
  command: "wait",
  tool: "wait_for_change",
  title: "Wait for a change",
  description:
    "Wait until a change reaches a milestone, re-issuing the wait_for_change long-poll until --timeout. Exit 0 when reached, 3 when it timed out, can no longer be reached, a human sent it back (changes requested, rejected, approval withdrawn) or it is failing (red CI, a merge-queue ejection or a failed merge).",
  properties: {
    changeId: { type: "string", description: "The change to wait for." },
    until: { enum: milestones(), description: "The milestone." },
    timeout: {
      type: "integer",
      description: `Overall seconds to wait (default ${DEFAULT_TIMEOUT_SEC}).`,
    },
  },
  required: ["changeId", "until"],
  positional: "changeId",
});

const TRANSIENT = new Set(["network", "timeout", "upstream", "rate-limited"]);

export const wait: Builtin = {
  spec,
  examples: [
    "gittifacts wait chg_123 --until evidence_ready",
    "gittifacts wait chg_123 --until merged --timeout 1800 --human",
  ],
  async run(ctx, parsed) {
    const changeId = requireValue(spec, positionalOr(spec, parsed, "changeId"), "<changeId>");
    const until = requireValue(spec, str(parsed, "until"), "--until") as WaitUntil;
    const timeoutSec = int(parsed, "timeout") ?? DEFAULT_TIMEOUT_SEC;
    if (timeoutSec < 1) {
      throw cliError(
        "usage",
        "--timeout must be at least 1 second",
        {
          explanation: "Pass the overall number of seconds to wait.",
          command: "gittifacts wait --help",
        },
        { exitCode: EXIT.usage },
      );
    }
    const target = ctx.target();
    const started = ctx.io.now();
    const deadline = started + timeoutSec * 1000;
    const ac = new AbortController();
    const off = ctx.io.onInterrupt(() => ac.abort(new Error("aborted")));
    const interrupted = () =>
      cliError(
        "interrupted",
        `stopped waiting for ${changeId}`,
        {
          explanation: "Nothing changed on the platform; wait again whenever you like.",
          command: `gittifacts wait ${changeId} --until ${until} --timeout ${timeoutSec}`,
        },
        { exitCode: EXIT.interrupted },
      );

    let attempts = 0;
    let transient = 0;
    let result: Record<string, unknown>;
    try {
      result = await ctx.withConnection(target, "wait", {}, async ({ mcp }) => {
        let last: Record<string, unknown> | null = null;
        for (;;) {
          const remaining = Math.ceil((deadline - ctx.io.now()) / 1000);
          if (remaining <= 0 && last !== null) return last;
          const windowSec = Math.max(1, Math.min(remaining, MAX_WINDOW_SEC));
          const issued = ctx.io.now();
          attempts += 1;
          let r: Awaited<ReturnType<typeof mcp.tools.wait_for_change>>;
          try {
            // The platform answers by windowSec + 5 s even when a deploy interrupts it; a request
            // still silent after REQUEST_MARGIN_SEC more is treated as lost and re-issued.
            r = await mcp.tools.wait_for_change(
              { changeId, until, timeoutSec: windowSec },
              { signal: ac.signal, timeout: (windowSec + REQUEST_MARGIN_SEC) * 1000 },
            );
          } catch (e) {
            if (ac.signal.aborted) throw interrupted();
            const mapped = toCliError(e, ctx.failureContext(target, "wait"));
            if (
              TRANSIENT.has(mapped.body.code) &&
              transient < MAX_TRANSIENT_RETRIES &&
              ctx.io.now() < deadline
            ) {
              transient += 1;
              ctx.out.progress(`connection trouble (${mapped.body.code}); retrying`);
              await ctx.io.sleep(1000 * 2 ** transient, ac.signal);
              continue;
            }
            throw mapped;
          }
          transient = 0;
          if (r.isError) throw toolFailure(spec, r);
          const doc = r.structuredContent;
          last = doc;
          // Anything but a timeout is final: reached, ended, or sent back by a human or by CI.
          if (doc.reached || doc.reason !== "timeout") return last;
          if (ctx.io.now() >= deadline) return last;
          ctx.out.progress(
            `waiting for ${changeId} to reach ${until}: status ${doc.change.status} (${Math.round((ctx.io.now() - started) / 1000)}s)`,
          );
          const elapsed = ctx.io.now() - issued;
          // An interrupted long-poll (e.g. a deploy) says when to ask again.
          const retryAfterMs =
            typeof doc.retryAfterSec === "number" ? Math.max(0, doc.retryAfterSec) * 1000 : 0;
          const pause = Math.min(
            Math.max(MIN_REISSUE_MS - elapsed, retryAfterMs),
            Math.max(0, deadline - ctx.io.now()),
          );
          if (pause > 0) await ctx.io.sleep(pause, ac.signal);
        }
      });
    } catch (e) {
      if (ac.signal.aborted || isAbort(e)) throw interrupted();
      throw e;
    } finally {
      off();
    }

    const reached = result.reached === true;
    ctx.out.result(
      withCommands(
        {
          ...result,
          waited: { attempts, seconds: Math.round((ctx.io.now() - started) / 1000), timeoutSec },
        },
        bundledCommands(),
      ),
      { title: reached ? `${changeId}: ${until} reached` : `${changeId}: ${until} not reached` },
    );
    return reached ? EXIT.ok : EXIT.notReached;
  },
};
