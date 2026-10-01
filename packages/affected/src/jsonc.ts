/** JSON with comments and trailing commas (tsconfig.json, wrangler.jsonc). */

/** Index of the next significant character at or after `i` (skipping whitespace and comments). */
function nextSignificant(text: string, from: number): number {
  let i = from;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
    } else return i;
  }
  return n;
}

/** Strip `//` and block comments outside strings, and trailing commas. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      i = nextSignificant(text, i);
      continue;
    }
    if (c === ",") {
      const next = text[nextSignificant(text, i + 1)];
      if (next === "}" || next === "]") {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** Parse JSONC; null when it is not valid even after stripping comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(stripJsonc(text.replace(/^﻿/, "")));
  } catch {
    return null;
  }
}
