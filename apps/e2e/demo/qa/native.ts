/**
 * Live demo (not part of the suite): a static-site repo, a Plan with three criteria, an agent's Change
 * with a split-the-bill page that has a rounding bug, then the human presses Run QA on the Change page.
 * Screenshots → $OUT. Prints timings and the run's cost.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE ?? "https://gittifacts.decroockjovi.workers.dev";
const OUT = process.env.OUT as string;
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const log = (m: string, x?: unknown) =>
  console.log(
    `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`,
    x === undefined ? "" : JSON.stringify(x),
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(
  method: string,
  path: string,
  auth: Record<string, string>,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      origin: BASE,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...auth,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

const stamp = Date.now().toString(36);
const email = `qa-demo-${stamp}@example.com`;
const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
  method: "POST",
  headers: { origin: BASE, "content-type": "application/json" },
  body: JSON.stringify({
    email,
    password: `qa-demo-${stamp}-correct-horse`,
    name: `QA demo ${stamp}`,
  }),
});
const cookie = (
  signUp.headers.getSetCookie().find((c) => c.includes("session_token=")) ?? ""
).split(";")[0] as string;
if (!signUp.ok || !cookie) throw new Error(`sign-up ${signUp.status} ${await signUp.text()}`);
const human = { cookie };
const { token } = await api<{ token: string }>("POST", "/api/v1/principals/agents", human, {
  name: `qa-demo-agent-${stamp}`,
  scopes: ["repo:read", "plan:create", "change:create"],
});
const agent = { authorization: `Bearer ${token}` };
log("signed up + agent");

const { repo } = await api<{ repo: { id: string; name: string } }>("POST", "/api/v1/repos", human, {
  name: `qa-demo-${stamp}`,
  template: "static-site",
});
log("repo", repo.id);

const { plan } = await api<{ plan: { id: string } }>("POST", "/api/v1/plans", agent, {
  repoId: repo.id,
  title: "Split the bill page",
  intent:
    "A page that splits an amount between people in whole cents, so a group can settle a bill fairly.",
  acceptanceCriteria: [
    "Entering 100 for 3 people and pressing Split lists exactly three shares",
    "The shares add up exactly to the amount: 100 split between 3 people shows a total of €100.00",
    "Splitting between 0 people shows the message 'Enter at least one person.' and no shares",
  ],
  affectedRoutes: ["/split/"],
  scopePaths: ["public/**"],
});
await api("POST", `/api/v1/plans/${plan.id}/approve`, human, {});
log("plan approved", plan.id);

// Wait for the first Change (bootstrap) to finish so main has the template.
for (;;) {
  const r = await api<{ repo: { defaultBranchSha?: string | null } }>(
    "GET",
    `/api/v1/repos/${repo.id}`,
    human,
  ).catch(() => null);
  if (r !== null) break;
  await sleep(2000);
}
let started: {
  change: { id: string };
  remote: { url: string; username: string; token: string; branch: string };
} | null = null;
for (let i = 0; i < 40 && started === null; i++) {
  started = await api<typeof started & object>("POST", "/api/v1/changes", agent, {
    repoId: repo.id,
    title: "Add a split-the-bill page",
    category: "feature",
    planId: plan.id,
  }).catch(async (e) => {
    log("start change retry", String(e).slice(0, 160));
    await sleep(3000);
    return null;
  });
}
if (started === null) throw new Error("could not start the change");
const changeId = started.change.id;
log("change", changeId);
writeFileSync(
  join(OUT, "..", "qa-native-state.json"),
  JSON.stringify({ cookie, token, changeId, repoId: repo.id }),
);

const dir = mkdtempSync(join(tmpdir(), "qa-demo-"));
const remote = new URL(started.remote.url);
remote.username = started.remote.username;
remote.password = started.remote.token;
execFileSync("git", ["clone", "-q", remote.toString(), dir]);
mkdirSync(join(dir, "public/split"), { recursive: true });
writeFileSync(
  join(dir, "public/split/index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Split the bill</title>
    <meta name="description" content="Split an amount between people in whole cents." />
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <header><nav><a href="/">Home</a> · <a href="/split/">Split</a></nav></header>
    <main>
      <h1>Split the bill</h1>
      <p>Shares are in whole cents, and they always add up to the amount.</p>
      <p><label>Amount (EUR) <input id="amount" name="amount" inputmode="decimal" /></label></p>
      <p><label>People <input id="people" name="people" inputmode="numeric" /></label></p>
      <p><button id="split" type="button">Split</button></p>
      <p id="error" role="alert"></p>
      <ol id="shares"></ol>
      <p id="total"></p>
    </main>
    <script src="/split/app.js"></script>
  </body>
</html>
`,
);
writeFileSync(
  join(dir, "public/split/app.js"),
  `const fmt = (c) => "€" + (c / 100).toFixed(2);
document.getElementById("split").addEventListener("click", () => {
  const cents = Math.round(Number(document.getElementById("amount").value) * 100);
  const people = Number(document.getElementById("people").value);
  const list = document.getElementById("shares");
  list.innerHTML = "";
  document.getElementById("total").textContent = "";
  if (!Number.isInteger(people) || people < 1) {
    document.getElementById("error").textContent = "Enter at least one person.";
    return;
  }
  document.getElementById("error").textContent = "";
  const share = Math.floor(cents / people); // BUG: the remainder cents are dropped
  const shares = Array.from({ length: people }, () => share);
  shares.forEach((s, i) => { const li = document.createElement("li"); li.textContent = "Person " + (i + 1) + ": " + fmt(s); list.append(li); });
  document.getElementById("total").textContent = "Total: " + fmt(shares.reduce((a, b) => a + b, 0));
});
`,
);
execFileSync("git", ["-C", dir, "add", "-A"]);
execFileSync("git", [
  "-C",
  dir,
  "-c",
  "user.name=qa-demo-agent",
  "-c",
  "user.email=agent@example.com",
  "commit",
  "-q",
  "-m",
  "Add a split-the-bill page",
]);
execFileSync("git", ["-C", dir, "push", "-q", "origin", `HEAD:${started.remote.branch}`]);
log("pushed");

for (;;) {
  const { change } = await api<{ change: { status: string; lane: number | null } }>(
    "GET",
    `/api/v1/changes/${changeId}`,
    agent,
  );
  if (change.status === "awaiting-review" || change.status === "failing") {
    log("graded", change);
    break;
  }
  await sleep(5000);
}

const browser = await chromium.launch();
for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: name === "phone" ? 2 : 1 });
  const [k, v] = cookie.split("=");
  await ctx.addCookies([
    {
      name: k as string,
      value: v as string,
      url: BASE,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/changes/${changeId}`);
  const qa = page.getByTestId("qa");
  await qa.scrollIntoViewIfNeeded();
  if (name === "desktop") {
    await qa.screenshot({ path: join(OUT, "16-qa-native-before.png") });
    const asked = Date.now();
    await qa.getByTestId("qa-run").click();
    await page.waitForTimeout(4000);
    await qa.screenshot({ path: join(OUT, "16-qa-native-running.png") });
    await page
      .locator('[data-testid="qa"][data-status="done"], [data-testid="qa"][data-status="failed"]')
      .waitFor({ timeout: 300_000 });
    log("QA finished in the page", { seconds: (Date.now() - asked) / 1000 });
  }
  await page.waitForTimeout(2500);
  await qa.scrollIntoViewIfNeeded();
  await qa.screenshot({ path: join(OUT, `16-qa-native-result-${name}.png`) });
  await page.screenshot({ path: join(OUT, `16-qa-native-page-${name}.png`), fullPage: true });
  await ctx.close();
}
await browser.close();
const { runs } = await api<{ runs: Array<Record<string, unknown>> }>(
  "GET",
  `/api/v1/changes/${changeId}/qa`,
  human,
);
writeFileSync(join(OUT, "16-qa-native-run.json"), JSON.stringify(runs[0], null, 2));
const r = runs[0] as {
  status: string;
  summary: unknown;
  laneBefore: number;
  laneAfter: number;
  costUsd: number;
  wallMs: number;
  createdAt: string;
  finishedAt: string;
};
log("run", {
  status: r.status,
  summary: r.summary,
  lanes: [r.laneBefore, r.laneAfter],
  costUsd: r.costUsd,
  wallMs: r.wallMs,
  requestToFinishMs: Date.parse(r.finishedAt) - Date.parse(r.createdAt),
});
console.log(
  JSON.stringify({ changeId, repoId: repo.id, url: `${BASE}/changes/${changeId}#qa`, email }),
);
