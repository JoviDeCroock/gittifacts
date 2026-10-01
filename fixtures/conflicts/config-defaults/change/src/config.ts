export interface Config {
  retries: number;
  timeoutMs: number;
  verbose: boolean;
}

export const defaults: Config = {
  retries: 3,
  timeoutMs: 1000,
  verbose: false,
};

export function withDefaults(partial: Partial<Config>): Config {
  return { ...defaults, ...partial };
}
