/**
 * An agent's mark: the one square every screen draws for an agent (people are circles). Two marks
 * must never read alike, and none may read as a severity code ("P0") or a lane, so:
 *
 * - the glyph is the first letter plus the agent's number when its name ends in one ("F12" for
 *   fleet-coder-12, "P02" for planner-02, never "FC" twice), else the initials of two words;
 * - a stable variant, picked from the principal id, sets the ground (solid ink or an ink outline)
 *   and the corner (square or notched). Ink, paper and shape only: no hue, so the Band Means Lane
 *   Rule holds and the marks stay distinct in both themes.
 */
import "../styles/agent-mark.css";

/** The letters and digits printed in the mark. Pure, so the list and the band agree. */
export function markGlyph(name: string): string {
  const words = name
    .trim()
    .split(/[-_\s.]+/)
    .filter(Boolean);
  const tail = words.length > 1 ? words[words.length - 1] : undefined;
  const digits = tail && /^\d+$/.test(tail) ? tail.slice(-3) : (/(\d{1,3})$/.exec(name.trim())?.[1] ?? "");
  const letters = words.filter((w) => /^\p{L}/u.test(w)).map((w) => w[0]!.toUpperCase());
  // A lone digit is padded ("P01", never "P1"), so no mark reads as a severity or priority code.
  if (digits) return `${letters[0] ?? "A"}${digits.padStart(2, "0")}`;
  return letters.slice(0, 2).join("") || "A";
}

/** 0 to 3: solid square, outline square, solid notched, outline notched. Stable per seed. */
export function markVariant(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 4;
}

export function AgentMark({ name, id, size = 36 }: { name: string; id?: string; size?: number }) {
  const glyph = markGlyph(name);
  const v = markVariant(id ?? name);
  const ground = v % 2 === 0 ? "solid" : "outline";
  const notched = v >= 2;
  // Three characters need a smaller face than two to sit inside the square.
  const font = Math.max(8, Math.round(size * (glyph.length > 2 ? 0.33 : 0.4)));
  return (
    <span
      class={`avatar avatar--agent agent-mark agent-mark--${ground}${notched ? " agent-mark--notched" : ""}`}
      style={{ width: `${size}px`, height: `${size}px`, fontSize: `${font}px` }}
      data-glyph={glyph}
      aria-hidden="true"
    >
      {glyph}
    </span>
  );
}
