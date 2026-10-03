/**
 * A page recorder that can pause. Frames come from the CDP screencast (JPEG) and go to
 * Playwright's bundled ffmpeg (mjpeg in, VP8/webm out) at a constant frame rate: the latest frame
 * is repeated until the page paints a new one. While paused nothing is written, so a dead wait
 * (CI running, a queue batch) is cut from the video; the overlay shows how long the cut was.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CDPSession, Page } from "playwright";

/** Playwright's ffmpeg build (mjpeg decoder, VP8 encoder, webm muxer). GF_FFMPEG overrides. */
export function ffmpegPath(): string {
  if (process.env.GF_FFMPEG) return process.env.GF_FFMPEG;
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), "Library/Caches/ms-playwright"),
    join(homedir(), ".cache/ms-playwright"),
  ].filter((r): r is string => r !== undefined && existsSync(r));
  for (const root of roots) {
    const dirs = readdirSync(root)
      .filter((d) => d.startsWith("ffmpeg-"))
      .sort()
      .reverse();
    for (const d of dirs) {
      for (const bin of ["ffmpeg-mac", "ffmpeg-linux", "ffmpeg-win64.exe"]) {
        const p = join(root, d, bin);
        if (existsSync(p)) return p;
      }
    }
  }
  throw new Error(
    "Playwright's ffmpeg not found: run `npx playwright install ffmpeg` or set GF_FFMPEG",
  );
}

export interface RecorderOptions {
  /** Output .webm path. */
  out: string;
  /** Video size in pixels (frames are scaled to it). */
  width: number;
  height: number;
  fps?: number;
  /** VP8 target bitrate, e.g. "700k". */
  bitrate?: string;
}

export class Recorder {
  private ff: ChildProcess | null = null;
  private cdp: CDPSession | null = null;
  private last: Buffer | null = null;
  private frames = 0;
  private written = 0;
  private startedAt = 0;
  private pausedAt: number | null = null;
  private pausedTotal = 0;
  private timer: NodeJS.Timeout | null = null;
  private exited: Promise<void> = Promise.resolve();
  readonly fps: number;

  constructor(private readonly opts: RecorderOptions) {
    this.fps = opts.fps ?? 20;
  }

  /** Video time so far, in milliseconds. */
  get videoMs(): number {
    return Math.round((this.written * 1000) / this.fps);
  }

  async start(page: Page, scale = 1): Promise<void> {
    const { width, height, out } = this.opts;
    const ff = spawn(
      ffmpegPath(),
      [
        ...["-loglevel", "error", "-f", "image2pipe", "-avioflags", "direct"],
        ...["-fpsprobesize", "0", "-probesize", "32", "-analyzeduration", "0"],
        ...["-c:v", "mjpeg", "-framerate", String(this.fps), "-i", "pipe:0", "-y", "-an"],
        ...["-r", String(this.fps), "-c:v", "vp8", "-qmin", "4", "-qmax", "48", "-crf", "12"],
        ...["-b:v", this.opts.bitrate ?? "700k", "-deadline", "good", "-cpu-used", "4"],
        ...["-threads", "2", "-vf", `scale=${width}:${height}`, out],
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    this.ff = ff;
    this.exited = new Promise((resolve) => ff.on("exit", () => resolve()));
    const cdp = await page.context().newCDPSession(page);
    this.cdp = cdp;
    cdp.on("Page.screencastFrame", (f) => {
      this.last = Buffer.from(f.data, "base64");
      this.frames++;
      if (this.startedAt === 0) this.startedAt = Date.now();
      cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 88,
      maxWidth: Math.round(width * scale),
      maxHeight: Math.round(height * scale),
      everyNthFrame: 1,
    });
    this.timer = setInterval(() => this.pump(), Math.floor(500 / this.fps));
  }

  /** Writes the latest frame as often as the clock (minus paused time) asks for. */
  private pump(): void {
    if (this.pausedAt !== null || this.last === null || this.ff?.stdin === null) return;
    const due = Math.floor(((Date.now() - this.startedAt - this.pausedTotal) * this.fps) / 1000);
    while (this.written < due) {
      this.ff?.stdin?.write(this.last);
      this.written++;
    }
  }

  pause(): void {
    this.pump();
    this.pausedAt ??= Date.now();
  }

  resume(): void {
    if (this.pausedAt === null) return;
    this.pausedTotal += Date.now() - this.pausedAt;
    this.pausedAt = null;
  }

  /** Resolves once the page painted a frame after this call (or after `timeoutMs`). */
  async freshFrame(timeoutMs = 1500): Promise<void> {
    const seen = this.frames;
    const until = Date.now() + timeoutMs;
    while (this.frames === seen && Date.now() < until) await new Promise((r) => setTimeout(r, 30));
  }

  async stop(): Promise<void> {
    this.pump();
    if (this.timer) clearInterval(this.timer);
    await this.cdp?.send("Page.stopScreencast").catch(() => {});
    this.ff?.stdin?.end();
    await this.exited;
  }
}
