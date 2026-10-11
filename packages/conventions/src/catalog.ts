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

/**
 * The small first task every template repo starts with (onboarding's golden path): create_project
 * drafts it as a Plan by the platform (`system`), a human approves it, an agent builds it, the
 * merge queue lands it. Fields are a `create_plan` input (PlanDraftInput) minus `repoId`.
 */
export const SamplePlan = z
  .object({
    title: z.string().min(3).max(200),
    intent: z.string().min(10).max(2000),
    acceptanceCriteria: z.array(z.string().min(1).max(1000)).min(1).max(10),
    outOfScope: z.array(z.string().min(1).max(1000)).max(10),
    scopePaths: z.array(z.string().min(1).max(300)).min(1).max(20),
    affectedRoutes: z.array(z.string().startsWith("/")).max(5),
  })
  .strict();
export type SamplePlan = z.infer<typeof SamplePlan>;

export interface TemplateSpec {
  manifest: TemplateManifest;
  /** The first Plan of a repo made from this template (drafted by the platform, never approved by it). */
  samplePlan: SamplePlan;
  features: ProjectFeatures;
  previewRoutes: string[];
  /**
   * The build output is a modules-only Worker the platform can roll out: the generated
   * `.platform/ci.ts` uploads it as the build step's `bundle` artifact. Templates on static
   * assets are not deployable yet (the deployer uploads modules only).
   */
  deployable: boolean;
}

export const TEMPLATES: Record<TemplateId, TemplateSpec> = {
  "workers-api": {
    samplePlan: {
      title: "Add GET /version",
      intent:
        "Callers can ask which version of the API is running: GET /version returns { version }, the version in package.json.",
      acceptanceCriteria: [
        "GET /version answers 200 with JSON { version } (a non-empty string)",
        "test/app.test.ts has a test for GET /version",
        "GET / and GET /health answer as before",
      ],
      outOfScope: ["Other routes", "Deploy settings (wrangler.jsonc)"],
      scopePaths: ["src/**", "test/**"],
      affectedRoutes: [],
    },
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
    deployable: true,
  },
  "preact-app": {
    samplePlan: {
      title: "Add a Reset button to the counter",
      intent:
        "The counter only counts up. A Reset button next to it sets the count back to 0, using the counter's reset().",
      acceptanceCriteria: [
        "The home page shows a Reset button next to the counter",
        "Clicking it sets the count (and its double) back to 0",
        "test/state.test.ts has a test for reset()",
      ],
      outOfScope: ["The server time button", "The /api/* routes"],
      scopePaths: ["src/client/**", "test/**"],
      affectedRoutes: ["/"],
    },
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
    deployable: false,
  },
  "ts-library": {
    samplePlan: {
      title: "Add capitalize()",
      intent:
        "Export capitalize(input) from the library: it upper-cases the first letter and leaves the rest as is. An additive public API change.",
      acceptanceCriteria: [
        'capitalize("hello world") returns "Hello world"',
        'capitalize("") returns ""',
        "src/index.ts exports capitalize, and test/capitalize.test.ts tests it",
      ],
      outOfScope: ["Changes to slugify() or truncate()"],
      scopePaths: ["src/**", "test/**"],
      affectedRoutes: [],
    },
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
    deployable: false,
  },
  "static-site": {
    samplePlan: {
      title: "Add a contact page",
      intent:
        "Visitors need a way to reach us: a /contact/ page with a title, a description and an email link, linked from the nav on every page.",
      acceptanceCriteria: [
        "/contact/ serves a page with a title and a mailto: link",
        "The nav on every page links to /contact/",
        "The site tests pass (every page's title and links)",
      ],
      outOfScope: ["A contact form", "Styling changes beyond the new page"],
      scopePaths: ["public/**", "test/**"],
      affectedRoutes: ["/contact/"],
    },
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
    deployable: false,
  },
};

export function isTemplateId(id: string): id is TemplateId {
  return (TEMPLATE_IDS as readonly string[]).includes(id);
}
