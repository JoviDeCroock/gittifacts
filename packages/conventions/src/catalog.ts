/**
 * The launch templates (`templates/<id>/` in the monorepo): ids, manifests and the project
 * features their `.platform/ci.ts` is generated from. Data only; `templates.ts` renders files.
 */
import { z } from "zod";
import type { ProjectFeatures } from "./project.js";

export const TEMPLATE_IDS = ["workers-api", "preact-app", "ts-library", "static-site"] as const;
export const TemplateId = z.enum(TEMPLATE_IDS);
export type TemplateId = z.infer<typeof TemplateId>;
export const DEFAULT_TEMPLATE: TemplateId = "workers-api";

/** `templates/<id>/template.json`. */
export const TemplateManifest = z
  .object({
    id: TemplateId,
    title: z.string().min(1).max(60),
    description: z.string().min(1).max(200),
    /** Run from the built checkout to serve the preview; `$PORT` is set by the platform. null: no preview. */
    previewCommand: z.string().min(1).nullable(),
    /** Directory the build writes (relative to the repo root). */
    buildOutput: z.string().min(1),
    /** Routes to load (and screenshot) once the preview is up. */
    routes: z.array(z.string().startsWith("/")),
    /** Upper bound for the first CI run from a warm dependency snapshot. */
    expectedCiSeconds: z.number().int().positive(),
  })
  .strict();
export type TemplateManifest = z.infer<typeof TemplateManifest>;

const PREVIEW = "wrangler dev --ip 0.0.0.0 --port $PORT";

/** Config files whose changes affect every step's result. */
const CONFIG = ["package.json", "pnpm-lock.yaml", "tsconfig.json"];

function pnpmFeatures(cacheInputs: string[], worker: boolean): ProjectFeatures {
  return {
    hasPackageJson: true,
    packageManager: "pnpm",
    lockfile: "pnpm-lock.yaml",
    scripts: { lint: "lint", typecheck: "typecheck", test: "test", build: "build" },
    typescript: true,
    testRunner: "vitest",
    worker,
    cacheInputs,
  };
}

export interface TemplateSpec {
  manifest: TemplateManifest;
  features: ProjectFeatures;
  previewRoutes: string[];
}

export const TEMPLATES: Record<TemplateId, TemplateSpec> = {
  "workers-api": {
    manifest: {
      id: "workers-api",
      title: "Workers API (TypeScript)",
      description:
        "A JSON API on Cloudflare Workers: GET / returns { now }, GET /health. Vitest tests, esbuild bundle.",
      previewCommand: PREVIEW,
      buildOutput: "dist",
      routes: ["/", "/health"],
      expectedCiSeconds: 30,
    },
    features: pnpmFeatures(["src/**", "test/**", ...CONFIG], true),
    previewRoutes: ["/"],
  },
  "preact-app": {
    manifest: {
      id: "preact-app",
      title: "Preact + signals app on Workers",
      description:
        "A Preact + @preact/signals single-page app on Workers static assets, with a JSON API under /api/*.",
      previewCommand: PREVIEW,
      buildOutput: "dist",
      routes: ["/", "/api/time"],
      expectedCiSeconds: 30,
    },
    features: pnpmFeatures(["src/**", "test/**", "public/**", "build.mjs", ...CONFIG], true),
    previewRoutes: ["/"],
  },
  "ts-library": {
    manifest: {
      id: "ts-library",
      title: "TypeScript library",
      description:
        "An npm library with Vitest and emitted .d.ts, so every Change gets a public-API diff (none/additive/breaking).",
      previewCommand: null,
      buildOutput: "dist",
      routes: [],
      expectedCiSeconds: 30,
    },
    features: pnpmFeatures(["src/**", "test/**", "tsconfig.build.json", ...CONFIG], false),
    previewRoutes: [],
  },
  "static-site": {
    manifest: {
      id: "static-site",
      title: "Static site",
      description:
        "Plain HTML and CSS served by Workers static assets. Tests check every page's title and links.",
      previewCommand: PREVIEW,
      buildOutput: "dist",
      routes: ["/", "/about/"],
      expectedCiSeconds: 25,
    },
    features: pnpmFeatures(["public/**", "test/**", "build.mjs", ...CONFIG], true),
    previewRoutes: ["/", "/about/"],
  },
};

export function isTemplateId(id: string): id is TemplateId {
  return (TEMPLATE_IDS as readonly string[]).includes(id);
}
