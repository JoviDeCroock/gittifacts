/**
 * The two ports the QA loop drives, and its limits. The platform implements `QaBrowser` with
 * Browser Run (every app request answered by the Worker from a private preview); tests use a fake.
 */
import type { QaArtifact, QaRun } from "@app/evidence";
import type { LlmClient, LlmMetadata } from "@app/tour";

/** A compact, model-readable view of the current page. */
export interface PageSnapshot {
  /** Path + search on the app origin. */
  url: string;
  title: string;
  /** Visible text, whitespace-collapsed, cut to ~1500 characters. */
  text: string;
  /** Interactive elements, each with a selector the browser can resolve again. */
  elements: Array<{ selector: string; role: string; name: string; type?: string; value?: string }>;
}

/** What one browser action did. `ok: false` with `notFound` means the target wasn't there. */
export interface ActionOutcome {
  ok: boolean;
  detail?: string;
  notFound?: boolean;
  /** goto: the document's HTTP status, when it answered. */
  status?: number;
}

/**
 * A real browser on the app's origin. Targets are CSS selectors or `text=<visible text>` (the first
 * visible button, link, label or element whose text contains it).
 */
export interface QaBrowser {
  /** A fresh page (no cookies or storage from an earlier criterion). */
  reset(): Promise<void>;
  /** Load `path` on the app origin; not ok when the document answered ≥ 400 or didn't load. */
  goto(path: string): Promise<ActionOutcome>;
  click(target: string): Promise<ActionOutcome>;
  fill(target: string, value: string): Promise<ActionOutcome>;
  press(key: string): Promise<ActionOutcome>;
  select(target: string, value: string): Promise<ActionOutcome>;
  wait(ms: number): Promise<void>;
  /** Visible text of `target`, or of the whole page without one; null when the target is missing. */
  textOf(target?: string): Promise<string | null>;
  isVisible(target: string): Promise<boolean>;
  /** How many visible elements match `target` (a CSS selector). */
  count(target: string): Promise<number>;
  /** Path + search of the current page. */
  path(): Promise<string>;
  snapshot(): Promise<PageSnapshot>;
  /** A JPEG of the viewport (`thumb`: ≤ 400 px wide). Null when the page can't be captured. */
  screenshot(opts?: { thumb?: boolean }): Promise<Uint8Array | null>;
  /**
   * Since the last call: console errors and uncaught page errors (`pageerror: …`), and app requests
   * that failed or answered ≥ 400. Requests QA blocked itself are not errors (see blockedOrigins).
   */
  drainErrors(): { console: string[]; network: string[] };
  /** Origins other than the app's the page tried to reach (blocked). */
  blockedOrigins(): string[];
  /** Encode `frames` (JPEGs) into an animated GIF in the browser; null when it can't. */
  replayGif?(
    frames: Uint8Array[],
    opts: { width: number; delayMs: number },
  ): Promise<Uint8Array | null>;
  /** Browser time used so far, in milliseconds. */
  usedMs(): number;
}

/** Stores an artifact (R2 on the platform) and returns its signed-item record (hash included). */
export interface QaArtifactSink {
  put(
    name: string,
    bytes: Uint8Array,
    contentType: string,
    role: QaArtifact["role"],
  ): Promise<QaArtifact>;
}

export interface QaLimits {
  wallMs: number;
  browserMs: number;
  llmUsd: number;
  maxCriteria: number;
  maxSteps: number;
  maxScreenshots: number;
  stepTimeoutMs: number;
}

export const DEFAULT_LIMITS: QaLimits = {
  wallMs: 5 * 60_000,
  browserMs: 3 * 60_000,
  llmUsd: 0.05,
  maxCriteria: 8,
  maxSteps: 10,
  maxScreenshots: 60,
  stepTimeoutMs: 5_000,
};

export interface QaCriterionInput {
  text: string;
  source: "plan" | "smoke";
}

export interface QaRunInput {
  runId: string;
  trigger: QaRun["trigger"];
  requestedBy: string;
  origin: string;
  snapshotStep: "build" | "install";
  criteria: QaCriterionInput[];
  /** Routes to explore first (≤ 4 are used). */
  routes: string[];
  /** Paths the Change touched (context for the planner; never file contents). */
  changedFiles: string[];
  limits?: Partial<QaLimits>;
}

export interface QaDeps {
  browser: QaBrowser;
  /** The reviewer's model client; null runs without a model (smoke checks only). */
  llm: LlmClient | null;
  artifacts: QaArtifactSink;
  /** Monotonic milliseconds. */
  now(): number;
  metadata: LlmMetadata;
  log?(event: string, data: Record<string, unknown>): void;
}
