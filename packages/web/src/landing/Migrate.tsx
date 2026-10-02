/**
 * Migration: bring a GitHub repository over in one call; config arrives as a plan to approve.
 */
import { CopyLine } from "./Hero.js";

const STEPS = [
  {
    title: "Import",
    text: "The repository comes over with its full history. Your editor, your scripts and any git client work against the new remote.",
  },
  {
    title: "Detect",
    text: "gittifacts reads your package manager, test runner, build command and TypeScript config, and says so when it is unsure.",
  },
  {
    title: "Approve",
    text: "The CI and policy config it proposes arrives as a plan and a change for a person to approve. Nothing is applied silently.",
  },
];

export function Migrate() {
  return (
    <section class="l-section migrate wrap" id="migrate" aria-labelledby="migrate-title">
      <div class="migrate__grid">
        <div class="l-head migrate__head">
          <h2 class="l-h2" id="migrate-title">
            Bring your repositories with you.
          </h2>
          <p class="l-lede">One call imports a GitHub repository. An agent can do it for you.</p>
          <div class="migrate__cmds">
            <p class="migrate__cmd-label">From an agent, over MCP</p>
            <CopyLine
              id="import-call"
              text={'create_project({ from: "https://github.com/you/repo" })'}
              label="Copy the import call"
            />
            <p class="migrate__cmd-label">From a terminal</p>
            <CopyLine
              id="import-cli"
              text="npx gittifacts init --from https://github.com/you/repo"
              label="Copy the import command"
            />
          </div>
        </div>
        <ol class="migrate__steps">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <span class="migrate__n" aria-hidden="true">
                {i + 1}
              </span>
              <div>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
