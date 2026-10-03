/** Text hygiene for tool output shown to people (reasons, notes, step logs). */

// CSI (ESC [ … final byte), OSC (ESC ] … BEL or ESC \), single-character escapes, and a bare
// CSI introducer (U+009B). Covers colours, cursor movement and hyperlinks.
const ANSI =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
  /[\u001b\u009b](?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/** `text` without ANSI escape sequences (colours, cursor moves, hyperlinks). */
export function stripAnsi(text: string): string {
  return text.includes("\u001b") || text.includes("\u009b") ? text.replace(ANSI, "") : text;
}
