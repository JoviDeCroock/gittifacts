/**
 * The contract external integrations (src/integrations/) rely on: an integration principal is a
 * `reader` on its installation's repos while the installing human is still a member, nothing
 * else, and never more than read (it cannot contribute, review or approve).
 */
import type { Principal } from "@app/domain";
import { describe, expect, it } from "vitest";
import {
  type AccessDeps,
  accessibleRepoIds,
  assertRepoAccess,
  effectiveRole,
} from "../src/access/access.js";
import { removeMemberRow } from "../src/access/members-store.js";
import { principals } from "../src/db/schema.js";
import { ApiError } from "../src/errors.js";
import { addMember, repoFixture, seedPrincipal, store, uid } from "./fixtures.js";

/** A fresh deps object per question: the access memo lives as long as one request. */
const deps = (): AccessDeps => ({ store: store(), env: {} });

async function integration(ownerId: string, repoIds: string[] | null): Promise<Principal> {
  const s = store();
  const id = uid("in");
  await s.db.insert(principals).values({
    id,
    kind: "integration",
    name: "Deploy platform",
    ownerId,
    userId: null,
    scopes: ["repo:read", "deployments:write", "checks:write"],
    repoIds,
    createdAt: new Date().toISOString(),
  });
  const p = await s.getPrincipal(id);
  if (!p) throw new Error("integration principal vanished");
  return p;
}

async function repoOwnedBy(ownerId: string, claimed = true) {
  const repo = repoFixture({
    claim: claimed
      ? { status: "claimed", ownerId, expiresAt: null }
      : { status: "unclaimed", ownerId: null, expiresAt: "2099-01-01T00:00:00.000Z" },
  });
  await store().insertRepo(repo);
  return repo;
}

async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string }> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ApiError);
  return { status: (e as ApiError).status, code: (e as ApiError).code };
}

describe("integration principals and the access chokepoint", () => {
  it("are readers on their installation's repos and can do nothing else there", async () => {
    const s = store();
    const installer = await seedPrincipal(s, { kind: "human" });
    const repo = await repoOwnedBy(installer);
    const p = await integration(installer, [repo.id]);
    expect(await effectiveRole(deps(), p, repo.id)).toBe("reader");
    await expect(assertRepoAccess(deps(), p, repo.id, "read")).resolves.toMatchObject({
      id: repo.id,
    });
    expect(await refusal(assertRepoAccess(deps(), p, repo.id, "contribute"))).toEqual({
      status: 403,
      code: "insufficient-scope",
    });
    for (const need of ["review", "approve", "admin"] as const) {
      expect(await refusal(assertRepoAccess(deps(), p, repo.id, need))).toEqual({
        status: 403,
        code: "forbidden",
      });
    }
    expect([...((await accessibleRepoIds(deps(), p)) as Set<string>)]).toEqual([repo.id]);
  });

  it("outside the installation: repo-not-granted for the installer's other repos, 404 for anyone else's", async () => {
    const s = store();
    const installer = await seedPrincipal(s, { kind: "human" });
    const stranger = await seedPrincipal(s, { kind: "human" });
    const installed = await repoOwnedBy(installer);
    const other = await repoOwnedBy(installer);
    const theirs = await repoOwnedBy(stranger);
    const unclaimed = await repoOwnedBy(installer, false);
    // Listing a repo the installer cannot see (or an unclaimed one) grants nothing.
    const p = await integration(installer, [installed.id, theirs.id, unclaimed.id]);
    expect(await effectiveRole(deps(), p, other.id)).toBeNull();
    expect(await refusal(assertRepoAccess(deps(), p, other.id, "read"))).toEqual({
      status: 403,
      code: "repo-not-granted",
    });
    for (const id of [theirs.id, unclaimed.id]) {
      expect(await effectiveRole(deps(), p, id)).toBeNull();
      expect(await refusal(assertRepoAccess(deps(), p, id, "read"))).toEqual({
        status: 404,
        code: "not-found",
      });
    }
    expect([...((await accessibleRepoIds(deps(), p)) as Set<string>)]).toEqual([installed.id]);
    // Never unrestricted: no repo list means no repos.
    const none = await integration(installer, null);
    expect(await effectiveRole(deps(), none, installed.id)).toBeNull();
    expect([...((await accessibleRepoIds(deps(), none)) as Set<string>)]).toEqual([]);
  });

  it("lose the repo the moment the installing human stops being a member", async () => {
    const s = store();
    const installer = await seedPrincipal(s, { kind: "human" });
    const coOwner = await seedPrincipal(s, { kind: "human" });
    const repo = await repoOwnedBy(installer);
    await addMember(s, repo.id, coOwner, "owner");
    const p = await integration(installer, [repo.id]);
    expect(await effectiveRole(deps(), p, repo.id)).toBe("reader");
    expect(await removeMemberRow(s, repo.id, installer)).toBe(true);
    expect(await effectiveRole(deps(), p, repo.id)).toBeNull();
    expect(await refusal(assertRepoAccess(deps(), p, repo.id, "read"))).toEqual({
      status: 404,
      code: "not-found",
    });
  });
});
