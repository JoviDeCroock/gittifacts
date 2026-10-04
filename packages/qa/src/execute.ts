/**
 * One step against the browser. Actions report whether they could act; expectations poll briefly
 * (async UIs) and report what they saw. A missing expectation target falls back to the page text,
 * so a wrong selector can't hide a visible answer, and an absent answer still fails.
 */
import type { Step } from "./script.js";
import type { ActionOutcome, QaBrowser } from "./types.js";

const POLL_MS = 250;
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const excerpt = (s: string, max = 160) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

export function describeStep(s: Step): string {
  const parts = [
    s.action,
    s.target === undefined ? null : JSON.stringify(s.target),
    s.value === undefined ? null : JSON.stringify(s.value),
  ];
  return parts.filter(Boolean).join(" ");
}

async function poll(
  b: QaBrowser,
  timeoutMs: number,
  check: () => Promise<boolean>,
): Promise<boolean> {
  const tries = Math.max(1, Math.ceil(timeoutMs / POLL_MS));
  for (let i = 0; i < tries; i++) {
    if (await check()) return true;
    if (i < tries - 1) await b.wait(POLL_MS);
  }
  return false;
}

async function pageText(b: QaBrowser, target: string | undefined): Promise<string> {
  if (target !== undefined) {
    const t = await b.textOf(target);
    if (t !== null) return t;
  }
  return (await b.textOf()) ?? "";
}

export async function executeStep(
  b: QaBrowser,
  s: Step,
  timeoutMs: number,
): Promise<ActionOutcome> {
  const need = (what: string): ActionOutcome => ({
    ok: false,
    detail: `${s.action} needs a ${what}`,
  });
  switch (s.action) {
    case "goto":
      return b.goto(s.target ?? s.value ?? "/");
    case "click":
      return s.target === undefined ? need("target") : b.click(s.target);
    case "fill":
      return s.target === undefined ? need("target") : b.fill(s.target, s.value ?? "");
    case "press":
      return b.press(s.value ?? s.target ?? "Enter");
    case "select":
      return s.target === undefined ? need("target") : b.select(s.target, s.value ?? "");
    case "wait":
      await b.wait(Math.min(2000, Math.max(0, Number(s.value) || 500)));
      return { ok: true };
    case "expect_text": {
      if (s.value === undefined || s.value.trim() === "") return need("value");
      const want = norm(s.value);
      let seen = "";
      const ok = await poll(b, timeoutMs, async () => {
        seen = await pageText(b, s.target);
        return norm(seen).includes(want);
      });
      return ok
        ? { ok, detail: `found "${excerpt(s.value)}"` }
        : { ok, detail: `"${excerpt(s.value)}" not found; saw "${excerpt(seen)}"` };
    }
    case "expect_no_text": {
      if (s.value === undefined || s.value.trim() === "") return need("value");
      await b.wait(POLL_MS);
      const seen = await pageText(b, s.target);
      const present = norm(seen).includes(norm(s.value));
      return present
        ? { ok: false, detail: `"${excerpt(s.value)}" is on the page` }
        : { ok: true, detail: `"${excerpt(s.value)}" absent` };
    }
    case "expect_visible": {
      if (s.target === undefined) return need("target");
      const target = s.target;
      const ok = await poll(b, timeoutMs, () => b.isVisible(target));
      return ok ? { ok } : { ok, detail: `${target} is not visible` };
    }
    case "expect_url": {
      const want = s.value ?? s.target;
      if (want === undefined) return need("value");
      let path = "";
      const ok = await poll(b, timeoutMs, async () => {
        path = await b.path();
        return path.includes(want);
      });
      return ok
        ? { ok, detail: `at ${path}` }
        : { ok, detail: `URL is ${path}, expected it to contain ${want}` };
    }
  }
}
