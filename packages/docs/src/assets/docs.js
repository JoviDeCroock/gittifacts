// gittifacts docs: the page's only script. Copy buttons, the phone menu, the theme switch,
// search over /docs/search-index.json, and the on-page TOC highlight. Pages work without it.
(() => {
  const THEME_KEY = "gf:theme";
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const announce = (text) => {
    const s = $("#copy-status");
    if (s) s.textContent = text;
  };

  function copyButtons() {
    if (!navigator.clipboard) return;
    for (const btn of $$("[data-copy]")) {
      btn.hidden = false;
      btn.setAttribute("aria-label", "Copy code");
      btn.addEventListener("click", async () => {
        const code = btn.closest(".code")?.querySelector("pre code");
        if (!code) return;
        try {
          await navigator.clipboard.writeText(code.textContent.replace(/\n$/, ""));
          btn.textContent = "Copied";
          btn.dataset.state = "done";
          announce("Copied to the clipboard");
        } catch {
          btn.textContent = "Select to copy";
          announce("Copying failed. Select the text and copy it instead.");
        }
        setTimeout(() => {
          btn.textContent = "Copy";
          delete btn.dataset.state;
        }, 2000);
      });
    }
  }

  function menu() {
    const btn = $("[data-menu]");
    const sidebar = $("#sidebar");
    if (!btn || !sidebar) return;
    let backdrop = null;
    const set = (open) => {
      btn.setAttribute("aria-expanded", String(open));
      btn.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
      if (open) {
        sidebar.setAttribute("data-open", "");
        backdrop = document.createElement("div");
        backdrop.className = "backdrop";
        backdrop.addEventListener("click", () => set(false));
        document.body.append(backdrop);
        sidebar.querySelector("a")?.focus();
      } else {
        sidebar.removeAttribute("data-open");
        backdrop?.remove();
        backdrop = null;
      }
    };
    btn.addEventListener("click", () => set(btn.getAttribute("aria-expanded") !== "true"));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && btn.getAttribute("aria-expanded") === "true") {
        set(false);
        btn.focus();
      }
    });
  }

  function theme() {
    const box = $("[data-theme-switch]");
    if (!box) return;
    let current = "system";
    try {
      current = localStorage.getItem(THEME_KEY) || "system";
    } catch {}
    box.hidden = false;
    for (const input of $$("input", box)) {
      input.checked = input.value === current;
      input.addEventListener("change", () => {
        const v = input.value;
        try {
          if (v === "system") localStorage.removeItem(THEME_KEY);
          else localStorage.setItem(THEME_KEY, v);
        } catch {}
        if (v === "system") document.documentElement.removeAttribute("data-theme");
        else document.documentElement.setAttribute("data-theme", v);
      });
    }
  }

  function tocSpy() {
    const links = $$(".toc a");
    if (links.length === 0 || !("IntersectionObserver" in window)) return;
    const byId = new Map(links.map((a) => [decodeURIComponent(a.hash.slice(1)), a]));
    const visible = new Set();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) (e.isIntersecting ? visible.add : visible.delete).call(visible, e.target.id);
        const first = $$(".prose h2[id], .prose h3[id]").find((h) => visible.has(h.id));
        if (!first) return;
        for (const a of links) a.removeAttribute("aria-current");
        byId.get(first.id)?.setAttribute("aria-current", "true");
      },
      { rootMargin: "-64px 0px -60% 0px" },
    );
    for (const h of $$(".prose h2[id], .prose h3[id]")) io.observe(h);
  }

  document.addEventListener("DOMContentLoaded", () => {
    copyButtons();
    menu();
    theme();
    tocSpy();
    window.gfDocsSearch?.();
  });
})();
