/**
 * Replays a captured terminal session (terminal/*.ts → casts/<slug>.json) in xterm.js and records
 * it. Idle gaps over 2 s play as 1 s with a "⏩ N s" marker; the corner clock shows the real
 * elapsed time, so the true time-to-green stays visible.
 *
 *   pnpm tsx scripts/journeys/replay.ts <out>/casts/<slug>.json --out <dir>
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { titleCardHtml } from "./lib/cards.js";
import { Recorder } from "./lib/recorder.js";
import type { Cast } from "./lib/term.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, drop: { type: "string", multiple: true } },
});
const castPath = positionals[0];
if (!castPath || !values.out) {
  console.error("usage: replay.ts <cast.json> --out <dir> [--drop <regex>]…");
  process.exit(2);
}
const cast = JSON.parse(readFileSync(castPath, "utf8")) as Cast;
const here = dirname(fileURLToPath(import.meta.url));

/** Labels for the numbers worth a badge on screen. */
const BADGES: Record<string, (v: number | string) => string> = {
  timeToFirstGreenSec: (v) => `Time to first green: ${v} s`,
  timeToEvidenceSec: (v) => `Push → evidence ready: ${v} s`,
  timeToTourSec: (v) => `Push → tour ready: ${v} s`,
  timeToProposalSec: (v) => `Import → detection Plan + Change: ${v} s`,
  initCommandMs: (v) =>
    `init returned in ${Math.round(Number(v) / 100) / 10} s (cold npx download included)`,
  createProjectMs: (v) => `create_project returned in ${Math.round(Number(v) / 100) / 10} s`,
  timeToLaneSec: (v) => `Import → lane assigned: ${v} s`,
};
// Lines matching --drop (machine-local noise such as a user npmrc warning) are removed.
const drops = (values.drop ?? []).map((r) => new RegExp(r));
const events = cast.events
  .map((e) => {
    if (e.k === "metric") {
      const [name, value] = e.d.split("=");
      const badge = name ? BADGES[name] : undefined;
      return badge && value !== undefined ? { ...e, label: badge(value) } : null;
    }
    if ((e.k === "out" || e.k === "err") && drops.length > 0) {
      const d = e.d
        .split("\n")
        .filter((l) => !drops.some((r) => r.test(l)))
        .join("\n");
      return d === "" ? null : { ...e, d };
    }
    return e;
  })
  .filter((e) => e !== null);

const out = resolve(values.out);
const file = join(out, `${cast.number}-${cast.slug}.webm`);
const size = { width: 1280, height: 800 };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: size });
const card = titleCardHtml({
  number: cast.number,
  title: cast.title,
  ...(cast.subtitle ? { subtitle: cast.subtitle } : {}),
  persona: "agent",
  mode: "live",
  date: cast.date,
  viewport: "Terminal replay 1280×800",
  host: new URL(cast.host).host,
});
await page.addInitScript(
  ([c, h]) => {
    (window as unknown as { __CAST: unknown; __CARD_HTML: string }).__CAST = c;
    (window as unknown as { __CARD_HTML: string }).__CARD_HTML = h;
  },
  [{ ...cast, events }, card] as const,
);
await page.route("https://replay.journeys.local/", (r) =>
  r.fulfill({
    contentType: "text/html",
    body: readFileSync(join(here, "terminal/replay.html"), "utf8"),
  }),
);
await page.goto("https://replay.journeys.local/");
await page.waitForFunction(() => "Terminal" in window, null, { timeout: 30_000 });
const rec = new Recorder({ out: file, ...size, bitrate: "600k" });
await rec.start(page);
await page.waitForTimeout(300);
const startedAtVideoMs = rec.videoMs;
await page.evaluate(() => {
  void (window as unknown as { __start: () => Promise<void> }).__start();
});
await page.waitForFunction(
  () => (window as unknown as { __done?: boolean }).__done === true,
  null,
  {
    timeout: 15 * 60_000,
    polling: 250,
  },
);
await rec.stop();

const chapters = (
  await page.evaluate(
    () => (window as unknown as { __chapters: Array<{ at: number; label: string }> }).__chapters,
  )
).map((c) => ({ t: Math.round((startedAtVideoMs + c.at) / 100) / 10, label: c.label }));
await browser.close();
const meta = {
  file: basename(file),
  title: cast.title,
  persona: "agent",
  viewport: "1280x800",
  mode: "live",
  durationSec: Math.round(rec.videoMs / 100) / 10,
  sizeMB: Math.round(statSync(file).size / 10_000) / 100,
  realElapsedSec: Math.round((cast.events.at(-1)?.t ?? 0) / 1000),
  chapters,
  metrics: cast.metrics,
};
writeFileSync(join(out, `${cast.number}-${cast.slug}.json`), `${JSON.stringify(meta, null, 2)}\n`);
console.log(JSON.stringify({ file, durationSec: meta.durationSec, sizeMB: meta.sizeMB }));
