/**
 * Live demo helper: render a PR's gittifacts summary comment and lane check run the way GitHub
 * renders Markdown (GitHub's own /markdown API, gfm, repo context) and screenshot them, since the
 * repo is private and a headless browser has no GitHub session. Images load from their real URLs.
 *   OUT=… REPO=ReSynapse/fixture-lib PR=17 tsx github-render.ts
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const { OUT, REPO, PR } = process.env as Record<string, string>;
const gh = (args: string[], input?: string) =>
  execFileSync("gh", args, { input, encoding: "utf8", maxBuffer: 1 << 26 });
const comments = JSON.parse(
  gh(["api", `repos/${REPO}/issues/${PR}/comments?per_page=100`]),
) as Array<{ body: string; updated_at: string }>;
const summary = comments.find((c) => c.body.includes("gittifacts:summary"));
const head = JSON.parse(gh(["api", `repos/${REPO}/pulls/${PR}`])).head.sha as string;
const runs = JSON.parse(
  gh(["api", `repos/${REPO}/commits/${head}/check-runs?check_name=gittifacts/lane`]),
).check_runs as Array<{
  output: { title: string; summary: string; text: string | null };
  conclusion: string | null;
}>;
const run = runs[0];
const render = (md: string) =>
  gh(["api", "markdown", "-f", `text=${md}`, "-f", "mode=gfm", "-f", `context=${REPO}`]);
const page = (
  title: string,
  html: string,
) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5/github-markdown-light.css">
<style>body{margin:0;padding:24px;background:#fff}.box{max-width:880px;border:1px solid #d0d7de;border-radius:6px}.hd{background:#f6f8fa;border-bottom:1px solid #d0d7de;padding:8px 16px;font:14px -apple-system,system-ui;color:#57606a}.markdown-body{padding:16px}</style></head>
<body><div class="box"><div class="hd">${title}</div><div class="markdown-body">${html}</div></div></body></html>`;
const browser = await chromium.launch();
const shoot = async (name: string, title: string, md: string, open: boolean) => {
  const file = join(OUT, `${name}.html`);
  writeFileSync(file, page(title, render(md)));
  const p = await browser.newPage({ viewport: { width: 940, height: 600 } });
  await p.goto(`file://${file}`);
  if (open)
    await p.evaluate(() =>
      document.querySelectorAll("details").forEach((d) => d.setAttribute("open", "")),
    );
  await p.waitForTimeout(2500);
  await p.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  await p.close();
};
if (summary) {
  await shoot(
    `16-qa-github-summary${process.env.TAG ? `-${process.env.TAG}` : ""}`,
    `gittifacts commented (summary, edited ${summary.updated_at})`,
    summary.body,
    false,
  );
  await shoot(
    `16-qa-github-summary-open${process.env.TAG ? `-${process.env.TAG}` : ""}`,
    "gittifacts summary comment, folds open",
    summary.body,
    true,
  );
  writeFileSync(
    join(OUT, `16-qa-github-summary${process.env.TAG ? `-${process.env.TAG}` : ""}.md`),
    summary.body,
  );
}
if (run) {
  await shoot(
    `16-qa-github-check${process.env.TAG ? `-${process.env.TAG}` : ""}`,
    `gittifacts/lane: ${run.output.title} (${run.conclusion})`,
    `${run.output.summary}\n\n${run.output.text ?? ""}`,
    true,
  );
  writeFileSync(
    join(OUT, `16-qa-github-check${process.env.TAG ? `-${process.env.TAG}` : ""}.json`),
    JSON.stringify(run, null, 2),
  );
}
await browser.close();
console.log(JSON.stringify({ summary: summary !== undefined, check: run?.output.title }));
