import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const BASE = "https://gittifacts.decroockjovi.workers.dev";
const OUT = process.env.OUT as string;
const st = JSON.parse(readFileSync(join(OUT, "..", "qa-native-state.json"), "utf8")) as {
  cookie: string;
  changeId: string;
};
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2,
});
const [k, v] = st.cookie.split("=");
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
await page.goto(`${BASE}/changes/${st.changeId}#qa`);
const qa = page.getByTestId("qa");
await qa.scrollIntoViewIfNeeded();
await page.getByTestId("qa-withdrawn").waitFor({ timeout: 20_000 });
await page.waitForTimeout(2000);
await qa.screenshot({ path: join(OUT, "16-qa-native-withdrawn.png") });
await browser.close();
console.log("ok");
