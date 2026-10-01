/**
 * The output contract.
 *
 * - JSON (default): exactly one JSON document on stdout, success or error. Errors are
 *   `{ error: { code, message, fix }, ...meta }`. Progress and prompts go to stderr.
 * - `--human`: the same document as text sections and tables on stdout; errors on stderr.
 */
import type { ErrorBody } from "./errors.js";
import { makeStyle, renderError, renderHuman, type Style, useColor } from "./human.js";
import type { CliIo } from "./io.js";

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

  result(doc: unknown, opts: { title?: string | undefined } = {}): void {
    if (this.human) {
      this.io.stdout.write(renderHuman(doc, { style: this.style, width: this.width, title: opts.title }));
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

  /** Progress lines (stderr) for people watching: shown with --human or on a terminal. */
  progress(line: string): void {
    if (this.human || this.io.stderr.isTTY) this.io.stderr.write(`${this.errStyle.dim(line)}\n`);
  }

  /** Instructions someone must act on (stderr, always). */
  notice(line: string): void {
    this.io.stderr.write(`${line}\n`);
  }
}
