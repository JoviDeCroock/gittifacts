/**
 * Security audit 2026-10-11 (Low, error text): internal details never reach the caller. The change
 * event stream sends a code and a generic message instead of raw exception text, and a stored row
 * whose R2 object is gone is a generic 500 (the key stays in the server log).
 */
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changeFixture, HEAD_SHA, store } from "./fixtures.js";
import { call, json, makeApp, signUpHuman } from "./http.js";
import { seedRepos } from "./oauth-helpers.js";

afterEach(() => vi.restoreAllMocks());

async function world(watchChange?: () => Promise<never>) {
  const { app } = makeApp(watchChange ? { watchChange } : {});
  const human = await signUpHuman(app, "Err Text");
  const [repo] = await seedRepos(1, human.principal.id);
  if (!repo) throw new Error("seed");
  const change = changeFixture(repo.id, human.principal.id, { status: "running" });
  await store().insertChange(change);
  return { app, human, change };
}

describe("error text", () => {
  it("the change event stream reports a failure as a code and a generic message, not the exception text", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "D1_ERROR: no such column internal_secret_col (r2 key blobs/abc)";
    const { app, human, change } = await world(async () => {
      throw new Error(secret);
    });
    const res = await call(app, "GET", `/api/v1/changes/${change.id}/events`, {
      cookie: human.cookie,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: error");
    const data = text
      .split("\n")
      .find((l, i, all) => l.startsWith("data:") && all[i - 1]?.startsWith("event: error"));
    expect(JSON.parse((data ?? "").slice(5))).toEqual({
      code: "internal",
      message: "internal error",
    });
    expect(text).not.toContain("internal_secret_col");
  });

  it("a stored row whose R2 object is missing is a generic 500 that names no storage key", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, human, change } = await world();
    const key = `diffs/${change.id}/${HEAD_SHA}.json`;
    await env.DB.prepare(
      "INSERT INTO diffs (change_id, head_sha, base_sha, json, r2_key, size_bytes, created_at) VALUES (?, ?, ?, NULL, ?, 1, ?)",
    )
      .bind(change.id, HEAD_SHA, "a".repeat(40), key, new Date().toISOString())
      .run();
    const res = await call(app, "GET", `/api/v1/changes/${change.id}/diff`, {
      cookie: human.cookie,
    });
    expect(res.status).toBe(500);
    const body = await json<{ error: { code: string; message: string } }>(res);
    expect(body.error).toMatchObject({
      code: "internal",
      message: "stored data could not be read",
    });
    expect(JSON.stringify(body)).not.toContain("diffs/");
    // The operator still sees which object is missing.
    expect(logged.mock.calls.flat().map(String).join(" ")).toContain(key);
  });
});
