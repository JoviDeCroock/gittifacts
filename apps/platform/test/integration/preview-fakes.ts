/**
 * Fakes for the preview path under workerd tests (no containers, no Browser Run):
 *
 * - `TestPreviewHost` is the real `PreviewHost` Durable Object with its `ctx.container` swapped
 *   for `FakePreviewContainer`, whose "workerd" answers HTML once `gittifacts-runner preview`
 *   was exec'd (and sets one host-only and one Domain cookie, which the gateway must drop).
 * - `fakeBrowser` answers Browser Run screenshot quick actions with a 1×1 PNG.
 *
 * State lives on globalThis so the test file and the Durable Object (same isolate) share it.
 */
import { type PreviewContainer, PreviewHost } from "../../src/previews/preview-host.js";

export interface PreviewFakeState {
  starts: Array<{ snapshot: string | null; enableInternet: boolean }>;
  execs: string[][];
  requests: string[];
  /** Fail the snapshot restore (start throws). */
  failStart: boolean;
}

const KEY = "__gittifactsPreviewFakes";

export function previewFakes(): PreviewFakeState {
  const g = globalThis as unknown as Record<string, PreviewFakeState | undefined>;
  g[KEY] ??= { starts: [], execs: [], requests: [], failStart: false };
  return g[KEY];
}

export function resetPreviewFakes(): PreviewFakeState {
  const fresh: PreviewFakeState = { starts: [], execs: [], requests: [], failStart: false };
  (globalThis as unknown as Record<string, PreviewFakeState>)[KEY] = fresh;
  return fresh;
}

export const PREVIEW_PAGE = (path: string) =>
  `<!doctype html><html><head><title>Hello</title><style>body{display:none!important}*{z-index:1!important}</style></head><body><h1>Hello from ${path}</h1></body></html>`;

export class FakePreviewContainer implements PreviewContainer {
  running = false;
  private serving = false;

  start(options: ContainerStartupOptions): void {
    const state = previewFakes();
    if (state.failStart) throw new Error("snapshot not found");
    state.starts.push({
      snapshot: options.containerSnapshot?.id ?? null,
      enableInternet: options.enableInternet,
    });
    this.running = true;
  }

  monitor(): Promise<void> {
    return new Promise(() => {});
  }

  async exec(cmd: string[]): Promise<{ exitCode: Promise<number> }> {
    previewFakes().execs.push(cmd);
    if (cmd.join(" ").includes("gittifacts-runner preview")) {
      this.serving = true;
      return { exitCode: new Promise(() => {}) };
    }
    return { exitCode: Promise.resolve(0) };
  }

  getTcpPort(port: number) {
    return {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        if (!this.serving || port !== 8787)
          throw new Error(`Container is not listening to port ${port}`);
        const url = new URL(input instanceof Request ? input.url : String(input));
        previewFakes().requests.push(url.pathname);
        if (url.pathname === "/health") {
          return Response.json({ ok: true });
        }
        const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
        headers.append("set-cookie", "session=1; Path=/; HttpOnly");
        headers.append("set-cookie", "tracker=1; Domain=preview.resynapse.dev; Path=/");
        return new Response(PREVIEW_PAGE(url.pathname), { status: 200, headers });
      },
    };
  }

  async setInactivityTimeout(): Promise<void> {}
  async interceptAllOutboundHttp(): Promise<void> {}
  async interceptOutboundHttps(): Promise<void> {}
}

const containers = new Map<string, FakePreviewContainer>();

export class TestPreviewHost extends PreviewHost {
  protected override container(): PreviewContainer {
    const id = this.ctx.id.toString();
    let c = containers.get(id);
    if (c === undefined) {
      c = new FakePreviewContainer();
      containers.set(id, c);
    }
    return c;
  }
}

/** 1×1 transparent PNG. */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  ),
  (ch) => ch.charCodeAt(0),
);

export const fakeBrowser: Pick<BrowserRun, "quickAction"> = {
  quickAction: (async () =>
    new Response(PNG, {
      headers: { "content-type": "image/png" },
    })) as unknown as BrowserRun["quickAction"],
};
