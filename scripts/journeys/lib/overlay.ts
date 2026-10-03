/**
 * The overlay injected into every page of a recording (an init script, so it survives full
 * navigations): a visible cursor (a finger dot on phones) with click ripples, the real elapsed
 * time in a corner, chapter captions and the "⏩ 34 s" marker shown after a cut.
 * Everything is pointer-events: none and sits in its own fixed layer above the app.
 */
export interface OverlayOptions {
  /** Wall-clock start of the journey (ms since epoch): the corner clock shows real time since. */
  t0: number;
  mobile: boolean;
}

/** Browser-side source. Runs before any page script; exposes `window.__gf`. */
export function overlayScript(opts: OverlayOptions): string {
  return `(() => {
  const T0 = ${opts.t0};
  const MOBILE = ${opts.mobile};
  if (window.top !== window) return; // not inside iframes (Turnstile)
  const css = \`
  #gf-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483647;font:500 13px/1.3 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  #gf-cursor{position:fixed;left:0;top:0;width:22px;height:22px;transform:translate(-3px,-2px);will-change:left,top;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}
  #gf-cursor.finger{width:34px;height:34px;border-radius:50%;background:rgba(40,40,40,.28);border:2px solid rgba(255,255,255,.85);transform:translate(-17px,-17px);filter:none}
  .gf-ripple{position:fixed;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:3px solid #ff6a00;animation:gf-r .55s ease-out forwards}
  @keyframes gf-r{to{transform:scale(3.4);opacity:0}}
  #gf-clock{position:fixed;right:10px;bottom:10px;padding:4px 9px;border-radius:999px;background:rgba(17,17,17,.78);color:#fff;font-variant-numeric:tabular-nums;letter-spacing:.01em}
  #gf-clock b{color:#ffb26b;font-weight:600}
  #gf-ff{position:fixed;left:50%;top:14px;transform:translateX(-50%);padding:7px 14px;border-radius:999px;background:#111;color:#fff;font-size:15px;font-weight:600;opacity:0;transition:opacity .2s}
  #gf-ff.on{opacity:.92}
  #gf-cap{position:fixed;left:50%;bottom:44px;transform:translateX(-50%);max-width:min(86vw,760px);padding:8px 14px;border-radius:10px;background:rgba(17,17,17,.86);color:#fff;font-size:\${MOBILE ? 13 : 15}px;text-align:center;opacity:0;transition:opacity .25s}
  #gf-cap.on{opacity:1}
  #gf-layer.hidden{display:none}
  #gf-layer.m #gf-clock{right:auto;left:50%;bottom:auto;top:6px;transform:translateX(-50%);font-size:11px;padding:3px 8px;opacity:.85}
  #gf-layer.m #gf-cap{bottom:auto;top:78px}
  #gf-layer.m #gf-ff{top:34px}\`;
  const arrow = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2l15 9.2-6.6 1.3L8.6 19z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  let layer, cursor, clock, ff, cap, capTimer, ffTimer;
  const fmt = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const m = Math.floor(s / 60); return m + ":" + String(s % 60).padStart(2, "0"); };
  function mount() {
    if (document.getElementById("gf-layer")) return;
    const style = document.createElement("style"); style.textContent = css;
    layer = document.createElement("div"); layer.id = "gf-layer"; if (MOBILE) layer.className = "m";
    cursor = document.createElement("div"); cursor.id = "gf-cursor";
    if (MOBILE) cursor.className = "finger"; else cursor.innerHTML = arrow;
    cursor.style.left = "-60px"; cursor.style.top = "-60px";
    clock = document.createElement("div"); clock.id = "gf-clock";
    ff = document.createElement("div"); ff.id = "gf-ff";
    cap = document.createElement("div"); cap.id = "gf-cap";
    layer.append(style, cap, ff, clock, cursor);
    document.documentElement.appendChild(layer);
    const tick = () => { clock.innerHTML = "real time <b>" + fmt(Date.now() - T0) + "</b>"; };
    tick(); setInterval(tick, 250);
  }
  const move = (x, y) => { if (!cursor) return; cursor.style.left = x + "px"; cursor.style.top = y + "px"; };
  window.addEventListener("mousemove", (e) => move(e.clientX, e.clientY), true);
  window.addEventListener("mousedown", (e) => {
    if (!layer) return;
    const r = document.createElement("div"); r.className = "gf-ripple";
    r.style.left = e.clientX + "px"; r.style.top = e.clientY + "px";
    layer.appendChild(r); setTimeout(() => r.remove(), 700);
  }, true);
  window.__gf = {
    cursor: move,
    hide: (on) => { mount(); layer.classList.toggle("hidden", on !== false); },
    caption: (text, ms) => { mount(); clearTimeout(capTimer); cap.textContent = text; cap.classList.add("on"); if (ms) capTimer = setTimeout(() => cap.classList.remove("on"), ms); },
    clearCaption: () => { if (cap) cap.classList.remove("on"); },
    ff: (text, ms) => { mount(); clearTimeout(ffTimer); ff.textContent = text; ff.classList.add("on"); ffTimer = setTimeout(() => ff.classList.remove("on"), ms || 1200); },
  };
  if (document.documentElement) mount(); else document.addEventListener("DOMContentLoaded", mount);
})();`;
}
