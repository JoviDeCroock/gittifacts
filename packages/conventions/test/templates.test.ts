import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PLACEHOLDER_NAMES,
  projectSlug,
  renderPlaceholders,
  TEMPLATE_IDS,
  TEMPLATES,
  TemplateManifest,
  templateFilesOnDisk,
  templateGeneratedFiles,
} from "../src/index.js";
import { listFiles, REPO_ROOT, readText, TEMPLATES_DIR } from "./helpers.js";

const SKIP = /(^|\/)(node_modules|dist|\.wrangler)(\/|$)/;

describe("templates/", () => {
  it("holds exactly the catalogued templates", () => {
    const dirs = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(dirs.sort()).toEqual([...TEMPLATE_IDS].sort());
    expect(existsSync(join(TEMPLATES_DIR, "README.md"))).toBe(true);
  });

  it("is not part of the monorepo workspace", () => {
    const workspace = readText(join(REPO_ROOT, "pnpm-workspace.yaml"));
    const packages = /^packages:\n((?:\s+- .+\n)+)/m.exec(workspace)?.[1] ?? "";
    expect(
      packages
        .trim()
        .split("\n")
        .map((l) => l.replace(/^\s*-\s*/, "").replace(/["']/g, "")),
    ).toEqual(["packages/*", "apps/*"]);
  });
});

describe.each([...TEMPLATE_IDS])("templates/%s", (id) => {
  const dir = join(TEMPLATES_DIR, id);
  const read = (path: string) => readText(join(dir, path));
  const pkg = JSON.parse(read("package.json")) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    packageManager?: string;
  };
  const isWorker = existsSync(join(dir, "wrangler.jsonc"));

  it("has generated files identical to what @app/conventions produces (run sync-templates)", () => {
    for (const [path, text] of Object.entries(templateFilesOnDisk(id))) {
      expect(existsSync(join(dir, path)), path).toBe(true);
      expect(
        read(path),
        `templates/${id}/${path} is stale: pnpm --filter @app/conventions sync-templates`,
      ).toBe(text);
    }
  });

  it("has a valid template.json matching its directory", () => {
    const manifest = TemplateManifest.parse(JSON.parse(read("template.json")));
    expect(manifest.id).toBe(id);
    expect(manifest.previewCommand !== null).toBe(isWorker);
    expect(manifest.routes.length > 0).toBe(isWorker);
  });

  it("has lint, typecheck, test and build scripts", () => {
    for (const script of ["lint", "typecheck", "test", "build"])
      expect(pkg.scripts?.[script], script).toBeTruthy();
    expect(TEMPLATES[id].features.scripts).toEqual({
      lint: "lint",
      typecheck: "typecheck",
      test: "test",
      build: "build",
    });
  });

  it("keeps dependencies minimal and pinned (no wrangler, no packageManager download)", () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(pkg.devDependencies?.typescript).toBe("6.0.3");
    expect(pkg.devDependencies?.vitest).toBe("4.1.11");
    expect(all).not.toHaveProperty("wrangler");
    expect(pkg.packageManager).toBeUndefined();
    for (const version of Object.values(all)) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(all).length).toBeLessThanOrEqual(5);
  });

  it("is a standalone pnpm project with a committed lockfile covering every dependency", () => {
    expect(existsSync(join(dir, "pnpm-workspace.yaml"))).toBe(true);
    const lock = read("pnpm-lock.yaml");
    expect(lock.startsWith("lockfileVersion: '9.0'")).toBe(true);
    const importer = /^importers:\n\n {2}\.:\n([\s\S]*?)\n\npackages:/m.exec(lock)?.[1] ?? "";
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(importer, `${name} missing from pnpm-lock.yaml`).toContain(
        `${name.includes("@") ? `'${name}'` : name}:\n        specifier: ${version}`,
      );
    }
  });

  it("ignores build output and dependencies", () => {
    const ignore = read(".gitignore").split("\n");
    expect(ignore).toEqual(expect.arrayContaining(["node_modules/", "dist/"]));
  });

  it.runIf(isWorker)(
    "has a wrangler.jsonc with the name placeholder and the pinned compatibility date",
    () => {
      const config = read("wrangler.jsonc");
      expect(config).toContain('"name": "{{projectName}}"');
      expect(config).toContain('"compatibility_date": "2026-09-30"');
      expect(config).toMatch(/"build": \{ "command": "pnpm run build"/);
    },
  );

  it("only uses known placeholders", () => {
    for (const file of listFiles(dir)) {
      const rel = relative(dir, file);
      if (SKIP.test(rel) || rel === "pnpm-lock.yaml") continue;
      for (const m of readText(file).matchAll(/\{\{(\w+)\}\}/g)) {
        expect(PLACEHOLDER_NAMES as readonly string[], `${rel}: {{${m[1]}}}`).toContain(m[1]);
      }
    }
  });

  it("renders a project's generated files without placeholders left", () => {
    const files = templateGeneratedFiles(id, {
      projectName: "my-app",
      host: "https://h.example",
      mcpUrl: "https://h.example/mcp",
      repoId: "rep_1",
      claimed: true,
    });
    for (const [path, text] of Object.entries(files)) expect(text, path).not.toMatch(/\{\{\w+\}\}/);
    expect(renderPlaceholders(read("README.md"), { projectName: "my-app" })).toMatch(/^# my-app\n/);
  });
});

describe("placeholders", () => {
  it("renders known names and leaves unknown ones", () => {
    expect(
      renderPlaceholders("{{projectName}} {{host}} {{other}}", { projectName: "a", host: "b" }),
    ).toBe("a b {{other}}");
  });

  it("slugs project names into Worker-safe names", () => {
    expect(projectSlug("My Cool API!")).toBe("my-cool-api");
    expect(projectSlug("Crème Brûlée")).toBe("creme-brulee");
    expect(projectSlug("***")).toBe("project");
    expect(projectSlug("a".repeat(80))).toHaveLength(63);
    expect(projectSlug(`${"a".repeat(62)}-b`)).toBe("a".repeat(62));
  });
});
