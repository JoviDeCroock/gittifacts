/**
 * The runner's own git calls run nothing repository code configured (security audit 2026-10-11,
 * H3): an evidence step starts from the install step's snapshot, where that code could write
 * `~/.gitconfig` and `.git/config`. An fsmonitor command there used to run inside every kind's git
 * calls, as the uid that writes `$GITTIFACTS_EVIDENCE_OUT`, so it could replace the evidence.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cli, document, ensureBundle, type TempRepo, tempRepo } from "./helpers.js";

const PKG = JSON.stringify({ name: "demo", version: "1.0.0", types: "index.d.ts" }, null, 2);
let repo: TempRepo;
let dir: string;
let home: string;
let marker: string;

beforeAll(() => {
  ensureBundle();
  repo = tempRepo(
    { "package.json": PKG, "index.d.ts": "export declare const a: number;\n" },
    { "index.d.ts": "export declare const a: number;\nexport declare const b: string;\n" },
  );
  dir = mkdtempSync(join(tmpdir(), "gittifacts-hostile-"));
  home = join(dir, "home");
  mkdirSync(home);
  marker = join(dir, "PWNED");
  const evil = join(dir, "evil.sh");
  // What a postinstall would do: forge the evidence file, and leave a trace for the test.
  writeFileSync(
    evil,
    `#!/bin/sh\necho "$0 $*" >> ${marker}\n[ -n "$GITTIFACTS_EVIDENCE_OUT" ] && echo '{"forged":true}' > "$GITTIFACTS_EVIDENCE_OUT"\nexit 1\n`,
  );
  chmodSync(evil, 0o755);
  writeFileSync(join(home, ".gitconfig"), `[core]\n\tfsmonitor = ${evil}\n`);
  const cfg = join(repo.dir, ".git", "config");
  writeFileSync(cfg, `${readFileSync(cfg, "utf8")}[core]\n\tfsmonitor = ${evil}\n`);
}, 180_000);

afterAll(() => {
  repo.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe("a planted git config", () => {
  for (const kind of ["dependencies", "public-api", "transforms"]) {
    it(`runs nothing in evidence ${kind}, and the evidence file is the runner's`, async () => {
      rmSync(marker, { force: true });
      const out = join(dir, `${kind}.json`);
      const res = await cli(
        ["evidence", kind, "--base", repo.base, "--head", repo.head, "--cwd", repo.dir],
        repo.dir,
        { HOME: home, GITTIFACTS_EVIDENCE_OUT: out },
      );
      expect(res.code, res.stderr).toBe(0);
      expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(document(res));
    });
  }
});
