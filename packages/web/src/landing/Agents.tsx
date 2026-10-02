/**
 * For agents: one URL, three calls, the measured time to first green, errors that say what to
 * do next, and starting without an account.
 */

import { ERROR_EXAMPLE, SHIP_CALLS } from "./content.js";
import { CopyLine } from "./Hero.js";

/** Time to first green on the live platform: 36 to 48 s against a 60 s target. */
function FirstGreen() {
  const pct = (s: number) => `${(s / 60) * 100}%`;
  return (
    <figure class="ttfg" aria-labelledby="ttfg-caption">
      <div class="ttfg__axis" aria-hidden="true">
        <span class="ttfg__range" style={{ left: pct(36), width: pct(12) }} />
        <span class="ttfg__target" style={{ left: "100%" }} />
        {[0, 15, 30, 45, 60].map((s) => (
          <span class="ttfg__tick" key={s} style={{ left: pct(s) }}>
            {s} s
          </span>
        ))}
      </div>
      <figcaption id="ttfg-caption">
        <strong>First green in 36 to 48 seconds,</strong> measured on the live platform: from one
        URL to a repo, a passing CI run and a live preview. The target is a minute.
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
          <h3>Three calls to ship something</h3>
          <ol>
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
              A streamable-HTTP MCP server, <code>npx gittifacts</code>, and git over HTTPS. An
              OpenAPI document covers the rest.
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
