/**
 * Public API. Everything exported here is the package's surface: the platform diffs the emitted
 * dist/index.d.ts on every Change (none / additive / breaking) and routes the Change by it.
 */
export { type SlugifyOptions, slugify } from "./slugify.js";
export { type TruncateOptions, truncate } from "./truncate.js";
