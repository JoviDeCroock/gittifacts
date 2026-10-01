import { DurableObject } from "cloudflare:workers";
export class AuditLog extends DurableObject<Env> {
  async ping() { return "pong"; }
}
export default { async fetch() { return new Response("ok"); } } satisfies ExportedHandler<Env>;
