/** Preview hostnames, the banner and the gateway's header hygiene. */
import { describe, expect, it } from "vitest";
import { hardenHeaders, withBanner } from "../src/previews/gateway.js";
import { parsePreviewHost, previewIdFor, previewUrlFor } from "../src/previews/ids.js";
import { BANNER_TAG, bannerHtml, busyPage } from "../src/previews/pages.js";

const ZONE = "-pv.resynapse.dev"; // host suffix: previews are first-level subdomains

describe("preview hostnames", () => {
  it("maps change ids to latest and pinned labels and back", () => {
    expect(previewIdFor("abc123")).toBe("p-abc123");
    expect(previewIdFor("abc123", "0123456789abcdef0123456789abcdef01234567")).toBe(
      "p-abc123-01234567",
    );
    expect(previewUrlFor(ZONE, "bs-r1")).toBe(`https://p-bs-r1${ZONE}`);
    expect(parsePreviewHost(`p-bs-r1${ZONE}`, ZONE)).toEqual({
      kind: "latest",
      previewId: "p-bs-r1",
      changeId: "bs-r1",
    });
    expect(parsePreviewHost(`P-ABC123-0123abcd${ZONE}.`, ZONE)).toEqual({
      kind: "pinned",
      previewId: "p-abc123-0123abcd",
      changeId: "abc123",
      sha8: "0123abcd",
    });
    expect(parsePreviewHost(`x.p-a${ZONE}`, ZONE)).toBeNull();
    expect(parsePreviewHost("gittifacts.example.com", ZONE)).toBeNull();
    expect(parsePreviewHost(`evil${ZONE}`, ZONE)).toBeNull();
    // The user's other subdomains are never previews.
    expect(parsePreviewHost("boris.resynapse.dev", ZONE)).toBeNull();
    // Labels longer than DNS allows (suffix included) are never minted.
    expect(previewUrlFor(ZONE, "x".repeat(70))).toBeNull();
    expect(previewUrlFor(ZONE, "x".repeat(58))).not.toBeNull(); // 60 + "-pv" = 63
    expect(previewUrlFor(ZONE, "x".repeat(59))).toBeNull();
    // A dedicated preview zone still works with a "." suffix.
    expect(previewUrlFor(".previews.example", "bs-r1")).toBe("https://p-bs-r1.previews.example");
  });
});

describe("gateway", () => {
  it("drops Domain cookies, forbids framing and indexing", () => {
    const h = new Headers({ "content-type": "text/html" });
    h.append("set-cookie", "a=1; Path=/");
    h.append("set-cookie", "b=2; domain=.resynapse.dev; Path=/");
    h.append("content-security-policy", "default-src 'self'");
    const out = hardenHeaders(h);
    expect(out.getSetCookie()).toEqual(["a=1; Path=/"]);
    expect(out.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(out.get("content-security-policy")).toBe("default-src 'self', frame-ancestors 'none'");
    expect(out.get("x-frame-options")).toBe("DENY");
  });

  it("injects the banner first in <body>, or at the end of a body-less document", async () => {
    const page = new Response(
      "<html><head><style>body{display:none}</style></head><body class=x><p>hi</p></body></html>",
      {
        headers: { "content-type": "text/html", "content-length": "99" },
      },
    );
    const html = await withBanner(page, "my-app", "c1").text();
    expect(html).toMatch(new RegExp(`<body class=x><${BANNER_TAG}[^>]*>`));
    expect(html).toContain("Preview of my-app · change c1 · not production · gittifacts");
    const fragment = await withBanner(
      new Response("<p>hi</p>", { headers: { "content-type": "text/html" } }),
      "a",
      "b",
    ).text();
    expect(fragment.startsWith("<p>hi</p>")).toBe(true);
    expect(fragment).toContain(`<${BANNER_TAG}`);
  });

  it("styles the banner so page CSS cannot hide it, and escapes names", () => {
    const html = bannerHtml('<script>"x"</script>', "c1");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("z-index:2147483647 !important");
    expect(html).toContain("position:fixed !important");
    expect(html).toContain('shadowrootmode="closed"');
  });

  it("asks browsers to come back with a self-refreshing page, others with Retry-After", async () => {
    const html = busyPage(new Request("https://x/", { headers: { accept: "text/html" } }), {
      title: "Starting preview…",
      body: "wait",
      retryAfter: 3,
    });
    expect(html.status).toBe(503);
    expect(await html.text()).toContain('<meta http-equiv="refresh" content="3">');
    const api = busyPage(new Request("https://x/api"), { title: "Starting", body: "wait" });
    expect(api.headers.get("content-type")).toContain("text/plain");
    expect(api.headers.get("retry-after")).toBe("3");
  });
});
