import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_DIR, readText } from "./helpers.js";

const SRC = join(PACKAGE_DIR, "src");

describe("src/ is pure TypeScript", () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));

  it.each(files)("%s uses no runtime-specific modules or globals", (file) => {
    const code = readText(join(SRC, file)).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/from\s+["'](node:|cloudflare:|fs|path|os|child_process)/);
    expect(code).not.toMatch(/\b(process|Buffer|globalThis|window|document)\./);
    expect(code).not.toMatch(/\bfetch\(|\bnew URL\(|\bcrypto\./);
  });

  it("imports only zod, @app/domain and relative modules", () => {
    for (const file of files) {
      for (const m of readText(join(SRC, file)).matchAll(/from\s+["']([^"']+)["']/g)) {
        expect(["zod", "@app/domain"].includes(m[1] ?? "") || m[1]?.startsWith("./"), `${file}: ${m[1]}`).toBe(true);
      }
    }
  });
});
