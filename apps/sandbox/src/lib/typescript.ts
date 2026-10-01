/**
 * The TypeScript compiler, loaded on first use: commands that don't need it (preview,
 * dependencies, policy, ...) neither pay its load time nor require it to be installed.
 */
import { createRequire } from "node:module";
import type * as TS from "typescript";

let loaded: typeof TS | undefined;

export function typescript(): typeof TS {
  loaded ??= createRequire(import.meta.url)("typescript") as typeof TS;
  return loaded;
}

/** A stand-in for `import ts from "typescript"` that loads the compiler on first property access. */
export const lazyTs: typeof TS = new Proxy({} as typeof TS, {
  get: (_target, prop) => Reflect.get(typescript(), prop),
});
