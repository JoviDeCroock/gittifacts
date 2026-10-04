/**
 * QA under workerd tests (no Browser Run): an HTML-only browser that loads pages through the SAME
 * private path production uses (`appFetchFor` → the PreviewHost DO, here with a fake container),
 * reads their text, and records every origin it was asked for. Model answers are scripted.
 * State lives on globalThis so the test and the QaRunWorkflow (same isolate) share it.
 */
import type { ActionOutcome, PageSnapshot } from "@app/qa";
import { FakeLlmClient } from "@app/tour";
import type { AppFetch } from "../../src/qa/browser-run.js";
import { configureQaRuntime, type OpenedBrowser } from "../../src/qa/runtime.js";

export interface QaFakeState {
  origins: string[];
  paths: string[];
  llm: FakeLlmClient;
  opened: number;
  closed: number;
  failBrowser: boolean;
}

const KEY = "__gittifactsQaFakes";

export function qaFakes(): QaFakeState {
  return (globalThis as unknown as Record<string, QaFakeState>)[KEY] as QaFakeState;
}

export function resetQaFakes(responses: unknown[]): QaFakeState {
  const state: QaFakeState = {
    origins: [],
    paths: [],
    llm: new FakeLlmClient(
      responses.map((json) => ({ json })),
      { defaultCostUsd: 0.0005, model: "@cf/zai-org/glm-5.3-flash" },
    ),
    opened: 0,
    closed: 0,
    failBrowser: false,
  };
  (globalThis as unknown as Record<string, QaFakeState>)[KEY] = state;
  configureQaRuntime({
    browser: async (_env, origin, app) => {
      const s = qaFakes();
      if (s.failBrowser) throw new Error("Browser Run answered 503");
      s.opened++;
      s.origins.push(origin);
      return new HtmlBrowser(origin, app, s);
    },
    llm: () => qaFakes().llm,
  });
  return state;
}

const text = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

class HtmlBrowser implements OpenedBrowser {
  private html = "";
  private url = "about:blank";
  private used = 0;
  private errors = { console: [] as string[], network: [] as string[] };

  constructor(
    private readonly origin: string,
    private readonly app: AppFetch,
    private readonly state: QaFakeState,
  ) {}

  async reset() {
    this.html = "";
    this.url = "about:blank";
  }
  async goto(path: string): Promise<ActionOutcome> {
    this.used += 200;
    this.state.paths.push(path);
    const res = await this.app(new Request(`${this.origin}${path}`));
    this.html = await res.text();
    this.url = path;
    if (res.status >= 400) {
      this.errors.network.push(`${res.status} ${path}`);
      return { ok: false, status: res.status, detail: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status };
  }
  async click(target: string): Promise<ActionOutcome> {
    return this.html.includes(target.replace(/^text=/, ""))
      ? { ok: true }
      : { ok: false, notFound: true, detail: `no element matches ${target}` };
  }
  async fill(target: string): Promise<ActionOutcome> {
    return { ok: false, notFound: true, detail: `no element matches ${target}` };
  }
  async press(): Promise<ActionOutcome> {
    return { ok: true };
  }
  async select(target: string): Promise<ActionOutcome> {
    return { ok: false, notFound: true, detail: `no element matches ${target}` };
  }
  async wait() {}
  async textOf(target?: string) {
    return target === undefined ? text(this.html) : null;
  }
  async isVisible(target: string) {
    return this.html.includes(`<${target}`);
  }
  async path() {
    return this.url;
  }
  async snapshot(): Promise<PageSnapshot> {
    return {
      url: this.url,
      title: /<title>([^<]*)/.exec(this.html)?.[1] ?? "",
      text: text(this.html).slice(0, 1500),
      elements: [],
    };
  }
  async screenshot(opts?: { thumb?: boolean }) {
    return Uint8Array.of(0xff, 0xd8, 0xff, opts?.thumb ? 1 : 0, this.url.length);
  }
  drainErrors() {
    const e = this.errors;
    this.errors = { console: [], network: [] };
    return e;
  }
  blockedOrigins() {
    return [];
  }
  async replayGif(frames: Uint8Array[]) {
    return Uint8Array.of(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, frames.length);
  }
  usedMs() {
    return this.used;
  }
  async close() {
    this.state.closed++;
  }
}

/** The default under workerd tests and the E2E server: the HTML browser, no model answers. */
export function installQaFakes(): void {
  if ((globalThis as unknown as Record<string, unknown>)[KEY] === undefined) resetQaFakes([]);
}
