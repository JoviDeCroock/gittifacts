/**
 * `PreviewHost`: one Durable Object per pinned preview (`p-<changeId>-<sha8>`), driving its own
 * `ctx.container` (the sandbox image, `scheduling_policy: durable_object`). It serves the
 * change's built Worker under workerd (`gittifacts-runner preview`, i.e. `wrangler dev --local`)
 * and is reached only through the preview gateway, which adds the banner and header hygiene.
 *
 * Boot: restore the CI `build` step's container snapshot (node_modules + build output at the
 * head commit) and start the preview server on port 8787. Without a build snapshot it restores
 * the `install` snapshot, checks the head out through the CI egress gateway (git host only, read
 * token in that exec's env alone) and lets `wrangler dev` run the project's build.
 *
 * The container has no internet (`enableInternet: false`) whatever the project's claim state, for
 * now (DECISIONS.md). It sleeps after `IDLE_MS` without requests; the next request wakes it: HTML
 * requests get a "starting preview…" page that refreshes itself, others a 503 with Retry-After.
 */
import { DurableObject } from "cloudflare:workers";
import {
  CHECKOUT_SCRIPT,
  CONTAINERS_CA_PATH,
  checkoutEnv,
  EGRESS_GATEWAY_EXPORT,
  type EgressProps,
  ROOT_USER,
  RUNNER_HOME,
  RUNNER_USER,
  trustCaScript,
  WORKSPACE,
} from "@app/ci-engine";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { previews } from "../db/schema.js";
import { busyPage, errorPage } from "./pages.js";

export const PREVIEW_PORT = 8787;
/** A preview sleeps after this long without requests. */
export const IDLE_MS = 10 * 60_000;
/** How long a boot may take before the preview is reported failed. */
export const BOOT_TIMEOUT_MS = 150_000;
const PROBE_INTERVAL_MS = 250;
const LOG = "/tmp/gittifacts-preview.log";
/** Header the gateway uses to tell the host which preview it is (clients' copies are stripped). */
export const PREVIEW_ID_HEADER = "x-gittifacts-preview-id";

export const PreviewConfig = z.object({
  previewId: z.string().min(3).max(63),
  changeId: z.string().min(1).max(64),
  repoId: z.string().min(1).max(64),
  projectName: z.string().min(1).max(100),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  artifactsRepo: z.string().min(1).max(100),
  snapshotId: z.string().min(1).max(200),
  snapshotStep: z.enum(["build", "install"]),
  template: z.string().nullable(),
  claimed: z.boolean(),
});
export type PreviewConfig = z.infer<typeof PreviewConfig>;

export interface PreviewState {
  status: "idle" | "booting" | "ready" | "failed";
  detail: string | null;
  readyAt: string | null;
  bootMs: number | null;
}

const IDLE: PreviewState = { status: "idle", detail: null, readyAt: null, bootMs: null };

/** The slice of `ctx.container` a preview needs (tests substitute a fake). */
export interface PreviewContainer {
  readonly running: boolean;
  start(options: ContainerStartupOptions): void;
  monitor(): Promise<void>;
  exec(cmd: string[], options?: ContainerExecOptions): Promise<{ exitCode: Promise<number> }>;
  getTcpPort(port: number): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  setInactivityTimeout(durationMs: number): Promise<void>;
  interceptAllOutboundHttp(binding: Fetcher): Promise<void>;
  interceptOutboundHttps(addr: string, binding: Fetcher): Promise<void>;
}

export interface PreviewHostEnv {
  DB: D1Database;
  ARTIFACTS: Artifacts;
  CF_ACCOUNT_ID: string;
  ARTIFACTS_NAMESPACE: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class PreviewHost extends DurableObject<PreviewHostEnv> {
  private state: PreviewState = IDLE;
  private booting: Promise<PreviewState> | null = null;

  /** The container seam (`ctx.container`); null where containers are unavailable. */
  protected container(): PreviewContainer | null {
    return (this.ctx.container as PreviewContainer | undefined) ?? null;
  }

  /** `ctx.exports.CiEgressGateway({ props })`, for checkouts from an install snapshot. */
  protected egressGateway(props: EgressProps): Fetcher | null {
    const exportsObject: unknown = this.ctx.exports;
    if (typeof exportsObject !== "object" || exportsObject === null) return null;
    const factory: unknown = Reflect.get(exportsObject, EGRESS_GATEWAY_EXPORT);
    if (typeof factory !== "function") return null;
    return Reflect.apply(factory, exportsObject, [{ props }]) as Fetcher;
  }

  // ------------------------------------------------------------------ RPC

  /**
   * Configure this preview and boot it, waiting up to `waitMs` for it to serve. Idempotent: a
   * second call for the same head returns the current state (or waits on the running boot).
   */
  async ensure(raw: unknown, opts: { waitMs: number }): Promise<PreviewState> {
    const config = PreviewConfig.parse(raw);
    const stored = await this.ctx.storage.get<PreviewConfig>("config");
    if (
      stored === undefined ||
      stored.headSha !== config.headSha ||
      stored.snapshotId !== config.snapshotId
    ) {
      await this.ctx.storage.put("config", config);
      if (this.state.status === "failed") this.state = IDLE;
    }
    const boot = this.boot(config);
    const waited = await Promise.race([
      boot,
      sleep(Math.max(0, Math.min(opts.waitMs, BOOT_TIMEOUT_MS))).then(() => null),
    ]);
    return waited ?? this.state;
  }

  async status(): Promise<PreviewState> {
    return this.state;
  }

  override async fetch(request: Request): Promise<Response> {
    const config = await this.loadConfig(request.headers.get(PREVIEW_ID_HEADER));
    if (config === null) {
      return errorPage(request, 404, "No such preview", "This preview does not exist (yet).");
    }
    const c = this.container();
    if (c === null) {
      return errorPage(
        request,
        503,
        "Previews are unavailable",
        "This deployment has no preview containers.",
      );
    }
    if (this.state.status === "ready" && c.running) {
      try {
        return await this.proxy(c, request);
      } catch {
        // The server went away (container slept or the process exited): boot again below.
        this.state = IDLE;
      }
    }
    if (this.state.status === "failed") {
      return errorPage(
        request,
        502,
        "The preview failed to start",
        this.state.detail ?? "The preview server did not start.",
      );
    }
    // Wake up (or keep booting) in the background; this request gets a "starting" answer.
    this.ctx.waitUntil(this.boot(config).catch(() => undefined));
    return busyPage(request, {
      title: "Starting preview…",
      body: `Waking up the preview of ${config.projectName} (${config.headSha.slice(0, 8)}). This page reloads by itself.`,
      projectName: config.projectName,
      changeId: config.changeId,
    });
  }

  // ------------------------------------------------------------------ internals

  private async loadConfig(previewId: string | null): Promise<PreviewConfig | null> {
    const stored = await this.ctx.storage.get<PreviewConfig>("config");
    if (stored !== undefined) return stored;
    if (previewId === null) return null;
    const row = await drizzle(this.env.DB)
      .select()
      .from(previews)
      .where(eq(previews.id, previewId))
      .get();
    if (row === undefined) return null;
    const parsed = PreviewConfig.safeParse({
      previewId: row.id,
      changeId: row.changeId,
      repoId: row.repoId,
      projectName: row.projectName,
      headSha: row.headSha,
      artifactsRepo: row.artifactsRepo,
      snapshotId: row.snapshotId,
      snapshotStep: row.snapshotStep,
      template: row.template,
      claimed: row.claimed,
    });
    if (!parsed.success) return null;
    await this.ctx.storage.put("config", parsed.data);
    return parsed.data;
  }

  private async proxy(c: PreviewContainer, request: Request): Promise<Response> {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete(PREVIEW_ID_HEADER);
    const init: RequestInit = { method: request.method, headers, redirect: "manual" };
    if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
    return c.getTcpPort(PREVIEW_PORT).fetch(`http://container${url.pathname}${url.search}`, init);
  }

  private boot(config: PreviewConfig): Promise<PreviewState> {
    if (this.state.status === "ready") return Promise.resolve(this.state);
    this.booting ??= this.doBoot(config).finally(() => {
      this.booting = null;
    });
    return this.booting;
  }

  private async doBoot(config: PreviewConfig): Promise<PreviewState> {
    const c = this.container();
    if (c === null) {
      this.state = { ...IDLE, status: "failed", detail: "no container runtime here" };
      return this.state;
    }
    const started = Date.now();
    this.state = { ...IDLE, status: "booting" };
    try {
      if (!c.running || !(await this.serving(c))) {
        if (!c.running) await this.startContainer(c, config);
        await this.startServer(c, config, started);
      }
      this.state = {
        status: "ready",
        detail: null,
        readyAt: new Date().toISOString(),
        bootMs: Date.now() - started,
      };
    } catch (e) {
      this.state = { ...IDLE, status: "failed", detail: message(e).slice(0, 2000) };
    }
    return this.state;
  }

  private async startContainer(c: PreviewContainer, config: PreviewConfig): Promise<void> {
    try {
      c.start({
        containerSnapshot: { id: config.snapshotId },
        // Previews have no internet (unclaimed or not, for now): only the gateway reaches in.
        enableInternet: false,
        instance: "standard-1",
        // Container label keys are limited to 16 bytes.
        labels: { "gf-preview": config.previewId.slice(0, 63) },
      });
    } catch (e) {
      throw new Error(`the ${config.snapshotStep} snapshot could not be restored: ${message(e)}`);
    }
    c.monitor().then(
      () => {
        this.state = IDLE;
      },
      () => {
        this.state = IDLE;
      },
    );
    await c.setInactivityTimeout(IDLE_MS);
    if (config.snapshotStep === "install") await this.checkout(c, config);
  }

  /** From an install snapshot: fetch the head through the egress gateway (git host only). */
  private async checkout(c: PreviewContainer, config: PreviewConfig): Promise<void> {
    const gitHost = `${this.env.CF_ACCOUNT_ID}.artifacts.cloudflare.net`;
    const gateway = this.egressGateway({
      runner: `preview:${config.previewId}`,
      registries: [],
      gitHost,
    });
    if (gateway === null) throw new Error(`the Worker does not export ${EGRESS_GATEWAY_EXPORT}`);
    await c.interceptAllOutboundHttp(gateway);
    await c.interceptOutboundHttps("*", gateway);
    const trust = await c.exec(["sh", "-c", trustCaScript(CONTAINERS_CA_PATH)], {
      cwd: "/",
      user: ROOT_USER,
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await trust.exitCode) !== 0) throw new Error("could not trust the egress interception CA");
    const repo = await this.env.ARTIFACTS.get(config.artifactsRepo);
    const { plaintext } = await repo.createToken("read", 900);
    const remote = `https://${gitHost}/git/${this.env.ARTIFACTS_NAMESPACE}/${config.artifactsRepo}.git`;
    const proc = await c.exec(["sh", "-c", CHECKOUT_SCRIPT], {
      cwd: "/",
      user: RUNNER_USER,
      env: {
        ...checkoutEnv({ remote, headSha: config.headSha, token: plaintext }),
        NODE_EXTRA_CA_CERTS: CONTAINERS_CA_PATH,
        GIT_SSL_CAINFO: "/etc/ssl/certs/ca-certificates.crt",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exitCode;
    if (code !== 0)
      throw new Error(`checking out ${config.headSha.slice(0, 12)} failed (exit ${code})`);
  }

  private async serving(c: PreviewContainer): Promise<boolean> {
    try {
      const res = await c
        .getTcpPort(PREVIEW_PORT)
        .fetch("http://container/", { redirect: "manual" });
      await res.body?.cancel();
      return true;
    } catch {
      return false;
    }
  }

  /** `gittifacts-runner preview` in the background; ready once the port answers. */
  private async startServer(
    c: PreviewContainer,
    config: PreviewConfig,
    started: number,
  ): Promise<void> {
    const proc = await c.exec(
      [
        "sh",
        "-c",
        `exec gittifacts-runner preview --port ${PREVIEW_PORT} --ip 0.0.0.0 > ${LOG} 2>&1`,
      ],
      {
        cwd: WORKSPACE,
        user: RUNNER_USER,
        env: { HOME: RUNNER_HOME, GITTIFACTS_PREVIEW_ID: config.previewId },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    let exited: number | null = null;
    proc.exitCode.then(
      (code) => {
        exited = code;
      },
      () => {
        exited = -1;
      },
    );
    while (Date.now() - started < BOOT_TIMEOUT_MS) {
      if (await this.serving(c)) return;
      if (exited !== null) {
        throw new Error(`the preview server exited (${exited}): ${await this.logTail(c)}`);
      }
      await sleep(PROBE_INTERVAL_MS);
    }
    throw new Error(`nothing answered on port ${PREVIEW_PORT} within ${BOOT_TIMEOUT_MS / 1000} s`);
  }

  private async logTail(c: PreviewContainer): Promise<string> {
    try {
      const proc = (await c.exec(["tail", "-c", "1500", LOG], {
        user: RUNNER_USER,
        stdout: "pipe",
        stderr: "ignore",
      })) as { exitCode: Promise<number>; stdout?: ReadableStream<Uint8Array> | null };
      const text = proc.stdout ? await new Response(proc.stdout).text() : "";
      return text.trim() || "(no output)";
    } catch {
      return "(no log)";
    }
  }
}
