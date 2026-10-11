import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Credentials,
  configDir,
  findProject,
  normalizeHost,
  PROJECT_FILE,
  readCredentials,
  resolveHost,
  resolveToken,
  writeCredentials,
} from "../src/config.js";
import { CliError } from "../src/errors.js";
import { envTokenAllowed, isSecureOrigin } from "../src/host-trust.js";
import { tempDir } from "./support/io.js";

const H = "https://gittifacts.example";

describe("credentials file", () => {
  it("is written 0600 inside a 0700 directory, atomically", () => {
    const dir = tempDir();
    const path = join(dir, "nested", "gittifacts", "credentials.json");
    writeCredentials(path, { version: 1, hosts: { [H]: { login: undefined } } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "nested", "gittifacts")).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, hosts: { [H]: {} } });
  });

  it("tightens a file that was readable by others", () => {
    const dir = tempDir();
    const path = join(dir, "credentials.json");
    writeFileSync(path, JSON.stringify({ version: 1, hosts: {} }));
    chmodSync(path, 0o644);
    writeCredentials(path, readCredentials(path));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("reads a missing file as empty and a corrupt one as a config error with a fix", () => {
    const dir = tempDir();
    expect(readCredentials(join(dir, "nope.json"))).toEqual({ version: 1, hosts: {} });
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    try {
      readCredentials(bad);
      throw new Error("expected an error");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).body).toMatchObject({
        code: "config",
        fix: { command: expect.stringContaining("gittifacts login") },
      });
    }
  });

  it("lives under XDG_CONFIG_HOME or ~/.config, unless GITTIFACTS_CONFIG_DIR says otherwise", () => {
    expect(configDir({}, "/home/a")).toBe("/home/a/.config/gittifacts");
    expect(configDir({ XDG_CONFIG_HOME: "/x" }, "/home/a")).toBe("/x/gittifacts");
    expect(configDir({ GITTIFACTS_CONFIG_DIR: "/c", XDG_CONFIG_HOME: "/x" }, "/home/a")).toBe("/c");
  });
});

describe("token and host resolution", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const creds = (loginExpires: string | null): Credentials => ({
    version: 1,
    defaultHost: H,
    hosts: {
      [H]: {
        login: {
          token: "login-tok",
          tokenType: "Bearer",
          scope: null,
          expiresAt: loginExpires,
          obtainedAt: "",
          via: "device-flow",
        },
        projects: {
          prj_1: { token: "project-tok", expiresAt: null, claimUrl: null, createdAt: "" },
        },
      },
    },
  });
  const project = { host: H, projectId: "prj_1", remote: "" };

  it("GITTIFACTS_TOKEN beats the login, which beats the project token", () => {
    expect(
      resolveToken(H, { GITTIFACTS_TOKEN: "env-tok" }, creds(null), project, now),
    ).toMatchObject({ token: "env-tok", source: "env" });
    expect(resolveToken(H, {}, creds(null), project, now)).toMatchObject({
      token: "login-tok",
      source: "login",
    });
    expect(resolveToken(H, {}, creds("2026-01-01T00:00:00Z"), project, now)).toMatchObject({
      token: "project-tok",
      source: "project",
    });
    expect(resolveToken(H, {}, creds("2026-01-01T00:00:00Z"), null, now)).toBeNull();
    expect(resolveToken("https://other.example", {}, creds(null), project, now)).toBeNull();
  });

  it("--host beats GITTIFACTS_HOST, which beats .gittifacts.json, which beats the last login", () => {
    const c = creds(null);
    expect(resolveHost("flag.example", { GITTIFACTS_HOST: "env.example" }, project, c)).toEqual({
      host: "https://flag.example",
      source: "flag",
    });
    expect(resolveHost(undefined, { GITTIFACTS_HOST: "env.example" }, project, c)).toEqual({
      host: "https://env.example",
      source: "env",
    });
    expect(resolveHost(undefined, {}, { ...project, host: "https://p.example/" }, c)).toEqual({
      host: "https://p.example",
      source: "project",
    });
    expect(resolveHost(undefined, {}, null, c)).toEqual({ host: H, source: "login" });
    expect(resolveHost(undefined, {}, null, { version: 1, hosts: {} })).toBeNull();
  });

  it("normalizes hosts to origins (http only for localhost)", () => {
    expect(normalizeHost("gittifacts.example/start")).toBe("https://gittifacts.example");
    expect(normalizeHost("localhost:8787")).toBe("http://localhost:8787");
    expect(normalizeHost("http://127.0.0.1:9/mcp")).toBe("http://127.0.0.1:9");
    expect(() => normalizeHost("ftp://x")).toThrow(CliError);
  });

  it("finds .gittifacts.json in a parent directory", () => {
    const root = tempDir();
    writeFileSync(
      join(root, PROJECT_FILE),
      JSON.stringify({ host: H, projectId: "prj_9", remote: "https://git.example/r.git" }),
    );
    const deep = join(root, "a", "b");
    mkdirSync(deep, { recursive: true });
    expect(findProject(deep)).toEqual({
      path: join(root, PROJECT_FILE),
      config: {
        host: H,
        projectId: "prj_9",
        remote: "https://git.example/r.git",
        mcpUrl: undefined,
      },
    });
    writeFileSync(join(root, "a", PROJECT_FILE), "[]");
    expect(() => findProject(deep)).toThrow(CliError);
  });
});

describe("which hosts get GITTIFACTS_TOKEN", () => {
  const empty: Credentials = { version: 1, hosts: {} };
  const fromProject = { host: H, source: "project" as const };

  it("a host the user chose always; one only the project file names, when trusted", () => {
    for (const source of ["flag", "env", "login", "build"] as const) {
      expect(envTokenAllowed({ host: H, source }, {}, empty)).toBe(true);
    }
    expect(envTokenAllowed(fromProject, {}, empty)).toBe(false);
    // Created an (unclaimed) project there from this machine, or logged in to it.
    const created: Credentials = {
      version: 1,
      hosts: {
        [H]: {
          projects: { prj_1: { token: "t", expiresAt: null, claimUrl: null, createdAt: "" } },
        },
      },
    };
    expect(envTokenAllowed(fromProject, {}, created)).toBe(true);
    // GITTIFACTS_TOKEN_HOST is normalized like --host; another host doesn't count.
    expect(
      envTokenAllowed(fromProject, { GITTIFACTS_TOKEN_HOST: "gittifacts.example/" }, empty),
    ).toBe(true);
    expect(envTokenAllowed(fromProject, { GITTIFACTS_TOKEN_HOST: "other.example" }, empty)).toBe(
      false,
    );
    expect(envTokenAllowed(fromProject, { GITTIFACTS_TOKEN_HOST: "ftp://x" }, empty)).toBe(false);
  });

  it("plain http only to loopback", () => {
    expect(isSecureOrigin("https://gittifacts.example")).toBe(true);
    expect(isSecureOrigin("http://localhost:8787")).toBe(true);
    expect(isSecureOrigin("http://127.0.0.1:1")).toBe(true);
    expect(isSecureOrigin("http://[::1]:9")).toBe(true);
    expect(isSecureOrigin("http://gittifacts.example")).toBe(false);
    expect(isSecureOrigin("http://localhost.evil.example")).toBe(false);
    expect(isSecureOrigin("not a url")).toBe(false);
  });
});
