/**
 * Journey 11 (capture): an agent works through MCP with the typed client (mcp-tada):
 * create_project → push a change to its fork → wait_for_change → get_tour → request_review.
 *
 *   pnpm tsx scripts/journeys/terminal/11-mcp-agent.ts --out <dir> --agent-file <agent.json>
 *
 * The agent token belongs to a human's agent (POST /api/v1/principals/agents), so the project is
 * claimed and the human can review it in journeys 3, 4 and 6 (ids go to state.json).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPlatformClient } from "../../../packages/mcp/src/client.js";
import { Term } from "../lib/term.js";
import { agentToken, HOST, mergeState, terminalArgs } from "./common.js";
import { abridge, gitWithGrant, ok, waitFor } from "./mcp-kit.js";

const { out, state, agentFile } = terminalArgs();
const token = agentToken(agentFile);
const term = new Term({
  number: "11",
  slug: "mcp-agent",
  title: "Agent over MCP: project → push → wait → tour",
  subtitle:
    "A signed-in human's agent, MCP only (typed client): create_project, push, wait_for_change, get_tour.",
  host: HOST,
  prompt: "mcp> ",
});
const show = (call: string) => term.typed(call);
const mcp = await createPlatformClient(`${HOST}/mcp`, token, { clientName: "journey-11-agent" });
const stamp = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");

term.chapter("Who am I");
show("whoami({})");
const me = ok("whoami", await mcp.tools.whoami());
term.print(
  abridge({
    principal: me.name,
    kind: me.kind,
    scopes: me.scopes,
    repos: `${me.repos.length} repos`,
  }),
);

term.chapter("create_project");
const name = `journey-mcp-${stamp}`;
show(`create_project({ template: "preact-app", name: "${name}" })`);
const createdAt = term.now;
const created = ok(
  "create_project",
  await mcp.tools.create_project({
    template: "preact-app",
    name,
    idempotencyKey: `journey-11-${name}`,
  }),
);
term.metric("createProjectMs", term.now - createdAt);
term.print(
  abridge({
    projectId: created.projectId,
    previewUrl: created.previewUrl,
    bootstrapChangeId: created.bootstrapChangeId,
    remote: { url: "…", branch: created.remote?.branch, changeId: created.remote?.changeId },
    nextSteps: created.nextSteps.slice(0, 3).map((s) => s.title),
  }),
);
const projectId = created.projectId;
const bootstrap = created.bootstrapChangeId;
if (bootstrap) {
  term.chapter("Wait for the first green");
  await waitFor(term, mcp, bootstrap, "evidence_ready");
  term.metric("timeToFirstGreenSec", Math.round((term.now - createdAt) / 100) / 10);
}

const remote = created.remote;
if (!remote) throw new Error("create_project returned no remote for the first change");
const changeId = remote.changeId;
term.chapter("Push a change to the fork");
const grant = { url: remote.url, token: remote.token, branch: remote.branch };
const dir = gitWithGrant(term, grant, "clone", changeId);
const app = join(dir, "src/client/App.tsx");
const { readFileSync } = await import("node:fs");
const src = readFileSync(app, "utf8");
writeFileSync(
  app,
  src.replace(
    "        doubled: {counter.double}\n",
    '        doubled: {counter.double}{" "}\n        <button type="button" onClick={counter.reset}>\n          Reset\n        </button>\n',
  ),
);
term.typed(`edit src/client/App.tsx  # add a Reset button next to the counter`);
gitWithGrant(term, grant, "commit-push", changeId, "Add a Reset button next to the counter");
const pushedAt = term.now;

term.chapter("wait_for_change → evidence");
await waitFor(term, mcp, changeId, "evidence_ready");
term.metric("timeToEvidenceSec", Math.round((term.now - pushedAt) / 100) / 10);
await waitFor(term, mcp, changeId, "lane_assigned");

term.chapter("get_tour");
await waitFor(term, mcp, changeId, "tour_ready");
term.metric("timeToTourSec", Math.round((term.now - pushedAt) / 100) / 10);
show(`get_tour({ changeId: "${changeId}" })`);
const { tour } = ok("get_tour", await mcp.tools.get_tour({ changeId }));
term.print(
  abridge({
    stops: tour.stops.map((s) => `[${s.kind}] ${s.title} (${s.verdict})`),
    leastConfident: tour.leastConfident,
  }),
);
show(`get_change_status({ changeId: "${changeId}" })`);
const st = ok("get_change_status", await mcp.tools.get_change_status({ changeId }));
term.print(
  abridge({
    status: st.change.status,
    lane: st.classification?.lane,
    reasons: (st.classification?.reasons ?? [])
      .filter((r) => r.lane > 0)
      .map((r) => `${r.code}: ${r.message}`),
    previewUrl: st.previewUrl,
  }),
);

term.chapter("Ask a human");
show(`request_review({ changeId: "${changeId}" })`);
const rr = ok("request_review", await mcp.tools.request_review({ changeId }));
term.print(abridge(rr));
term.note(`A human reviews it at ${HOST}/changes/${changeId}`);

term.save(join(out, "casts", "11-mcp-agent.json"));
mergeState(state, { projectId, mcpChangeId: changeId, reviewChangeIdMobile: changeId });
process.exit(0);
