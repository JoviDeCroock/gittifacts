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
              })
            ).module;
        return html.replace(MARKER, await mod.renderLanding());
      },
    },
  };
}
