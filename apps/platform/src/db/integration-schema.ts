/**
 * External integrations (docs/prompts/04-integrations.md): OAuth apps that deploy platforms
 * register, their installations on a human's repos, webhook deliveries and deployment reports.
 *
 * - An installation is integration × account (a human today; `account_kind` leaves room for orgs)
 *   × repos. Each installation has its own `integration` principal (kind "integration", owned by the
 *   installing human, repoIds = the installation's repos) and one `agent_sessions` row so access
 *   tokens (`gti_…` in `agent_tokens`) and rotating refresh tokens (`gtir_…` in
 *   `oauth_refresh_tokens`) reuse the O4 machinery and die together on uninstall.
 * - Client secrets are stored as SHA-256 only; webhook secrets must be usable for HMAC, so they are
 *   stored AES-GCM encrypted under a key derived from BETTER_AUTH_SECRET.
 */
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { principals, repos } from "./app-schema.js";

export const integrations = sqliteTable(
  "integrations",
  {
    id: text("id").primaryKey(),
    /** Public OAuth client id (`gtic_…`). */
    clientId: text("client_id").notNull(),
    /** The developer (a human principal) who registered and manages it. */
    ownerId: text("owner_id")
      .notNull()
      .references(() => principals.id),
    name: text("name").notNull(),
    description: text("description"),
    logoUrl: text("logo_url"),
    homepageUrl: text("homepage_url").notNull(),
    /** Exact-match redirect URIs. */
    redirectUris: text("redirect_uris", { mode: "json" }).$type<string[]>().notNull(),
    clientType: text("client_type", { enum: ["confidential", "public"] }).notNull(),
    /** The permissions it requests (IntegrationScope[]). */
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    webhookUrl: text("webhook_url"),
    /** AES-GCM ciphertext (`v1.<iv>.<ct>`, base64url) of the webhook secret. */
    webhookSecretEnc: text("webhook_secret_enc"),
    webhookActive: integer("webhook_active", { mode: "boolean" }).notNull().default(true),
    webhookEvents: text("webhook_events", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    uniqueIndex("integrations_client_id_uq").on(t.clientId),
    index("integrations_owner_idx").on(t.ownerId),
  ],
);

/** Confidential clients' secrets (`gtis_…`), SHA-256 only; several may be active while rotating. */
export const integrationSecrets = sqliteTable(
  "integration_secrets",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    secretHash: text("secret_hash").notNull(),
    prefix: text("prefix").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
  },
  (t) => [
    uniqueIndex("integration_secrets_hash_uq").on(t.secretHash),
    index("integration_secrets_integration_idx").on(t.integrationId),
  ],
);

export const installations = sqliteTable(
  "installations",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id),
    /** The account it is installed on: a human principal (orgs later). */
    accountId: text("account_id")
      .notNull()
      .references(() => principals.id),
    accountKind: text("account_kind", { enum: ["human", "org"] }).notNull(),
    /** The installation's own `integration` principal (tokens, audit, repo grant). */
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id),
    /** agent_sessions.id that its refresh tokens hang off. */
    sessionId: text("session_id").notNull(),
    installedBy: text("installed_by")
      .notNull()
      .references(() => principals.id),
    /** `all`: every repo the account may install on, now and later; `selected`: installation_repos. */
    repoSelection: text("repo_selection", { enum: ["all", "selected"] }).notNull(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    status: text("status", { enum: ["active", "deleted"] }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (t) => [
    uniqueIndex("installations_principal_uq").on(t.principalId),
    index("installations_integration_idx").on(t.integrationId, t.status),
    index("installations_account_idx").on(t.accountId, t.status),
  ],
);

/** Repos of a `selected` installation. */
export const installationRepos = sqliteTable(
  "installation_repos",
  {
    installationId: text("installation_id")
      .notNull()
      .references(() => installations.id, { onDelete: "cascade" }),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.installationId, t.repoId] }),
    index("installation_repos_repo_idx").on(t.repoId),
  ],
);

/**
 * One integration install attempt (authorization code + PKCE): created by `/api/oauth/authorize`
 * for an integration client, decided on `/integrations/install`, redeemed at the token endpoint.
 * Kept apart from `oauth_requests` so the agent and integration flows can never cross.
 */
export const integrationAuthorizations = sqliteTable(
  "integration_authorizations",
  {
    /** Unguessable (32 random bytes, base64url): it is the install screen's URL. */
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    state: text("state"),
    /** PKCE S256 challenge (required for every integration client). */
    codeChallenge: text("code_challenge").notNull(),
    requestedScopes: text("requested_scopes", { mode: "json" }).$type<string[]>().notNull(),
    audience: text("audience", { mode: "json" }).$type<string[]>().notNull(),
    status: text("status", { enum: ["pending", "approved", "denied", "redeemed"] }).notNull(),
    /** The human deciding; bound on first view of the install screen. */
    ownerId: text("owner_id").references(() => principals.id),
    repoSelection: text("repo_selection", { enum: ["all", "selected"] }),
    grantedRepoIds: text("granted_repo_ids", { mode: "json" }).$type<string[]>(),
    /** The installation the approval created or updated. */
    installationId: text("installation_id"),
    codeHash: text("code_hash"),
    codeExpiresAt: text("code_expires_at"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    decidedAt: text("decided_at"),
  },
  (t) => [
    uniqueIndex("integration_authorizations_code_uq").on(t.codeHash),
    index("integration_authorizations_expires_idx").on(t.expiresAt),
  ],
);

/** One webhook delivery (and its retries). Redeliveries are new rows with `redelivery_of`. */
export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    /** `X-Gittifacts-Delivery`: the original delivery's id, also on redeliveries (receivers dedupe). */
    guid: text("guid").notNull(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    installationId: text("installation_id"),
    event: text("event").notNull(),
    action: text("action"),
    repoId: text("repo_id"),
    /** The exact signed body. */
    payload: text("payload").notNull(),
    status: text("status", { enum: ["pending", "delivered", "failed", "cancelled"] }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: text("next_attempt_at"),
    lastAttemptAt: text("last_attempt_at"),
    /** A consumer holds the delivery until then (no two consumers send it at once). */
    leaseUntil: text("lease_until"),
    url: text("url"),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    durationMs: integer("duration_ms"),
    error: text("error"),
    redeliveryOf: text("redelivery_of"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("webhook_deliveries_integration_idx").on(t.integrationId, t.createdAt),
    index("webhook_deliveries_installation_idx").on(t.installationId, t.status),
    index("webhook_deliveries_pending_idx").on(t.status, t.nextAttemptAt),
  ],
);

/** A deployment an integration reported (deploy platforms report back; they never deploy for us). */
export const deployments = sqliteTable(
  "deployments",
  {
    id: text("id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    changeId: text("change_id"),
    installationId: text("installation_id")
      .notNull()
      .references(() => installations.id),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id),
    /** The integration principal that reported it. */
    principalId: text("principal_id").notNull(),
    sha: text("sha").notNull(),
    ref: text("ref"),
    environment: text("environment", { enum: ["preview", "production"] }).notNull(),
    /** Latest status. */
    state: text("state", {
      enum: ["pending", "queued", "in_progress", "success", "failure", "error"],
    }).notNull(),
    url: text("url"),
    logUrl: text("log_url"),
    description: text("description"),
    /** Preview evidence: none | pending (bundle not sealed yet) | attached. */
    evidenceStatus: text("evidence_status", { enum: ["none", "pending", "attached"] })
      .notNull()
      .default("none"),
    evidenceItemId: text("evidence_item_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("deployments_repo_idx").on(t.repoId, t.createdAt),
    index("deployments_change_idx").on(t.changeId, t.sha),
    index("deployments_evidence_idx").on(t.evidenceStatus, t.changeId),
  ],
);

export const deploymentStatuses = sqliteTable(
  "deployment_statuses",
  {
    id: text("id").primaryKey(),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    state: text("state", {
      enum: ["queued", "in_progress", "success", "failure", "error"],
    }).notNull(),
    url: text("url"),
    logUrl: text("log_url"),
    description: text("description"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("deployment_statuses_deployment_idx").on(t.deploymentId, t.createdAt)],
);

/** Stable, unique handles for git URLs (`/git/<handle>/<repo>.git`); assigned on first use. */
export const accountHandles = sqliteTable(
  "account_handles",
  {
    principalId: text("principal_id")
      .primaryKey()
      .references(() => principals.id, { onDelete: "cascade" }),
    handle: text("handle").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("account_handles_handle_uq").on(t.handle)],
);
