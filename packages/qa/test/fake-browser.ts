/**
 * A scripted browser over a tiny in-memory counter app: `/` has a counter (#n), an Increment button
 * (#inc) and a name field (#who → #hello). `bug: "no-increment"` makes the button do nothing;
 * `status500` makes `/` answer 500. Screenshots are 4-byte JPEG stand-ins.
 */
import type { QaArtifact } from "@app/evidence";
import type { ActionOutcome, PageSnapshot, QaArtifactSink, QaBrowser } from "../src/index.js";

export interface FakeAppOptions {
  bug?: "no-increment" | "throws";
  status500?: boolean;
  /** Extra milliseconds of "browser time" each action costs. */
  costMs?: number;
}

export class FakeBrowser implements QaBrowser {
  url = "about:blank";
  n = 0;
  who = "";
  used = 0;
  shots = 0;
  log: string[] = [];
  private errors = { console: [] as string[], network: [] as string[] };

  constructor(private readonly opts: FakeAppOptions = {}) {}

  private tick(what: string) {
    this.used += this.opts.costMs ?? 100;
    this.log.push(what);
  }

  async reset() {
    this.tick("reset");
    this.url = "about:blank";
    this.n = 0;
    this.who = "";
  }
  async goto(path: string): Promise<ActionOutcome> {
    this.tick(`goto ${path}`);
    if (path !== "/") {
      this.errors.network.push(`404 ${path}`);
      return { ok: false, status: 404, detail: "HTTP 404" };
    }
    if (this.opts.status500) return { ok: false, status: 500, detail: "HTTP 500" };
    this.url = "/";
    if (this.opts.bug === "throws")
      this.errors.console.push("pageerror: TypeError: x is undefined");
    return { ok: true, status: 200 };
  }
  private find(target: string): "inc" | "who" | "n" | "hello" | null {
    if (this.url !== "/") return null;
    if (target === "#inc" || target === "text=Increment") return "inc";
    if (target === "#who" || target === "[name=who]") return "who";
    if (target === "#n") return "n";
    if (target === "#hello") return "hello";
    return null;
  }
  async click(target: string): Promise<ActionOutcome> {
    this.tick(`click ${target}`);
    if (this.find(target) !== "inc")
      return { ok: false, notFound: true, detail: `no element matches ${target}` };
    if (this.opts.bug !== "no-increment") this.n++;
    return { ok: true };
  }
  async fill(target: string, value: string): Promise<ActionOutcome> {
    this.tick(`fill ${target}`);
    if (this.find(target) !== "who")
      return { ok: false, notFound: true, detail: `no element matches ${target}` };
    this.who = value;
    return { ok: true };
  }
  async press(): Promise<ActionOutcome> {
    return { ok: true };
  }
  async select(target: string): Promise<ActionOutcome> {
    return { ok: false, notFound: true, detail: `no element matches ${target}` };
  }
  async wait(ms: number) {
    this.used += Math.min(ms, 10);
  }
  async textOf(target?: string): Promise<string | null> {
    if (this.url !== "/") return target === undefined ? "" : null;
    const all = `Counter ${this.n} Increment ${this.who ? `Hello ${this.who}` : ""}`;
    if (target === undefined) return all;
    const el = this.find(target);
    if (el === "n") return String(this.n);
    if (el === "hello") return this.who ? `Hello ${this.who}` : "";
    if (el === "inc") return "Increment";
    return null;
  }
  async count(target: string) {
    // "button" counts the page's two buttons in the fake app (Increment and the hidden Reset).
    if (this.url !== "/") return 0;
    return target === "button" ? 2 : this.find(target) === null ? 0 : 1;
  }
  async isVisible(target: string) {
    return this.find(target) !== null;
  }
  async path() {
    return this.url;
  }
  async snapshot(): Promise<PageSnapshot> {
    return {
      url: this.url,
      title: "Counter",
      text: (await this.textOf()) ?? "",
      elements: [
        { selector: "#inc", role: "button", name: "Increment" },
        { selector: "#who", role: "textbox", name: "Your name", type: "text" },
        { selector: "#n", role: "status", name: String(this.n) },
      ],
    };
  }
  async screenshot(opts?: { thumb?: boolean }) {
    this.shots++;
    return Uint8Array.of(0xff, 0xd8, opts?.thumb ? 1 : 0, this.shots & 255);
  }
  drainErrors() {
    const e = this.errors;
    this.errors = { console: [], network: [] };
    return e;
  }
  blockedOrigins() {
    return ["https://fonts.example"];
  }
  async replayGif(frames: Uint8Array[]) {
    return frames.length > 0 ? Uint8Array.of(0x47, 0x49, 0x46) : null;
  }
  usedMs() {
    return this.used;
  }
}

export class MemorySink implements QaArtifactSink {
  readonly items = new Map<string, Uint8Array>();
  async put(
    name: string,
    bytes: Uint8Array,
    contentType: string,
    role: QaArtifact["role"],
  ): Promise<QaArtifact> {
    this.items.set(name, bytes);
    return {
      name,
      ref: `qa/test/${name}`,
      sha256: "0".repeat(64),
      bytes: bytes.byteLength,
      contentType,
      role,
    };
  }
}
