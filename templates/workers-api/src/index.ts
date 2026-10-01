import { handle } from "./app.js";

/** Bindings from wrangler.jsonc (KV, D1, vars, ...). Empty for now. */
export type Env = Record<string, never>;

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    return handle(request);
  },
};
