/**
 * Records one browser journey against the live platform.
 *
 *   pnpm tsx scripts/journeys/record.ts <journey> [--mobile] --out <dir> \
 *     [--cookie-jar <human cookies.txt>] [--state <state.json>]
 *
 * <journey> is a module in ./human (e.g. 01-first-visit). The video lands in
 * <out>/<NN-slug>[-mobile].webm with a <same>.json of chapters, numbers and console/network
 * problems next to it. `state.json` holds the ids the journeys need (see README.md).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Journey } from "./lib/journey.js";
import type { HumanJourney, State } from "./lib/types.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mobile: { type: "boolean", default: false },
    out: { type: "string" },
    "cookie-jar": { type: "string" },
    state: { type: "string" },
    headed: { type: "boolean", default: false },
  },
});

const name = positionals[0];
if (!name || !values.out) {
  console.error("usage: record.ts <journey> --out <dir> [--mobile] [--cookie-jar f] [--state f]");
  process.exit(2);
}

const mod = (await import(`./human/${name}.js`)) as { journey: HumanJourney };
const def = mod.journey;
const state: State =
  values.state && existsSync(values.state)
    ? (JSON.parse(readFileSync(values.state, "utf8")) as State)
    : {};
const mobile = values.mobile === true;
if (mobile && !def.mobile) {
  console.error(`${name} has no phone variant`);
  process.exit(2);
}

const j = new Journey({
  slug: `${def.number}-${def.slug}${mobile ? "-mobile" : ""}`,
  number: def.number,
  title: def.title,
  ...(def.subtitle ? { subtitle: def.subtitle } : {}),
  persona: "human",
  mode: def.mode ?? "live",
  mobile,
  headed: values.headed || def.headed === true,
  ...(def.signedIn && values["cookie-jar"] ? { cookieJar: resolve(values["cookie-jar"]) } : {}),
  outDir: resolve(values.out),
});

await j.open();
await j.titleCard({
  date: new Date().toISOString().slice(0, 10),
  viewport: mobile ? "Phone 390×844" : "Desktop 1280×800",
  host: new URL(process.env.GF_HOST ?? "https://gittifacts.decroockjovi.workers.dev").host,
});
try {
  await def.run(j, state, { mobile });
} catch (e) {
  console.error(`journey failed at ${j.t}s:`, e);
  await j.snap("failure");
  j.notes.push(`FAILED at ${j.t}s: ${e instanceof Error ? e.message : String(e)}`);
}
await j.close();
