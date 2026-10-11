/**
 * Which audit events a principal may read, as one SQL condition on `audit_events`:
 *
 * - events whose subject is a repo it can read, or a plan/change of one (`repo:`, `plan:`,
 *   `change:` subjects);
 * - events about itself (`principal:<id>`), and for humans about the agents they own;
 * - platform-wide events (any other subject: `platform:…`, other principals) only for platform
 *   admins; auditors and the system read everything.
 *
 * Humans and unrestricted agents are matched through a `repo_members` subquery (no id lists, so
 * D1's bound-parameter limit never bites); repo-restricted principals through their small grant.
 */
import type { Principal } from "@app/domain";
import { type SQL, sql } from "drizzle-orm";
import { auditEvents, changes, plans, principals, repoMembers, repos } from "../db/schema.js";
import { type AccessDeps, accessibleRepoIds } from "./access.js";
import { isPlatformAdmin, isPlatformAuditor } from "./config.js";
import { isSystem } from "./roles.js";

const REPO_SUBJECT = sql`(${auditEvents.subject} LIKE 'repo:%' OR ${auditEvents.subject} LIKE 'plan:%' OR ${auditEvents.subject} LIKE 'change:%')`;

/** null = everything; otherwise the WHERE condition for the events `p` may read. */
export async function auditVisibility(deps: AccessDeps, p: Principal): Promise<SQL | null> {
  if (isSystem(p)) return null;
  if (isPlatformAuditor(p, deps.env) && (await accessibleRepoIds(deps, p)) === "all") return null;

  let repoIds: SQL;
  const restricted =
    p.kind === "integration" || (p.kind === "agent" && (p.repoIds ?? null) !== null);
  if (p.kind === "human" || (p.kind === "agent" && p.ownerId !== null && !restricted)) {
    const member = p.kind === "human" ? p.id : (p.ownerId as string);
    repoIds = sql`(SELECT ${repoMembers.repoId} FROM ${repoMembers} WHERE ${repoMembers.principalId} = ${member})`;
  } else {
    const ids = await accessibleRepoIds(deps, p);
    const list = ids === "all" ? [] : [...ids];
    repoIds =
      list.length === 0
        ? sql`(SELECT NULL WHERE 0)`
        : sql`(${sql.join(
            list.map((id) => sql`${id}`),
            sql`, `,
          )})`;
  }

  const ownPrincipals =
    p.kind === "human"
      ? sql`(SELECT 'principal:' || ${principals.id} FROM ${principals} WHERE ${principals.id} = ${p.id} OR ${principals.ownerId} = ${p.id})`
      : sql`(${`principal:${p.id}`})`;

  const parts: SQL[] = [
    sql`${auditEvents.subject} IN (SELECT 'repo:' || ${repos.id} FROM ${repos} WHERE ${repos.id} IN ${repoIds})`,
    sql`${auditEvents.subject} IN (SELECT 'plan:' || ${plans.id} FROM ${plans} WHERE ${plans.repoId} IN ${repoIds})`,
    sql`${auditEvents.subject} IN (SELECT 'change:' || ${changes.id} FROM ${changes} WHERE ${changes.repoId} IN ${repoIds})`,
    sql`${auditEvents.subject} IN ${ownPrincipals}`,
  ];
  if (isPlatformAdmin(p, deps.env)) parts.push(sql`NOT ${REPO_SUBJECT}`);
  return sql`(${sql.join(parts, sql` OR `)})`;
}

/** Events about one repo: the repo itself, its plans and its changes (`?repoId=` on the audit log). */
export function repoAuditSubjects(repoId: string): SQL {
  return sql`(${auditEvents.subject} = ${`repo:${repoId}`} OR ${auditEvents.subject} IN (SELECT 'plan:' || ${plans.id} FROM ${plans} WHERE ${plans.repoId} = ${repoId}) OR ${auditEvents.subject} IN (SELECT 'change:' || ${changes.id} FROM ${changes} WHERE ${changes.repoId} = ${repoId}))`;
}
