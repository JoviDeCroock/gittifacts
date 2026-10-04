/**
 * Scripts evaluated in the QA page, as plain-JS strings: wrangler's esbuild keeps function names
 * by injecting `__name(...)` calls, which don't exist in the page, so no TS function is ever
 * stringified into it. Each is an expression taking JSON arguments.
 */

/** Shared helpers: visibility and `text=` resolution. */
const HELPERS = String.raw`
  var visible = function (el) {
    if (!el || !el.getBoundingClientRect) return false;
    var s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
  };
  var byText = function (text) {
    var want = text.replace(/\s+/g, " ").trim().toLowerCase();
    var pref = "button, a, [role=button], [role=link], input[type=submit], input[type=button], label, summary, [onclick]";
    var pools = [Array.prototype.slice.call(document.querySelectorAll(pref)), Array.prototype.slice.call(document.querySelectorAll("body *"))];
    for (var p = 0; p < pools.length; p++) {
      var best = null;
      for (var i = 0; i < pools[p].length; i++) {
        var el = pools[p][i];
        var t = ((el.innerText || el.value || el.getAttribute("aria-label") || "") + "").replace(/\s+/g, " ").trim().toLowerCase();
        if (t.indexOf(want) < 0 || !visible(el)) continue;
        if (best === null || t.length < best.t.length) best = { el: el, t: t };
      }
      if (best !== null) return best.el;
    }
    return null;
  };
  var find = function (target) {
    if (target.indexOf("text=") === 0) return byText(target.slice(5));
    try { return document.querySelector(target); } catch (e) { return null; }
  };`;

/** `(target, tag) → boolean`: mark the target with data-gf-qa=tag so puppeteer can act on it. */
export const TAG_TARGET = String.raw`(function (target, tag) {${HELPERS}
  var old = document.querySelectorAll("[data-gf-qa]");
  for (var i = 0; i < old.length; i++) old[i].removeAttribute("data-gf-qa");
  var el = find(target);
  if (!el) return false;
  el.setAttribute("data-gf-qa", tag);
  return true;
})`;

/** `(target | null) → string | null`: visible text of the target, or of the page. */
export const TEXT_OF = String.raw`(function (target) {${HELPERS}
  if (target === null) return document.body ? document.body.innerText : "";
  var el = find(target);
  if (!el) return null;
  return (el.innerText || el.value || el.textContent || "") + "";
})`;

/** `(target) → boolean` */
export const IS_VISIBLE = String.raw`(function (target) {${HELPERS}
  return visible(find(target));
})`;

/** `() → PageSnapshot` without the url: title, visible text, up to 40 interactive elements. */
export const SNAPSHOT = String.raw`(function () {${HELPERS}
  var css = function (v) { return /^[A-Za-z][\w-]*$/.test(v); };
  var q = function (v) { return '"' + v.replace(/"/g, '\\"') + '"'; };
  var sel = "a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=tab], [contenteditable=true]";
  var els = Array.prototype.slice.call(document.querySelectorAll(sel)).filter(visible).slice(0, 40);
  var out = els.map(function (el) {
    var name = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.value || el.getAttribute("title") || el.getAttribute("name") || "").replace(/\s+/g, " ").trim().slice(0, 80);
    var tag = el.tagName.toLowerCase();
    var s = null;
    if (el.id && css(el.id) && document.querySelectorAll("#" + el.id).length === 1) s = "#" + el.id;
    else if (el.getAttribute("data-testid")) s = "[data-testid=" + q(el.getAttribute("data-testid")) + "]";
    else if (el.getAttribute("name")) s = tag + "[name=" + q(el.getAttribute("name")) + "]";
    else if (name && (tag === "button" || tag === "a" || tag === "summary" || el.getAttribute("role"))) s = "text=" + name.slice(0, 60);
    else {
      var same = Array.prototype.slice.call(el.parentNode ? el.parentNode.children : []).filter(function (c) { return c.tagName === el.tagName; });
      s = tag + ":nth-of-type(" + (same.indexOf(el) + 1) + ")";
    }
    var role = el.getAttribute("role") || ({ a: "link", button: "button", select: "combobox", textarea: "textbox", summary: "button" })[tag] || (tag === "input" ? (el.type === "checkbox" ? "checkbox" : el.type === "submit" || el.type === "button" ? "button" : "textbox") : tag);
    var item = { selector: s, role: role, name: name };
    if (tag === "input") item.type = el.type;
    if ((tag === "input" || tag === "textarea" || tag === "select") && el.value) item.value = (el.value + "").slice(0, 60);
    return item;
  });
  // Structure the planner can count or read: lists (with how many items now) and headings.
  var structure = Array.prototype.slice.call(document.querySelectorAll("ol[id], ul[id], table[id], [data-testid]:not(button):not(a):not(input)")).slice(0, 10).map(function (el) {
    var tag = el.tagName.toLowerCase();
    var base = el.id && css(el.id) ? "#" + el.id : "[data-testid=" + q(el.getAttribute("data-testid")) + "]";
    var item = tag === "ol" || tag === "ul" ? " > li" : tag === "table" ? " tr" : "";
    var n = item ? el.querySelectorAll(item.replace(" > ", ":scope > ").trim()).length : 0;
    return { selector: base + item, role: item ? "items" : tag, name: item ? (tag === "table" ? "rows" : "items") + " of " + base + " (" + n + " now)" : (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60) };
  });
  out = structure.concat(out).slice(0, 45);
  var text = (document.body ? document.body.innerText : "").replace(/\s+/g, " ").trim().slice(0, 1500);
  return { title: document.title.slice(0, 120), text: text, elements: out };
})`;

/** `(target) → void`: clear an input's value (so fill replaces, not appends). */
export const CLEAR_VALUE = String.raw`(function (tag) {
  var el = document.querySelector('[data-gf-qa="' + tag + '"]');
  if (el && "value" in el) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); }
})`;

/**
 * `() → { width, height }`: how far the visible content reaches (text and controls, not the
 * full-width blocks around them), so a screenshot of a small page isn't mostly empty.
 */
export const CONTENT_BOX = `(function () {
  var w = 0, h = 0;
  var grow = function (b) { if (b.width > 0 && b.height > 0) { w = Math.max(w, b.right); h = Math.max(h, b.bottom); } };
  if (document.body) {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var n, range = document.createRange();
    while ((n = walker.nextNode())) { if (n.textContent.trim() !== "") { range.selectNodeContents(n); grow(range.getBoundingClientRect()); } }
    var els = document.body.querySelectorAll("input, button, select, textarea, img, svg, canvas, video, iframe, hr");
    for (var i = 0; i < els.length; i++) grow(els[i].getBoundingClientRect());
  }
  return { width: Math.ceil(w), height: Math.ceil(h) };
})()`;

/** `(selector) → number`: how many visible elements match (an invalid selector counts 0). */
export const COUNT = `(function (sel) {
  var visible = function (el) {
    var s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
  };
  try { return Array.prototype.slice.call(document.querySelectorAll(sel)).filter(visible).length; } catch (e) { return 0; }
})`;
