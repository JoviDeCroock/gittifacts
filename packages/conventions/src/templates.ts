/**
 * Files generated into templates and new projects. The catalogue (`catalog.ts`) is the source of
 * truth for each template's `template.json`, `.platform/*` files and AGENTS.md; a test checks the
 * files under `templates/` match what these generators produce
 * (`pnpm --filter @app/conventions sync-templates` rewrites them).
 */
import { agentsMd } from "./agents-md.js";
import { TEMPLATES, type TemplateId } from "./catalog.js";
import { defaultCiTs, defaultPolicyTs } from "./platform-files.js";

// ---------------------------------------------------------------- placeholders

export const PLACEHOLDER_NAMES = ["projectName", "host", "mcpUrl", "repoId"] as const;
export type PlaceholderName = (typeof PLACEHOLDER_NAMES)[number];
export type PlaceholderValues = Record<PlaceholderName, string>;

/** Values that render each placeholder as itself (`{{projectName}}`), used for the files on disk. */
export const PLACEHOLDER_SELF: PlaceholderValues = {
  projectName: "{{projectName}}",
  host: "{{host}}",
  mcpUrl: "{{mcpUrl}}",
  repoId: "{{repoId}}",
};

/** Replaces `{{name}}` for every known placeholder; unknown `{{...}}` text is left untouched. */
export function renderPlaceholders(text: string, values: Partial<PlaceholderValues>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    const value = (values as Record<string, string | undefined>)[name];
    return value === undefined ? whole : value;
  });
}

/** Worker-name-safe slug: lowercase letters, digits and dashes, 1–63 chars. */
export function projectSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return slug === "" ? "project" : slug;
}

// ---------------------------------------------------------------- generated files

export interface TemplateFileOptions extends PlaceholderValues {
  claimed: boolean;
}

/**
 * The files the platform writes into a new project on top of the template's own files:
 * `.platform/ci.ts`, `.platform/policy.ts` and `AGENTS.md`. Keys are repo paths.
 */
export function templateGeneratedFiles(id: TemplateId, opts: TemplateFileOptions): Record<string, string> {
  const spec = TEMPLATES[id];
  const ci = defaultCiTs(spec.features);
  const policy = defaultPolicyTs({ previewRoutes: spec.previewRoutes });
  return {
    [ci.path]: ci.text,
    [policy.path]: policy.text,
    "AGENTS.md": agentsMd({
      projectName: opts.projectName,
      host: opts.host,
      mcpUrl: opts.mcpUrl,
      repoId: opts.repoId,
      claimed: opts.claimed,
      template: id,
    }),
  };
}

/** What `templates/<id>/` holds for the generated files: rendered with placeholders, unclaimed. */
export function templateFilesOnDisk(id: TemplateId): Record<string, string> {
  return {
    ...templateGeneratedFiles(id, { ...PLACEHOLDER_SELF, claimed: false }),
    "template.json": `${JSON.stringify(TEMPLATES[id].manifest, null, 2)}\n`,
  };
}
