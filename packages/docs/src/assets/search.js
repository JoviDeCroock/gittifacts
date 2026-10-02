// Client-side search over the prebuilt index (/docs/search-index.json), fetched on first use.
// Every query word must match a page's title, headings, description or text; titles and
// headings weigh most. Results link straight to the matching heading.
window.gfDocsSearch = () => {
  const form = document.querySelector("[data-search]");
  const input = form?.querySelector("input");
  const list = document.getElementById("search-results");
  if (!form || !input || !list) return;
  form.hidden = false;
  let index = null;
  let loading = null;
  let active = -1;

  const load = () => {
    loading ??= fetch("/docs/search-index.json")
      .then((r) => (r.ok ? r.json() : []))
      .then((docs) => {
        index = docs.map((d) => ({
          ...d,
          lt: d.t.toLowerCase(),
          ld: d.d.toLowerCase(),
          lx: d.x.toLowerCase(),
          lh: d.h.map(([id, text]) => [id, text, text.toLowerCase()]),
        }));
      })
      .catch(() => {
        index = [];
      });
    return loading;
  };

  const score = (doc, terms) => {
    let total = 0;
    let heading = null;
    for (const t of terms) {
      let s = 0;
      if (doc.lt.includes(t)) s += doc.lt.split(/\W+/).some((w) => w.startsWith(t)) ? 14 : 10;
      const h = doc.lh.find(([, , lower]) => lower.includes(t));
      if (h) {
        s += 6;
        heading ??= h;
      }
      if (doc.ld.includes(t)) s += 3;
      if (doc.lx.includes(t)) s += 1;
      if (s === 0) return null;
      total += s;
    }
    return { doc, total, heading };
  };

  const escape = (s) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    active = -1;
  };

  const select = (i) => {
    const items = Array.from(list.querySelectorAll("a"));
    if (items.length === 0) return;
    active = (i + items.length) % items.length;
    items.forEach((a, j) => a.setAttribute("aria-selected", String(j === active)));
    items[active].scrollIntoView({ block: "nearest" });
  };

  const render = () => {
    const q = input.value.trim().toLowerCase();
    if (q === "" || index === null) return close();
    const terms = q.split(/\s+/).filter(Boolean);
    const hits = index
      .map((d) => score(d, terms))
      .filter(Boolean)
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);
    list.innerHTML =
      hits.length === 0
        ? `<p class="search__empty">No page matches “${escape(input.value.trim())}”.</p>`
        : hits
            .map(({ doc, heading }) => {
              const href = heading ? `${doc.u}#${heading[0]}` : doc.u;
              const where = [doc.s, heading?.[1]].filter(Boolean).join(" · ");
              return `<a role="option" aria-selected="false" href="${escape(href)}"><span class="search__title">${escape(doc.t)}</span><span class="search__where">${escape(where || doc.d)}</span></a>`;
            })
            .join("");
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    active = -1;
  };

  input.addEventListener("focus", () => void load());
  input.addEventListener("input", () => void load().then(render));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      select(active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      select(active - 1);
    } else if (e.key === "Escape") {
      close();
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const items = list.querySelectorAll("a");
    const target = items[Math.max(active, 0)];
    if (target) window.location.href = target.href;
  });
  document.addEventListener("click", (e) => {
    if (!form.contains(e.target)) close();
  });
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
    if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      input.focus();
    }
  });
};
