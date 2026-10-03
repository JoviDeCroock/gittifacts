/** The 2 s title card every video starts with (also used by the terminal replay page). */
export interface TitleCard {
  number: string;
  title: string;
  persona: "human" | "agent";
  mode: "live" | "mock";
  date: string;
  viewport: string;
  /** One line under the title: what the journey shows. */
  subtitle?: string;
  host?: string;
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

export function titleCardHtml(card: TitleCard): string {
  const live = card.mode === "live";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{margin:0;height:100%;background:#0f0f10;color:#f4f1ea;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  main{box-sizing:border-box;height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 8vw;gap:18px}
  .num{font:600 14px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#ff8a3d;letter-spacing:.08em}
  h1{margin:0;font-size:clamp(28px,5.2vw,54px);line-height:1.08;font-weight:650;letter-spacing:-.02em;max-width:22ch}
  p{margin:0;font-size:clamp(15px,2vw,20px);color:#c9c4ba;max-width:52ch;line-height:1.4}
  .tags{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
  .tag{padding:6px 11px;border-radius:999px;border:1px solid #3a3835;font-size:13px;color:#e8e3d9}
  .tag.live{border-color:#2f7d4f;color:#8fe0ae}
  .tag.mock{border-color:#a3542b;color:#ffb48a;font-weight:600}
  .host{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:#8b867d}
</style></head><body><main>
  <div class="num">JOURNEY ${esc(card.number)} · GITTIFACTS</div>
  <h1>${esc(card.title)}</h1>
  ${card.subtitle ? `<p>${esc(card.subtitle)}</p>` : ""}
  <div class="tags">
    <span class="tag">${card.persona === "human" ? "Persona: human (browser)" : "Persona: agent (terminal)"}</span>
    <span class="tag ${live ? "live" : "mock"}">${live ? "LIVE platform" : "MOCK data"}</span>
    <span class="tag">${esc(card.viewport)}</span>
    <span class="tag">${esc(card.date)}</span>
  </div>
  ${card.host ? `<div class="host">${esc(card.host)}</div>` : ""}
</main></body></html>`;
}
