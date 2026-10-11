/**
 * A word a new person may not know yet, where it first appears: the word with a dotted
 * underline, its one-line hint as the button's accessible description, and on a tap or click a
 * small paper card with the hint and a link to the docs page that explains it (DESIGN.md, Term).
 * The card is a popover (top layer, light dismiss, Escape), placed under the word and kept inside
 * the viewport; it closes when the page scrolls, so it never floats away from its word.
 */
import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { TERMS, type TermId } from "../lib/terms.js";
import "../styles/term.css";

const GAP = 6;
const EDGE = 16;

export function Term({ id, children }: { id: TermId; children?: ComponentChildren }) {
  const t = TERMS[id];
  const hintId = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = card.current;
    if (!el) return;
    const close = () => {
      if (el.matches(":popover-open")) el.hidePopover();
    };
    const onToggle = (e: Event) => {
      const open = (e as ToggleEvent).newState === "open";
      btn.current?.setAttribute("aria-expanded", String(open));
      if (open) window.addEventListener("scroll", close, { passive: true, capture: true, once: true });
      else window.removeEventListener("scroll", close, { capture: true });
    };
    el.addEventListener("toggle", onToggle);
    return () => {
      el.removeEventListener("toggle", onToggle);
      window.removeEventListener("scroll", close, { capture: true });
    };
  }, []);

  function toggle() {
    const el = card.current;
    const b = btn.current;
    if (!el || !b || typeof el.showPopover !== "function") return;
    if (el.matches(":popover-open")) {
      el.hidePopover();
      return;
    }
    const r = b.getBoundingClientRect();
    const width = Math.min(288, window.innerWidth - 2 * EDGE);
    el.style.inlineSize = `${width}px`;
    el.style.left = `${Math.max(EDGE, Math.min(r.left, window.innerWidth - EDGE - width))}px`;
    el.style.top = `${r.bottom + GAP}px`;
    el.showPopover();
    // Not enough room below: open above the word instead.
    const h = el.offsetHeight;
    if (r.bottom + GAP + h > window.innerHeight - EDGE && r.top - GAP - h > EDGE) el.style.top = `${r.top - GAP - h}px`;
  }

  return (
    <span class="term" data-term={id}>
      <button type="button" ref={btn} class="term__word" aria-describedby={hintId} aria-expanded="false" aria-controls={hintId} onClick={toggle} data-testid="term">
        {children ?? t.word}
      </button>
      <span ref={card} id={hintId} class="term__card" {...{ popover: "auto" }} data-testid="term-card">
        <span class="term__hint">{t.hint}</span>{" "}
        <a class="term__more" href={t.href}>
          More about {t.word.toLowerCase()}
        </a>
      </span>
    </span>
  );
}
