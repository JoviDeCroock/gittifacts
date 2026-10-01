export { AuditLog } from "./audit/audit-log-do.js";
export default { async fetch() { return new Response("ok"); } } satisfies ExportedHandler<Env>;
