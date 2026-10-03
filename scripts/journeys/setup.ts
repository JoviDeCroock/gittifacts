/**
 * The agent's side of the human journeys, done off camera with the same agent token:
 *
 *   pnpm tsx scripts/journeys/setup.ts plan      --state s.json --agent-file agent.json   # journey 3
 *   pnpm tsx scripts/journeys/setup.ts implement --state s.json --agent-file agent.json   # journey 4
 *   pnpm tsx scripts/journeys/setup.ts queue     --state s.json --agent-file agent.json   # journey 6
 *   pnpm tsx scripts/journeys/setup.ts approve   --state s.json --cookie-jar cookies.txt  # journey 6
 *
 * Works on state.projectId (journey 11's project, a preact-app the human owns). Ids go back to
 * state.json. `approve` is the one human act here: it approves state.queueChangeIds at their heads.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createPlatformClient } from "../../packages/mcp/src/client.js";
import { HOST } from "./lib/journey.js";
import { Term } from "./lib/term.js";
import { agentToken, mergeState, readState } from "./terminal/common.js";
import { gitWithGrant, ok, waitFor } from "./terminal/mcp-kit.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    state: { type: "string" },
    "agent-file": { type: "string" },
    "cookie-jar": { type: "string" },
  },
});
const cmd = positionals[0];
const statePath = values.state ?? "state.json";
const state = readState(statePath) as {
  projectId?: string;
  planId?: string;
  queueChangeIds?: string[];
};
const quiet = new Term({ number: "00", slug: "setup", title: "setup", host: HOST, prompt: "$ " });

async function agent() {
  return createPlatformClient(`${HOST}/mcp`, agentToken(values["agent-file"]), {
    clientName: "journey-setup",
  });
}

/** start_change → clone → edit → push → lane → request_review. */
async function change(
  mcp: Awaited<ReturnType<typeof agent>>,
  title: string,
  edit: (dir: string) => void,
  planId?: string,
): Promise<string> {
  const repoId = state.projectId as string;
  const { change: c, remote } = ok(
    "start_change",
    await mcp.tools.start_change({
      repoId,
      title,
      category: planId ? "feature" : "chore",
      ...(planId ? { planId } : {}),
      idempotencyKey: `journey-${title.replace(/[^\x21-\x7e]+/g, "-")}-${Date.now()}`,
    }),
  );
  const dir = gitWithGrant(quiet, remote, "clone", c.id);
  edit(dir);
  gitWithGrant(quiet, remote, "commit-push", c.id, title);
  return c.id;
}

const edit = (dir: string, file: string, from: string, to: string) => {
  const p = join(dir, file);
  const text = readFileSync(p, "utf8");
  if (!text.includes(from)) throw new Error(`${file}: pattern not found`);
  writeFileSync(p, text.replace(from, to));
};

if (!state.projectId && cmd !== "approve")
  throw new Error("state.projectId is missing (run journey 11 first)");

if (cmd === "plan") {
  const mcp = await agent();
  const { plan } = ok(
    "create_plan",
    await mcp.tools.create_plan({
      repoId: state.projectId as string,
      title: "Show the server time when the page opens",
      intent:
        "Today the page says “not loaded” until someone clicks Server time, so the first screen shows no real data.\n\nLoad the server time once when the app starts. The Server time button keeps refreshing it, and a failed request shows its error instead of “not loaded”.",
      acceptanceCriteria: [
        "Opening / shows the server time without a click",
        "The Server time button still refreshes it",
        "If /api/time fails, the page shows the error, not “not loaded”",
      ],
      outOfScope: ["Changing GET /api/time", "Polling or live updates"],
      scopePaths: ["src/client/**"],
      affectedRoutes: ["/"],
      idempotencyKey: `journey-plan-${state.projectId}-${Date.now()}`,
    }),
  );
  mergeState(statePath, { planId: plan.id });
  console.log(JSON.stringify({ planId: plan.id, url: `${HOST}/plans/${plan.id}` }));
} else if (cmd === "implement") {
  const mcp = await agent();
  if (!state.planId) throw new Error("state.planId is missing");
  const id = await change(
    mcp,
    "Show the server time when the page opens",
    (dir) =>
      edit(
        dir,
        "src/client/App.tsx",
        "const clock = createServerClock();\n",
        "const clock = createServerClock();\n// Load once at startup; the button below refreshes it.\nvoid clock.refresh();\n",
      ),
    state.planId,
  );
  await waitFor(quiet, mcp, id, "tour_ready");
  ok("request_review", await mcp.tools.request_review({ changeId: id }));
  mergeState(statePath, { reviewChangeId: id });
  console.log(JSON.stringify({ reviewChangeId: id, url: `${HOST}/changes/${id}` }));
} else if (cmd === "lane2") {
  // A planless behavior change for the phone review (journey 4, --mobile).
  const mcp = await agent();
  const variant = positionals[1] ?? "a";
  const id =
    variant === "a"
      ? await change(mcp, "Show the count in the browser tab title", (dir) =>
          edit(
            dir,
            "src/client/App.tsx",
            "const counter = createCounter();\n",
            "const counter = createCounter();\n// Keep the tab title in sync with the count.\ncounter.count.subscribe((n) => {\n  document.title = `(${n}) Preact + signals`;\n});\n",
          ),
        )
      : variant === "c"
        ? await change(mcp, "Cap the counter at 99", (dir) =>
            edit(
              dir,
              "src/client/state.ts",
              "count.value += 1;",
              "count.value = Math.min(99, count.value + 1);",
            ),
          )
        : await change(mcp, "Disable Reset while the count is at its start", (dir) =>
            edit(
              dir,
              "src/client/App.tsx",
              '<button type="button" onClick={counter.reset}>',
              '<button type="button" onClick={counter.reset} disabled={counter.count.value === 0}>',
            ),
          );
  await waitFor(quiet, mcp, id, "tour_ready");
  ok("request_review", await mcp.tools.request_review({ changeId: id }));
  mergeState(statePath, { reviewChangeIdMobile: id });
  console.log(JSON.stringify({ reviewChangeIdMobile: id, url: `${HOST}/changes/${id}` }));
} else if (cmd === "queue2") {
  // A second round on the README as it is after "queue" merged: two edits of the same line again.
  const mcp = await agent();
  const readme = "README.md";
  const dev = "npx wrangler dev       # http://localhost:8787 (runs the build first)";
  const ids = [
    await change(mcp, "README: say how to stop the dev server", (d) =>
      edit(
        d,
        readme,
        dev,
        "npx wrangler dev       # http://localhost:8787 (builds first; Ctrl-C stops it)",
      ),
    ),
    await change(mcp, "README: run the dev server on port 8788", (d) =>
      edit(
        d,
        readme,
        dev,
        "npx wrangler dev --port 8788  # http://localhost:8788 (runs the build first)",
      ),
    ),
    await change(mcp, "README: agents start from a Plan", (d) =>
      edit(
        d,
        readme,
        "before changing anything.",
        "before changing anything, and start every change from an approved Plan.",
      ),
    ),
  ];
  for (const id of ids) {
    await waitFor(quiet, mcp, id, "lane_assigned");
    ok("request_review", await mcp.tools.request_review({ changeId: id }));
  }
  mergeState(statePath, { queueChangeIds: ids });
  console.log(JSON.stringify({ queueChangeIds: ids }));
} else if (cmd === "queue3") {
  // A round that works on any README: two Changes rewrite its title line (the resolver has to
  // merge them, usually with a line of its own, so a person re-approves), one adds a closing line.
  const mcp = await agent();
  const readme = "README.md";
  const title = (dir: string) => {
    const line = readFileSync(join(dir, readme), "utf8")
      .split("\n")
      .find((l) => l.startsWith("# "));
    if (line === undefined) throw new Error("README has no title line");
    return line;
  };
  const ids = [
    await change(mcp, "README: say what the project is in its title", (d) =>
      edit(d, readme, title(d), `${title(d)} (a Preact and signals app on Workers)`),
    ),
    await change(mcp, "README: name the platform in the title", (d) =>
      edit(d, readme, title(d), `${title(d)}, built through gittifacts`),
    ),
    await change(mcp, "README: end with where to ask questions", (d) => {
      const p = join(d, readme);
      writeFileSync(p, `${readFileSync(p, "utf8").trimEnd()}\n\nQuestions: open a Plan.\n`);
    }),
  ];
  for (const id of ids) {
    await waitFor(quiet, mcp, id, "lane_assigned");
    ok("request_review", await mcp.tools.request_review({ changeId: id }));
  }
  mergeState(statePath, { queueChangeIds: ids });
  console.log(JSON.stringify({ queueChangeIds: ids }));
} else if (cmd === "queue") {
  const mcp = await agent();
  const readme = "README.md";
  const ids = [
    await change(mcp, "README: say how to run the tests in watch mode", (d) =>
      edit(
        d,
        readme,
        "pnpm test              # vitest (state and API; no DOM needed)",
        "pnpm test              # vitest (state and API; no DOM needed)\npnpm test -- --watch   # re-run on save",
      ),
    ),
    await change(mcp, "README: name the API routes in the intro", (d) =>
      edit(
        d,
        readme,
        "The Worker only handles `/api/*`;",
        "The Worker only handles `/api/*` (`/api/time`, `/api/health`);",
      ),
    ),
    await change(mcp, "README: link the gittifacts docs from the intro", (d) =>
      edit(
        d,
        readme,
        "The Worker only handles `/api/*`;",
        `The Worker only handles \`/api/*\` ([gittifacts docs](${HOST}/docs));`,
      ),
    ),
  ];
  for (const id of ids) {
    await waitFor(quiet, mcp, id, "lane_assigned");
    ok("request_review", await mcp.tools.request_review({ changeId: id }));
  }
  mergeState(statePath, { queueChangeIds: ids });
  console.log(JSON.stringify({ queueChangeIds: ids }));
} else if (cmd === "approve") {
  const { cookiesFromJar } = await import("./lib/journey.js");
  const jar = values["cookie-jar"];
  if (!jar) throw new Error("pass --cookie-jar");
  const cookie = cookiesFromJar(jar, new URL(HOST).hostname)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  for (const id of state.queueChangeIds ?? []) {
    const h = {
      cookie,
      origin: HOST,
      "content-type": "application/json",
      accept: "application/json",
    };
    const c = (await (await fetch(`${HOST}/api/v1/changes/${id}`, { headers: h })).json()) as {
      change: { headSha: string; status: string };
    };
    const res = await fetch(`${HOST}/api/v1/changes/${id}/review`, {
      method: "POST",
      headers: { ...h, "idempotency-key": `journey-approve-${id}-${c.change.headSha}` },
      body: JSON.stringify({
        decision: "approve",
        headSha: c.change.headSha,
        comment: "Docs only; fine to merge.",
      }),
    });
    console.log(id, c.change.status, "→", res.status);
  }
} else {
  console.error("usage: setup.ts plan|implement|queue|approve …");
  process.exit(2);
}
process.exit(0);
