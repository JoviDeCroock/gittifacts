/**
 * For agents: one URL, three calls, the measured time to first green, errors that say what to
 * do next, and starting without an account.
 */
import { DEFAULT_ORIGIN, ERROR_EXAMPLE, FIRST_GREEN, MEASURED, SHIP_CALLS } from "./content.js";
import { CopyButton, CopyLine } from "./Hero.js";

/** Axis position of `sec` seconds (the Worker computes the same for the live numbers). */
export function ttfgPct(sec: number): string {
  const clamped = Math.min(Math.max(sec, 0), FIRST_GREEN.axisMaxSec);
  return `${Math.round((clamped / FIRST_GREEN.axisMaxSec) * 1000) / 10}%`;
}

/**
 * Time to first green on the live platform against the 60 s target: the bar runs from the median
 * to the 90th percentile. Static numbers here; the Worker fills in the live ones (data-ttfg-*).
 */
function FirstGreen() {
  const { p50Sec, p90Sec, targetSec, axisMaxSec } = FIRST_GREEN;
  return (
    <figure class="ttfg" aria-labelledby="ttfg-caption">
      <div class="ttfg__axis" aria-hidden="true">
        <span
          class="ttfg__range"
          data-ttfg-range=""
          style={{ left: ttfgPct(p50Sec), width: ttfgPct(p90Sec - p50Sec) }}
        />
        <span class="ttfg__median" data-ttfg-median="" style={{ left: ttfgPct(p50Sec) }} />
        <span class="ttfg__target" style={{ left: ttfgPct(targetSec) }}>
          <span>target</span>
        </span>
        {[0, 30, 60, axisMaxSec].map((s) => (
          <span class="ttfg__tick" key={s} style={{ left: ttfgPct(s) }}>
            {s} s
          </span>
        ))}
      </div>
      <figcaption id="ttfg-caption">
        <strong>First green in {MEASURED.firstGreen}:</strong> from one URL to a repo, a passing CI
        run and a live preview. The target is under a minute.{" "}
        <span data-ttfg-live="">
          Median {p50Sec}&nbsp;s, 9 in 10 projects within {p90Sec}&nbsp;s, over {FIRST_GREEN.window}
          .
        </span>{" "}
        The bar runs from the median to the 90th percentile.{" "}
        <a href={FIRST_GREEN.statsPath}>Live numbers (JSON)</a>
      </figcaption>
    </figure>
  );
}

export function Agents() {
  return (
    <section class="agents" id="agents" aria-labelledby="agents-title">
      <div class="wrap agents__inner">
        <div class="agents__head">
          <h2 class="l-h2" id="agents-title">
            Give your agent one URL.
          </h2>
          <p class="l-lede">
            From <code>/start</code> it finds the MCP server, the CLI and the git remote, then ships
            its first change without a person in the loop.
          </p>
          <CopyLine id="agent-url-2" originPath="/start" label="Copy the start URL" />
        </div>
        <FirstGreen />
        <div class="agents__calls">
          <h3>
            Three calls to ship something
            <CopyButton target="ship-calls" label="Copy the three calls" />
          </h3>
          <ol id="ship-calls">
            {SHIP_CALLS.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ol>
          <p>
            <code>create_project</code> creates the repo from a template, writes the CI config, the
            policy and an <code>AGENTS.md</code>, runs the first CI and starts a preview, all in one
            call.
          </p>
        </div>
        <dl class="agents__facts">
          <div>
            <dt>MCP, CLI or plain git</dt>
            <dd>
              A streamable-HTTP MCP server at{" "}
              <code data-origin-text="/mcp">{`${DEFAULT_ORIGIN}/mcp`}</code>, the{" "}
              <code>gittifacts</code> CLI (served from <code>/cli/gittifacts.tgz</code>), and git
              over HTTPS. An OpenAPI document covers the rest.
            </dd>
          </div>
          <div>
            <dt>No account to start</dt>
            <dd>
              An agent can create an unclaimed project and hand you a link to claim it. Unclaimed
              projects are deleted after 7 days.
            </dd>
          </div>
          <div>
            <dt>Scoped tokens</dt>
            <dd>
              Agents can read, plan and change, inside the repos a person gave them. They never
              approve.
            </dd>
          </div>
        </dl>
        <div class="agents__error">
          <h3>Errors say what to do next</h3>
          <p>
            Every error carries a fix: what happened and the next step, often as the exact call or
            command. Here an agent tried to approve a plan.
          </p>
        </div>
        <pre class="art-code agents__json">
          <code>
            {ERROR_EXAMPLE.split("\n").map((line, n) => (
              // Hanging indent: a wrapped JSON line continues under its own key, not at column 0.
              <span
                class="jl"
                key={n}
                style={{ "--indent": `${line.length - line.trimStart().length}ch` }}
              >
                {line.trimStart()}
              </span>
            ))}
          </code>
        </pre>
      </div>
    </section>
  );
}
