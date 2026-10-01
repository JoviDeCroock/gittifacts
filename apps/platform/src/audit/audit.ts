import type { Audit } from "@app/coordinator";
import type { AuditEvent } from "@app/domain";

/** Name of the org-wide AuditLog instance (one per org later). */
export const AUDIT_LOG_NAME = "global";

export function auditLogStub(env: Pick<Env, "AUDIT_LOG">, name: string = AUDIT_LOG_NAME) {
  return env.AUDIT_LOG.getByName(name);
}

/** The `Audit` port: every append goes through the single-writer AuditLog DO. */
export class DoAudit implements Audit {
  constructor(
    private readonly env: Pick<Env, "AUDIT_LOG">,
    private readonly logName: string = AUDIT_LOG_NAME,
  ) {}

  async append(input: {
    principalId: string;
    action: string;
    subject: string;
    payload: unknown;
  }): Promise<AuditEvent> {
    // Round-trip through JSON: RPC arguments must be structured-clonable and the chain hashes
    // canonical JSON anyway (drops undefined, rejects functions early with a clear error).
    const payload =
      input.payload === undefined ? null : (JSON.parse(JSON.stringify(input.payload)) as unknown);
    return auditLogStub(this.env, this.logName).append({ ...input, payload });
  }
}
