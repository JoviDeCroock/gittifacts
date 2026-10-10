/**
 * Page commands: one handler per name, reached from a single-key shortcut on the page or from the
 * palette (`gf:command` events), so a key and its palette row can never do different things.
 * Keys never fire while typing, with a modifier held, or while a dialog is open; no key signs
 * anything on its own (A opens the decision, it doesn't approve).
 */
import { useEffect, useRef } from "preact/hooks";
import type { PageCommand } from "../lib/commands.js";

type Handlers = Partial<Record<PageCommand, () => void>>;

function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/**
 * `keys` maps a lowercase key to a page command or a plain action (e.g. go to evidence).
 * Handlers are read through a ref, so callers can pass fresh closures every render.
 */
export function usePageCommands(handlers: Handlers, keys: Record<string, PageCommand | (() => void)> = {}): void {
  const h = useRef(handlers);
  const k = useRef(keys);
  h.current = handlers;
  k.current = keys;
  useEffect(() => {
    const onCommand = (e: Event) => {
      const name = (e as CustomEvent<PageCommand>).detail;
      h.current[name]?.();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || typing(e.target)) return;
      if (document.querySelector("dialog[open]")) return;
      const action = k.current[e.key.toLowerCase()];
      if (!action) return;
      e.preventDefault();
      // A command key goes out as the same event the palette sends, so whichever component
      // owns that command (the decision panel owns approve) handles it.
      if (typeof action === "function") action();
      else window.dispatchEvent(new CustomEvent("gf:command", { detail: action }));
    };
    window.addEventListener("gf:command", onCommand);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("gf:command", onCommand);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}
