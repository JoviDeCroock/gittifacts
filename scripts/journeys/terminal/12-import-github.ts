/**
 * Journey 12 (capture): an agent imports a public GitHub repo with the CLI, as "Migrate from
 * GitHub" says, and gets the detection Plan + Change a human approves.
 *
 *   pnpm tsx scripts/journeys/terminal/12-import-github.ts --out <dir> --agent-file <agent.json> \
 *     [--repo https://github.com/JoviDeCroock/gittifacts-fixture-clock-api]
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Term } from "../lib/term.js";
import { agentToken, CLI, HOST, mergeState, parseJson, terminalArgs } from "./common.js";

const { out, state, agentFile, values } = terminalArgs();
const from = String(values.repo ?? "https://github.com/JoviDeCroock/gittifacts-fixture-clock-api");
const term = new Term({
  number: "12",
  slug: "import-github",
  title: "Import a GitHub repo: detection Plan + Change",
  subtitle:
    "An agent imports a public GitHub repo; detection proposes .platform config as a Plan and a Lane 2 Change.",
  host: HOST,
  prompt: "agent@sandbox:~$ ",
});
const home = mkdtempSync(join(tmpdir(), "gf-j12-"));
const work = join(home, "work");
mkdirSync(work);
const env = {
  GITTIFACTS_TOKEN: agentToken(agentFile),
  GITTIFACTS_HOST: HOST,
  GITTIFACTS_CONFIG_DIR: join(home, "config"),
  npm_config_cache: join(home, "npm-cache"),
  npm_config_userconfig: join(home, ".npmrc"),
  npm_config_update_notifier: "false",
  NO_COLOR: "1",
};
const gf = `npx -y ${CLI}`;
const name = `clock-api-${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "")}`;

term.chapter("The repo on GitHub");
term.note("GITTIFACTS_TOKEN is an agent token a human created; the import is owned by that human.");
await term.run(`git ls-remote ${from} HEAD`, `git ls-remote ${from} HEAD`, { env });

term.chapter("Import it");
const t0 = term.now;
const init = await term.run(
  `gittifacts init --from ${from} --name ${name}`,
  `${gf} init --from ${from} --name ${name}`,
  {
    env,
    cwd: work,
  },
);
const created = parseJson<{ projectId: string; bootstrapChangeId?: string | null }>(init.stdout);
if (created === null) {
  term.save(join(out, "casts", "12-import-github.json"));
  throw new Error(`init failed (${init.code})`);
}
term.metric("importMs", init.ms);

term.chapter("Detection proposes the config");
term.note(
  "Migrate from GitHub, step 3: let detection propose .platform/ci.ts, policy.ts and AGENTS.md.",
);
let proposal: { status?: string; planId?: string | null; changeId?: string | null } | null = null;
for (let i = 0; i < 8; i++) {
  const r = await term.run(
    `gittifacts propose-platform-config --repo-id ${created.projectId} --wait-sec 45`,
    `${gf} propose-platform-config --repo-id ${created.projectId} --wait-sec 45`,
    { env, cwd: work },
  );
  proposal = parseJson(r.stdout);
  if (proposal?.status !== "pending" && proposal?.status !== "running") break;
}
term.metric("timeToProposalSec", Math.round((term.now - t0) / 100) / 10);

if (proposal?.planId) {
  term.chapter("The Plan (drafted by the platform)");
  await term.run(
    `curl -s -H "Authorization: Bearer $GITTIFACTS_TOKEN" ${HOST}/api/v1/plans/${proposal.planId} | jq '.plan | {title, status, risks: .riskDeclarations, acceptanceCriteria}'`,
    `curl -s -H "Authorization: Bearer $GITTIFACTS_TOKEN" ${HOST}/api/v1/plans/${proposal.planId} | jq '.plan | {title, status, risks: .riskDeclarations, acceptanceCriteria}'`,
    { env },
  );
}
if (proposal?.changeId) {
  term.chapter("The Change (Lane 2: it touches .platform/**)");
  await term.run(
    `gittifacts wait ${proposal.changeId} --until lane_assigned`,
    `${gf} wait ${proposal.changeId} --until lane_assigned --timeout 600 | jq '{reached, reason, status: .change.status, lane: .change.lane}'`,
    { env, cwd: work },
  );
  await term.run(
    `gittifacts get-change-status ${proposal.changeId} | jq '{status: .change.status, lane: .classification.lane, raisedBy: [.classification.reasons[] | select(.lane > 0) | .code]}'`,
    `${gf} get-change-status ${proposal.changeId} | jq '{status: .change.status, lane: .classification.lane, raisedBy: [.classification.reasons[] | select(.lane > 0) | .code]}'`,
    { env, cwd: work },
  );
  term.metric("timeToLaneSec", Math.round((term.now - t0) / 100) / 10);
  term.note(`A human approves the Plan, then reviews ${HOST}/changes/${proposal.changeId}`);
}
term.save(join(out, "casts", "12-import-github.json"));
mergeState(state, {
  importProjectId: created.projectId,
  importPlanId: proposal?.planId,
  importChangeId: proposal?.changeId,
});
process.exit(0);
