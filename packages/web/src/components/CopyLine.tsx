/**
 * The Copy Line (DESIGN.md, Components): a value a reader will paste, as selectable mono text in a
 * sheet field, with a 44px teal copy button behind a hairline. The app's twin of the landing's
 * script-free copy line, so a command looks and behaves the same before and after sign-in.
 */
import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import { BreakableCode } from "./ui.js";
import { Icon } from "./Icon.js";
import "../styles/copy-line.css";

export function CopyLine({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const state = useSignal<"idle" | "done" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      state.value = "done";
    } catch {
      state.value = "failed";
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => (state.value = "idle"), 1800);
  }
  return (
    <div class="copy-line" data-testid={testId}>
      <span class="copy-line__text">
        <BreakableCode text={text} />
      </span>
      <button type="button" class="copy-line__btn" aria-label={label} data-state={state.value} onClick={copy}>
        <Icon name={state.value === "done" ? "check" : "copy"} size={16} />
        <span class="copy-line__done" aria-hidden="true">
          {state.value === "failed" ? "Select it instead" : "Copied"}
        </span>
      </button>
      <span class="sr-only" aria-live="polite">
        {state.value === "done" ? `Copied ${text}` : state.value === "failed" ? "Copying failed. Select the text and copy it instead." : ""}
      </span>
    </div>
  );
}
