/**
 * One recorded browser journey: a Playwright page, the pausable recorder, the overlay, and the
 * notes the video ships with (chapters, measured numbers, console/network problems).
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Locator, type Page } from "playwright";
import { type TitleCard, titleCardHtml } from "./cards.js";
import { overlayScript } from "./overlay.js";
import { Recorder } from "./recorder.js";

export const HOST = (process.env.GF_HOST ?? "https://gittifacts.decroockjovi.workers.dev").replace(
  /\/+$/,
  "",
);

export interface JourneySpec {
  slug: string;
  number: string;
  title: string;
  subtitle?: string;
  persona: "human" | "agent";
  mode: "live" | "mock";
  mobile?: boolean;
  /** Headed Chromium (Turnstile refuses headless browsers). */
  headed?: boolean;
  /** Netscape cookie jar (curl -c) for a signed-in human; omitted = signed out. */
  cookieJar?: string;
  outDir: string;
}

export interface Chapter {
  t: number;
  label: string;
}
export interface Problem {
  t: number;
  kind: "console" | "pageerror" | "http" | "requestfailed";
  text: string;
}

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

/** Cookies for `host` from a Netscape cookie file. */
export function cookiesFromJar(path: string, host: string) {
  const out: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    expires: number;
  }> = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const httpOnly = raw.startsWith("#HttpOnly_");
    const line = httpOnly ? raw.slice("#HttpOnly_".length) : raw;
    if (line.startsWith("#") || line.trim() === "") continue;
    const f = line.split("\t");
    if (f.length < 7) continue;
    const domain = (f[0] ?? "").replace(/^\./, "");
    if (domain !== host) continue;
    out.push({
      name: f[5] ?? "",
      value: f[6] ?? "",
      domain,
      path: f[2] ?? "/",
      secure: f[3] === "TRUE",
      httpOnly,
      expires: Number(f[4]) || -1,
    });
  }
  return out;
}

export class Journey {
  browser!: Browser;
  context!: BrowserContext;
  page!: Page;
  rec!: Recorder;
  readonly chapters: Chapter[] = [];
  readonly problems: Problem[] = [];
  readonly metrics: Record<string, number | string> = {};
  readonly notes: string[] = [];
  readonly t0 = Date.now();
  readonly size: { width: number; height: number };
  private cursor = { x: 0, y: 0 };
  readonly file: string;

  constructor(readonly spec: JourneySpec) {
    this.size = spec.mobile ? PHONE : DESKTOP;
    this.file = join(spec.outDir, `${spec.slug}.webm`);
  }

  get t(): number {
    return Math.round(this.rec.videoMs / 100) / 10;
  }

  async open(): Promise<void> {
    mkdirSync(this.spec.outDir, { recursive: true });
    this.browser = await chromium.launch({
      headless: !this.spec.headed,
      args: this.spec.headed ? ["--disable-blink-features=AutomationControlled"] : [],
    });
    const mobile = this.spec.mobile === true;
    this.context = await this.browser.newContext({
      viewport: this.size,
      deviceScaleFactor: mobile ? 2 : 1,
      isMobile: mobile,
      hasTouch: mobile,
      colorScheme: "light",
      // No locale or user-agent override: Turnstile fails a browser whose language or UA
      // disagrees with its engine (error 600010), and the claim journey needs it to pass.
    });
    if (this.spec.cookieJar) {
      await this.context.addCookies(cookiesFromJar(this.spec.cookieJar, new URL(HOST).hostname));
    }
    await this.context.addInitScript(overlayScript({ t0: this.t0, mobile }));
    this.page = await this.context.newPage();
    this.watch(this.page);
    this.rec = new Recorder({
      out: this.file,
      width: this.size.width * (mobile ? 2 : 1),
      height: this.size.height * (mobile ? 2 : 1),
      bitrate: mobile ? "700k" : "700k",
    });
    await this.page.setContent("<html><body style='margin:0;background:#0f0f10'></body></html>");
    await this.rec.start(this.page, mobile ? 2 : 1);
    this.cursor = { x: this.size.width * 0.6, y: this.size.height * 0.55 };
  }

  /** Console errors, page errors, failed requests and HTTP ≥ 400 from the platform, timestamped. */
  private watch(page: Page): void {
    const add = (kind: Problem["kind"], text: string) =>
      this.problems.push({ t: this.rec ? this.t : 0, kind, text: text.slice(0, 400) });
    page.on("console", (m) => {
      if (m.type() === "error") add("console", m.text());
    });
    page.on("pageerror", (e) => add("pageerror", e.message));
    page.on("requestfailed", (r) => {
      const err = r.failure()?.errorText ?? "";
      if (!err.includes("ERR_ABORTED")) add("requestfailed", `${r.method()} ${r.url()} ${err}`);
    });
    page.on("response", (r) => {
      if (r.status() >= 400 && r.url().startsWith(HOST))
        add("http", `${r.status()} ${r.request().method()} ${r.url()}`);
    });
  }

  private gf(fn: string, ...args: unknown[]): Promise<void> {
    return this.page
      .evaluate(
        ([f, a]) => {
          const g = (window as unknown as { __gf?: Record<string, (...x: unknown[]) => void> })
            .__gf;
          g?.[f as string]?.(...(a as unknown[]));
        },
        [fn, args] as const,
      )
      .catch(() => {});
  }

  /** The 2 s title card. */
  async titleCard(
    card: Omit<TitleCard, "number" | "title" | "persona" | "mode" | "subtitle">,
  ): Promise<void> {
    const { number, title, persona, mode, subtitle } = this.spec;
    await this.page.setContent(
      titleCardHtml({ number, title, persona, mode, ...(subtitle ? { subtitle } : {}), ...card }),
    );
    await this.gf("hide", true);
    await this.hold(2200);
  }

  /** A chapter mark (and a caption on screen for `captionMs`, 0 = none). */
  async chapter(label: string, caption = label, captionMs = 2600): Promise<void> {
    this.chapters.push({ t: this.t, label });
    if (caption !== "" && captionMs > 0) await this.gf("caption", caption, captionMs);
  }

  async caption(text: string, ms = 2600): Promise<void> {
    await this.gf("caption", text, ms);
  }

  async hold(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  /** Navigate (the time it takes stays in the video: it is part of the experience). */
  async goto(url: string, opts: { waitFor?: string; settleMs?: number } = {}): Promise<number> {
    const started = Date.now();
    await this.page.goto(url.startsWith("http") ? url : `${HOST}${url}`, {
      waitUntil: "domcontentloaded",
    });
    await this.gf("hide", false);
    await this.gf("cursor", this.cursor.x, this.cursor.y);
    if (opts.waitFor)
      await this.page.waitForSelector(opts.waitFor, { timeout: 30_000 }).catch(() => {});
    await this.page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    const ms = Date.now() - started;
    await this.hold(opts.settleMs ?? 600);
    return ms;
  }

  /** Glide the cursor to a point. */
  async moveTo(x: number, y: number, ms = 450): Promise<void> {
    const steps = Math.max(6, Math.round(ms / 25));
    await this.page.mouse.move(x, y, { steps });
    this.cursor = { x, y };
  }

  /** Move to the element, ripple, click. Scrolls it into view first (smoothly). */
  async click(
    target: Locator | string,
    opts: { pauseMs?: number; force?: boolean } = {},
  ): Promise<void> {
    const loc = typeof target === "string" ? this.page.locator(target).first() : target;
    await loc.waitFor({ state: "visible", timeout: 20_000 });
    await this.reveal(loc);
    // Nested scroll containers (a sticky rail) don't follow the page wheel: jump if still hidden.
    const hit = await loc
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return top !== null && (el === top || el.contains(top));
      })
      .catch(() => true);
    if (!hit) await loc.scrollIntoViewIfNeeded().catch(() => {});
    const box = await loc.boundingBox();
    if (box === null) throw new Error(`no box for ${String(target)}`);
    const x = box.x + Math.min(box.width / 2, 60 + box.width * 0.2);
    const y = box.y + box.height / 2;
    await this.moveTo(x, y);
    await this.hold(180);
    await this.page.mouse.down();
    await this.hold(70);
    await this.page.mouse.up();
    await this.hold(opts.pauseMs ?? 500);
  }

  /** Smooth wheel scroll by dy pixels over ~ms. */
  async scroll(dy: number, ms = 900, at?: { x: number; y: number }): Promise<void> {
    // The wheel scrolls whatever is under the cursor: move off a sidebar (its own scroller) first.
    const { x, y } = this.cursor;
    const inSide = await this.page
      .evaluate(
        ([px, py]) => {
          const el = document.elementFromPoint(px as number, py as number);
          return el?.closest("nav, aside, [class*='sidebar'], [class*='rail']") != null;
        },
        [x, y] as const,
      )
      .catch(() => false);
    if (at) await this.moveTo(at.x, at.y, 250);
    else if (inSide)
      await this.moveTo(
        this.size.width * (this.size.width > 600 ? 0.5 : 0.5),
        this.size.height * 0.5,
        250,
      );
    const steps = Math.max(4, Math.round(ms / 40));
    for (let i = 0; i < steps; i++) {
      await this.page.mouse.wheel(0, dy / steps);
      await this.page.waitForTimeout(ms / steps);
    }
    await this.hold(250);
  }

  /** Scroll until the element's top sits ~1/4 down the viewport (only when it is off screen). */
  async reveal(loc: Locator, force = false): Promise<void> {
    let lastY: number | null = null;
    for (let i = 0; i < 12; i++) {
      const box = await loc.boundingBox();
      if (box === null) return;
      // Fixed or sticky (a bottom action bar), or the page can't scroll further: stop.
      if (lastY !== null && Math.abs(lastY - box.y) < 2) return;
      lastY = box.y;
      const top = this.size.height * 0.22;
      const inView = box.y >= 40 && box.y + Math.min(box.height, 120) <= this.size.height - 60;
      if (inView && !force) return;
      const dy = box.y - top;
      if (Math.abs(dy) < 30) return;
      // Wheel over the target's own column, so its scroll container is the one that moves.
      const at = {
        x: Math.max(20, Math.min(this.size.width - 20, box.x + Math.min(40, box.width / 2))),
        y: this.size.height * 0.5,
      };
      await this.scroll(
        Math.max(-900, Math.min(900, dy)),
        Math.min(1200, 300 + Math.abs(dy) * 0.8),
        at,
      );
      force = false;
    }
  }

  async type(target: Locator | string, text: string, delay = 35): Promise<void> {
    const loc = typeof target === "string" ? this.page.locator(target).first() : target;
    await this.click(loc, { pauseMs: 150 });
    await loc.pressSequentially(text, { delay });
    await this.hold(250);
  }

  /** Cut a dead wait: nothing is recorded while `work` runs; then "⏩ N s" shows for ~1 s. */
  async cut<T>(label: string, work: () => Promise<T>): Promise<T> {
    this.rec.pause();
    const started = Date.now();
    const result = await work();
    const s = Math.round((Date.now() - started) / 1000);
    await this.gf("ff", `⏩ ${s} s ${label}`, 1400);
    await this.rec.freshFrame();
    this.rec.resume();
    this.notes.push(`cut ${s}s at ${this.t}s: ${label}`);
    await this.hold(1100);
    return result;
  }

  /** A full-resolution screenshot for the review (not part of the video). */
  async snap(name: string, fullPage = false): Promise<void> {
    const dir = join(this.spec.outDir, "snaps", this.spec.slug);
    mkdirSync(dir, { recursive: true });
    await this.page.screenshot({ path: join(dir, `${name}.png`), fullPage }).catch(() => {});
  }

  /** Hold the final state ~2 s, finish the video and write `<slug>.json` next to it. */
  async close(): Promise<void> {
    await this.gf("clearCaption");
    await this.hold(2200);
    await this.rec.stop();
    await this.browser.close();
    const meta = {
      file: `${this.spec.slug}.webm`,
      title: this.spec.title,
      persona: this.spec.persona,
      viewport: `${this.size.width}x${this.size.height}`,
      mode: this.spec.mode,
      durationSec: Math.round(this.rec.videoMs / 100) / 10,
      sizeMB: Math.round(statSync(this.file).size / 10_000) / 100,
      realElapsedSec: Math.round((Date.now() - this.t0) / 1000),
      chapters: this.chapters,
      metrics: this.metrics,
      problems: this.problems,
      notes: this.notes,
    };
    const out = join(dirname(this.file), `${this.spec.slug}.json`);
    writeFileSync(out, `${JSON.stringify(meta, null, 2)}\n`);
    console.log(
      JSON.stringify({ file: this.file, durationSec: meta.durationSec, sizeMB: meta.sizeMB }),
    );
  }
}
