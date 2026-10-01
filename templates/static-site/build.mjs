// Copies public/ to dist/, the directory Workers static assets serves (see wrangler.jsonc).
import { cp, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await cp("public", "dist", { recursive: true });
