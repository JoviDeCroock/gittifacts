/**
 * Prerenders the marketing landing page (landing.html) at build time and on every dev request:
 * src/landing/render.tsx is loaded through Vite's module runner and its HTML replaces the
 * `<!--landing-->` marker. The page ships as static HTML; no app code reaches the browser.
 */
import { type Plugin, runnerImport, type ViteDevServer } from "vite";

const MARKER = "<!--landing-->";
const ENTRY = "/src/landing/render.tsx";

interface RenderModule {
  renderLanding(): Promise<string>;
}

const CSS_STUB = "\0landing-css-stub";

function cssStub(): Plugin {
  return {
    name: "gittifacts:landing-css-stub",
    enforce: "pre",
    resolveId: (source) => (source.endsWith(".css") ? CSS_STUB : null),
    load: (id) => (id === CSS_STUB ? "export default {};" : null),
  };
}

export function landingPrerender(): Plugin {
  let root = "";
  let server: ViteDevServer | undefined;
  return {
    name: "gittifacts:landing-prerender",
    configResolved(config) {
      root = config.root;
    },
    configureServer(s) {
      server = s;
    },
    transformIndexHtml: {
      order: "pre",
      async handler(html, ctx) {
        if (!ctx.filename.endsWith("landing.html")) return html;
        if (!html.includes(MARKER)) throw new Error(`landing.html has no ${MARKER} marker`);
        const mod = server
          ? ((await server.ssrLoadModule(ENTRY)) as RenderModule)
          : (
              await runnerImport<RenderModule>(`${root}${ENTRY}`, {
                configFile: false,
                root,
                logLevel: "error",
                oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
                // Components import their stylesheets (landing.css bundles them for the page);
                // the prerender only needs markup, so CSS imports resolve to an empty module.
                plugins: [cssStub()],
              })
            ).module;
        return html.replace(MARKER, await mod.renderLanding());
      },
    },
  };
}

/**
 * Preloads the latin subset of the UI face on the landing page, so the display headline does
 * not shift when the font swaps in. Build only: the hashed file name exists after bundling.
 */
export function landingFontPreload(): Plugin {
  return {
    name: "gittifacts:landing-font-preload",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (!ctx.filename.endsWith("landing.html") || !ctx.bundle) return html;
        const font = Object.keys(ctx.bundle).find((f) =>
          /atkinson-hyperlegible-next-latin-wght-normal.*\.woff2$/.test(f),
        );
        if (!font) return html;
        return {
          html,
          tags: [
            {
              tag: "link",
              attrs: {
                rel: "preload",
                href: `/${font}`,
                as: "font",
                type: "font/woff2",
                crossorigin: "",
              },
              injectTo: "head-prepend",
            },
          ],
        };
      },
    },
  };
}
