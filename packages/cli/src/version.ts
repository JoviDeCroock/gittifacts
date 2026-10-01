import pkg from "../package.json" with { type: "json" };

/** From package.json (esbuild inlines it into the bundle). */
export const CLI_VERSION: string = pkg.version;
export const CLI_NAME: string = pkg.name;
