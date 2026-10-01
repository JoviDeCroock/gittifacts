export interface Config {
  retries: number;
  timeoutMs: number;
}

export const defaults: Config = {
  retries: 3,
  timeoutMs: 1000,
};

export function withDefaults(partial: Partial<Config>): Config {
  return { ...defaults, ...partial };
}
