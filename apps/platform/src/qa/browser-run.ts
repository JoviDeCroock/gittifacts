/**
 * `QaBrowser` on Browser Run (docs/research/agentic-qa.md §2). A real Chromium drives the app,
 * but the app has no public address: every request the page makes is paused over CDP and
 * answered here. Requests to the app origin are fetched from the private preview (the
 * `PreviewHost` Durable Object, over its binding); every other origin is aborted and recorded.
 */
import type { ActionOutcome, PageSnapshot, QaBrowser } from "@app/qa";
import { REPLAY_PAGE_SCRIPT } from "@app/qa";
import type { Browser, HTTPRequest, Page } from "@cloudflare/puppeteer";
import {
  CLEAR_VALUE,
  CONTENT_BOX,
  COUNT,
  IS_VISIBLE,
  SNAPSHOT,
  TAG_TARGET,
  TEXT_OF,
} from "./page-scripts.js";

const VIEWPORT = { width: 1280, height: 800 };
const NAV_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 5_000;
/** Request headers a fulfilled response must not carry (the body is already decoded). */
const DROP = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);
const OUR_BLOCK = "ERR_BLOCKED_BY_CLIENT";

export type AppFetch = (request: Request) => Promise<Response>;

const js = (v: unknown) => JSON.stringify(v);
const msg = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).split("\n")[0]?.slice(0, 300) ?? "";

export class BrowserRunQa implements QaBrowser {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private started = 0;
  private errors = { console: [] as string[], network: [] as string[] };
  private blocked = new Set<string>();
  private seq = 0;

  constructor(
    private readonly binding: Fetcher,
    private readonly origin: string,
    private readonly app: AppFetch,
  ) {}

  async open(): Promise<void> {
    const puppeteer = (await import("@cloudflare/puppeteer")).default;
    this.browser = await puppeteer.launch(this.binding, { keep_alive: 120_000 });
    this.started = Date.now();
    await this.reset();
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }

  private get p(): Page {
    if (this.page === null) throw new Error("the QA browser is not open");
    return this.page;
  }

  async reset(): Promise<void> {
    if (this.browser === null) throw new Error("the QA browser is not open");
    await this.page?.close().catch(() => undefined);
    const context = await this.browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport(VIEWPORT);
    await page.setRequestInterception(true);
    page.on("request", (r) => void this.route(r));
    page.on("console", (m) => {
      if (m.type() === "error" && !m.text().includes(OUR_BLOCK))
        this.errors.console.push(m.text().slice(0, 300));
    });
    page.on("pageerror", (e) => this.errors.console.push(`pageerror: ${msg(e)}`));
    page.on("response", (r) => {
      if (r.status() >= 400 && r.url().startsWith(this.origin))
        this.errors.network.push(`${r.status()} ${r.url().slice(this.origin.length)}`);
    });
    page.on("requestfailed", (r) => {
      const why = r.failure()?.errorText ?? "failed";
      if (r.url().startsWith(this.origin) && !why.includes(OUR_BLOCK))
        this.errors.network.push(`${why} ${r.url().slice(this.origin.length)}`);
    });
    this.page = page;
  }

  /** The interception: the app from the private preview, nothing else. */
  private async route(r: HTTPRequest): Promise<void> {
    if (r.isInterceptResolutionHandled()) return;
    const url = r.url();
    if (url.startsWith("data:") || url.startsWith("blob:"))
      return void (await r.continue().catch(() => undefined));
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return void (await r.abort("blockedbyclient").catch(() => undefined));
    }
    if (origin !== this.origin) {
      this.blocked.add(origin);
      return void (await r.abort("blockedbyclient").catch(() => undefined));
    }
    try {
      const method = r.method();
      const body = method === "GET" || method === "HEAD" ? null : (r.postData() ?? null);
      const res = await this.app(
        new Request(url, { method, headers: r.headers(), body, redirect: "manual" }),
      );
      const headers: Record<string, string | string[]> = {};
      res.headers.forEach((v, k) => {
        if (!DROP.has(k) && k !== "set-cookie") headers[k] = v;
      });
      const cookies = res.headers.getSetCookie();
      if (cookies.length > 0) headers["set-cookie"] = cookies;
      const bytes = new Uint8Array(await res.arrayBuffer());
      await r.respond({ status: res.status, headers, body: bytes });
    } catch (e) {
      this.errors.network.push(
        `the app did not answer ${url.slice(this.origin.length)}: ${msg(e)}`,
      );
      await r.abort("failed").catch(() => undefined);
    }
  }

  async goto(path: string): Promise<ActionOutcome> {
    const url = `${this.origin}${path.startsWith("/") ? path : `/${path}`}`;
    try {
      const res = await this.p.goto(url, { waitUntil: "networkidle0", timeout: NAV_TIMEOUT_MS });
      const status = res?.status() ?? 0;
      return status >= 400 ? { ok: false, status, detail: `HTTP ${status}` } : { ok: true, status };
    } catch (e) {
      // A page that never goes network-idle still loaded if it has a body.
      const loaded = await this.p
        .evaluate(
          `document.readyState !== 'loading' && location.href.startsWith(${js(this.origin)})`,
        )
        .catch(() => false);
      return loaded
        ? { ok: true, detail: `loaded, not idle: ${msg(e)}` }
        : { ok: false, detail: msg(e) };
    }
  }

  private async tag(target: string): Promise<string | null> {
    const tag = `t${++this.seq}`;
    const ok = await this.p.evaluate(`${TAG_TARGET}(${js(target)}, ${js(tag)})`).catch(() => false);
    return ok === true ? tag : null;
  }

  private async act(
    target: string,
    fn: (sel: string, tag: string) => Promise<unknown>,
  ): Promise<ActionOutcome> {
    const tag = await this.tag(target);
    if (tag === null) return { ok: false, notFound: true, detail: `no element matches ${target}` };
    try {
      await Promise.race([
        fn(`[data-gf-qa="${tag}"]`, tag),
        new Promise((_, no) => setTimeout(() => no(new Error("timed out")), ACTION_TIMEOUT_MS)),
      ]);
      await this.settle();
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: msg(e) };
    }
  }

  /** Let the page react (navigation, fetches) before the next step looks at it. */
  private async settle(): Promise<void> {
    await this.p.waitForNetworkIdle({ idleTime: 300, timeout: 3_000 }).catch(() => undefined);
  }

  click(target: string) {
    return this.act(target, (sel) => this.p.click(sel));
  }
  fill(target: string, value: string) {
    return this.act(target, async (sel, tag) => {
      await this.p.evaluate(`${CLEAR_VALUE}(${js(tag)})`);
      await this.p.type(sel, value);
    });
  }
  select(target: string, value: string) {
    return this.act(target, (sel) => this.p.select(sel, value));
  }
  async press(key: string): Promise<ActionOutcome> {
    try {
      await this.p.keyboard.press(key as Parameters<Page["keyboard"]["press"]>[0]);
      await this.settle();
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: msg(e) };
    }
  }
  async wait(ms: number) {
    await new Promise((r) => setTimeout(r, ms));
  }
  async textOf(target?: string): Promise<string | null> {
    const out = await this.p.evaluate(`${TEXT_OF}(${js(target ?? null)})`).catch(() => null);
    return typeof out === "string" ? out : null;
  }
  async count(target: string): Promise<number> {
    const n = await this.p.evaluate(`${COUNT}(${js(target)})`).catch(() => 0);
    return typeof n === "number" ? n : 0;
  }
  async isVisible(target: string): Promise<boolean> {
    return (await this.p.evaluate(`${IS_VISIBLE}(${js(target)})`).catch(() => false)) === true;
  }
  async path(): Promise<string> {
    const u = new URL(this.p.url());
    return `${u.pathname}${u.search}`;
  }
  async snapshot(): Promise<PageSnapshot> {
    const s = (await this.p.evaluate(`${SNAPSHOT}()`).catch(() => null)) as Omit<
      PageSnapshot,
      "url"
    > | null;
    return {
      url: await this.path(),
      title: s?.title ?? "",
      text: s?.text ?? "",
      elements: s?.elements ?? [],
    };
  }
  async screenshot(opts: { thumb?: boolean } = {}): Promise<Uint8Array | null> {
    // Crop to the content (at least 640×400, 16:10, never past the viewport), top-left anchored.
    const box = (await this.p.evaluate(CONTENT_BOX).catch(() => null)) as {
      width: number;
      height: number;
    } | null;
    const width = Math.min(VIEWPORT.width, Math.max(640, (box?.width ?? VIEWPORT.width) + 32));
    const height = Math.min(
      VIEWPORT.height,
      Math.max(Math.round((width * 10) / 16), (box?.height ?? VIEWPORT.height) + 32),
    );
    const scale = opts.thumb ? Math.min(1, 400 / width) : 1;
    const shot = await this.p
      .screenshot({
        type: "jpeg",
        quality: opts.thumb ? 60 : 70,
        clip: { x: 0, y: 0, width, height, scale },
      })
      .catch(() => null);
    return shot === null ? null : new Uint8Array(shot);
  }
  drainErrors() {
    const e = this.errors;
    this.errors = { console: [], network: [] };
    return e;
  }
  blockedOrigins(): string[] {
    return [...this.blocked].sort();
  }
  async replayGif(
    frames: Uint8Array[],
    opts: { width: number; delayMs: number },
  ): Promise<Uint8Array | null> {
    if (this.browser === null) return null;
    const page = await this.browser.newPage();
    try {
      const b64 = frames.map((f) => btoa(Array.from(f, (c) => String.fromCharCode(c)).join("")));
      const out = await page.evaluate(
        `(${REPLAY_PAGE_SCRIPT})(${js(b64)}, ${opts.width}, ${opts.delayMs})`,
      );
      return typeof out === "string" ? Uint8Array.from(atob(out), (c) => c.charCodeAt(0)) : null;
    } finally {
      await page.close().catch(() => undefined);
    }
  }
  usedMs(): number {
    return this.started === 0 ? 0 : Date.now() - this.started;
  }
}
