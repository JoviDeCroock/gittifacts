/**
 * Journey 10 (capture): an anonymous agent with only a shell goes from /start to its first green
 * check with the CLI. No account, a cold npx cache, a fresh CLI config directory.
 *
 *   pnpm tsx scripts/journeys/terminal/10-cli-onboarding.ts --out <dir> [--state <state.json>]
 *
 * Writes <out>/casts/10-cli-onboarding.json (replay it with replay.ts) and adds the project's
 * claimUrl to state.json for the claim journey.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Term } from "../lib/term.js";
import { CLI, HOST, mergeState, parseJson, terminalArgs } from "./common.js";

const { out, state } = terminalArgs();
const term = new Term({
  number: "10",
  slug: "cli-onboarding",
  title: "Anonymous agent: CLI to the first green check",
  subtitle: "An agent with a shell and no account: /start → init → wait → status → preview.",
  host: HOST,
  prompt: "agent@sandbox:~$ ",
});

const home = mkdtempSync(join(tmpdir(), "gf-j10-"));
const work = join(home, "work");
mkdirSync(work);
const env = {
  GITTIFACTS_CONFIG_DIR: join(home, "config"),
  npm_config_cache: join(home, "npm-cache"),
  npm_config_update_notifier: "false",
  // A clean agent sandbox: no user npmrc (its warnings are this machine's, not the product's).
  npm_config_userconfig: join(home, ".npmrc"),
  NO_COLOR: "1",
};
const name = `journey-cli-${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "")}`;

term.chapter("Read the front door");
term.note("The agent was told one thing: use gittifacts. It starts at /start.");
await term.run(`curl -s ${HOST}/start | sed -n '1,22p'`, `curl -s ${HOST}/start | sed -n '1,22p'`, {
  env,
});

term.chapter("Create a project (no account)");
const initAt = term.now;
const init = await term.run(
  `npx -y ${CLI} --host ${HOST} init --template workers-api --name ${name} --clone`,
  `npx -y ${CLI} --host ${HOST} init --template workers-api --name ${name} --clone`,
  { env, cwd: work },
);
const created = parseJson<{
  projectId: string;
  claimUrl?: string | null;
  previewUrl?: string | null;
  bootstrapChangeId?: string | null;
  nextSteps?: Array<{ call?: string }>;
}>(init.stdout);
if (init.code !== 0 || created === null) {
  term.note(`init failed (exit ${init.code})`);
  term.save(join(out, "casts", "10-cli-onboarding.json"));
  process.exit(1);
}
term.metric("initCommandMs", init.ms);
const changeId =
  created.bootstrapChangeId ?? /changeId: "([^"]+)"/.exec(created.nextSteps?.[0]?.call ?? "")?.[1];
const dir = join(work, name);

term.chapter("Wait for the first green");
term.note("nextSteps: wait on the bootstrap Change (first CI run + preview).");
const alias = `npx -y ${CLI}`;
const wait = await term.run(
  `gittifacts wait ${changeId} --until evidence_ready`,
  `${alias} wait ${changeId} --until evidence_ready --timeout 900`,
  { env, cwd: dir },
);
const greenAt = term.now;
term.metric("timeToFirstGreenSec", Math.round((greenAt - initAt) / 100) / 10);
term.metric("waitExit", wait.code);

term.chapter("Read the result");
await term.run(
  `gittifacts get-change-status ${changeId} --human`,
  `${alias} get-change-status ${changeId} --human`,
  { env, cwd: dir },
);

if (created.previewUrl) {
  term.chapter("Open the preview");
  const pv = await term.run(
    `curl -s ${created.previewUrl}/health`,
    `curl -s -m 60 ${created.previewUrl}/health; echo`,
    {
      env,
    },
  );
  term.metric("previewHealthMs", pv.ms);
  await term.run(`curl -s ${created.previewUrl}/`, `curl -s -m 60 ${created.previewUrl}/; echo`, {
    env,
  });
}

term.chapter("Hand the claim link to a human");
term.note(`claimUrl: ${created.claimUrl ?? "(none)"}`);
term.note("Until a human claims it: previews only, no Lane 0, expires in 7 days.");

term.save(join(out, "casts", "10-cli-onboarding.json"));
mergeState(state, {
  claimUrl: created.claimUrl ?? undefined,
  cliProjectId: created.projectId,
  cliChangeId: changeId,
});
console.error(`\nTTFG ${term.cast.metrics.timeToFirstGreenSec}s; project ${created.projectId}`);
