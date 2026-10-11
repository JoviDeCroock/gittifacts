/**
 * The output contract.
 *
 * - JSON (default): exactly one JSON document on stdout, success or error. Errors are
 *   `{ error: { code, message, fix }, ...meta }`. Progress and prompts go to stderr.
 * - `--human`: the same document as text sections and tables on stdout; errors on stderr.
 */
import type { ErrorBody } from "./errors.js";
import {
  makeStyle,
  renderError,
  renderHuman,
  type Style,
  stripControl,
  useColor,
} from "./human.js";
import type { CliIo } from "./io.js";
import { isRecord } from "./tools/schema.js";

export class Output {
  readonly style: Style;
  private readonly errStyle: Style;

  constructor(
    private readonly io: CliIo,
    readonly human: boolean,
  ) {
    this.style = makeStyle(human && useColor(io.stdout, io.env));
    this.errStyle = makeStyle(useColor(io.stderr, io.env));
  }

  private get width(): number {
    const cols = this.io.stdout.columns;
    return typeof cols === "number" && cols > 20 ? cols : 100;
  }

  /** `view` reshapes the document for `--human` only; the JSON output is always `doc`. */
  result(
    doc: unknown,
    opts: { title?: string | undefined; view?: ((doc: Record<string, unknown>) => unknown) | undefined } = {},
  ): void {
    if (this.human) {
      const shown = opts.view !== undefined && isRecord(doc) ? opts.view(doc) : doc;
      this.io.stdout.write(
        renderHuman(shown, { style: this.style, width: this.width, title: opts.title }),
      );
    } else {
      this.io.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
    }
  }

  error(body: ErrorBody, meta: Record<string, unknown> = {}): void {
    if (this.human) {
      this.io.stderr.write(renderError(body, { style: this.errStyle, width: this.width }, meta));
    } else {
      this.io.stdout.write(`${JSON.stringify({ error: body, ...meta }, null, 2)}\n`);
    }
  }

  /**
   * Progress lines (stderr) for people watching: shown with --human or on a terminal. They can
   * quote server text (a QA run's progress), so terminal control characters are stripped.
   */
  progress(line: string): void {
    if (this.human || this.io.stderr.isTTY)
      this.io.stderr.write(`${this.errStyle.dim(stripControl(line))}\n`);
  }

  /** Instructions someone must act on (stderr, always). */
  notice(line: string): void {
    this.io.stderr.write(`${line}\n`);
  }
}
